/** The public demo's own Ntasks (deploy/demo/README.md): the Ntasks Worker the
 * demo image builds from the commit deploy/demo/ntasks.json pins, run in
 * Miniflare by the demo stack's ntasks service. Its D1 database is
 * provisioned by Ntasks's own provision command, and its one workspace,
 * the demo's, is the deployment's public workspace: visitors read it with no
 * credential, and every change they send is refused there. The simulator
 * changes it through the one credential granted the sites' projects.
 *
 * Nothing here reaches another Ntasks: every address is the stack's own
 * loopback listener.
 */
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { DEMO_READ_ONLY } from './demo-viewer-policy.mjs';
import { createHostedMcp, MCP_PATH } from './hosted-mcp.mjs';
import { TASK_MCP_TOOLS } from './hosted-task-mcp.mjs';
import { McpToolError } from './mcp-protocol.mjs';
import { demoNtasksSeed } from './demo-ntasks-seed.mjs';
import { withNoticeosRecords } from './task-service.mjs';
import { boardResults, LABEL_READS, readLabelled } from './runner/task-service-poll.mjs';
import { TASK_CLOSES_DAYS, tasksClosedSince, tasksClosesSince, summarizeTaskProject } from './task-snapshot-summary.mjs';
import { AGENT_HISTORY_DAYS, readAgentStats, type AgentStatsProject } from '../packages/contract/src/agent-stats.mjs';
import type { BeadsProjectInput, BeadsSnapshotInput } from '../packages/contract/src/task-snapshot.mjs';
import type { generateDemoScenario } from './demo-scenario.mjs';

type Scenario = ReturnType<typeof generateDemoScenario>;

/** Where the ntasks service listens, inside the network namespace it owns and the app and setup share. */
export const DEMO_NTASKS_PORT = 8787;
export const DEMO_NTASKS_ORIGIN = `http://127.0.0.1:${DEMO_NTASKS_PORT}`;
/** The newest compatibility date the image's Workers runtime runs. Ntasks's
 * code needs none newer: Node's modules come built in from 2026-08-04. */
