// The task source seam. Every task screen asks a source the same four things:
// is it connected, what tasks are there (the board), how many need the
// operator, and what waits on them for one site. `TaskSourceAdapter` is that
// question list and this file the registry; the actions are the
// `/api/tasks/*` contract (`shared/tasks.ts`). `read` photographs the source
// once per request so a count and a list always come from the same minute.

import type { AssetOperatorPosture } from "../shared/asset-detail";
import {
  BEADS,
  TASK_SOURCE_IDS,
  type TaskSourceId,
  type TaskSourcePayload,
  type TaskSourceStatus,
} from "../shared/task-source";
import { unreadOperatorPosture, type OperatorPosture } from "../shared/wall";
import type { WorkPayload } from "../shared/work";
import { loadLatestBeadsSnapshot, type BeadsSnapshot } from "./beads-snapshot";
import type { WorkspaceStore } from "@noticeos/postgres";
import { buildWorkPayload } from "./work-payload";

/** What a source is read with: the call's store, and the saved settings it
 * counts its projects from. */
export interface TaskSourceContext {
  /** Holds the task snapshots, daily counts and the site list. */
  store: WorkspaceStore;
  /** How many projects the operator saved for each source. Absent where the
   * caller has no settings to hand; a source then counts what its read saw. */
  savedProjects?: Partial<Record<TaskSourceId, number>>;
}

/** One source, read once, with every answer bound to that read. */
export interface TaskSourceReading {
  status: TaskSourceStatus;
  /** List tasks: the Tasks board (`GET /api/work`). */
  board(now: Date): Promise<WorkPayload>;
  /** Counts for Needs you: Home's tile and the Wall's heading. */
  needsYou(): OperatorPosture;
  /** The inbox for one site: its Overview's Needs you. */
  inbox(asset: string): AssetOperatorPosture;
}

export interface TaskSourceAdapter {
  readonly id: TaskSourceId;
  read(context: TaskSourceContext): Promise<TaskSourceReading>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Beads — the task hub
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connected: the runner's newest snapshot read at least one task project. The
 * runner files a snapshot only when the hub answered
 * (scripts/runner/task-snapshot.mjs); with no saved project it files an empty
 * one, which clears the connection.
 */
export function beadsConnected(snapshot: BeadsSnapshot | null): boolean {
  return snapshot !== null && snapshot.projects.length > 0;
}

/** The beads source's row: its saved projects, the last read, and how much of
 * that read failed. */
export function beadsStatus(snapshot: BeadsSnapshot | null, savedProjects?: number): TaskSourceStatus {
  const connected = beadsConnected(snapshot);
  const read = snapshot?.projects ?? [];
  return {
    id: BEADS,
    connected,
    projects: savedProjects ?? read.length,
    readAt: connected ? snapshot!.capturedAt : null,
    failing: read.filter((project) => !project.ok).length,
  };
}

/** Portfolio-wide human intervention from the same photograph that feeds each
 * card's work shape. Partial reads preserve their known lower bound and expose
 * the missing coverage; they never collapse to an exact zero. */
export function beadsNeedsYou(snapshot: BeadsSnapshot | null): OperatorPosture {
  if (!snapshot) {
    return unreadOperatorPosture();
  }

  let waiting = 0;
  let urgent = 0;
  let measuredProjects = 0;
  let urgentMeasuredProjects = 0;
  for (const project of snapshot.projects) {
    if (!project.ok) continue;
    if (project.counts.waiting === null) {
      // One half of the operator read may still have answered. Its bounded
      // rows are a lower bound, never proof this project's inbox was measured.
      waiting += project.waiting.length;
      urgent += project.waiting.filter((item) => item.issueType === "gate" || item.priority <= 1).length;
      continue;
    }
    waiting += project.counts.waiting;
    measuredProjects += 1;
    if (project.waitingUrgent !== null) {
      urgent += project.waitingUrgent;
      urgentMeasuredProjects += 1;
    }
  }

  return {
    waiting,
    urgent,
    measuredProjects,
    urgentMeasuredProjects,
    projectCount: snapshot.projects.length,
    capturedAt: snapshot.capturedAt,
  };
}

/** The asset page's one trustworthy answer to "does this asset need me?".
 *
 * `counts.waiting` alone is not sufficient: the long-running local poller can
 * predate the blocker-aware inbox correction while still writing that field.
 * `waitingUrgent` arrived with the corrected contract, so it is the generation
 * marker. New partial reads omit both exact counts but preserve known rows;
 * legacy exact-count/no-urgency lists still cannot prove actionable items.
 */
export function beadsInbox(snapshot: BeadsSnapshot | null, asset: string): AssetOperatorPosture {
  const project = snapshot?.projects.find((entry) => entry.asset === asset);
  const measured =
    project?.ok === true &&
    project.counts.waiting !== null &&
    project.waitingUrgent !== null;
  return {
    capturedAt: snapshot?.capturedAt ?? null,
    waiting: measured ? project.counts.waiting : null,
    urgent: measured ? project.waitingUrgent : null,
    items: project?.ok === true && (measured || project.counts.waiting === null) ? project.waiting : [],
  };
}

/** A beads reading also carries its snapshot: the hub's own extras (a site's
 * review task, the tasks filed from a finding, each card's open work) are read
 * off the same photograph by the payloads that show them. */
export interface BeadsTaskSourceReading extends TaskSourceReading {
  snapshot: BeadsSnapshot | null;
}

/** The beads read over a snapshot already in hand. */
export function beadsReading(
  store: WorkspaceStore,
  snapshot: BeadsSnapshot | null,
  savedProjects?: number,
): BeadsTaskSourceReading {
  return {
    snapshot,
    status: beadsStatus(snapshot, savedProjects),
    board: (now) => buildWorkPayload(store, { now, snapshot }),
    needsYou: () => beadsNeedsYou(snapshot),
    inbox: (asset) => beadsInbox(snapshot, asset),
  };
}

export const beadsTaskSource = {
  id: BEADS,
  async read({ store, savedProjects }: TaskSourceContext): Promise<BeadsTaskSourceReading> {
    return beadsReading(store, await loadLatestBeadsSnapshot(store), savedProjects?.beads);
  },
} satisfies TaskSourceAdapter;

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

/** Every adapter, in `TASK_SOURCE_IDS` order. */
export const TASK_SOURCE_ADAPTERS: Readonly<Record<TaskSourceId, TaskSourceAdapter>> = {
  beads: beadsTaskSource,
};

/** Read snapshot availability once for the health response. */
export async function readTaskSources(context: TaskSourceContext): Promise<{
  readings: TaskSourceReading[];
  connected: TaskSourceReading | null;
}> {
  const readings = await Promise.all(TASK_SOURCE_IDS.map((id) => TASK_SOURCE_ADAPTERS[id].read(context)));
  return { readings, connected: readings.find((reading) => reading.status.connected) ?? null };
}

/** `GET /api/task-source`: which source every task screen shows, and each
 * source's row on Integrations. */
export async function buildTaskSourcePayload(context: TaskSourceContext): Promise<TaskSourcePayload> {
  const { readings, connected } = await readTaskSources(context);
  return {
    connected: connected?.status.id ?? null,
    sources: readings.map((reading) => reading.status),
  };
}

/** The core board retains its actual latest reading, including failed projects. */
export async function buildTaskBoard(context: TaskSourceContext, now: Date): Promise<WorkPayload> {
  return (await beadsTaskSource.read(context)).board(now);
}
