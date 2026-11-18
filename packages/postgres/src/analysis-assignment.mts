import type { WorkspaceStore } from './store.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const TASK_ID = /^[a-z0-9]+-[a-z0-9]+(?:\.[a-z0-9]+)*$/u;
export interface AnalysisAssignment {
  readonly projectId: string;
  readonly startedAt: string;
  readonly deliveryStartedAt: string | null;
  readonly taskId: string | null;
}
export interface AnalysisAssignmentInput {
  readonly template: string;
  readonly version: number;
  readonly title: string;
  readonly assetIds: string[];
  readonly asOf: string;
  readonly output: string;
}
interface AssignmentRow extends Record<string, unknown> {
  project_id: string;
  started_at: string;
  delivery_started_at: string | null;
  task_id: string | null;
}
export class AnalysisAssignmentRefused extends Error {
  override name = 'AnalysisAssignmentRefused';
  constructor(readonly status: 400 | 404 | 409) { super('Analysis assignment unavailable.'); }
}
function ids(...values: string[]): void {
  if (values.some(value => typeof value !== 'string' || !UUID.test(value))) throw new AnalysisAssignmentRefused(400);
}
function assignment(row: AssignmentRow): AnalysisAssignment {
  return { projectId: row.project_id, startedAt: new Date(row.started_at).toISOString(),
    deliveryStartedAt: row.delivery_started_at ? new Date(row.delivery_started_at).toISOString() : null, taskId: row.task_id };
}
export function validAnalysisTaskId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && TASK_ID.test(value);
}
export async function readAnalysisAssignment(store: WorkspaceStore, workflowId: string, runId: string): Promise<AnalysisAssignment | null> {
  ids(workflowId, runId);
  return store.read(async tx => {
    const [row] = await tx.query<AssignmentRow>(`
      SELECT project_id,started_at::text,delivery_started_at::text,task_id FROM noticeos.analysis_workflow_assignments
      WHERE workflow_id=$1::uuid AND run_id=$2::uuid`, [workflowId, runId]);
    return row ? assignment(row) : null;
  });
}

/** Only the saved runbook references needed for the task cross into Ntasks. */
export async function readAnalysisAssignmentInput(store: WorkspaceStore, workflowId: string, runId: string): Promise<AnalysisAssignmentInput> {
  ids(workflowId, runId);
  return store.read(async tx => {
    const [row] = await tx.query<{
      template: string; version: string; title: string; assets: string; as_of: string; output: string;
    }>(`SELECT input #>> '{runbook,id}' AS template, input #>> '{runbook,version}' AS version,
      input #>> '{runbook,title}' AS title, (input #> '{workflow,assetIds}')::text AS assets,
      input #>> '{evidence,asOf}' AS as_of, input #>> '{runbook,output}' AS output
      FROM noticeos.analysis_workflow_runs WHERE workflow_id=$1::uuid AND run_id=$2::uuid`, [workflowId, runId]);
    if (!row) throw new AnalysisAssignmentRefused(404);
    const assets: unknown = JSON.parse(row.assets);
    if (!/^[a-z0-9-]{1,64}$/u.test(row.template) || !/^[1-9][0-9]{0,5}$/u.test(row.version)
      || typeof row.title !== 'string' || !row.title || row.title.length > 120 || typeof row.output !== 'string' || row.output.length > 1_000
      || !Number.isFinite(Date.parse(row.as_of)) || !Array.isArray(assets) || assets.length < 1 || assets.length > 8
      || assets.some(asset => typeof asset !== 'string' || !/^[a-z0-9.-]{1,253}$/u.test(asset))) throw new AnalysisAssignmentRefused(409);
    return { template: row.template, version: Number(row.version), title: row.title, assetIds: assets as string[],
      asOf: new Date(row.as_of).toISOString(), output: row.output };
  });
}

