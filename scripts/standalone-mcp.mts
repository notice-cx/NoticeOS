/** A standalone installation's MCP endpoint: the hosted endpoint's tools
 * (hosted-mcp.mts, standalone profile) over the installation's own database,
 * linked task projects and Tower. The Tower serves it at /api/mcp
 * (apps/tower/vite/mcp-lane.ts) and local-mcp.mjs over stdio. Whoever reaches
 * either operates the installation, as with the Tower's own pages.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, type PostgresStore } from '../packages/postgres/src/store.mjs';
import { taskReceipts, type TaskReceipts } from '../packages/postgres/src/task-receipts.mjs';
import { DEFAULT_TOWER_ORIGIN } from './dev-secrets.mjs';
import { createHostedMcp, MCP_PATH } from './hosted-mcp.mjs';
import { createHostedTaskOperations } from './hosted-task-operations.mjs';
import { createStandaloneTaskExecutor, standaloneProjectId, standaloneTaskDirectory,
  type StandaloneTaskProject } from './standalone-tasks.mjs';
import { taskChildEnvironment, type TaskClientEnvironment } from './task-client.mjs';
import { readTaskProjects, type TaskProject } from './task-project-config.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createPanelOperations } from './panel-mcp.mjs';
import { PANEL_REPORTS_ROOT } from './signal-panel-paths.mjs';

/** The origin every request to the endpoint is addressed to, whatever carried it. */
export const STANDALONE_MCP_ORIGIN = 'http://localhost';
/** Names the agent a request acts as; without it, `agent`. */
export const ACTOR_HEADER = 'x-noticeos-actor';
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** How long one read of the linked projects serves the calls after it. */
const PROJECTS_TTL_MS = 5_000;

/** Who a request acts as, or null when it names someone no task can record. */
export function actorOf(request: Request): string | null {
  const named = request.headers.get(ACTOR_HEADER);
  if (named === null) return 'agent';
  return ACTOR.test(named) ? named : null;
}

/** The linked task projects, as the Tower's task lane resolves them. */
export function linkedProjects({ read = () => readTaskProjects(), root = REPO_ROOT, now = Date.now }: {
  read?: () => Promise<TaskProject[]>; root?: string; now?: () => number } = {}): () => Promise<readonly StandaloneTaskProject[]> {
  let cached: { at: number; projects: readonly StandaloneTaskProject[] } | null = null;
  return async () => {
    if (cached && now() - cached.at < PROJECTS_TTL_MS) return cached.projects;
    const projects = Object.freeze((await read()).filter(project => project.repo).map(project => Object.freeze({
      projectId: standaloneProjectId(project.asset), asset: project.asset, prefix: project.prefix, cwd: path.resolve(root, project.repo) })));
    cached = { at: now(), projects };
    return projects;
  };
}

/** One task client command in a project's folder, with the declared task client, bounded in time and output. */
export function runTaskClient(argv: readonly string[], cwd: string, env: TaskClientEnvironment = process.env):
  Promise<{ readonly code: number; readonly stdout: string }> {
  return new Promise(resolve => {
    execFile(env.BEADS_BD_BIN ?? 'bd', [...argv], { cwd, env: taskChildEnvironment(env), timeout: 30_000, maxBuffer: 32 * 1024 ** 2,
      encoding: 'utf8' }, (error, stdout) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout });
    });
  });
}

export interface StandaloneMcp {
  /** Answers one MCP POST addressed to STANDALONE_MCP_ORIGIN + MCP_PATH. */
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}
export interface StandaloneMcpOptions {
  readonly databaseUrl?: string;
  /** Tests supply a store and receipts instead of a database. */
  readonly store?: Pick<PostgresStore, 'onlyWorkspace' | 'close'>;
  readonly receipts?: TaskReceipts;
  readonly projects?: () => Promise<readonly StandaloneTaskProject[]>;
  readonly run?: (argv: readonly string[], cwd: string) => Promise<{ readonly code: number; readonly stdout: string }>;
  /** Where the Tower answers its read-model MCP calls. */
  readonly tower?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Where the installation publishes its site panels; tests name a fixture. */
  readonly panelRoot?: string;
}

export async function openStandaloneMcp(options: StandaloneMcpOptions): Promise<StandaloneMcp> {
  const opened = options.store ? null : openStore(options.databaseUrl ?? '', { maxConnections: 2 });
  const store = options.store ?? opened!;
  let workspaceId: string;
  try { workspaceId = await store.onlyWorkspace(); } catch (error) { await store.close(); throw error; }
  const admission = createWorkspaceAdmission({ kind: 'standalone', profile: Symbol('standalone-mcp'),
    authority: async request => {
      const principalId = actorOf(request);
      return principalId === null ? null : { principalId, workspaceId, workspaceStatus: 'active' };
    } });
  const projects = options.projects ?? linkedProjects();
  const operations = createHostedTaskOperations({ admission, directory: standaloneTaskDirectory(projects),
    executor: createStandaloneTaskExecutor({ admission, projects, run: options.run ?? ((argv, cwd) => runTaskClient(argv, cwd)) }),
    receipts: options.receipts ?? taskReceipts(opened!) });
  const tower = options.tower ?? DEFAULT_TOWER_ORIGIN, fetch = options.fetch ?? globalThis.fetch;
  const panelRoot = options.panelRoot ?? PANEL_REPORTS_ROOT;
  const handle = createHostedMcp({ profile: 'standalone', trustedOrigin: STANDALONE_MCP_ORIGIN, standaloneWorkspaceId: workspaceId,
    operations, readModels: async request => fetch(tower + MCP_PATH,
      { method: 'POST', headers: request.headers, body: await request.text(), signal: request.signal }),
    panels: createPanelOperations({ admission, root: () => panelRoot }) });
  return Object.freeze({ handle, close: () => store.close() });
}
