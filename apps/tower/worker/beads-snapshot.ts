// The one reader of the task-hub snapshots (`noticeos.task_snapshots`). The
// /work board and the asset card's work widget both answer from the same
// snapshot; this module owns the query and the parse. Only the newest row is
// read, and only the newest row is whole: an older one keeps just the lists
// the Wall's feed replays (`supersededPayload`,
// workers/ingest/src/beads-snapshots.ts).

import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { TASK_CHOICE_KEYS, taskChoiceOf, taskChoicesOf, type TaskChoiceKey } from "@noticeos/contract/task-choices";
import { isTaskResolution, type TaskResolution } from "@noticeos/contract/task-resolution";
import { taskCardOf } from "@noticeos/contract/task-card";
import { isTaskChangeClass } from "@noticeos/contract/task-change-class";
import type { HandoffBead } from "../shared/asset-detail";
import type { PanelReview } from "../shared/wall";
import { PRIORITY_BANDS, type WorkCloses, type WorkCounts, type WorkDependency, type WorkEpic, type WorkEvent, type WorkItem, type WorkWorker } from "../shared/work";

type SnapshotRow = {
  captured_at: string;
  payload: string;
};

/** The review obligation as the hub knows it — everything in `PanelReview`
 * except `panel`, which the payload builders attach from config
 * (`cardPanelReviewsOf`). */
export type SnapshotPanelReview = Omit<PanelReview, "panel">;

const EMPTY_COUNTS: WorkCounts = {
  open: 0,
  highPriority: null,
  ready: 0,
  inProgress: 0,
  blocked: 0,
  closedRecent: 0,
  deferred: null,
  waiting: null,
};

/** One stored project entry. Identical to `WorkProject` except that it carries
 * no display name — the name is a join against `assets` that only the board
 * needs. */
export interface SnapshotProject {
  asset: string;
  prefix: string;
  ok: boolean;
  error: string | null;
  counts: WorkCounts;
  priorities: number[] | null;
  epics: WorkEpic[] | null;
  ready: WorkItem[];
  inProgress: WorkItem[];
  /** Open work waiting on another task; absent from an older snapshot. */
  blocked?: WorkItem[];
  recentlyClosed: WorkItem[];
  deferred: WorkItem[];
  waiting: WorkItem[];
  /** All human gates plus P0/P1 ready-human rows over the untruncated inbox.
   * null when the poller generation did not send it. */
  waitingUrgent: number | null;
  /** The asset's serp-panel review task. Three-valued: `undefined` = this
   * poller did not look (an older snapshot, or a repo `bd` could not answer
   * for), `null` = it looked and this asset has no review task. The payload
   * boundary collapses both; the distinction survives here. */
  panelReview: SnapshotPanelReview | null | undefined;
  /** The tasks filed from this asset's Tower handoffs. `undefined` = this
   * poller never asked the register; `[]` = it asked and nobody has filed
   * anything. Only the second licenses a finding card to present itself as
   * untouched work. */
  handoffs: HandoffBead[] | undefined;
  /** Who did the work; absent when the snapshot carries none. */
  workers?: WorkWorker[];
  recentWork?: WorkEvent[];
  /** Every close the closed read returned, behind Done this week and last
   * week; absent from an older poller. */
  closes?: WorkCloses;
}

export interface BeadsSnapshot {
  /** When the poller looked, NOT when the Tower rendered. */
  capturedAt: string;
  projects: SnapshotProject[];
}

