// The route a verdict takes back to the bead that is owed it (db/0024).
//
// A closed watch window already files a flag on its property (see
// `closeWindow`). That is the right surface for "what happened to this
// property", and the wrong one for "what happened to the thing I did": the
// freeze register in each spoke names a READBACK BEAD per entry — the bead that
// owns the reading — and until now that bead learned nothing. The verdict sat
// on a card, and the task that caused the change sat open beside it.
//
// This module is the queue between the two. It cannot post anything itself:
// workerd has no `bd`, and the beads hub is a Dolt server this store only
// mirrors (db/0017). So the runner asks what is pending, posts it, and says so —
// and because the store stamps `readback_posted_at` only on the way back, a
// crash between the two leaves the verdict pending rather than lost. Reporting
// twice is the failure this guards against; reporting late is not a failure.

import type { WatchScopeInput } from '@noticeos/contract';
import { javascriptInstant } from '@noticeos/postgres';
import { parseWatchScope, watchScopeLabel, watchScopeSelector } from './watch-windows.js';

/** How many verdicts one poll carries. A backlog drains over ticks rather than
 * in one unbounded body — the posture db/0022 set for job runs. */
export const WATCH_READBACK_MAX_BATCH = 50;

/** One closed window whose verdict has not reached its bead. */
export interface PendingWatchReadback {
  windowId: string;
  bead: string;
  asset: string;
  outcome: string;
  closedAt: string;
  /** The comment to post, composed HERE so one place owns the sentence an
   * operator will read on the bead. */
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
  // On Postgres (bead ro-ujb9.76.5.7): the pending windows' own index, oldest
  // close first, ties by id.
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
 * The sentence posted on the bead.
 *
 * It says what was bet, what came back, and where to look — and nothing about
 * what to do next. A verdict is evidence for the person who owns the reading;
 * an OS that also announced the decision would be pre-registering the operator.
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
 * Stamp the windows whose verdicts have been posted.
 *
 * The WHERE clause repeats every precondition rather than trusting the caller's
 * list: an id that is open, unclaimed, or already stamped is left alone and
 * reported as not stamped, so a confused runner cannot mark a verdict delivered
 * that never was.
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
  // In the caller's order, as the D1 batch answered them.
  const posted = wanted.filter((id) => stampedIds.has(id));
  return { posted, skipped: wanted.filter((id) => !stampedIds.has(id)) };
}
