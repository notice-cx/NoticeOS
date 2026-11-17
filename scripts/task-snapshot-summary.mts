// Pure task snapshot derivation from the Ntasks rows the runner reads.
import { gateReason, gateTitle, TASK_BLOCKING_DEPENDENCIES } from '../packages/contract/src/task-gate.mjs';
import { recordsClose, TASK_METADATA, taskMetadataValue } from '../packages/contract/src/task-metadata.mjs';
import { BEADS_ATTENTION_TASKS_MAX, BEADS_CLOSES_MAX, BEADS_DEPENDENCIES_MAX, BEADS_HANDOFF_KINDS } from '../packages/contract/src/task-snapshot.mjs';
import type { BeadsEpicInput, BeadsHandoffInput, BeadsIssueInput, BeadsProjectInput, BeadsWorkerInput, BeadsWorkEventInput } from '../packages/contract/src/task-snapshot.mjs';
import { readTaskChoice, readTaskChoices } from '../packages/contract/src/task-choices.mjs';
import { readTaskCard } from '../packages/contract/src/task-card.mjs';
import { readTaskChangeClass } from '../packages/contract/src/task-change-class.mjs';
import { readTaskResolution } from '../packages/contract/src/task-resolution.mjs';
import { panelReviewEntry } from "./panel-review-summary.mjs";
import { taskRowDependencies } from './task-row.mjs';
import { TASK_SNAPSHOT_ERROR_MAX, taskInstant, taskRecord, taskText } from "./task-snapshot-values.mjs";

type TaskRow = Record<string, unknown>;
type Project = Pick<BeadsProjectInput, 'asset' | 'prefix'>;
type TaskIssue = ReturnType<typeof taskIssue>;
type Links = (row: TaskRow | null) => Pick<BeadsIssueInput, 'dependencies'>;

// The Tower handoff join: one key carried from the finding to the task filed
// for it, so the finding can show its task. A handoff (apps/tower/src/lib/
// task-handoff.ts) carries `noticeos_*` metadata (`reindex_*` on older
// tasks, read the same way) naming the finding it came from. The label and
// the three metadata keys below are a contract with that emitter: renaming
// either side silently empties the marker on every finding card. It is a
// filtered query per spoke, not a slice of the capped lists this poller
// captures, because a task filed a month ago falls outside all of them.

/** The label every Tower handoff task carries; the handoff read also takes in
 * the older `reindex-handoff` label. */
export { HANDOFF_LABEL } from '../packages/contract/src/task-metadata.mjs';
/** The finding/query identity, byte-exact. Read from metadata and never from
 * the `key:` label: label lists split on commas, and the label carries a
 * lossy slug. */
export const HANDOFF_KEY_FIELD = TASK_METADATA.key.name;
/** Which Tower surface raised it. This is wider than `decisions.kind`: page
 * rows file work but carry no mark/dismiss display state. */
export const HANDOFF_KIND_FIELD = TASK_METADATA.kind.name;
/** Which property it was raised for. */
export const HANDOFF_ASSET_FIELD = TASK_METADATA.asset.name;
/** The surfaces that emit a handoff: the contract's list, which the ingest
 * validator reads too. */
export const HANDOFF_KINDS = BEADS_HANDOFF_KINDS;
/**
 * How many filed tasks one spoke may report — a rendering bound, not a truth
 * bound (the ingest route's own ceiling is 50 items). The read is unlimited so
 * the dedupe sees every attempt; truncation happens after ranking, so a
 * saturated property loses its oldest shipped work first.
 */
export const HANDOFF_LIMIT = 50;

/** One task's handoff metadata, or null when it carries none. */
/**
 * The spoke's handoff tasks, one per rendered query, finding, page or alert
 * row. A task naming a different asset than the spoke's is dropped: finding
 * keys are rule ids every property's analyzer emits, so a task filed in the
 * wrong repo would attach to an unrelated property's finding. A task carrying
 * no handoff asset is kept. One task per (kind, key): an open task always
 * wins, then the most recently closed.
 */
