import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { containerCommand } from '../deploy/compose/entrypoint.mjs';
import { invokeLocalJob, requestLocalJob, startLocalJobControl } from './local-job-control.mjs';
import { parseJobRuns } from './job-runs.mjs';
import { runLocalLane } from './runner/scheduler.mjs';
import { createScheduledJobRunner } from './scheduled-job-runner.mjs';
import { LOCAL_JOB_SOCKET, SCHEDULED_JOBS, manualLocalJob } from './scheduled-jobs.mjs';
import { actionArgs, stackControl } from './stack-control.mjs';
import { createWorkflowHistory, WORKFLOW_HISTORY_FILE } from './workflow-history.mjs';

const execute = promisify(execFile);
const selector = { project: 'synthetic-job', files: ['/fixture/compose.yaml'], envFile: '/fixture/installation.env', dockerHost: 'unix:///fixture/docker.sock' };
const barrier = () => Promise.withResolvers();

async function fixture(t, body = async () => ({ checked: 1 })) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noticeos-job-'));
  let scheduler, control;
  const pending = new Set();
  t.after(async () => {
    scheduler?.stop();
    await control?.close();
    await Promise.allSettled([...pending]);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(root, '.local'));
  const file = path.join(root, 'runs.jsonl');
  const calls = [], shipped = [], lines = [], timers = [];
  let overrides = null, readFailure = false, ready = true, stopped = false, readGate = null;
  const history = createWorkflowHistory(root);
  const deps = { file, ship: async (record) => { shipped.push(record); }, emit: (level, text) => lines.push({ level, text }),
    begin: history.beginRun };
  scheduler = createScheduledJobRunner({
    run: (job, manual) => {
      const work = runLocalLane(job.id, { run: async () => { calls.push(job.id); return body(job); } }, manual, deps);
      pending.add(work);
      void work.finally(() => pending.delete(work));
      return work;
    },
    read: async () => { await readGate?.promise; if (readFailure) throw new Error('fixture unavailable'); return overrides; },
    createTimer: (cron, callback) => { timers.push({ cron, callback }); return { stop() {}, nextRun: () => null }; },
  });
  await scheduler.refresh();
  const admission = { scheduler, ready: () => ready, stopped: () => stopped };
  control = await startLocalJobControl({ root, ...admission });
  return { root, file, calls, shipped, lines, scheduler, admission,
    request: (id) => requestLocalJob(id, { root }),
    tick: (id) => timers.find(timer => timer.cron === SCHEDULED_JOBS.find(job => job.id === id).cron).callback(),
    records: async () => parseJobRuns(await readFile(file, 'utf8')),
    pause: (id) => { overrides = { [id]: { enabled: false, cron: SCHEDULED_JOBS.find(job => job.id === id).cron } }; },
    readFailure: () => { readFailure = true; }, notReady: () => { ready = false; },
    shutdown: () => { stopped = true; scheduler.stop(); },
    blockRead: () => { readGate = barrier(); return readGate; },
  };
}

