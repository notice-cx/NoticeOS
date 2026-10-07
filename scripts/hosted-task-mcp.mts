/** The hosted task MCP endpoint (epic ro-cvl9): the shared MCP transport
 * (mcp-protocol, both protocol eras) over one POST route. Every tool is a shared
 * hosted task operation (hosted-task-operations), the same ones the Tasks HTTP
 * API calls, under the same current admission. Results speak in tasks and
 * comments; storage names and command output never reach a client.
 *
 * Human decisions (respond, dismiss, resolve) are not tools: write access
 * must not give an agent a route to answer its own question. Writes require
 * an idempotency key so an agent can retry an interrupted call safely.
 */
import { createBrowserRequestPolicy, WORKSPACE_SELECTION_HEADER } from './browser-request-policy.mjs';
import { HostedTaskReceiptsUnavailable, type HostedTaskOperations, type HostedTaskWriteOutcome } from './hosted-task-operations.mjs';
import { HOSTED_TASK_LIMITS, type HostedTaskOperation, type HostedTaskStatus, type HostedTaskType } from './hosted-task-command.mjs';
import { McpToolError, serveMcp, type McpServer } from './mcp-protocol.mjs';
import { bearerChallenge, bearerToken, requiredScopes, scopesSatisfy } from './agent-access.mjs';
import { toComment, toLiveTask } from './task-row.mjs';
import { IDEMPOTENCY_KEY } from '../packages/postgres/src/task-receipts.mjs';

export const TASK_MCP_PATH = '/api/tasks/mcp';
const SERVER_INFO = Object.freeze({ name: 'noticeos-tasks', version: '1.0.0' });
const BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const TASK_ID = /^[a-z0-9]+-{1,2}[a-z0-9]+(?:\.[0-9]+)*$/iu;
const STATUSES: readonly HostedTaskStatus[] = ['open', 'in_progress', 'blocked', 'deferred', 'closed'];
const TYPES: readonly HostedTaskType[] = ['task', 'bug', 'feature', 'epic', 'chore'];
const INSTRUCTIONS = 'Tasks in this workspace\'s projects. Start with list_projects. Every change takes an idempotency_key: reuse it when retrying.';

export interface HostedTaskMcpOptions {
  readonly profile: 'hosted' | 'demo';
  readonly trustedOrigin: string;
  readonly demoWorkspaceId?: string;
  readonly operations: HostedTaskOperations;
  /** Agent sign-in (agent-access.mts), hosted only: verifies a bearer
   * request's token for this endpoint. Without it, a bearer request is
   * refused. Admission verifies it again, with fresh membership, per call. */
  readonly agents?: { verify(request: Request): Promise<{ readonly workspaceId: string; readonly scopes: readonly string[] } | null> };
}

function refuse(message: string): never { throw new McpToolError(message); }

// ─── Arguments ────────────────────────────────────────────────────────────────
type Args = Record<string, unknown>;
function only(args: Args, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter(key => !allowed.includes(key));
  if (unknown.length) refuse(`invalid arguments: unknown ${unknown.join(', ')}`);
}
function textArg(args: Args, name: string, max: number, required = true, empty = false): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) refuse(`invalid arguments: ${name}`);
  return value;
}
function project(args: Args): string {
  const value = args.project;
  if (typeof value !== 'string' || !UUID.test(value)) refuse('invalid arguments: project (a projectId from list_projects)');
  return value;
}
function task(args: Args, name = 'task'): string {
  const value = args[name];
  if (typeof value !== 'string' || !TASK_ID.test(value)) refuse(`invalid arguments: ${name}`);
  return value;
}
function key(args: Args): string {
  const value = args.idempotency_key;
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    refuse('invalid arguments: idempotency_key (8–128 of A–Z a–z 0–9 . _ : -; reuse it when retrying this call)');
  }
  return value;
}
function priority(args: Args): number | undefined {
  const value = args.priority;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 4) refuse('invalid arguments: priority (0–4)');
  return value;
}
function labels(args: Args, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > HOSTED_TASK_LIMITS.labels
    || value.some(label => typeof label !== 'string')) refuse(`invalid arguments: ${name}`);
  return value as string[];
}
function choice<T extends string>(args: Args, name: string, values: readonly T[]): T | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T)) refuse(`invalid arguments: ${name} (one of ${values.join(', ')})`);
  return value as T;
}
function defined<T extends object>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as T;
}

