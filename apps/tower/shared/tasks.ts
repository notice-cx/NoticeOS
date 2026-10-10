// The tasks contract: what the live lane returns, as against the snapshot
// board's `shared/work.ts`. The snapshot is a bounded summary the poller
// POSTs to the store; the live read runs `bd` in the project and hands back
// the rows unbounded, with the fields a task page needs. It exists only where
// the lane does; a deployed build has `live: false` and keeps the snapshot
// board. `LiveTask` extends `WorkItem` rather than restating it. Tasks are
// coordination state, not signals.

import type { WorkItem } from "./work";

/** Closed history is bounded in time, never sampled by row count. */
export const TASKS_CLOSED_WINDOW_DAYS = 7;

/** Task ids share the lane's prefix/hash grammar, including gate and child ids. */
export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+-{1,2}[a-z0-9]+(\.[0-9]+)*$/i.test(value);
}

/** One dependency edge, flattened. `bd` reports these two ways — a plain
 * edge on `bd list`, a whole embedded issue on `bd show` — and the lane
 * normalizes both to this. */
export interface TaskDependency {
  /** The task on the other end. */
  id: string;
  /** `blocks`, `parent-child`, `discovered-from`, … — `bd`'s own vocabulary,
   * not an enum: it accepts types this build has never heard of. */
  type: string;
  /** Present only when the read carried it (`bd show`); null on a list row. */
  title: string | null;
  /** The other task's own status, when the read embedded the whole issue
   * (`bd show`); null on a plain edge. A closed blocker is no longer in the
   * way, and the task page has to be able to say so. */
  status: string | null;
}

/** One task as the lane reads it live: everything `WorkItem` has, plus what
 * a task page and a filterable index need. */
export interface LiveTask extends WorkItem {
  /** Empty string when the task carries none. */
  description: string;
  acceptance: string;
  labels: string[];
  /** Claimable now: this id appeared in the same poll's `bd ready`, which is
   * blocker-aware in a way the stored `status` is not. */
  ready: boolean;
  dependencies: TaskDependency[];
  /** How many comments the task carries. The bodies come from the detail
   * read only. */
  comments: number;
  /** `noticeos_*` handoff metadata when the task was filed from a Tower
   * finding (config/beads.README.md §Handoff metadata), null otherwise. */
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
  /** When somebody claimed it (`bd`'s `started_at`), null while nobody has.
   * Distinct from `updatedAt`, which any later edit moves. */
  startedAt: string | null;
  /** Why it was closed — the completion evidence, which is the one thing a
   * closed row is for. */
  closeReason: string | null;
  /** `human`, `timer`, `gh:run`, … on an approval task; null on everything
   * else. */
  awaitType: string | null;
}

/** One container task with its all-time child progress (`bd epic status`) —
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
  /** The asset id — the `config/beads.json` project this was read from. */
  project: string;
  prefix: string;
  /** The project's repo path as configured (relative to the repo root). */
  repo: string;
  /** When the lane ran `bd`. Not a snapshot age: this read is live, and the
   * stamp is here so a stale tab can tell. */
  readAt: string;
  /** UTC lower boundary used by the complete closed-task query. Older cached
   * clients may omit it; current lane replies always include it. */
  closedSince?: string;
  tasks: LiveTask[];
  /** null when this project's `bd` could not answer `epic status` — the board
   * falls back to flat lists. */
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

/** One task and its conversation — the task page's read. */
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

/** Why a deployment cannot write tasks, as a state code rather than a
 * sentence; the Tower renders it as one Read-only chip and
 * `READ_ONLY_TASKS_HINT`. */
export type TasksReadOnlyReason = "read_only_deployment";
export const READ_ONLY_DEPLOYMENT: TasksReadOnlyReason = "read_only_deployment";

/** Can this deployment reach the task hub? `true` only where the local lane
 * is serving. A deployed Worker answers `false` with `reason:
 * "read_only_deployment"`; `null` with `live: false` means the question went
 * unanswered, which the board treats the same way. */
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

/** The verbs the lane will run, as the operator's own words. The client
 * renders it and the lane enforces it. */
export const TASK_ACTIONS = ["close", "comments", "respond", "dismiss"] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];
