import assert from 'node:assert/strict';
import test from 'node:test';
import { customerScheduleClock } from './local-customer-schedules.mjs';

test('quiet minutes do no database work and the latest due window is fair across workspaces', async () => {
  const hour = Date.parse('2026-11-17T10:00:00Z');
  let now = hour - 60_000, plans = 0;
  const runs = [], errors = [];
  const clock = customerScheduleClock({ workspaces: ['large', 'small', 'idle'], now: () => now,
    async read(binding) {
      plans++;
      return binding === 'idle' ? [] : [{ job: 'counters', schedule: { enabled: true, cron: '0 * * * *' },
        assets: binding === 'large' ? ['one', 'two', 'three'] : ['only'] }];
    },
    async run(call) { runs.push(call); if (call.asset === 'two') throw new Error('provider offline'); },
    warn: () => errors.push(1),
  });
  await clock.tick();
  assert.equal(plans, 3);
  assert.equal(runs.length, 0);
  now = hour;
  await Promise.all([clock.tick(), clock.tick()]);
  await clock.whenIdle();
  assert.deepEqual(runs.map(call => call.asset), ['one', 'only', 'two', 'three']);
  assert.ok(runs.every(call => call.scheduledAt === '2026-11-17T10:00:00.000Z'));
  assert.equal(errors.length, 1);
  const reads = plans;
  for (let minute = 1; minute < 60; minute++) { now = hour + minute * 60_000; await clock.tick(); }
  assert.equal(plans, reads);
  assert.equal(runs.length, 4);
  now = hour + 3 * 3_600_000 + 120_000;
  await clock.tick();
  await clock.whenIdle();
  assert.equal(runs.length, 8);
  assert.equal(runs.at(-1).scheduledAt, '2026-11-17T13:00:00.000Z');
  await clock.close();
  now += 3_600_000;
  await clock.tick();
  assert.equal(runs.length, 8);
});

test('a slow tenant leaves a worker available to another tenant on the next tick', async () => {
  const first = Date.parse('2026-11-17T10:00:00Z');
  let now = first, release;
  const blocked = new Promise(resolve => { release = resolve; });
  let secondFinished;
  const second = new Promise(resolve => { secondFinished = resolve; });
  const seen = [];
  const clock = customerScheduleClock({ workspaces: ['backlog', 'short', 'later'], now: () => now,
    read: async tenant => [{ job: 'counters', schedule: { cron: tenant === 'later' ? '1 * * * *' : '0 * * * *', enabled: true },
      assets: tenant === 'backlog' ? ['first', 'next'] : ['only'] }],
    async run(call) {
      seen.push(call.binding + '/' + call.asset);
      if (call.binding === 'backlog' && call.asset === 'first') await blocked;
      if (call.binding === 'later') secondFinished();
    },
  });
  try {
    await clock.tick(); now += 60_000;
    await clock.tick(); await second;
    assert.deepEqual(seen, ['backlog/first', 'short/only', 'later/only']);
  } finally { release(); await clock.whenIdle(); await clock.close(); }
  assert.equal(seen.at(-1), 'backlog/next');
});

test('discovery retries only the affected workspace and resumes its current targets once', async () => {
  const due = Date.parse('2026-11-17T10:00:00Z');
  const minute = 60_000;
  let now = due - 5 * minute, stopHolding, startedHolding;
  const held = new Promise(resolve => { stopHolding = resolve; });
  const holding = new Promise(resolve => { startedHolding = resolve; });
  const recovering = { workspaceId: 'recovering' }, healthy = { workspaceId: 'healthy' };
  const reads = [], runs = [], warnings = [];
  const timed = (job, cron, assets) => ({ job, schedule: { cron, enabled: true }, assets });
  const clock = customerScheduleClock({ workspaces: [recovering, healthy], now: () => now,
    async read(binding) {
      reads.push([binding.workspaceId, now]);
      if (binding === healthy) return [timed('signal-dumps', '0 * * * *', ['same-site'])];
      if (now >= due && now < due + 3 * minute) throw new Error('Temporary configuration read failure');
      const counters = now < due ? ['holding', 'queued', 'removed'] : ['holding', 'queued'];
      return [timed('counters', '55 * * * *', counters), timed('signal-dumps', '0 * * * *', ['same-site'])];
    },
    async run({ binding, job, asset, scheduledAt }) {
      runs.push([binding.workspaceId, job, asset, Date.parse(scheduledAt)]);
      if (asset === 'holding') { startedHolding(); await held; }
    },
    warn: () => warnings.push(now),
  });
  try {
    await clock.tick();
    await holding;
    now = due;
    await clock.tick();
    assert.equal(clock.status('recovering').error, 'waiting');
    assert.equal(clock.status('healthy').error, null);
    stopHolding();
    await clock.whenIdle();
    assert.deepEqual(runs, [
      ['recovering', 'counters', 'holding', due - 5 * minute],
      ['healthy', 'signal-dumps', 'same-site', due],
    ]);
    now = due + minute;
    await clock.tick();
    now = due + 2 * minute;
    await clock.tick();
    assert.deepEqual(warnings, [due, due + minute]);
    assert.equal(runs.length, 2);
    now = due + 3 * minute;
    await clock.tick();
    await clock.whenIdle();
    assert.equal(clock.status('recovering').error, null);
    assert.deepEqual(runs.slice(2), [
      ['recovering', 'counters', 'queued', due - 5 * minute],
      ['recovering', 'signal-dumps', 'same-site', due],
    ]);
    const completed = runs.slice();
    now = due + 4 * minute;
    await clock.tick();
    await clock.whenIdle();
    assert.deepEqual(runs, completed);
    assert.deepEqual(reads.filter(([tenant]) => tenant === 'recovering').map(([, at]) => at),
      [due - 5 * minute, due, due + minute, due + 3 * minute]);
    assert.deepEqual(reads.filter(([tenant]) => tenant === 'healthy').map(([, at]) => at),
      [due - 5 * minute, due]);
  } finally {
    stopHolding();
    await clock.close();
  }
});

