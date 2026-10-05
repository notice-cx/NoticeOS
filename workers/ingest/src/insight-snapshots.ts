// The executive-snapshot writer — the one WRITE lane out of the local analysis
// tree into the central store (`noticeos.asset_insight_snapshots`, bead
// ro-ujb9.76.5.4; first db/migrations/0008_property_insight_snapshots.sql).
//
// The producer is `scripts/signal-insights-publish.mjs`: an operator reviews
// `.local/signal-dumps/reports/<asset>/executive.json` and publishes that
// compact read model, which is all the Tower ever shows. The raw archives stay
// in R2 and the CSVs stay on disk; this table is the presentation boundary.
//
// WHY THIS IS A ROUTE. Until now the script reached the store by shelling out to
// `wrangler d1 execute --local --persist-to ../../.wrangler/state`, which starts
// a SECOND miniflare over the sqlite file the live runtime already holds open as
// its D1DatabaseObject — the 2026-08-02 corruption topology (ro-mad, ro-icq).
// A second READER is bad; this lane was a second WRITER, run beside a live
// `os:up` because that is the only state the operator ever runs it in. So the
// write comes through the runtime that owns the file (bead ro-2zk.3).
//
// CONTENT-ADDRESSING IS OVER THE STORED BYTES. `contentSha256` is the SHA-256 of
// the exact payload string this module stores, and the id carries its first 24
// hex chars. Hashing what is stored — rather than re-serializing and hashing
// that — is what makes a re-publish of the same file provably the same row: the
// caller can compute the id it expects before it asks, and the store's one
// row per site and hash turns the second publish into a no-op instead of a
// duplicate.
//
// The payload is stored VERBATIM for the same reason. A normalizing writer (the
// beads-snapshot lane does normalize, deliberately) would change the bytes the
// hash names, and the id would stop meaning "this exact analysis output".

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

/** The only snapshot shape this store understands. `signal-history-analyze.mjs`
 * stamps it; a future shape gets a new number and a migration, never a silent
 * reinterpretation of these columns. */
export const INSIGHT_SCHEMA_VERSION = 1;

/** How much of the digest names the row. Twenty-four hex chars is 96 bits —
 * collision-free for a per-property table that grows a handful of rows a week,
 * and short enough to read in a log line. Fixed forever: changing it renames
 * every future row and breaks the "same file, same id" property callers rely
 * on to predict what they are about to write. */
export const INSIGHT_ID_HASH_CHARS = 24;

/** A ceiling on one publish, well inside D1's 2 MB row limit. One asset's
 * July snapshot is ~34 KB, so this is a bound on a runaway producer rather than
 * a budget anyone has to think about. */
export const INSIGHT_PAYLOAD_MAX_BYTES = 1_000_000;

/** The executive page renders eight cards and lists the rest in
 * `suppressedItems`; a snapshot carrying hundreds of findings is a rule that
 * has gone wrong, not a property with a lot to say. */
export const INSIGHT_MAX_ITEMS = 500;

export type InsightSnapshotResult =
  | {
      ok: true;
      /** False when this exact payload was already published — the write is a
       * no-op and the caller is told so rather than being let believe it wrote. */
      created: boolean;
      id: string;
      asset: string;
      contentSha256: string;
      generatedAt: string;
    }
  | { ok: false; error: 'bad_request'; detail: string }
  | { ok: false; error: 'unknown_asset'; asset: string }
  | { ok: false; error: 'validation'; issues: { path: string; code: string; message: string }[] };

export async function sha256Hex(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The row id for a payload's digest. Exported because the publisher prints it
 * and the tests pin it: one spelling, in one place. */
export function insightSnapshotId(asset: string, contentSha256: string): string {
  return `insight:${asset}:${contentSha256.slice(0, INSIGHT_ID_HASH_CHARS)}`;
}

/** The window pair, enforced exactly as the table's CHECK does — both absent or
 * both present and ordered. A half-open window would be rejected by sqlite as a
 * constraint failure, and a caller deserves to hear WHICH field is wrong. */
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
 *
 * `payload` is the raw request body, untrusted and unparsed: this module is the
 * only thing standing between a local analysis run and a column the Tower
 * renders as fact. What it enforces is the shape the Tower's reader assumes and
 * the constraints the table declares — nothing about the FINDINGS, which are
 * the analyzer's business and are stored whole.
 *
 * A rejected field comes back as a result; only a store failure throws.
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
  // Not backdate-tolerant the way an annotation is: `generatedAt` is stamped by
  // the analyzer that just read the pinned history, and it orders the table the Tower
  // reads newest-first. A future one would pin itself to the top of that read
  // and make a stale analysis look like today's.
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

  // An unknown asset is a clean error, not a raw FK failure (same posture as the
  // annotation and revenue lanes). The site list is on Postgres (bead
  // ro-ujb9.76.4.2).
  if (!(await assetKnown(env.STORE, asset))) {
    return { ok: false, error: 'unknown_asset', asset };
  }

  const contentSha256 = await sha256Hex(payload);
  const id = insightSnapshotId(asset, contentSha256);

  // One transaction: the snapshot stored unless this exact payload already is
  // (`ON CONFLICT DO NOTHING` on the site and hash, the model's no-op
  // republish), then, when nothing was inserted, the stored row confirmed. A
  // CHECK or a foreign key refuses loudly here, so "no row inserted" can only
  // be a re-publish — and if the row is not found, the caller hears a failure
  // instead of a write that never happened.
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
