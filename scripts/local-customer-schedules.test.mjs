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

test('restart resumes only the latest eligible free collection since activation', async () => {
  const at = Date.parse('2026-11-17T10:07:00Z');
  const selected = [
    { job: 'counters', schedule: { cron: '0 * * * *' }, assets: ['site'] },
    { job: 'signal-dumps', schedule: { cron: '45 9 * * *' }, assets: ['site'] },
    { job: 'freshness', schedule: { cron: '0 * * * *' }, assets: [null] },
  ];
  async function resumed(since) {
    const calls = [];
    const clock = customerScheduleClock({ workspaces: ['one'], now: () => at, resumeSince: since,
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
});