/** Fixes the project before any request to create a task. */
export async function reserveAnalysisAssignment(store: WorkspaceStore, workflowId: string, runId: string,
  projectId: string, assignedBy: string): Promise<AnalysisAssignment> {
  ids(workflowId, runId, projectId, assignedBy);
  return store.write(async tx => {
    const [run] = await tx.query<{ finished: boolean; retry: boolean }>(`
      SELECT completed_at IS NOT NULL AS finished, retry_of IS NOT NULL AS retry FROM noticeos.analysis_workflow_runs
      WHERE workflow_id=$1::uuid AND run_id=$2::uuid FOR NO KEY UPDATE`, [workflowId, runId]);
    if (!run) throw new AnalysisAssignmentRefused(404);
    const [existing] = await tx.query<AssignmentRow>(`
      SELECT project_id,started_at::text,delivery_started_at::text,task_id FROM noticeos.analysis_workflow_assignments
      WHERE workflow_id=$1::uuid AND run_id=$2::uuid`, [workflowId, runId]);
    if (existing) {
      if (existing.project_id !== projectId) throw new AnalysisAssignmentRefused(409);
      return assignment(existing);
    }
    if (run.finished || run.retry) throw new AnalysisAssignmentRefused(409);
    const [row] = await tx.query<AssignmentRow>(`
      INSERT INTO noticeos.analysis_workflow_assignments
        (workspace_id,workflow_id,run_id,project_id,assigned_by)
      VALUES (noticeos.current_workspace_id(),$1::uuid,$2::uuid,$3::uuid,$4::uuid)
      RETURNING project_id,started_at::text,delivery_started_at::text,task_id`, [workflowId, runId, projectId, assignedBy]);
    if (!row) throw new AnalysisAssignmentRefused(409);
    return assignment(row);
  });
}

/** Only the caller that sets this fence can send a task creation request. */
export async function startAnalysisAssignmentDelivery(store: WorkspaceStore, workflowId: string, runId: string,
  projectId: string): Promise<AnalysisAssignment | null> {
  ids(workflowId, runId, projectId);
  return store.write(async tx => {
    const [run] = await tx.query<{ finished: boolean }>(`
      SELECT completed_at IS NOT NULL AS finished FROM noticeos.analysis_workflow_runs
      WHERE workflow_id=$1::uuid AND run_id=$2::uuid FOR NO KEY UPDATE`, [workflowId, runId]);
    if (!run || run.finished) throw new AnalysisAssignmentRefused(409);
    const [row] = await tx.query<AssignmentRow>(`
      UPDATE noticeos.analysis_workflow_assignments SET delivery_started_at=clock_timestamp()
      WHERE workflow_id=$1::uuid AND run_id=$2::uuid AND project_id=$3::uuid AND delivery_started_at IS NULL
      RETURNING project_id,started_at::text,delivery_started_at::text,task_id`, [workflowId, runId, projectId]);
    return row ? assignment(row) : null;
  });
}

/** The receiver has already verified the task in the reserved project. */
export async function linkAnalysisAssignment(store: WorkspaceStore, workflowId: string, runId: string,
  projectId: string, taskId: string): Promise<AnalysisAssignment> {
  ids(workflowId, runId, projectId);
  if (!validAnalysisTaskId(taskId)) throw new AnalysisAssignmentRefused(400);
  return store.write(async tx => {
    const args = [workflowId, runId, projectId, taskId];
    const [updated] = await tx.query<AssignmentRow>(`
      UPDATE noticeos.analysis_workflow_assignments SET task_id=$4,linked_at=clock_timestamp()
      WHERE workflow_id=$1::uuid AND run_id=$2::uuid AND project_id=$3::uuid AND task_id IS NULL AND delivery_started_at IS NOT NULL
      RETURNING project_id,started_at::text,delivery_started_at::text,task_id`, args);
    if (updated) return assignment(updated);
    const [existing] = await tx.query<AssignmentRow>(`
      SELECT project_id,started_at::text,delivery_started_at::text,task_id FROM noticeos.analysis_workflow_assignments
      WHERE workflow_id=$1::uuid AND run_id=$2::uuid AND project_id=$3::uuid AND task_id=$4`, args);
    if (!existing) throw new AnalysisAssignmentRefused(409);
    return assignment(existing);
  });
}
