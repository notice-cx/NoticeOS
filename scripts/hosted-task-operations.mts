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
import type { WorkspaceAdmission, WorkspaceContext } from './workspace-admission.mjs';
import type { HostedTaskExecutor } from './hosted-task-executor.mjs';
import { hostedTaskAction, type HostedTaskOperation, type HostedTaskRequest, type HostedTaskStatus } from './hosted-task-command.mjs';
import { toLiveTask, toComment, toEpic } from './task-row.mjs';

export interface HostedTaskOperationsOptions {
  readonly admission: WorkspaceAdmission;
  readonly directory: Pick<TaskDirectory, 'catalog'>;
  readonly executor: Pick<HostedTaskExecutor, 'execute'>;
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
  board(proof: Request, workspaceId: string, projectId: string, statuses: readonly HostedTaskStatus[]): Promise<Record<string, unknown>>;
  task(proof: Request, workspaceId: string, projectId: string, taskId: string): Promise<Record<string, unknown>>;
  history(proof: Request, workspaceId: string, projectId: string, taskId: string, limit: number): Promise<unknown>;
  write(proof: Request, workspaceId: string, request: HostedTaskRequest, idempotencyKey?: string): Promise<HostedTaskWriteOutcome>;
}
/** A write's key cannot be honored on this server: no receipt store is configured. */
export class HostedTaskReceiptsUnavailable extends Error {
  override name = 'HostedTaskReceiptsUnavailable';
  constructor() { super('Retry-safe task writes are unavailable.'); }
}

export const EDITABLE_TASK_FIELDS = Object.freeze(['status', 'priority', 'title', 'description', 'claim', 'assignee',
  'parent', 'defer', 'acceptance', 'addLabels', 'removeLabels']);
const STATUSES: readonly HostedTaskStatus[] = ['open', 'in_progress', 'blocked', 'deferred', 'closed'];
const ACTIVE = Object.freeze(['open', 'in_progress', 'blocked', 'deferred'] as const);
const RECEIPTED: readonly string[] = ['create', 'update', 'comment', 'close'];
const TASK_ID = /^[a-z0-9]+-{1,2}[a-z0-9]+(?:\.[0-9]+)*$/iu;
const DAY_MS = 86_400_000;
function invalid(): never { throw new Error('Hosted task operation refused'); }
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

