export const ANALYSIS_WORKFLOWS_PATH = '/api/analysis-workflows';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
export const analysisId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
export type AnalysisWorkflowRequest =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'pause'; workflowId: string }
  | { kind: 'start'; workflowId: string }
  | { kind: 'run'; workflowId: string; runId: string }
  | { kind: 'complete'; workflowId: string; runId: string };

export function analysisWorkflowRequest(request: Request): AnalysisWorkflowRequest | null {
  if (!(request instanceof Request) || request.url.length > 2048) return null;
  const url = new URL(request.url);
  if (url.search || url.hash || url.username || url.password || /%|\\/u.test(url.pathname)) return null;
  const read = request.method === 'GET' && request.body === null;
  const write = request.method === 'POST';
  if (!read && !write) return null;
  if (url.pathname === ANALYSIS_WORKFLOWS_PATH) return { kind: read ? 'list' : 'create' };
  if (!url.pathname.startsWith(ANALYSIS_WORKFLOWS_PATH + '/')) return null;
  const [workflowId, next, runId, last, ...more] = url.pathname.slice(ANALYSIS_WORKFLOWS_PATH.length + 1).split('/');
  if (!analysisId(workflowId) || more.length) return null;
  if (read && next === undefined) return { kind: 'workflow', workflowId };
  if (write && next === 'pause' && runId === undefined) return { kind: 'pause', workflowId };
  if (next !== 'runs') return null;
  if (write && runId === undefined) return { kind: 'start', workflowId };
  if (!analysisId(runId)) return null;
  if (read && last === undefined) return { kind: 'run', workflowId, runId };
  if (write && last === 'complete') return { kind: 'complete', workflowId, runId };
  return null;
}

export type AnalysisAssignmentRequest =
  | { kind: 'projects' }
  | { kind: 'assign' | 'reconcile'; workflowId: string; runId: string };

export function analysisAssignmentRequest(request: Request): AnalysisAssignmentRequest | null {
  if (!(request instanceof Request) || request.url.length > 2048) return null;
  const url = new URL(request.url);
  if (url.search || url.hash || url.username || url.password || /%|\\/u.test(url.pathname)) return null;
  if (request.method === 'GET' && request.body === null && url.pathname === ANALYSIS_WORKFLOWS_PATH + '/assignments')
    return { kind: 'projects' };
  if (request.method !== 'POST' || !url.pathname.startsWith(ANALYSIS_WORKFLOWS_PATH + '/')) return null;
  const [workflowId, lane, runId, action, last, ...more] = url.pathname.slice(ANALYSIS_WORKFLOWS_PATH.length + 1).split('/');
  if (lane !== 'runs' || action !== 'assignment' || !analysisId(workflowId) || !analysisId(runId) || more.length) return null;
  if (last === undefined || last === 'reconcile') return { kind: last === undefined ? 'assign' : 'reconcile', workflowId, runId };
  return null;
}
