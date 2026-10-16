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
      /** Server-only receipt identity (hosted-task-operations); request parsers never set it. */
      readonly operationId?: string }
  | { readonly kind: 'update'; readonly taskId: string; readonly status?: HostedTaskStatus;
      readonly priority?: number; readonly title?: string; readonly description?: string; readonly claim?: true;
      readonly assignee?: string; readonly parent?: string; readonly defer?: string; readonly acceptance?: string;
      readonly addLabels?: readonly string[]; readonly removeLabels?: readonly string[];
      /** With a claim only: the model the claimer names, kept on the task. */
      readonly model?: string }
  | { readonly kind: 'comment'; readonly taskId: string; readonly text: string }
  /** `model` is the closer's, recorded by the attribution that follows the close.
   * `force` closes a task someone else holds; only a workspace service may send
   * it, and request parsers never construct it. */
  | { readonly kind: 'close'; readonly taskId: string; readonly reason: string; readonly model?: string; readonly force?: true }
  /** Server-only: who closed a task, written after its close. Request parsers never construct it. */
  | { readonly kind: 'attribute'; readonly taskId: string; readonly closedBy: string; readonly closedAt: string; readonly model?: string }
  | { readonly kind: 'depend'; readonly taskId: string; readonly dependsOn: string; readonly type: HostedTaskDependencyType }
  | { readonly kind: 'undepend'; readonly taskId: string; readonly dependsOn: string }
  /** Opens a human gate the task waits on. Only a person's resolve-gate clears it. */
  | { readonly kind: 'gate'; readonly taskId: string; readonly reason: string }
  | { readonly kind: 'lint'; readonly taskIds: readonly string[] }
  | { readonly kind: 'respond'; readonly taskId: string; readonly response: string }
  | { readonly kind: 'dismiss'; readonly taskId: string; readonly reason?: string }
  | { readonly kind: 'resolve-gate'; readonly taskId: string; readonly reason?: string };

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
function handoffMetadata(value: unknown): Readonly<Record<string, string>> {
  // What only the server writes is never a caller's metadata.
  const row = record(value); keys(row, [], Object.values(TASK_METADATA).map(field => field.name)
    .filter(name => !SERVER_TASK_METADATA.includes(name)));
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, entry] of Object.entries(row)) result[key] = text(entry, HOSTED_TASK_LIMITS.metadataValue);
  return Object.freeze(result);
}

