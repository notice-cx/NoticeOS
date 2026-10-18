/** Pure hosted task planning, not authentication or execution.
 * Before every call, the server must authorize the selected workspace and
 * named action. A workspace UUID, capability handle or plan does not establish
 * that authority. Requests cannot supply workspace selection or physical facts.
 * The eventual executor supplies its authenticated actor and process setup;
 * it must not append flags after the terminal `--` in these fixed arguments.
 * Command execution is not qualified here, including history's internal
 * checkout with --readonly. The executor proof must exercise the exact plans.
 */
import { SERVER_TASK_METADATA, TASK_METADATA } from '../packages/contract/src/task-metadata.mjs';
import { choiceName, readTaskChoice, readTaskChoices, TASK_CHOICE_KEYS, TASK_CHOICE_LIMITS, taskChoiceOf, taskChoicesOf, type TaskChoice,
  type TaskChoiceKey, type TaskChoices } from '../packages/contract/src/task-choices.mjs';
import { TASK_RESOLUTIONS, type TaskResolution } from '../packages/contract/src/task-resolution.mjs';
import { TASK_BLOCKING_DEPENDENCIES as BLOCKING } from '../packages/contract/src/task-gate.mjs';

export const MAINTENANCE_ACTIONS = ['answer', 'completed', 'obsolete', 'superseded', 'duplicate', 'routine', 'release'] as const;
export interface TaskMaintenance {
  readonly kind: 'maintain';
  readonly taskId: string;
  readonly action: typeof MAINTENANCE_ACTIONS[number];
  /** Exact proposal snapshot read by the agent, returned by get_task. */
  readonly proposal: string;
  readonly explanation: string;
  readonly evidence: string;
  readonly model?: string;
  readonly duplicateOf?: string;
  /** Owner's exact words, their identity, the source and the authorized scope. */
  readonly response?: string;
  readonly owner?: string;
  readonly source?: string;
  readonly scope?: string;
  /** Checked inactivity and preserved progress; elapsed age alone is insufficient. */
  readonly holder?: string;
  readonly inactive?: true;
  readonly activityCheck?: string;
  readonly progress?: string;
}
/** Server-composed source authority. Request fields and presentation actor lists
 * never establish that an answer came from the owner. */
export type OwnerAnswerVerifier = (workspaceId: string, projectId: string, operation: TaskMaintenance,
  task: Readonly<Record<string, unknown>>, comments: unknown) => Promise<boolean>;

/** Compare a human comment with the proposal at its timestamp. A later task
 * edit cannot turn an old “A” into approval of replacement options. */
export function commentProposalMatches(operation: TaskMaintenance, row: Record<string, unknown>, comments: unknown, history: unknown): boolean {
  if (!operation.source?.startsWith('comment:')) return true;
  const comment = rowsOf(comments).find(entry => String(entry.id) === operation.source!.slice(8));
  const at = Date.parse(stringOf(comment?.created_at)), updated = Date.parse(stringOf(row.updated_at));
  if (!Number.isFinite(at)) return false;
  if (Number.isFinite(updated) && at > updated) return true;
  const versions = rowsOf(history).map(entry => ({ at: Date.parse(stringOf(entry.CommitDate)), issue: entry.Issue }))
    .filter(entry => Number.isFinite(entry.at) && entry.at <= at && entry.issue && typeof entry.issue === 'object')
    .sort((a, b) => b.at - a.at);
  const latest = versions[0];
  if (!latest) return false;
  // Equal timestamps with different proposals cannot establish which the owner saw.
  return versions.filter(entry => entry.at === latest.at).every(entry => taskProposal(entry.issue as Record<string, unknown>) === operation.proposal);
}

export const HOSTED_TASK_LIMITS = Object.freeze({
  projects: 4096, identifier: 128, title: 512, body: 8192,
  comment: 4096, reason: 2048, rows: 200, labels: 32, label: 128, metadataValue: 2048, links: 32,
  /** The longest closed read: the Agents page's eight weeks and the day it starts in. */
  closedDays: 57,
});

export type HostedTaskStatus = 'open' | 'in_progress' | 'blocked' | 'deferred' | 'closed';
export type HostedTaskType = 'task' | 'bug' | 'feature' | 'epic' | 'chore' | 'decision';
/** blocks keeps the task out of ready work until the other closes; the others only record a link. */
export type HostedTaskDependencyType = 'blocks' | 'related' | 'discovered-from';
/** A new task's link to an existing one, in the task client's `--deps` words:
 * blocked-by waits on it, blocks holds it back, the others only record a link. */
export interface HostedTaskLink {
  readonly type: 'blocked-by' | 'blocks' | 'related' | 'discovered-from';
  readonly taskId: string;
}
export type HostedTaskOperation =
  | TaskMaintenance
  | { readonly kind: 'record-maintenance'; readonly taskId: string; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: 'list'; readonly limit: number; readonly status?: HostedTaskStatus }
  | { readonly kind: 'show'; readonly taskId: string }
  /** Which of these task ids the project holds, closed or not: an absent one is not listed. */
  | { readonly kind: 'find'; readonly taskIds: readonly string[] }
  | { readonly kind: 'history'; readonly taskId: string; readonly limit: number }
  | { readonly kind: 'comments'; readonly taskId: string }
  | { readonly kind: 'ready' }
  | { readonly kind: 'epics' }
  /** Server-only ordinary poll; HTTP command parsers never construct it. */
  | { readonly kind: 'snapshot'; readonly closedSince: string }
  /** Complete lists remain process/output/time bounded, never silently sampled. */
  | { readonly kind: 'active-board'; readonly statuses: readonly Exclude<HostedTaskStatus, 'closed'>[] }
  | { readonly kind: 'closed-board'; readonly since: string; readonly until: string }
  | { readonly kind: 'create'; readonly title: string; readonly description?: string;
      readonly type?: HostedTaskType; readonly priority?: number; readonly labels?: readonly string[];
      readonly parent?: string; readonly acceptance?: string; readonly metadata?: Readonly<Record<string, string>>;
      readonly links?: readonly HostedTaskLink[];
      /** The options a person picks from, kept on the task (task-choices.mts). */
      readonly choices?: TaskChoices;
      /** The model the filer names, kept on the task. */
      readonly model?: string;
      /** Server-only receipt identity (hosted-task-operations); request parsers never set it. */
      readonly operationId?: string;
      /** Server-only: the actor filing the task, kept on it. Request parsers never set it. */
      readonly filedBy?: string }
  | { readonly kind: 'update'; readonly taskId: string; readonly status?: HostedTaskStatus;
      readonly priority?: number; readonly title?: string; readonly description?: string; readonly claim?: true;
      readonly assignee?: string; readonly parent?: string; readonly defer?: string; readonly acceptance?: string;
      readonly addLabels?: readonly string[]; readonly removeLabels?: readonly string[];
      /** A whole new set of choices, or null to take them off; refused once a person has chosen. */
      readonly choices?: TaskChoices | null;
      /** With a claim only: the model the claimer names, kept on the task. */
      readonly model?: string }
  | { readonly kind: 'comment'; readonly taskId: string; readonly text: string }
  /** `model` and `resolution` (done when absent) are the closer's, recorded by
   * the attribution that follows the close; `duplicateOf`, with a duplicate
   * only, names the other task. `force` closes a task someone else holds; only
   * a workspace service may send it, and request parsers never construct it. */
  | { readonly kind: 'close'; readonly taskId: string; readonly reason: string; readonly model?: string; readonly force?: true;
      readonly resolution?: TaskResolution; readonly duplicateOf?: string }
  /** Server-only: who closed a task and how, written after its close. Request parsers never construct it. */
  | { readonly kind: 'attribute'; readonly taskId: string; readonly closedBy: string; readonly closedAt: string; readonly model?: string;
      readonly resolution?: TaskResolution; readonly duplicateOf?: string }
  | { readonly kind: 'depend'; readonly taskId: string; readonly dependsOn: string; readonly type: HostedTaskDependencyType }
  | { readonly kind: 'undepend'; readonly taskId: string; readonly dependsOn: string }
  /** Opens a human gate the task waits on. Only a person's resolve-gate clears it. */
  | { readonly kind: 'gate'; readonly taskId: string; readonly reason: string }
  | { readonly kind: 'lint'; readonly taskIds: readonly string[] }
  /** A decision task closes with the answer; any other task goes back to ready work with it (answerSteps). */
  | { readonly kind: 'respond'; readonly taskId: string; readonly response: string }
  /** A person declining an ask: it closes with the task client's own
   * dismissal, recorded with `resolution` (won't do when absent; never done)
   * and, for a duplicate, the other task. */
  | { readonly kind: 'dismiss'; readonly taskId: string; readonly reason?: string;
      readonly resolution?: Exclude<TaskResolution, 'done'>; readonly duplicateOf?: string }
  | { readonly kind: 'resolve-gate'; readonly taskId: string; readonly reason?: string }
  /** A person's pick of one of the task's choices, run as the steps choiceSteps plans. */
  | { readonly kind: 'choose'; readonly taskId: string; readonly option: TaskChoiceKey; readonly note?: string }
  /** Server-only steps of a person's decision; request parsers never construct them. */
  | { readonly kind: 'record-choice'; readonly taskId: string; readonly choice: TaskChoice }
  /** Back to ready work for any agent: open, unassigned, without the human label.
   * `holder` is the assignee as read, so a change since refuses the step. */
  | { readonly kind: 'hand-back'; readonly taskId: string; readonly holder: string; readonly removeHuman: boolean;
      readonly preserveStatus?: HostedTaskStatus };

