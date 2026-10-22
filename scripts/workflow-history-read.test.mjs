import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { findPostgres } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { trackFixturePool } from './test-fixtures/postgres-pool.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { MANUAL_RUN_DETAIL } from '../packages/contract/src/job-runs.ts';
import { buildWorkflowHistory } from './workflow-history-view.mjs';
import { WORKFLOW_DEFINITIONS } from './workflow-definitions.mjs';
import { jobRunName } from './scheduled-jobs.mjs';

const require = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = require('pg');
const build = createRequire(createRequire(path.join(REPO_ROOT, 'workers/ingest/package.json')).resolve('wrangler/package.json'))('esbuild').build;
const NOW = Date.parse('2026-11-02T12:30:00Z');
const HOUR = 3_600_000;
const job = jobRunName(WORKFLOW_DEFINITIONS.find(definition => definition.id === 'counters'));

test('local complete daily counts survive rich-detail retention and resolve the old failed run', () => {
  const records = Array.from({ length: 168 }, (_, i) => ({ job, at: new Date(NOW - i * HOUR).toISOString(), ms: 1, outcome: i === 120 ? 'failed' : 'ran' }));
  const selected = `counters@${records[120].at}`;
  const view = buildWorkflowHistory(records, [], [], NOW, selected);
  const own = view.workflows.find(workflow => workflow.id === 'counters');
  assert.equal(own.runs.length, 30);
  assert.equal(own.dailyHistory.timeZone, 'UTC');
  assert.equal(own.dailyHistory.buckets.length, 31);
  assert.equal(own.dailyHistory.buckets.reduce((sum, bucket) => sum + bucket.succeeded + bucket.failed, 0), 168);
  const day = own.dailyHistory.buckets.find(bucket => bucket.at.startsWith(records[120].at.slice(0, 10)));
  assert.equal(day.failed, 1); assert.equal(day.succeeded, 23); assert.equal(day.runId, selected);
  assert.equal(view.selectedRun.id, selected); assert.equal(view.selectedRun.state, 'failed');
});

test('local manual failure links distinguish a simultaneous scheduled success', () => {
  const at = new Date(NOW - 5 * 24 * HOUR).toISOString();
  const records = [{ job, at, ms: 1, outcome: 'ran' }, { job, at, ms: 1, outcome: 'failed', trigger: 'manual' }];
  const selected = `counters@manual/${at}`;
  const view = buildWorkflowHistory(records, [], [], NOW, selected);
  assert.equal(view.selectedRun.id, selected);
  assert.equal(view.selectedRun.state, 'failed');
  assert.equal(view.workflows.find(workflow => workflow.id === 'counters').dailyHistory.buckets.find(bucket => bucket.failed).runId, selected);
});