export const DEMO_NTASKS_COMPATIBILITY_DATE = '2026-10-30';
/** The address of the stack's own Ntasks: an http origin on 127.0.0.1, or the value is refused. */
export function demoNtasksOrigin(value: unknown): string {
  let url: URL | null = null;
  try { url = typeof value === 'string' ? new URL(value) : null; } catch { url = null; }
  if (!url || url.origin !== value || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('Demo Ntasks address refused.');
  return url.origin;
}
/** The credential setup loads the seed through, and the one the simulator changes tasks through. */
export const DEMO_NTASKS_CREDENTIALS = Object.freeze({ seed: 'seed', activity: 'demo' });
/** The operator of record, who files the scenario's tasks. */
const OPERATOR = 'Mara';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const TIMEOUT_MS = 15_000;

/** What Ntasks's provision command takes for the demo: its workspace, and the
 * two credentials. The simulator changes the sites' projects, never the OS's own. */
export function demoNtasksProvisionRequest(scenario: Scenario) {
  const own = (prefix: string) => scenario.assets.find(asset => asset.prefix === prefix)?.isOs === true;
  const projects = demoNtasksSeed(scenario).projects.filter(project => !own(project.prefix));
  return {
    format: 'ntasks-provision-request-v1',
    workspace: { id: scenario.manifest.workspaceId, name: 'Synthetic demo' },
    owner: { name: OPERATOR },
    credentials: [
      { name: DEMO_NTASKS_CREDENTIALS.seed, backup: true, restore: true },
      { name: DEMO_NTASKS_CREDENTIALS.activity,
        grants: projects.map(project => ({ projectId: project.id, access: 'write' })) },
    ],
  } as const;
}

/** The provision file Ntasks's provision command writes. */
export interface DemoNtasksProvision {
  readonly format: 'ntasks-provision-v1';
  readonly workspaceId: string;
  readonly statements: readonly { readonly sql: string; readonly values: readonly (string | number | null)[] }[];
  readonly tokens: Readonly<Record<string, string>>;
}

/** The Ntasks Worker as one Miniflare 4 worker: its built bundle, its task
 * store, its D1 database and rate limits, and sign-in on, with GitHub values
 * nothing reaches. Nobody signs in to this deployment; it fetches nothing. */
export function demoNtasksWorker({ bundleRoot, authSecret, workspaceId }: { bundleRoot: string; authSecret: string; workspaceId: string }) {
  if (!path.isAbsolute(bundleRoot) || authSecret.length < 32 || !UUID.test(workspaceId)) throw new Error('Demo Ntasks configuration refused.');
  const files = readdirSync(bundleRoot);
  if (!files.includes('index.js')) throw new Error('Demo Ntasks bundle absent.');
  return {
    name: 'ntasks',
    modulesRoot: bundleRoot,
    modules: [{ type: 'ESModule', path: path.join(bundleRoot, 'index.js') },
      ...files.filter(name => name.endsWith('.sql')).sort().map(name => ({ type: 'Text', path: path.join(bundleRoot, name) }))],
    compatibilityDate: DEMO_NTASKS_COMPATIBILITY_DATE,
    durableObjects: { TASK_STORE: { className: 'TaskStore', useSQLite: true } },
    d1Databases: { DB: 'ntasks' },
    ratelimits: {
      SIGN_IN_LIMIT: { namespace_id: '1001', simple: { limit: 30, period: 60 } },
      REGISTER_LIMIT: { namespace_id: '1002', simple: { limit: 10, period: 60 } },
      REGISTER_ADDRESS_LIMIT: { namespace_id: '1003', simple: { limit: 3, period: 60 } },
    },
    bindings: { AUTH_SECRET: authSecret, NTASKS_ORIGIN: DEMO_NTASKS_ORIGIN, GITHUB_CLIENT_ID: 'demo-none',
      GITHUB_CLIENT_SECRET: 'demo-none', PUBLIC_WORKSPACE_ID: workspaceId },
    outboundService: async () => new Response('Demo external fetch refused.', { status: 403 }),
  };
}

interface D1Like {
  prepare(sql: string): { bind(...values: unknown[]): unknown };
  batch(statements: unknown[]): Promise<unknown>;
}
/** Runs the provision's statements on the empty D1 database, as one batch. */
export async function applyDemoNtasksProvision(db: D1Like, provision: DemoNtasksProvision): Promise<void> {
  if (provision.format !== 'ntasks-provision-v1' || !Array.isArray(provision.statements) || !provision.statements.length) {
    throw new Error('Demo Ntasks provision refused.');
  }
  await db.batch(provision.statements.map(({ sql, values }) => db.prepare(sql).bind(...values)));
}

export interface DemoNtasksReply { readonly status: number; readonly body: unknown }
export interface DemoNtasksCallOptions {
  readonly body?: unknown;
  /** The agent a credential's change is for: Ntasks records it as `service:<credential>/<agent>`. */
  readonly onBehalfOf?: string;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}
/** An Ntasks tool refused the call; the message is its sentence. */
export class DemoNtasksRefused extends Error {
  override name = 'DemoNtasksRefused';
}
export interface DemoNtasks {
  call(method: 'GET' | 'POST' | 'PATCH', pathAndQuery: string, options?: DemoNtasksCallOptions): Promise<DemoNtasksReply>;
  /** One MCP tool in the demo workspace; its structured result. */
  tool(name: string, args: Readonly<Record<string, unknown>>, options?: Omit<DemoNtasksCallOptions, 'body' | 'idempotencyKey'>): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The demo's Ntasks, as a visitor without `token`, or as the credential `token` belongs to. */
export function demoNtasks({ workspaceId, token, origin = DEMO_NTASKS_ORIGIN, fetch = globalThis.fetch }: {
  workspaceId: string; token?: string; origin?: string; fetch?: typeof globalThis.fetch;
}): DemoNtasks {
  demoNtasksOrigin(origin);
  if (!UUID.test(workspaceId)) throw new Error('Demo Ntasks workspace refused.');
  const headers = (options: DemoNtasksCallOptions = {}): Record<string, string> => ({
    accept: 'application/json',
    ...(token === undefined ? { 'x-ntasks-workspace': workspaceId } : { authorization: `Bearer ${token}` }),
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(options.onBehalfOf === undefined ? {} : { 'x-ntasks-on-behalf-of': options.onBehalfOf }),
    ...(options.idempotencyKey === undefined ? {} : { 'idempotency-key': options.idempotencyKey }),
  });
  const send = async (method: string, pathAndQuery: string, options: DemoNtasksCallOptions = {}, extra: Record<string, string> = {}) => {
    if (!pathAndQuery.startsWith('/api/')) throw new Error('Demo Ntasks path refused.');
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetch(origin + pathAndQuery, { method, headers: { ...headers(options), ...extra }, redirect: 'error', signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) as unknown : null; } catch { body = null; }
    return { status: response.status, body };
  };
  const client: DemoNtasks = {
    call: (method, pathAndQuery, options) => send(method, pathAndQuery, options),
    async tool(name, args, options = {}) {
      const reply = await send('POST', '/api/mcp', { ...options,
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { ...args, workspace: workspaceId } } } },
      { 'mcp-protocol-version': '2025-06-18' });
      const answer = record(reply.body), result = record(answer?.result), error = record(answer?.error);
      if (result?.isError === true) {
        const text = Array.isArray(result.content) ? record(result.content[0])?.text : undefined;
        throw new DemoNtasksRefused(typeof text === 'string' ? text : `refused: ${name}`);
      }
      if (result) {
        if (result.structuredContent !== undefined) return result.structuredContent;
        const text = Array.isArray(result.content) ? record(result.content[0])?.text : undefined;
        return typeof text === 'string' ? JSON.parse(text) as unknown : null;
      }
      if (error && typeof error.message === 'string') throw new DemoNtasksRefused(error.message);
      throw new Error(`The demo's Ntasks answered ${name} with HTTP ${reply.status}.`);
    },
  };
  return Object.freeze(client);
}

