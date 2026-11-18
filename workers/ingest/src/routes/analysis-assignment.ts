import { AnalysisAssignmentRefused, linkAnalysisAssignment, readAnalysisAssignment, readAnalysisAssignmentInput,
  reserveAnalysisAssignment, startAnalysisAssignmentDelivery, validAnalysisTaskId, type AnalysisAssignment } from '@noticeos/postgres/analysis-assignment';
import { analysisAssignmentRequest, analysisId } from '../../../../scripts/analysis-workflow-request.mjs';
import { readBoundedJsonText } from '../../../../scripts/bounded-json-body.mjs';
import type { WorkspaceContext } from '../../../../scripts/workspace-admission.mjs';
import { workspaceEntryOrigin } from '../../../../scripts/workspace-entry.mjs';
import { callNtasks } from '../ntasks.js';
import { json as response } from '../responses.js';
import { isRecord } from '../shared.js';
import { readHostedTaskConnection } from './hosted-task-service.js';

const json = (body: unknown, status = 200) => response(body, status, { 'cache-control': 'no-store' });
const assignmentReply = (assignment: AnalysisAssignment, status = assignment.taskId ? 200 : 202) => json({ assignment }, status);
type Connection = NonNullable<Awaited<ReturnType<typeof readHostedTaskConnection>>>;
type AssignmentRoute = Extract<NonNullable<ReturnType<typeof analysisAssignmentRequest>>, { workflowId: string }>;

function runLink(origin: string, route: AssignmentRoute): string {
  const url = new URL('/workflows', origin);
  url.searchParams.set('workflow', route.workflowId);
  url.searchParams.set('run', route.runId);
  return url.href;
}

/** Read back the reference through the same current project. This path never
 * posts a second task, even if the original response was lost. */
async function findExistingTask(connection: Connection, project: Connection['catalog'][number],
  route: AssignmentRoute, url: string, taskId: unknown, fetchImpl: typeof fetch): Promise<string | null> {
  const get = (path: string) => callNtasks(connection.credential.fields,
    { method: 'GET', path, workspaceId: connection.workspaceId }, fetchImpl);
  let id = taskId;
  const mentionsRun = (task: Record<string, unknown>) => typeof task.description === 'string'
    && task.description.split('\n').some(line => line === url);
  if (id === undefined) {
    const found = await get('/api/tasks/search?' + new URLSearchParams({ q: route.runId, limit: '10' }));
    if (found.status !== 200 || !isRecord(found.body) || !Array.isArray(found.body.tasks)) return null;
    const candidates = found.body.tasks.filter(task => isRecord(task) && task.project === project.logicalKey
      && validAnalysisTaskId(task.id) && mentionsRun(task));
    if (candidates.length !== 1) return null;
    id = candidates[0].id;
  }
  if (!validAnalysisTaskId(id) || !id.startsWith(project.prefix + '-')) return null;
  const matched = await get(`/api/tasks/${id}?` + new URLSearchParams({ project: project.projectId }));
  if (matched.status !== 200 || !isRecord(matched.body) || !isRecord(matched.body.task) || matched.body.task.id !== id
    || !mentionsRun(matched.body.task) || !await connection.stillCurrent()) return null;
  return id;
}

/** Customer-only task handoff. The verified human initiates it, the existing
 * Ntasks mapping limits it, and the run record reserves the one create. */