export function handoffEntries(rows: unknown, asset: string): BeadsHandoffInput[] {
  if (!Array.isArray(rows)) return [];
  const byKey = new Map<string, BeadsHandoffInput>();
  for (const input of rows) {
    const row = taskRecord(input);
    const beadId = taskText(row?.id);
    const metadata = taskRecord(row?.metadata);
    if (beadId === '' || metadata === null) continue;
    const key = taskText(taskMetadataValue(metadata, 'key'));
    const rawKind = taskText(taskMetadataValue(metadata, 'kind'));
    const kind = HANDOFF_KINDS.find(kind => kind === rawKind);
    // No key or an unknown surface: dropped rather than guessed, because a
    // marker on the wrong finding is worse than no marker.
    if (key === '' || kind === undefined) continue;
    const owner = taskText(taskMetadataValue(metadata, 'asset'));
    if (owner !== '' && owner !== asset) continue;
    const closed = taskText(row?.status) === 'closed';
    const entry: BeadsHandoffInput = {
      kind,
      key,
      beadId,
      status: closed ? 'closed' : 'open',
      closedAt: closed ? taskInstant(row?.closed_at) : null,
    };
    const mapKey = `${kind}\0${key}`;
    const held = byKey.get(mapKey);
    if (!held || handoffRank(entry, held) < 0) byKey.set(mapKey, entry);
  }
  // Ranked, then truncated, then sorted: the rank decides what survives a
  // saturated property; the final sort makes the payload a function of the
  // hub's state rather than of the order Ntasks answered in.
  return [...byKey.values()]
    .sort(handoffRank)
    .slice(0, HANDOFF_LIMIT)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

/** Which of two tasks for the same finding is the one to show. Negative means
 * `a` wins: open over closed, then the newer close, then the lower id. */
function handoffRank(a: BeadsHandoffInput, b: BeadsHandoffInput) {
  return (
    Number(a.status === 'closed') - Number(b.status === 'closed') ||
    (b.closedAt ?? '').localeCompare(a.closedAt ?? '') ||
    a.beadId.localeCompare(b.beadId)
  );
}

// Task snapshot poller — each task project's boards, once a minute, into the
// central store so the Tower can render them. The runner reads the boards from
// Ntasks (runner/task-service-poll.mjs) and POSTs what it saw to the ingest
// worker. This is a read: the poller never creates, closes or edits a task
// (runner/panel-review.mjs and runner/watch-readbacks.mjs are separate lanes
// that write).

/** How many of each list a project reports: the board shows the head of the
 * queue, not the queue. */
export const TASK_READY_LIMIT = 10;
export const TASK_IN_PROGRESS_LIMIT = 10;
export const TASK_BLOCKED_LIMIT = 10;
export const TASK_DAILY_CLOSED_LIMIT = 5;
/** Newest-filed work a project reports, so the Wall feed can say "New task"
 * the minute one is filed. Capped like the closed list. */
export const TASK_CREATED_LIMIT = 5;
/** "Recently closed" means closed within this many days — the "what moved?"
 * window, at day grain like the closed read's own reach. */
export const TASK_CLOSED_WINDOW_DAYS = 7;
/** How far back the closed read reaches: this calendar week and last, from
 * Monday in any time zone, plus the boundary day the task client may leave
 * out. The recent lists above are cut from it to their own week. */
export const TASK_CLOSES_DAYS = 15;
/** The default priority, used when a task carries none. */
const TASK_DEFAULT_PRIORITY = 2;
/** The task type that is a container rather than work. Counting epics inflates
 * every "how much is left?" number, so they are filtered here, at the only
 * place that can see the untruncated lists. */
export const TASK_CONTAINER_TYPE = 'epic';
/** P0–P1. The urgency question a property card asks, and the one thing about a
 * queue that cannot wait for someone to open the board. */
export const TASK_HIGH_PRIORITY_MAX = 1;
/** Priorities run P0–P4, so a queue's shape is five numbers. Computed here because
 * the lists are truncated downstream, so nothing else can see the whole
 * distribution. */
export const TASK_PRIORITY_BANDS = 5;
/** The status of deliberately parked work. Only the deferred list holds it. */
export const TASK_DEFERRED_STATUS = 'deferred';

/** The oldest close still worth showing, as a YYYY-MM-DD day. */
export function tasksClosedSince(nowMs: number) {
  return new Date(nowMs - TASK_CLOSED_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/** The first day the closed read asks for. */
export function tasksClosesSince(nowMs: number) {
  return new Date(nowMs - TASK_CLOSES_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The lists one project's snapshot is made of, each a list of task rows
 * (`boardReads` in runner/task-service-poll.mjs cuts them from the project's
 * Ntasks boards):
 * - `active`: every task not closed or parked, for the counts and the
 *   in-flight list. Uncut: the counts must be true though the lists are
 *   truncated afterwards.
 * - `ready`: claimable work, as Ntasks marks it, in the board's order. Ntasks
 *   decides what is blocked; re-deriving it here would be a second rule.
 * - `blocked`: open tasks whose blockers are still open.
 * - `closed`: the closes since `tasksClosesSince`.
 * - `epics`: containers with their all-time child progress, since the closed
 *   list is a trailing window and an epic finished last month would otherwise
 *   read as 0% done.
 * - `human`: tasks labelled `human`, which also include parked, blocked and
 *   in-progress rows, so the inbox intersects it with `ready`.
 * - `gates`: open gates, which carry no `human` label; a human gate holds a
 *   task out of the ready list until resolved.
 * - `deferred`: deliberately parked work, which no other list holds.
 * - `panelReview` and `handoffs`: every task with the panel-review or a handoff
 *   label, any status, because a task filed a month ago is in none of the
 *   lists above.
 */
export const TASK_REQUIRED_READS = ['active', 'ready', 'blocked', 'closed'] as const;
/** Lists whose absence costs the snapshot nothing but its own enhancement. */
export const TASK_OPTIONAL_READS = ['epics', 'deferred', 'human', 'gates', 'panelReview', 'handoffs'] as const;
type RequiredRead = typeof TASK_REQUIRED_READS[number];
type OptionalRead = typeof TASK_OPTIONAL_READS[number];

function taskPriority(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 9 ? value : TASK_DEFAULT_PRIORITY;
}

function countPriority(priorities: number[], priority: number) {
  const band = Math.min(priority, TASK_PRIORITY_BANDS - 1);
  priorities[band] = (priorities[band] ?? 0) + 1;
}

/** One task row flattened to what a board row needs. Row field names are
 * snake_case (`runnerRow` in runner/task-service-poll.mjs); everything the OS
 * stores is camelCase, and this is the one place the two meet. A task with a
 * blank title falls back to its own id rather than rendering as an empty row. `links` (`taskLinks`)
 * adds the task's links to other tasks. */
function taskIssue(row: TaskRow | null, links?: Links) {
  const id = taskText(row?.id);
  return {
    id,
    title: taskText(row?.title, id),
    status: taskText(row?.status, 'open'),
    priority: taskPriority(row?.priority),
    issueType: taskText(row?.await_type) !== '' ? 'gate' : taskText(row?.issue_type, 'task'),
    assignee: taskText(row?.assignee) || null,
    updatedAt: taskInstant(row?.updated_at),
    closedAt: taskInstant(row?.closed_at),
    // When the task was filed: the only field that tells a new task from an
    // old one.
    createdAt: taskInstant(row?.created_at),
    // The epic this task belongs to (its `parent`). null = un-epiced, which the board groups
    // as the remainder rather than hiding.
    parent: taskText(row?.parent) || null,
    // When a parked task asks to be looked at again. Only deferred tasks carry
    // one.
    deferUntil: taskInstant(row?.defer_until),
    ...taskChoices(row),
    ...taskResolution(row),
    ...taskCard(row),
    ...(links === undefined ? {} : links(row)),
  };
}

/**
 * Each task's links to other tasks, as the Tower's live read takes them
 * (`taskRowDependencies`). They are read off the active, deferred and closed
 * rows first, and a task those rows do not hold keeps the links on its own
 * row. Each link names the other task's status where any of these reads holds
 * that task. A task with more links than the store keeps carries none, so its
 * links read as not recorded rather than short.
 */
function taskLinks(listRows: (TaskRow | null)[], otherRows: (TaskRow | null)[]): Links {
  const listed = new Map<string, TaskRow>();
  const statuses = new Map<string, string>();
  for (const [rows, list] of [[listRows, true], [otherRows, false]] as const) {
    for (const row of rows) {
      const id = taskText(row?.id);
      if (id === '' || row === null) continue;
      if (!statuses.has(id)) statuses.set(id, taskText(row.status, 'open'));
      if (list && !listed.has(id)) listed.set(id, row);
    }
  }
  return (row) => {
    const edges = taskRowDependencies(listed.get(taskText(row?.id))?.dependencies ?? row?.dependencies);
    if (edges.length > BEADS_DEPENDENCIES_MAX) return {};
    return {
      dependencies: edges.map((edge) => {
        const status = edge.status ?? statuses.get(edge.id) ?? null;
        return { id: edge.id, type: edge.type, ...(status === null ? {} : { status }) };
      }),
    };
  };
}

/** Why the task is worth doing and the kind of change it makes, as the task
 * tools recorded them; no keys when it carries neither, so a row without them
 * reads as it always did. */
function taskCard(row: TaskRow | null) {
  const card = readTaskCard(row?.metadata), changeClass = readTaskChangeClass(row?.metadata);
  return { ...(card === null ? {} : { card }), ...(changeClass === null ? {} : { changeClass }) };
}

/** How a closed task's close ended, when it is not done; no keys for a done
 * close or an open task, so a row without them reads as it always did. */
function taskResolution(row: TaskRow | null): Pick<BeadsIssueInput, 'resolution' | 'duplicateOf'> {
  if (row?.status !== 'closed') return {};
  const { resolution, duplicateOf } = readTaskResolution(row?.metadata, row?.closed_at);
  return resolution === 'done' ? {} : { resolution, ...(duplicateOf === null ? {} : { duplicateOf }) };
}

/** A task's choices and a person's pick, as the task tools and the choose
 * operation recorded them; no keys when it carries neither, so a row without
 * them reads as it always did. */
function taskChoices(row: TaskRow | null) {
  const choices = readTaskChoices(row?.metadata), choice = readTaskChoice(row?.metadata);
  return { ...(choices === null ? {} : { choices }), ...(choice === null ? {} : { choice }) };
}

/**
 * The ask inside a gate's description — the one reader the Tower's live task
 * read shares (packages/contract/src/task-gate.mts), so the snapshot and the
 * live board never title one gate two ways.
 */
export { gateReason as taskGateReason };

/** Who did the work, as the Tower's Home line and the Wall read it without a
 * live task read: each worker and model's closes in the closed window and the
 * work it holds, and the newest claims and closes with their evidence. */
export const TASK_WORKER_LIMIT = 20;
export const TASK_WORK_LIMIT = 12;
/** A close reason is evidence, kept whole up to here and cut beyond. */
export const TASK_EVIDENCE_MAX = 300;

/** Who a closed row's close belongs to: the closer NoticeOS recorded for this
 * close, else whoever held it. */
function taskCloser(row: TaskRow) {
  return recordsClose(row.metadata, row.closed_at)
    ? taskText(taskRecord(row.metadata)?.[TASK_METADATA.closedBy.name]) : taskText(row.assignee);
}
function taskModel(row: TaskRow, closed: boolean) {
  const metadata = taskRecord(row.metadata);
  return (closed ? taskText(metadata?.[TASK_METADATA.closedModel.name]) : '')
    || taskText(metadata?.[TASK_METADATA.claimedModel.name]) || null;
}
/** Who filed a task and the model it named, as the task tools recorded them;
 * no keys when they recorded none. */
export function taskFiler(input: unknown) {
  const metadata = taskRecord(taskRecord(input)?.metadata);
  const by = taskText(metadata?.[TASK_METADATA.filedBy.name]);
  const model = taskText(metadata?.[TASK_METADATA.filedModel.name]);
  return by === '' ? {} : { filedBy: by, ...(model === '' ? {} : { filedModel: model }) };
}

/** At one instant, a close is listed before a pick, and a pick before a claim. */
const WORK_ORDER = { closed: 0, chosen: 1, claimed: 2 };

/** Each worker and model's closed and held work, and the newest claims,
 * closes and picks. Rows here are the raw reads, which still carry the
 * metadata the board's rows drop. */
export function taskWork(activeRows: unknown, closedRows: unknown) {
  const work = (rows: unknown) => (Array.isArray(rows) ? rows : []).map(taskRecord)
    .filter((row): row is TaskRow => row !== null && taskText(row.id) !== ''
      && taskText(row.issue_type, 'task') !== TASK_CONTAINER_TYPE && row.issue_type !== 'gate');
  const held = work(activeRows).filter((row) => row?.status === 'in_progress' && taskText(row?.assignee) !== '');
  const closed = work(closedRows).filter((row) => taskInstant(row?.closed_at) !== null && taskCloser(row) !== '');
  const tally = new Map<string, BeadsWorkerInput>();
  const entry = (id: string, model: string | null) => {
    const key = `${id}\0${model ?? ''}`;
    const worker = tally.get(key) ?? { id, model, closedRecent: 0, inProgress: 0 };
    tally.set(key, worker);
    return worker;
  };
  for (const row of closed) entry(taskCloser(row), taskModel(row, true)).closedRecent += 1;
  for (const row of held) entry(taskText(row.assignee), taskModel(row, false)).inProgress += 1;
  const workers = [...tally.values()]
    .sort((a, b) => b.closedRecent - a.closedRecent || b.inProgress - a.inProgress || a.id.localeCompare(b.id))
    .slice(0, TASK_WORKER_LIMIT);
  const evidence = (row: TaskRow) => {
    const reason = taskText(row?.close_reason);
    return reason === '' ? null : reason.length > TASK_EVIDENCE_MAX ? `${reason.slice(0, TASK_EVIDENCE_MAX - 1)}…` : reason;
  };
  const events: BeadsWorkEventInput[] = [
    ...closed.flatMap((row) => {
      const at = taskInstant(row.closed_at);
      const { resolution } = taskResolution(row);
      return at === null ? [] : [{ kind: 'closed' as const, taskId: taskText(row.id), title: taskText(row.title, taskText(row.id)), by: taskCloser(row),
        model: taskModel(row, true), at, evidence: evidence(row), ...(resolution === undefined ? {} : { resolution }) }];
    }),
    ...[...held, ...closed].flatMap((row) => {
      const at = taskInstant(row.started_at), by = taskText(row.assignee);
      return at === null || by === '' ? [] : [{ kind: 'claimed' as const, taskId: taskText(row.id), title: taskText(row.title, taskText(row.id)), by,
        model: taskModel(row, false), at, evidence: null }];
    }),
    // A person's pick, at the time it was recorded, on whichever list holds its task now.
    ...[...work(activeRows), ...work(closedRows)].flatMap((row) => {
      const choice = readTaskChoice(row?.metadata);
      const at = taskInstant(choice?.at);
      return choice === null || at === null ? [] : [{ kind: 'chosen' as const, taskId: taskText(row.id), title: taskText(row.title, taskText(row.id)),
        by: choice.by, model: null, at, evidence: null, option: choice.option, label: choice.label }];
    }),
  ].sort((a, b) => b.at.localeCompare(a.at) || WORK_ORDER[a.kind] - WORK_ORDER[b.kind]).slice(0, TASK_WORK_LIMIT);
  return { workers, recentWork: events };
}

function taskIssues(parsed: (TaskRow | null)[] | undefined, links?: Links) {
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((row) => taskText(row?.id) !== '').map((row) => taskIssue(row, links));
}

/** A project that could not be read: named, honest, and carrying no work. The
 * board renders this as a degraded line, never as "nothing to do". */
export function taskProjectError(project: Project, error: string): BeadsProjectInput {
  return {
    asset: project.asset,
    prefix: project.prefix,
    ok: false,
    error: String(error).slice(0, TASK_SNAPSHOT_ERROR_MAX),
    counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
    priorities: Array.from({ length: TASK_PRIORITY_BANDS }, () => 0),
    epics: [],
    ready: [],
    inProgress: [],
    blocked: [],
    recentlyClosed: [],
    deferred: [],
    waiting: [],
  };
}

/** How many epics and parked tasks one project may report. */
export const TASK_EPIC_LIMIT = 25;
export const TASK_DEFERRED_LIMIT = 15;
/** The operator inbox is a top-N, not a queue. */
export const TASK_WAITING_LIMIT = 10;
/** Only a `human` gate waits on a person. A timer or a
 * GitHub gate resolves itself and is nobody's inbox item. */
export const TASK_HUMAN_GATE = 'human';

/**
 * One epic's grouping row: the container, plus what its children are doing.
 * `total`/`closed` come from the board's epics, which count all children ever;
 * the status counts and the priority shape come from the live children, so
 * they agree with the lists the board renders beneath.
 */
function childCount(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function taskEpicSummary(entry: TaskRow | null, childrenByParent: Map<string, TaskIssue[]>): BeadsEpicInput | null {
  const epic = taskRecord(entry?.epic);
  const id = taskText(epic?.id);
  if (!id) return null;
  const kids = childrenByParent.get(id) ?? [];
  const priorities = Array.from({ length: TASK_PRIORITY_BANDS }, () => 0);
  for (const kid of kids) {
    // Parked work is not queued work, so it stays out of the shape exactly as
    // it stays out of every other count.
    if (kid.status === TASK_DEFERRED_STATUS) continue;
    countPriority(priorities, kid.priority);
  }
  const byStatus = (status: string) => kids.filter((kid) => kid.status === status).length;
  return {
    id,
    title: taskText(epic?.title, id),
    status: taskText(epic?.status, 'open'),
    priority: taskPriority(epic?.priority),
    total: childCount(entry?.total_children),
    closed: childCount(entry?.closed_children),
    counts: {
      open: byStatus('open'),
      inProgress: byStatus('in_progress'),
      blocked: byStatus('blocked'),
      deferred: byStatus(TASK_DEFERRED_STATUS),
    },
    priorities,
  };
}

/**
 * Turn one project's lists (`TASK_REQUIRED_READS`, `TASK_OPTIONAL_READS`) into
 * its snapshot entry. Pure: the caller reads Ntasks. A required list that is
 * missing or holds a row without an id fails this project only; an optional
 * list that is missing stays absent, so the board shows it as a read never
 * made. The ready list keeps the board's order. Epic-type containers are
 * dropped from every list before anything is counted or truncated, the only
 * place that can see the untruncated lists.
 *
 * `closesSince` is the first day the closed read asked for; with it the entry
 * carries every close as `closes`. `closedSince` cuts the recent lists and
 * counts to their own week from that longer read. Either absent leaves that
 * part as the read returned it.
 */
export function summarizeTaskProject(project: Project, reads: Record<string, unknown> | null | undefined,
  { closedSince, closesSince }: { closedSince?: string; closesSince?: string } = {}): BeadsProjectInput {
  const parsed: Record<RequiredRead, TaskRow[]> & Partial<Record<OptionalRead, (TaskRow | null)[]>> =
    { active: [], ready: [], blocked: [], closed: [] };
  for (const key of TASK_REQUIRED_READS) {
    const values = reads?.[key];
    const rows = Array.isArray(values) ? values.map(taskRecord) : null;
    // A row without an id is refused, not skipped: dropping it would
    // undercount the queue.
    if (rows === null || !rows.every(
      (row): row is TaskRow => row !== null && taskText(row.id) !== '',
    )) {
      return taskProjectError(project, `Ntasks gave no valid ${key} list (expected tasks with non-empty ids)`);
    }
    parsed[key] = rows;
  }
  for (const key of TASK_OPTIONAL_READS) {
    const rows = reads?.[key];
    if (Array.isArray(rows)) parsed[key] = rows.map(taskRecord);
  }

  const work = (issues: TaskIssue[]) => issues.filter((issue) => issue.issueType !== TASK_CONTAINER_TYPE && issue.issueType !== 'gate');
  // The recent lists keep their week; the closed read reaches further back.
  const recentFrom = closedSince === undefined ? null : `${closedSince}T00:00:00.000Z`;
  const recentRows = parsed.closed.filter((row) => recentFrom === null || (taskInstant(row?.closed_at) ?? '') >= recentFrom);
  const agentWork = taskWork(parsed.active, recentRows);
  // The raw rows still carry the metadata that names a task's filer.
  const rawById = new Map([parsed.active, parsed.deferred, recentRows]
    .flatMap((rows) => (Array.isArray(rows) ? rows : []))
    .map((row) => [taskText(row?.id), row] as const));
  const rows = (key: RequiredRead | OptionalRead) => parsed[key] ?? [];
  const links = taskLinks([...rows('active'), ...rows('deferred'), ...rows('closed')], [...rows('gates'), ...rows('ready'), ...rows('blocked')]);
  const active = work(taskIssues(parsed.active, links));
  const ready = work(taskIssues(parsed.ready, links));
  const activeStatus = new Map(active.map((issue) => [issue.id, issue.status]));
  const blocked = [...new Map([
    ...work(taskIssues(parsed.blocked, links)).filter((issue) => ['open', 'blocked'].includes(activeStatus.get(issue.id) ?? issue.status)),
    ...active.filter((issue) => issue.status === 'blocked'),
  ].map((issue) => [issue.id, issue])).values()];
  const everyClose = work(taskIssues(parsed.closed));
  const closed = work(taskIssues(recentRows, links));
  const inProgress = active.filter((issue) => issue.status === 'in_progress');
  // Whether we looked, which is not the same as finding none: a project whose
  // deferred list is missing must not report "0 parked".
  const sawDeferred = Array.isArray(parsed.deferred);
  const deferred = sawDeferred ? work(taskIssues(parsed.deferred, links)) : [];
  // A poller that could not run the read sends no key; one that ran it and
  // found nothing sends `null`. "We never asked" must not render as "nothing
  // to triage".
  const sawPanelReview = Array.isArray(parsed.panelReview);
  // An absent key means this poller never asked the register; an empty list
  // means it asked and nobody has filed anything. Only the second licenses a
  // card to say a finding is untouched.
  const sawHandoffs = Array.isArray(parsed.handoffs);

  // What is waiting on the operator, from two reads that do not overlap:
  // blocker-aware ready tasks that also carry `human`, and open gates of
  // await_type `human`. A gate stays separate because resolving it is itself
  // the action that releases the task it holds out of the ready list.
  const sawHuman = Array.isArray(parsed.human);
  const sawGates = Array.isArray(parsed.gates);
  // Either read can preserve known rows, but only BOTH license an exact total.
  // A successful empty human list cannot prove that a failed gate read is empty.
  const sawWaiting = sawHuman || sawGates;
  const completeWaiting = sawHuman && sawGates;
  const humanIds = new Set(
    Array.isArray(parsed.human)
      ? work(taskIssues(parsed.human)).map((issue) => issue.id)
      : [],
  );
  const humanTasks = Array.isArray(parsed.human)
    ? ready.filter((issue) => issue.status === 'open' && humanIds.has(issue.id) && issue.choice == null)
    : [];
  const humanGates = Array.isArray(parsed.gates)
    ? parsed.gates
        .filter(
          (row) => row?.await_type === TASK_HUMAN_GATE && taskText(row?.status) !== 'closed',
        )
        .map((row) => {
          const issue = taskIssue(row, links);
          // "Gate: human" names the mechanism rather than the ask; its reason
          // is the ask, so it takes the title slot.
          return { ...issue, title: gateTitle(row?.title, row?.description, { id: issue.id, tasks: [...rows('active'), ...rows('blocked'), ...rows('ready')], dependents: row?.dependents }) };
        })
        .filter((issue) => issue.id !== '')
    : [];
  const waiting = [...humanGates, ...humanTasks]
    // A gate first (it is holding work, not merely asking), then by priority,
    // then oldest activity first — the ask nobody has touched is the one
    // rotting.
    .sort(
      (a, b) =>
        Number(b.issueType === 'gate') - Number(a.issueType === 'gate') ||
        a.priority - b.priority ||
        (a.updatedAt ?? '').localeCompare(b.updatedAt ?? ''),
    );
  // Gates are urgent regardless of their stored priority because they hold a
  // blocked task out of the ready list. This rides separately from the bounded
  // waiting list so a Wall total is never re-derived from a truncated head.
  const waitingUrgent =
    humanGates.length +
    humanTasks.filter((issue) => issue.priority <= TASK_HIGH_PRIORITY_MAX).length;
  const decisionIds = new Set(waiting.map(issue => issue.id));
  const attentionItems = [...new Map([
    ...active.filter(issue => issue.priority <= TASK_HIGH_PRIORITY_MAX),
    ...waiting,
  ].filter(issue => issue.status !== 'closed' && issue.status !== TASK_DEFERRED_STATUS && issue.issueType !== TASK_CONTAINER_TYPE)
    .map(issue => [issue.id, issue])).values()]
    .map(issue => ({ ...issue, decision: decisionIds.has(issue.id) }));
  // An oversized or older read remains partial rather than claiming an empty queue.
  const attentionTasks = attentionItems.length <= BEADS_ATTENTION_TASKS_MAX
    ? { items: attentionItems, complete: completeWaiting } : undefined;
  // The blocked tasks a listed decision holds lead their sample, so what an
  // answer releases is counted from tasks the snapshot lists.
  const asks = new Set(waiting.slice(0, TASK_WAITING_LIMIT).map((issue) => issue.id));
  const heldByAsk = (issue: TaskIssue) => issue.dependencies?.some((edge) => TASK_BLOCKING_DEPENDENCIES.includes(edge.type) && asks.has(edge.id)) === true;

  // Epic structure, when the board carried it. Children come from the live
  // lists (active + deferred) so the grouping always agrees with the rows
  // rendered under it; the board's epics supply only the all-time progress.
  let epics;
  if (Array.isArray(parsed.epics)) {
    const childrenByParent = new Map<string, TaskIssue[]>();
    for (const issue of [...active, ...deferred]) {
      if (!issue.parent) continue;
      const kids = childrenByParent.get(issue.parent) ?? [];
      kids.push(issue);
      childrenByParent.set(issue.parent, kids);
    }
    epics = parsed.epics
      .map((entry) => taskEpicSummary(entry, childrenByParent))
      .filter((entry) => entry !== null)
      // An epic with nothing live under it and nothing finished is structure
      // nobody has used yet — it would render as an empty card.
      .filter((entry) => entry.total > 0 || entry.counts.open + entry.counts.inProgress + entry.counts.blocked + entry.counts.deferred > 0)
      .slice(0, TASK_EPIC_LIMIT);
  }

  // The queue's SHAPE, P0..P4. A task may carry a priority above 4, so anything
  // beyond the scale folds into the last band rather than being dropped — an
  // unusual priority is still open work somebody has to do.
  const priorities = Array.from({ length: TASK_PRIORITY_BANDS }, () => 0);
  for (const issue of active) {
    countPriority(priorities, issue.priority);
  }

  return {
    asset: project.asset,
    prefix: project.prefix,
    ok: true,
    error: null,
    counts: {
      // Not-started work includes both stored and dependency-blocked tasks.
      // Ready and blocked are subsets, not additional work.
      open: active.filter((issue) => issue.status === 'open' || issue.status === 'blocked').length,
      // Cuts across the other four: a P0 can be open, in flight or blocked.
      highPriority: active.filter((issue) => issue.priority <= TASK_HIGH_PRIORITY_MAX).length,
      ready: ready.length,
      inProgress: inProgress.length,
      blocked: blocked.length,
      closedRecent: closed.length,
      // Parked, and therefore in none of the counts above: visible, not
      // counted as active.
      ...(sawDeferred ? { deferred: deferred.length } : {}),
      // Waiting on the operator. Human tasks are a filter over `ready`, while
      // human gates live outside the work queue; the count is never added to a
      // queue total.
      ...(completeWaiting ? { waiting: waiting.length } : {}),
    },
    ...(completeWaiting ? { waitingUrgent } : {}),
    ...(attentionTasks === undefined ? {} : { attentionTasks }),
    priorities,
    ...(epics === undefined ? {} : { epics }),
    ready: ready.slice(0, TASK_READY_LIMIT),
    inProgress: inProgress.slice(0, TASK_IN_PROGRESS_LIMIT),
    blocked: [...blocked.filter(heldByAsk), ...blocked.filter((issue) => !heldByAsk(issue))].slice(0, TASK_BLOCKED_LIMIT),
    // Newest close first — the only list where recency, not rank, is the point.
    recentlyClosed: closed
      .slice()
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
      .slice(0, TASK_DAILY_CLOSED_LIMIT),
    // Newest filed first, whatever became of it since: a task filed and
    // closed inside a minute was still filed. Gates are asks for approval,
    // not tasks; they reach the operator through `waiting`.
    recentlyCreated: [...new Map([...active, ...deferred, ...closed].map((issue) => [issue.id, issue])).values()]
      .filter((issue): issue is TaskIssue & { createdAt: string } => issue.createdAt !== null && issue.issueType !== 'gate')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, TASK_CREATED_LIMIT)
      .map((issue) => ({ ...issue, ...taskFiler(rawById.get(issue.id)) })),
    // Soonest wake-up first: a deferral's whole meaning is when it comes back.
    ...(sawDeferred
      ? {
          deferred: deferred
            .slice()
            .sort((a, b) => (a.deferUntil ?? '9999').localeCompare(b.deferUntil ?? '9999'))
            .slice(0, TASK_DEFERRED_LIMIT),
        }
      : {}),
    ...(sawWaiting ? { waiting: waiting.slice(0, TASK_WAITING_LIMIT) } : {}),
    ...(sawPanelReview ? { panelReview: panelReviewEntry(parsed.panelReview) } : {}),
    ...(sawHandoffs ? { handoffs: handoffEntries(parsed.handoffs, project.asset) } : {}),
    // Absent when nobody holds or closed work in the window, so a board
    // without either reads as it always did.
    ...(agentWork.workers.length ? { workers: agentWork.workers } : {}),
    ...(agentWork.recentWork.length ? { recentWork: agentWork.recentWork } : {}),
    ...taskCloses(everyClose, closesSince),
  };
}

/** Every close the read returned, oldest first, for the week counts: none when
 * the read's reach is not known or it held more than the store keeps, so a
 * week is never counted short. */
function taskCloses(issues: TaskIssue[], since: string | undefined): Pick<BeadsProjectInput, 'closes'> {
  if (since === undefined) return {};
  const items = issues
    .flatMap((issue) => issue.closedAt === null ? [] : [
      { at: issue.closedAt, ...(issue.resolution === undefined ? {} : { resolution: issue.resolution }) },
    ])
    .sort((a, b) => a.at.localeCompare(b.at) || (a.resolution ?? '').localeCompare(b.resolution ?? ''));
  return items.length > BEADS_CLOSES_MAX ? {} : { closes: { since, items } };
}
