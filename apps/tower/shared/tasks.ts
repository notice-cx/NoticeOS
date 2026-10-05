// Shared TASKS contract: what the LIVE lane returns, as against the snapshot
// board's `shared/work.ts`.
//
// TWO READS OF THE SAME HUB, and the difference is the whole point.
// `shared/work.ts` describes a photograph: `scripts/os-up.mjs` shells `bd` once
// a minute, POSTs a bounded summary to the store, and the Worker serves it in
// every deployment. That payload is truncated by construction (heads of lists,
// counts over everything) because it has to survive a database column and a
// Worker with no `bd`.
//
// This file describes the LIVE read (D19, epic `ro-l1ed`): the local lane runs
// `bd` in the spoke and hands back the rows unbounded, with the fields a task
// PAGE needs and a board row does not — description, acceptance criteria,
// labels, dependencies, the comment count, the handoff metadata. It exists only
// where the lane does; a deployed build has `live: false` and keeps the
// snapshot board.
//
// `LiveTask` EXTENDS `WorkItem` rather than restating it. A bead is one thing,
// and the two reads must never disagree about what its id, status or priority
// mean — the live payload only knows MORE about the same row.
//
// Still true, and unchanged by the lane: tasks are coordination state, not
// signals (docs/01, docs/06). Nothing here is evidence about an asset.

import type { WorkItem } from "./work";

/** Closed history is bounded in time, never sampled by row count. */
export const TASKS_CLOSED_WINDOW_DAYS = 7;

/** Task ids share the lane's prefix/hash grammar, including gate and child ids. */
export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+-{1,2}[a-z0-9]+(\.[0-9]+)*$/i.test(value);
}

/** One dependency edge, flattened. `bd` reports these two ways — a plain edge
 * on `bd list`, a whole embedded issue on `bd show` — and the lane normalizes
 * both to this, so a caller never has to know which read it came from. */
export interface TaskDependency {
  /** The bead on the other end. */
  id: string;
  /** `blocks`, `parent-child`, `discovered-from`, … — `bd`'s own vocabulary,
   * not an enum: it accepts types this build has never heard of. */
  type: string;
  /** Present only when the read carried it (`bd show`); null on a list row. */
  title: string | null;
  /** The other bead's own status, when the read embedded the whole issue
   * (`bd show`); null on a plain edge. A task page draws a status glyph beside
   * each blocker, and a CLOSED blocker is the one that matters most: it is no
   * longer in the way, and a list that could not say so would read as five
   * things blocking work that only two of them still block. */
  status: string | null;
}

/**
 * One bead as the lane reads it live. Everything `WorkItem` has, plus what a
 * task page and a filterable index need.
 */
export interface LiveTask extends WorkItem {
  /** Empty string when the bead carries none — the board renders the absence,
   * and `null` here would only add a second way to say "nothing". */
  description: string;
  acceptance: string;
  labels: string[];
  /** Claimable NOW: this id appeared in the same poll's `bd ready`, which is
   * blocker-aware in a way the stored `status` is not. Deriving it here from
   * dependency ids would be a second implementation of `bd`'s own semantics. */
  ready: boolean;
  dependencies: TaskDependency[];
  /** How many comments the bead carries. The bodies come from the detail read
   * only — a list of 300 beads must not drag every conversation with it. */
  comments: number;
  /** `noticeos_*` handoff metadata when the bead was filed from a Tower finding
   * (config/beads.README.md §Handoff metadata), null otherwise. */
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
  /** When somebody claimed it (`bd`'s `started_at`), null while nobody has.
   * Distinct from `updatedAt`, which any later edit moves: a task page's
   * activity timeline has to date the CLAIM, and dating it by the last edit
   * would quietly redate history every time a label changed. */
  startedAt: string | null;
  /** Why it was closed — the completion evidence, which is the one thing a
   * closed row is for. */
  closeReason: string | null;
  /** `human`, `timer`, `gh:run`, … on a gate bead; null on everything else. A
   * human gate is the sharpest form of waiting on the operator. */
  awaitType: string | null;
}

/** One epic container with its ALL-TIME child progress (`bd epic status`) —
 * the only honest denominator, since a list read is a window. */
export interface LiveEpic {
  id: string;
  title: string;
  status: string;
  priority: number;
  total: number;
  closed: number;
  /** `bd`'s own judgment that every child is done and the container could be
   * closed. Surfaced rather than re-derived. */
  eligibleForClose: boolean;
}