/** Server-owned opaque handle; do not put paths/secrets in its description. */
export interface HostedTaskProject {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly capability: symbol;
}
export interface HostedTaskRequest {
  readonly projectId: string;
  readonly operation: HostedTaskOperation;
}
export interface HostedTaskPlan {
  readonly capability: symbol;
  readonly kind: HostedTaskOperation['kind'];
  /** Classification for shared named-action policy, never permission. */
  readonly readOnly: boolean;
  readonly argv: readonly string[];
}
export type HostedTaskPlanner = (serverSelectedWorkspaceId: string, request: HostedTaskRequest) => HostedTaskPlan;

function invalid(): never { throw new Error('Invalid hosted task plan input.'); }

/** Data properties only: malformed JavaScript callers cannot smuggle getters. */
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor)) invalid();
    values[key] = descriptor.value as unknown;
  }
  return values;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key))
      || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value)) invalid();
  return value;
}
function workspace(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value)) invalid();
  return value;
}
function project(value: unknown): string {
  if (typeof value !== 'string' || value.length > HOSTED_TASK_LIMITS.identifier
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) invalid();
  return value;
}
function task(value: unknown): string {
  // Same prefix/hash/child shape the standalone lane accepts; no flag or path.
  if (typeof value !== 'string' || value.length > HOSTED_TASK_LIMITS.identifier
      || !/^[a-z0-9]+-{1,2}[a-z0-9]+(\.[0-9]+)*$/iu.test(value)) invalid();
  return value;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
      || (!empty && !value.trim())) invalid();
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid();
  return value;
}
function choice(value: unknown, values: readonly string[]): string {
  if (typeof value !== 'string' || !values.includes(value)) invalid();
  return value;
}
const STATUSES: readonly string[] = ['open', 'in_progress', 'blocked', 'deferred', 'closed'];
const TYPES: readonly string[] = ['task', 'bug', 'feature', 'epic', 'chore', 'decision'];
const DEPENDENCY_TYPES: readonly string[] = ['blocks', 'related', 'discovered-from'];
const LINK_TYPES: readonly string[] = ['blocked-by', 'blocks', 'related', 'discovered-from'];
/** Data-property entries of a bounded array, in order. */
function entries(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field || !('value' in field)) invalid();
    out.push(field.value);
  }
  return out;
}
function labelList(value: unknown, empty = false): readonly string[] {
  const labels: string[] = [];
  for (const entry of entries(value, empty ? 0 : 1, HOSTED_TASK_LIMITS.labels)) {
    const label = text(entry, HOSTED_TASK_LIMITS.label);
    if (/[\r\n\t,]/u.test(label) || label.trim() !== label || labels.includes(label)) invalid();
    labels.push(label);
  }
  return Object.freeze(labels);
}
/** `--deps` entries. The task client keeps one link per pair, so a target is
 * named once, and never the parent, which already holds its link. */
function linkList(value: unknown, parent: string | undefined): readonly string[] {
  const targets = new Set<string>(parent === undefined ? [] : [parent]);
  return Object.freeze(entries(value, 1, HOSTED_TASK_LIMITS.links).map(item => {
    const link = record(item); keys(link, ['type', 'taskId']);
    const type = choice(link.type, LINK_TYPES), target = task(link.taskId);
    if (targets.has(target)) invalid();
    targets.add(target);
    return `${type}:${target}`;
  }));
}
/** A model as its agent names it: one line, at most an identifier long. */
function model(value: unknown): string {
  const name = text(value, HOSTED_TASK_LIMITS.identifier);
  if (/[\r\n\t]/u.test(name) || name.trim() !== name) invalid();
  return name;
}
function deferDate(value: unknown): string {
  if (value === '') return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
/** A task's choices, read through data properties only and checked against
 * the one copy of their rules (task-choices.mts). */
function choiceSet(value: unknown): TaskChoices {
  const row = record(value);
  const copy: Record<string, unknown> = { ...row };
  if (Object.hasOwn(row, 'options')) copy.options = entries(row.options, 0, TASK_CHOICE_LIMITS.most).map(option => ({ ...record(option) }));
  return taskChoicesOf(copy) ?? invalid();
}
/** A close's resolution as the attribution records it: done when the close
 * names none, and the other task a duplicate names, which only a duplicate
 * takes and must take. Written on every attributed close, so a reopened
 * task's next close never reads an earlier one's. */
function resolutionMetadata(op: Record<string, unknown>, taskId: string): Readonly<Record<string, string>> {
  const resolution = Object.hasOwn(op, 'resolution') ? choice(op.resolution, TASK_RESOLUTIONS) : 'done';
  if ((resolution === 'duplicate') !== Object.hasOwn(op, 'duplicateOf')) invalid();
  if (resolution !== 'duplicate') return { [TASK_METADATA.resolution.name]: resolution };
  const other = task(op.duplicateOf);
  if (other === taskId) invalid();
  return { [TASK_METADATA.resolution.name]: resolution, [TASK_METADATA.duplicateOf.name]: other };
}
function handoffMetadata(value: unknown): Readonly<Record<string, string>> {
  // What only the server writes is never a caller's metadata.
  const row = record(value); keys(row, [], Object.values(TASK_METADATA).map(field => field.name)
    .filter(name => !SERVER_TASK_METADATA.includes(name)));
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, entry] of Object.entries(row)) result[key] = text(entry, HOSTED_TASK_LIMITS.metadataValue);
  return Object.freeze(result);
}

/** What a close's attribution writes onto its task: who closed it, when, the
 * model they named and how it ended. The one copy for both writers of a
 * close, the planner here and the Tower's local task lane. */
export function closerMetadata(attribution: Extract<HostedTaskOperation, { kind: 'attribute' }>): Readonly<Record<string, string>> {
  const op = record(attribution);
  keys(op, ['kind', 'taskId', 'closedBy', 'closedAt'], ['model', 'resolution', 'duplicateOf']);
  if (op.kind !== 'attribute' || typeof op.closedAt !== 'string' || !Number.isFinite(Date.parse(op.closedAt)) || op.closedAt.length > 64) invalid();
  return Object.freeze({ [TASK_METADATA.closedBy.name]: text(op.closedBy, HOSTED_TASK_LIMITS.identifier),
    [TASK_METADATA.closedAt.name]: op.closedAt,
    ...(Object.hasOwn(op, 'model') ? { [TASK_METADATA.closedModel.name]: model(op.model) } : {}),
    ...resolutionMetadata(op, task(op.taskId)) });
}

