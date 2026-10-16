/** Hosted task operations shared by the Tasks HTTP API and the MCP endpoint.
 * Each adapter parses its own wire format into these calls;
 * admission, project selection, the read compositions and retry-safe writes
 * live here once, so the two surfaces cannot drift. The executor still
 * re-admits and re-resolves the project before every command.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { TaskDirectory, TaskProjectCatalogEntry } from '../packages/postgres/src/task-directory.mjs';
import { IDEMPOTENCY_KEY, TASK_RECEIPT_RESULT_BYTES, type TaskReceipt, type TaskReceiptIdentity,
  type TaskReceipts } from '../packages/postgres/src/task-receipts.mjs';
import type { WorkspaceActor } from '../packages/postgres/src/identity.mjs';
import { taskMetadataValue } from '../packages/contract/src/task-metadata.mjs';
import { gateReason } from '../packages/contract/src/task-gate.mjs';
import { AdmissionRefused, type WorkspaceAdmission, type WorkspaceContext } from './workspace-admission.mjs';
import { hostedTaskAction, HumanDecisionRefused, refusalFromState, TaskStateRefused, type HostedTaskOperation, type HostedTaskRequest,
  type HostedTaskStatus, type TaskProjectName } from './hosted-task-command.mjs';
import { toLiveTask, toComment, toEpic } from './task-row.mjs';

/** Runs one task operation in the server-selected workspace (hosted-task-executor, standalone-tasks). */
export interface TaskOperationExecutor {
  execute(proof: Request, workspaceId: string, request: HostedTaskRequest,
    controls?: { readonly deadline?: number; readonly signal?: AbortSignal }): Promise<unknown>;
  /** One request's reads of one project in one client session. An executor
   * that verifies its client before each command offers this; one that
   * verifies nothing per command leaves it out and runs `execute` per read. */
  reads?<T>(proof: Request, workspaceId: string, projectId: string,
    work: (run: (operation: HostedTaskOperation) => Promise<unknown>) => Promise<T>,
    controls?: { readonly deadline?: number; readonly signal?: AbortSignal }): Promise<T>;
}
export interface HostedTaskOperationsOptions {
  readonly admission: WorkspaceAdmission;
  /** `formerly`, where a directory has it, names the project an id it no longer holds once named. */
  readonly directory: Pick<TaskDirectory, 'catalog'> & {
    readonly formerly?: (workspaceId: string, projectId: string) => Promise<TaskProjectCatalogEntry | null>;
  };
  readonly executor: TaskOperationExecutor;
  readonly workspaceActors?: (workspaceId: string) => Promise<readonly WorkspaceActor[]>;
  /** Absent: a write that carries an idempotency key is refused as unavailable. */
  readonly receipts?: TaskReceipts;
  /** How long an unfinished attempt is presumed still running (default 5 minutes:
   * the executor's 30-second budget plus room for an orphaned child). */
  readonly pendingMs?: number;
  readonly now?: () => number;
}
export type HostedTaskWriteOutcome =
  | { readonly status: 'done'; readonly value: unknown; readonly replayed: boolean }
  /** An attempt may still be running, or its outcome could not be established. */
  | { readonly status: 'pending' }
  /** The key was first used with another project or request. */
  | { readonly status: 'conflict' };
