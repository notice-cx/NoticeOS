// GET /api/work — the read-only task board. The Tower never talks to the hub;
// it reads the newest task snapshot ingest filed (`./beads-snapshot`), the daily
// rollup (`./beads-daily`) and the site names, and writes nothing.

import { assetDisplayName } from "@noticeos/contract/asset-name";
import type { WorkspaceStore } from "@noticeos/postgres";
import { readSites } from "./asset-registry";
import { loadBeadsDailyHistory } from "./beads-daily";
import { loadLatestBeadsSnapshot, type BeadsSnapshot } from "./beads-snapshot";
import {
  WORK_OWNER,
  WORK_POLL_CADENCE_HOURS,
  emptyWorkHistory,
  workWeeks,
  type WorkPayload,
  type WorkProject,
  type WorkWeeks,
} from "../shared/work";

export interface WorkPayloadOptions {
  now: Date;
  /** The snapshot the caller already read (the task source seam reads it once
   * per request, `./task-source`); absent reads the newest one here. */
  snapshot?: BeadsSnapshot | null;
  /** The installation's clock (`os_time_zone`), which decides where a week
   * starts. UTC when the caller has none. */
  timeZone?: string;
}

/** The days a week reading needs: this week and last (fourteen), the day
 * before the seven-day window, and one for the history's UTC day running
 * ahead of the installation's. */
const WEEKS_HISTORY_DAYS = 16;

/** Each project's week against the week before, keyed by asset id, from the
 * daily rollup's last few days: what the Wall's work tile reads. A project
 * the rollup holds no day for is absent. */
export async function loadWorkWeeks(store: WorkspaceStore, now: Date, timeZone: string): Promise<Map<string, WorkWeeks>> {
  const since = new Date(now.getTime() - WEEKS_HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const history = await loadBeadsDailyHistory(store, { since });
  return new Map([...history.byProject].map(([asset, series]) => [asset, workWeeks(series, now, timeZone)]));
}

/** The whole board. */
export async function buildWorkPayload(
  store: WorkspaceStore,
  { now, snapshot: given, timeZone = "UTC" }: WorkPayloadOptions,
): Promise<WorkPayload> {
  const generatedAt = now.toISOString();

  const snapshot = given === undefined ? await loadLatestBeadsSnapshot(store) : given;
  const history = await loadBeadsDailyHistory(store);

  if (!snapshot) {
    // No snapshot has ever been filed: a fully-formed payload with no projects,
    // so the client branches on loading/error only.
    return {
      generatedAt,
      capturedAt: null,
      pollCadenceHours: WORK_POLL_CADENCE_HOURS,
      owner: WORK_OWNER,
      projects: [],
      historyDays: history.days,
    };
  }

  const names = new Map((await readSites(store)).map((site) => [site.id, assetDisplayName(site.isOs, site.displayName)]));

  const projects: WorkProject[] = snapshot.projects.map(
    // Card, finding and Wall fields stay off the /work payload: the board
    // already lists the tasks they summarize.
    ({
      panelReview: _cardOnly,
      handoffs: _findingOnly,
      waitingUrgent: _wallOnly,
      ...project
    }): WorkProject => {
      // No rollup rows yet: an empty history, never a dropped project.
      const series = history.byProject.get(project.asset) ?? emptyWorkHistory();
      return {
        ...project,
        // An unknown asset id still renders under its own id, so config drift shows.
        name: names.get(project.asset) ?? project.asset,
        history: series,
        // A store with no rollup at all has no weeks to read, which is not a
        // week of zeroes.
        ...(history.days > 0 ? { weeks: workWeeks(series, now, timeZone) } : {}),
      };
    },
  );

  return {
    generatedAt,
    capturedAt: snapshot.capturedAt,
    pollCadenceHours: WORK_POLL_CADENCE_HOURS,
    owner: WORK_OWNER,
    projects,
    historyDays: history.days,
  };
}