// ─── Results in task language ─────────────────────────────────────────────────
type LiveTask = ReturnType<typeof toLiveTask>;
function presentTask(task: LiveTask, withReady: boolean): Record<string, unknown> {
  return {
    id: task.id, title: task.title, status: task.status, priority: task.priority, type: task.issueType,
    assignee: task.assignee, labels: task.labels, parent: task.parent, ...(withReady ? { ready: task.ready } : {}),
    description: task.description, acceptance: task.acceptance, deferUntil: task.deferUntil,
    dependencies: task.dependencies, commentCount: task.comments, metadata: task.metadata,
    createdAt: task.createdAt, updatedAt: task.updatedAt, startedAt: task.startedAt,
    closedAt: task.closedAt, closeReason: task.closeReason, awaitingHuman: task.awaitType === 'human',
  };
}
function taskOf(value: unknown): Record<string, unknown> {
  return presentTask(toLiveTask(Array.isArray(value) ? value[0] : value, new Set()), false);
}

// ─── Tools ────────────────────────────────────────────────────────────────────
interface ToolContext { readonly proof: Request; readonly workspaceId: string; readonly operations: HostedTaskOperations }
interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: Record<string, unknown>;
  run(context: ToolContext, args: Args): Promise<unknown>;
}
const PROJECT = { type: 'string', description: 'The projectId from list_projects.' };
const TASK = { type: 'string', description: 'The task id, such as abc-1x2.' };
const IDEMPOTENCY = { type: 'string', pattern: IDEMPOTENCY_KEY.source,
  description: 'A key you choose for this call. Retrying with the same key and arguments never repeats the change.' };
function schema(properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
const READ = Object.freeze({ readOnlyHint: true, idempotentHint: true, openWorldHint: false });
const WRITE = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });

async function write(context: ToolContext, projectId: string, operation: HostedTaskOperation, idempotencyKey: string,
  present: (value: unknown) => unknown): Promise<unknown> {
  let outcome: HostedTaskWriteOutcome;
  try {
    outcome = await context.operations.write(context.proof, context.workspaceId, { projectId, operation }, idempotencyKey);
  } catch (error) {
    if (error instanceof HostedTaskReceiptsUnavailable) refuse('unavailable: retry-safe task changes are not configured on this server');
    throw error;
  }
  if (outcome.status === 'pending') {
    refuse('pending: an earlier call with this idempotency_key may still be running or its result is not yet known; retry later with the same key');
  }
  if (outcome.status === 'conflict') refuse('conflict: this idempotency_key was already used for a different change');
  return { ...(present(outcome.value) as object), replayed: outcome.replayed };
}