export interface HostedTaskCapabilities {
  readonly live: true;
  readonly writable: boolean;
  readonly projectSelection: true;
  readonly operations: readonly string[];
  readonly editableFields: readonly string[];
}
export interface HostedTaskOperations {
  projects(proof: Request, workspaceId: string): Promise<readonly TaskProjectCatalogEntry[]>;
  capabilities(proof: Request, workspaceId: string): Promise<HostedTaskCapabilities>;
  /** `closedDays` widens the closed read from the board's week to the Agents page's history. */
  board(proof: Request, workspaceId: string, projectId: string, statuses: readonly HostedTaskStatus[], closedDays?: number): Promise<Record<string, unknown>>;
  task(proof: Request, workspaceId: string, projectId: string, taskId: string): Promise<Record<string, unknown>>;
  history(proof: Request, workspaceId: string, projectId: string, taskId: string, limit: number): Promise<unknown>;
  write(proof: Request, workspaceId: string, request: HostedTaskRequest, idempotencyKey?: string): Promise<HostedTaskWriteOutcome>;
  /** Opens a human gate the task waits on, or returns the open one already
   * asking the same thing, so a retried request never asks a person twice. */
  approval(proof: Request, workspaceId: string, projectId: string, taskId: string, reason: string):
    Promise<{ readonly gate: Record<string, unknown>; readonly created: boolean }>;
  /** The sections each task's type expects that it still lacks, as Beads' lint names them, by task id. */
  lint(proof: Request, workspaceId: string, projectId: string, taskIds: readonly string[]): Promise<ReadonlyMap<string, readonly string[]>>;
}
/** A write's key cannot be honored on this server: no receipt store is configured. */
export class HostedTaskReceiptsUnavailable extends Error {
  override name = 'HostedTaskReceiptsUnavailable';
  constructor() { super('Retry-safe task writes are unavailable.'); }
}
/** A call naming a projectId this workspace's catalog does not hold
 * (`project` null), or a task whose prefix another of its projects owns.
 * `owner` is the project that owns the task's prefix, when one does. Thrown
 * after admission, from the catalog list_projects shows the caller. */
export class TaskProjectRefused extends Error {
  override name = 'TaskProjectRefused';
  constructor(readonly projectId: string, readonly taskId: string | null, readonly project: TaskProjectName | null,
    readonly owner: TaskProjectName | null) { super('Task project refused.'); }
}

export const EDITABLE_TASK_FIELDS = Object.freeze(['status', 'priority', 'title', 'description', 'claim', 'assignee',
  'parent', 'defer', 'acceptance', 'addLabels', 'removeLabels']);