function json(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}
/** A board or a task read with each task's close and claim under the NoticeOS keys the pages read. */
function withRecords(body: Record<string, unknown>): Record<string, unknown> {
  const tasks = Array.isArray(body.tasks) ? body.tasks.map(task => record(task) ? withNoticeosRecords(record(task)!) : task) : body.tasks;
  const task = record(body.task) ? withNoticeosRecords(record(body.task)!) : body.task;
  return { ...body, ...(tasks === undefined ? {} : { tasks }), ...(task === undefined ? {} : { task }) };
}
const READ = /^\/api\/tasks(?:\/(?:projects|capabilities|agent-stats|[a-z0-9]+-[a-z0-9]+(?:\.[0-9]+)*(?:\/history)?))?$/u;

/** The demo's task routes for its pages: every read answered by its Ntasks as
 * a visitor, and every change refused here, as the demo refuses any other. */
export function createDemoTaskGateway({ ntasks, now = () => Date.now() }: { ntasks: DemoNtasks; now?: () => number }) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method)) return json(403, { error: 'demo_read_only', detail: DEMO_READ_ONLY });
    if (!READ.test(url.pathname)) return json(404, { error: 'not_found' });
    if (url.pathname === '/api/tasks/agent-stats') return json(200, await agentStats(ntasks, url, now()));
    const reply = await ntasks.call('GET', url.pathname + url.search, { signal: request.signal });
    const body = record(reply.body);
    if (reply.status === 200 && body) return json(200, withRecords(body));
    return json(reply.status === 200 ? 502 : reply.status, body ?? { error: 'task_service_invalid' });
  };
}

/** The demo's task routes and its one MCP endpoint, for the demo server:
 * reads and the task tools answered by its Ntasks as a visitor, and the
 * read-model tools forwarded to the Workers through `readModels`. */
