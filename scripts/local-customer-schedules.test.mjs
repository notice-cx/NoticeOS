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