function command(input: unknown): Pick<HostedTaskPlan, 'kind' | 'readOnly' | 'argv'> {
  const op = record(input);
  const kind = choice(op.kind, ['list', 'show', 'find', 'history', 'comments', 'ready', 'epics', 'active-board', 'closed-board',
    'snapshot', 'lint', 'create', 'update', 'comment', 'close', 'attribute', 'depend', 'undepend', 'gate', 'respond', 'dismiss', 'resolve-gate',
    'choose', 'record-choice', 'hand-back', 'maintain', 'record-maintenance']) as HostedTaskOperation['kind'];
  const readOnly = ['list', 'show', 'find', 'history', 'comments', 'ready', 'epics', 'active-board', 'closed-board', 'snapshot', 'lint'].includes(kind);
  const argv = ['--sandbox', '--json', ...(readOnly ? ['--readonly'] : [])];
  switch (kind) {
    case 'maintain': {
      keys(op, ['kind', 'taskId', 'action', 'proposal', 'explanation', 'evidence'],
        ['model', 'duplicateOf', 'response', 'owner', 'source', 'scope', 'holder', 'inactive', 'activityCheck', 'progress']);
      task(op.taskId); choice(op.action, MAINTENANCE_ACTIONS);
      text(op.proposal, 30000);
      text(op.explanation, 800); text(op.evidence, 800);
      if (op.model !== undefined) model(op.model);
      if (op.action === 'answer') {
        text(op.response, 1000); text(op.owner, HOSTED_TASK_LIMITS.identifier); text(op.source, 512); text(op.scope, 1000);
        // A source must identify a comment or an explicitly linked conversation.
        if (!/^(?:comment:|https:\/\/|codex:\/\/threads\/)/u.test(String(op.source))) invalid();
      } else if (['response', 'owner', 'source', 'scope'].some(key => Object.hasOwn(op, key))) invalid();
      if (op.action === 'release') {
        text(op.holder, HOSTED_TASK_LIMITS.identifier); text(op.activityCheck, 800); text(op.progress, 1000);
        if (op.inactive !== true) invalid();
      } else if (['holder', 'inactive', 'activityCheck', 'progress'].some(key => Object.hasOwn(op, key))) invalid();
      if (op.action === 'duplicate') { if (task(op.duplicateOf) === op.taskId) invalid(); }
      else if (Object.hasOwn(op, 'duplicateOf')) invalid();
      break;
    }
    case 'record-maintenance':
      keys(op, ['kind', 'taskId', 'value']);
      argv.push('update', `--metadata=${JSON.stringify({ [TASK_METADATA.maintenance.name]: record(op.value) })}`, '--', task(op.taskId));
      break;
    case 'list':
      keys(op, ['kind', 'limit'], ['status']);
      argv.push('list', `--limit=${integer(op.limit, 1, HOSTED_TASK_LIMITS.rows)}`);
      if (Object.hasOwn(op, 'status')) argv.push(`--status=${choice(op.status, STATUSES)}`);
      break;
    case 'show':
      keys(op, ['kind', 'taskId']);
      argv.push('show', '--', task(op.taskId));
      break;
    case 'find': {
      keys(op, ['kind', 'taskIds']);
      const ids = entries(op.taskIds, 1, HOSTED_TASK_LIMITS.rows).map(task);
      if (new Set(ids).size !== ids.length) invalid();
      argv.push('list', '--all', '--include-gates', '--limit=0', `--id=${ids.join(',')}`);
      break;
    }
    case 'history':
      keys(op, ['kind', 'taskId', 'limit']);
      argv.push('history', `--limit=${integer(op.limit, 1, HOSTED_TASK_LIMITS.rows)}`, '--', task(op.taskId));
      break;
    case 'comments':
      keys(op, ['kind', 'taskId']);
      argv.push('comments', '--', task(op.taskId));
      break;
    case 'lint': {
      keys(op, ['kind', 'taskIds']);
      const ids = entries(op.taskIds, 1, HOSTED_TASK_LIMITS.rows).map(task);
      if (new Set(ids).size !== ids.length) invalid();
      argv.push('lint', '--', ...ids);
      break;
    }
    case 'ready':
      keys(op, ['kind']); argv.push('ready', '--limit=0');
      break;
    case 'snapshot':
      keys(op, ['kind', 'closedSince']);
      if (typeof op.closedSince !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(op.closedSince)
        || !Number.isFinite(Date.parse(op.closedSince)) || new Date(op.closedSince).toISOString().slice(0, 10) !== op.closedSince) invalid();
      // The executor derives the complete fixed read batch from beadsPollArgs.
      break;
    case 'epics':
      keys(op, ['kind']); argv.push('epic', 'status');
      break;
    case 'active-board': {
      keys(op, ['kind', 'statuses']);
      if (!Array.isArray(op.statuses) || op.statuses.length < 1 || op.statuses.length > 4) invalid();
      const statuses: string[] = [];
      for (let index = 0; index < op.statuses.length; index++) {
        const property = Object.getOwnPropertyDescriptor(op.statuses, String(index));
        if (!property || !('value' in property)) invalid();
        const status = choice(property.value, ['open', 'in_progress', 'blocked', 'deferred']);
        if (statuses.includes(status)) invalid(); statuses.push(status);
      }
      if (Reflect.ownKeys(op.statuses).length !== op.statuses.length + 1) invalid();
      argv.push('list', `--status=${statuses.join(',')}`, '--limit=0', '--include-gates');
      break;
    }
    case 'closed-board': {
      keys(op, ['kind', 'since', 'until']);
      if (typeof op.since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(op.since)
        || typeof op.until !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(op.until)) invalid();
      const since = Date.parse(op.since), until = Date.parse(op.until);
      if (!Number.isFinite(since) || !Number.isFinite(until) || new Date(since).toISOString().slice(0, 10) !== op.since
        || new Date(until).toISOString() !== op.until || until < since || until - since > HOSTED_TASK_LIMITS.closedDays * 86400000) invalid();
      argv.push('list', '--status=closed', `--closed-after=${op.since}`, `--closed-before=${op.until}`, '--limit=0', '--include-gates');
      break;
    }
    case 'create':
      keys(op, ['kind', 'title'], ['description', 'type', 'priority', 'labels', 'parent', 'acceptance', 'metadata', 'links', 'choices', 'model',
        'operationId', 'filedBy']);
      argv.push('create');
      if (Object.hasOwn(op, 'description')) argv.push(`--description=${text(op.description, HOSTED_TASK_LIMITS.body, true)}`);
      if (Object.hasOwn(op, 'type')) argv.push(`--type=${choice(op.type, TYPES)}`);
      if (Object.hasOwn(op, 'priority')) argv.push(`--priority=${integer(op.priority, 0, 4)}`);
      if (Object.hasOwn(op, 'labels')) {
        const labels = labelList(op.labels, true); if (labels.length) argv.push(`--labels=${labels.join(',')}`);
      }
      // A child carries only the labels it names. Beads would copy its parent's,
      // human among them, and only a person may take that one off.
      if (Object.hasOwn(op, 'parent')) argv.push(`--parent=${task(op.parent)}`, '--no-inherit-labels');
      // In the create itself, so a task and its links land together or not at all.
      if (Object.hasOwn(op, 'links')) argv.push(`--deps=${linkList(op.links, Object.hasOwn(op, 'parent') ? task(op.parent) : undefined).join(',')}`);
      if (Object.hasOwn(op, 'acceptance')) argv.push(`--acceptance=${text(op.acceptance, HOSTED_TASK_LIMITS.body, true)}`);
      // In the create itself, so a task, its filer and its choices land together.
      if (['metadata', 'operationId', 'filedBy', 'model', 'choices'].some(key => Object.hasOwn(op, key))) {
        const metadata = { ...(Object.hasOwn(op, 'metadata') ? handoffMetadata(op.metadata) : {}),
          ...(Object.hasOwn(op, 'operationId') ? { [TASK_METADATA.operation.name]: uuid(op.operationId) } : {}),
          ...(Object.hasOwn(op, 'filedBy') ? { [TASK_METADATA.filedBy.name]: text(op.filedBy, HOSTED_TASK_LIMITS.identifier) } : {}),
          ...(Object.hasOwn(op, 'model') ? { [TASK_METADATA.filedModel.name]: model(op.model) } : {}),
          ...(Object.hasOwn(op, 'choices') ? { [TASK_METADATA.choices.name]: choiceSet(op.choices) } : {}) };
        argv.push(`--metadata=${JSON.stringify(metadata)}`);
      }
      argv.push(`--title=${text(op.title, HOSTED_TASK_LIMITS.title)}`, '--');
      break;
    case 'update': {
      const fields = ['status', 'priority', 'title', 'description', 'claim', 'assignee', 'parent', 'defer', 'acceptance', 'addLabels', 'removeLabels', 'choices'];
      keys(op, ['kind', 'taskId'], [...fields, 'model']);
      if (!fields.some(key => Object.hasOwn(op, key)) || Object.hasOwn(op, 'model') && op.claim !== true) invalid();
      // A claim writes its model with --metadata, which the task client will not combine with --unset-metadata.
      if (Object.hasOwn(op, 'choices') && Object.hasOwn(op, 'claim')) invalid();
      argv.push('update');
      if (Object.hasOwn(op, 'status')) argv.push(`--status=${choice(op.status, STATUSES)}`);
      if (Object.hasOwn(op, 'priority')) argv.push(`--priority=${integer(op.priority, 0, 4)}`);
      if (Object.hasOwn(op, 'title')) argv.push(`--title=${text(op.title, HOSTED_TASK_LIMITS.title)}`);
      if (Object.hasOwn(op, 'description')) argv.push(`--description=${text(op.description, HOSTED_TASK_LIMITS.body, true)}`);
      if (Object.hasOwn(op, 'claim')) { if (op.claim !== true || Object.hasOwn(op, 'assignee') || Object.hasOwn(op, 'status')) invalid(); argv.push('--claim'); }
      if (Object.hasOwn(op, 'assignee')) argv.push(`--assignee=${text(op.assignee, HOSTED_TASK_LIMITS.identifier, true)}`);
      if (Object.hasOwn(op, 'parent')) argv.push(`--parent=${op.parent === '' ? '' : task(op.parent)}`);
      if (Object.hasOwn(op, 'defer')) argv.push(`--defer=${deferDate(op.defer)}`);
      if (Object.hasOwn(op, 'acceptance')) argv.push(`--acceptance=${text(op.acceptance, HOSTED_TASK_LIMITS.body, true)}`);
      if (Object.hasOwn(op, 'addLabels')) argv.push(`--add-label=${labelList(op.addLabels).join(',')}`);
      if (Object.hasOwn(op, 'removeLabels')) argv.push(`--remove-label=${labelList(op.removeLabels).join(',')}`);
      if (Object.hasOwn(op, 'choices')) {
        argv.push(op.choices === null ? `--unset-metadata=${TASK_METADATA.choices.name}`
          : `--metadata=${JSON.stringify({ [TASK_METADATA.choices.name]: choiceSet(op.choices) })}`);
      }
      // In the claim itself, so the claim and its model land together.
      if (Object.hasOwn(op, 'model')) argv.push(`--metadata=${JSON.stringify({ [TASK_METADATA.claimedModel.name]: model(op.model) })}`);
      argv.push('--', task(op.taskId));
      break;
    }
    case 'comment':
      keys(op, ['kind', 'taskId', 'text']);
      argv.push('comments', 'add', '--', task(op.taskId), text(op.text, HOSTED_TASK_LIMITS.comment));
      break;
    case 'close':
      keys(op, ['kind', 'taskId', 'reason'], ['model', 'force', 'resolution', 'duplicateOf']);
      if (Object.hasOwn(op, 'model')) model(op.model);
      if (Object.hasOwn(op, 'force') && op.force !== true) invalid();
      // The resolution is the attribution's to write; the close reason stays the caller's own text.
      resolutionMetadata(op, task(op.taskId));
      argv.push('close', `--reason=${text(op.reason, HOSTED_TASK_LIMITS.reason)}`, ...(op.force ? ['--force'] : []), '--', task(op.taskId));
      break;
    case 'attribute':
      // The task client's close carries no metadata, so the closer follows it.
      argv.push('update', `--metadata=${JSON.stringify(closerMetadata(op as unknown as Extract<HostedTaskOperation, { kind: 'attribute' }>))}`,
        '--', task(op.taskId));
      break;
    case 'depend':
    case 'undepend': {
      keys(op, ['kind', 'taskId', 'dependsOn', ...(kind === 'depend' ? ['type'] : [])]);
      const from = task(op.taskId), to = task(op.dependsOn);
      if (from === to) invalid();
      // A repeated add or remove changes nothing, and an add never retypes an existing edge.
      argv.push('dep', ...(kind === 'depend' ? ['add', `--type=${choice(op.type, DEPENDENCY_TYPES)}`] : ['remove']), '--', from, to);
      break;
    }
    case 'gate':
      keys(op, ['kind', 'taskId', 'reason']);
      argv.push('gate', 'create', '--type=human', `--blocks=${task(op.taskId)}`, `--reason=${text(op.reason, HOSTED_TASK_LIMITS.reason)}`, '--');
      break;
    case 'respond':
      keys(op, ['kind', 'taskId', 'response']);
      // Short enough to fit one comment as "Answered: <response>" when the task goes back to ready work.
      argv.push('human', 'respond', `--response=${text(op.response, HOSTED_TASK_LIMITS.comment - ANSWERED.length)}`, '--', task(op.taskId));
      break;
    case 'dismiss':
    case 'resolve-gate':
      keys(op, ['kind', 'taskId'], kind === 'dismiss' ? ['reason', 'resolution', 'duplicateOf'] : ['reason']);
      // A dismissal records how it ended after it lands; nothing declined is done.
      if (kind === 'dismiss' && (op.resolution === 'done' || Object.hasOwn(op, 'duplicateOf') && !Object.hasOwn(op, 'resolution'))) invalid();
      if (kind === 'dismiss') resolutionMetadata(op, task(op.taskId));
      argv.push(...(kind === 'dismiss' ? ['human', 'dismiss'] : ['gate', 'resolve']));
      if (Object.hasOwn(op, 'reason')) argv.push(`--reason=${text(op.reason, HOSTED_TASK_LIMITS.reason)}`);
      argv.push('--', task(op.taskId));
      break;
    case 'choose':
      // The executor composes a pick from its steps (choiceSteps), each planned on its own.
      keys(op, ['kind', 'taskId', 'option'], ['note']);
      task(op.taskId); choice(op.option, TASK_CHOICE_KEYS);
      if (Object.hasOwn(op, 'note')) text(op.note, TASK_CHOICE_LIMITS.note);
      break;
    case 'record-choice': {
      keys(op, ['kind', 'taskId', 'choice']);
      const recorded = taskChoiceOf({ ...record(op.choice) }) ?? invalid();
      text(recorded.label, TASK_CHOICE_LIMITS.label); text(recorded.by, HOSTED_TASK_LIMITS.identifier); text(recorded.at, 64);
      if (recorded.note !== undefined) text(recorded.note, TASK_CHOICE_LIMITS.note);
      argv.push('update', `--metadata=${JSON.stringify({ [TASK_METADATA.choice.name]: recorded })}`, '--', task(op.taskId));
      break;
    }
    case 'hand-back':
      keys(op, ['kind', 'taskId', 'holder', 'removeHuman'], ['preserveStatus']);
      if (typeof op.removeHuman !== 'boolean' || typeof op.holder !== 'string' || /[\r\n\t]/u.test(op.holder)) invalid();
      // --if-assignee names the holder as read: a hand-over the task client allows, and refuses if the holder changed since.
      if (op.preserveStatus !== undefined) choice(op.preserveStatus, STATUSES.filter(status => status !== 'closed'));
      argv.push('update', ...(op.preserveStatus !== undefined ? [`--if-status=${op.preserveStatus}`] : ['--status=open']), '--assignee=', `--if-assignee=${text(op.holder, HOSTED_TASK_LIMITS.identifier, true)}`,
        ...(op.removeHuman ? ['--remove-label=human'] : []), '--', task(op.taskId));
      break;
  }
  return { kind, readOnly, argv: Object.freeze(argv) };
}