test('the stack command reaches the live scheduler from a separate CLI process and runs exactly the selected job', async (t) => {
  const own = await fixture(t);
  const dockerCalls = [];
  const run = async (command, args) => {
    assert.equal(command, 'docker');
    const index = args.indexOf('exec');
    if (index < 0) return { code: 0, stdout: JSON.stringify(['noticeos', 'postgres', 'dolt'].map((Service, i) => ({
      Project: selector.project, Service, ID: String(i + 1).repeat(64), State: 'running', Health: 'healthy',
    }))) };
    dockerCalls.push(args.slice(index));
    const mapped = containerCommand(args.slice(args.indexOf('deploy/compose/entrypoint.mjs') + 1));
    const result = await execute(process.execPath, mapped, { cwd: path.resolve(import.meta.dirname, '..'),
      env: { PATH: process.env.PATH, NOTICEOS_HOME: own.root }, timeout: 10_000 });
    assert.match(result.stdout, /Local job panel-refresh: ran/);
    return { code: 0, stdout: result.stdout };
  };
  await stackControl('run-job', selector, { args: ['--id', 'panel-refresh'], run });
  assert.deepEqual(dockerCalls, [['exec', '-T', 'noticeos', 'node', 'deploy/compose/entrypoint.mjs', 'run-job', '--id', 'panel-refresh']]);
  assert.deepEqual(own.calls, ['panel-refresh']);
  assert.deepEqual((await own.records()).map(row => [row.job, row.outcome]), [['panel-refresh', 'ran']]);
  assert.equal(own.shipped.length, 1);
  const traces = (await readFile(path.join(own.root, WORKFLOW_HISTORY_FILE), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(traces.length, 1);
  assert.deepEqual(traces[0].trigger, { kind: 'manual' });
  assert.deepEqual(traces[0].steps.map(step => step.id), ['execute', 'record']);
  assert.equal((await stat(path.join(own.root, LOCAL_JOB_SOCKET))).mode & 0o777, 0o600);
});

test('manual and scheduled execution exclude each other in both directions, while another job can run', async (t) => {
  const entered = barrier(), release = barrier();
  const own = await fixture(t, async (job) => { if (job.id === 'panel-refresh') { entered.resolve(); await release.promise; } return {}; });
  t.after(() => release.resolve());
  const scheduled = own.tick('panel-refresh');
  try {
    await entered.promise;
    assert.equal((await own.request('panel-refresh')).body.error, 'job_busy');
    assert.equal((await own.request('beads-snapshot')).status, 200);
  } finally { release.resolve(); await scheduled; }
  const secondRelease = barrier();
  const manualEntered = barrier();
  const other = await fixture(t, async () => { manualEntered.resolve(); await secondRelease.promise; return {}; });
  const manual = other.request('panel-refresh');
  try {
    await manualEntered.promise;
    await other.tick('panel-refresh');
    assert.equal((await other.request('panel-refresh')).body.error, 'job_busy');
    assert.deepEqual(other.calls, ['panel-refresh']);
  } finally { secondRelease.resolve(); await manual; }
  assert.deepEqual((await other.records()).map(row => row.outcome), ['ran']);
});

test('startup recovery and first-snapshot executions use the same exclusion as manual runs', async (t) => {
  const own = await fixture(t);
  const entered = barrier(), release = barrier();
  const recovery = own.scheduler.runOnce('beads-snapshot', { execute: async () => { entered.resolve(); await release.promise; } });
  try {
    await entered.promise;
    assert.equal((await own.request('beads-snapshot')).body.error, 'job_busy');
    assert.deepEqual(own.calls, []);
  } finally { release.resolve(); await recovery; }
  assert.equal((await own.request('beads-snapshot')).status, 200);
});

test('unknown IDs, non-local jobs, backup and arbitrary commands are rejected at every command boundary', async (t) => {
  const own = await fixture(t);
  for (const id of ['missing', 'counters', 'backup', '../panel-refresh', 'panel-refresh;id', 'constructor', '', null]) {
    assert.equal(manualLocalJob(id), null);
    assert.throws(() => actionArgs('run-job', ['--id', id]));
    assert.equal(containerCommand(['run-job', '--id', id]), null);
    assert.equal((await invokeLocalJob(id, own.admission)).status, 422);
  }
  for (const args of [['--id'], ['--id', 'panel-refresh', 'beads-snapshot'], ['panel-refresh'], ['--id', 'panel-refresh', '--', '0 * * * *']]) {
    assert.throws(() => actionArgs('run-job', args));
    assert.equal(containerCommand(['run-job', ...args]), null);
  }
  assert.deepEqual(own.calls, []);
  assert.deepEqual(containerCommand(['run-job', '0 6 * * *']), ['scripts/os-up.mjs', '--tick', '0 6 * * *']);
});

test('a saved pause and an in-progress refresh are observed before a manual request executes', async (t) => {
  const own = await fixture(t);
  own.pause('panel-refresh');
  const gate = own.blockRead();
  const refresh = own.scheduler.refresh();
  const manual = invokeLocalJob('panel-refresh', own.admission);
  gate.resolve();
  await refresh;
  assert.equal((await manual).body.error, 'job_paused');
  assert.deepEqual(own.calls, []);
});

test('unavailable settings, a down runtime and shutdown refuse new work', async (t) => {
  for (const state of ['readFailure', 'notReady', 'shutdown']) {
    const own = await fixture(t);
    own[state]();
    assert.equal((await own.request('panel-refresh')).status, 503);
    assert.deepEqual(own.calls, []);
  }
});

test('throws and returned failures retain records and release exclusion; a skipped job stays skipped', async (t) => {
  let attempt = 0;
  const own = await fixture(t, async () => {
    attempt++;
    if (attempt === 1) throw new Error('synthetic failure');
    if (attempt === 2) return { code: 1 };
    if (attempt === 3) return null;
    return {};
  });
  assert.deepEqual((await own.request('panel-refresh')).body, { job: 'panel-refresh', outcome: 'failed' });
  assert.equal((await own.request('panel-refresh')).status, 500);
  assert.equal((await own.request('panel-refresh')).body.outcome, 'skipped');
  assert.equal((await own.request('panel-refresh')).body.outcome, 'ran');
  const records = await own.records();
  assert.deepEqual(records.map(row => row.outcome), ['failed', 'ran', 'skipped', 'ran']);
  assert.equal(records[0].detail, 'synthetic failure');
  assert.deepEqual(records.map(row => row.workflowState), ['failed', 'failed', 'skipped', 'succeeded']);
  assert.equal(own.shipped.length, 4);
  assert.ok(own.lines.some(line => line.level === 'ERROR' && line.text.includes('synthetic failure')));
});

test('socket ownership is exclusive, existing files survive, and disconnected callers do not unlock a running job', async (t) => {
  const entered = barrier(), release = barrier();
  const own = await fixture(t, async () => { entered.resolve(); await release.promise; return {}; });
  await assert.rejects(startLocalJobControl({ root: own.root, ...own.admission }), /already owned/);
  const req = http.request({ socketPath: path.join(own.root, LOCAL_JOB_SOCKET), path: '/', method: 'POST' });
  req.on('error', () => {});
  req.end(JSON.stringify({ id: 'panel-refresh' }));
  try {
    await entered.promise;
    req.destroy();
    assert.equal((await own.request('panel-refresh')).body.error, 'job_busy');
  } finally { release.resolve(); }
  const root = await mkdtemp(path.join(os.tmpdir(), 'noticeos-job-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.local'));
  await writeFile(path.join(root, LOCAL_JOB_SOCKET), 'keep');
  await assert.rejects(startLocalJobControl({ root, ...own.admission }), /not a socket/);
  assert.equal(await readFile(path.join(root, LOCAL_JOB_SOCKET), 'utf8'), 'keep');
});

test('a missing supervisor fails without creating state or executing a job', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noticeos-no-job-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await requestLocalJob('panel-refresh', { root, timeoutMs: 100 })).body.error, 'runner_unavailable');
  await assert.rejects(stat(path.join(root, '.local')), { code: 'ENOENT' });
});

