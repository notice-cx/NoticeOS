import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { readJobRuns, retryOutcome, runRecordedLane } from './job-runs.mjs';

import { hostLanes } from './os-up.mjs';
import { SCHEDULED_JOBS } from './scheduled-jobs.mjs';
import { CONFIG } from './runner/config.mjs';
import {
  HOST_CATCHUP_LANES,
  STARTUP_CATCHUP_POLICIES,
  readCrons,
  retryFailedFiring,
  runWorkerLane,
  scheduledUrl,
  startupCatchupPlan,
  stopScheduler,
  trackTimer,
  waitForRuntime,
} from './runner/scheduler.mjs';

// scripts/runner/scheduler.mjs: when the lanes fire. It is
// handed the coordinator's lane table and never imports a lane itself. Nothing
// here arms the real scheduler: that reads the store through the live door.

const LOCAL_JOBS = SCHEDULED_JOBS.filter((job) => job.local).map((job) => job.id).sort();

test('the startup catch-up pays exactly four host lanes, each looked up by its job id', () => {
  assert.deepEqual(HOST_CATCHUP_LANES, ['panel-review', 'task-map', 'panel-refresh', 'backup']);
  for (const lane of HOST_CATCHUP_LANES) {
    assert.ok(LOCAL_JOBS.includes(lane), `${lane} is not a local scheduled job`);
    const policy = STARTUP_CATCHUP_POLICIES.find((candidate) => candidate.kind === lane);
    assert.equal(policy.job, lane, 'the record names the lane by its job id');
  }
});

test("the coordinator's lane table has one body for every local job, and nothing else", () => {
  const lanes = hostLanes({ running: false, ready: false });
  assert.deepEqual(Object.keys(lanes).sort(), LOCAL_JOBS);
  for (const [id, lane] of Object.entries(lanes)) {
    assert.equal(typeof lane.run, 'function', `${id} has no body`);
    if (lane.outcomeOf !== undefined) assert.equal(typeof lane.outcomeOf, 'function', `${id}'s outcome reader`);
  }
  // The task service lane records its check as the check says, skip included.
  const skipped = { outcome: 'skipped', detail: 'no task service is connected' };
  assert.deepEqual(lanes['beads-hub'].outcomeOf(skipped), skipped);
});

test('every cron the ingest declares is a scheduled job the runner knows', async () => {
  const known = new Set(SCHEDULED_JOBS.filter((job) => !job.local).map((job) => job.cron));
  const crons = await readCrons();
  assert.ok(crons.length > 0, 'workers/ingest/wrangler.jsonc names no crons');
  for (const cron of crons) assert.ok(known.has(cron), `"${cron}" fires nothing the runner schedules`);
});

test('a cron fires at the pinned ingest door', () => {
  const url = new URL(scheduledUrl('0 * * * *'));
  assert.equal(url.host, `127.0.0.1:${CONFIG.ingestPort}`);
  assert.equal(url.searchParams.get('cron'), '0 * * * *');
});

test('the catch-up plan is the shared rule with this host’s lanes among the policies', () => {
  const plan = startupCatchupPlan([], [], Date.parse('2026-09-24T12:00:00Z'));
  assert.ok(Array.isArray(plan.due) && Array.isArray(plan.excluded));
});

test('waiting for the runtime answers at once when it is up, and gives up when it is not', async () => {
  assert.equal(await waitForRuntime({ running: true, ready: true }, 1_000), true);
  const started = Date.now();
  assert.equal(await waitForRuntime({ running: true, ready: false }, 150), false);
  // Gave up rather than hung; generous for a loaded runner (issue #12).
  assert.ok(Date.now() - started < 5_000);
});

test('a tracked interval never fires after the scheduler stops', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let fired = 0;
  trackTimer(setInterval(() => (fired += 1), 20));
  stopScheduler();
  t.mock.timers.tick(80);
  assert.equal(fired, 0);
});

