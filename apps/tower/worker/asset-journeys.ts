import {
  journeyDefinitionId,
  readJourneyDefinitions,
  readJourneySnapshot,
  type JourneySnapshot,
} from '@noticeos/contract/journeys';
import type { WorkspaceStore } from '@noticeos/postgres';

export interface JourneyBinding {
  asset: string;
  propertyId: string | null;
  timeZone: string | null;
}

export async function readJourneyBinding(
  store: WorkspaceStore,
  asset: string,
  mapping: { status?: string; propertyId?: string } | undefined,
): Promise<JourneyBinding> {
  if (mapping?.status === 'skipped' || mapping?.status === 'not-applicable') {
    return { asset, propertyId: null, timeZone: null };
  }
  const propertyId = mapping?.propertyId ?? null;
  const [observed] = await store.read((tx) => tx.query<{ propertyId: string; timeZone: string | null }>(
    `SELECT property_ref AS "propertyId", time_zone AS "timeZone"
       FROM noticeos.signal_runs
      WHERE asset_id = $1 AND integration = 'ga4' AND status = 'success'
        AND ($2::text IS NULL OR property_ref = $2)
      ORDER BY finished_at DESC, run_seq DESC LIMIT 1`,
    [asset, propertyId],
  ));
  return { asset, propertyId: propertyId ?? observed?.propertyId ?? null, timeZone: observed?.timeZone ?? null };
}

/** The current saved definition controls visibility, including before collection. */
export function assetJourneys(payload: string | null, definitions: unknown, binding: JourneyBinding): JourneySnapshot {
  const current = [...(readJourneyDefinitions(definitions) ?? [])];
  let stored: JourneySnapshot | null = null;
  if (payload !== null) {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          && (parsed as Record<string, unknown>).asset === binding.asset) {
        stored = readJourneySnapshot((parsed as Record<string, unknown>).journeys);
      }
    } catch {
      // An invalid published snapshot leaves saved definitions available to edit.
    }
  }
  return {
    source: 'ga4',
    countingUnit: 'activeUsers',
    generatedAt: stored?.generatedAt ?? null,
    definitions: current,
    funnels: (stored?.funnels ?? []).filter((result) => current.some((definition) =>
      definition.id === result.journeyId && definition.kind === 'funnel'
      && definition.status === 'active' && journeyDefinitionId(definition) === result.definitionId)
      && result.propertyId === binding.propertyId
      && (binding.timeZone === null || result.timeZone === binding.timeZone)),
    exploration: {
      state: 'unsupported',
      reason: 'Session paths need a source that records the order of pages within each visit.',
    },
  };
}
