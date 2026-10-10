import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Cron } from 'croner';
import { SCHEDULED_JOBS, cronIntervalMinutes, scheduleFor, schedulesRefusal, jobRunName } from './scheduled-jobs.mjs';
import { createScheduledJobRunner, readStoredSchedules } from './scheduled-job-runner.mjs';
import { CONFIG, STARTUP_CATCHUP_POLICIES, scheduledCatchupPolicies, startupCatchupPlan } from './os-up.mjs';
import { validateSchemaAndSafety, resolveOps, applyDocumentOps } from './config-documents.mjs';
import { WORKFLOW_DEFINITIONS } from './workflow-definitions.mjs';

const job = SCHEDULED_JOBS.find((item) => item.id === 'dataforseo');
const backup = SCHEDULED_JOBS.find((item) => item.id === 'backup');
const time = new Date('2026-09-09T12:00:00Z');
const changed = { enabled: true, cron: '15 9 * * 3' };
const paused = { ...changed, enabled: false };

test('the catalog covers every ingest trigger and preserves local defaults', async () => {
  // The ingest writes no expression of its own: each crons.ts constant reads
  // one ingest job's key from this catalog, and
  // workers/ingest/test/crons.test.ts pins wrangler.jsonc and the dispatch
  // table to the same jobs.
  const source = await readFile(new URL('../workers/ingest/src/crons.ts', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/export const \w+ = '([^']+)'/g)].map((match) => match[1]), []);
  const keyed = [...source.matchAll(/dispatchKey\('([a-z0-9-]+)'\)/g)].map((match) => match[1]);
  assert.deepEqual(keyed.sort(), SCHEDULED_JOBS.filter((item) => !item.local).map((item) => item.id).sort());
  const local = ['beadsHubCheckCron', 'beadsPollCron', 'panelFilerCron', 'pushStateCron', 'watchReadbackCron', 'beadsMapCheckCron', 'panelRefreshCron', 'backupCron'];
  assert.deepEqual(SCHEDULED_JOBS.filter((item) => item.local).map((item) => item.cron), local.map((key) => CONFIG[key]));
  assert.equal(new Set(SCHEDULED_JOBS.map((item) => item.id)).size, SCHEDULED_JOBS.length);
  for (const item of SCHEDULED_JOBS) assert.equal(schedulesRefusal({ [item.id]: scheduleFor(item) }), null);
});

