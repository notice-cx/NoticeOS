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
  type WorkPayload,
  type WorkProject,
} from "../shared/work";

export interface WorkPayloadOptions {
  now: Date;
  /** The snapshot the caller already read (the task source seam reads it once
   * per request, `./task-source`); absent reads the newest one here. */
  snapshot?: BeadsSnapshot | null;
}

/** The whole board. */
export async function buildWorkPayload(
  store: WorkspaceStore,
  { now, snapshot: given }: WorkPayloadOptions,
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
    }): WorkProject => ({
      ...project,
      // An unknown asset id still renders under its own id, so config drift shows.
      name: names.get(project.asset) ?? project.asset,
      // No rollup rows yet: an empty history, never a dropped project.
      history: history.byProject.get(project.asset) ?? emptyWorkHistory(),
    }),
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