test('restart resumes only the latest eligible collection or backup since that schedule was activated', async () => {
  const at = Date.parse('2026-11-17T10:07:00Z');
  const selected = [
    { job: 'counters', schedule: { enabled: true, cron: '0 * * * *' }, assets: ['site'] },
    { job: 'signal-dumps', schedule: { enabled: true, cron: '45 9 * * *' }, assets: ['site'] },
    { job: 'freshness', schedule: { enabled: true, cron: '0 * * * *' }, assets: [null] },
    { job: 'backup', schedule: { enabled: true, cron: '0 4 * * *' }, assets: [null] },
  ];
  async function resumed(since, backupResumeSince) {
    const calls = [];
    const clock = customerScheduleClock({ workspaces: ['one'], now: () => at, resumeSince: since, backupResumeSince,
      read: async () => selected, run: async call => calls.push([call.job, call.scheduledAt]) });
    try { await clock.tick(); await clock.whenIdle(); }
    finally { await clock.close(); }
    return calls;
  }
  assert.deepEqual(await resumed(at - 3 * 3_600_000), [
    ['counters', '2026-11-17T10:00:00.000Z'], ['signal-dumps', '2026-11-17T09:45:00.000Z'],
  ]);
  assert.deepEqual(await resumed(at - 10 * 60_000), [['counters', '2026-11-17T10:00:00.000Z']]);
  assert.deepEqual(await resumed(undefined), []);
  assert.deepEqual(await resumed(undefined, at - 25 * 3_600_000), [['backup', '2026-11-17T04:00:00.000Z']]);
  assert.deepEqual(await resumed(undefined, at - 3_600_000), []);
});

test('a missing Google scope retries and recovers the daily window without delaying other work', async () => {
  const minute = 60_000;
  const due = Date.parse('2026-11-17T10:00:00Z');
  const workspace = { workspaceId: 'fixture' };
  let now = due, reads = 0;
  const runs = [];
  const counters = { job: 'site-counters', schedule: { enabled: true, cron: '*/15 * * * *' }, assets: ['site'] };
  const archives = { job: 'signal-dumps', schedule: { enabled: true, cron: '0 10 * * *' },
    archives: [{ asset: 'site', archive: { provider: 'ga4', report: 'events' } }] };
  const clock = customerScheduleClock({ workspaces: [workspace], now: () => now,
    async read() {
      reads++;
      if (reads === 1) return { jobs: [counters], googleScopePending: true };
      return { jobs: reads === 2 ? [counters, archives] : [counters], googleScopePending: false };
    },
    async run(call) { runs.push([call.job, call.scheduledAt]); },
  });
  const tick = async at => { now = at; await clock.tick(); await clock.whenIdle(); };
  try {
    await tick(due);
    assert.deepEqual(runs, [['site-counters', new Date(due).toISOString()]]);
    await tick(due + minute);
    assert.deepEqual(runs.at(-1), ['signal-dumps', new Date(due).toISOString()]);
    await tick(due + 2 * minute);
    assert.equal(reads, 2);
    await tick(due + 60 * minute);
    assert.deepEqual(clock.status(workspace.workspaceId).registeredJobs, ['site-counters']);
    assert.equal(runs.filter(([job]) => job === 'signal-dumps').length, 1);
  } finally { await clock.close(); }
});