test('every step a scheduled tick runs is a stage its workflow shows', async () => {
  // A step the workflow definitions do not list runs, and spends, where the
  // operator cannot see it. The ingest's steps are its dispatch table
  // (dispatch.ts `JOB_LANES`), pinned to these definitions by
  // workers/ingest/test/crons.test.ts, which can import it.
  // The Tower's own steps of a tick
  // are held to the same rule; tower-cron.ts names each one `step("<id>", …)`.
  const tower = await readFile(new URL('../apps/tower/worker/tower-cron.ts', import.meta.url), 'utf8');
  const towerSteps = [...tower.matchAll(/\bstep\("([a-z0-9-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(towerSteps, ['connection-counts', 'source-history']);
  const hourly = WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === 'freshness');
  for (const id of towerSteps) assert.ok(hourly.stages.some((stage) => stage.id === id), `Tower step "${id}" has no stage on the hourly job`);
});

test('the daily archive tick re-collects what an offline DataForSEO run skipped, as its own stage', async () => {
  // Reusing the 12:15 daily expression rather than adding one: the weekly sweep
  // keeps its own tick, and the re-collection is a second, visible step on this one.
  const archives = WORKFLOW_DEFINITIONS.find((workflow) => workflow.id === 'signal-dumps');
  assert.deepEqual(archives.stages.map((stage) => stage.id), ['config', 'archives', 'search-recovery', 'record']);
  assert.equal(archives.cron, '15 12 * * *');
  const source = await readFile(new URL('../workers/ingest/src/dispatch.ts', import.meta.url), 'utf8');
  const tick = source.slice(source.indexOf("'signal-dumps': {"), source.indexOf('posthog: {'));
  assert.match(tick, /'search-recovery': \(env, cfg\) =>\s+cfg\.dataForSeoPaused/);
  // It rides the archive job's clock, so it has to honour the DataForSEO pause itself.
  assert.match(source, /schedulePaused\(documents\['config\/constants\.json'\], 'dataforseo'\)/);
  // And it inherits the archive tick's bounded catch-up after downtime.
  assert.ok(STARTUP_CATCHUP_POLICIES.some((policy) => policy.expression === '15 12 * * *'));
});

test('schedule validation excludes unknown jobs, malformed calendars and executable text', () => {
  for (const overrides of [null, [], { backup: {} }, { unknown: changed }, { backup: { ...changed, command: 'whoami' } },
    ...['* * * * * *', '60 * * * *', '0 24 * * *', '0 9 * * 7', '0 0 31 2 *', '*/0 * * * *', '*/59 * * * *', '0 9 * * 1; whoami', '', '0 9 * * MON'].map((cron) => ({ backup: { enabled: true, cron } }))]) {
    assert.ok(schedulesRefusal(overrides), JSON.stringify(overrides));
  }
});

test('a schedule reads as its longest wait between two runs', () => {
  assert.equal(cronIntervalMinutes('*/15 * * * *'), 15);
  assert.equal(cronIntervalMinutes('10,30,50 * * * *'), 20);
  assert.equal(cronIntervalMinutes('5 * * * *'), 60);
  assert.equal(cronIntervalMinutes('0 4,16 * * *'), 720);
  assert.equal(cronIntervalMinutes('0 4 * * *'), 1440);
  // Monday then Wednesday: the wait back round to Monday is the longest.
  assert.equal(cronIntervalMinutes('0 9 * * 1,3'), 5 * 1440);
  assert.equal(cronIntervalMinutes('45 12 * * 1'), 7 * 1440);
  // Nothing the editor does not offer is read as a cadence.
  for (const cron of ['0 0 1 * *', '* * * * * *', 'not a schedule']) assert.equal(cronIntervalMinutes(cron), null, cron);
  // The counters job's default: the 15 minutes the Tower ages its cards against.
  assert.equal(cronIntervalMinutes(SCHEDULED_JOBS.find((entry) => entry.id === 'counters').cron), 15);
});

function harness() {
  const timers = [];
  const calls = [];
  const runner = createScheduledJobRunner({
    jobs: [job, backup], now: () => time,
    run: async (item) => { calls.push(jobRunName(item)); },
    createTimer: (cron, callback, timezone) => {
      const timer = { cron, callback, timezone, stopped: false, stop() { this.stopped = true; }, nextRun: () => new Date('2026-09-10T09:15:00Z') };
      timers.push(timer); return timer;
    },
  });
  return { runner, timers, calls };
}

test('changed timing retains dispatch identity, leaves other timers alone, and retires queued callbacks', async () => {
  const { runner, timers, calls } = harness();
  runner.apply({});
  const original = timers[0];
  runner.apply({ [job.id]: changed });
  assert.equal(original.stopped, true);
  assert.equal(timers[1].stopped, false);
  assert.equal(timers[2].cron, changed.cron);
  await original.callback();
  await timers[2].callback();
  assert.deepEqual(calls, ['cron 45 12 * * 1']);
  runner.apply({ [job.id]: paused });
  await timers[2].callback();
  assert.equal(calls.length, 1);
  assert.equal(runner.snapshot().jobs.find((item) => item.id === job.id).nextRun, null);
  runner.apply({});
  assert.equal(timers[3].cron, job.cron);
  runner.stop();
  await timers[3].callback();
  assert.equal(calls.length, 1);
});

test('unchanged refreshes preserve the timer and a running job cannot overlap itself', async () => {
  let finish;
  let calls = 0;
  let fire;
  let timers = 0;
  const runner = createScheduledJobRunner({ jobs: [job], run: () => { calls++; return new Promise((resolve) => { finish = resolve; }); },
    createTimer: (_cron, callback) => { timers++; fire = callback; return { stop() {}, nextRun: () => null }; } });
  runner.apply({}); runner.apply({});
  assert.equal(timers, 1);
  const first = fire();
  await fire();
  assert.equal(calls, 1);
  finish(); await first;
  runner.stop();
});

test('first read failure arms nothing; later failure preserves the acknowledged pause; recovery applies', async () => {
  let value = 'error';
  let published;
  const runner = createScheduledJobRunner({ jobs: [job], run: async () => {},
    read: async () => { if (value === 'error') throw new Error('unavailable'); return value; },
    publish: async (status) => { published = status; },
    createTimer: () => ({ stop() {}, nextRun: () => null }),
  });
  await runner.refresh();
  assert.deepEqual(published.jobs, []);
  assert.equal(published.error, 'waiting');
  value = { [job.id]: paused }; await runner.refresh();
  value = 'error'; await runner.refresh();
  assert.equal(runner.current(job.id).enabled, false);
  assert.equal(published.error, 'held');
  value = { [job.id]: changed }; await runner.refresh();
  assert.equal(runner.current(job.id).enabled, true);
  assert.equal(published.error, null);
  runner.stop();
});

test('a read completing after shutdown cannot re-arm timers or publish live status', async () => {
  let complete;
  let published = false;
  const runner = createScheduledJobRunner({ jobs: [job], run: async () => {},
    read: () => new Promise((resolve) => { complete = resolve; }), publish: async () => { published = true; },
    createTimer: () => { assert.fail('must not create a timer after shutdown'); },
  });
  const refresh = runner.refresh(); runner.stop(); complete({}); await refresh;
  assert.equal(published, false);
});

test('startup recovery waits for the first successful load and begins exactly once', async () => {
  let unavailable = true;
  const plans = [];
  const runner = createScheduledJobRunner({ jobs: [job, backup], run: async () => {},
    read: async () => { if (unavailable) throw new Error('still starting'); return { [job.id]: changed, backup: paused }; },
    createTimer: () => ({ stop() {}, nextRun: () => null }),
    onReady: () => plans.push(scheduledCatchupPolicies(STARTUP_CATCHUP_POLICIES, (id) => runner.current(id))),
  });
  await runner.refresh();
  assert.equal(plans.length, 0);
  unavailable = false;
  await runner.refresh(); await runner.refresh();
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].map((policy) => policy.job), ['cron 45 12 * * 1']);
  const plan = startupCatchupPlan([job.cron], [], time.getTime(), plans[0]);
  assert.equal(plan.due[0].scheduledAt, '2026-09-09T09:15:00.000Z');
  runner.stop();
});

