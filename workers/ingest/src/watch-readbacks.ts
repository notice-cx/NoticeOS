// The queue between a closed watch window and the task that is owed its
// verdict. This module cannot post anything itself (workerd has no `bd`), so
// the runner asks what is pending, posts it, and says so; `readback_posted_at`
// is stamped only on the way back, so a crash between the two leaves the
// verdict pending rather than lost. Reporting twice is the failure guarded
// against; reporting late is not a failure.

import type { WatchScopeInput } from '@noticeos/contract';
import { javascriptInstant } from '@noticeos/postgres';
import { recordMutation } from '@noticeos/postgres/mutation-audit';
import { settledFlagsSql, TUNE_CARRIED_MARK } from '@noticeos/contract/flag-open';
import { parseWatchScope, watchScopeLabel, watchScopeSelector } from './watch-windows.js';

/** Each delivery or review request has a bounded body. */
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
 * The result and completion instructions posted to the existing review task.
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
    'Close this task with the review decision and evidence after reviewing this result. ' +
      'If the task is already closed, reopen it first. Completing the review marks its alert read; the measured outcome stays unchanged.',
    '',
    `Registered ${row.registered_at.slice(0, 10)}, closed ${row.closed_at.slice(0, 10)}. ` +
      `A flag carrying the same numbers is on the ${row.asset} card. Window ${row.id}.`,
  ].join('\n');
}

export interface WatchReview {
  flagNumber: number;
  windowId: string;
  asset: string;
  bead: string;
  postedAt: string;
}

export interface CompletedWatchReview extends WatchReview {
  closedAt: string;
  checkedAt: string;
  reason: string;
}

/** Keyset pages keep an unfinished early review from hiding later completions. */
export async function readWatchReviews(env: IngestEnv, after: number = 0): Promise<WatchReview[]> {
  const rows = await env.STORE.read((tx) => tx.query<WatchReview & Record<string, unknown>>(
    `SELECT f.flag_number::int AS "flagNumber", w.window_id AS "windowId", w.asset_id AS asset,
            w.readback_bead AS bead, w.readback_posted_at AS "postedAt"
       FROM noticeos.watch_windows w
       JOIN noticeos.current_flags f ON f.asset_id = w.asset_id
        AND f.rule_id = 'watch-window-closed' AND f.rule_inputs->>'watchWindowId' = w.window_id
      WHERE w.status = 'closed' AND w.readback_bead IS NOT NULL AND w.readback_posted_at IS NOT NULL
        AND f.flag_number > $1 AND NOT ${settledFlagsSql('f')}
      ORDER BY f.flag_number LIMIT $2`, [after, WATCH_READBACK_MAX_BATCH],
  ));
  return rows.map((row) => ({ ...row, postedAt: javascriptInstant(row.postedAt) }));
}

/** Only a fresh, exact task close after delivery can acknowledge this result. */
export async function completeWatchReviews(
  env: IngestEnv, reviews: CompletedWatchReview[], nowMs: number = Date.now(),
): Promise<{ reviewed: number[]; skipped: number[] }> {
  const reviewed: number[] = [], skipped: number[] = [];
  const now = new Date(nowMs).toISOString();
  for (const review of reviews) {
    const checked = Date.parse(review.checkedAt), closed = Date.parse(review.closedAt), posted = Date.parse(review.postedAt);
    if (!Number.isFinite(checked) || !Number.isFinite(closed) || !Number.isFinite(posted)
      || checked > nowMs || nowMs - checked > 300_000 || closed > checked || closed <= posted
      || review.reason.trim() === '') {
      skipped.push(review.flagNumber);
      continue;
    }
    const changed = await env.STORE.write(async (tx) => {
      // Lock the mapping as well as the alert: a relink cannot race settlement.
      const [window] = await tx.query<{ id: string }>(
        `SELECT window_id AS id FROM noticeos.watch_windows
          WHERE window_id = $1 AND asset_id = $2 AND readback_bead = $3
            AND status = 'closed' AND readback_posted_at = $4::timestamptz FOR UPDATE`,
        [review.windowId, review.asset, review.bead, review.postedAt],
      );
      if (!window) return false;
      const rows = await tx.query<{ id: number }>(
        `UPDATE noticeos.flags SET disposition = 'ack', disposition_at = $1::timestamptz,
            disposition_note = $2 || CASE
              WHEN disposition = 'tune' AND disposition_note IS NOT NULL THEN $3 || disposition_note
              WHEN strpos(disposition_note, $3) > 0 THEN substr(disposition_note, strpos(disposition_note, $3))
              ELSE '' END,
            snooze_until = NULL, ack_expiry = NULL
          WHERE flag_number = $4 AND asset_id = $5 AND rule_id = 'watch-window-closed'
            AND rule_inputs->>'watchWindowId' = $6 AND replaced_by_pulse_id IS NULL AND NOT ${settledFlagsSql()}
          RETURNING flag_number::int AS id`,
        [now, `Outcome reviewed on task (${review.closedAt}); decision and evidence retained on the task.`, TUNE_CARRIED_MARK,
          review.flagNumber, review.asset, review.windowId],
      );
      if (rows.length === 0) return false;
      await recordMutation(tx, null, { event: 'flag.acknowledge', assetId: review.asset,
        subject: { flagNumber: review.flagNumber, changedCount: rows.length } });
      return true;
    });
    (changed ? reviewed : skipped).push(review.flagNumber);
  }
  return { reviewed, skipped };
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
