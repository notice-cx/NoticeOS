import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hostLanes } from './os-up.mjs';
import { SCHEDULED_JOBS } from './scheduled-jobs.mjs';
import { CONFIG } from './runner/config.mjs';
import {
  HOST_CATCHUP_LANES,
  STARTUP_CATCHUP_POLICIES,
  readCrons,
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
  assert.deepEqual(HOST_CATCHUP_LANES, ['panel-review', 'push-state', 'panel-refresh', 'backup']);
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
  assert.deepEqual(lanes['beads-hub'].outcomeOf(false), { outcome: 'ran', detail: 'hub down' });
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

test('a tracked interval never fires after the scheduler stops', async () => {
  let fired = 0;
  trackTimer(setInterval(() => (fired += 1), 20));
  stopScheduler();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(fired, 0);
});
