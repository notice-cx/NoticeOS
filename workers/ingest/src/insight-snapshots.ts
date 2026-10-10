// The executive-snapshot writer: an operator publishes a reviewed analysis
// read model, which is all the Tower ever shows. `contentSha256` is the hash of
// the exact payload string stored, and the id carries its first 24 hex chars,
// so a re-publish of the same bytes is provably the same row and a no-op. The
// payload is stored verbatim for the same reason.

import { assetKnown } from './asset-registry.js';
import {
  FUTURE_SKEW_MS,
  Issues,
  SITE_ROW_FIELDS,
  declaredString,
  isoDate,
  nonNegativeInteger,
  pastInstant,
} from './routes/validate.js';
import { sha256Hex } from './shared.js';

/** A future shape gets a new number and a migration, never a silent
 * reinterpretation of these columns. */
export const INSIGHT_SCHEMA_VERSION = 1;

/** Fixed forever: changing it renames every future row and breaks the
 * "same file, same id" property callers rely on. */
export const INSIGHT_ID_HASH_CHARS = 24;

/** A bound on a runaway producer; a real snapshot is tens of kilobytes. */
export const INSIGHT_PAYLOAD_MAX_BYTES = 1_000_000;

/** A snapshot carrying hundreds of findings is a rule that has gone wrong. */
export const INSIGHT_MAX_ITEMS = 500;

export type InsightSnapshotResult =
  | {
      ok: true;
      /** False when this exact payload was already published: a no-op. */
      created: boolean;
      id: string;
      asset: string;
      contentSha256: string;
      generatedAt: string;
    }
  | { ok: false; error: 'bad_request'; detail: string }
  | { ok: false; error: 'unknown_asset'; asset: string }
  | { ok: false; error: 'validation'; issues: { path: string; code: string; message: string }[] };

/** One spelling of the id, in one place. */
export function insightSnapshotId(asset: string, contentSha256: string): string {
  return `insight:${asset}:${contentSha256.slice(0, INSIGHT_ID_HASH_CHARS)}`;
}

/** Both absent or both present and ordered, as the table's CHECK demands; a
 * caller deserves to hear which field is wrong. */
function parseWindow(
  issues: Issues,
  raw: Record<string, unknown>,
): { start: string | null; end: string | null } {
  const rawStart = raw.windowStart;
  const rawEnd = raw.windowEnd;
  const absent = (value: unknown) => value === undefined || value === null;
  if (absent(rawStart) && absent(rawEnd)) return { start: null, end: null };
  if (absent(rawStart) || absent(rawEnd)) {
    issues.add(
      'windowStart',
      'custom',
      'windowStart and windowEnd must both be present or both absent',
    );
    return { start: null, end: null };
  }
  const start = isoDate(issues, rawStart, 'windowStart');
  const end = isoDate(issues, rawEnd, 'windowEnd');
  if (start !== null && end !== null && start > end) {
    issues.add('windowEnd', 'custom', 'windowEnd must not precede windowStart');
  }
  return { start, end };
}

/**
 * Validate one published snapshot and store it if it is not already there.
 * This enforces the shape the Tower's reader assumes and the constraints the
 * table declares, nothing about the findings, which are stored whole. A
 * rejected field comes back as a result; only a store failure throws.
 */
export async function writeInsightSnapshot(
  env: IngestEnv,
  payload: string,
  nowMs: number = Date.now(),
): Promise<InsightSnapshotResult> {
  const bytes = new TextEncoder().encode(payload).length;
  if (bytes > INSIGHT_PAYLOAD_MAX_BYTES) {
    return {
      ok: false,
      error: 'bad_request',
      detail: `snapshot is ${bytes} bytes; the limit is ${INSIGHT_PAYLOAD_MAX_BYTES}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    return { ok: false, error: 'bad_request', detail: `could not parse body: ${String(err)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'bad_request', detail: 'body must be a JSON object' };
  }
  const raw = parsed as Record<string, unknown>;

  const issues = new Issues();
  if (raw.schemaVersion !== INSIGHT_SCHEMA_VERSION) {
    issues.add(
      'schemaVersion',
      'invalid_value',
      `schemaVersion must be ${INSIGHT_SCHEMA_VERSION}`,
    );
  }
  const asset = declaredString(issues, raw.asset, 'asset', SITE_ROW_FIELDS.id);
  // Never a future `generatedAt`: it orders the table the Tower reads
  // newest-first, so a future one would pin a stale analysis to the top.
  const generatedAt = pastInstant(issues, raw.generatedAt, 'generatedAt', nowMs, FUTURE_SKEW_MS);
  const window = parseWindow(issues, raw);
  const sourceArchiveCount = nonNegativeInteger(
    issues,
    raw.sourceArchiveCount,
    'sourceArchiveCount',
  );
  if (!Array.isArray(raw.items)) {
    issues.add('items', 'invalid_type', 'items must be an array');
  } else if (raw.items.length > INSIGHT_MAX_ITEMS) {
    issues.add('items', 'too_big', `items must hold at most ${INSIGHT_MAX_ITEMS} findings`);
  }

  if (!issues.ok || asset === null || generatedAt === null || sourceArchiveCount === null) {
    return { ok: false, error: 'validation', issues: issues.list };
  }

  // An unknown asset is a clean error, not a raw FK failure.
  if (!(await assetKnown(env.STORE, asset))) {
    return { ok: false, error: 'unknown_asset', asset };
  }

  const contentSha256 = await sha256Hex(payload);
  const id = insightSnapshotId(asset, contentSha256);

  // One transaction: insert unless this exact payload already exists, then,
  // when nothing was inserted, confirm the stored row. A CHECK or foreign key
  // refuses loudly, so "no row inserted" can only be a re-publish; a missing
  // row is a failure, never a write that never happened.
  const created = await env.STORE.write(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO noticeos.asset_insight_snapshots (
         workspace_id, snapshot_id, asset_id, generated_at, window_start, window_end,
         source_archive_count, content_sha256, payload
       ) VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::date, $6::date, $7, $8, $9::json)
       ON CONFLICT DO NOTHING
       RETURNING snapshot_id AS id`,
      [tx.workspaceId, id, asset, generatedAt, window.start, window.end, sourceArchiveCount, contentSha256, payload],
    );
    if (inserted.length > 0) return true;
    const existing = await tx.query<{ id: string }>(
      `SELECT snapshot_id AS id FROM noticeos.asset_insight_snapshots WHERE snapshot_id = $1`,
      [id],
    );
    if (existing.length === 0) {
      throw new Error('insight_snapshot_write_failed: row neither inserted nor found');
    }
    return false;
  });
  return { ok: true, created, id, asset, contentSha256, generatedAt };
}