function command(input: unknown): Pick<HostedTaskPlan, 'kind' | 'readOnly' | 'argv'> {
  const op = record(input);
  const kind = choice(op.kind, ['list', 'show', 'find', 'history', 'comments', 'ready', 'epics', 'active-board', 'closed-board',
    'snapshot', 'lint', 'create', 'update', 'comment', 'close', 'attribute', 'depend', 'undepend', 'gate', 'respond', 'dismiss', 'resolve-gate']) as HostedTaskOperation['kind'];
  const readOnly = ['list', 'show', 'find', 'history', 'comments', 'ready', 'epics', 'active-board', 'closed-board', 'snapshot', 'lint'].includes(kind);
  const argv = ['--sandbox', '--json', ...(readOnly ? ['--readonly'] : [])];
  switch (kind) {
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
      keys(op, ['kind', 'title'], ['description', 'type', 'priority', 'labels', 'parent', 'acceptance', 'metadata', 'links', 'operationId']);
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
      if (Object.hasOwn(op, 'metadata') || Object.hasOwn(op, 'operationId')) {
        const metadata = { ...(Object.hasOwn(op, 'metadata') ? handoffMetadata(op.metadata) : {}),
          ...(Object.hasOwn(op, 'operationId') ? { [TASK_METADATA.operation.name]: uuid(op.operationId) } : {}) };
        argv.push(`--metadata=${JSON.stringify(metadata)}`);
      }
      argv.push(`--title=${text(op.title, HOSTED_TASK_LIMITS.title)}`, '--');
      break;
    case 'update': {
      const fields = ['status', 'priority', 'title', 'description', 'claim', 'assignee', 'parent', 'defer', 'acceptance', 'addLabels', 'removeLabels'];
      keys(op, ['kind', 'taskId'], [...fields, 'model']);
      if (!fields.some(key => Object.hasOwn(op, key)) || Object.hasOwn(op, 'model') && op.claim !== true) invalid();
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
      keys(op, ['kind', 'taskId', 'reason'], ['model', 'force']);
      if (Object.hasOwn(op, 'model')) model(op.model);
      if (Object.hasOwn(op, 'force') && op.force !== true) invalid();
      argv.push('close', `--reason=${text(op.reason, HOSTED_TASK_LIMITS.reason)}`, ...(op.force ? ['--force'] : []), '--', task(op.taskId));
      break;
    case 'attribute': {
      // The task client's close carries no metadata, so the closer follows it.
      keys(op, ['kind', 'taskId', 'closedBy', 'closedAt'], ['model']);
      if (typeof op.closedAt !== 'string' || !Number.isFinite(Date.parse(op.closedAt)) || op.closedAt.length > 64) invalid();
      const metadata = { [TASK_METADATA.closedBy.name]: text(op.closedBy, HOSTED_TASK_LIMITS.identifier),
        [TASK_METADATA.closedAt.name]: op.closedAt,
        ...(Object.hasOwn(op, 'model') ? { [TASK_METADATA.closedModel.name]: model(op.model) } : {}) };
      argv.push('update', `--metadata=${JSON.stringify(metadata)}`, '--', task(op.taskId));
      break;
    }
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
      argv.push('human', 'respond', `--response=${text(op.response, HOSTED_TASK_LIMITS.comment)}`, '--', task(op.taskId));
      break;
    case 'dismiss':
    case 'resolve-gate':
      keys(op, ['kind', 'taskId'], ['reason']);
      argv.push(...(kind === 'dismiss' ? ['human', 'dismiss'] : ['gate', 'resolve']));
      if (Object.hasOwn(op, 'reason')) argv.push(`--reason=${text(op.reason, HOSTED_TASK_LIMITS.reason)}`);
      argv.push('--', task(op.taskId));
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
const BLOCKING: readonly string[] = ['blocks', 'waits-for', 'conditional-blocks'];
function rowsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row)) : [];
}
const stringOf = (value: unknown): string => typeof value === 'string' ? value : '';
/** The task client's actor match: a run of `.`, `_` or `-` is one separator, and `--` another. */
function canonicalActor(name: string): string {
  return name.replace(/[._-]+/gu, run => run === '--' ? '/' : '_');
}
function sameActor(a: string, b: string): boolean { return a === b || canonicalActor(a) === canonicalActor(b); }

/** A write whose own task's state decides how it runs: a close, a claim, a
 * change of assignee. A caller's forced close is a service closing for the
 * agent it named, and decides for itself. */
function stateGuarded(operation: HostedTaskOperation): operation is Extract<HostedTaskOperation, { kind: 'close' | 'update' }> {
  if (operation.kind === 'close') return operation.force !== true;
  return operation.kind === 'update' && (operation.claim === true || operation.assignee !== undefined);
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
  const children = operation.kind === 'close' && stateGuarded(operation) && operation.taskId === taskId;
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
  const attempted: TaskAttempt = operation.kind === 'close' ? 'close' : operation.claim === true ? 'claim' : 'reassign';
  const refuse = (reason: TaskStateReason): never => { throw new TaskStateRefused(operation.taskId, attempted, reason); };
  const status = stringOf(row.status), holder = stringOf(row.assignee);
  const held = holder !== '' && !sameActor(holder, actor);
  const open = (edge: Record<string, unknown>) => stringOf(edge.status) !== 'closed';
  const blockers = rowsOf(row.dependencies).filter(edge => BLOCKING.includes(stringOf(edge.dependency_type)) && open(edge));
  if (operation.kind === 'update') {
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

/** Semantic action classification after the same strict command validation.
 * It grants nothing; shared current admission decides who may perform it. */
export function hostedTaskAction(operation: HostedTaskOperation): 'tasks.read' | 'tasks.write' | 'tasks.decide' {
  const plan = command(operation);
  return plan.readOnly ? 'tasks.read' : ['respond', 'dismiss', 'resolve-gate'].includes(plan.kind) ? 'tasks.decide' : 'tasks.write';
}

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