export async function handleAnalysisAssignment(request: Request, env: IngestEnv, context: WorkspaceContext,
  fetchImpl: typeof fetch = fetch): Promise<Response> {
  const route = analysisAssignmentRequest(request);
  if (!route || context.principalKind !== 'person' || !context.sessionId
    || context.action !== 'analysis.assign' || !context.allowedActions.includes('tasks.write')) return json({ error: 'person_required' }, 403);
  try {
    const connection = await readHostedTaskConnection(env, fetchImpl);
    const projects = connection?.catalog.filter(project => connection.selectedIds.has(project.projectId)
      && connection.writableProjectIds.has(project.projectId)) ?? [];
    if (route.kind === 'projects') return json({ projects: projects.map(({ projectId, displayName }) => ({ projectId, displayName })) });
    let body: unknown;
    try { body = JSON.parse(await readBoundedJsonText(request, 1024)); }
    catch { return json({ error: 'invalid_analysis_assignment' }, 400); }
    if (!isRecord(body)) return json({ error: 'invalid_analysis_assignment' }, 400);
    const store = env.STORE;
    const { workflowId, runId } = route;
    const url = runLink(workspaceEntryOrigin(env), route);
    if (route.kind === 'reconcile') {
      if (Object.keys(body).some(key => key !== 'taskId') || (body.taskId !== undefined && !validAnalysisTaskId(body.taskId)))
        return json({ error: 'invalid_analysis_assignment' }, 400);
      const assignment = await readAnalysisAssignment(store, workflowId, runId);
      if (!assignment) return json({ error: 'assignment_not_found' }, 404);
      const project = projects.find(entry => entry.projectId === assignment.projectId);
      if (!connection || !project) return json({ error: 'assignment_project_unavailable' }, 403);
      if (assignment.taskId || !assignment.deliveryStartedAt) return assignmentReply(assignment);
      const taskId = await findExistingTask(connection, project, route, url, body.taskId, fetchImpl);
      return assignmentReply(taskId
        ? await linkAnalysisAssignment(store, workflowId, runId, project.projectId, taskId)
        : assignment);
    }
    const { projectId } = body;
    if (Object.keys(body).length !== 1 || !analysisId(projectId)) return json({ error: 'invalid_analysis_assignment' }, 400);
    const project = projects.find(entry => entry.projectId === projectId);
    if (!connection || !project || !await connection.stillCurrent()) return json({ error: 'assignment_project_unavailable' }, 403);
    const input = await readAnalysisAssignmentInput(store, workflowId, runId);
    const assignment = await reserveAnalysisAssignment(store, workflowId, runId, projectId, context.principalId);
    if (assignment.deliveryStartedAt || !await connection.stillCurrent()) return assignmentReply(assignment);
    const description = [
      'Open the saved analysis run in NoticeOS.',
      url,
      `Review ${input.title} for ${input.assetIds.join(', ')}.`,
      `NoticeOS workspace ${context.workspaceId}. Runbook ${input.template} version ${input.version}. Saved inputs through ${input.asOf}.`,
      input.output,
      'Submit the sourced result in NoticeOS. This task tracks the handoff.',
    ].join('\n\n');
    const delivery = await startAnalysisAssignmentDelivery(store, workflowId, runId, projectId);
    if (!delivery) return assignmentReply((await readAnalysisAssignment(store, workflowId, runId)) ?? assignment);
    if (!await connection.stillCurrent()) return assignmentReply(delivery);
    try {
      const filed = await callNtasks(connection.credential.fields, {
        method: 'POST', path: '/api/tasks', workspaceId: connection.workspaceId, idempotencyKey: `analysis-review:${runId}`,
        onBehalfOf: `tower:${context.principalId}`, body: JSON.stringify({
          projectId, title: `Review ${input.title}`, description, type: 'task', priority: 2, labels: ['analysis-review'],
        }),
      }, fetchImpl);
      if ((filed.status === 201 || filed.status === 200) && isRecord(filed.body) && filed.body.project === project.logicalKey
        && validAnalysisTaskId(filed.body.id) && filed.body.id.startsWith(project.prefix + '-')) {
        return assignmentReply(await linkAnalysisAssignment(store, workflowId, runId, projectId, filed.body.id), 201);
      }
    } catch {
      // A lost response may already have created the task. Keep the reservation.
    }
    return assignmentReply(delivery);
  } catch (error) {
    if (error instanceof AnalysisAssignmentRefused) return json({ error: 'analysis_assignment_unavailable' }, error.status);
    return json({ error: 'analysis_assignment_unavailable' }, 503);
  }
}
