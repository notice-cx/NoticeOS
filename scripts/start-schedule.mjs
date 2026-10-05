// start-schedule.mjs — the schedule of an installation `pnpm start` runs
// (bead ro-ujb9.156, decision D30).
//
// The managed service's runner (scripts/os-up.mjs) fires the ingest's crons at
// its door and keeps their record under the home checkout. A started
// installation keeps collecting the same way, on its own: this fires the
// ingest's crons (workers/ingest/wrangler.jsonc triggers.crons) at ITS door with
// ITS operator token, and keeps the job-run record, the Workflows history and
// the scheduler status in ITS folder — the files its Tower reads under
// NOTICEOS_HOME (apps/tower/vite/scheduled-jobs-lane.ts, workflow-history.ts).
// It never names the managed service's door, store or `.local/`.
//
// The ingest's crons, and of the runner's host lanes only the two a started
// installation can set up itself — the task board refresh and the backup —
// once it has (scripts/start-host-lanes.mjs, bead ro-ujb9.174). The rest — the
// task hub's health, the task filers, spoke push state, the local signal
// panels — need the host the managed service runs on. Its status says
// `hostLanes: false` and lists only the jobs it runs, and the Tower then lists
// only those (apps/tower/shared/workflows.ts installedWorkflows).
//
// The same record, catch-up policy and saved schedules as the managed service
// (scripts/job-runs.mjs, scripts/scheduled-job-runner.mjs). A started
// installation is down whenever its person is not running it, so each start
// pays the latest missed obligation of every lane once, cheapest cadence first.

import fs from 'node:fs/promises';
import path from 'node:path';
import { configStoreRequest } from './config-store-client.mjs';
import { doorUrl, fireScheduledTrigger, localDoorFetch } from './ingest-door.mjs';
import {
  CRON_CATCHUP_POLICIES,
  armJobRunShipping,
  catchupOutcome,
  catchupStillArmed,
  createCatchupOwnership,
  readJobRuns,
  runRecordedLane,
  scheduledCatchupPolicies,
  scheduledDuringCatchupDecision,
  shipJobRunQueue,
  startupCatchupPlan,
} from './job-runs.mjs';
import { statePaths } from './os-runtime.mjs';
import { createScheduledJobRunner, readStoredSchedules } from './scheduled-job-runner.mjs';
import { SCHEDULED_JOBS, SCHEDULE_STATUS_FILE, jobRunName } from './scheduled-jobs.mjs';
import { WORKFLOW_SESSION_ID, createWorkflowHistory } from './workflow-history.mjs';
import { BACKUP_CATCHUP, STARTED_HOST_JOBS, TASK_BOARD_LANE, createStartedHostLanes } from './start-host-lanes.mjs';

/** How often the saved schedules are re-read and the status republished —
 * the managed runner's cadence; the Tower calls a status older than 45 s stale. */
export const SCHEDULE_REFRESH_MS = 15_000;

/** The ingest jobs a started installation runs: every cron its Worker config
 * schedules. Its host lanes are `STARTED_HOST_JOBS`, each on once set up. */
export function startedJobs(crons) {
  return SCHEDULED_JOBS.filter((job) => !job.local && crons.includes(job.cron));
}

/** Every file the schedule writes, all inside the installation's folder. */
export function schedulePaths(home) {
  const state = statePaths(home);
  return { logsDir: state.logsDir, jobRuns: state.jobRunsFile, status: path.join(home, SCHEDULE_STATUS_FILE) };
}

const HELD = Symbol('held-for-startup-catch-up');

/**
 * Arm the schedule. Called once the installation's door answers and its
 * settings are seeded; resolves after the first read of the saved schedules.
 * `stop()` disarms every timer and stops shipping.
 */