const STATUSES: readonly HostedTaskStatus[] = ['open', 'in_progress', 'blocked', 'deferred', 'closed'];
const ACTIVE = Object.freeze(['open', 'in_progress', 'blocked', 'deferred'] as const);
const RECEIPTED: readonly string[] = ['create', 'update', 'comment', 'close'];
const TASK_ID = /^[a-z0-9]+-{1,2}[a-z0-9]+(?:\.[0-9]+)*$/iu;
const DAY_MS = 86_400_000;
/** The board's closed week, and the longest history a closed read may ask for. */
export const CLOSED_DAYS = 7;
export const CLOSED_HISTORY_DAYS = 56;
function invalid(): never { throw new Error('Hosted task operation refused'); }
/** The task ids a write names, which a refusal checks the project for. */
function tasksNamed(operation: HostedTaskOperation): string[] {
  const ids = operation.kind === 'create' ? [operation.parent, ...(operation.links ?? []).map(link => link.taskId)]
    : operation.kind === 'update' ? [operation.taskId, operation.parent]
    : operation.kind === 'depend' || operation.kind === 'undepend' ? [operation.taskId, operation.dependsOn]
    : 'taskId' in operation ? [operation.taskId] : [];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
}
/** A catalog entry as a refusal names it. */
function named(entry: TaskProjectCatalogEntry): TaskProjectName {
  return Object.freeze({ projectId: entry.projectId, name: entry.displayName, prefix: entry.prefix });
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid(); return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
/** Canonical JSON: object keys sorted, so a request hashes the same however
 * its adapter happened to order fields. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Who closed a task, written onto it after its close: the task client keeps
 * no closer. The close stands whether or not this lands; a task without it
 * shows its close and no closer. `closeOutput` is the close's own answer. */
export async function recordCloser(run: (operation: HostedTaskOperation) => Promise<unknown>, taskId: string,
  closeOutput: unknown, closedBy: string, model?: string): Promise<void> {
  try {
    const closedAt = (found: unknown) => {
      const row = (Array.isArray(found) ? found : [found]).map(entry => entry && typeof entry === 'object' ? entry as Record<string, unknown> : {})
        .find(entry => entry.id === taskId);
      return row?.status === 'closed' && typeof row.closed_at === 'string' ? row.closed_at : null;
    };
    const at = closedAt(closeOutput) ?? closedAt(await run({ kind: 'show', taskId }));
    if (at === null) return;
    await run(Object.freeze({ kind: 'attribute', taskId, closedBy, closedAt: at, ...(model === undefined ? {} : { model }) }));
  } catch { /* The close itself is the outcome; its closer stays unrecorded. */ }
}

export function createHostedTaskOperations(options: HostedTaskOperationsOptions): HostedTaskOperations {
  const { directory, executor, workspaceActors, receipts } = options;
  const admission: WorkspaceAdmission = options.admission;
  if (typeof admission?.withAdmission !== 'function' || typeof directory?.catalog !== 'function'
    || directory.formerly !== undefined && typeof directory.formerly !== 'function'
    || typeof executor?.execute !== 'function' || executor.reads !== undefined && typeof executor.reads !== 'function') invalid();
  const now = options.now ?? Date.now;
  const pendingMs = options.pendingMs ?? 5 * 60_000;
  if (!Number.isFinite(pendingMs) || pendingMs < 30_000) invalid();

  /** Current admission for one named action, then this workspace's catalog. */
  function admitted<T>(proof: Request, workspaceId: string, action: Parameters<WorkspaceAdmission['withAdmission']>[0],
    work: (context: WorkspaceContext, catalog: readonly TaskProjectCatalogEntry[]) => Promise<T>): Promise<T> {
    return admission.withAdmission(action, { requestedWorkspaceId: workspaceId, correlationId: 'hosted-tasks' }, proof, async context => {
      const catalog = await directory.catalog(workspaceId);
      admission.assertContext(context, action);
      return work(context, catalog);
    });
  }
  /** The project a call names. A task id it names must not carry another
   * project's prefix: that call meant the other project. */
  async function selected(workspaceId: string, catalog: readonly TaskProjectCatalogEntry[], projectId: string,
    taskId?: string): Promise<TaskProjectCatalogEntry> {
    const project = catalog.find(entry => entry.projectId === projectId);
    const prefix = taskId?.slice(0, taskId.indexOf('-')).toLowerCase();
    const owner = prefix === undefined ? undefined : catalog.find(entry => entry.prefix.toLowerCase() === prefix);
    if (!project) {
      let former: TaskProjectCatalogEntry | null = null;
      // Advice only: a directory that cannot say leaves the refusal without it.
      if (!owner) try { former = await directory.formerly?.(workspaceId, projectId) ?? null; } catch { /* See above. */ }
      const holder = owner ?? former;
      throw new TaskProjectRefused(projectId, taskId ?? null, null, holder ? named(holder) : null);
    }
    if (owner && owner.projectId !== project.projectId && project.prefix.toLowerCase() !== prefix) {
      throw new TaskProjectRefused(projectId, taskId!, named(project), named(owner));
    }
    return project;
  }
  /** Names a refused call's cause when the store shows one: a task it names
   * is not in the project, or, for a write, its task as it stands now breaks
   * a rule the write is held to. Any other failure stands as it was. */
  async function explained<T>(proof: Request, workspaceId: string, projectId: string, taskIds: readonly string[],
    work: () => Promise<T>, operation?: HostedTaskOperation): Promise<T> {
    try { return await work(); } catch (error) {
      if (!taskIds.length || [AdmissionRefused, HumanDecisionRefused, TaskStateRefused, TaskProjectRefused,
        HostedTaskReceiptsUnavailable].some(kind => error instanceof kind)) throw error;
      let cause: TaskStateRefused | null = null;
      try {
        cause = await admitted(proof, workspaceId, 'tasks.read', async (context, catalog) => {
          const project = await selected(workspaceId, catalog, projectId);
          const read = (step: HostedTaskOperation) => executor.execute(proof, workspaceId, { projectId, operation: step });
          const found = new Set(rows(await read({ kind: 'find', taskIds })).map(row => record(row).id));
          const absent = taskIds.find(id => !found.has(id));
          if (absent !== undefined) return new TaskStateRefused(absent, 'other', { kind: 'missing', project: named(project) });
          if (operation === undefined || !('taskId' in operation)) return null;
          // Read after the refusal, so it sees whatever another caller wrote first.
          const shown = await read({ kind: 'show', taskId: operation.taskId });
          return refusalFromState(operation, record(Array.isArray(shown) ? shown[0] : shown), context.principalId);
        });
      } catch { /* The diagnosis is advice; the call's own failure stands. */ }
      throw cause ?? error;
    }
  }
  /** One project's reads under one aggregate deadline, as the Tower draws them. */
  function read<T>(proof: Request, workspaceId: string, projectId: string,
    work: (project: TaskProjectCatalogEntry, run: (operation: HostedTaskOperation) => Promise<unknown>,
      readAt: string, actors: () => Promise<readonly WorkspaceActor[]>) => Promise<T>, taskId?: string): Promise<T> {
    return admitted(proof, workspaceId, 'tasks.read', async (context, catalog) => {
      const project = await selected(workspaceId, catalog, projectId, taskId);
      const readAt = new Date(now()).toISOString(), deadline = now() + 30000;
      const controls = Object.freeze({ deadline, signal: proof.signal });
      const actorsOf = async () => {
        // Names are presentation only. An unavailable roster does not invent a
        // name or stop the underlying task read; hosted UUIDs remain unknown.
        let actors: readonly WorkspaceActor[] = [];
        try { actors = await workspaceActors?.(workspaceId) ?? []; } catch { /* Unknown is an honest display state. */ }
        admission.assertContext(context, 'tasks.read');
        return actors;
      };
      if (executor.reads) return executor.reads(proof, workspaceId, projectId, run => work(project, run, readAt, actorsOf), controls);
      return work(project, operation => executor.execute(proof, workspaceId, { projectId, operation }, controls), readAt, actorsOf);
    });
  }
  /** A created task as both adapters answer it. */
  function created(value: unknown, project: TaskProjectCatalogEntry): { readonly id: string; readonly project: string } {
    const row = record(Array.isArray(value) ? value[0] : value);
    if (typeof row.id !== 'string' || !TASK_ID.test(row.id)) invalid();
    return Object.freeze({ id: row.id, project: project.logicalKey });
  }
  /** What a receipt keeps: the answer itself when it fits, else the task id. */
  function recordable(value: unknown, request: HostedTaskRequest): unknown {
    const text = JSON.stringify(value);
    if (typeof text === 'string' && new TextEncoder().encode(text).byteLength <= TASK_RECEIPT_RESULT_BYTES) return value;
    return { id: 'taskId' in request.operation ? request.operation.taskId : null, truncated: true };
  }
  /** Task evidence that an earlier attempt already took effect, or undefined.
   * Create and comment would duplicate if repeated, and a close is refused
   * once its task is closed; Beads 1.3.1 repeats update and claim (by the same
   * actor) without a second effect. */
  async function evidence(proof: Request, workspaceId: string, request: HostedTaskRequest, project: TaskProjectCatalogEntry,
    receipt: TaskReceipt, principalId: string): Promise<unknown> {
    const operation = request.operation;
    const controls = Object.freeze({ deadline: now() + 30000, signal: proof.signal });
    const run = (read: HostedTaskOperation) => executor.execute(proof, workspaceId, { projectId: request.projectId, operation: read }, controls);
    if (operation.kind === 'create') {
      const found = [...rows(await run({ kind: 'active-board', statuses: ACTIVE }))];
      const since = new Date(Date.parse(receipt.createdAt) - DAY_MS).toISOString().slice(0, 10);
      const until = new Date(now()).toISOString();
      if (Date.parse(until) - Date.parse(since) <= 8 * DAY_MS) found.push(...rows(await run({ kind: 'closed-board', since, until })));
      const matches = found.filter(row => taskMetadataValue(record(row).metadata, 'operation') === receipt.operationId);
      if (matches.length > 1) invalid();
      return matches.length ? created(matches[0], project) : undefined;
    }
    if (operation.kind === 'comment') {
      // Beads keeps comment times to the second.
      const floor = Math.floor(Date.parse(receipt.createdAt) / 1000) * 1000;
      const match = rows(await run({ kind: 'comments', taskId: operation.taskId })).map(record)
        .find(row => row.author === principalId && row.text === operation.text
          && typeof row.created_at === 'string' && Date.parse(row.created_at) >= floor);
      return match;
    }
    if (operation.kind === 'close') {
      const shown = await run({ kind: 'show', taskId: operation.taskId });
      const row = record(Array.isArray(shown) ? shown[0] : shown);
      return row.id === operation.taskId && row.status === 'closed' && row.close_reason === operation.reason ? [row] : undefined;
    }
    return undefined;
  }

  async function attribute(proof: Request, workspaceId: string, request: HostedTaskRequest, value: unknown, principalId: string): Promise<void> {
    const operation = request.operation;
    if (operation.kind !== 'close') return;
    await recordCloser(step => executor.execute(proof, workspaceId, { projectId: request.projectId, operation: step }),
      operation.taskId, value, principalId, operation.model);
  }

  return Object.freeze({
    projects(proof, workspaceId) {
      return admitted(proof, workspaceId, 'tasks.read', async (_context, catalog) => catalog);
    },
    capabilities(proof, workspaceId) {
      return admitted(proof, workspaceId, 'tasks.read', async context => Object.freeze({
        live: true as const, writable: context.allowedActions.includes('tasks.write'), projectSelection: true as const,
        operations: Object.freeze(['create', 'update', 'comment', 'close',
          ...(context.allowedActions.includes('tasks.decide') ? ['respond', 'dismiss', 'resolve'] : [])]),
        editableFields: EDITABLE_TASK_FIELDS,
      }));
    },
    board(proof, workspaceId, projectId, statuses, closedDays = CLOSED_DAYS) {
      if (!Array.isArray(statuses) || statuses.length < 1 || statuses.length > 5 || new Set(statuses).size !== statuses.length
        || statuses.some(status => !STATUSES.includes(status))) invalid();
      if (!Number.isInteger(closedDays) || closedDays < 1 || closedDays > CLOSED_HISTORY_DAYS) invalid();
      return read(proof, workspaceId, projectId, async (project, run, readAt, actorsOf) => {
        const actors = await actorsOf();
        const active = statuses.filter((status): status is Exclude<HostedTaskStatus, 'closed'> => status !== 'closed');
        // A closed task is never ready, so a closed-only read skips the ready list.
        const ready = new Set(active.length === 0 ? [] : rows(await run({ kind: 'ready' })).map(row => record(row).id)
          .filter((id): id is string => typeof id === 'string'));
        const closedSince = new Date(Date.parse(readAt) - closedDays * DAY_MS).toISOString().slice(0, 10);
        const tasks = new Map<string, ReturnType<typeof toLiveTask>>();
        for (const row of active.length ? rows(await run({ kind: 'active-board', statuses: active })) : []) {
          const task = toLiveTask(row, ready); if (!task.id) invalid(); tasks.set(task.id, task);
        }
        if (statuses.includes('closed')) for (const row of rows(await run({ kind: 'closed-board', since: closedSince, until: readAt }))) {
          const task = toLiveTask(row, ready); if (!task.id) invalid();
          if (task.status === 'closed' && task.closedAt !== null && task.closedAt >= `${closedSince}T00:00:00.000Z` && task.closedAt <= readAt) tasks.set(task.id, task);
        }
        let epics = null;
        if (active.length) try { epics = rows(await run({ kind: 'epics' })).map(toEpic).filter(value => value !== null); } catch { /* Unknown stays null; never invent progress. */ }
        return { project: project.logicalKey, prefix: project.prefix, repo: '', readAt, closedSince, tasks: [...tasks.values()], epics, actors };
      });
    },
    task(proof, workspaceId, projectId, taskId) {
      return explained(proof, workspaceId, projectId, [taskId], () => read(proof, workspaceId, projectId, async (project, run, readAt, actorsOf) => {
        const actors = await actorsOf();
        const ready = new Set(rows(await run({ kind: 'ready' })).map(row => record(row).id).filter((id): id is string => typeof id === 'string'));
        const shown = await run({ kind: 'show', taskId });
        const task = toLiveTask(Array.isArray(shown) ? shown[0] : shown, ready);
        if (task.id !== taskId) invalid();
        const comments = rows(await run({ kind: 'comments', taskId })).map(toComment);
        return { project: project.logicalKey, prefix: project.prefix, repo: '', readAt, task, comments, actors };
      }, taskId));
    },
    history(proof, workspaceId, projectId, taskId, limit) {
      return explained(proof, workspaceId, projectId, [taskId], () => read(proof, workspaceId, projectId, async (_project, run, _readAt, actorsOf) => {
        await actorsOf();
        return run({ kind: 'history', taskId, limit });
      }, taskId));
    },
    approval(proof, workspaceId, projectId, taskId, reason) {
      const operation = Object.freeze({ kind: 'gate' as const, taskId, reason });
      hostedTaskAction(operation);
      return explained(proof, workspaceId, projectId, [taskId], () => admitted(proof, workspaceId, 'tasks.write', async (_context, catalog) => {
        await selected(workspaceId, catalog, projectId, taskId);
        const run = (step: HostedTaskOperation) => executor.execute(proof, workspaceId, { projectId, operation: step });
        const shown = await run({ kind: 'show', taskId });
        const task = record(Array.isArray(shown) ? shown[0] : shown);
        if (task.id !== taskId || task.status === 'closed') invalid();
        const asked = gateReason(`Reason: ${reason}`);
        const open = (Array.isArray(task.dependencies) ? task.dependencies : []).map(record).find(edge => edge.issue_type === 'gate'
          && edge.await_type === 'human' && edge.dependency_type === 'blocks' && edge.status !== 'closed' && gateReason(edge.description) === asked);
        if (open) return Object.freeze({ gate: open, created: false });
        const gate = record(await run(operation));
        if (typeof gate.id !== 'string' || !TASK_ID.test(gate.id) || gate.issue_type !== 'gate' || gate.await_type !== 'human') invalid();
        return Object.freeze({ gate, created: true });
      }));
    },
    lint(proof, workspaceId, projectId, taskIds) {
      return read(proof, workspaceId, projectId, async (_project, run) => {
        const report = record(await run({ kind: 'lint', taskIds }));
        // A task with nothing missing is absent from the results, which are then null.
        const missing = new Map<string, readonly string[]>(taskIds.map(id => [id, Object.freeze([])]));
        const seen = new Set<string>();
        for (const row of report.results === null ? [] : rows(report.results).map(record)) {
          if (typeof row.id !== 'string' || !missing.has(row.id)) continue;
          if (seen.has(row.id) || !Array.isArray(row.missing) || row.missing.some(item => typeof item !== 'string')) invalid();
          seen.add(row.id); missing.set(row.id, Object.freeze([...row.missing] as string[]));
        }
        return missing;
      });
    },
    async write(proof, workspaceId, request, idempotencyKey) {
      // The planner's grammar validates the operation and names its action.
      const action = hostedTaskAction(request.operation);
      const kind = request.operation.kind;
      if (kind === 'create' && (Object.hasOwn(request.operation, 'operationId') || Object.hasOwn(request.operation, 'filedBy'))) invalid();
      if (idempotencyKey !== undefined) {
        if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey) || !RECEIPTED.includes(kind)) invalid();
        if (!receipts) throw new HostedTaskReceiptsUnavailable();
      }
      const primary = 'taskId' in request.operation ? request.operation.taskId : undefined;
      return explained(proof, workspaceId, request.projectId, tasksNamed(request.operation),
        () => admitted(proof, workspaceId, action, async (context, catalog): Promise<HostedTaskWriteOutcome> => {
        const project = await selected(workspaceId, catalog, request.projectId, primary);
        const answer = (value: unknown) => kind === 'create' ? created(value, project) : value;
        const effect = async (planned: HostedTaskRequest) => {
          const value = await executor.execute(proof, workspaceId, planned);
          await attribute(proof, workspaceId, planned, value, context.principalId);
          return answer(value);
        };
        // A new task's filer is the admitted actor, as a close's closer is.
        const filed: HostedTaskRequest = kind === 'create'
          ? Object.freeze({ projectId: request.projectId, operation: Object.freeze({ ...request.operation, filedBy: context.principalId }) })
          : request;
        if (idempotencyKey === undefined || !receipts) {
          return { status: 'done', value: await effect(filed), replayed: false };
        }
        const identity: TaskReceiptIdentity = Object.freeze({ principalId: context.principalId,
          operation: kind as TaskReceiptIdentity['operation'], idempotencyKey });
        const requestHash = createHash('sha256').update(`noticeos-task-write-v1:${canonical(request)}`).digest('hex');
        const start = await receipts.start(workspaceId, { ...identity, projectId: request.projectId, requestHash }, randomUUID());
        if (start.kind === 'conflict') return { status: 'conflict' };
        let receipt = start.receipt;
        if (start.kind === 'existing') {
          if (receipt.state === 'succeeded') return { status: 'done', value: receipt.result, replayed: true };
          if (receipt.state === 'pending' && now() - Date.parse(receipt.startedAt) < pendingMs) return { status: 'pending' };
          // The last attempt ended, or was abandoned, without a recorded outcome.
          const found = await evidence(proof, workspaceId, request, project, receipt, context.principalId);
          if (found !== undefined) {
            const value = recordable(found, request);
            return await receipts.finish(workspaceId, identity, receipt, value)
              ? { status: 'done', value, replayed: true } : { status: 'pending' };
          }
          const next = await receipts.retry(workspaceId, identity, { operationId: receipt.operationId, attempt: receipt.attempt,
            state: receipt.state === 'interrupted' ? 'interrupted' : 'pending' });
          if (!next) return { status: 'pending' };
          receipt = next;
        }
        const planned: HostedTaskRequest = kind === 'create'
          ? Object.freeze({ projectId: request.projectId, operation: Object.freeze({ ...filed.operation, operationId: receipt.operationId }) })
          : request;
        let value: unknown;
        try {
          value = await effect(planned);
        } catch (error) {
          // The effect may or may not have happened; the next retry checks.
          try { await receipts.interrupt(workspaceId, identity, receipt); } catch { /* Stays pending until the window passes. */ }
          throw error;
        }
        const kept = recordable(value, request);
        // The effect happened; a lost record is reconciled by the next retry.
        try { await receipts.finish(workspaceId, identity, receipt, kept); } catch { /* See above. */ }
        return { status: 'done', value, replayed: false };
      }), request.operation);
    },
  } satisfies HostedTaskOperations);
}
