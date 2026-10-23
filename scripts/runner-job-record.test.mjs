import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parseJobRuns } from './job-runs.mjs';
import { fireScheduledTrigger } from './ingest-door.mjs';
import { createWorkflowHistory, WORKFLOW_HISTORY_FILE } from './workflow-history.mjs';
import { REPO_ROOT, runnerPaths, CONFIG } from './runner/config.mjs';
import {
  JOB_RUNS_FILE,
  REGULAR_LANE_HELD,
  armJobRunShipping,
  finishJobRuns,
  jobRunAge,
  jobRunStartupLines,
  jobRunsUrl,
  reportJobRuns,
  runJobLane,
  shipJobRuns,
  summarizeJobRuns,
} from './runner/job-record.mjs';

// scripts/runner/job-record.mjs: the runner's job-run
// record, bound to its own file, log and door. Every firing below goes to a
// throwaway file, and shipping is driven with an injected state and door.

const NOW = Date.parse('2026-09-24T12:00:00.000Z');

function throwaway() {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-record-'));
  const file = path.join(dir, 'job-runs.jsonl');
  const lines = [];
  return {
    deps: { file, emit: (level, text) => lines.push(`${level} ${text}`), now: () => NOW },
    lines,
    read: () => parseJobRuns(existsSync(file) ? readFileSync(file, 'utf8') : ''),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("the record is home's .local/logs/job-runs.jsonl", () => {
  assert.equal(JOB_RUNS_FILE, runnerPaths(REPO_ROOT).jobRunsFile);
});

test('a firing is appended, read back, and summarized per lane', async () => {
  const lane = throwaway();
  try {
    await runJobLane('panel-review', async () => ({ filed: [] }), undefined, lane.deps);
    await runJobLane('panel-review', async () => null, undefined, { ...lane.deps, now: () => NOW + 60_000 });
    const kept = await reportJobRuns(NOW + 3 * 3_600_000, lane.deps);
    assert.deepEqual(kept.map((entry) => entry.outcome), ['ran', 'skipped']);
    assert.deepEqual(summarizeJobRuns(kept).map((entry) => [entry.job, entry.ran, entry.skipped]), [['panel-review', 1, 1]]);
    assert.match(lane.lines.at(-1), /^INFO job-run record — 1 lane\(s\): panel-review skipped 3h ago/u);
  } finally {
    lane.cleanup();
  }
});

test('a lane held for startup catch-up is recorded with the hold, not as a run', async () => {
  const lane = throwaway();
  try {
    const held = await runJobLane('backup', async () => REGULAR_LANE_HELD,
      () => ({ outcome: 'skipped', detail: 'held for startup catch-up' }), lane.deps);
    assert.equal(held, REGULAR_LANE_HELD);
    assert.deepEqual(lane.read().map((entry) => [entry.outcome, entry.detail]), [['skipped', 'held for startup catch-up']]);
  } finally {
    lane.cleanup();
  }
});

test('a lane whose last firing failed is named at startup', () => {
  const lines = jobRunStartupLines(
    [{ job: 'backup', last: new Date(NOW - 26 * 3_600_000).toISOString(), lastOutcome: 'failed', ran: 0, skipped: 0, failed: 1 }],
    NOW,
    '/tmp/job-runs.jsonl',
  );
  assert.deepEqual(lines.map((line) => line.level), ['INFO', 'WARN']);
  assert.match(lines[1].text, /backup \(last 26h ago\) last FAILED/u);
  assert.equal(jobRunAge('not a date', NOW), 'never');
});

test('reload interruptions persist as skipped in the ledger and workflow without a startup failure', async () => {
  const lane = throwaway();
  const root = path.dirname(lane.deps.file);
  const history = createWorkflowHistory(root);
  const shipped = [];
  try {
    const pending = runJobLane('cron * * * * *', () => fireScheduledTrigger('http://127.0.0.1:1', '* * * * *', {
      fetchImpl: async () => Response.json({ error: 'runtime_reloading' }, { status: 503 }),
      emit: lane.deps.emit,
    }), value => value, { ...lane.deps, begin: history.beginRun, ship: async record => { shipped.push(record); } });
    await finishJobRuns();
    await pending;
    const [record] = lane.read();
    assert.equal(record.outcome, 'skipped');
    assert.equal(record.detail, 'interrupted: server reloading');
    assert.equal(record.workflowState, 'skipped');
    assert.equal(shipped[0].outcome, 'skipped');
    const workflow = JSON.parse(readFileSync(path.join(root, WORKFLOW_HISTORY_FILE), 'utf8').trim());
    assert.equal(workflow.state, 'skipped');
    assert.deepEqual(jobRunStartupLines(summarizeJobRuns([record]), NOW).map(line => line.level), ['INFO']);
    assert.equal(lane.lines.some(line => line.startsWith('ERROR')), false);
  } finally { lane.cleanup(); }
});

test('shutdown waits for pending records, with a bounded wait for unfinished work', async () => {
  const lane = throwaway();
  let finish;
  try {
    const pending = runJobLane('backup', () => new Promise(resolve => { finish = resolve; }), undefined,
      { ...lane.deps, ship: async () => {} });
    await finishJobRuns(1);
    assert.equal(lane.read().length, 0);
    finish(null);
    await finishJobRuns();
    await pending;
    assert.equal(lane.read()[0].outcome, 'skipped');
  } finally { lane.cleanup(); }
});

test('shipping waits for a runtime, then posts to this runner’s door', async () => {
  const state = { runtime: null, pending: [], skipping: null };
  const posted = [];
  const deps = {
    state,
    post: async (url, init) => (posted.push({ url, body: JSON.parse(init.body) }), new Response('{}', { status: 201 })),
    readToken: async () => 'example-bearer',
    emit: () => {},
    stopped: () => false,
  };
  const record = { at: new Date(NOW).toISOString(), job: 'backup', outcome: 'ran', ms: 5 };
  assert.equal(await shipJobRuns(record, deps), null, 'no runtime yet: disk only');
  assert.equal(posted.length, 0);
  armJobRunShipping({ running: true, ready: true }, [record], NOW, state);
  await shipJobRuns(null, deps);
  assert.equal(posted[0]?.url, jobRunsUrl(CONFIG));
});