export function openDemoTasks(options: { trustedOrigin: string; demoWorkspaceId: string; ntasks: { origin: string } },
  { readModels, fetch }: { readModels?: (request: Request) => Promise<Response>; fetch?: typeof globalThis.fetch } = {}) {
  const ntasks = demoNtasks({ workspaceId: options.demoWorkspaceId, origin: options.ntasks.origin, ...(fetch ? { fetch } : {}) });
  const gateway = createDemoTaskGateway({ ntasks });
  const mcp = createHostedMcp({ profile: 'demo', trustedOrigin: options.trustedOrigin, demoWorkspaceId: options.demoWorkspaceId,
    ...(readModels ? { readModels } : {}),
    taskTools: async (name, args) => {
      // Refused here as the task routes refuse a change, whatever the Ntasks behind it allows a visitor.
      if (TASK_MCP_TOOLS.find(tool => tool.name === name)?.annotations.readOnlyHint !== true) {
        throw new McpToolError(`refused: ${DEMO_READ_ONLY} Nothing was read or changed.`);
      }
      try { return await ntasks.tool(name, args); } catch (error) {
        if (error instanceof DemoNtasksRefused) throw new McpToolError(error.message);
        throw error;
      }
    } });
  let closed = false;
  return Object.freeze({
    handle(request: Request): Promise<Response> {
      if (closed) return Promise.resolve(json(503, { error: 'hosted_task_unavailable' }));
      return new URL(request.url).pathname === MCP_PATH ? mcp(request) : gateway(request);
    },
    async close() { closed = true; },
  });
}

/** The Agents page's model statistics, read from each project's boards as the Tower reads Ntasks elsewhere. */
async function agentStats(ntasks: DemoNtasks, url: URL, nowMs: number) {
  const selected = url.searchParams.get('project');
  const listed = record((await ntasks.call('GET', '/api/tasks/projects')).body)?.projects;
  const projects = (Array.isArray(listed) ? listed : []).flatMap(value => {
    const project = record(value);
    return typeof project?.projectId === 'string' && typeof project.displayName === 'string'
      && (selected === null || project.projectId === selected) ? [{ projectId: project.projectId, displayName: project.displayName }] : [];
  });
  const readAt = new Date(nowMs).toISOString();
  const read: AgentStatsProject[] = [], broken: string[] = [];
  for (const project of projects) {
    const id = encodeURIComponent(project.projectId);
    const boards = await Promise.all([`status=in_progress,blocked`, `status=closed&closedDays=${AGENT_HISTORY_DAYS}`]
      .map(query => ntasks.call('GET', `/api/tasks?project=${id}&${query}`)));
    const rows = boards.map(board => board.status === 200 ? record(board.body)?.tasks : undefined);
    if (rows.some(list => !Array.isArray(list))) { broken.push(project.displayName); continue; }
    read.push({ project: project.projectId, tasks: (rows as unknown[][]).flat()
      .map(task => record(task) ? withNoticeosRecords(record(task)!) : task) as AgentStatsProject['tasks'] });
  }
  return { readAt, projects: projects.length, broken, stats: readAgentStats(read, nowMs) };
}

/** A task the simulator filed, as it finds it again on the board. */
export interface DemoTaskRow {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly assignee: string | null;
  readonly labels: readonly string[];
}
/** What the simulator does with tasks: each change through the demo's credential,
 * as the agent it names. */
export interface DemoTaskService {
  /** The open tasks of a project that carry `label`. */
  labelled(projectId: string, label: string, signal: AbortSignal): Promise<readonly DemoTaskRow[]>;
  create(projectId: string, task: { title: string; description: string; acceptance: string; labels: readonly string[] }, key: string, signal: AbortSignal): Promise<string>;
  claim(taskId: string, agent: string, model: string | undefined, signal: AbortSignal): Promise<void>;
  close(taskId: string, reason: string, agent: string, model: string | undefined, signal: AbortSignal): Promise<void>;
  comments(projectId: string, taskId: string, signal: AbortSignal): Promise<readonly { author: string; text: string }[]>;
  comment(taskId: string, text: string, agent: string, signal: AbortSignal): Promise<void>;
  /** The board photograph the Home and the Wall read, from each project's boards. */
  snapshot(projects: readonly { readonly projectId: string; readonly asset: string; readonly prefix: string }[], signal: AbortSignal): Promise<BeadsSnapshotInput & { capturedAt: string }>;
  /** The actor Ntasks records for this agent's changes. */
  actor(agent?: string): string;
}