/** One project's live board. */
export interface LiveTasksPayload {
  /** Current selected-workspace presentation facts. Absent on standalone;
   * IDs in task rows remain the immutable source of attribution. */
  actors?: readonly TaskActor[];
  /** The asset id — the `config/beads.json` spoke this was read from. */
  project: string;
  prefix: string;
  /** The spoke's repo path as configured (relative to the repo root), so the
   * page can say WHERE it looked. */
  repo: string;
  /** When the lane ran `bd`. Not a snapshot age: this read is live, and the
   * stamp is here so a stale tab can tell. */
  readAt: string;
  /** UTC lower boundary used by the complete closed-task query. Older cached
   * clients may omit it; current lane replies always include it. */
  closedSince?: string;
  tasks: LiveTask[];
  /** null when this spoke's `bd` could not answer `epic status` — the board
   * falls back to flat lists rather than inventing groups. */
  epics: LiveEpic[] | null;
}

export interface TaskComment {
  id: string;
  author: string;
  text: string;
  createdAt: string | null;
}

export interface TaskActor {
  readonly principalId: string;
  readonly displayName: string;
}
/** A name never changes authority. Unavailable hosted UUIDs have no guessed
 * person/service identity; standalone and explicit agent strings stay intact. */
export function taskActorLabel(actor: string, actors?: readonly TaskActor[]): string {
  if (actors === undefined) return actor;
  const found = actors.find(person => person.principalId === actor);
  if (found?.displayName.trim()) return found.displayName;
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(actor) ? 'Unknown actor' : actor;
}

/** One bead and its conversation — the task page's read. */
export interface LiveTaskDetail {
  actors?: readonly TaskActor[];
  project: string;
  prefix: string;
  repo: string;
  readAt: string;
  task: LiveTask;
  comments: TaskComment[];
}

/** What `POST /api/tasks` answers with: the id the hub minted. */
export interface TaskCreated {
  id: string;
  project: string;
}

/**
 * WHY a deployment cannot write tasks, as a STATE CODE rather than a sentence
 * (bead `ro-ujb9.96.6.11`). A deployed Worker has no `bd` and no route to the
 * Dolt server on the operator's Mac; the Tower renders the code as one
 * Read-only chip and `READ_ONLY_TASKS_HINT`, never as a paragraph the server
 * wrote. One code today — the union is where a second one would go.
 */
export type TasksReadOnlyReason = "read_only_deployment";
export const READ_ONLY_DEPLOYMENT: TasksReadOnlyReason = "read_only_deployment";

/**
 * Can this deployment reach the task hub?
 *
 * `true` only where the local lane is serving (`apply: "serve"`, the `os:up`
 * dev server). A deployed Worker answers `false` with `reason:
 * "read_only_deployment"`; `null` with `live: false` means the question itself
 * went unanswered, which the board treats the same way.
 */
export interface TasksCapabilities {
  live: boolean;
  /** Older servers omit this; their existing live lane remains writable. */
  writable?: boolean;
  /** Hosted commands select an owned logical project explicitly. */
  projectSelection?: boolean;
  /** Omitted by older standalone servers, whose full lane is unchanged. */
  operations?: readonly string[];
  editableFields?: readonly string[];
  reason: TasksReadOnlyReason | null;
}

export interface TaskProject {
  projectId: string;
  logicalKey: string;
  displayName: string;
  prefix: string;
}

export function taskOperationAvailable(capabilities: TasksCapabilities, operation: string): boolean {
  return taskWritesAvailable(capabilities) && (capabilities.operations === undefined || capabilities.operations.includes(operation));
}
export function taskFieldAvailable(capabilities: TasksCapabilities, field: string): boolean {
  return taskOperationAvailable(capabilities, 'update') && (capabilities.editableFields === undefined || capabilities.editableFields.includes(field));
}

/** Live detail reads remain available when the runtime limits task writes. */
export function taskWritesAvailable(capabilities: TasksCapabilities): boolean {
  return capabilities.live && capabilities.writable !== false;
}

/** Where task projects are added and repaired — the Settings section id, so a
 * surface with no task project links to the fix rather than describing it. */
export const TASK_PROJECTS_PATH = `/settings#${"task-hub"}`;

/** The one line a read-only task surface shows beside its Read-only chip —
 * what to do, since the chip already says what happened. */
export const READ_ONLY_TASKS_HINT = "Make changes from the local NoticeOS.";

/** The verbs the lane will run, as the operator's own words — what a refusal
 * names, and what the docs promise. Kept beside the types because the client
 * renders it and the lane enforces it, and one list has to serve both. */
export const TASK_ACTIONS = ["close", "comments", "respond", "dismiss"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];
