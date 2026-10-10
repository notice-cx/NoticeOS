import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { readStoredSchedules } from '../../../scripts/scheduled-job-runner.mjs';
import { configStoreRequest } from '../../../scripts/config-store-client.mjs';
import { SCHEDULE_STATUS_FILE, type ScheduleStatus } from '../shared/scheduled-jobs';
import { DEFAULT_REPO_ROOT, laneMiddleware, type LaneReply, type LaneRequest } from './lane';
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
  } = {},
): Promise<LaneReply> {
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

export function scheduledJobsLane(): Plugin {
  const history = createWorkflowHistoryReader(DEFAULT_REPO_ROOT, () => readManualRuns());
  return {
    name: 'scheduled-jobs', apply: 'serve', enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(laneMiddleware({
        matches: (pathname) => pathname === '/api/scheduled-jobs' || pathname === '/api/workflows',
        handle: async (request) => {
          const response = await handleScheduledJobsRequest(request);
          const url = new URL(request.url ?? '/', 'http://localhost');
          if (url.pathname !== '/api/workflows' || response.status !== 200) return response;
          const now = Date.now();
          const result = await history(now, url.searchParams.get('run') ?? undefined, (response.body.runtime as ScheduleStatus | null)?.sessionId);
          return { status: 200, body: { ...response.body, ...result, generatedAt: new Date(now).toISOString() } };
        },
        failure: 'schedules_unavailable',
      }));
    },
  };
}