test('startup recovery uses the saved time, keeps the dispatcher key and excludes paused jobs', () => {
  const overrides = { [job.id]: changed, backup: paused };
  const policies = scheduledCatchupPolicies(STARTUP_CATCHUP_POLICIES, (id) => overrides[id] ?? null);
  const plan = startupCatchupPlan(SCHEDULED_JOBS.filter((item) => !item.local).map((item) => item.cron), [], time.getTime(), policies);
  assert.equal(plan.due.length, 1);
  assert.equal(plan.due[0].job, 'cron 45 12 * * 1');
  assert.equal(plan.due[0].expression, job.cron);
  assert.equal(plan.due[0].scheduledAt, '2026-09-09T09:15:00.000Z');
  assert.deepEqual(scheduledCatchupPolicies(STARTUP_CATCHUP_POLICIES, () => null), []);
});

test('preview and scheduler agree on the next UTC weekly run', () => {
  const timer = new Cron(changed.cron, { timezone: 'UTC', paused: true });
  assert.equal(timer.nextRun(time).toISOString(), '2026-09-16T09:15:00.000Z');
  timer.stop();
});

test('the reader requires the stored document, including on unseeded and malformed responses', async () => {
  const answer = (body, status = 200) => async () => ({ status, body });
  assert.equal(await readStoredSchedules(answer({ ready: true, documents: [{ file: 'config/constants.json', body: {} }] })), null);
  assert.deepEqual(await readStoredSchedules(answer({ ready: true, documents: [{ file: 'config/constants.json', body: { schedules: { backup: paused } } }] })), { backup: paused });
  for (const body of [{ ready: false }, { ready: true, documents: [] }, { ready: true, documents: [{ file: 'config/constants.json', body: { schedules: 'bad' } }] }]) {
    await assert.rejects(() => readStoredSchedules(answer(body)));
  }
});