/** The simulator's task service: the demo credential's reads and changes. */
export function createDemoTaskService({ ntasks, now = () => Date.now() }: { ntasks: DemoNtasks; now?: () => number }): DemoTaskService {
  const rowsOf = (reply: DemoNtasksReply): Record<string, unknown>[] => {
    const tasks = record(reply.body)?.tasks;
    if (reply.status !== 200 || !Array.isArray(tasks)) throw new Error(`The demo's Ntasks answered a board read with HTTP ${reply.status}.`);
    return tasks.flatMap(task => record(task) ? [record(task)!] : []);
  };
  const tasks: DemoTaskService = {
    actor: (agent?: string) => `service:${DEMO_NTASKS_CREDENTIALS.activity}${agent === undefined ? '' : `/${agent}`}`,
    async labelled(projectId, label, signal) {
      const query = new URLSearchParams({ project: projectId, status: 'open,in_progress,blocked,deferred' });
      return rowsOf(await ntasks.call('GET', `/api/tasks?${query}`, { signal }))
        .filter(task => Array.isArray(task.labels) && task.labels.includes(label))
        .map(task => ({ id: String(task.id), type: String(task.issueType), status: String(task.status),
          assignee: typeof task.assignee === 'string' ? task.assignee : null, labels: (task.labels as unknown[]).map(String) }));
    },
    async create(projectId, task, key, signal) {
      // Keyed by the intention, so a retry after a lost answer files nothing twice.
      const created = record(await ntasks.tool('create_task', { project: projectId, title: task.title, description: task.description,
        acceptance: task.acceptance, type: 'task', priority: 2, labels: [...task.labels], idempotency_key: `demo-create-${key}`.slice(0, 128) }, { signal }));
      const id = created?.id ?? record(created?.task)?.id;
      if (typeof id !== 'string') throw new Error('The demo\'s Ntasks filed no task.');
      return id;
    },
    async claim(taskId, agent, model, signal) {
      await ntasks.tool('claim_task', { task: taskId, ...(model ? { model } : {}) }, { onBehalfOf: agent, signal });
    },
    async close(taskId, reason, agent, model, signal) {
      await ntasks.tool('close_task', { task: taskId, reason, ...(model ? { model } : {}) }, { onBehalfOf: agent, signal });
    },
    async comments(projectId, taskId, signal) {
      const reply = await ntasks.call('GET', `/api/tasks/${encodeURIComponent(taskId)}?project=${encodeURIComponent(projectId)}`, { signal });
      const comments = record(reply.body)?.comments;
      if (reply.status !== 200 || !Array.isArray(comments)) throw new Error(`The demo's Ntasks answered a task read with HTTP ${reply.status}.`);
      return comments.flatMap(comment => {
        const row = record(comment);
        return typeof row?.author === 'string' && typeof row.text === 'string' ? [{ author: row.author, text: row.text }] : [];
      });
    },
    async comment(taskId, text, agent, signal) {
      await ntasks.tool('comment_on_task', { task: taskId, text }, { onBehalfOf: agent, signal });
    },
    async snapshot(projects, signal) {
      const at = now();
      // The label reads go through the same call, so the step's signal stops them too.
      const service = { call: ({ method, path: read }: { method: 'GET'; path: string }) => ntasks.call(method, read, { signal }) };
      const reach = { closedSince: tasksClosedSince(at), closesSince: tasksClosesSince(at) };
      const entries: BeadsProjectInput[] = [];
      for (const project of projects) {
        const id = encodeURIComponent(project.projectId);
        const [board, closes] = await Promise.all([`/api/tasks?project=${id}`, `/api/tasks?project=${id}&status=closed&closedDays=${TASK_CLOSES_DAYS}`]
          .map(at => ntasks.call('GET', at, { signal })));
        const labelled: Record<string, unknown[]> = {};
        for (const [read, labels] of Object.entries(LABEL_READS) as [string, readonly string[]][]) {
          const found = new Map<string, unknown>();
          for (const label of labels) for (const task of await readLabelled(service, project.projectId, label) as Record<string, unknown>[]) found.set(String(task.id), task);
          labelled[read] = [...found.values()];
        }
        entries.push(summarizeTaskProject(project, boardResults({ tasks: rowsOf(board!), epics: record(board!.body)?.epics },
          { tasks: rowsOf(closes!) }, labelled), reach) as BeadsProjectInput);
      }
      return { capturedAt: new Date(at).toISOString(), projects: entries };
    },
  };
  return Object.freeze(tasks);
}
