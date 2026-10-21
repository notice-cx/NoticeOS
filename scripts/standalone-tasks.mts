/** A standalone installation's task projects behind the shared hosted task
 * operations, so its local MCP (local-mcp.mjs) offers the same task tools as
 * a hosted workspace. The installation's own task client runs in each linked
 * project's folder; the planner's fixed commands, the server-chosen actor and
 * the human-decision guards are the hosted executor's.
 */
import { createHash } from 'node:crypto';
import type { TaskProjectCatalogEntry } from '../packages/postgres/src/task-directory.mjs';
import { assetDisplayName } from '../packages/contract/src/asset-name.mjs';
import type { WorkspaceAdmission } from './workspace-admission.mjs';
import type { TaskOperationExecutor } from './hosted-task-operations.mjs';
import { commentProposalMatches, createHostedTaskPlanner, decisionGuardTargets, guardedWrite, guardReadArgs, hostedTaskAction, HumanDecisionRefused,
  isHumanDecision, maintenanceSteps, TaskStoreFailed, taskStoreStepFailure, writeGuardReads, type OwnerAnswerVerifier, type HostedTaskOperation, type HostedTaskRequest } from './hosted-task-command.mjs';

/** One linked task project: where its task client runs, and its stable id. */
export interface StandaloneTaskProject {
  readonly projectId: string;
  /** The site the project is filed under: its key in the catalog, and editable. */
  readonly asset: string;
  readonly prefix: string;
  /** The project's own folder, where the task client finds its settings. */
  readonly cwd: string;
}
/** One row of the site list as the store holds it. */
export interface StandaloneSite {
  readonly id: string;
  readonly displayName: string;
  /** The installation's own row, which reads as the System whatever it stores. */
  readonly isOs: boolean | number;
}
export interface StandaloneTaskExecutorOptions {
  readonly verifyOwnerAnswer?: OwnerAnswerVerifier;
  /** All writers of a project share this reservation, including ordinary edits. */
  readonly withProjectMutation?: <T>(workspaceId: string, projectId: string, work: () => Promise<T>) => Promise<T>;
  readonly admission: WorkspaceAdmission;
  /** Read for every call, so a project linked or unlinked since is seen. */
  readonly projects: () => Promise<readonly StandaloneTaskProject[]>;
  /** Runs the task client once with these arguments in `cwd`; `timedOut` when its time ran out. */
  readonly run: (argv: readonly string[], cwd: string) => Promise<{ readonly code: number; readonly stdout: string; readonly timedOut?: boolean }>;
}
export class StandaloneTaskRefused extends Error {
  override name = 'StandaloneTaskRefused';
  constructor() { super('Task operation refused.'); }
}
function refuse(): never { throw new StandaloneTaskRefused(); }

