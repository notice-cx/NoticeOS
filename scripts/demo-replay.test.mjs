import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchDemoReplay, parseDemoReplayArgs, retireDemoGeneration, generateNextDemo } from './demo-replay.mjs';
import { findPsql } from './postgres-dev.mjs';
import { runCommand } from './run-command.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
function deferred() { let resolve; const done = new Promise(value => { resolve = value; }); return { done, resolve }; }
async function fixture(t, overrides = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-replay-test-')));

  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const options = { currentHome: path.join(base, 'old'), nextHome: path.join(base, 'next'), control: path.join(base, 'control'), port, currentPort: 6400, nextPort: 6404, seedPort: 6410,
    seed: 'fixture', cutoff: '2026-09-30T00:00:00.000Z', release: '1'.repeat(40), binary: path.join(base, 'bd'), durationMs: 60 * 60 * 1000 };
  fs.mkdirSync(options.currentHome);
  const old = { completedAt: '2026-09-30T01:00:00.000Z' }; fs.writeFileSync(path.join(options.currentHome, 'demo-generation.json'), JSON.stringify(old));
  let time = Date.parse('2026-10-01T00:00:00.000Z'); const scheduled = []; const attempt = deferred();
  const readers = [], calls = [];
  const qualified = home => ({ id: home === options.currentHome ? A : B, completedAt: home === options.currentHome ? old.completedAt : '2026-10-01T00:02:00.000Z',
    installation: { home, postgresProject: home === options.currentHome ? 'own-a' : 'own-b', postgresPort: home === options.currentHome ? 6420 : 6412, dolt: { port: home === options.currentHome ? 6421 : 6413 } },
    source: { tree: '2'.repeat(40) }, resources: { containers: [home === options.currentHome ? A : B] } });
  const context = { root: base, env: {}, out: { write() {} }, now: () => time, clientTools: () => ({ psql: '/private/tmp/qualified-client/bin/psql', major: 18 }),
    schedule: (ms, work) => { const entry = { at: time + ms, work, active: true }; scheduled.push(entry); return () => { entry.active = false; }; },
    qualify: async home => { calls.push(['qualify', home]); return qualified(home); },
    generate: (_options, { env, maxMs }) => {
      assert.equal(fs.existsSync(path.join(options.control, 'generation-attempt.json')), true);
      assert.equal(env.HOME, path.join(options.control, 'client-home')); assert.equal(env.NODE_OPTIONS, undefined);
      assert.equal(env.DATABASE_URL, undefined); assert.equal(maxMs, 10 * 60 * 1000);
      assert.equal(env.PATH.split(':')[1], '/private/tmp/qualified-client/bin');
      calls.push(['generate']); return { done: attempt.done, pid: 123, stop: () => { calls.push(['stop-seed']); attempt.resolve({ code: 1, timedOut: true }); } };
    },
    startReader: async (generation, selectedPort) => { const stopped = deferred(); const reader = { port: selectedPort, base: `/generation/${generation.id}/`, done: stopped.done,
      stop: async () => { if (!reader.stopped) { reader.stopped = true; calls.push(['stop-reader', generation.id]); stopped.resolve(0); } } }; readers.push(reader); return reader; },
    retire: async generation => { calls.push(['retire', generation.id]); }, ...overrides };
  let replay;
  t.after(async () => { await replay?.stop(); fs.rmSync(base, { recursive: true, force: true }); });
  try { replay = await launchDemoReplay(options, context); }
  catch (error) { error.fixture = { options, readers, calls, scheduled }; throw error; }
  return { options, replay, attempt, calls, readers, qualified, oldBytes: fs.readFileSync(path.join(options.currentHome, 'demo-generation.json')),
    advance: async ms => { time += ms; for (const entry of scheduled.filter(item => item.active && item.at <= time)) { entry.active = false; await entry.work(); } },
    current: () => JSON.parse(fs.readFileSync(path.join(options.control, 'current.json'), 'utf8')) };
}
test('one successful attempt publishes only qualified completion; original visit and archive stay fixed', async t => {
  const f = await fixture(t); const first = f.replay.visits.begin(Date.parse('2026-10-01T00:00:00.000Z'));
  f.attempt.resolve({ code: 0, timedOut: false }); assert.equal((await f.replay.attempt).published, true);
  assert.equal(f.current().generation, B); assert.equal(f.current().completedAt, '2026-10-01T00:02:00.000Z');
  assert.equal(first.generation, A); assert.equal(f.readers.length, 2); assert.equal(f.calls.filter(([call]) => call === 'generate').length, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.options.currentHome, 'demo-generation.json')), f.oldBytes);
  await f.advance(15 * 60 * 1000 + 30 * 1000);
  assert.deepEqual(f.calls.filter(([call]) => call === 'retire'), [['retire', A]]);
  assert.equal(fs.existsSync(path.join(f.options.control, 'previous-retired.json')), true);
  assert.equal(f.readers[1].stopped, undefined);
  assert.equal(fs.existsSync(path.join(f.options.control, 'launcher-stopped.json')), false);
});
test('failed generation retains old publication and completion; no retry or unknown cleanup occurs', async t => {
  const f = await fixture(t); f.attempt.resolve({ code: 1, timedOut: false });
  assert.deepEqual(await f.replay.attempt, { published: false, generation: A }); assert.equal(f.current().generation, A);
  assert.equal(f.readers.length, 1); assert.equal(f.calls.filter(([call]) => call === 'generate').length, 1);
  assert.equal(f.calls.some(([call]) => call === 'retire'), false);
  assert.deepEqual(fs.readFileSync(path.join(f.options.currentHome, 'demo-generation.json')), f.oldBytes);
  assert.equal(fs.existsSync(path.join(f.options.control, 'publication-intent.json')), false);
});
test('interrupted or timed-out seed stops only its recorded group and cannot publish', async t => {
  const f = await fixture(t); await f.advance(10 * 60 * 1000);
  assert.equal((await f.replay.attempt).published, false); assert.equal(f.current().generation, A);
  assert.deepEqual(f.calls.filter(([call]) => call === 'stop-seed'), [['stop-seed']]);
  assert.equal(f.readers.length, 1); assert.equal(f.calls.some(([call]) => call === 'retire'), false);
});
test('altered publication custody refuses promotion and preserves both candidate and prior custody', async t => {
  const f = await fixture(t); fs.writeFileSync(path.join(f.options.control, 'current.json'), 'changed');
  f.attempt.resolve({ code: 0, timedOut: false }); assert.equal((await f.replay.attempt).published, false);
  assert.equal(fs.readFileSync(path.join(f.options.control, 'current.json'), 'utf8'), 'changed');
  assert.equal(f.replay.visits.state().current, A); assert.equal(f.readers[1].stopped, true);
  assert.equal(f.calls.some(([call]) => call === 'retire'), false);
});
test('uncertain retirement retains custody and stops serving rather than deleting another generation', async t => {
  const f = await fixture(t, { retire: async () => { throw new Error('changed identity'); } });
  f.attempt.resolve({ code: 0, timedOut: false }); await f.replay.attempt; await f.advance(15 * 60 * 1000 + 30 * 1000); await f.replay.finished;
  assert.equal(fs.existsSync(path.join(f.options.control, 'retirement-refused.json')), true);
  assert.equal(f.readers.every(reader => reader.stopped), true); assert.equal(f.current().generation, B);
});
test('the fixed launcher deadline interrupts an unfinished candidate and never extends with reads', async t => {
  const f = await fixture(t); const visit = f.replay.visits.begin(Date.parse('2026-10-01T00:00:00.000Z'));
  await f.advance(60 * 60 * 1000); await f.replay.finished; assert.equal((await f.replay.attempt).published, false);
  assert.equal(visit.expiresAt, Date.parse('2026-10-01T00:15:00.000Z')); assert.equal(f.current().generation, A);
  assert.equal(f.readers[0].stopped, true);
});
test('CLI refuses ambiguous or overlapping ports, selectors and unbounded lifetime', () => {
  const good = ['--current-dir', '/private/tmp/old', '--next-dir', '/private/tmp/new', '--control-dir', '/private/tmp/control', '--port', '6400', '--current-port', '6402', '--next-port', '6404', '--seed-port', '6410', '--seed', 'own', '--cutoff', '2026-09-30T00:00:00.000Z', '--release', '1'.repeat(40), '--bd-bin', '/private/tmp/bd'];
  assert.equal(parseDemoReplayArgs(good).durationMs, 12 * 60 * 60 * 1000);
  for (const args of [[], [...good, '--port', '6400'], [...good, '--unknown', '1'], [...good, '--duration-ms', 'Infinity'], good.map(value => value === '6410' ? '6402' : value)]) assert.throws(() => parseDemoReplayArgs(args));
});

