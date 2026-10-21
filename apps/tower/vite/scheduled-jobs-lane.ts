import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { readStoredSchedules } from '../../../scripts/scheduled-job-runner.mjs';
import { configStoreRequest } from '../../../scripts/config-store-client.mjs';
import { requestLocalJob } from '../../../scripts/local-job-control.mjs';
import { SCHEDULE_STATUS_FILE, manualLocalJob, type ScheduleStatus } from '../shared/scheduled-jobs';
import { demoViewerReply, type DemoViewerDescriptor } from '../shared/demo-viewer';
import { DEFAULT_REPO_ROOT, crossOrigin, isJson, laneMiddleware, type LaneReply, type LaneRequest } from './lane';
import { createWorkflowHistoryReader } from './workflow-history';

export async function handleScheduledJobsRequest(
  request: LaneRequest,
  {
    read = readStoredSchedules,
    status = async (): Promise<ScheduleStatus | null> => {
      try { return JSON.parse(await readFile(path.join(DEFAULT_REPO_ROOT, SCHEDULE_STATUS_FILE), 'utf8')) as ScheduleStatus; }
      catch { return null; }
    },
    now = Date.now,
    runJob = (id: string) => requestLocalJob(id, { root: DEFAULT_REPO_ROOT }),
    demoViewer = null as DemoViewerDescriptor | null,
  } = {},
): Promise<LaneReply> {
  if (request.method === 'POST' && request.url === '/api/workflows') {
    const demo = demoViewerReply(demoViewer, request.method, request.url);
    if (demo) return { status: demo.status, body: demo.body as Record<string, unknown> };
    if (crossOrigin(request.headers)) return { status: 403, body: { error: 'forbidden' } };
    if (!isJson(request.headers)) return { status: 415, body: { error: 'json_required' } };
    let input: unknown;
    try { input = JSON.parse(request.body); } catch { input = null; }
    if (!input || typeof input !== 'object' || Object.keys(input).join(',') !== 'id' || !manualLocalJob((input as { id?: unknown }).id)) {
      return { status: 422, body: { error: 'local_job_not_allowed' } };
    }
    return runJob((input as { id: string }).id);
  }
  if (request.method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } };
  try {
    const [overrides, runtime] = await Promise.all([read(), status()]);
    const age = runtime ? now() - Date.parse(runtime.updatedAt) : NaN;
    return { status: 200, body: { overrides, runtime, runtimeFresh: Number.isFinite(age) && age >= 0 && age < 45_000 } };
  } catch {
    // /workflows states its own "could not be read" line beside a Retry button.
    return { status: 503, body: { error: 'schedules_unavailable' } };
  }
}

/** The manual firings the store holds, through the same operator-authed door
 * the saved schedules are read through. */
export async function readManualRuns(request: typeof configStoreRequest = configStoreRequest): Promise<unknown> {
  const result = await request('api/job-runs', {
    params: { trigger: 'manual' },
    fetchImpl: (url: string | URL | Request, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(5_000) }),
  });
  return result.status === 200 ? (result.body as { runs?: unknown })?.runs ?? [] : [];
}

export function scheduledJobsLane({ demoViewer = null }: { demoViewer?: DemoViewerDescriptor | null } = {}): Plugin {
  const history = createWorkflowHistoryReader(DEFAULT_REPO_ROOT, () => readManualRuns());
  return {
    name: 'scheduled-jobs', apply: 'serve', enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(laneMiddleware({
        matches: (pathname) => pathname === '/api/scheduled-jobs' || pathname === '/api/workflows',
        handle: async (request) => {
          const response = await handleScheduledJobsRequest(request, { demoViewer });
          const url = new URL(request.url ?? '/', 'http://localhost');
          if (request.method !== 'GET' || url.pathname !== '/api/workflows' || response.status !== 200) return response;
          const now = Date.now();
          const result = await history(now, url.searchParams.get('run') ?? undefined, (response.body.runtime as ScheduleStatus | null)?.sessionId);
          return { status: 200, body: { ...response.body, ...result, generatedAt: new Date(now).toISOString() } };
        },
        failure: 'schedules_unavailable',
      }));
    },
  };
}