/** A write refused because the task it would change is a person's decision.
 * Thrown only after admission and the task's own read, so naming the reason
 * tells the caller nothing its access did not already show. */
export class HumanDecisionRefused extends Error {
  override name = 'HumanDecisionRefused';
  constructor(readonly taskId: string) { super(`${taskId} is a person's decision.`); }
}
/** A person's decision: a gate, or a task labelled human. */
export function isHumanDecision(row: { readonly issue_type?: unknown; readonly labels?: unknown }): boolean {
  return row.issue_type === 'gate' || Array.isArray(row.labels) && row.labels.includes('human');
}
/** The tasks an executor must find are not a person's decision before it runs
 * this ordinary write: no close, marker removal or removed dependency stands
 * in for the decision itself, which has its own named verb. */
export function decisionGuardTargets(operation: HostedTaskOperation): readonly string[] {
  if (operation.kind === 'close') return [operation.taskId];
  if (operation.kind === 'update') return operation.status === 'closed' || operation.removeLabels?.includes('human') ? [operation.taskId] : [];
  if (operation.kind === 'undepend') return [operation.taskId, operation.dependsOn];
  return [];
}

/** A task project as list_projects names it. */
export interface TaskProjectName { readonly projectId: string; readonly name: string; readonly prefix: string }
/** Why a call was refused, from the state of the task it names: read just
 * before a write, or after the store refused one. Thrown only after admission
 * and that read, so naming the cause shows nothing get_task would not. */