function changeset(op) { return { version: 1, slug: 'schedule-test', createdAt: time.toISOString(), ops: [op] }; }
test('the guarded pipeline supports first save, rejects stale edits, and undoes exactly', async () => {
  const document = { monthly_caps: { data_usd: 25 } };
  const value = { backup: paused };
  const insert = { kind: 'file-json-insert', file: 'config/constants.json', pointer: '/schedules', value };
  const cs = changeset(insert);
  validateSchemaAndSafety(cs);
  const resolved = await resolveOps(cs, null, { readDocument: async () => document });
  assert.deepEqual(resolved.mismatches, []);
  applyDocumentOps(resolved.resolved, resolved.documents);
  const stored = resolved.documents.get('config/constants.json');
  assert.deepEqual(stored, { monthly_caps: { data_usd: 25 }, schedules: value });
  const stale = changeset({ kind: 'file-json-set', file: insert.file, pointer: insert.pointer, value: {}, expect: {} });
  assert.equal((await resolveOps(stale, null, { readDocument: async () => stored })).mismatches.length, 1);
  const undo = changeset({ kind: 'file-json-delete', file: insert.file, pointer: insert.pointer, expect: value });
  validateSchemaAndSafety(undo);
  const back = await resolveOps(undo, null, { readDocument: async () => stored });
  applyDocumentOps(back.resolved, back.documents);
  assert.deepEqual(back.documents.get(insert.file), { monthly_caps: { data_usd: 25 } });
  for (const op of [ { ...insert, value: { unknown: changed } },
    { kind: 'file-json-set', file: insert.file, pointer: '/schedules/backup/cron', value: 'anything', expect: 'before' }]) {
    assert.throws(() => validateSchemaAndSafety(changeset(op)));
  }
});


test('timezone-only edits replace the timer, retire callbacks and remain in runtime status', async () => {
  const { runner, timers, calls } = harness();
  runner.apply({});
  runner.apply({ [job.id]: { enabled: true, cron: job.cron, timezone: 'America/Los_Angeles' } });
  assert.equal(timers[0].stopped, true);
  assert.equal(timers[2].timezone, 'America/Los_Angeles');
  assert.equal(runner.snapshot().jobs[0].timezone, 'America/Los_Angeles');
  await timers[0].callback();
  assert.equal(calls.length, 0);
  runner.stop();
});

test('validates IANA zones and uses them for bounded startup recovery', () => {
  assert.ok(schedulesRefusal({ backup: { ...changed, timezone: 'not/a/timezone' } }));
  assert.ok(schedulesRefusal({ backup: { ...changed, timezone: 9 } }));
  const saved = { ...changed, timezone: 'America/Los_Angeles' };
  assert.equal(schedulesRefusal({ [job.id]: saved }), null);
  const policies = scheduledCatchupPolicies(STARTUP_CATCHUP_POLICIES, (id) => id === job.id ? saved : null);
  const plan = startupCatchupPlan([job.cron], [], Date.parse('2026-09-09T17:00:00Z'), policies);
  assert.equal(plan.due[0].scheduledAt, '2026-09-09T16:15:00.000Z');
  assert.equal(plan.due[0].job, jobRunName(job));
  const timer = new Cron('0 9 * * *', { timezone: saved.timezone, paused: true });
  assert.equal(timer.nextRun(new Date('2026-10-31T17:00:00Z')).toISOString(), '2026-11-01T17:00:00.000Z');
  timer.stop();
});
