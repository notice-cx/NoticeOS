// The schedule of an installation `pnpm start` runs: the
// ingest's crons, fired at that installation's door, recorded in its folder,
// shipped to its store — and none of the NoticeOS stack's host lanes.
//
// Driven against a fake door on loopback, so each assertion is about where a
// request or a file actually went. scripts/start.test.mjs proves the same on a
// real start, with a tripwire on the checkout.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseJobRuns } from './job-runs.mjs';
import { workerCrons } from './os-runtime.mjs';
import { SCHEDULED_JOBS, jobRunName } from './scheduled-jobs.mjs';
import { schedulePaths, startSchedule, startedJobs } from './start-schedule.mjs';
import { createStartedHostLanes } from './start-host-lanes.mjs';
import { WORKFLOW_HISTORY_FILE } from './workflow-history.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INGEST_CRONS = workerCrons(readFileSync(path.join(REPO_ROOT, 'workers', 'ingest', 'wrangler.jsonc'), 'utf8'));
const NOW = Date.parse('2026-09-23T14:07:00.000Z');
const TOKEN = 'a-started-installations-token';

function tempHome(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'start-schedule-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'installation');
}

/** A door on loopback that answers a cron fire as the ingest's dispatch does
 * and accepts shipped job runs, remembering every request. */
