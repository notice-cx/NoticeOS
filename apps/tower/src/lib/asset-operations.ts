import type { AssetStatus } from '@shared/asset-detail';
import { LIFECYCLE_ANNOTATION_KIND, lifecycleMoveRef } from '@shared/asset-detail';
import type { PlannedWrites } from '@shared/asset-wizard';
import { buildChangeset } from '@shared/changeset';
import type { SaveRequest } from '@/hooks/useConfigSave';
import { ApiError, AssetExistsError, createAsset, createAssetConfig, type ConfigSaveResult } from './api';

export interface IncompleteSetup { id: string; reason: string; changeset: string }
type CreateOutcome =
  | { kind: 'busy' }
  /** `existing` names the site already holding this id or domain (the store's
   * 409), so the screen can offer to open it rather than only refuse. */
  | { kind: 'rejected'; field: 'domain' | 'displayName'; message: string; existing?: string; existingStatus?: AssetStatus }
  | { kind: 'failed'; message: string }
  | { kind: 'setup-needed'; report: IncompleteSetup }
  | { kind: 'created'; plan: PlannedWrites; result: ConfigSaveResult | void };

interface AssetWrites {
  createAsset: typeof createAsset;
  createAssetConfig: typeof createAssetConfig;
}

/** One in-memory operation session. Only an acknowledged row establishes a
 * resumable setup plan. Transport errors and duplicate responses never do.
 * The original plan survives retries; configuration guards remain authoritative.
 */
export function createAssetOperations(writes: AssetWrites = { createAsset, createAssetConfig }) {
  let confirmedPlan: PlannedWrites | null = null;
  let working = false;
  return {
    async create(plan: PlannedWrites): Promise<CreateOutcome> {
      if (working) return { kind: 'busy' };
      working = true;
      const attempt = confirmedPlan ?? structuredClone(plan);
      try {
        if (confirmedPlan === null) {
          try {
            const created = await writes.createAsset(attempt.row);
            if (created?.id !== attempt.row.id) {
              throw new Error('The server did not confirm this site. No setup changes were sent; check Sites before trying again.');
            }
            confirmedPlan = attempt;
          } catch (error) {
            // The site the store names, never the id just typed: they differ
            // where another site holds the domain (bead `ro-ujb9.76.4.6`). A
            // refusal that names none offers no way to it.
            if (error instanceof AssetExistsError) {
              return { kind: 'rejected', field: 'domain', message: 'Already added', existing: error.holder, existingStatus: error.existingStatus };
            }
            if (error instanceof ApiError && error.code === 'asset_exists') {
              return { kind: 'rejected', field: 'domain', message: 'Already added' };
            }
            if (error instanceof ApiError && error.status === 422) {
              return { kind: 'rejected', field: error.field === 'displayName' ? 'displayName' : 'domain', message: error.message };
            }
            return { kind: 'failed', message: error instanceof Error ? error.message : 'The site was not created' };
          }
        }
        try {
          const result = await writes.createAssetConfig(attempt.ops, attempt.slug);
          return { kind: 'created', plan: attempt, result };
        } catch (error) {
          return { kind: 'setup-needed', report: {
            id: attempt.row.id,
            reason: error instanceof Error ? error.message : 'The setup could not be confirmed',
            changeset: JSON.stringify(buildChangeset(attempt.ops, { slug: attempt.slug }), null, 2),
          } };
        }
      } finally { working = false; }
    },
  };
}

/** useConfigSave calls record only after the write, including its guarded Undo.
 * Recording failure remains separate from a stage change that already landed. */
export function lifecycleSaveRequest(
  assetId: string, from: AssetStatus, to: AssetStatus,
  recordAnnotation: (input: { kind: typeof LIFECYCLE_ANNOTATION_KIND; ref: string }) => Promise<void>,
  label = 'Lifecycle stage',
): SaveRequest {
  return {
    label,
    ops: [{ kind: 'store-asset-set', asset: assetId, column: 'status', expect: from, value: to }],
    record: async (written) => {
      for (const op of written) {
        if (op.kind !== 'store-asset-set' || op.column !== 'status') continue;
        await recordAnnotation({ kind: LIFECYCLE_ANNOTATION_KIND,
          ref: lifecycleMoveRef({ from: op.expect as AssetStatus, to: op.value as AssetStatus }) });
      }
    },
  };
}
