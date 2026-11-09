/** This installation's task service, an Ntasks Worker (docs/11-integrations.md#ntasks),
 * as every Node caller reaches it: the local MCP, the Tower's task routes and
 * the runner. Calls go through the ingest's POST /api/task-service
 * (workers/ingest/src/routes/task-service.ts) with the operator bearer, and
 * the ingest adds the service credential, which only a Worker opens.
 *
 * Authored TypeScript: `pnpm generate` writes the `.mjs` the runner imports
 * and the `.d.mts` the Tower's Vite lanes read.
 */
import { configStoreRequest, DEFAULT_DOOR } from './config-store-client.mjs';
import { TASK_METADATA } from '../packages/contract/src/task-metadata.mjs';

export const TASK_SERVICE_ROUTE = 'api/task-service';
/** How long one answer to "is a task service connected?" serves the calls after it. */
const STATUS_TTL_MS = 5_000;
/** How long Ntasks's project list and workspace id serve the calls after them. */
const CATALOG_TTL_MS = 30_000;
/** The ingest's own bound is 15 seconds; this one covers the door around it. */
const DOOR_TIMEOUT_MS = 20_000;

export interface TaskServiceOptions {
  readonly door?: string;
  /** The operator bearer; the door client reads it from the installation's secrets when absent. */
  readonly token?: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}
export interface TaskServiceCall {
  readonly method: 'GET' | 'POST' | 'PATCH';
  /** An Ntasks path with its query, such as `/api/tasks?project=…`. */
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  /** The agent the call is for, which Ntasks records as `service:<credential>/<name>`. */
  readonly onBehalfOf?: string;
}
export interface TaskServiceReply { readonly status: number; readonly body: unknown }
export interface NtasksProject { readonly projectId: string; readonly logicalKey: string; readonly displayName: string; readonly prefix: string }

/** Ntasks gave no answer. `reason` is the ingest's: `not-connected`, `network`,
 * `timeout`, `redirect`, `too-large`, `invalid-response`, or `ingest` when the
 * ingest itself did not answer. Nothing it was asked to change is known to have changed. */
export class TaskServiceUnavailable extends Error {
  override name = 'TaskServiceUnavailable';
  constructor(readonly reason: string, readonly status?: number) { super(`The task service did not answer (${reason}).`); }
}
/** An Ntasks tool refused the call; the message is its sentence for the agent. */
export class TaskServiceToolRefused extends Error {
  override name = 'TaskServiceToolRefused';
}

/** Where this installation's tasks live: `none` while no task service is
 * connected, when it has no tasks; `unknown` means the ingest has not said
 * since this process started. */
export type TaskBackend = 'ntasks' | 'none' | 'unknown';

export interface TaskService {
  /** Whether this installation's tasks live in Ntasks; throws when the ingest cannot say.
   * `fresh` asks the ingest now rather than reuse an answer from the last few seconds. */
  connected(options?: { readonly fresh?: boolean }): Promise<boolean>;
  /** Where the tasks live, for choosing a route: the last answer the ingest
   * gave when it cannot say now, and `unknown` only when it never has. */
  backend(): Promise<TaskBackend>;
  /** Where the task service is, when one is connected. */
  origin(): Promise<string | null>;
  /** The Tower's client id as a connected app of the task service, when one is saved:
   * the id a person's browser signs in to Ntasks with. */
  appClientId(): Promise<string | null>;
  /** Where the tasks live and the task service's address, waiting for the
   * ingest at most `within` milliseconds, or until it answers or fails when
   * `within` is absent; then its last answer, or `unknown` when it never gave one. */
  home(within?: number): Promise<{ readonly backend: TaskBackend; readonly origin: string | null }>;
  call(call: TaskServiceCall): Promise<TaskServiceReply>;
  /** One Ntasks MCP tool, with `workspace` set to Ntasks's own, for the agent `onBehalfOf`; its structured result. */
  tool(name: string, args: Readonly<Record<string, unknown>>, onBehalfOf?: string): Promise<unknown>;
  /** Ntasks's projects this credential reaches. */
  projects(): Promise<readonly NtasksProject[]>;
}

