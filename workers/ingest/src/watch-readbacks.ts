// The queue between a closed watch window and the task that is owed its
// verdict. This module cannot post anything itself (workerd has no `bd`), so
// the runner asks what is pending, posts it, and says so; `readback_posted_at`
// is stamped only on the way back, so a crash between the two leaves the
// verdict pending rather than lost. Reporting twice is the failure guarded
// against; reporting late is not a failure.

import type { WatchScopeInput } from '@noticeos/contract';
import { javascriptInstant } from '@noticeos/postgres';
import { parseWatchScope, watchScopeLabel, watchScopeSelector } from './watch-windows.js';

/** A backlog drains over ticks rather than in one unbounded body. */
export const WATCH_READBACK_MAX_BATCH = 50;

/** One closed window whose verdict has not reached its task. */
export interface PendingWatchReadback {
  windowId: string;
  bead: string;
  asset: string;
  outcome: string;
  closedAt: string;
  /** Composed here so one place owns the sentence an operator reads. */
  comment: string;
}

interface ReadbackRow extends Record<string, unknown> {
  id: string;
  asset: string;
  ref: string;
  note: string | null;
  metric_integration: string;
  metric: string;
  scope_json: string | null;
  registered_at: string;
  closed_at: string;
  outcome: string;
  outcome_note: string | null;
  readback_bead: string;
}

export async function readPendingWatchReadbacks(
  env: IngestEnv,
  limit: number = WATCH_READBACK_MAX_BATCH,
): Promise<PendingWatchReadback[]> {
  // Oldest close first, ties by id.
  const records = await env.STORE.read((tx) =>
    tx.query<ReadbackRow>(
      `SELECT window_id AS id, asset_id AS asset, ref, note, metric_integration, metric,
              scope::text AS scope_json, registered_at, closed_at, outcome, outcome_note, readback_bead
         FROM noticeos.watch_windows
        WHERE status = 'closed'
          AND readback_bead IS NOT NULL
          AND readback_posted_at IS NULL
        ORDER BY closed_at ASC, window_id COLLATE "C" ASC
        LIMIT $1`,
      [Math.max(1, Math.min(limit, WATCH_READBACK_MAX_BATCH))],
    ),
  );
  const rows = records.map((record) => ({
    ...record,
    registered_at: javascriptInstant(record.registered_at),
    closed_at: javascriptInstant(record.closed_at),
  }));

  return rows.map((row) => ({
    windowId: row.id,
    bead: row.readback_bead,
    asset: row.asset,
    outcome: row.outcome,
    closedAt: row.closed_at,
    comment: readbackComment(row),
  }));
}

/**
 * The sentence posted on the task: what was bet, what came back, and where to
 * look, and nothing about what to do next. A verdict is evidence for the
 * person who owns the reading.
 */
function readbackComment(row: ReadbackRow): string {
  const scope: WatchScopeInput | null = parseWatchScope(row.scope_json);
  const selector = watchScopeSelector(scope);
  const series = `${row.metric_integration}/${row.metric}`;
  const measured = selector ? `${series} for ${watchScopeLabel(selector)}` : `${series}, property-wide`;
  const what = row.note && row.note.trim().length > 0 ? row.note.trim() : row.ref;
  return [
    `Watch window ${row.outcome} — ${row.asset}`,
    '',
    `Watching: ${what}`,
    `Measured: ${measured}`,
    row.outcome_note ? `Reading: ${row.outcome_note}` : 'Reading: no note recorded.',
    '',
    `Registered ${row.registered_at.slice(0, 10)}, closed ${row.closed_at.slice(0, 10)}. ` +
      `A flag carrying the same numbers is on the ${row.asset} card. Window ${row.id}.`,
  ].join('\n');
}

/**
 * Stamp the windows whose verdicts have been posted. The WHERE clause repeats
 * every precondition rather than trusting the caller's list: an id that is
 * open, unclaimed or already stamped is left alone and reported as not stamped.
 */
export async function markWatchReadbacksPosted(
  env: IngestEnv,
  ids: string[],
  nowMs: number = Date.now(),
): Promise<{ posted: string[]; skipped: string[] }> {
  const wanted = [...new Set(ids)].slice(0, WATCH_READBACK_MAX_BATCH);
  if (wanted.length === 0) return { posted: [], skipped: [] };

  const now = new Date(nowMs).toISOString();
  const stamped = await env.STORE.write((tx) =>
    tx.query<{ id: string }>(
      `UPDATE noticeos.watch_windows
          SET readback_posted_at = $2::timestamptz
        WHERE window_id = ANY($1::text[])
          AND status = 'closed'
          AND readback_bead IS NOT NULL
          AND readback_posted_at IS NULL
        RETURNING window_id AS id`,
      [wanted, now],
    ),
  );
  const stampedIds = new Set(stamped.map((row) => row.id));
  // In the caller's order.
  const posted = wanted.filter((id) => stampedIds.has(id));
  return { posted, skipped: wanted.filter((id) => !stampedIds.has(id)) };
}