/** A condition can include several firings; work filed from any of them still belongs to it. */
export function alertHandoffsOf(snapshot: BeadsSnapshot | null, asset: string, flagIds: readonly number[]): HandoffBead[] | undefined {
  const project = snapshot?.projects.find((entry) => entry.asset === asset);
  if (!project?.ok || project.handoffs === undefined) return undefined;
  const keys = new Set(flagIds.map(String));
  return project.handoffs.filter((bead) => bead.kind === 'alert' && keys.has(bead.key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A close's resolution as a snapshot stores it: absent, or unreadable, is done. */
function notDone(value: unknown): Exclude<TaskResolution, "done"> | null {
  return isTaskResolution(value) && value !== "done" ? value : null;
}

function readItem(value: unknown): WorkItem | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  const createdAt = nullableText(value.createdAt);
  // Read through the contract's own rules: an unreadable set or pick is left out.
  const choices = taskChoicesOf(value.choices), choice = taskChoiceOf(value.choice);
  const card = taskCardOf(value.card), changeClass = isTaskChangeClass(value.changeClass) ? value.changeClass : null;
  const ended = notDone(value.resolution);
  const duplicateOf = ended === "duplicate" ? nullableText(value.duplicateOf) : null;
  return {
    ...readDependencies(value.dependencies),
    ...(createdAt ? { createdAt } : {}),
    ...(choices ? { choices } : {}),
    ...(choice ? { choice } : {}),
    ...(card ? { card } : {}),
    ...(changeClass ? { changeClass } : {}),
    ...(ended ? { resolution: ended } : {}),
    ...(duplicateOf ? { duplicateOf } : {}),
    id,
    title: text(value.title, id),
    status: text(value.status, "open"),
    priority:
      typeof value.priority === "number" && Number.isInteger(value.priority) ? value.priority : 2,
    issueType: text(value.issueType, "task"),
    assignee: nullableText(value.assignee),
    updatedAt: nullableText(value.updatedAt),
    closedAt: nullableText(value.closedAt),
    parent: nullableText(value.parent),
    deferUntil: nullableText(value.deferUntil),
  };
}

/** A task's links, all or none: a list missing one would let a held task read
 * as free. No key when the row carries none, which an older poller wrote. */
function readDependencies(value: unknown): Pick<WorkItem, "dependencies"> {
  if (!Array.isArray(value)) return {};
  const dependencies: WorkDependency[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !text(entry.id) || !text(entry.type)) return {};
    const status = nullableText(entry.status);
    dependencies.push({ id: text(entry.id), type: text(entry.type), ...(status ? { status } : {}) });
  }
  return { dependencies };
}

/** Container grouping, all-or-nothing per row: a half-readable container
 * would render a card whose progress disagrees with the rows under it. */
function readEpic(value: unknown): WorkEpic | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const priorities = readPriorities(value.priorities);
  if (!id || priorities === null) return null;
  const counts = isRecord(value.counts) ? value.counts : {};
  return {
    id,
    title: text(value.title, id),
    status: text(value.status, "open"),
    priority:
      typeof value.priority === "number" && Number.isInteger(value.priority) ? value.priority : 2,
    total: count(value.total),
    closed: count(value.closed),
    counts: {
      open: count(counts.open),
      inProgress: count(counts.inProgress),
      blocked: count(counts.blocked),
      deferred: count(counts.deferred),
    },
    priorities,
  };
}

/** null when the row carries no usable structure at all — the board then falls
 * back to flat lists instead of a partial hierarchy that hides work. */
function readEpics(value: unknown): WorkEpic[] | null {
  if (!Array.isArray(value)) return null;
  const out: WorkEpic[] = [];
  for (const entry of value) {
    const epic = readEpic(entry);
    if (epic) out.push(epic);
  }
  return out;
}

function readItems(value: unknown): WorkItem[] {
  if (!Array.isArray(value)) return [];
  const out: WorkItem[] = [];
  for (const entry of value) {
    const item = readItem(entry);
    if (item) out.push(item);
  }
  return out;
}

/** An optional count: null when the poller did not measure it. Every other
 * count defaults to 0 because it has been in the payload since the table
 * existed; this one's absence is an ordinary fact about an older writer. */
function optionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The queue-shape array, or null when this row does not carry a usable one.
 * All-or-nothing on purpose: a partly-readable distribution would render as a
 * bar with the wrong mass, which is worse than no bar at all. */
function readPriorities(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length !== PRIORITY_BANDS.length) return null;
  const out: number[] = [];
  for (const band of value) {
    if (typeof band !== "number" || !Number.isInteger(band) || band < 0) return null;
    out.push(band);
  }
  return out;
}

/**
 * The asset's panel-review task. An explicit JSON `null` is the one value
 * that means "measured, and this asset has no review task"; anything else
 * that is not a readable review travels as `undefined`. Two fields are
 * load-bearing: `beadId` and a `status` in the pinned vocabulary. The dates
 * ride through as whatever arrived; `panelReviewState` treats an unreadable
 * one as the quiet state.
 */
function readPanelReview(value: unknown): SnapshotPanelReview | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const beadId = text(value.beadId);
  const status = text(value.status);
  if (!beadId || (status !== "open" && status !== "closed")) return undefined;
  return {
    beadId,
    panelDate: nullableText(value.panelDate),
    dueAt: nullableText(value.dueAt),
    status,
    closedAt: nullableText(value.closedAt),
  };
}

/**
 * One handoff task, or null when this entry cannot be joined to anything.
 * Four fields are load-bearing: `key`, `kind`, `beadId` and a status in the
 * pinned pair. `closedAt` rides through as whatever arrived.
 */
function readHandoff(value: unknown): HandoffBead | null {
  if (!isRecord(value)) return null;
  const kind = text(value.kind);
  const key = text(value.key);
  const beadId = text(value.beadId);
  const status = text(value.status);
  if (kind !== "query" && kind !== "finding" && kind !== "page" && kind !== "alert") return null;
  if (!key || !beadId) return null;
  if (status !== "open" && status !== "closed") return null;
  return { kind, key, beadId, status, closedAt: nullableText(value.closedAt) };
}

/**
 * The asset's handoff tasks, or `undefined` when the row does not carry the
 * field at all. Unreadable entries are dropped one at a time rather than
 * costing the whole list — the opposite of the all-or-nothing rule the
 * containers and priority bands follow, because this renders one marker per
 * finding and a garbled entry costs exactly the finding it belonged to.
 */
function readHandoffs(value: unknown): HandoffBead[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: HandoffBead[] = [];
  for (const entry of value) {
    const handoff = readHandoff(entry);
    if (handoff) out.push(handoff);
  }
  return out;
}