function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function createTaskService(options: TaskServiceOptions = {}): TaskService {
  const door = options.door ?? DEFAULT_DOOR;
  const token = options.token;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let status: { at: number; connected: boolean; origin: string | null; appClientId: string | null } | null = null;
  /** The last read that failed: reused for as long as a good answer would be, so a
   * stalled ingest costs one wait per few seconds rather than one per call. */
  let failed: { at: number; error: unknown } | null = null;
  let known: boolean | null = null;
  /** The read in flight, which every caller shares while the ingest is slow. */
  let pending: Promise<{ connected: boolean; origin: string | null; appClientId: string | null }> | null = null;
  let catalog: { at: number; projects: readonly NtasksProject[] } | null = null;
  let workspace: { at: number; id: string } | null = null;

  /** One request to the ingest door, through the one door client that carries the operator bearer. */
  async function door_(method: 'GET' | 'POST', body?: unknown): Promise<Record<string, unknown>> {
    let reply: { status: number; body: unknown };
    try {
      reply = await configStoreRequest(TASK_SERVICE_ROUTE, { door, method, ...(body === undefined ? {} : { body }),
        ...(token ? { token: await token() } : {}),
        fetchImpl: (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(DOOR_TIMEOUT_MS) }) });
    } catch { throw new TaskServiceUnavailable('ingest'); }
    const answer = row(reply.body);
    if (reply.status !== 200 || answer === null) throw new TaskServiceUnavailable('ingest', reply.status);
    return answer;
  }
  async function read(fresh = false): Promise<{ connected: boolean; origin: string | null; appClientId: string | null }> {
    if (!fresh && status && now() - status.at < STATUS_TTL_MS) return status;
    if (!fresh && failed && now() - failed.at < STATUS_TTL_MS) throw failed.error;
    pending ??= (async () => {
      try {
        let answer: Record<string, unknown>;
        try { answer = await door_('GET'); } catch (error) { failed = { at: now(), error }; throw error; }
        failed = null;
        status = { at: now(), connected: answer.connected === true, origin: typeof answer.origin === 'string' ? answer.origin : null,
          appClientId: typeof answer.appClientId === 'string' ? answer.appClientId : null };
        known = status.connected;
        return status;
      } finally { pending = null; }
    })();
    return pending;
  }
  async function call(request: TaskServiceCall): Promise<TaskServiceReply> {
    const answer = await door_('POST', { method: request.method, path: request.path,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
      ...(request.onBehalfOf === undefined ? {} : { onBehalfOf: request.onBehalfOf }) });
    if (answer.answered !== true || typeof answer.status !== 'number') {
      throw new TaskServiceUnavailable(typeof answer.reason === 'string' ? answer.reason : 'network', typeof answer.status === 'number' ? answer.status : undefined);
    }
    return { status: answer.status, body: answer.body };
  }
  let ids = 0;
  /** One JSON-RPC tools/call; the tool's own refusals become TaskServiceToolRefused. */
  async function rpc(name: string, args: Readonly<Record<string, unknown>>, onBehalfOf?: string): Promise<unknown> {
    // A write tool's retry key is its own `idempotency_key` argument, as in NoticeOS's tools.
    const reply = await call({ method: 'POST', path: '/api/mcp', ...(onBehalfOf === undefined ? {} : { onBehalfOf }),
      body: { jsonrpc: '2.0', id: ++ids, method: 'tools/call', params: { name, arguments: args } } });
    const body = row(reply.body);
    const result = row(body?.result), error = row(body?.error);
    if (result?.isError === true) {
      const text = (Array.isArray(result.content) ? row(result.content[0])?.text : undefined);
      throw new TaskServiceToolRefused(typeof text === 'string' ? text : `refused: Ntasks refused ${name}.`);
    }
    if (result) return result.structuredContent ?? null;
    if (error && typeof error.message === 'string' && /no tool named/iu.test(error.message)) {
      throw new TaskServiceToolRefused(`refused: the task service does not offer ${name} yet; nothing was read or changed.`);
    }
    if (error && error.code === -32602 && typeof error.message === 'string') throw new TaskServiceToolRefused(`invalid arguments: ${error.message}`);
    if (reply.status === 401 || reply.status === 403) {
      throw new TaskServiceToolRefused('refused: Ntasks refused this installation\'s service credential; replace it in Settings → Task projects.');
    }
    throw new TaskServiceUnavailable('invalid-response', reply.status);
  }
  async function workspaceId(): Promise<string> {
    if (workspace && now() - workspace.at < CATALOG_TTL_MS) return workspace.id;
    const listed = row(await rpc('list_workspaces', {}));
    const first = Array.isArray(listed?.workspaces) ? row(listed.workspaces[0]) : null;
    if (typeof first?.workspaceId !== 'string') throw new TaskServiceUnavailable('invalid-response');
    workspace = { at: now(), id: first.workspaceId };
    return workspace.id;
  }

  const service: TaskService = {
    async connected(options) { return (await read(options?.fresh === true)).connected; },
    async backend() {
      try { return (await read()).connected ? 'ntasks' : 'none'; }
      catch { return known === null ? 'unknown' : known ? 'ntasks' : 'none'; }
    },
    async origin() { return (await read()).origin; },
    async appClientId() { return (await read()).appClientId; },
    async home(within) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = within === undefined ? [] : [new Promise<null>(resolve => { timer = setTimeout(resolve, within, null); })];
      try {
        const answer = await Promise.race([read().catch(() => null), ...late]);
        if (answer) return { backend: answer.connected ? 'ntasks' : 'none', origin: answer.origin };
        return { backend: known === null ? 'unknown' : known ? 'ntasks' : 'none', origin: known ? status?.origin ?? null : null };
      } finally { clearTimeout(timer); }
    },
    call,
    async tool(name, args, onBehalfOf) {
      return rpc(name, Object.hasOwn(args, 'workspace') ? { ...args, workspace: await workspaceId() } : args, onBehalfOf);
    },
    async projects() {
      if (catalog && now() - catalog.at < CATALOG_TTL_MS) return catalog.projects;
      const reply = await call({ method: 'GET', path: '/api/tasks/projects' });
      const listed = row(reply.body)?.projects;
      if (reply.status !== 200 || !Array.isArray(listed)) throw new TaskServiceUnavailable(reply.status === 401 || reply.status === 403 ? 'refused' : 'invalid-response', reply.status);
      const projects = Object.freeze(listed.flatMap(value => {
        const entry = row(value);
        return typeof entry?.projectId === 'string' && typeof entry.logicalKey === 'string' && typeof entry.displayName === 'string' && typeof entry.prefix === 'string'
          ? [Object.freeze({ projectId: entry.projectId, logicalKey: entry.logicalKey, displayName: entry.displayName, prefix: entry.prefix })] : [];
      }));
      catalog = { at: now(), projects };
      return projects;
    },
  };
  return Object.freeze(service);
}

