/** Tower-compatible Tasks API in the trusted Node server. The private directory
 * supplies selectors, not authorization; every child command independently
 * reloads current session, workspace and physical mapping before dispatch.
 * Reads and writes are the shared hosted task operations the MCP endpoint
 * also uses (hosted-task-operations); this file is the HTTP wire format.
 */
import type { TaskDirectory } from '../packages/postgres/src/task-directory.mjs';
import type { TaskReceipts } from '../packages/postgres/src/task-receipts.mjs';
import type { WorkspaceAdmission } from './workspace-admission.mjs';
import type { HostedTaskExecutor } from './hosted-task-executor.mjs';
import type { HostedTaskStatus, HostedTaskRequest } from './hosted-task-command.mjs';
import { readHostedTaskCommand } from './hosted-task-http.mjs';
import { createBrowserRequestPolicy, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { createHostedTaskOperations, HostedTaskReceiptsUnavailable, type HostedTaskWriteOutcome } from './hosted-task-operations.mjs';
import { IDEMPOTENCY_KEY } from '../packages/postgres/src/task-receipts.mjs';
import type { WorkspaceActor } from '../packages/postgres/src/identity.mjs';

export interface HostedTasksApiOptions {
  readonly profile: 'hosted' | 'demo';
  readonly trustedOrigin: string;
  readonly demoWorkspaceId?: string;
  readonly admission: WorkspaceAdmission;
  readonly directory: Pick<TaskDirectory, 'catalog'>;
  readonly executor: Pick<HostedTaskExecutor, 'execute'>;
  readonly workspaceActors?: (workspaceId: string) => Promise<readonly WorkspaceActor[]>;
  /** Retry-safe writes; absent, a request carrying Idempotency-Key answers 503. */
  readonly receipts?: TaskReceipts;
}
/** A write's optional retry key (epic ro-cvl9); see docs/23 for its semantics. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const STATUSES: readonly HostedTaskStatus[] = ['open', 'in_progress', 'blocked', 'deferred', 'closed'];
function invalid(): never { throw new Error('Hosted Tasks request refused'); }
function response(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}
function selections(url: URL, allowed: readonly string[]): Record<string, string> {
  const value: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, entry] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(value, key)) invalid(); value[key] = entry;
  }
  return value;
}
/** The HTTP answer to a write outcome; the MCP adapter answers the same three. */
export function writeResponse(outcome: HostedTaskWriteOutcome): Response {
  if (outcome.status === 'pending') return response(409, { error: 'operation_pending' });
  if (outcome.status === 'conflict') return response(409, { error: 'idempotency_conflict' });
  return response(200, outcome.value);
}

export function createHostedTasksApi(options: HostedTasksApiOptions): (original: Request) => Promise<Response> {
  const origin = createBrowserRequestPolicy(options.trustedOrigin).origin;
  const { profile, directory, executor, workspaceActors, receipts } = options;
  const admission: WorkspaceAdmission = options.admission;
  if (!['hosted', 'demo'].includes(profile) || typeof admission?.withAdmission !== 'function'
    || typeof directory?.catalog !== 'function' || typeof executor?.execute !== 'function') invalid();
  const demo = profile === 'demo' && typeof options.demoWorkspaceId === 'string' && UUID.test(options.demoWorkspaceId)
    ? options.demoWorkspaceId : undefined;
  if (profile === 'demo' && !demo || profile === 'hosted' && options.demoWorkspaceId !== undefined) invalid();
  const operations = createHostedTaskOperations({ admission, directory, executor,
    ...(workspaceActors ? { workspaceActors } : {}), ...(receipts ? { receipts } : {}) });
  return async original => {
    let url: URL, workspace: string;
    let proof: Request;
    let mutation: HostedTaskRequest | undefined, key: string | undefined;
    let query: Record<string, string> | undefined, statuses: HostedTaskStatus[] | undefined;
    try {
      if (!(original instanceof Request)) invalid();
      url = new URL(original.url);
      if (url.origin !== origin || url.hash || url.username || url.password) invalid();
      proof = new Request(original.url, { method: original.method, headers: new Headers(original.headers), signal: original.signal });
      const header = original.headers.get(WORKSPACE_SELECTION_HEADER);
      workspace = profile === 'demo' ? demo! : header ?? '';
      if (!UUID.test(workspace) || profile === 'demo' && header !== null && header !== demo) invalid();
      const path = url.pathname;
      if (!/^\/api\/tasks(?:\/(?:projects|capabilities|[a-z0-9]+-{1,2}[a-z0-9]+(?:\.[0-9]+)*(?:\/(?:history|comments|close|respond|dismiss))?))?$/iu.test(path)
        && !/^\/api\/gates\/[a-z0-9]+-{1,2}[a-z0-9]+(?:\.[0-9]+)*\/resolve$/iu.test(path)) invalid();
      if (original.method === 'GET' && original.body !== null) invalid();
      const supplied = original.headers.get(IDEMPOTENCY_HEADER);
      if (supplied !== null && (original.method === 'GET' || !IDEMPOTENCY_KEY.test(supplied))) invalid();
      if (path === '/api/tasks/projects' || path === '/api/tasks/capabilities') {
        if (original.method !== 'GET' || url.search !== '') invalid();
      } else if (original.method !== 'GET') {
        mutation = await readHostedTaskCommand(original, url, workspace);
        if (supplied !== null && !['create', 'update', 'comment', 'close'].includes(mutation.operation.kind)) invalid();
        key = supplied ?? undefined;
      } else {
        const match = /^\/api\/tasks(?:\/([a-z0-9]+-{1,2}[a-z0-9]+(?:\.[0-9]+)*)(?:\/(history))?)?$/iu.exec(path);
        if (!match) invalid();
        query = selections(url, match[1] ? match[2] ? ['project', 'limit'] : ['project'] : ['project', 'status']);
        if (!query.project || !UUID.test(query.project)) invalid();
        if (match[2] && query.limit !== undefined && (!/^[1-9]\d{0,2}$/u.test(query.limit) || Number(query.limit) > 200)) invalid();
        if (!match[1]) {
          const selectedStatuses = query.status === undefined ? [...STATUSES] : query.status.split(',');
          if (selectedStatuses.length < 1 || selectedStatuses.length > 5 || new Set(selectedStatuses).size !== selectedStatuses.length
            || selectedStatuses.some(status => !STATUSES.includes(status as HostedTaskStatus))) invalid();
          statuses = selectedStatuses as HostedTaskStatus[];
        }
      }
    } catch { return response(400, { error: 'invalid_hosted_task_request' }); }
    try {
      if (url.pathname === '/api/tasks/projects') return response(200, { projects: await operations.projects(proof, workspace) });
      if (url.pathname === '/api/tasks/capabilities') return response(200, await operations.capabilities(proof, workspace));
      // Parsing consumed the original stream once before admission; neither a
      // body tee nor a caller-supplied command/context is forwarded.
      if (mutation) return writeResponse(await operations.write(proof, workspace, mutation, key));
      const match = /^\/api\/tasks(?:\/([a-z0-9]+-{1,2}[a-z0-9]+(?:\.[0-9]+)*)(?:\/(history))?)?$/iu.exec(url.pathname);
      if (!match || !query) invalid();
      const taskId = match[1], history = match[2];
      if (history) return response(200, await operations.history(proof, workspace, query.project!, taskId!, query.limit ? Number(query.limit) : 100));
      if (taskId) return response(200, await operations.task(proof, workspace, query.project!, taskId));
      if (!statuses) invalid();
      return response(200, await operations.board(proof, workspace, query.project!, statuses));
    } catch (error) {
      if (error instanceof HostedTaskReceiptsUnavailable) return response(503, { error: 'idempotency_unavailable' });
      return response(403, { error: 'hosted_task_refused' });
    }
  };
}