export const TASK_MCP_TOOLS: readonly Tool[] = Object.freeze([
  { name: 'list_projects', description: 'List the task projects in this workspace.',
    inputSchema: schema({}), annotations: READ,
    async run({ proof, workspaceId, operations }, args) {
      only(args, []);
      return { projects: (await operations.projects(proof, workspaceId)).map(entry => ({
        projectId: entry.projectId, key: entry.logicalKey, name: entry.displayName, prefix: entry.prefix })) };
    } },
  { name: 'list_tasks', description: 'List a project\'s tasks: every open one and those closed in the last 7 days.',
    inputSchema: schema({ project: PROJECT,
      status: { type: 'array', items: { type: 'string', enum: STATUSES }, description: 'Only these statuses.' },
      ready: { type: 'boolean', description: 'Only tasks with nothing blocking them.' } }, ['project']),
    annotations: READ,
    async run({ proof, workspaceId, operations }, args) {
      only(args, ['project', 'status', 'ready']);
      const projectId = project(args);
      const statuses = args.status === undefined ? STATUSES : args.status;
      if (!Array.isArray(statuses) || statuses.length < 1 || new Set(statuses).size !== statuses.length
        || statuses.some(status => !STATUSES.includes(status as HostedTaskStatus))) refuse('invalid arguments: status');
      if (args.ready !== undefined && typeof args.ready !== 'boolean') refuse('invalid arguments: ready');
      const board = await operations.board(proof, workspaceId, projectId, statuses as HostedTaskStatus[]);
      const tasks = (board.tasks as LiveTask[]).filter(row => args.ready !== true || row.ready);
      return { project: board.project, readAt: board.readAt, closedSince: board.closedSince,
        tasks: tasks.map(row => presentTask(row, true)) };
    } },
  { name: 'get_task', description: 'Read one task with its comments.',
    inputSchema: schema({ project: PROJECT, task: TASK }, ['project', 'task']), annotations: READ,
    async run({ proof, workspaceId, operations }, args) {
      only(args, ['project', 'task']);
      const detail = await operations.task(proof, workspaceId, project(args), task(args));
      return { project: detail.project, readAt: detail.readAt, task: presentTask(detail.task as LiveTask, true),
        comments: detail.comments };
    } },
  { name: 'get_task_history', description: 'Read how one task changed, newest first.',
    inputSchema: schema({ project: PROJECT, task: TASK,
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'At most this many changes (default 50).' } }, ['project', 'task']),
    annotations: READ,
    async run({ proof, workspaceId, operations }, args) {
      only(args, ['project', 'task', 'limit']);
      const limit = args.limit ?? 50;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) refuse('invalid arguments: limit (1–200)');
      const history = await operations.history(proof, workspaceId, project(args), task(args), limit);
      if (!Array.isArray(history)) refuse('unavailable: history could not be read');
      return { changes: history.map(entry => {
        const row = (entry ?? {}) as Record<string, unknown>;
        return { revision: typeof row.CommitHash === 'string' ? row.CommitHash : null,
          at: typeof row.CommitDate === 'string' ? row.CommitDate : null, task: taskOf(row.Issue) };
      }) };
    } },
  { name: 'create_task', description: 'Create a task in a project.',
    inputSchema: schema({ project: PROJECT, title: { type: 'string', maxLength: HOSTED_TASK_LIMITS.title },
      description: { type: 'string', maxLength: HOSTED_TASK_LIMITS.body }, type: { type: 'string', enum: TYPES },
      priority: { type: 'integer', minimum: 0, maximum: 4, description: '0 is most urgent.' },
      labels: { type: 'array', items: { type: 'string' }, maxItems: HOSTED_TASK_LIMITS.labels },
      parent: { type: 'string', description: 'A parent task id.' },
      acceptance: { type: 'string', maxLength: HOSTED_TASK_LIMITS.body, description: 'What proves it done.' },
      idempotency_key: IDEMPOTENCY }, ['project', 'title', 'idempotency_key']),
    annotations: WRITE,
    async run(context, args) {
      only(args, ['project', 'title', 'description', 'type', 'priority', 'labels', 'parent', 'acceptance', 'idempotency_key']);
      const operation = defined({ kind: 'create' as const, title: textArg(args, 'title', HOSTED_TASK_LIMITS.title)!,
        description: textArg(args, 'description', HOSTED_TASK_LIMITS.body, false, true), type: choice(args, 'type', TYPES),
        priority: priority(args), labels: labels(args, 'labels'),
        parent: args.parent === undefined ? undefined : task(args, 'parent'),
        acceptance: textArg(args, 'acceptance', HOSTED_TASK_LIMITS.body, false, true) });
      return write(context, project(args), operation, key(args), value => value);
    } },
  { name: 'claim_task', description: 'Assign an open task to yourself and start it. Fails if someone else holds it.',
    inputSchema: schema({ project: PROJECT, task: TASK, idempotency_key: IDEMPOTENCY }, ['project', 'task', 'idempotency_key']),
    annotations: WRITE,
    async run(context, args) {
      only(args, ['project', 'task', 'idempotency_key']);
      return write(context, project(args), { kind: 'update', taskId: task(args), claim: true }, key(args), value => ({ task: taskOf(value) }));
    } },
  { name: 'update_task', description: 'Change a task\'s fields. Use close_task to close one and claim_task to take one.',
    inputSchema: schema({ project: PROJECT, task: TASK, status: { type: 'string', enum: STATUSES.filter(status => status !== 'closed') },
      priority: { type: 'integer', minimum: 0, maximum: 4 }, title: { type: 'string', maxLength: HOSTED_TASK_LIMITS.title },
      description: { type: 'string', maxLength: HOSTED_TASK_LIMITS.body }, assignee: { type: 'string' },
      parent: { type: 'string', description: 'A parent task id, or "" for none.' },
      defer: { type: 'string', description: 'YYYY-MM-DD to hide it until then, or "" to clear.' },
      acceptance: { type: 'string', maxLength: HOSTED_TASK_LIMITS.body },
      add_labels: { type: 'array', items: { type: 'string' } }, remove_labels: { type: 'array', items: { type: 'string' } },
      idempotency_key: IDEMPOTENCY }, ['project', 'task', 'idempotency_key']),
    annotations: WRITE,
    async run(context, args) {
      only(args, ['project', 'task', 'status', 'priority', 'title', 'description', 'assignee', 'parent', 'defer',
        'acceptance', 'add_labels', 'remove_labels', 'idempotency_key']);
      const operation = defined({ kind: 'update' as const, taskId: task(args),
        status: choice(args, 'status', STATUSES.filter(status => status !== 'closed')), priority: priority(args),
        title: textArg(args, 'title', HOSTED_TASK_LIMITS.title, false),
        description: textArg(args, 'description', HOSTED_TASK_LIMITS.body, false, true),
        assignee: textArg(args, 'assignee', HOSTED_TASK_LIMITS.identifier, false, true),
        parent: args.parent === undefined || args.parent === '' ? args.parent as string | undefined : task(args, 'parent'),
        defer: textArg(args, 'defer', 10, false, true), acceptance: textArg(args, 'acceptance', HOSTED_TASK_LIMITS.body, false, true),
        addLabels: labels(args, 'add_labels'), removeLabels: labels(args, 'remove_labels') });
      if (Object.keys(operation).length === 2) refuse('invalid arguments: name at least one field to change');
      return write(context, project(args), operation, key(args), value => ({ task: taskOf(value) }));
    } },
  { name: 'comment_on_task', description: 'Add a comment to a task.',
    inputSchema: schema({ project: PROJECT, task: TASK, text: { type: 'string', maxLength: HOSTED_TASK_LIMITS.comment },
      idempotency_key: IDEMPOTENCY }, ['project', 'task', 'text', 'idempotency_key']),
    annotations: WRITE,
    async run(context, args) {
      only(args, ['project', 'task', 'text', 'idempotency_key']);
      return write(context, project(args), { kind: 'comment', taskId: task(args), text: textArg(args, 'text', HOSTED_TASK_LIMITS.comment)! },
        key(args), value => ({ comment: toComment(value) }));
    } },
  { name: 'close_task', description: 'Close a task with the reason it is done, citing evidence such as a commit or URL.',
    inputSchema: schema({ project: PROJECT, task: TASK, reason: { type: 'string', maxLength: HOSTED_TASK_LIMITS.reason },
      idempotency_key: IDEMPOTENCY }, ['project', 'task', 'reason', 'idempotency_key']),
    annotations: WRITE,
    async run(context, args) {
      only(args, ['project', 'task', 'reason', 'idempotency_key']);
      return write(context, project(args), { kind: 'close', taskId: task(args), reason: textArg(args, 'reason', HOSTED_TASK_LIMITS.reason)! },
        key(args), value => ({ task: taskOf(value) }));
    } },
]);

