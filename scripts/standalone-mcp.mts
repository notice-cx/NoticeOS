/** A standalone installation's MCP endpoint: the hosted endpoint's tools
 * (hosted-mcp.mts, standalone profile) over the installation's own database,
 * published panels and Tower. The Tower serves it at /api/mcp
 * (apps/tower/vite/mcp-lane.ts) and local-mcp.mjs over stdio. Whoever reaches
 * either operates the installation, as with the Tower's own pages. Its tasks
 * live in Ntasks, so it lists no task tools and names Ntasks's endpoint.
 */
import { openStore, type PostgresStore } from '../packages/postgres/src/store.mjs';
import { DEFAULT_TOWER_ORIGIN } from './dev-secrets.mjs';
import { createHostedMcp, MCP_PATH, type TaskHome } from './hosted-mcp.mjs';
import type { TaskService } from './task-service.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createBrowserRequestPolicy } from './browser-request-policy.mjs';
import { createPanelOperations } from './panel-mcp.mjs';
import { PANEL_REPORTS_ROOT } from './signal-panel-paths.mjs';

/** The origin every request to the endpoint is addressed to, whatever carried it. */
export const STANDALONE_MCP_ORIGIN = 'http://localhost';
/** Names the agent a request acts as; without it, `agent`. */
export const ACTOR_HEADER = 'x-noticeos-actor';
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

/** Who a request acts as, or null when it names someone no record can name. */
export function actorOf(request: Request): string | null {
  const named = request.headers.get(ACTOR_HEADER);
  if (named === null) return 'agent';
  return ACTOR.test(named) ? named : null;
}

export interface StandaloneMcp {
  /** Answers one MCP POST addressed to STANDALONE_MCP_ORIGIN + MCP_PATH. */
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}
export interface StandaloneMcpOptions {
  readonly databaseUrl?: string;
  /** Tests supply a store instead of a database. */
  readonly store?: Pick<PostgresStore, 'onlyWorkspace' | 'close'>;
  /** Where the Tower answers its read-model MCP calls. */
  readonly tower?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Where the installation publishes its site panels; tests name a fixture. */
  readonly panelRoot?: string;
  /** The installation's task service, whose answer names where its tasks
   * live; without one, the endpoint has no task service connected. */
  readonly taskService?: TaskService;
}

/** How long one MCP request waits for the ingest to say where the tasks live
 * before it uses the ingest's last answer: every request reads it, so a stalled
 * ingest must not hold up a client's start or a tool that is not a task tool. */
const TASK_HOME_WAIT_MS = 2_000;

/** Where the installation's tasks live, as the task service last said. */
export function taskHome(service: TaskService): (options: { readonly forTaskTool: boolean }) => Promise<TaskHome> {
  return async ({ forTaskTool }) => {
    const { backend, origin } = await service.home(forTaskTool ? undefined : TASK_HOME_WAIT_MS);
    return backend === 'ntasks' ? { kind: 'ntasks', origin } : { kind: backend };
  };
}

const NO_TASK_SERVICE: TaskHome = Object.freeze({ kind: 'none' });

export async function openStandaloneMcp(options: StandaloneMcpOptions): Promise<StandaloneMcp> {
  const store = options.store ?? openStore(options.databaseUrl ?? '', { maxConnections: 1 });
  let workspaceId: string;
  try { workspaceId = await store.onlyWorkspace(); } catch (error) { await store.close(); throw error; }
  const admission = createWorkspaceAdmission({ kind: 'standalone', profile: Symbol('standalone-mcp'),
    authority: async request => {
      const principalId = actorOf(request);
      return principalId === null ? null : { principalId, workspaceId, workspaceStatus: 'active' };
    } });
  const tower = options.tower ?? DEFAULT_TOWER_ORIGIN, fetch = options.fetch ?? globalThis.fetch;
  const panelRoot = options.panelRoot ?? PANEL_REPORTS_ROOT;
  const handle = createHostedMcp({ profile: 'standalone', trustedOrigin: STANDALONE_MCP_ORIGIN, standaloneWorkspaceId: workspaceId,
    taskHome: options.taskService ? taskHome(options.taskService) : async () => NO_TASK_SERVICE,
    readModels: async request => fetch(tower + MCP_PATH,
      { method: 'POST', headers: request.headers, body: await request.text(), signal: request.signal }),
    panels: createPanelOperations({ admission, root: () => panelRoot }),
    journeys: async request => {
      if (actorOf(request) === null) return Response.json({ error: 'invalid actor' }, { status: 403 });
      const url = new URL(request.url);
      const target = new URL(tower + url.pathname);
      const browserMarked = [...request.headers.keys()].some(name => name === 'origin' || name === 'referer' || name.startsWith('sec-fetch-'));
      if (browserMarked) {
        try {
          createBrowserRequestPolicy(target.origin).assertEffect(new Request(target, { method: request.method, headers: request.headers }));
          const referer = request.headers.get('referer');
          if (referer !== null && new URL(referer).origin !== target.origin) throw new Error('Cross-site referrer');
        } catch { return Response.json({ error: 'forbidden' }, { status: 403 }); }
      }
      return fetch(tower + url.pathname, { method: request.method, headers: request.headers,
        ...(request.method === 'PUT' ? { body: await request.text() } : {}), signal: request.signal });
    } });
  return Object.freeze({ handle, close: () => store.close() });
}
