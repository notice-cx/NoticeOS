// runner/scheduler.mjs — when the local runner's lanes fire. It arms every
// scheduled job from the saved schedules (scripts/scheduled-job-runner.mjs),
// fires the ingest's crons at this runner's own door, holds a lane while the
// one bounded startup catch-up pays its missed obligation, and fires the first
// task-board snapshot as soon as the runtime is ready.
//
// It does not know what a lane does. scripts/os-up.mjs hands it a table of lane
// bodies by job id — `{ run, outcomeOf? }`, where the default outcome reads a
// null result as skipped — and the scheduler decides only when each runs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fireScheduledTrigger, scheduledTriggerUrl } from '../ingest-door.mjs';
import {
  CRON_CATCHUP_POLICIES,
  catchupOutcome,
  catchupStillArmed,
  createCatchupOwnership,
  scheduledCatchupPolicies,
  scheduledDuringCatchupDecision,
  startupCatchupPlan as cronCatchupPlan,
} from '../job-runs.mjs';
import { workerCrons } from '../os-runtime.mjs';
import { createScheduledJobRunner } from '../scheduled-job-runner.mjs';
import { SCHEDULED_JOBS, SCHEDULE_STATUS_FILE, jobRunName } from '../scheduled-jobs.mjs';
import { publishWorkflowHeartbeat, WORKFLOW_SESSION_ID } from '../workflow-history.mjs';
import { CONFIG, HOME_ROOT, INGEST_WRANGLER } from './config.mjs';
import { cronFireDecision, runtimeDoorOwnership } from './door-ownership.mjs';
import { REGULAR_LANE_HELD, runJobLane } from './job-record.mjs';
import { isShuttingDown } from './lifecycle.mjs';
import { log } from './log.mjs';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Recovery is explicit per lane (scripts/job-runs.mjs CRON_CATCHUP_POLICIES):
 * the ingest's crons, then this host's own lanes.
 */
export const STARTUP_CATCHUP_POLICIES = [
  ...CRON_CATCHUP_POLICIES,
  { job: 'panel-review', expression: CONFIG.panelFilerCron, kind: 'panel-review', maxAgeMs: 2 * HOUR_MS },
  { job: 'push-state', expression: CONFIG.pushStateCron, kind: 'push-state', maxAgeMs: 2 * HOUR_MS },
  { job: 'panel-refresh', expression: CONFIG.panelRefreshCron, kind: 'panel-refresh', maxAgeMs: 36 * HOUR_MS },
  { job: 'backup', expression: CONFIG.backupCron, kind: 'backup', maxAgeMs: 36 * HOUR_MS },
];

/** The host lanes the startup catch-up may pay, each named by its policy's
 * kind, which is also its job id in the lane table. Every other kind is a
 * cron fire. */
export const HOST_CATCHUP_LANES = STARTUP_CATCHUP_POLICIES
  .filter((policy) => policy.kind !== 'cron')
  .map((policy) => policy.kind);

/** The one bounded startup pass (scripts/job-runs.mjs startupCatchupPlan),
 * with this host's own lanes among the policies. */
export function startupCatchupPlan(configuredCrons, records, nowMs = Date.now(), policies = STARTUP_CATCHUP_POLICIES) {
  return cronCatchupPlan(configuredCrons, records, nowMs, policies);
}

// ─────────────────────────────────────────────────────────────────────────────
// JSONC → crons (scripts/os-runtime.mjs workerCrons). Anything unreadable
// degrades to [] with one ERROR line.
// ─────────────────────────────────────────────────────────────────────────────
export async function readCrons() {
  try {
    return workerCrons(await fs.readFile(INGEST_WRANGLER, 'utf8'));
  } catch (err) {
    log('ERROR', `could not read crons from ${INGEST_WRANGLER}: ${err.message}`);
    return [];
  }
}

// Which lanes the one startup catch-up pass currently owns
// (scripts/job-runs.mjs createCatchupOwnership).
const startupCatchupOwnership = createCatchupOwnership();
const cronJobs = [];
// setInterval handles that are not crons (currently only the first-snapshot
// armer). Cleared on shutdown so a pending one cannot hold the process open.
const oneShotTimers = new Set();

/** Hand the scheduler an interval to clear on shutdown. */
export function trackTimer(timer) {
  oneShotTimers.add(timer);
}