async function fakeDoor(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://door');
      requests.push({ method: req.method, path: url.pathname, cron: url.searchParams.get('cron'), auth: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/cdn-cgi/handler/scheduled') {
        res.end(JSON.stringify({ ok: true, cron: url.searchParams.get('cron'), outcome: 'skipped', detail: 'nothing connected', steps: [] }));
      } else res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { door: `http://127.0.0.1:${server.address().port}`, requests };
}

/** Timers that fire only when the test says so. */
function manualTimers() {
  const timers = [];
  return {
    timers,
    createTimer: (cron, callback) => {
      const timer = { cron, callback, stopped: false, stop: () => (timer.stopped = true), nextRun: () => new Date(NOW + 60_000) };
      timers.push(timer);
      return timer;
    },
  };
}

test('a started installation schedules every cron the ingest declares, and none of the host’s own lanes', () => {
  const jobs = startedJobs(INGEST_CRONS);
  assert.ok(jobs.length > 0);
  assert.deepEqual(jobs.map((job) => job.cron).sort(), [...INGEST_CRONS].sort(), 'one job per ingest cron');
  assert.equal(jobs.some((job) => job.local), false);
  // The host lanes the stack's runner adds: task hub, filers, push state,
  // local panels, backup.
  const host = SCHEDULED_JOBS.filter((job) => job.local).map((job) => job.id);
  assert.deepEqual(host.sort(), ['backup', 'beads-hub', 'beads-snapshot', 'panel-refresh', 'panel-review', 'push-state', 'task-map', 'watch-readbacks']);
});

test('its fires, record, history and status go to its own door and folder only', async (t) => {
  const home = tempHome(t);
  const { door, requests } = await fakeDoor(t);
  const { createTimer } = manualTimers();
  const schedule = await startSchedule({
    home, door, token: TOKEN, crons: INGEST_CRONS, now: () => NOW,
    readSchedules: async () => null, createTimer,
  });
  t.after(() => schedule.stop());
  await schedule.catchup();

  // A brand-new record owes every lane its latest obligation, paid once each,
  // the fifteen-minute counters first.
  const fires = requests.filter((r) => r.path === '/cdn-cgi/handler/scheduled');
  assert.deepEqual(fires.map((r) => r.cron).sort(), [...INGEST_CRONS].sort());
  assert.equal(fires[0].cron, '*/15 * * * *');

  const paths = schedulePaths(home);
  const records = parseJobRuns(readFileSync(paths.jobRuns, 'utf8'));
  assert.deepEqual(records.map((r) => r.job).sort(), INGEST_CRONS.map((cron) => `cron ${cron}`).sort());
  for (const record of records) {
    assert.equal(record.outcome, 'skipped', 'the dispatch’s own verdict is kept');
    assert.match(record.detail, /^startup catch-up for .* · nothing connected$/);
  }
  assert.ok(existsSync(path.join(home, WORKFLOW_HISTORY_FILE)), 'Workflows history is in the folder');

  const status = JSON.parse(readFileSync(paths.status, 'utf8'));
  assert.equal(status.hostLanes, false);
  assert.equal(typeof status.sessionId, 'string');
  assert.deepEqual(status.jobs.map((job) => job.id).sort(), startedJobs(INGEST_CRONS).map((job) => job.id).sort());

  // Every firing reached this installation's store, with its own token.
  const shipped = requests.filter((r) => r.path === '/api/job-runs');
  assert.ok(shipped.length > 0);
  assert.ok(shipped.every((r) => r.method === 'POST' && r.auth === `Bearer ${TOKEN}`));
  assert.deepEqual(new Set(shipped.flatMap((r) => r.body.runs.map((run) => run.job))), new Set(records.map((r) => r.job)));
  for (const file of Object.values(paths)) assert.ok(file.startsWith(home + path.sep), `${file} is in the folder`);
});

test('a regular tick fires its own cron, and a restart owes nothing already paid', async (t) => {
  const home = tempHome(t);
  const { door, requests } = await fakeDoor(t);
  const first = manualTimers();
  const schedule = await startSchedule({
    home, door, token: TOKEN, crons: INGEST_CRONS, now: () => NOW,
    readSchedules: async () => null, createTimer: first.createTimer,
  });
  await schedule.catchup();
  const counters = first.timers.find((timer) => timer.cron === '*/15 * * * *');
  requests.length = 0;
  await counters.callback();
  assert.deepEqual(requests.filter((r) => r.cron).map((r) => r.cron), ['*/15 * * * *']);
  schedule.stop();
  assert.ok(first.timers.every((timer) => timer.stopped), 'stop disarms every timer');
  requests.length = 0;
  await counters.callback();
  assert.deepEqual(requests, [], 'a stopped schedule fires nothing');

  const second = manualTimers();
  const again = await startSchedule({
    home, door, token: TOKEN, crons: INGEST_CRONS, now: () => NOW + 60_000,
    readSchedules: async () => null, createTimer: second.createTimer,
  });
  t.after(() => again.stop());
  await again.catchup();
  assert.deepEqual(requests.filter((r) => r.cron), [], 'every latest obligation is already in the record');
});

test('a lane its person paused is neither ticked nor caught up', async (t) => {
  const home = tempHome(t);
  const { door, requests } = await fakeDoor(t);
  const { timers, createTimer } = manualTimers();
  const paused = SCHEDULED_JOBS.find((job) => job.id === 'dataforseo');
  const schedule = await startSchedule({
    home, door, token: TOKEN, crons: INGEST_CRONS, now: () => NOW,
    readSchedules: async () => ({ dataforseo: { enabled: false, cron: paused.cron } }), createTimer,
  });
  t.after(() => schedule.stop());
  await schedule.catchup();
  assert.equal(requests.some((r) => r.cron === paused.cron), false);
  assert.equal(timers.some((timer) => timer.cron === paused.cron), false);
  const status = JSON.parse(readFileSync(schedulePaths(home).status, 'utf8'));
  assert.equal(status.jobs.find((job) => job.id === 'dataforseo').enabled, false);
  assert.equal(parseJobRuns(readFileSync(schedulePaths(home).jobRuns, 'utf8')).some((r) => r.job === jobRunName(paused)), false);
});

// ─── Its host lanes, once set up ──────────────────────────

/** A door that also serves the saved settings — the schedules and, when
 * given, task projects whose hub is the door itself — and takes snapshots. */
async function settingsDoor(t, { spokes = [] } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://door');
      requests.push({ method: req.method, path: url.pathname, cron: url.searchParams.get('cron'), auth: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/config-documents') {
        const { port } = server.address();
        res.end(JSON.stringify({ ready: true, documents: [
          { file: 'config/constants.json', version: 1, body: {} },
          { file: 'config/beads.json', version: 1, body: { hub: { host: '127.0.0.1', port }, spokes } },
        ] }));
      } else if (url.pathname === '/cdn-cgi/handler/scheduled') {
        res.end(JSON.stringify({ ok: true, outcome: 'skipped', detail: 'nothing connected', steps: [] }));
      } else {
        res.statusCode = url.pathname === '/api/beads-snapshot' ? 201 : 200;
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { door: `http://127.0.0.1:${server.address().port}`, requests };
}

/** The stack's runner's task board code, with `bd` answered here. */
async function taskBoardRunner(bdCalls) {
  const { runBeadsPoll } = await import('./runner/task-snapshot.mjs');
  const { probeTcp } = await import('./runner/host-tools.mjs');
  return { runBeadsPoll, probeTcp, runBd: async (argv) => (bdCalls.push(argv), { code: 0, stdout: '[]', stderr: '' }) };
}

function installationFile(home, name, body) {
  mkdirSync(path.join(home, 'installation'), { recursive: true });
  writeFileSync(path.join(home, 'installation', name), JSON.stringify(body));
}

const SHOP = { asset: 'shop.example', prefix: 'shop', database: 'shop' };

test('a saved task project turns its task board refresh on, filed at its own door', async (t) => {
  const home = tempHome(t);
  installationFile(home, 'task-host.json', { repositories: [{ ...SHOP, repo: '../shop.example' }] });
  const { door, requests } = await settingsDoor(t, { spokes: [SHOP] });
  const { timers, createTimer } = manualTimers();
  const bdCalls = [];
  const managed = await taskBoardRunner(bdCalls);
  const schedule = await startSchedule({
    home, door, token: TOKEN, crons: INGEST_CRONS, now: () => NOW, createTimer,
    hostLanes: createStartedHostLanes({ home, door, token: TOKEN, now: () => NOW,
      taskRun: managed.runBd,
      runner: () => ({ ...managed, runBd: () => assert.fail('the inherited managed bd environment must not run') }),
    }),
  });
  t.after(() => schedule.stop());
  await schedule.catchup();

  const status = JSON.parse(readFileSync(schedulePaths(home).status, 'utf8'));
  assert.equal(status.hostLanes, false);
  assert.ok(status.jobs.some((job) => job.id === 'beads-snapshot'), 'its status lists the lane, so the Tower shows it');
  assert.equal(status.jobs.some((job) => job.id === 'backup'), false, 'no offsite folder named: no backup');

  assert.equal(requests.filter(r => r.path === '/api/beads-snapshot').length, 1, 'the first own-project snapshot is ready before start returns');
  requests.length = 0;
  await timers.find((timer) => timer.cron === '* * * * *').callback();
  const filed = requests.filter((r) => r.path === '/api/beads-snapshot');
  assert.equal(filed.length, 1, 'the snapshot went to this installation’s door');
  assert.equal(filed[0].auth, `Bearer ${TOKEN}`);
  assert.deepEqual(filed[0].body.projects.map((project) => project.asset), ['shop.example']);
  assert.ok(bdCalls.length > 0 && bdCalls.every((argv) => argv[0] === '-C' && argv[1] === path.resolve(home, '../shop.example')), 'bd read the linked checkout');
  const records = parseJobRuns(readFileSync(schedulePaths(home).jobRuns, 'utf8'));
  assert.ok(records.some((record) => record.job === 'beads-snapshot' && record.outcome === 'ran'));
});

test('with no task project saved and no offsite folder, its host lanes stay off, unlisted and unrecorded', async (t) => {
  const home = tempHome(t);
  const { door, requests } = await settingsDoor(t);
  const { timers, createTimer } = manualTimers();
  const schedule = await startSchedule({
    home, door, token: TOKEN, crons: INGEST_CRONS, now: () => NOW, createTimer,
    hostLanes: createStartedHostLanes({ home, door, token: TOKEN, now: () => NOW, runner: () => assert.fail('no host lane runs') }),
  });
  t.after(() => schedule.stop());
  await schedule.catchup();
  requests.length = 0;
  for (const timer of timers.filter((timer) => ['* * * * *', '0 4 * * *'].includes(timer.cron))) await timer.callback();

  const status = JSON.parse(readFileSync(schedulePaths(home).status, 'utf8'));
  assert.deepEqual(status.jobs.map((job) => job.id).sort(), startedJobs(INGEST_CRONS).map((job) => job.id).sort());
  assert.equal(requests.some((r) => r.path === '/api/beads-snapshot'), false);
  const records = parseJobRuns(readFileSync(schedulePaths(home).jobRuns, 'utf8'));
  assert.equal(records.some((record) => ['beads-snapshot', 'backup'].includes(record.job)), false);
});

test('an offsite folder named in its installation turns its backup on, and a missed night is paid at start', async (t) => {
  const home = tempHome(t);
  const offsite = path.join(path.dirname(home), 'offsite');
  installationFile(home, 'host-backup.json', { offsiteBackupDir: offsite });
  const { door } = await settingsDoor(t);
  const { createTimer } = manualTimers();
  const backups = [];
  const schedule = await startSchedule({
    home, door, token: TOKEN, crons: INGEST_CRONS, now: () => NOW, createTimer,
    hostLanes: createStartedHostLanes({
      home, door, token: TOKEN, now: () => NOW,
      runner: async () => ({ CONFIG: { backupRetentionDays: 30 }, bdBin: () => 'bd' }),
      backup: async (settings) => (backups.push(settings), { ok: true, detail: 'Postgres: completed' }),
    }),
  });
  t.after(() => schedule.stop());
  await schedule.catchup();

  // 14:07 UTC: the 04:00 obligation was missed, and is paid once.
  assert.deepEqual(backups, [{ repoRoot: home, retentionDays: 30, offsiteBackupDir: offsite, bdBinary: 'bd', taskHub: 'linked' }]);
  const status = JSON.parse(readFileSync(schedulePaths(home).status, 'utf8'));
  assert.ok(status.jobs.some((job) => job.id === 'backup'));
  const records = parseJobRuns(readFileSync(schedulePaths(home).jobRuns, 'utf8'));
  assert.ok(records.some((record) => record.job === 'backup' && record.outcome === 'ran'));
});