test('missing or unsupported PostgreSQL client refuses before readers, target custody or generation', async () => {
  for (const client of [null, { psql: '/private/tmp/old-client/psql', major: 14 }, { psql: 'psql', major: 18 }]) {
    const hooks = [];
    try {
      await fixture({ after: work => hooks.push(work) }, { clientTools: () => client });
      assert.fail('Unsupported client acquired a launcher');
    } catch (error) {
      assert.match(error.message, /supported PostgreSQL client/u);
      assert.deepEqual(error.fixture.calls, []);
      assert.deepEqual(error.fixture.readers, []);
      assert.equal(fs.existsSync(error.fixture.options.control), false);
      assert.equal(fs.existsSync(error.fixture.options.nextHome), false);
    } finally { for (const hook of hooks.reverse()) await hook(); }
  }
});

test('the resolved prepared client remains usable in the curated generation child', async t => {
  const client = findPsql();
  if (!client) { if (process.env.NOTICEOS_REQUIRE_POSTGRES === '1') assert.fail('Required PostgreSQL client is missing'); t.skip('PostgreSQL client is unavailable'); return; }
  let transferred;
  const f = await fixture(t, { clientTools: findPsql,
    generate: (_options, { env }) => {
      assert.equal(env.PATH.includes('/unqualified/caller-tools'), false);
      assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.PGPASSWORD, undefined); assert.equal(env.DATABASE_URL, undefined);
      transferred = runCommand('psql', ['--version'], { cwd: os.tmpdir(), env, timeoutMs: 5000 });
      return { pid: null, stop() {}, done: transferred.then(result => ({ code: result.code, timedOut: result.timedOut })) };
    } });
  assert.equal((await f.replay.attempt).published, true);
  const result = await transferred;
  assert.equal(result.code, 0); assert.equal(result.stdout.trim(), client.version);
});

