// The one reader of `noticeos.task_daily_counts`, the rollup behind the Tasks
// strip's trend. `./beads-snapshot` reads the present and is pruned within a
// week; these rows are the only record of a past day, since the hub keeps no
// history of its own counts.

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
 * list of ids). Null is a gap in the series, never a zero. */
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
 * Every day the rollup holds, per project, in one read. A null count is a day
 * missing from that one series, never a zero: a zero would draw a queue that
 * emptied on the day nobody looked.
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
