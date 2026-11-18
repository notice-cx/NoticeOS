import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { startLocalCustomer } from './local-customer.mjs';
import { startLocalCustomerSchedules } from './local-customer-schedules.mjs';
import { SCHEDULED_JOBS, SCHEDULES_FILE, SCHEDULES_POINTER, jobRunName } from './scheduled-jobs.mjs';
import { ACCEPT_INVITATION_PATH, EMAIL_CODE_PATHS, EMAIL_ENROLLMENT_HEADERS } from './identity-protocol.mjs';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { startPlan } from './start.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { availableCustomerPort } from './test/customer-ports.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';

async function ownerSession(app, { email, url, workspaceId }) {
  const http = (route, { method = 'GET', body, headers = {} } = {}) => fetch(app.publicOrigin + route, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { origin: app.publicOrigin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    redirect: 'manual', signal: AbortSignal.timeout(30000),
  });
  const invitationId = new URL(url).hash.slice('#invitation='.length);
  const enrollment = { [EMAIL_ENROLLMENT_HEADERS.kind]: 'invitation', [EMAIL_ENROLLMENT_HEADERS.id]: invitationId };
  assert.equal((await http(EMAIL_CODE_PATHS.request, { method: 'POST', body: { email }, headers: enrollment })).status, 202);
  const mail = readdirSync(app.outbox).map(file => JSON.parse(readFileSync(path.join(app.outbox, file), 'utf8')))
    .find(item => item.to === email && /[0-9]{6}\.$/u.test(item.text));
  const otp = mail?.text.match(/\b([0-9]{6})\.$/u)?.[1];
  assert.ok(otp);
  const verified = await http(EMAIL_CODE_PATHS.verify, { method: 'POST', body: { email, otp }, headers: enrollment });
  assert.equal(verified.status, 200);
  const cookie = verified.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const { session } = await (await http('/api/session', { headers: { cookie } })).json();
  const signedIn = { cookie, [WORKSPACE_SESSION_HEADER]: session.sessionId };
  assert.equal((await http(ACCEPT_INVITATION_PATH, { method: 'POST', body: { invitationId }, headers: signedIn })).status, 200);
  return (route, options) => http(route, { ...options, headers: { ...signedIn, [WORKSPACE_SELECTION_HEADER]: workspaceId } });
}

test('customer Tower reports and rolls up alerts once per scheduled occurrence in each enabled workspace', { timeout: 150_000 }, async t => {
  const root = testFixtureRoot('n-customer-tower-report-');
  const plan = startPlan({ dir: path.join(root, 'runtime'), port: await availableCustomerPort() });
  const now = Date.UTC(2026, 10, 17, 3, 5);
  const occurrence = new Date(now).toISOString() + '/workspace';
  const journalJob = jobRunName(SCHEDULED_JOBS.find(job => job.id === 'asset-zero'));
  const dispatches = [];
  let clockTime = now, beforeDispatch = () => {};
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
  const receipts = () => db.cluster.sql(`SELECT workspace_id,occurrence,state,attempt,steps->'report'->>'state' AS report_state
    FROM noticeos.hosted_job_occurrences WHERE lane='asset-zero' ORDER BY workspace_id`);
  // The released job name maps the workflow attempt to the same Journal as standalone.
  const journal = () => db.cluster.sql(`SELECT workspace_id,started_at::text,outcome
    FROM noticeos.job_runs WHERE job='${journalJob}' ORDER BY workspace_id`);
  const launch = () => startLocalCustomer(plan, db, {
    fixtureProvider() { outbound++; return new Response(null, { status: 503 }); },
    startSchedules: options => startLocalCustomerSchedules({ ...options, now: () => clockTime, worker: {
      async fetch(request) {
        const call = await request.clone().json();
        dispatches.push(call);
        beforeDispatch(call);
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
    const [eastWorkspace, westWorkspace] = app.workspaces;
    const { workspaceId: east } = eastWorkspace, { workspaceId: west } = westWorkspace;
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
    assert.deepEqual(eastReceipts, [{ workspace_id: east, occurrence, state: 'succeeded', attempt: '1', report_state: 'succeeded' }]);
    assert.deepEqual(eastJournal.map(row => [row.workspace_id, row.outcome]), [[east, 'ran']]);
    assert.deepEqual(dispatches, [{ workspaceId: east, job: 'asset-zero', asset: null, occurrence }]);
    const signedIn = await ownerSession(app, westWorkspace);
    const workflows = async () => {
      const response = await signedIn('/api/workflows');
      assert.equal(response.status, 200);
      const payload = await response.json();
      const job = payload.runtime.jobs.find(row => row.id === 'asset-zero');
      const item = payload.workflows.find(row => row.id === 'asset-zero');
      assert.ok(job && item);
      assert.ok(payload.runtimeFresh);
      assert.ok(!payload.workflows.some(row => ['stripe', 'counters'].includes(row.id)));
      return { saved: payload.overrides, job, item };
    };
    const save = async ({ saved }, enabled) => {
      const expected = { ...saved, 'asset-zero': { ...saved['asset-zero'], enabled } };
      const response = await signedIn('/api/config', { method: 'PUT', body: {
        slug: 'schedule-asset-zero', ops: [{ kind: 'file-json-set', file: SCHEDULES_FILE,
          pointer: SCHEDULES_POINTER, expect: saved, value: expected }],
      } });
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual((await workflows()).saved, expected);
    };
    const paused = await workflows();
    assert.equal(paused.saved['asset-zero'].enabled, false);
    assert.deepEqual(paused.job, { id: 'asset-zero', enabled: false, cron: '5 3 * * *', nextRun: null });
    assert.deepEqual(paused.item.runs, []);
    await save(paused, true);
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
    assert.deepEqual(inWorkspace(receipts(), west), [{ workspace_id: west, occurrence, state: 'succeeded', attempt: '1', report_state: 'succeeded' }]);
    assert.deepEqual(inWorkspace(journal(), west).map(row => row.outcome), ['ran']);
    const resumed = await workflows();
    assert.equal(resumed.job.enabled, true);
    assert.equal(resumed.item.runs.length, 1);
    await save(resumed, false);
    clockTime = now + 86_400_000;
    beforeDispatch = ({ workspaceId }) => {
      assert.equal(workspaceId, east);
      setSchedule(east, false);
    };
    await restart();
    const pausedAgain = await workflows();
    assert.equal(pausedAgain.job.enabled, false);
    assert.equal(pausedAgain.job.nextRun, null);
    assert.deepEqual(pausedAgain.item.runs, resumed.item.runs);
    assert.deepEqual(inWorkspace(reports(), west), westReports);
    assert.deepEqual(inWorkspace(reports(), east), eastReports);
    assert.deepEqual(inWorkspace(journal(), east).map(row => row.outcome).sort(), ['ran', 'skipped']);
    assert.equal(outbound, 0);
  } finally {
    try { await app?.close(); } finally { db?.close(); }
    const postmaster = path.join(plan.home, '.local', 'customer-postgres', 'data', 'postmaster.pid');
    assert.equal(existsSync(postmaster), false);
    rmSync(root, { recursive: true, force: true });
  }
});