test('hosted daily counts and old failure links remain complete and workspace isolated', { timeout: 120000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workflow-week-'));
  let cluster, closePool;
  const stores = [];
  try {
    cluster = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), findPostgres()));
    if (!cluster) return;
    applyMigrations(cluster);
    const admin = new Pool({ host: cluster.socketDir, port: cluster.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 1 });
    closePool = trackFixturePool(admin);
    const appUrl = cluster.applicationLogin().url();
    const workspaces = [randomUUID(), randomUUID()];
    const now = new Date(NOW).toISOString();
    for (const [index, workspace] of workspaces.entries()) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')", [workspace, `fixture-${index}`]);
      await admin.query(`INSERT INTO noticeos.hosted_scheduler_status(workspace_id,service_id,session_id,observed_at,running,payload)
        VALUES($1,$2,$2,$3,true,$4)`, [workspace, randomUUID(), now, { updatedAt: now, error: null, onlyListedJobs: true, registeredJobs: ['counters'], jobs: [{ id: 'counters', enabled: true, cron: '0 * * * *', nextRun: null }] }]);
      for (let i = 0; i < 168; i++) {
        const at = new Date(NOW - i * HOUR).toISOString();
        const occurrence = `week-${i}`, lease = randomUUID();
        const state = index === 0 && i === 120 ? 'exhausted' : 'succeeded';
        await admin.query(`INSERT INTO noticeos.hosted_job_occurrences(workspace_id,lane,occurrence,service_id,definition_hash,input_hash,state,attempt,lease_id,lease_expires_at)
          VALUES($1,'counters',$2,$3,$4,$4,$5,1,$6,$7)`, [workspace, occurrence, randomUUID(), 'a'.repeat(64), state, lease, now]);
        await admin.query(`INSERT INTO noticeos.hosted_job_attempts(workspace_id,lane,occurrence,attempt,lease_id,state,started_at,finished_at)
          VALUES($1,'counters',$2,1,$3,$4,$5,$5)`, [workspace, occurrence, lease, state, at]);
      }
      await admin.query(`INSERT INTO noticeos.job_runs(workspace_id,job_run_number,job,started_at,finished_at,outcome,detail,recorded_at)
        SELECT $1,n+1,$2,$3::timestamptz - n * interval '30 minutes',$3::timestamptz - n * interval '30 minutes',
          CASE WHEN n=240 AND $5=0 THEN 'failed' ELSE 'ran' END,$4,$3::timestamptz FROM generate_series(0,335) n`, [workspace, job, now, MANUAL_RUN_DETAIL, index]);
      const bound = openWorkspaceStore(appUrl, { workspaceId: workspace });
      stores.push({ ...bound, read: work => bound.read(async tx => {
        await tx.query("SELECT set_config('TimeZone',$1,true)", [index === 0 ? 'America/Los_Angeles' : 'Asia/Kathmandu']);
        return work(tx);
      }) });
    }
    const output = path.join(root, 'read.mjs');
    await build({ entryPoints: [path.join(REPO_ROOT, 'apps/tower/worker/hosted-workflow-read.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' });
    const { handleHostedWorkflowRead } = await import(pathToFileURL(output).href);
    const read = async (store, run) => (await handleHostedWorkflowRead(new Request('https://fixture.example/api/workflows' + (run ? '?run=' + encodeURIComponent(run) : '')), store, NOW)).json();
    for (const [index, store] of stores.entries()) {
      const payload = await read(store);
      const own = payload.workflows[0];
      assert.equal(own.runs.length, 30);
      assert.equal(own.history.length, 24);
      assert.equal(own.dailyHistory.buckets.length, 31);
      assert.equal(own.dailyHistory.buckets.reduce((sum, bucket) => sum + bucket.succeeded + bucket.failed, 0), 504);
      const day = own.dailyHistory.buckets.find(bucket => bucket.at.startsWith('2026-10-28'));
      assert.equal(day.failed, index === 0 ? 2 : 0);
      assert.equal(day.succeeded, index === 0 ? 70 : 72);
      const selected = await read(store, day.runId);
      assert.equal(selected.selectedRun.id, day.runId);
      assert.equal(selected.selectedRun.state, index === 0 ? 'failed' : 'succeeded');
      assert.equal(selected.workflows[0].runs.length, 30);
    }
    const manualOutput = path.join(root, 'manual.mjs');
    await build({ entryPoints: [path.join(REPO_ROOT, 'workers/ingest/src/job-runs.ts')], outfile: manualOutput, banner: { js: `import { createRequire } from 'node:module'; const require=createRequire(${JSON.stringify(path.join(REPO_ROOT, 'package.json'))});` }, bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'silent' });
    const { readManualJobRunHistory } = await import(pathToFileURL(manualOutput).href);
    for (const [index, store] of stores.entries()) {
      const manual = await readManualJobRunHistory({ STORE: store }, undefined, NOW);
      assert.equal(manual.runs.length, 200);
      assert.equal(manual.dailyHistory.buckets.reduce((sum, bucket) => sum + bucket.succeeded + bucket.failed, 0), 336);
      const failed = manual.dailyHistory.buckets.find(bucket => bucket.at.startsWith('2026-10-28'));
      assert.equal(failed.failed, index === 0 ? 1 : 0);
      const opened = await readManualJobRunHistory({ STORE: store }, { job, at: failed.runAt }, NOW);
      assert.equal(opened.runs.some(run => run.startedAt === failed.runAt && run.outcome === (index === 0 ? 'failed' : 'ran')), true);
    }
    const manualFailure = (await admin.query("SELECT job_run_id::text FROM noticeos.job_runs WHERE workspace_id=$1 AND outcome='failed'", [workspaces[0]])).rows[0].job_run_id;
    const oldManual = `counters@manual/${manualFailure}`;
    assert.equal((await read(stores[0], oldManual)).selectedRun.state, 'failed');
    assert.equal((await read(stores[1], oldManual)).selectedRun, null);
    await assert.rejects(handleHostedWorkflowRead(new Request('https://fixture.example/api/workflows'), { read: async () => { throw new Error('fixture unavailable'); } }, NOW), /fixture unavailable/);
  } finally {
    await Promise.allSettled(stores.map(store => store.close()));
    await closePool?.(); cluster?.close(); rmSync(root, { recursive: true, force: true });
  }
});
