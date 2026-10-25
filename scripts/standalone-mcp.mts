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
import { LOCAL_CONNECTION_VARIABLE } from './database-address.mjs';
import { createHostedMcp, MCP_PATH } from './hosted-mcp.mjs';
import { createHostedTaskOperations, type HostedTaskOperations } from './hosted-task-operations.mjs';
import { createStandaloneTaskExecutor, standaloneProjectId, standaloneTaskDirectory,
  type StandaloneSite, type StandaloneTaskProject } from './standalone-tasks.mjs';
import { taskChildEnvironment, type TaskClientEnvironment } from './task-client.mjs';
import { readTaskProjects, taskProjectDirectory, type TaskProject } from './task-project-config.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createBrowserRequestPolicy } from './browser-request-policy.mjs';
import { createPanelOperations } from './panel-mcp.mjs';
import { PANEL_REPORTS_ROOT } from './signal-panel-paths.mjs';
import type { OwnerAnswerVerifier } from './hosted-task-command.mjs';

/** The origin every request to the endpoint is addressed to, whatever carried it. */
export const STANDALONE_MCP_ORIGIN = 'http://localhost';
/** Names the agent a request acts as; without it, `agent`. */
export const ACTOR_HEADER = 'x-noticeos-actor';
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** How long one read of the linked projects, or of the site list, serves the calls after it. */
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
    const projects = Object.freeze((await read()).flatMap(project => !project.unavailableReason && project.database && (project.cwd || project.repo)
      ? [Object.freeze({ projectId: standaloneProjectId(project.database), asset: project.asset, prefix: project.prefix, cwd: taskProjectDirectory(project, root), identityCwd: project.repo ? path.resolve(root, project.repo) : root })] : []));
    cached = { at: now(), projects };
    return projects;
  };
}

type SiteRow = { id: string; displayName: string; isOs: boolean };

/** The site list the Tower names sites from (apps/tower/worker/asset-registry.ts),
 * for the task projects' names. A failed read is not kept. */
export function storeSites(store: Pick<PostgresStore, 'inWorkspace'>, workspaceId: string, now: () => number = Date.now):
  () => Promise<readonly StandaloneSite[]> {
  let cached: { at: number; sites: readonly StandaloneSite[] } | null = null;
  return async () => {
    if (cached && now() - cached.at < PROJECTS_TTL_MS) return cached.sites;
    const sites = Object.freeze(await store.inWorkspace(workspaceId, tx => tx.query<SiteRow>(
      'SELECT asset_id AS id, display_name AS "displayName", is_os AS "isOs" FROM noticeos.assets'), { readOnly: true }));
    cached = { at: now(), sites };
    return sites;
  };
}

/** One task client command in a project's folder, with the declared task client, bounded in time and output. */
export function runTaskClient(argv: readonly string[], cwd: string, env: TaskClientEnvironment = process.env, timeout = 30_000):
  Promise<{ readonly code: number; readonly stdout: string; readonly timedOut: boolean }> {
  return new Promise(resolve => {
    execFile(env.BEADS_BD_BIN ?? 'bd', [...argv], { cwd, env: taskChildEnvironment(env), timeout, maxBuffer: 32 * 1024 ** 2,
      encoding: 'utf8' }, (error, stdout) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      // Node kills the client when its time runs out, and when its output overflows.
      const timedOut = error !== null && error.killed === true && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      resolve({ code, stdout, timedOut });
    });
  });
}

export interface StandaloneMcp {
  /** Answers one MCP POST addressed to STANDALONE_MCP_ORIGIN + MCP_PATH. */
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}
export interface StandaloneMcpOptions {
  /** Trusted linked-conversation source adapter, absent when none is connected. */
  readonly ownerAnswers?: OwnerAnswerVerifier;
  readonly databaseUrl?: string;
  /** Tests supply a store and receipts instead of a database. */
  readonly store?: Pick<PostgresStore, 'onlyWorkspace' | 'inWorkspace' | 'close'>;
  readonly receipts?: TaskReceipts;
  readonly projects?: () => Promise<readonly StandaloneTaskProject[]>;
  readonly run?: (argv: readonly string[], cwd: string) => Promise<{ readonly code: number; readonly stdout: string }>;
  /** Where the Tower answers its read-model MCP calls. */
  readonly tower?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Where the installation publishes its site panels; tests name a fixture. */
  readonly panelRoot?: string;
}

/** Shared by the standalone Tower and MCP writers, across processes. */
export function withStandaloneTaskMutation<T>(store: Pick<PostgresStore, 'inWorkspace'>, workspaceId: string, work: () => Promise<T>): Promise<T> {
  return store.inWorkspace(workspaceId, async tx => {
    const [lock] = await tx.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired', [`noticeos-task-mutations:${workspaceId}`]);
    if (lock?.acquired !== true) throw new Error('Tasks are being changed; retry this same request.');
    return work();
  });
}

/** The local Tower opens the selected installation only while handling a write. */
export async function withLocalTaskMutation<T>(work: () => Promise<T>): Promise<T> {
  const store = openStore(process.env[LOCAL_CONNECTION_VARIABLE] ?? '', { maxConnections: 1 });
  try { return await withStandaloneTaskMutation(store, await store.onlyWorkspace(), work); }
  finally { await store.close(); }
}

/** The installation's task operations, shared by MCP and automatic filing. */
export async function openStandaloneTasks(options: StandaloneMcpOptions): Promise<{
  readonly admission: ReturnType<typeof createWorkspaceAdmission>; readonly operations: HostedTaskOperations; readonly workspaceId: string; close(): Promise<void>;
}> {
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
  const operations = createHostedTaskOperations({ admission, directory: standaloneTaskDirectory(projects, storeSites(store, workspaceId)),
    executor: createStandaloneTaskExecutor({ admission, projects, run: options.run ?? ((argv, cwd) => runTaskClient(argv, cwd)),
      withProjectMutation: (workspace, _project, work) => withStandaloneTaskMutation(store, workspace, work),
      verifyOwnerAnswer: async (workspace, projectId, operation, task, comments) => {
        if (!operation.source?.startsWith('comment:')) return await options.ownerAnswers?.(workspace, projectId, operation, task, comments) === true;
        const project = (await projects()).find(entry => entry.projectId === projectId);
        if (!project) return false;
        // The Tower records a standalone person's comments with this same local identity.
        const owner = await new Promise<string>(resolve => execFile('git', ['config', 'user.name'], { cwd: project.identityCwd ?? project.cwd, timeout: 2000,
          encoding: 'utf8', maxBuffer: 4096 }, (error, stdout) => resolve(error ? '' : stdout.trim())));
        return owner !== '' && operation.owner === owner;
      } }),
    receipts: options.receipts ?? taskReceipts(opened!) });
  return Object.freeze({ admission, operations, workspaceId, close: () => store.close() });
}

export async function openStandaloneMcp(options: StandaloneMcpOptions): Promise<StandaloneMcp> {
  const { admission, operations, workspaceId, close } = await openStandaloneTasks(options);
  const tower = options.tower ?? DEFAULT_TOWER_ORIGIN, fetch = options.fetch ?? globalThis.fetch;
  const panelRoot = options.panelRoot ?? PANEL_REPORTS_ROOT;
  const handle = createHostedMcp({ profile: 'standalone', trustedOrigin: STANDALONE_MCP_ORIGIN, standaloneWorkspaceId: workspaceId,
    operations, readModels: async request => fetch(tower + MCP_PATH,
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
  return Object.freeze({ handle, close });
}
