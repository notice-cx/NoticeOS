// The annotation writer — one implementation behind two capabilities.
//
// `POST /api/annotations` (operator bearer, routes/annotations.ts) and the
// `createAnnotation()` RPC method on the WorkerEntrypoint (the Tower's private
// Service Binding, index.ts) are two ways to be ALLOWED to write, not two ways
// to write. The rules — kind vocabulary, backdating, `(asset, at, kind, ref)`
// identity, field caps — live here so the lanes cannot drift apart. The Tower
// briefly carried its own copy of this SQL because it could not hold the
// operator bearer (docs/10 build note); this module is what that copy collapsed
// into.

import type {
  AnnotationKind,
  AnnotationRow,
  CreateAnnotationInput,
  CreateAnnotationResult,
} from '@noticeos/contract';
import { javascriptInstant } from '@noticeos/postgres';
import { recordMutation, type MutationActor } from '@noticeos/postgres/mutation-audit';
import { assetKnown } from './asset-registry.js';
import {
  ASSET_ID_MAX,
  FUTURE_SKEW_MS,
  Issues,
  enumValue,
  optionalString,
  pastInstant,
  requiredString,
} from './routes/validate.js';

/** The `annotations.kind` CHECK constraint (db/postgres/migrations/0001_baseline.sql),
 * typed against the contract so the two cannot disagree silently. */
export const ANNOTATION_KINDS: readonly AnnotationKind[] = [
  'deploy',
  'model-change',
  'config',
  'incident',
  'autonomy-change',
  'external',
];

/** commit sha / config version / model+version / update-calendar id. */
export const ANNOTATION_REF_MAX = 256;
export const ANNOTATION_NOTE_MAX = 1000;

/** An annotation in the row's own words; its number is the id a reader
 * shows (bead ro-ujb9.76.5.7). */
const COLUMNS = `annotation_number AS id, asset_id AS asset, at, kind, ref, note, created_at`;

/** An annotation as Postgres returns it: the number is an `int8`. */
type StoredAnnotation = Omit<AnnotationRow, 'id'> & { id: bigint } & Record<string, unknown>;

function asRow(row: StoredAnnotation): AnnotationRow {
  return {
    id: Number(row.id),
    asset: row.asset,
    at: javascriptInstant(row.at),
    kind: row.kind,
    ref: row.ref,
    note: row.note,
    created_at: javascriptInstant(row.created_at),
  };
}

/**
 * Validate one claimed timeline event and write it if it is not already there.
 *
 * `input` is caller-supplied on both lanes — an HTTP body and an RPC argument
 * are equally untrusted — so every field is validated here regardless of the
 * static type. A rejected field or an unknown asset comes back as a result;
 * only a store failure throws.
 */
export async function writeAnnotation(
  env: IngestEnv,
  input: CreateAnnotationInput,
  nowMs: number = Date.now(),
  actor: MutationActor | null = null,
): Promise<CreateAnnotationResult> {
  const issues = new Issues();
  const asset = requiredString(issues, input.asset, 'asset', ASSET_ID_MAX);
  const kind = enumValue(issues, input.kind, 'kind', ANNOTATION_KINDS);
  // `at` defaults to now, so an annotation written the moment a deploy lands
  // needs no clock handling on the caller's side.
  const at =
    input.at === undefined || input.at === null
      ? new Date(nowMs).toISOString()
      : pastInstant(issues, input.at, 'at', nowMs, FUTURE_SKEW_MS);
  const ref = optionalString(issues, input.ref, 'ref', ANNOTATION_REF_MAX);
  const note = optionalString(issues, input.note, 'note', ANNOTATION_NOTE_MAX);

  if (!issues.ok || !asset || !kind || !at) {
    return { ok: false, error: 'validation', issues: issues.list };
  }

  // An unknown asset is a clean error, not a raw FK failure (same posture as
  // the revenue lane). The site list is on Postgres (bead ro-ujb9.76.4.2).
  if (!(await assetKnown(env.STORE, asset))) {
    return { ok: false, error: 'unknown_asset', asset };
  }

  // Idempotent re-post: identity is (asset, at, kind, ref) — `note` is prose
  // about the event, not part of what makes it the same event. `IS NOT
  // DISTINCT FROM` is null-safe equality, so two ref-less deploys at the same
  // instant still collapse to one row. The read and the insert are one
  // transaction holding that identity, so two posts of one event at once are
  // one row: D1 had that from running one statement at a time (bead
  // ro-ujb9.76.5.7).
  return env.STORE.write(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `noticeos.annotation:${tx.workspaceId}:${JSON.stringify([asset, at, kind, ref])}`,
    ]);
    const [existing] = await tx.query<StoredAnnotation>(
      `SELECT ${COLUMNS}
         FROM noticeos.annotations
        WHERE asset_id = $1 AND at = $2::timestamptz AND kind = $3 AND ref IS NOT DISTINCT FROM $4
        ORDER BY annotation_number ASC
        LIMIT 1`,
      [asset, at, kind, ref],
    );
    if (existing) return { ok: true, created: false, annotation: asRow(existing) };

    const [inserted] = await tx.query<StoredAnnotation>(
      `INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind, ref, note)
       VALUES ($1::uuid, $2, $3::timestamptz, $4, $5, $6)
       RETURNING ${COLUMNS}`,
      [tx.workspaceId, asset, at, kind, ref, note],
    );
    if (!inserted) {
      // A write that produced no row is never reported as a write that worked.
      throw new Error('annotation_write_failed: insert returned no row');
    }
    await recordMutation(tx, actor, { event: 'annotation.create', assetId: asset,
      subject: { annotationNumber: String(inserted.id), kind } });
    return { ok: true, created: true, annotation: asRow(inserted) };
  });
}