export async function startSchedule({
  home,
  door,
  token,
  crons,
  emit = () => {},
  now = Date.now,
  post = fetch,
  fire = localDoorFetch,
  taskRun = null,
  hostLanes = createStartedHostLanes({ home, door, token, emit, now, taskRun }),
  // One read of the saved settings per refresh: the schedules, and the task
  // projects that turn the task board refresh on.
  readSchedules = () => readStoredSchedules(async (route, options) => {
    const result = await configStoreRequest(route, { ...options, door, token });
    hostLanes.observe(result.body?.documents);
    return result;
  }),
  createTimer,
  refreshMs = SCHEDULE_REFRESH_MS,
}) {
  const paths = schedulePaths(home);
  await fs.mkdir(paths.logsDir, { recursive: true });
  const history = createWorkflowHistory(home);
  const records = await readJobRuns(paths.jobRuns, now());
  const jobs = [...startedJobs(crons), ...STARTED_HOST_JOBS];
  let stopped = false;

  // The door is up while this schedule is armed: pnpm start arms it after the
  // door answers and stops it before the Tower goes.
  const runtime = { running: true, ready: true };
  const shipping = { runtime: null, pending: [], skipping: null };
  armJobRunShipping(runtime, records, now(), shipping);
  const ship = (record) =>
    shipJobRunQueue(record, {
      state: shipping,
      post,
      readToken: async () => token,
      emit,
      url: doorUrl(door, 'api/job-runs'),
      stopped: () => stopped,
    });
  const lane = (job, fn, outcomeOf) =>
    runRecordedLane(job, fn, outcomeOf, { file: paths.jobRuns, emit, now, ship, begin: history.beginRun });
  const fireCron = (expr) =>
    stopped ? { outcome: 'skipped', detail: 'shutting down' } : fireScheduledTrigger(door, expr, { fetchImpl: fire, emit });

  const ownership = createCatchupOwnership();
  const regular = (job) => {
    const name = jobRunName(job);
    const decision = scheduledDuringCatchupDecision(ownership.holds(name), name);
    return lane(
      name,
      async () => {
        if (decision.run) return fireCron(job.cron);
        emit('WARN', decision.text);
        return HELD;
      },
      (result) => (result === HELD ? { outcome: decision.outcome, detail: decision.detail } : result),
    );
  };

  // A host lane that is not set up is not run and leaves no record.
  const host = (job) => {
    if (stopped || !hostLanes.runs(job.id)) return Promise.resolve(null);
    const { fn, outcomeOf } = hostLanes.run(job.id);
    return lane(job.id, fn, outcomeOf);
  };

  let catchup = Promise.resolve();
  const runner = createScheduledJobRunner({
    jobs,
    run: (job) => (job.local ? host(job) : regular(job)),
    read: async () => {
      const overrides = await readSchedules();
      await hostLanes.refresh();
      return overrides;
    },
    ...(createTimer ? { createTimer } : {}),
    now: () => new Date(now()),
    onReady: () => {
      catchup = catchUp().catch((error) => emit('ERROR', `startup catch-up failed: ${error?.message ?? error}`));
    },
    publish: async (status) => {
      await history.publishHeartbeat();
      const listed = status.jobs.filter((job) => !STARTED_HOST_JOBS.some((hostJob) => hostJob.id === job.id) || hostLanes.runs(job.id));
      await fs.writeFile(`${paths.status}.tmp`, JSON.stringify({ ...status, jobs: listed, sessionId: WORKFLOW_SESSION_ID, hostLanes: false }));
      await fs.rename(`${paths.status}.tmp`, paths.status);
    },
  });

  async function catchUp() {
    const policies = scheduledCatchupPolicies(
      [...CRON_CATCHUP_POLICIES, ...(hostLanes.runs(BACKUP_CATCHUP.job) ? [BACKUP_CATCHUP] : [])],
      (id) => runner.current(id),
    );
    const plan = startupCatchupPlan(crons, records, now(), policies);
    const unknown = plan.excluded.filter((item) => item.reason.startsWith('unknown cron'));
    if (unknown.length > 0) {
      emit('WARN', `startup catch-up excluded ${unknown.length} unknown cron(s): ${unknown.map((item) => item.expression).join(', ')}`);
    }
    if (plan.due.length === 0) return;
    ownership.own(plan.due.map((item) => item.job));
    emit('INFO', `startup catch-up: ${plan.due.length} latest obligation(s), cheapest cadence first`);
    try {
      for (const item of plan.due) {
        if (stopped) break;
        try {
          const job = SCHEDULED_JOBS.find((candidate) => jobRunName(candidate) === item.job);
          if (!catchupStillArmed(item, job && runner.current(job.id))) continue;
          if (item.kind === 'backup') {
            const { fn, outcomeOf } = hostLanes.run(item.job);
            await lane(item.job, fn, catchupOutcome(outcomeOf, item.scheduledAt));
          } else await lane(item.job, () => fireCron(item.expression), catchupOutcome((result) => result, item.scheduledAt));
        } finally {
          ownership.release(item.job);
        }
      }
    } finally {
      ownership.clear();
    }
  }

  await runner.refresh();
  // Seed the first task photograph through the normal own-project lane before
  // Home is announced ready; later refreshes retain the saved schedule.
  const taskJob = STARTED_HOST_JOBS.find(job => job.id === TASK_BOARD_LANE);
  if (taskJob && hostLanes.runs(TASK_BOARD_LANE)) await host(taskJob);
  const refresh = setInterval(() => {
    void runner.refresh().catch(() => emit('ERROR', 'could not publish scheduler status'));
  }, refreshMs);
  refresh.unref?.();
  emit('INFO', `schedule: ${jobs.length} job(s) at ${door}; saved schedules re-read every ${Math.round(refreshMs / 1000)} s`);

  return {
    runner,
    /** The startup catch-up pass, once the first read armed the schedule. */
    catchup: () => catchup,
    stop() {
      stopped = true;
      runtime.running = false;
      clearInterval(refresh);
      runner.stop();
    },
  };
}