/** Stop every scheduled job and clear every tracked interval (the shutdown). */
export function stopScheduler() {
  for (const job of cronJobs) {
    try {
      job.stop();
    } catch {
      // ignore
    }
  }
  for (const timer of oneShotTimers) clearInterval(timer);
  oneShotTimers.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler — fire each ingest cron (UTC) against the local scheduled endpoint.
// A non-200 or fetch failure is an ERROR line but never crashes the runner.
// Firing is skipped while the runtime is down/restarting or while the door
// belongs to another runner (runner/door-ownership.mjs). Startup recovery
// separately pays at most the latest missed obligation per allowlisted lane;
// see startupCatchupPlan.
//
// The URL is unchanged from when the ingest was its own `wrangler dev`: the
// tower's loopback ingest door answers `/cdn-cgi/handler/scheduled` at the same
// address and hands it to the ingest Worker's cron dispatch over the private
// Service Binding (apps/tower/vite/runner-door.ts, apps/tower/shared/runner-lane.ts).
// ─────────────────────────────────────────────────────────────────────────────
const MANAGED_DOOR_URL = `http://127.0.0.1:${CONFIG.ingestPort}`;
export function scheduledUrl(expr) {
  return scheduledTriggerUrl(MANAGED_DOOR_URL, expr);
}

/** `runtime` is the child whose workerd hosts the ingest — the tower. One
 * process now serves both Workers, so its readiness is the ingest's — but
 * readiness alone is not permission to fire (see runner/door-ownership.mjs). */
async function fireScheduled(expr, runtime) {
  if (isShuttingDown()) return { outcome: 'skipped', detail: 'shutting down' };

  // Only ask who owns the door once the child is up: a subprocess per tick is
  // cheap, a subprocess per tick against a dead child is waste.
  const ownership =
    runtime.running && runtime.ready ? await runtimeDoorOwnership(runtime) : null;
  const decision = cronFireDecision(
    { running: runtime.running, ready: runtime.ready, ownership },
    expr,
  );
  if (decision.level) log(decision.level, decision.text);
  if (!decision.fire) return { outcome: decision.outcome, detail: decision.detail };

  return fireScheduledTrigger(MANAGED_DOOR_URL, expr, { emit: log });
}

let scheduledJobRunner = null;

/**
 * Arm the scheduler for `runtime`. `lanes` is the table of host lane bodies by
 * job id; `onPublished(status)` runs after each published schedule status (the
 * coordinator records whether the scheduler is armed). Returns the scheduled
 * job runner, whose `snapshot()` says what is armed.
 */
export async function startScheduler(runtime, records, { lanes, onPublished }) {
  const crons = await readCrons();
  const configured = new Set(crons);
  const jobs = SCHEDULED_JOBS.filter((job) => job.local || configured.has(job.cron));
  const localRuns = Object.fromEntries(
    Object.entries(lanes).map(([id, lane]) => [id, () => runRegularLane(id, lane.run, lane.outcomeOf)]),
  );
  scheduledJobRunner = createScheduledJobRunner({
    jobs,
    run: (job) => job.local
      ? localRuns[job.id]()
      : runRegularLane(jobRunName(job), () => fireScheduled(job.cron, runtime), (result) => result),
    onReady: () => {
      fireFirstBeadsPoll(runtime, lanes);
      // An initially unavailable store must delay recovery, not discard it.
      // Do not await recovery: refreshes must still observe pauses while it runs.
      void runStartupCatchups(runtime, records, crons, lanes).catch((error) => {
        log('ERROR', `startup catch-up failed: ${error?.message ?? error}`);
      });
    },
    publish: async (status) => {
      await publishWorkflowHeartbeat();
      const destination = path.join(HOME_ROOT, SCHEDULE_STATUS_FILE);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(`${destination}.tmp`, JSON.stringify({ ...status, sessionId: WORKFLOW_SESSION_ID }));
      await fs.rename(`${destination}.tmp`, destination);
      await onPublished(status);
    },
  });
  cronJobs.push(scheduledJobRunner);
  // Read the authoritative store only once the runtime can answer. A failure
  // arms no defaults that could undo an operator's saved pause.
  await waitForRuntime(runtime);
  await scheduledJobRunner.refresh();
  const refresh = setInterval(() => {
    void scheduledJobRunner.refresh().catch(() => log('ERROR', 'could not publish scheduler status'));
  }, 15_000);
  oneShotTimers.add(refresh);
  log('INFO', `scheduler: ${jobs.length} known jobs; saved schedules refreshed every 15 seconds (UTC)`);
  return scheduledJobRunner;
}

function runRegularLane(job, fn, outcomeOf = (result) => (result === null ? 'skipped' : 'ran')) {
  const decision = scheduledDuringCatchupDecision(startupCatchupOwnership.holds(job), job);
  return runJobLane(
    job,
    () => {
      if (!decision.run) {
        log('WARN', decision.text);
        return REGULAR_LANE_HELD;
      }
      return fn();
    },
    (result) =>
      result === REGULAR_LANE_HELD
        ? { outcome: decision.outcome, detail: decision.detail }
        : outcomeOf(result),
  );
}

export async function waitForRuntime(runtime, timeoutMs = CONFIG.readyGraceMs + 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!isShuttingDown() && Date.now() < deadline) {
    if (runtime.running && runtime.ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return runtime.running && runtime.ready;
}

/**
 * Run at most one latest missed obligation per allowlisted lane, sequentially.
 *
 * Sequential means the catch-up FIRINGS do not overlap each other; it does not
 * mean the machine stops. Only the lanes in the plan hold their regular tick,
 * and each is released as soon as its own catch-up firing is done.
 */
async function runStartupCatchups(runtime, records, configuredCrons, lanes, nowMs = Date.now()) {
  try {
    const policies = scheduledCatchupPolicies(STARTUP_CATCHUP_POLICIES,
      (id) => scheduledJobRunner?.current(id));
    const plan = startupCatchupPlan(configuredCrons, records, nowMs, policies);
    const unknown = plan.excluded.filter((item) => item.reason.startsWith('unknown cron'));
    if (unknown.length > 0) {
      log(
        'WARN',
        `startup catch-up excluded ${unknown.length} unknown cron(s): ${unknown.map((item) => item.expression).join(', ')}`,
      );
    }
    if (plan.due.length === 0) {
      log('INFO', 'startup catch-up: no bounded missed obligations');
      return;
    }
    // Claim the planned lanes before the wait, so an owed lane cannot tick
    // ahead of its own recovery while the runtime is still coming up.
    startupCatchupOwnership.own(plan.due.map((item) => item.job));
    if (!(await waitForRuntime(runtime))) {
      log('WARN', `startup catch-up: ${plan.due.length} obligation(s) due, but runtime did not become ready`);
      return;
    }

    log(
      'INFO',
      `startup catch-up: ${plan.due.length} latest obligation(s), sequential and at most once per lane, cheapest cadence first ` +
        `(${plan.due.map((item) => item.job).join(', ')}) — only those lane(s) hold their regular tick; every other lane ticks normally`,
    );
    for (const item of plan.due) {
      if (isShuttingDown()) break;
      // Whatever happens to this firing — a throw, a skip, a normal return —
      // the lane goes straight back to its own schedule.
      try {
        const job = SCHEDULED_JOBS.find((candidate) => jobRunName(candidate) === item.job);
        const current = job && scheduledJobRunner?.current(job.id);
        // A save during catch-up must also retire the obligation already queued.
        if (!catchupStillArmed(item, current)) continue;
        log('INFO', `startup catch-up: ${item.job} missed ${item.scheduledAt}`);
        const defaultOutcome = (result) => (result === null ? 'skipped' : 'ran');
        if (item.kind === 'cron') {
          await runJobLane(
            item.job,
            () => fireScheduled(item.expression, runtime),
            catchupOutcome((result) => result, item.scheduledAt),
          );
        } else if (HOST_CATCHUP_LANES.includes(item.kind)) {
          const lane = lanes[item.kind];
          await runJobLane(
            item.job,
            () => lane.run(),
            catchupOutcome(lane.outcomeOf ?? defaultOutcome, item.scheduledAt),
          );
        }
      } finally {
        startupCatchupOwnership.release(item.job);
      }
    }
  } finally {
    startupCatchupOwnership.clear();
    log('INFO', 'startup catch-up complete — regular schedules own subsequent ticks');
  }
}

/** Fire the first snapshot the moment ingest can accept one, instead of leaving
 * the board a minute stale after every restart. If ingest has not come up by
 * the time the regular tick would have covered it anyway, this gives up
 * silently — it is an optimization, not a second scheduler. */
function fireFirstBeadsPoll(runtime, lanes) {
  const deadline = Date.now() + CONFIG.readyGraceMs * 2;
  const timer = setInterval(() => {
    if (isShuttingDown() || Date.now() > deadline) {
      clearInterval(timer);
      oneShotTimers.delete(timer);
      return;
    }
    if (!runtime.running || !runtime.ready) return;
    if (!scheduledJobRunner?.current('beads-snapshot')?.enabled) return;
    clearInterval(timer);
    oneShotTimers.delete(timer);
    // Through the same lane wrapper as the scheduled poll: this IS the beads
    // snapshot lane firing, and a record that skipped the first one after every
    // restart would understate how often it runs.
    void runJobLane('beads-snapshot', () => lanes['beads-snapshot'].run());
  }, 500);
  oneShotTimers.add(timer);
}