function readCounts(value: unknown): WorkCounts {
  if (!isRecord(value)) return { ...EMPTY_COUNTS };
  return {
    open: count(value.open),
    highPriority: optionalCount(value.highPriority),
    ready: count(value.ready),
    inProgress: count(value.inProgress),
    blocked: count(value.blocked),
    closedRecent: count(value.closedRecent),
    deferred: optionalCount(value.deferred),
    waiting: optionalCount(value.waiting),
  };
}

/** One stored project entry, read defensively because the row outlives the
 * code that wrote it: anything unreadable degrades to a named project with no
 * work rather than to an exception. */
function readProject(value: unknown): SnapshotProject | null {
  if (!isRecord(value)) return null;
  const asset = text(value.asset);
  if (!asset) return null;
  const ok = value.ok !== false;
  return {
    asset,
    prefix: text(value.prefix, "?"),
    ok,
    error: nullableText(value.error),
    counts: readCounts(value.counts),
    priorities: readPriorities(value.priorities),
    epics: ok ? readEpics(value.epics) : null,
    ready: ok ? readItems(value.ready) : [],
    inProgress: ok ? readItems(value.inProgress) : [],
    ...(ok && Array.isArray(value.blocked) ? { blocked: readItems(value.blocked) } : {}),
    recentlyClosed: ok ? readItems(value.recentlyClosed) : [],
    deferred: ok ? readItems(value.deferred) : [],
    waiting: ok ? readItems(value.waiting) : [],
    waitingUrgent: ok ? optionalCount(value.waitingUrgent) : null,
    // A repo the poller could not open told it nothing: "did not look".
    panelReview: ok ? readPanelReview(value.panelReview) : undefined,
    handoffs: ok ? readHandoffs(value.handoffs) : undefined,
    ...(ok ? readWork(value) : {}),
    ...(ok ? readCloses(value.closes) : {}),
  };
}

/** The closes, all or none: a list missing one would count a week short. */
function readCloses(value: unknown): Pick<SnapshotProject, "closes"> {
  if (!isRecord(value) || typeof value.since !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.since) || !Array.isArray(value.items)) return {};
  const items: WorkCloses["items"] = [];
  for (const entry of value.items) {
    if (!isRecord(entry)) return {};
    const at = nullableText(entry.at);
    if (at === null || !Number.isFinite(Date.parse(at))) return {};
    const ended = notDone(entry.resolution);
    items.push({ at, ...(ended ? { resolution: ended } : {}) });
  }
  return { closes: { since: value.since, items } };
}

/** Who did the work, each row read alone so one unreadable row costs only itself. */
function readWork(value: Record<string, unknown>): Pick<SnapshotProject, "workers" | "recentWork"> {
  const workers = (Array.isArray(value.workers) ? value.workers : []).flatMap((entry): WorkWorker[] => {
    if (!isRecord(entry) || !text(entry.id)) return [];
    return [{ id: text(entry.id), model: nullableText(entry.model), closedRecent: count(entry.closedRecent), inProgress: count(entry.inProgress) }];
  });
  const recentWork = (Array.isArray(value.recentWork) ? value.recentWork : []).flatMap((entry): WorkEvent[] => {
    if (!isRecord(entry) || (entry.kind !== "claimed" && entry.kind !== "closed" && entry.kind !== "chosen")
      || !text(entry.taskId) || !text(entry.by) || !nullableText(entry.at)) return [];
    // A pick without its option and label tells nothing; it is left out.
    const option = (TASK_CHOICE_KEYS as readonly unknown[]).includes(entry.option) ? entry.option as TaskChoiceKey : null;
    if (entry.kind === "chosen" && (option === null || !text(entry.label))) return [];
    const ended = entry.kind === "closed" ? notDone(entry.resolution) : null;
    return [{ kind: entry.kind, taskId: text(entry.taskId), title: text(entry.title, text(entry.taskId)), by: text(entry.by),
      model: nullableText(entry.model), at: text(entry.at), evidence: nullableText(entry.evidence),
      ...(entry.kind === "chosen" ? { option: option!, label: text(entry.label) } : {}),
      ...(ended ? { resolution: ended } : {}) }];
  });
  return { ...(workers.length ? { workers } : {}), ...(recentWork.length ? { recentWork } : {}) };
}

/** The newest snapshot, or null when none has ever been filed. Project order
 * is the snapshot's own, which is `config/beads.json`'s order. */
export async function loadLatestBeadsSnapshot(store: WorkspaceStore): Promise<BeadsSnapshot | null> {
  const [row] = await store.read((tx) =>
    tx.query<SnapshotRow>(
      `SELECT captured_at, payload::text AS payload
         FROM noticeos.task_snapshots
        ORDER BY captured_at DESC, snapshot_id DESC
        LIMIT 1`,
    ),
  );

  if (!row) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    parsed = null;
  }
  const rawProjects = isRecord(parsed) && Array.isArray(parsed.projects) ? parsed.projects : [];

  const projects: SnapshotProject[] = [];
  for (const entry of rawProjects) {
    const project = readProject(entry);
    if (project) projects.push(project);
  }

  return { capturedAt: javascriptInstant(row.captured_at), projects };
}
