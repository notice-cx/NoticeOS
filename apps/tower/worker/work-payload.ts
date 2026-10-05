// Work payload assembly — behind GET /api/work, the read-only board over the
// beads task hub. Pure over the call's store (the photographs, the daily
// rollup and the site names are all on Postgres, beads ro-ujb9.76.4.2 and
// ro-ujb9.76.4.3).
//
// THREE reads and no writes. The Tower never talks to the hub — it cannot; the
// hub speaks MySQL and lives on the operator's Mac — so everything here comes
// from the newest task photograph that `scripts/os-up.mjs` filed through the
// ingest worker. Reading that row is `./beads-snapshot`'s job, shared with
// the asset card's work widget; this module only names the projects and
// wraps them in the board's payload.
//
// The third read is the DAILY ROLLUP (`./beads-daily`, db/0032), which is what
// gives the Tasks strip's six numbers a trend to ride — the photograph says
// what is true now, the rollup says what has been true since (bead
// `ro-78qo.23`). Both are in the call's store (bead ro-ujb9.76.4.3), which
// always has the rollup, so `historyDays` is always a count.

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
    // No snapshot has ever been filed. A fully-formed payload with no projects,
    // so the client branches on loading/error only (the wall/integrations rule).
    return {
      generatedAt,
      capturedAt: null,
      pollCadenceHours: WORK_POLL_CADENCE_HOURS,
      owner: WORK_OWNER,
      projects: [],
      historyDays: history.days,
    };
  }

  // The OS's own project is named by the product, like its row everywhere
  // else (bead `ro-ujb9.77.10`).
  const names = new Map((await readSites(store)).map((site) => [site.id, assetDisplayName(site.isOs, site.displayName)]));

  const projects: WorkProject[] = snapshot.projects.map(
    // `panelReview` is dropped here on purpose (bead `ro-rkp`): it is a
    // asset-CARD fact — one bead's review state, rendered as a glyph beside
    // an asset name — and this board already lists that bead among the
    // project's open work. Letting the spread carry it would put an undeclared
    // field in the /work payload that no reader on this route consumes.
    //
    // `handoffs` goes the same way for the same reason (bead `ro-248`): it is a
    // finding-CARD fact, and the beads it names are ordinary work this board
    // already renders under their own project. A board row is about the task;
    // the join is only interesting where the finding is.
    //
    // `waitingUrgent` is the Wall's portfolio roll-up input. This board already
    // carries each waiting row and its priority, so leaking a second undeclared
    // count here would create two public shapes for the same project.
    ({
      panelReview: _cardOnly,
      handoffs: _findingOnly,
      waitingUrgent: _wallOnly,
      ...project
    }): WorkProject => ({
      ...project,
      // An asset id with no row in `assets` still renders, under its own id: the
      // snapshot is the observation, and dropping a project because the store
      // does not recognize it would hide a config drift instead of showing it.
      name: names.get(project.asset) ?? project.asset,
      // A project the rollup has no rows for gets an EMPTY history rather than
      // being dropped from it: a spoke added this morning is on the board today
      // and in the series tomorrow, and the strip's own three-point floor is
      // what decides when a line may be drawn.
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