export function createHostedTaskOperations(options: HostedTaskOperationsOptions): HostedTaskOperations {
  const { directory, executor, workspaceActors, receipts } = options;
  const admission: WorkspaceAdmission = options.admission;
  if (typeof admission?.withAdmission !== 'function' || typeof directory?.catalog !== 'function'
    || typeof executor?.execute !== 'function') invalid();
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
  function selected(catalog: readonly TaskProjectCatalogEntry[], projectId: string): TaskProjectCatalogEntry {
    const project = catalog.find(entry => entry.projectId === projectId);
    if (!project) invalid();
    return project;
  }
  /** One project's reads under one aggregate deadline, as the Tower draws them. */
  function read<T>(proof: Request, workspaceId: string, projectId: string,
    work: (project: TaskProjectCatalogEntry, run: (operation: HostedTaskOperation) => Promise<unknown>,
      readAt: string, actors: () => Promise<readonly WorkspaceActor[]>) => Promise<T>): Promise<T> {
    return admitted(proof, workspaceId, 'tasks.read', async (context, catalog) => {
      const project = selected(catalog, projectId);
      const readAt = new Date(now()).toISOString(), deadline = now() + 30000;
      const controls = Object.freeze({ deadline, signal: proof.signal });
      return work(project, operation => executor.execute(proof, workspaceId, { projectId, operation }, controls), readAt, async () => {
        // Names are presentation only. An unavailable roster does not invent a
        // name or stop the underlying task read; hosted UUIDs remain unknown.
        let actors: readonly WorkspaceActor[] = [];
        try { actors = await workspaceActors?.(workspaceId) ?? []; } catch { /* Unknown is an honest display state. */ }
        admission.assertContext(context, 'tasks.read');
        return actors;
      });
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
   * Only create and comment would duplicate if repeated; Beads 1.3.1 repeats
   * update, claim (by the same actor) and close without a second effect. */
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
    return undefined;
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
    board(proof, workspaceId, projectId, statuses) {
      if (!Array.isArray(statuses) || statuses.length < 1 || statuses.length > 5 || new Set(statuses).size !== statuses.length
        || statuses.some(status => !STATUSES.includes(status))) invalid();
      return read(proof, workspaceId, projectId, async (project, run, readAt, actorsOf) => {
        const actors = await actorsOf();
        const ready = new Set(rows(await run({ kind: 'ready' })).map(row => record(row).id).filter((id): id is string => typeof id === 'string'));
        const closedSince = new Date(Date.parse(readAt) - 7 * DAY_MS).toISOString().slice(0, 10);
        const tasks = new Map<string, ReturnType<typeof toLiveTask>>();
        const active = statuses.filter((status): status is Exclude<HostedTaskStatus, 'closed'> => status !== 'closed');
        for (const row of active.length ? rows(await run({ kind: 'active-board', statuses: active })) : []) {
          const task = toLiveTask(row, ready); if (!task.id) invalid(); tasks.set(task.id, task);
        }
        if (statuses.includes('closed')) for (const row of rows(await run({ kind: 'closed-board', since: closedSince, until: readAt }))) {
          const task = toLiveTask(row, ready); if (!task.id) invalid();
          if (task.status === 'closed' && task.closedAt !== null && task.closedAt >= `${closedSince}T00:00:00.000Z` && task.closedAt <= readAt) tasks.set(task.id, task);
        }
        let epics = null;
        try { epics = rows(await run({ kind: 'epics' })).map(toEpic).filter(value => value !== null); } catch { /* Unknown stays null; never invent progress. */ }
        return { project: project.logicalKey, prefix: project.prefix, repo: '', readAt, closedSince, tasks: [...tasks.values()], epics, actors };
      });
    },
    task(proof, workspaceId, projectId, taskId) {
      return read(proof, workspaceId, projectId, async (project, run, readAt, actorsOf) => {
        const actors = await actorsOf();
        const ready = new Set(rows(await run({ kind: 'ready' })).map(row => record(row).id).filter((id): id is string => typeof id === 'string'));
        const shown = await run({ kind: 'show', taskId });
        const task = toLiveTask(Array.isArray(shown) ? shown[0] : shown, ready);
        if (task.id !== taskId) invalid();
        const comments = rows(await run({ kind: 'comments', taskId })).map(toComment);
        return { project: project.logicalKey, prefix: project.prefix, repo: '', readAt, task, comments, actors };
      });
    },
    history(proof, workspaceId, projectId, taskId, limit) {
      return read(proof, workspaceId, projectId, async (_project, run, _readAt, actorsOf) => {
        await actorsOf();
        return run({ kind: 'history', taskId, limit });
      });
    },
    async write(proof, workspaceId, request, idempotencyKey) {
      // The planner's grammar validates the operation and names its action.
      const action = hostedTaskAction(request.operation);
      const kind = request.operation.kind;
      if (kind === 'create' && Object.hasOwn(request.operation, 'operationId')) invalid();
      if (idempotencyKey !== undefined) {
        if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey) || !RECEIPTED.includes(kind)) invalid();
        if (!receipts) throw new HostedTaskReceiptsUnavailable();
      }
      return admitted(proof, workspaceId, action, async (context, catalog): Promise<HostedTaskWriteOutcome> => {
        const project = selected(catalog, request.projectId);
        const answer = (value: unknown) => kind === 'create' ? created(value, project) : value;
        if (idempotencyKey === undefined || !receipts) {
          return { status: 'done', value: answer(await executor.execute(proof, workspaceId, request)), replayed: false };
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
        const effect: HostedTaskRequest = kind === 'create'
          ? Object.freeze({ projectId: request.projectId, operation: Object.freeze({ ...request.operation, operationId: receipt.operationId }) })
          : request;
        let value: unknown;
        try {
          value = answer(await executor.execute(proof, workspaceId, effect));
        } catch (error) {
          // The effect may or may not have happened; the next retry checks.
          try { await receipts.interrupt(workspaceId, identity, receipt); } catch { /* Stays pending until the window passes. */ }
          throw error;
        }
        const kept = recordable(value, request);
        // The effect happened; a lost record is reconciled by the next retry.
        try { await receipts.finish(workspaceId, identity, receipt, kept); } catch { /* See above. */ }
        return { status: 'done', value, replayed: false };
      });
    },
  } satisfies HostedTaskOperations);
}