test('manual admission never initializes an unarmed scheduler or starts its recovery jobs', async (t) => {
  let available = false, reads = 0, ready = 0;
  const calls = [];
  const scheduler = createScheduledJobRunner({
    read: async () => { reads++; if (!available) throw new Error('fixture unavailable'); return null; },
    onReady: () => { ready++; },
    run: async (job) => { calls.push(job.id); return { outcome: 'ran' }; },
    createTimer: () => ({ stop() {}, nextRun: () => null }),
  });
  t.after(() => scheduler.stop());
  await scheduler.refresh();
  available = true;
  const admission = { scheduler, ready: () => true, stopped: () => false };
  assert.equal((await invokeLocalJob('panel-refresh', admission)).status, 503);
  assert.equal(reads, 1);
  assert.equal(ready, 0);
  assert.deepEqual(calls, []);
  await scheduler.refresh();
  assert.equal(ready, 1);
  assert.equal((await invokeLocalJob('panel-refresh', admission)).status, 200);
  assert.deepEqual(calls, ['panel-refresh']);
  assert.equal(ready, 1);
});

test('recovery waits for a held tick to finish recording without dropping its obligation', async (t) => {
  const own = await fixture(t);
  const entered = barrier(), release = barrier();
  let recovered = 0;
  const tick = own.scheduler.runOnce('panel-refresh', { execute: async () => { entered.resolve(); await release.promise; } });
  await entered.promise;
  const recovery = own.scheduler.runOnce('panel-refresh', { wait: true, execute: async () => { recovered++; } });
  try {
    assert.equal(recovered, 0);
    assert.equal((await own.request('panel-refresh')).body.error, 'job_busy');
  } finally { release.resolve(); await tick; }
  assert.equal((await recovery).status, 'ran');
  assert.equal(recovered, 1);
});

test('shutdown refuses waiting recovery and new manual work while an accepted run finishes and records', async (t) => {
  const entered = barrier(), release = barrier();
  const own = await fixture(t, async () => { entered.resolve(); await release.promise; return {}; });
  const manual = own.request('panel-refresh');
  await entered.promise;
  let recovered = false;
  const recovery = own.scheduler.runOnce('panel-refresh', { wait: true, execute: async () => { recovered = true; } });
  try {
    own.shutdown();
    assert.equal((await own.request('beads-snapshot')).status, 503);
  } finally { release.resolve(); }
  assert.equal((await manual).body.outcome, 'ran');
  assert.equal((await recovery).status, 'unavailable');
  assert.equal(recovered, false);
  assert.deepEqual((await own.records()).map(row => row.workflowState), ['succeeded']);
});
