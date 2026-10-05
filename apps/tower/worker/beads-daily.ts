// The one reader of the task hub's daily counts (db/migrations/0032, bead
// `ro-78qo.23`; on Postgres, `noticeos.task_daily_counts`, since bead
// ro-ujb9.76.4.3) — the daily rollup that puts a trend behind the Tasks
// strip's six numbers.
//
// Its sibling `./beads-snapshot` reads the newest PHOTOGRAPH, which is what is
// happening now. This reads the ROLLUP, which is what has been happening. Two
// tables, two questions, and the split is on purpose: the photograph is a cache
// of the hub's present state and is pruned inside a week, while these rows are
// the only record there will ever be of a past day — the hub itself holds no
// history of its own counts.
//
// A migrated store always has the table: an empty history means the rollup
// has no days yet.

import type { WorkspaceStore } from "@noticeos/postgres";
import { type WorkCountsHistory, emptyWorkHistory } from "../shared/work";

type DailyRow = {
  asset: string;
  day: string;
  waiting: number | null;
  urgent: number | null;
  open: number;
  inProgress: number;
  blocked: number;
  closedIds: string | null;
};

export interface BeadsDailyHistory {
  /** One entry per project the rollup holds days for. A project with no rows is
   * simply absent — the payload gives it an empty history. */
  byProject: Map<string, WorkCountsHistory>;
  /** How many distinct calendar days the table holds, across every project. */
  days: number;
}

/** How many ids the day's closed set holds, or null when the day's closings
 * were never observable (the column is NULL, or holds something that is not a
 * list of ids any more). Null is a GAP in the series, never a zero. */
function closedCount(stored: string | null): number | null {
  if (stored === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed.length : null;
}

/**
 * Every day the rollup holds, per project.
 *
 * ONE READ FOR THE WHOLE WINDOW. 400 days across six projects is 2,400 rows of
 * seven small columns — smaller than the single snapshot payload the sibling
 * reader already parses on every request, and the alternative (a query per
 * project) would be six round trips to save nothing.
 *
 * A NULL COUNT DOES NOT BECOME A POINT. `waiting` and `urgent` are null on the
 * days a poller did not measure them and `closed` on the days whose closings
 * were not observable; each of those is a day MISSING from that one series
 * while the other five keep it. Pushing a zero instead would draw a queue that
 * emptied on the day nobody looked (doc 21 principle 8).
 */
export async function loadBeadsDailyHistory(store: WorkspaceStore): Promise<BeadsDailyHistory> {
  const rows = await store.read((tx) =>
    tx.query<DailyRow>(
      `SELECT project AS asset,
              day,
              waiting,
              urgent,
              open,
              in_progress AS "inProgress",
              blocked,
              closed_ids::text AS "closedIds"
         FROM noticeos.task_daily_counts
        ORDER BY day ASC, project COLLATE "C" ASC`,
    ),
  );

  const byProject = new Map<string, WorkCountsHistory>();
  const days = new Set<string>();
  for (const row of rows) {
    if (typeof row.asset !== "string" || typeof row.day !== "string") continue;
    days.add(row.day);
    let history = byProject.get(row.asset);
    if (!history) {
      history = emptyWorkHistory();
      byProject.set(row.asset, history);
    }
    push(history.waiting, row.day, row.waiting);
    push(history.urgent, row.day, row.urgent);
    push(history.open, row.day, row.open);
    push(history.inProgress, row.day, row.inProgress);
    push(history.blocked, row.day, row.blocked);
    push(history.closed, row.day, closedCount(row.closedIds));
  }
  return { byProject, days: days.size };
}

function push(series: { t: string; v: number }[], day: string, value: number | null): void {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return;
  series.push({ t: day, v: Number(value) });
}