test('startup output or receipt failure closes the acquired gateway and reader before rejection', async t => {
  for (const defect of ['output', 'receipt']) {
    const hooks = [];
    const inner = { after: work => hooks.push(work) };
    let failure;
    try {
      await fixture(inner, {
        out: { write: () => { throw new Error('output refused'); } },
        startReader: async (generation, port) => {
          if (defect === 'receipt') fs.mkdirSync(path.join(path.dirname(generation.installation.home), 'control/current.json'));
          const ended = deferred(); const reader = { port, base: `/generation/${generation.id}/`, done: ended.done, stopped: false,
            stop: async () => { reader.stopped = true; ended.resolve(0); } };
          hooks.push(() => assert.equal(reader.stopped, true)); return reader;
        },
      });
      assert.fail('Failed startup returned a launcher');
    } catch (error) { failure = error; }
    assert.ok(failure.fixture);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(failure.fixture.options.currentHome, 'demo-generation.json'), 'utf8')), { completedAt: '2026-09-30T01:00:00.000Z' });
    assert.equal(failure.fixture.calls.some(([call]) => call === 'generate'), false);
    const check = http.createServer();
    await new Promise((resolve, reject) => { check.once('error', reject); check.listen(failure.fixture.options.port, '127.0.0.1', resolve); });
    await new Promise(resolve => check.close(resolve));
    assert.equal(failure.fixture.scheduled.some(entry => entry.active), false);
    for (const hook of hooks.reverse()) await hook();
  }
});