export type TaskStateReason =
  | { readonly kind: 'closed' }
  | { readonly kind: 'held'; readonly holder: string }
  /** Open gates it waits on; `human` when every one waits on a person. */
  | { readonly kind: 'gate'; readonly gates: readonly string[]; readonly human: boolean }
  | { readonly kind: 'children'; readonly children: readonly string[] }
  /** A claim of a task whose status is not open, with the open tasks it depends on. */
  | { readonly kind: 'not-open'; readonly status: string; readonly blockers: readonly string[] }
  /** A dependency asked for with one type where an edge of another already stands. */
  | { readonly kind: 'linked'; readonly dependsOn: string; readonly type: string; readonly wanted: string }
  /** A change to a task's choices, or a second pick, after a person picked one:
   * the pick as a sentence names it, or null when it cannot be read. */
  | { readonly kind: 'chosen'; readonly chosen: string | null }
  /** A pick on a task that offers no choices. */
  | { readonly kind: 'no-choices' }
  /** A pick of an option the task does not offer, with the ones it does. */
  | { readonly kind: 'no-option'; readonly option: string; readonly offered: readonly string[] }
  | { readonly kind: 'missing'; readonly project: TaskProjectName };
/** What the refused call tried, so its refusal can say what to do instead. */
export type TaskAttempt = 'close' | 'claim' | 'reassign' | 'other';
export class TaskStateRefused extends Error {
  override name = 'TaskStateRefused';
  constructor(readonly taskId: string, readonly attempted: TaskAttempt, readonly reason: TaskStateReason) {
    super(`${taskId} refused: ${reason.kind}.`);
  }
}
/** The task client did not complete a command every check before it allowed:
 * it ran out of time, or failed with no cause the task's own state shows. */
export class TaskStoreFailed extends Error {
  override name = 'TaskStoreFailed';
  constructor(readonly timedOut: boolean) { super(timedOut ? 'The task client did not answer in time.' : 'The task client failed.'); }
}

/** The dependency types the task client counts as live blockers while the other task is open. */
function rowsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row)) : [];
}
const stringOf = (value: unknown): string => typeof value === 'string' ? value : '';
/** The task client's actor match: a run of `.`, `_` or `-` is one separator, and `--` another. */
function canonicalActor(name: string): string {
  return name.replace(/[._-]+/gu, run => run === '--' ? '/' : '_');
}
export function sameActor(a: string, b: string): boolean { return a === b || canonicalActor(a) === canonicalActor(b); }

/** A write whose own task's state decides how it runs: a close, a claim, a
 * change of assignee or of choices. A caller's forced close is a service
 * closing for the agent it named, and decides for itself. */
function stateGuarded(operation: HostedTaskOperation): operation is Extract<HostedTaskOperation, { kind: 'close' | 'update' }> {
  if (operation.kind === 'close') return operation.force !== true;
  return operation.kind === 'update' && (operation.claim === true || operation.assignee !== undefined || operation.choices !== undefined);
}
/** Whether a person has chosen on this task: its pick named, or null when the
 * recorded pick cannot be read; undefined when it carries none. */
function chosenOn(row: Record<string, unknown>): string | null | undefined {
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || (metadata as Record<string, unknown>)[TASK_METADATA.choice.name] === undefined) return undefined;
  const chosen = readTaskChoice(metadata);
  return chosen === null ? null : choiceName(chosen.option, chosen.label);
}
/** The tasks an executor reads before this write: the decisions it must not
 * stand in for, then the task whose own state decides it. */
export function writeGuardReads(operation: HostedTaskOperation): readonly string[] {
  const reads = [...decisionGuardTargets(operation)];
  if (stateGuarded(operation) && !reads.includes(operation.taskId)) reads.push(operation.taskId);
  return reads;
}
/** The fixed read of one of those tasks. A close reads its children too, which
 * the task client's plain show only counts. */
export function guardReadArgs(operation: HostedTaskOperation, taskId: string): readonly string[] {
  const children = (operation.kind === 'close' && stateGuarded(operation) || operation.kind === 'choose' || operation.kind === 'respond') && operation.taskId === taskId;
  return Object.freeze(['--sandbox', '--readonly', '--json', 'show', ...(children ? ['--include-dependents'] : []), '--', task(taskId)]);
}
/** The write to run, given its task as read just before (writeGuardReads). A
 * dependency holds a task out of ready work, not open: a close whose only
 * obstacle is an open blocker runs forced past it, and the checks that force
 * would also skip are made here first. Its holder, an open gate and an open
 * child still stop it. A claim or a change of assignee is refused here for
 * the causes the task client would refuse it for, so the refusal can name
 * them. */
