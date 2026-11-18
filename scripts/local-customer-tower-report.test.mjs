import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startLocalCustomer } from './local-customer.mjs';
import { startLocalCustomerSchedules } from './local-customer-schedules.mjs';
import { SCHEDULED_JOBS, jobRunName } from './scheduled-jobs.mjs';
import { startPlan } from './start.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { availableCustomerPort } from './test/customer-ports.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';

test('customer Tower reports and rolls up alerts once per scheduled occurrence in each enabled workspace', { timeout: 150_000 }, async t => {
  const root = testFixtureRoot('n-customer-tower-report-');
  const plan = startPlan({ dir: path.join(root, 'runtime'), port: await availableCustomerPort() });
  const now = Date.UTC(2026, 10, 17, 3, 5);
  const occurrence = new Date(now).toISOString() + '/workspace';
  const journalJob = jobRunName(SCHEDULED_JOBS.find(job => job.id === 'asset-zero'));
  const dispatches = [];
  let outbound = 0, db, app;
  const setSchedule = (workspace, enabled) => db.cluster.run(`
    UPDATE noticeos.config_documents SET body=jsonb_set(body::jsonb,'{schedules}',:'schedules'::jsonb)::json
    WHERE workspace_id=:'workspace'::uuid AND document_key='constants';`, { vars: { workspace, schedules: JSON.stringify({
    'asset-zero': { enabled, cron: '5 3 * * *' },
    'panel-refresh': { enabled: false, cron: '10 13 * * *' },
    freshness: { enabled: false, cron: '0 * * * *' },
  }) } });
  const seed = (workspace, severity, outcome) => db.cluster.run(`
    INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,status,is_os,list_position)
    VALUES (:'workspace'::uuid,'fixture-system','Fixture Tower','live',true,1);
    INSERT INTO noticeos.flags(workspace_id,asset_id,fired_at,severity,kind,rule_id)
    VALUES (:'workspace'::uuid,'fixture-system',now()-interval '10 minutes',:'severity','anomaly','fixture');
    INSERT INTO noticeos.job_runs(workspace_id,job,started_at,finished_at,outcome,recorded_at)
    VALUES (:'workspace'::uuid,'fixture-job',now()-interval '10 minutes',now(),:'outcome',now());`,
  { vars: { workspace, severity, outcome } });
  const reports = () => db.cluster.sql(`SELECT workspace_id,asset_id,pulse_date::text,revision,pulse_id,
    (generated_at AT TIME ZONE 'UTC')::date::text AS generated_day,
    envelope->'metrics'->'cronRunSuccess'->>'last24h' AS healthy,
    envelope->'metrics'->'openFlagsError'->>'last24h' AS errors,
    envelope->'metrics'->'openFlagsWarn'->>'last24h' AS warnings
    FROM noticeos.pulses ORDER BY workspace_id, pulse_id`);
  const alerts = () => db.cluster.sql(`SELECT workspace_id,coalesce(asset_id,'portfolio') AS subject,day::text,
    observed_at::text,open,errors,warnings FROM noticeos.alert_daily_counts ORDER BY workspace_id,subject`);
  const receipts = () => db.cluster.sql(`SELECT workspace_id,occurrence,state,attempt
    FROM noticeos.hosted_job_occurrences WHERE lane='asset-zero' ORDER BY workspace_id`);
  // The released job name maps the workflow attempt to the same Journal as standalone.
  const journal = () => db.cluster.sql(`SELECT workspace_id,started_at::text,outcome
    FROM noticeos.job_runs WHERE job='${journalJob}' ORDER BY workspace_id`);
  const launch = () => startLocalCustomer(plan, db, {
    fixtureProvider() { outbound++; return new Response(null, { status: 503 }); },
    startSchedules: options => startLocalCustomerSchedules({ ...options, now: () => now, worker: {
      async fetch(request) {
        dispatches.push(await request.clone().json());
        return options.worker.fetch(request);
      },
    } }),
  });
  const restart = async () => {
    await app.close(); app = undefined;
    db.close(); db = undefined;
    db = openDevelopmentStart(plan, { profile: 'hosted' });
    app = await launch();
    await app.whenIdle();
  };
  try {
    db = await skipWithoutPostgres(t, () => openDevelopmentStart(plan, { profile: 'hosted' }));
    if (!db) return;
    app = await startLocalCustomer(plan, db);
    const [east, west] = app.workspaces.map(entry => entry.workspaceId);
    seed(east, 'error', 'ran');
    seed(west, 'warn', 'failed');
    setSchedule(east, true);
    setSchedule(west, false);
    await restart();
    const eastReports = reports(), eastAlerts = alerts(), eastReceipts = receipts(), eastJournal = journal();
    assert.deepEqual(eastReports.map(({ workspace_id, asset_id, revision, healthy, errors, warnings }) =>
      [workspace_id, asset_id, revision, healthy, errors, warnings]), [[east, 'fixture-system', '1', '1', '1', '0']]);
    assert.equal(eastReports[0].pulse_date, eastReports[0].generated_day);
    assert.deepEqual(eastAlerts.map(({ workspace_id, subject, day, open, errors, warnings }) =>
      [workspace_id, subject, day, open, errors, warnings]), ['fixture-system', 'portfolio'].map(subject =>
      [east, subject, eastReports[0].pulse_date, '1', '1', '0']));
    assert.deepEqual(eastReceipts, [{ workspace_id: east, occurrence, state: 'succeeded', attempt: '1' }]);
    assert.deepEqual(eastJournal.map(row => [row.workspace_id, row.outcome]), [[east, 'ran']]);
    assert.deepEqual(dispatches, [{ workspaceId: east, job: 'asset-zero', asset: null, occurrence }]);
    setSchedule(west, true);
    await restart();
    assert.deepEqual(dispatches, [east, west].map(workspaceId => ({ workspaceId, job: 'asset-zero', asset: null, occurrence })));
    const inWorkspace = (rows, workspace) => rows.filter(row => row.workspace_id === workspace);
    assert.deepEqual(inWorkspace(reports(), east), eastReports);
    assert.deepEqual(inWorkspace(alerts(), east), eastAlerts);
    assert.deepEqual(inWorkspace(receipts(), east), eastReceipts);
    assert.deepEqual(inWorkspace(journal(), east), eastJournal);
    const westReports = inWorkspace(reports(), west);
    assert.deepEqual(westReports.map(({ asset_id, revision, healthy, errors, warnings }) =>
      [asset_id, revision, healthy, errors, warnings]), [['fixture-system', '1', '0', '0', '1']]);
    assert.deepEqual(inWorkspace(alerts(), west).map(({ subject, day, open, errors, warnings }) =>
      [subject, day, open, errors, warnings]), ['fixture-system', 'portfolio'].map(subject =>
      [subject, westReports[0].pulse_date, '1', '0', '1']));
    assert.deepEqual(inWorkspace(receipts(), west), [{ workspace_id: west, occurrence, state: 'succeeded', attempt: '1' }]);
    assert.deepEqual(inWorkspace(journal(), west).map(row => row.outcome), ['ran']);
    assert.equal(outbound, 0);
  } finally {
    try { await app?.close(); } finally { db?.close(); }
    const postmaster = path.join(plan.home, '.local', 'customer-postgres', 'data', 'postmaster.pid');
    assert.equal(existsSync(postmaster), false);
    rmSync(root, { recursive: true, force: true });
  }
});