test('retirement requires exact resource identity and post-teardown absence, not just exit zero', async () => {
  const project = 'noticeos-start-1234567890abcdef';
  const generation = { installation: { home: '/private/tmp/own-fixture', postgresProject: project, postgresPort: 6402, dolt: { port: 6403, secretsDir: '/private/tmp/own-fixture/dolt/secrets', composeFile: '/private/tmp/public/db/dolt/host/compose.yaml' } }, resources: { containers: [A, B] } };
  for (const defect of [null, 'identity', 'survivor', 'inspection-error']) {
    const calls = [];
    const options = { root: '/private/tmp/public', env: { HOME: '/private/tmp/own-client' },
      verify: async () => ({ project, containers: defect === 'identity' ? [A, 'c'.repeat(64)] : [B, A] }),
      run: async (command, args, { timeoutMs }) => {
        assert.equal(command, 'docker'); assert.ok(timeoutMs > 0 && timeoutMs <= 120000); calls.push(args);
        if (args[0] === 'compose') { assert.equal(args[2], project); assert.deepEqual(args.slice(-2), ['down', '--volumes']); return { code: 0, stdout: '' }; }
        assert.equal(args.includes('--filter'), true); assert.equal(args.some(value => value.includes(project)), true);
        return { code: defect === 'inspection-error' ? 1 : 0, stdout: defect === 'survivor' ? A : '' };
      } };
    if (defect) await assert.rejects(retireDemoGeneration(generation, options)); else await retireDemoGeneration(generation, options);
    if (defect === 'identity') assert.equal(calls.length, 0);
    if (defect === null) assert.equal(calls.length, 8);
  }
});

test('duplicate generation stop and child exit retire the single escalation before it can signal again', async () => {
  const child = new EventEmitter(); child.pid = 123456;
  const scheduled = [], signals = [];
  const process = generateNextDemo({ nextHome: '/private/tmp/new-fixture', seedPort: 6410, seed: 'own', cutoff: '2026-09-30T00:00:00.000Z', release: '1'.repeat(40) },
    { root: '/private/tmp/public-fixture', env: {}, maxMs: 600000, spawnChild: () => child,
      killGroup: (pid, signal) => signals.push([pid, signal]), timer: (work, ms) => { const task = { work, ms, active: true }; scheduled.push(task); return task; }, clearTimer: task => { if (task) task.active = false; } });
  process.stop(); process.stop(); assert.equal(scheduled.filter(task => task.ms === 3000).length, 1);
  assert.deepEqual(signals, [[123456, 'SIGTERM']]); child.emit('close', 0); await process.done;
  assert.equal(scheduled.some(task => task.active), false); assert.deepEqual(signals, [[123456, 'SIGTERM'], [123456, 'SIGKILL']]);
  process.stop(); for (const task of scheduled) task.work();
  assert.deepEqual(signals, [[123456, 'SIGTERM'], [123456, 'SIGKILL']], 'retired callbacks and later stop cannot signal an old process group');
});

test('a byte-identical foreign publication file is refused rather than adopted', async t => {
  const f = await fixture(t), file = path.join(f.options.control, 'current.json');
  const bytes = fs.readFileSync(file); fs.renameSync(file, file + '.retained'); fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
  f.attempt.resolve({ code: 0, timedOut: false }); assert.equal((await f.replay.attempt).published, false);
  assert.equal(f.replay.visits.state().current, A); assert.deepEqual(fs.readFileSync(file + '.retained'), bytes);
  assert.equal(fs.existsSync(path.join(f.options.control, 'publication-intent.json')), false);
});