export function guardedWrite(operation: HostedTaskOperation, row: Record<string, unknown> | undefined, actor: string): HostedTaskOperation {
  if (!stateGuarded(operation)) return operation;
  if (!row || row.id !== operation.taskId) invalid();
  const attempted: TaskAttempt = operation.kind === 'close' ? 'close' : operation.claim === true ? 'claim'
    : operation.assignee !== undefined ? 'reassign' : 'other';
  const refuse = (reason: TaskStateReason): never => { throw new TaskStateRefused(operation.taskId, attempted, reason); };
  const status = stringOf(row.status), holder = stringOf(row.assignee);
  const held = holder !== '' && !sameActor(holder, actor);
  const open = (edge: Record<string, unknown>) => stringOf(edge.status) !== 'closed';
  const blockers = rowsOf(row.dependencies).filter(edge => BLOCKING.includes(stringOf(edge.dependency_type)) && open(edge));
  if (operation.kind === 'update') {
    // A pick is recorded against the options the person saw.
    const chosen = operation.choices === undefined ? undefined : chosenOn(row);
    if (chosen !== undefined) refuse({ kind: 'chosen', chosen });
    if (attempted === 'other') return operation;
    if (attempted === 'reassign') {
      // The task client lets only its holder hand on a task someone is working.
      if (status === 'in_progress' && held && !sameActor(holder, operation.assignee!)) refuse({ kind: 'held', holder });
      return operation;
    }
    if (status === 'closed') refuse({ kind: 'closed' });
    if (held) refuse({ kind: 'held', holder });
    // The task client claims an open task, or re-claims one its holder is working.
    if (status === 'blocked' || status === 'deferred' || status === 'in_progress' && holder === '') {
      refuse({ kind: 'not-open', status, blockers: blockers.map(edge => stringOf(edge.id)) });
    }
    return operation;
  }
  if (status === 'closed') refuse({ kind: 'closed' });
  if (held) refuse({ kind: 'held', holder });
  const gates = blockers.filter(edge => edge.issue_type === 'gate');
  if (gates.length) refuse({ kind: 'gate', gates: gates.map(edge => stringOf(edge.id)), human: gates.every(edge => edge.await_type === 'human') });
  const children = rowsOf(row.dependents).filter(edge => edge.dependency_type === 'parent-child' && open(edge));
  if (children.length) refuse({ kind: 'children', children: children.map(edge => stringOf(edge.id)) });
  // A pinned or template task keeps the task client's own refusal, which force would skip.
  const kept = row.pinned === true || status === 'pinned' || row.is_template === true;
  return blockers.length && !kept ? Object.freeze({ ...operation, force: true as const }) : operation;
}
/** What the task's state, read again after the store refused a write, says
 * refused it, or null when it explains nothing: the rules guardedWrite checks
 * before a write (another caller can win a claim between that read and the
 * write), and an edge the write would retype, which the task client never does. */
export function refusalFromState(operation: HostedTaskOperation, row: Record<string, unknown>, actor: string): TaskStateRefused | null {
  if (operation.kind === 'depend') {
    const edge = rowsOf(row.dependencies).find(entry => entry.id === operation.dependsOn);
    const type = stringOf(edge?.dependency_type);
    return edge && type !== operation.type
      ? new TaskStateRefused(operation.taskId, 'other', { kind: 'linked', dependsOn: operation.dependsOn, type, wanted: operation.type }) : null;
  }
  if (!stateGuarded(operation)) return null;
  // Closed with this very reason: the refused close may itself have landed, which a retry with its key confirms.
  if (operation.kind === 'close' && row.status === 'closed' && row.close_reason === operation.reason) return null;
  try { guardedWrite(operation, row, actor); return null; } catch (error) {
    if (error instanceof TaskStateRefused) return error;
    throw error;
  }
}

/** One step of a person's decision: an ordinary write, run once the decision is admitted. */
export type DecisionStep = Extract<HostedTaskOperation, { kind: 'record-choice' | 'comment' | 'close' | 'hand-back' }>;
export type MaintenanceStep = DecisionStep | Extract<HostedTaskOperation, { kind: 'record-maintenance' | 'update' | 'depend' | 'attribute' }>;

/** The proposal excludes comments and reservations: neither changes what the owner saw. */
export function taskProposal(row: Record<string, unknown>): string {
  return JSON.stringify([row.id, row.title ?? '', row.description ?? '', row.acceptance_criteria ?? '',
    row.issue_type, readTaskChoices(row.metadata)]);
}

export class TaskMaintenanceRefused extends Error {
  override name = 'TaskMaintenanceRefused';
}
function maintenanceRefused(message: string): never { throw new TaskMaintenanceRefused(message); }

/** Resolve short replies only against the frozen proposal. Free text is a direction,
 * never a guessed option; an unclear short answer leaves the question open. */
export function replyOption(response: string, choices: TaskChoices | null, taskId?: string): TaskChoiceKey | null {
  if (/\?|\b(?:not sure|unsure|maybe|perhaps|need more|need to think|can you explain|what do you mean)\b/iu.test(response)) {
    return maintenanceRefused('This reply leaves the decision unresolved. Ask one clarification covering only the uncertainty.');
  }
  if (choices === null) return null;
  const reply = response.trim().replace(/[.!]$/u, '').toLowerCase();
  const batch = /^([a-f]) for (.+)$/u.exec(reply);
  const named: readonly string[] = batch?.[2]?.match(/[a-z0-9]+-{1,2}[a-z0-9]+(?:\.[0-9]+)*/giu) ?? [];
  const letter = /^\(?([a-f])\)?$/u.exec(reply)?.[1]
    ?? (taskId && named.includes(taskId.toLowerCase()) ? batch?.[1] : undefined);
  if (letter) {
    if (choices.options.some(option => option.key === letter)) return letter as TaskChoiceKey;
    return maintenanceRefused('That letter is not an offered option. Ask which offered option the owner means.');
  }
  if (/^(?:yes[, ]+)?(?:your |the )?recommendation(?: please)?$/u.test(reply)
    || /^(?:yes[, ]+)?(?:go with |use |do )(?:your |the )?recommendation$/u.test(reply)) {
    return choices.options.find(option => option.recommended)!.key;
  }
  const label = choices.options.find(option => option.label.toLowerCase() === reply);
  if (label) return label.key;
  if (/^(?:yes|no|ok|okay|sure|approved|go ahead|that one|all|both)$/u.test(reply)) {
    return maintenanceRefused('This reply does not identify an option. Ask one clarification naming only the unresolved choice.');
  }
  if (!/^(?:please )?(?:use|build|keep|switch|remove|add|set|return|make|change|stop|start|leave|ship|do not|don't|skip|choose|go with|move|enable|disable|create|proceed|implement|replace|rename|align|put|show|hide|include|exclude|reduce|increase|retain|drop|combine|split|follow|apply|send|publish|defer|wait|accept|reject|cancel|continue|schedule|run|review|record|close|reopen)\b|^(?:i (?:want|approve|choose|prefer)|let's|let us|we should)\b/u.test(reply)) {
    return maintenanceRefused('This reply does not give a clear direction. Ask one clarification covering only the unresolved choice.');
  }
  return null;
}

/** Evidence-backed task maintenance. The caller verifies linked conversation
 * evidence; the server verifies task comments, proposal identity and reservation
 * comparisons. Retirement records no permission and leaves gated actions blocked. */
