/** A standalone installation's task projects behind the shared hosted task
 * operations, so its local MCP (local-mcp.mjs) offers the same task tools as
 * a hosted workspace. The installation's own task client runs in each linked
 * project's folder; the planner's fixed commands, the server-chosen actor and
 * the human-decision guards are the hosted executor's.
 */
import { createHash } from 'node:crypto';
import type { TaskProjectCatalogEntry } from '../packages/postgres/src/task-directory.mjs';
import type { WorkspaceAdmission } from './workspace-admission.mjs';
import type { TaskOperationExecutor } from './hosted-task-operations.mjs';
import { createHostedTaskPlanner, decisionGuardTargets, hostedTaskAction, HumanDecisionRefused, isHumanDecision,
  type HostedTaskRequest } from './hosted-task-command.mjs';

/** One linked task project: where its task client runs, and its stable id. */
export interface StandaloneTaskProject {
  readonly projectId: string;
  readonly asset: string;
  readonly prefix: string;
  /** The project's own folder, where the task client finds its settings. */
  readonly cwd: string;
}
export interface StandaloneTaskExecutorOptions {
  readonly admission: WorkspaceAdmission;
  /** Read for every call, so a project linked or unlinked since is seen. */
  readonly projects: () => Promise<readonly StandaloneTaskProject[]>;
  /** Runs the task client once with these arguments in `cwd`. */
  readonly run: (argv: readonly string[], cwd: string) => Promise<{ readonly code: number; readonly stdout: string }>;
}
export class StandaloneTaskRefused extends Error {
  override name = 'StandaloneTaskRefused';
  constructor() { super('Task operation refused.'); }
}
function refuse(): never { throw new StandaloneTaskRefused(); }

/** A project's id, the same on every read: derived from its asset, which an
 * installation never reuses for another project. */
export function standaloneProjectId(asset: string): string {
  const hex = createHash('sha256').update(`noticeos-task-project:${asset}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${(8 + (parseInt(hex[16]!, 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The catalog the shared operations select a project from. */
export function standaloneTaskDirectory(projects: () => Promise<readonly StandaloneTaskProject[]>) {
  return Object.freeze({
    async catalog(_workspaceId: string): Promise<readonly TaskProjectCatalogEntry[]> {
      return Object.freeze((await projects()).map(project => Object.freeze({
        projectId: project.projectId, logicalKey: project.asset, displayName: project.asset, prefix: project.prefix })));
    },
  });
}

export function createStandaloneTaskExecutor(options: StandaloneTaskExecutorOptions): TaskOperationExecutor {
  const { projects, run } = options;
  const admission: WorkspaceAdmission = options.admission;
  if (typeof admission?.withAdmission !== 'function' || typeof projects !== 'function' || typeof run !== 'function') refuse();
  return Object.freeze({
    async execute(proof: Request, workspaceId: string, request: HostedTaskRequest): Promise<unknown> {
      const operation = request?.operation;
      const action = hostedTaskAction(operation);
      // Decisions are a person's, made in the Tower; the poll batch is the runner's.
      if (action === 'tasks.decide' || operation.kind === 'snapshot') refuse();
      return admission.withAdmission(action, { requestedWorkspaceId: workspaceId, correlationId: 'standalone-tasks' }, proof, async context => {
        const project = (await projects()).find(entry => entry.projectId === request.projectId);
        if (!project) refuse();
        const plan = createHostedTaskPlanner([{ workspaceId, projectId: project.projectId, capability: Symbol() }])(workspaceId, request);
        admission.assertContext(context, action);
        const client = async (argv: readonly string[]) => {
          const result = await run(argv, project.cwd);
          if (result.code !== 0) refuse();
          try { return JSON.parse(result.stdout) as unknown; } catch { refuse(); }
        };
        if (operation.kind === 'update' && operation.status === 'closed' && operation.addLabels?.includes('human')) refuse();
        for (const taskId of decisionGuardTargets(operation)) {
          const shown = await client(['--sandbox', '--readonly', '--json', 'show', '--', taskId]);
          const row = (Array.isArray(shown) ? shown[0] : shown) as Record<string, unknown> | undefined;
          if (row?.id !== taskId) refuse();
          if (isHumanDecision(row)) throw new HumanDecisionRefused(taskId);
        }
        // The actor is the admitted principal, inserted before every command token.
        return client([plan.argv[0]!, plan.argv[1]!, `--actor=${context.principalId}`, ...plan.argv.slice(2)]);
      });
    },
  });
}