/** A saved task project (config/beads.json `spokes`) and the Ntasks project
 * that holds its tasks: the one whose prefix it carries, since a task's id
 * starts with its project's prefix in both. */
export interface MappedTaskProject {
  readonly asset: string;
  readonly prefix: string;
  readonly project: NtasksProject | null;
}
export function mapTaskProjects(spokes: readonly { readonly asset: string; readonly prefix: string }[],
  projects: readonly NtasksProject[]): MappedTaskProject[] {
  return spokes.map(spoke => ({ asset: spoke.asset, prefix: spoke.prefix,
    project: projects.find(project => project.prefix.toLowerCase() === spoke.prefix.toLowerCase()) ?? null }));
}

/** The sentence an operator or agent reads when Ntasks gave no answer. */
export function unavailableSentence(error: TaskServiceUnavailable, origin: string | null): string {
  const where = origin ?? 'the task service';
  if (error.reason === 'not-connected') return 'No task service is connected; connect Ntasks in Settings → Task projects.';
  if (error.reason === 'ingest') return 'The installation\'s ingest did not answer, so the task service could not be asked.';
  if (error.reason === 'refused') return `${where} refused this installation's service credential; replace it in Settings → Task projects.`;
  return `${where} did not answer (${error.reason}).`;
}

/** A task as Ntasks's task routes answer it, with its close and its claim also
 * written under the NoticeOS metadata keys the task snapshot, the readback lane
 * and the Tower's close attribution read (packages/contract/src/task-metadata.mts).
 * Ntasks keeps them on the task itself; a close it imported without a closer
 * gains none. */
export function withNoticeosRecords<T extends Record<string, unknown>>(task: T): T {
  const recorded: Record<string, string> = {};
  const text = (value: unknown) => typeof value === 'string' && value.trim() !== '' ? value : null;
  const closedBy = text(task.closedBy), closedAt = text(task.closedAt);
  if (closedBy !== null && closedAt !== null) {
    recorded[TASK_METADATA.closedBy.name] = closedBy;
    recorded[TASK_METADATA.closedAt.name] = closedAt;
    const model = text(task.closedModel), resolution = text(task.resolution), duplicateOf = text(task.duplicateOf);
    if (model !== null) recorded[TASK_METADATA.closedModel.name] = model;
    if (resolution !== null) recorded[TASK_METADATA.resolution.name] = resolution;
    if (duplicateOf !== null) recorded[TASK_METADATA.duplicateOf.name] = duplicateOf;
  }
  const claimedModel = text(task.assigneeModel);
  if (claimedModel !== null) recorded[TASK_METADATA.claimedModel.name] = claimedModel;
  if (Object.keys(recorded).length === 0) return task;
  return { ...task, metadata: { ...(row(task.metadata) ?? {}), ...recorded } };
}