export function maintenanceSteps(operation: TaskMaintenance, row: Record<string, unknown>, comments: unknown,
  actor: string, at: string, duplicate?: Record<string, unknown>, ownerVerified = false): readonly MaintenanceStep[] {
  command(operation);
  if (row.id !== operation.taskId || taskProposal(row) !== operation.proposal) {
    return maintenanceRefused('The proposal changed. Read it again and match the owner’s answer to the proposal they saw.');
  }
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata as Record<string, unknown> : {};
  const previous = metadata[TASK_METADATA.maintenance.name] as Record<string, unknown> | undefined;
  const identity = JSON.stringify(operation);
  const same = previous?.identity === identity && previous?.by === actor;
  const gate = row.issue_type === 'gate';
  const retiring = ['completed', 'obsolete', 'superseded', 'duplicate'].includes(operation.action);
  const closed = row.status === 'closed';
  if (closed && !same) return maintenanceRefused('This task is already closed. Reopen it before recording a different disposition.');
  if (gate && ['routine', 'release', 'completed'].includes(operation.action)) {
    return maintenanceRefused('An approval cannot be completed or made routine from implementation evidence. Record the owner’s scoped answer or retire the abandoned request.');
  }
  if (operation.action === 'completed' && row.issue_type === 'decision') {
    return maintenanceRefused('A completed implementation does not prove a business decision was approved. Record its owner answer or why the decision is obsolete.');
  }
  const holder = stringOf(row.assignee);
  if (operation.action !== 'answer' && operation.action !== 'release' && holder && !sameActor(holder, actor)) {
    return maintenanceRefused(`Check ${holder}’s activity and release its abandoned assignment before maintaining this task.`);
  }
  if (operation.action === 'release' && holder !== operation.holder && !(same && holder === '')) {
    return maintenanceRefused('The assignment changed. Check its current holder before releasing it.');
  }
  const steps: MaintenanceStep[] = [];
  let answered: readonly DecisionStep[] = [];
  if (operation.action === 'answer') {
    if (!ownerVerified) return maintenanceRefused('The owner answer could not be authenticated from its source. Keep the recorded answer; connect its trusted source instead of asking the owner again.');
    if (sameActor(operation.owner!, actor)) return maintenanceRefused('An agent cannot supply its own answer as the owner’s.');
    if (operation.source!.startsWith('comment:')) {
      const source = rowsOf(comments).find(comment => String(comment.id) === operation.source!.slice(8));
      if (!source || source.author !== operation.owner || source.text !== operation.response) {
        return maintenanceRefused('The cited owner comment does not match its author and exact answer.');
      }
    }
    if (!isHumanDecision(row) && !same) return maintenanceRefused('This task has no unresolved human request.');
    const choices = readTaskChoices(row.metadata);
    const option = replyOption(operation.response!, choices, operation.taskId);
    if (gate) {
      const scope = /(?:^|\n)Reason:[ \t]*([\s\S]+)$/u.exec(stringOf(row.description))?.[1]?.trim();
      if (!scope || operation.scope !== scope) return maintenanceRefused('Approval scope must exactly match this gate’s requested action, environment and verification.');
      if (!/^(?:yes|approve|approved|yes[, ]+(?:your |the )?recommendation)[.!]?$/iu.test(operation.response!.trim())) {
        return maintenanceRefused('This is not an explicit approval of the named action. Keep the action blocked and clarify only its approval.');
      }
      answered = [decisionClose(row, operation.taskId, 'Owner approved the recorded scope', operation.owner!,
        reason => { throw new TaskStateRefused(operation.taskId, 'other', reason); })];
    } else if (option !== null && !closed && !(same && row.status === 'open' && !labelsOf(row).includes('human'))) {
      answered = choiceSteps({ kind: 'choose', taskId: operation.taskId, option }, row, comments, operation.owner!, at)
        .filter(step => step.kind !== 'comment');
    } else if (!closed && !(same && row.status === 'open' && !labelsOf(row).includes('human'))) {
      answered = row.issue_type === 'decision'
        ? [decisionClose(row, operation.taskId, 'Owner answered the recorded proposal', actor,
          reason => { throw new TaskStateRefused(operation.taskId, 'other', reason); })]
        : [handBack(row, operation.taskId)];
    }
  }
  const value = same ? previous! : { identity, by: actor, at, ...operation, permission: operation.action === 'answer' && gate ? 'approved-scope-only' : 'none' };
  const note = `Task maintenance: ${operation.action}. ${operation.explanation}\nEvidence: ${operation.evidence}`
    + (operation.action === 'answer' ? `\nOwner: ${operation.owner}\nSource: ${operation.source}\nAnswer: ${operation.response}\nScope: ${operation.scope}` : '')
    + (operation.action === 'release' ? `\nActivity checked: ${operation.activityCheck}\nProgress preserved: ${operation.progress}` : '')
    + (gate && retiring ? '\nRequest retired. No permission to perform the action was granted.' : '');
  if (!same) steps.push({ kind: 'record-maintenance', taskId: operation.taskId, value });
  if (!rowsOf(comments).some(comment => comment.author === actor && comment.text === note)) {
    steps.push({ kind: 'comment', taskId: operation.taskId, text: note });
  }
  if (operation.action === 'duplicate') {
    if (!duplicate || duplicate.id !== operation.duplicateOf || duplicate.status === 'closed') {
      return maintenanceRefused('The duplicate must name an open task retaining the complete scope.');
    }
    if (gate && (duplicate.issue_type !== 'gate' || duplicate.await_type !== 'human' || duplicate.description !== row.description)) {
      return maintenanceRefused('Duplicate approvals must retain exactly the same requested scope.');
    }
    steps.push({ kind: 'depend', taskId: operation.taskId, dependsOn: operation.duplicateOf!, type: 'related' });
  }
  if (gate && retiring && !closed) {
    for (const dependent of rowsOf(row.dependents).filter(edge => BLOCKING.includes(stringOf(edge.dependency_type)) && edge.status !== 'closed')) {
      if (operation.action === 'duplicate') steps.push({ kind: 'depend', taskId: stringOf(dependent.id), dependsOn: operation.duplicateOf!, type: 'blocks' });
      else steps.push({ kind: 'update', taskId: stringOf(dependent.id), status: 'blocked' });
      steps.push({ kind: 'comment', taskId: stringOf(dependent.id), text: `Approval request ${operation.taskId} retired: ${operation.explanation}. No permission granted; obtain a new action-specific approval before proceeding.` });
    }
  }
  if (!closed && retiring) {
    const resolution = operation.action === 'duplicate' ? 'duplicate' : operation.action === 'obsolete' || operation.action === 'superseded' ? 'wont-do' : 'already-handled';
    // All open children and gates still require their own disposition.
    const close = decisionClose(row, operation.taskId, `${operation.explanation}\nEvidence: ${operation.evidence}`, actor,
      reason => { throw new TaskStateRefused(operation.taskId, 'close', reason); });
    if (close.kind !== 'close') invalid();
    steps.push({ ...close, resolution, ...(operation.duplicateOf ? { duplicateOf: operation.duplicateOf } : {}), ...(operation.model ? { model: operation.model } : {}) });
  } else if (operation.action === 'answer') {
    if (gate && !closed) {
      for (const dependent of rowsOf(row.dependents).filter(edge => BLOCKING.includes(stringOf(edge.dependency_type))
        && edge.status !== 'closed' && labelsOf(edge).includes('human')
        && edge.issue_type !== 'decision' && edge.issue_type !== 'gate' && readTaskChoices(edge.metadata) === null)) {
        steps.push({ kind: 'comment', taskId: stringOf(dependent.id), text: `Owner approval recorded on ${operation.taskId}. Continue only within that recorded scope; other approvals are unchanged.` },
          handBack(dependent, stringOf(dependent.id)));
      }
    }
    steps.push(...answered);
  }
  else if (!closed && (operation.action === 'routine' || operation.action === 'release') && !(same && holder === '')) {
    steps.push({ kind: 'hand-back', taskId: operation.taskId, holder, removeHuman: operation.action === 'routine',
      ...(operation.action === 'release' && row.status !== 'in_progress' ? { preserveStatus: row.status as HostedTaskStatus } : {}) });
  }
  if (closed && same && retiring && typeof row.closed_at === 'string') {
    const resolution = operation.action === 'duplicate' ? 'duplicate' : operation.action === 'completed' ? 'already-handled' : 'wont-do';
    steps.push({ kind: 'attribute', taskId: operation.taskId, closedBy: actor, closedAt: row.closed_at,
      resolution, ...(operation.duplicateOf ? { duplicateOf: operation.duplicateOf } : {}), ...(operation.model ? { model: operation.model } : {}) });
  }
  // Validate every step before the executor applies even the first one.
  for (const step of steps) command(step);
  return Object.freeze(steps);
}
const ANSWERED = 'Answered: ';
/** The comment a pick leaves: "Chose (b) Keep the old page." and the person's note. */
export function choiceComment(choice: TaskChoice): string {
  return `Chose ${choiceName(choice.option, choice.label)}.${choice.note === undefined ? '' : ` ${choice.note}`}`;
}
/** The reason a decision task closes with after a pick. */
export function choiceCloseReason(choice: TaskChoice): string {
  return `Chose ${choiceName(choice.option, choice.label)}`;
}
/** The comment a free-text answer leaves on a task that goes back to ready work. */
export function answerComment(response: string): string {
  return `${ANSWERED}${response}`;
}
const labelsOf = (row: Record<string, unknown>): string[] =>
  Array.isArray(row.labels) ? row.labels.filter((label): label is string => typeof label === 'string') : [];
function handBack(row: Record<string, unknown>, taskId: string): DecisionStep {
  return Object.freeze({ kind: 'hand-back' as const, taskId, holder: stringOf(row.assignee), removeHuman: labelsOf(row).includes('human') });
}
/** A decision's close after a pick: past an open blocker or another holder, as
 * the task client's own response to a person closes, and refused while an
 * approval it waits on or a task under it is open. */
