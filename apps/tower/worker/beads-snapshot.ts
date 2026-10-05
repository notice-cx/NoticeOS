// The one reader of the task-hub photographs (db/migrations/0017_beads_snapshots.sql;
// on Postgres, `noticeos.task_snapshots`, since bead ro-ujb9.76.4.3).
//
// Two surfaces render the task hub — the /work board (a project's whole queue)
// and the asset card's work widget (one asset's counts at a glance) — and
// both answer from the same photograph. This module owns the query and the
// parse so they cannot drift into two different opinions about which row is
// "latest" or what an unreadable payload means.
//
// ONLY the newest row is read, and only the newest row is whole: an older one
// keeps just the lists the Wall's feed replays (`supersededPayload`,
// workers/ingest/src/beads-snapshots.ts). Both surfaces are "what is happening
// now": showing an older snapshot when the newest one is stale would hide
// exactly the failure the age badges exist to reveal.

import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import type { HandoffBead } from "../shared/asset-detail";
import type { PanelReview } from "../shared/wall";
import { PRIORITY_BANDS, type WorkCounts, type WorkEpic, type WorkItem } from "../shared/work";

type SnapshotRow = {
  captured_at: string;
  payload: string;
};

/** The review obligation as the HUB knows it — everything in `PanelReview`
 * except `panel`.
 *
 * The hub has no opinion about what the operator bought: `bd` holds a bead, not
 * `config/serp-panel.json`. So the noun flag is attached one layer up, by the
 * payload builders that already carry the config (`cardPanelReviewsOf`), and
 * this reader stays a pure parse of what the poller photographed (bead
 * `ro-z0g`). */
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
  recentlyClosed: WorkItem[];
  deferred: WorkItem[];
  waiting: WorkItem[];
  /** All human gates plus P0/P1 ready-human rows over the untruncated inbox.
   * null when the poller generation did not send it. */
  waitingUrgent: number | null;
  /** The asset's serp-panel review bead (bead `ro-9hx` writes it).
   *
   * THREE-VALUED, and the two absences are different measurements: `undefined`
   * = this poller did not look (a snapshot written before the field existed, or
   * a repo `bd` could not answer for), `null` = it looked and this asset has
   * no review bead at all. The asset card collapses both to "render
   * nothing", because its answer to them is genuinely identical — but the
   * collapse happens at the payload boundary, not here, so the distinction
   * survives for any reader that ever needs it. */
  panelReview: SnapshotPanelReview | null | undefined;
  /** The beads filed from this asset's Tower handoffs (bead `ro-248`).
   *
   * TWO-VALUED and the same distinction one shape up: `undefined` = this poller
   * never asked the register (an older snapshot, or a repo `bd` could not open),
   * `[]` = it asked and nobody has filed anything for this asset. Only the
   * second licenses a finding card to present itself as untouched work. */
  handoffs: HandoffBead[] | undefined;
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

function readItem(value: unknown): WorkItem | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;
  const createdAt = nullableText(value.createdAt);
  return {
    ...(createdAt ? { createdAt } : {}),
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

/** Epic grouping, all-or-nothing per row: a half-readable epic would render a
 * card whose progress and shape disagree with the rows under it. */
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

/** An optional count: null when the poller did not measure it.
 *
 * Every OTHER count defaults to 0, which is safe because they have been in the
 * payload since the table existed — a missing one means an unreadable row, and
 * the surrounding degradation already covers that. `highPriority` arrived later
 * (2026-08-01), so its absence is an ordinary fact about an older writer rather
 * than damage, and it has to survive as one all the way to the chip. */
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
 * The asset's panel-review bead (bead `ro-rkp`).
 *
 * An explicit JSON `null` is the ONE value that means "measured, and this
 * asset has no review bead". Everything else that is not a readable review —
 * the key absent, a non-object, a record naming no bead — means this poller did
 * not tell us, and travels as `undefined`. The card renders both as nothing,
 * but they are different facts and only one of them was observed.
 *
 * TWO fields are load-bearing and the rest are not. Without `beadId` there is
 * nothing to send the operator to, and without a `status` in the pinned
 * vocabulary (`bd`'s in_progress/blocked/deferred all collapse to "open"
 * upstream) there is no state to derive. The dates ride through as whatever
 * arrived: `panelReviewState` already treats an unreadable one as the quiet
 * state, which is a better answer than dropping an obligation the hub really is
 * holding because a poller one generation behind spelled a timestamp
 * differently.
 *
 * The key is absent on every snapshot written before 2026-08-02, and stays
 * absent until the operator restarts `os:up` — the poller is a static node
 * process, unlike the hot-reloaded Worker. That is an ordinary fact about an
 * older writer, degraded to absence, never to an error.
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
 * One handoff bead, or null when this entry cannot be joined to anything.
 *
 * FOUR fields are load-bearing and none of them have a sane default. Without
 * `key` there is no finding to attach to; without `kind` the key could match a
 * query and a finding that merely share a string; without `beadId` there is
 * nothing to send the operator to; and a status outside the pinned pair is a
 * state this surface has no rendering for. `closedAt` rides through as whatever
 * arrived — the marker degrades to "closed, undated", which is still true.
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
 * The asset's handoff beads, or `undefined` when the row does not carry the
 * field at all (every snapshot written before 2026-08-03, and every one written
 * after until the operator restarts `os:up` — the poller is a static node
 * process, unlike the hot-reloaded Worker).
 *
 * Unreadable ENTRIES are dropped one at a time rather than costing the whole
 * list, which is the opposite of the all-or-nothing rule the epics and the
 * priority bands follow — deliberately. Those two render a shape, and a partial
 * shape is a confident lie about the whole queue. This renders one marker per
 * finding, so a garbled entry costs exactly the finding it belonged to; failing
 * the array instead would silently un-file every OTHER finding on the page.
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

/**
 * One stored project entry.
 *
 * The ingest route validated this JSON on the way in, so re-reading it
 * defensively is belt-and-braces — but the row outlives the code that wrote it,
 * and a surface that throws on a payload written by an older poller is a
 * surface that goes dark exactly when someone changed something. Anything
 * unreadable degrades to a named project with no work rather than to an
 * exception.
 */
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
    recentlyClosed: ok ? readItems(value.recentlyClosed) : [],
    deferred: ok ? readItems(value.deferred) : [],
    waiting: ok ? readItems(value.waiting) : [],
    waitingUrgent: ok ? optionalCount(value.waitingUrgent) : null,
    // Same `bd` read as the counts, so the same failure: a repo the poller
    // could not open told it nothing about a review bead either — which is
    // "did not look", not "looked and found none".
    panelReview: ok ? readPanelReview(value.panelReview) : undefined,
    // Same `bd`, same failure: a repo the poller could not open told it nothing
    // about filed work either, which is "did not ask" and never "none filed".
    handoffs: ok ? readHandoffs(value.handoffs) : undefined,
  };
}

/**
 * The newest snapshot, or null when none has ever been filed.
 *
 * Project order is the snapshot's own, which is `config/beads.json`'s order —
 * the file the operator edits is the file that decides what comes first, and
 * re-sorting here (by count, by name) would put a project's position at the
 * mercy of how busy it happened to be this minute.
 */
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