test('a failed weekly DataForSEO firing is fired once more ten minutes later, and both firings are recorded', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-retry-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'job-runs.jsonl');
  const job = 'cron 45 12 * * 1';
  // The door answers 500 while the app restarts, then the sweep runs.
  const answers = [{ outcome: 'failed', detail: 'HTTP 500' }, { outcome: 'ran', detail: 'HTTP 200' }];
  const record = { file, emit: () => {}, ship: async () => {} };
  const fire = (outcomeOf) => runRecordedLane(job, async () => answers.shift(), outcomeOf, record);

  const scheduled = [];
  let retried = null;
  const first = await fire((fired) => fired);
  retryFailedFiring(job, first, {
    retry: () => (retried = fire(retryOutcome((fired) => fired))),
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); return setTimeout(() => {}, 0); },
  });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 10 * 60_000);
  scheduled[0].fn();
  await retried;

  const records = await readJobRuns(file);
  assert.deepEqual(records.map((entry) => entry.outcome), ['failed', 'ran']);
  assert.match(records[1].detail, /^retry after a failed firing/);
});

test('only a failed firing of a lane that earns a retry schedules one', () => {
  const schedule = () => assert.fail('nothing should be scheduled');
  assert.equal(retryFailedFiring('cron 45 12 * * 1', { outcome: 'ran' }, { retry: () => {}, schedule }), null);
  assert.equal(retryFailedFiring('cron 45 12 * * 1', { outcome: 'skipped', detail: 'interrupted: server reloading' }, { retry: () => {}, schedule }), null);
  assert.equal(retryFailedFiring('cron 45 12 * * 1', null, { retry: () => {}, schedule }), null);
  // A daily lane's failure waits for its next regular tick.
  assert.equal(retryFailedFiring('cron 15 12 * * *', { outcome: 'failed' }, { retry: () => {}, schedule }), null);
});


test('worker manual requests pass their trigger, record once and never schedule an automatic retry', async () => {
  const job = SCHEDULED_JOBS.find(job => job.id === 'dataforseo');
  const calls = [], retries = [];
  const result = await runWorkerLane(job, {}, true, {
    fire: async (cron, runtime, trigger) => { calls.push({ cron, trigger }); return { outcome: 'failed' }; },
    record: async (name, run, outcomeOf, deps) => {
      assert.equal(name, `cron ${job.cron}`);
      assert.deepEqual(deps.trigger, { kind: 'manual' });
      return outcomeOf(await run());
    },
    scheduleRetry: (...args) => retries.push(args),
  });
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(calls, [{ cron: job.cron, trigger: 'manual' }]);
  assert.deepEqual(retries, []);
});

test('scheduled worker requests retain their automatic failure retry', async () => {
  const job = SCHEDULED_JOBS.find(job => job.id === 'dataforseo');
  let retries = 0;
  await runWorkerLane(job, {}, false, {
    fire: async (_cron, _runtime, trigger) => { assert.equal(trigger, undefined); return { outcome: 'failed' }; },
    record: async (_name, run, outcomeOf, deps) => { assert.deepEqual(deps, {}); return outcomeOf(await run()); },
    scheduleRetry: () => { retries++; },
  });
  assert.equal(retries, 1);
});


test('a manual firing does not satisfy a missed scheduled obligation', () => {
  const now = Date.parse('2026-11-06T12:30:00Z');
  const policy = { job: 'backup', expression: '0 4 * * *', kind: 'backup', maxAgeMs: 36 * 3_600_000 };
  const plan = startupCatchupPlan([], [{ job: 'backup', at: '2026-11-06T10:00:00Z', outcome: 'ran', trigger: 'manual' }], now, [policy]);
  assert.equal(plan.due.length, 1);
  assert.equal(plan.due[0].job, 'backup');
});

test('a held worker manual request returns the recorded skip instead of a false failure', async () => {
  const job = SCHEDULED_JOBS.find(job => job.id === 'freshness');
  const result = await runWorkerLane(job, {}, true, {
    record: async (_name, _run, _outcome, deps) => { deps.onRecord({ outcome: 'skipped' }); return Symbol('held'); },
    fire: async () => { throw new Error('Held execution must not run'); },
  });
  assert.deepEqual(result, { outcome: 'skipped' });
});