function decisionClose(row: Record<string, unknown>, taskId: string, reason: string, actor: string,
  refuse: (reason: TaskStateReason) => never): DecisionStep {
  const open = (edge: Record<string, unknown>) => stringOf(edge.status) !== 'closed';
  const blockers = rowsOf(row.dependencies).filter(edge => BLOCKING.includes(stringOf(edge.dependency_type)) && open(edge));
  const gates = blockers.filter(edge => edge.issue_type === 'gate');
  if (gates.length) refuse({ kind: 'gate', gates: gates.map(edge => stringOf(edge.id)), human: gates.every(edge => edge.await_type === 'human') });
  const children = rowsOf(row.dependents).filter(edge => edge.dependency_type === 'parent-child' && open(edge));
  if (children.length) refuse({ kind: 'children', children: children.map(edge => stringOf(edge.id)) });
  const holder = stringOf(row.assignee);
  const kept = row.pinned === true || row.status === 'pinned' || row.is_template === true;
  const force = !kept && (blockers.length > 0 || holder !== '' && !sameActor(holder, actor));
  return Object.freeze({ kind: 'close' as const, taskId, reason, ...(force ? { force: true as const } : {}) });
}

/** The steps that record a person's pick, from the task and its comments as
 * read just before: the pick, its comment, then a decision's close or any
 * other task's hand-back to ready work. The pick is written first, so a second
 * one is refused, and the same person sending the same option again finishes
 * the steps an interrupted pick left undone. Nothing runs when it refuses. */
export function choiceSteps(operation: Extract<HostedTaskOperation, { kind: 'choose' }>, row: Record<string, unknown>,
  comments: unknown, actor: string, at: string): readonly DecisionStep[] {
  if (!row || row.id !== operation.taskId) invalid();
  const taskId = operation.taskId;
  const refuse = (reason: TaskStateReason): never => { throw new TaskStateRefused(taskId, 'other', reason); };
  const decision = row.issue_type === 'decision', closed = stringOf(row.status) === 'closed';
  const steps: DecisionStep[] = [];
  let pick: TaskChoice;
  const chosen = chosenOn(row);
  if (chosen !== undefined) {
    const earlier = readTaskChoice(row.metadata);
    if (earlier === null || earlier.option !== operation.option || !sameActor(earlier.by, actor)) return refuse({ kind: 'chosen', chosen });
    pick = earlier;
    const commented = rowsOf(comments).some(entry => sameActor(stringOf(entry.author), actor) && entry.text === choiceComment(earlier));
    if (closed || !decision && commented && !labelsOf(row).includes('human')) return refuse({ kind: 'chosen', chosen });
    if (!commented) steps.push(Object.freeze({ kind: 'comment' as const, taskId, text: choiceComment(earlier) }));
  } else {
    if (closed) refuse({ kind: 'closed' });
    const choices = readTaskChoices(row.metadata);
    if (choices === null) return refuse({ kind: 'no-choices' });
    const option = choices.options.find(entry => entry.key === operation.option);
    if (option === undefined) return refuse({ kind: 'no-option', option: operation.option, offered: choices.options.map(entry => entry.key) });
    pick = Object.freeze({ option: option.key, label: option.label, by: actor, at, ...(operation.note === undefined ? {} : { note: operation.note }) });
    steps.push(Object.freeze({ kind: 'record-choice' as const, taskId, choice: pick }),
      Object.freeze({ kind: 'comment' as const, taskId, text: choiceComment(pick) }));
  }
  steps.push(decision ? decisionClose(row, taskId, choiceCloseReason(pick), actor, refuse) : handBack(row, taskId));
  return Object.freeze(steps);
}

/** The steps of a free-text answer on a task that is not a decision: the
 * answer as a comment, then the hand-back to ready work. Null for a decision,
 * which closes on the task client's own response instead. */
export function answerSteps(operation: Extract<HostedTaskOperation, { kind: 'respond' }>, row: Record<string, unknown>): readonly DecisionStep[] | null {
  if (!row || row.id !== operation.taskId) invalid();
  if (row.issue_type === 'decision') return null;
  return Object.freeze([Object.freeze({ kind: 'comment' as const, taskId: operation.taskId, text: answerComment(operation.response) }),
    handBack(row, operation.taskId)]);
}

/** The same short-reply mapping for a Tower answer and an agent's recorded answer. */
export function ownerResponseSteps(operation: Extract<HostedTaskOperation, { kind: 'respond' }>, row: Record<string, unknown>,
  comments: unknown, actor: string, at: string): readonly DecisionStep[] | null {
  const option = replyOption(operation.response, readTaskChoices(row.metadata), operation.taskId);
  return option === null ? answerSteps(operation, row)
    : choiceSteps({ kind: 'choose', taskId: operation.taskId, option }, row, comments, actor, at);
}

/** Task ids as a sentence lists them. */
function inWords(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
/** A refused decision or close as the person who made it reads it on Tasks,
 * or null for a cause this does not name. */
export function decisionRefusal({ taskId: id, reason }: TaskStateRefused): string | null {
  switch (reason.kind) {
    case 'closed': return `${id} is already closed.`;
    case 'held': return `${id} is held by ${reason.holder}, and only its holder closes it.`;
    case 'missing': return `${id} is not a task in ${reason.project.name}.`;
    case 'chosen': return reason.chosen === null ? `${id} already has a choice.` : `${id} already has a choice: ${reason.chosen}.`;
    case 'no-choices': return `${id} offers no options to choose from.`;
    case 'no-option': return `${id} offers ${inWords(reason.offered.map(key => `(${key})`))}, not (${reason.option}).`;
    case 'gate': return `${id} waits on approval ${inWords(reason.gates)}. Approve it first.`;
    case 'children': return `${id} has open tasks under it: ${inWords(reason.children)}.`;
    default: return null;
  }
}

/** Semantic action classification after the same strict command validation.
 * It grants nothing; shared current admission decides who may perform it. */
export function hostedTaskAction(operation: HostedTaskOperation): 'tasks.read' | 'tasks.write' | 'tasks.decide' {
  const plan = command(operation);
  return plan.readOnly ? 'tasks.read' : DECISIONS.includes(plan.kind) ? 'tasks.decide' : 'tasks.write';
}
/** A person's decisions, and the steps one runs as: only a person is admitted to any of them. */
const DECISIONS: readonly string[] = ['respond', 'dismiss', 'resolve-gate', 'choose', 'record-choice', 'hand-back', 'record-maintenance'];

/** No authorization, role/demo policy, environment, IO or runtime executor.
 * Call only after shared named-action admission. Never forward a JSON body's
 * workspace field here; the workspace argument is selected by the server.
 */
export function createHostedTaskPlanner(projects: readonly HostedTaskProject[]): HostedTaskPlanner {
  if (!Array.isArray(projects) || projects.length > HOSTED_TASK_LIMITS.projects) invalid();
  const directory = new Map<string, Map<string, symbol>>();
  const capabilities = new Set<symbol>();
  for (let index = 0; index < projects.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(projects, String(index));
    if (!descriptor || !('value' in descriptor)) invalid();
    const entry = record(descriptor.value as unknown);
    keys(entry, ['workspaceId', 'projectId', 'capability']);
    const owner = workspace(entry.workspaceId), id = project(entry.projectId);
    if (typeof entry.capability !== 'symbol' || capabilities.has(entry.capability)) invalid();
    const owned = directory.get(owner) ?? new Map<string, symbol>();
    if (owned.has(id)) invalid();
    owned.set(id, entry.capability); capabilities.add(entry.capability); directory.set(owner, owned);
  }
  return (serverSelectedWorkspaceId, request) => {
    const owner = workspace(serverSelectedWorkspaceId);
    const input = record(request);
    keys(input, ['projectId', 'operation']);
    const capability = directory.get(owner)?.get(project(input.projectId));
    if (capability === undefined) invalid();
    return Object.freeze({ capability, ...command(input.operation) });
  };
}