export function createHostedTaskMcp(options: HostedTaskMcpOptions): (original: Request) => Promise<Response> {
  const origin = createBrowserRequestPolicy(options.trustedOrigin).origin;
  const { profile, operations } = options;
  if (!['hosted', 'demo'].includes(profile) || !operations || typeof operations.write !== 'function') throw new Error('Task MCP configuration refused');
  const demo = profile === 'demo' && typeof options.demoWorkspaceId === 'string' && UUID.test(options.demoWorkspaceId)
    ? options.demoWorkspaceId : undefined;
  if (profile === 'demo' && !demo || profile === 'hosted' && options.demoWorkspaceId !== undefined
    || options.agents !== undefined && (profile !== 'hosted' || typeof options.agents.verify !== 'function')) throw new Error('Task MCP configuration refused');
  const agents = options.agents;
  const invalid = (message: string) => Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message } },
    { status: 400, headers: { 'cache-control': 'no-store' } });
  return async original => {
    let url: URL;
    try { url = new URL(original.url); } catch { return invalid('invalid request'); }
    if (url.origin !== origin || url.pathname !== TASK_MCP_PATH || url.search || url.hash || url.username || url.password) {
      return invalid('invalid request');
    }
    const header = original.headers.get(WORKSPACE_SELECTION_HEADER);
    // An agent signs in (agent-access.mts): no credential at all is a 401
    // naming where to; its token names the workspace and the scopes it holds.
    const bearer = bearerToken(original.headers);
    let workspaceId: string, scopes: readonly string[] | null = null;
    if (agents && (bearer === false || bearer === null && !original.headers.has('cookie'))) {
      return bearerChallenge(origin, 'tasks', bearer === false ? { error: 'invalid_token' } : undefined);
    }
    if (bearer !== null) {
      if (!agents || bearer === false) return invalid('this endpoint does not accept bearer tokens');
      let agent: Awaited<ReturnType<typeof agents.verify>>;
      try { agent = await agents.verify(original); } catch { agent = null; }
      if (!agent) return bearerChallenge(origin, 'tasks', { error: 'invalid_token' });
      if (header !== null && header !== agent.workspaceId) return invalid('this token is for another workspace');
      ({ workspaceId, scopes } = agent);
    } else {
      workspaceId = profile === 'demo' ? demo! : header ?? '';
      if (!UUID.test(workspaceId) || profile === 'demo' && header !== null && header !== demo) {
        return invalid(`select a workspace with the ${WORKSPACE_SELECTION_HEADER} header`);
      }
    }
    // The parsed body is not forwarded: admission reads only request metadata.
    const proof = new Request(original.url, { method: original.method, headers: new Headers(original.headers), signal: original.signal });
    const server: McpServer = { info: SERVER_INFO, instructions: INSTRUCTIONS, tools: TASK_MCP_TOOLS, async call(name, args) {
      try {
        return await TASK_MCP_TOOLS.find(tool => tool.name === name)!.run({ proof, workspaceId, operations }, args);
      } catch (error) {
        if (error instanceof McpToolError) throw error;
        // Admission, project selection and command refusals share one answer:
        // which of them refused is not the caller's to learn.
        throw new McpToolError('refused: this workspace, project or task is not available to you, or the change was not accepted');
      }
    } };
    // A tool that changes tasks needs tasks:write; any other needs tasks:read.
    const authorize = scopes === null ? undefined : (message: { method: string; params: Readonly<Record<string, unknown>> }) => {
      if (message.method !== 'tools/call') return null;
      const tool = TASK_MCP_TOOLS.find(candidate => candidate.name === message.params.name);
      const needed = requiredScopes('tasks', tool?.annotations.readOnlyHint === false);
      return scopesSatisfy(scopes!, needed) ? null : bearerChallenge(origin, 'tasks', { error: 'insufficient_scope', scopes: needed });
    };
    return serveMcp(original, server, { origin, maxBytes: BODY_BYTES, ...(authorize ? { authorize } : {}) });
  };
}