test('a paused report stays listed and schedule edits only affect future runs', async () => {
  const workspace = { workspaceId: 'fixture' };
  let now = Date.parse('2026-11-17T09:04:00Z'), enabled = false, cron = '5 * * * *';
  const runs = [];
  const clock = customerScheduleClock({ workspaces: [workspace], now: () => now,
    read: async () => [{ job: 'panel-refresh', schedule: { enabled, cron }, assets: ['site'] }],
    run: async call => runs.push(call.scheduledAt),
  });
  const tick = async at => {
    now = Date.parse(at);
    await clock.tick();
    await clock.whenIdle();
    return clock.status(workspace.workspaceId);
  };
  try {
    const paused = await tick('2026-11-17T09:05:00Z');
    assert.deepEqual(paused.registeredJobs, ['panel-refresh']);
    assert.deepEqual(paused.jobs, [{ id: 'panel-refresh', enabled: false, cron, nextRun: null }]);
    assert.deepEqual(runs, []);
    enabled = true;
    const resumed = await tick('2026-11-17T10:00:00Z');
    assert.deepEqual(resumed.jobs, [{ id: 'panel-refresh', enabled: true, cron, nextRun: '2026-11-17T10:05:00.000Z' }]);
    assert.deepEqual(runs, []);
    await tick('2026-11-17T10:05:00Z');
    assert.deepEqual(runs, ['2026-11-17T10:05:00.000Z']);
    cron = '45 * * * *';
    const edited = await tick('2026-11-17T11:00:00Z');
    assert.deepEqual(edited.jobs, [{ id: 'panel-refresh', enabled: true, cron, nextRun: '2026-11-17T11:45:00.000Z' }]);
    assert.deepEqual(runs, ['2026-11-17T10:05:00.000Z']);
    await tick('2026-11-17T11:45:00Z');
    assert.deepEqual(runs, ['2026-11-17T10:05:00.000Z', '2026-11-17T11:45:00.000Z']);
  } finally { await clock.close(); }
});

test('weekly analysis retries its original occurrence on later ticks without delaying other work', async () => {
  const due = Date.parse('2026-11-17T09:59:00Z');
  const minute = 60_000;
  let now = due, paused = false;
  const transient = 'analysis-workflow-00000000-0000-4000-8000-000000000001';
  const persistent = 'analysis-workflow-00000000-0000-4000-8000-000000000002';
  const disabled = 'analysis-workflow-00000000-0000-4000-8000-000000000003';
  const weekly = (job, enabled = true) => ({ job, schedule: { enabled, cron: '59 9 * * 2' }, assets: [null] });
  const counters = { job: 'site-counters', schedule: { enabled: true, cron: '0 10 * * *' }, assets: ['site'] };
  const runs = [], attempts = new Map();
  const clock = customerScheduleClock({ workspaces: ['one', 'two'], now: () => now,
    async read(workspace) {
      if (workspace === 'two') return [weekly(disabled, !paused), counters];
      if (now === due + minute) return { jobs: [counters], analysisPending: true };
      return [weekly(transient), weekly(persistent), counters];
    },
    async run({ binding, job, scheduledAt }) {
      const attempt = (attempts.get(job) ?? 0) + 1;
      attempts.set(job, attempt);
      runs.push({ binding, job, scheduledAt, at: now });
      if (job === persistent || job === disabled || job === transient && attempt === 1) throw new Error('Synthetic read outage');
    },
    warn() {},
  });
  const tick = async (offset) => { now = due + offset * minute; await clock.tick(); await clock.whenIdle(); };
  const times = job => runs.filter(run => run.job === job).map(run => (run.at - due) / minute);
  try {
    await tick(0);
    assert.deepEqual(times(transient), [0]);
    paused = true;
    await tick(1);
    assert.deepEqual(times(transient), [0]);
    assert.deepEqual(runs.filter(run => run.job === counters.job).map(run => run.binding).sort(), ['one', 'two']);
    await tick(2);
    assert.deepEqual(times(transient), [0, 2]);
    assert.deepEqual(times(persistent), [0, 2]);
    await tick(3);
    assert.deepEqual(times(persistent), [0, 2]);
    await tick(4);
    await tick(7);
    assert.deepEqual(times(persistent), [0, 2, 4]);
    assert.deepEqual(times(disabled), [0]);
    assert.ok(runs.filter(run => run.job !== counters.job).every(run => Date.parse(run.scheduledAt) === due));
  } finally { await clock.close(); }
});