/** A fixed UUID for a name, in the version-8 layout. */
function uuidOf(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${(8 + (parseInt(hex[16]!, 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A project's id, the same on every read: derived from its task database,
 * which no two projects share and which moving the project to another site
 * leaves unchanged. */
export function standaloneProjectId(database: string): string {
  return uuidOf(`noticeos-task-database:${database}`);
}

/** An id derived from the site `asset` instead of a database, which agents
 * may still hold. It names no project; `formerly` finds the project now filed
 * under that site. */
export function formerStandaloneProjectId(asset: string): string {
  return uuidOf(`noticeos-task-project:${asset}`);
}

/** Each site's on-screen name by id. A name is presentation only: when the
 * site list cannot be read, each project is named by its site's id instead of
 * the call being refused. */
async function siteNames(sites: () => Promise<readonly StandaloneSite[]>): Promise<ReadonlyMap<string, string>> {
  try {
    return new Map((await sites()).map(site => [site.id, assetDisplayName(site.isOs, site.displayName)]));
  } catch { return new Map(); }
}

/** The catalog the shared operations select a project from. A project is
 * named by its site's on-screen name, or by the site's id when the store holds
 * no such site. */
export function standaloneTaskDirectory(projects: () => Promise<readonly StandaloneTaskProject[]>,
  sites: () => Promise<readonly StandaloneSite[]>) {
  async function catalog(_workspaceId: string): Promise<readonly TaskProjectCatalogEntry[]> {
    const [linked, names] = await Promise.all([projects(), siteNames(sites)]);
    return Object.freeze(linked.map(project => Object.freeze({
      projectId: project.projectId, logicalKey: project.asset, displayName: names.get(project.asset) ?? project.asset,
      prefix: project.prefix })));
  }
  return Object.freeze({
    catalog,
    /** The project now filed under the site a former id was derived from, or
     * null when `projectId` is not a former id of a linked project. A former
     * id is still refused; this only names the project to use instead. */
    async formerly(workspaceId: string, projectId: string): Promise<TaskProjectCatalogEntry | null> {
      return (await catalog(workspaceId)).find(entry => formerStandaloneProjectId(entry.logicalKey) === projectId) ?? null;
    },
  });

}

export function createStandaloneTaskExecutor(options: StandaloneTaskExecutorOptions): TaskOperationExecutor {
  const { projects, run } = options;
  const admission: WorkspaceAdmission = options.admission;
  if (typeof admission?.withAdmission !== 'function' || typeof projects !== 'function' || typeof run !== 'function') refuse();
  const executor = Object.freeze({
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
          // Admitted, in a linked project: what failed is the task client itself.
          if (result.code !== 0) throw new TaskStoreFailed(result.timedOut === true, result.timedOut ? 'timeout' : 'exit');
          try { return JSON.parse(result.stdout) as unknown; } catch { throw new TaskStoreFailed(false, 'invalid-output'); }
        };
        if (operation.kind === 'maintain') {
          const read = async (id: string) => {
            const shown = await client(['--sandbox', '--readonly', '--json', 'show', '--include-dependents', '--', id]);
            const row = (Array.isArray(shown) ? shown[0] : shown) as Record<string, unknown>;
            if (row?.id !== id) refuse();
            return row;
          };
          const before = await read(operation.taskId);
          const comments = await client(['--sandbox', '--readonly', '--json', 'comments', '--', operation.taskId]);
          const duplicate = operation.duplicateOf === undefined ? undefined : await read(operation.duplicateOf);
          const history = operation.source?.startsWith('comment:') && !commentProposalMatches(operation, before, comments, [])
            ? await client(['--sandbox', '--readonly', '--json', 'history', '--limit=200', '--', operation.taskId]) : [];
          const verified = operation.action === 'answer' && operation.answerMode !== 'direct' && commentProposalMatches(operation, before, comments, history)
            && await options.verifyOwnerAnswer?.(workspaceId, request.projectId, operation, before, comments) === true;
          const steps = maintenanceSteps(operation, before, comments, context.principalId, new Date().toISOString(), duplicate, verified);
          const execute = async (step: HostedTaskOperation) => {
            admission.assertContext(context, action);
            const argv = createHostedTaskPlanner([{ workspaceId, projectId: project.projectId, capability: Symbol() }])(workspaceId,
              { projectId: project.projectId, operation: step }).argv;
            return client([argv[0]!, argv[1]!, `--actor=${context.principalId}`, ...argv.slice(2)]);
          };
          for (const step of steps) {
            try { await execute(step); } catch (error) { taskStoreStepFailure(error, step.kind); }
            if (step.kind === 'close') {
              const after = await read(operation.taskId);
              if (after.status !== 'closed') refuse();
              if (typeof after.closed_at === 'string') await execute({ kind: 'attribute', taskId: operation.taskId,
                closedBy: context.principalId, closedAt: after.closed_at, ...(operation.model ? { model: operation.model } : {}),
                ...(step.resolution ? { resolution: step.resolution } : {}), ...(step.duplicateOf ? { duplicateOf: step.duplicateOf } : {}) });
            }
          }
          return read(operation.taskId);
        }
        if (operation.kind === 'update' && operation.status === 'closed' && operation.addLabels?.includes('human')) refuse();
        const rows = new Map<string, Record<string, unknown>>(), decisions = decisionGuardTargets(operation);
        for (const taskId of writeGuardReads(operation)) {
          const shown = await client(guardReadArgs(operation, taskId));
          const row = (Array.isArray(shown) ? shown[0] : shown) as Record<string, unknown> | undefined;
          if (row?.id !== taskId) refuse();
          if (decisions.includes(taskId) && isHumanDecision(row)) throw new HumanDecisionRefused(taskId);
          rows.set(taskId, row);
        }
        const effective = guardedWrite(operation, 'taskId' in operation ? rows.get(operation.taskId) : undefined, context.principalId);
        const argv = effective === operation ? plan.argv
          : createHostedTaskPlanner([{ workspaceId, projectId: project.projectId, capability: Symbol() }])(workspaceId,
            { projectId: project.projectId, operation: effective }).argv;
        // The actor is the admitted principal, inserted before every command token.
        return client([argv[0]!, argv[1]!, `--actor=${context.principalId}`, ...argv.slice(2)]);
      });
    },
  });
  return Object.freeze({
    async execute(proof: Request, workspaceId: string, request: HostedTaskRequest) {
      const write = hostedTaskAction(request.operation) !== 'tasks.read';
      return write && options.withProjectMutation
        ? options.withProjectMutation(workspaceId, request.projectId, () => executor.execute(proof, workspaceId, request))
        : executor.execute(proof, workspaceId, request);
    },
  });
}
