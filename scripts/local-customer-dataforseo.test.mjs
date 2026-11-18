import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { openWorkspaceStore } from '../packages/postgres/src/store.mjs';
import { verifyComposeCustomerCollection } from '../deploy/compose/customer-entry.mjs';
import { customerCollectionPolicy } from './customer-collection-policy.mjs';
import { CUSTOMER_GOOGLE_ARCHIVE_PLAN_URL, customerSchedules } from './customer-collection.mjs';
import { DATAFORSEO_ACCOUNT_PATH, DATAFORSEO_ORIGIN, DATAFORSEO_REPORT_PATHS } from './customer-dataforseo-egress.mjs';
import { startAttachedCustomer } from './local-customer-attach.mjs';
import { startLocalCustomer } from './local-customer.mjs';
import { loadCustomerWorkflowModule } from './local-customer-workflow-module.mjs';
import { startLocalCustomerSchedules } from './local-customer-schedules.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { startPlan } from './start.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { sealedProviderSql } from './test-fixtures/customer-backup.mjs';
import { availableCustomerPort } from './test/customer-ports.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';

test('an attached customer buys approved reports and recovers a paid result under its original date', { timeout: 150_000 }, async t => {
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.notEqual(url.origin, DATAFORSEO_ORIGIN, 'A synthetic fixture must not use Node’s provider transport.');
    return fetch(input, init);
  });
  const root = testFixtureRoot('n-customer-paid-');
  const plan = startPlan({ dir: path.join(root, 'source'), port: await availableCustomerPort() });
  const attached = startPlan({ dir: path.join(root, 'runtime'), port: plan.port });
  const scheduledAt = Math.floor(Date.now() / 60_000) * 60_000;
  const occurrence = new Date(scheduledAt).toISOString() + '/workspace';
  const alpha = 'alpha.example', beta = 'beta.example', gamma = 'gamma.example';
  let db, app, workers, bucket;
  const paidCalls = [], accountCalls = [], regularWorkerStatus = [];
  const login = randomBytes(12).toString('hex'), password = randomBytes(20).toString('hex');
  const transport = async (url, { method, headers, body }) => {
    assert.equal(new URL(url).origin, DATAFORSEO_ORIGIN);
    assert.equal(new Headers(headers).get('authorization'), 'Basic ' + Buffer.from(login + ':' + password).toString('base64'));
    const endpoint = new URL(url).pathname;
    if (method === 'GET' && endpoint === DATAFORSEO_ACCOUNT_PATH) {
      accountCalls.push(endpoint);
      return Response.json({ status_code: 20000, money: { balance: 4 } });
    }
    const [task] = JSON.parse(body);
    paidCalls.push([endpoint, task.target]);
    return Response.json({ status_code: 20000, cost: 0.02,
      tasks: [{ status_code: 20000, result: [{ items_count: 1, items: [{ fixture: true }] }] }] });
  };
  try {
    db = await skipWithoutPostgres(t, () => openDevelopmentStart(plan, { profile: 'hosted' }));
    if (!db) return;
    app = await startLocalCustomer(plan, db);
    const workspaces = app.workspaces.map(({ workspaceId, serviceId }) => ({ workspaceId, serviceId }));
    const [east, west] = workspaces.map(workspace => workspace.workspaceId);
    const { identitySecret, credentialsKey } = JSON.parse(readFileSync(path.join(db.customer, 'settings.json'), 'utf8'));
    const schedule = { enabled: true, cron: '* * * * *' };
    const settings = { monthly_caps: { data_usd: 0.27 }, schedules: { dataforseo: schedule, 'dataforseo-recovery': schedule,
      freshness: { ...schedule, enabled: false }, 'panel-refresh': { ...schedule, enabled: false } } };
    const writeConstants = (workspace, value) => db.cluster.run(`UPDATE noticeos.config_documents SET body=:'body'::json
      WHERE workspace_id=:'workspace'::uuid AND document_key='constants'`, { vars: { workspace, body: JSON.stringify(value) } });
    for (const [workspace, asset, position] of [[east, alpha, 1], [west, alpha, 1], [east, beta, 2], [east, gamma, 3]]) {
      db.cluster.run(`INSERT INTO noticeos.assets(workspace_id,asset_id,display_name,domain,status,list_position)
        VALUES (:'workspace'::uuid,:'asset',:'asset',:'asset','live',:'position'::int)`, { vars: { workspace, asset, position } });
    }
    for (const workspace of [east, west]) writeConstants(workspace, settings);
    const connectionId = randomUUID(), otherConnection = randomUUID();
    db.cluster.run(sealedProviderSql(east, credentialsKey, 'dataforseo', { DATAFORSEO_LOGIN: login, DATAFORSEO_PASSWORD: password }, connectionId));
    db.cluster.run(sealedProviderSql(west, credentialsKey, 'dataforseo', { DATAFORSEO_LOGIN: login, DATAFORSEO_PASSWORD: password }, otherConnection));
    const approval = { workspaceId: east, connectionId, secretVersion: 1, approvedMonthlyCapUsd: 0.27, weekly: true, recovery: false,
      assets: [{ asset: alpha, families: ['backlinks-summary', 'serp-panel'] }, { asset: beta, families: ['serp-competitors'] },
        { asset: gamma, families: ['backlinks-summary'] }] };
    const preflight = selected => verifyComposeCustomerCollection({ workspaces, address: db.address,
      collectorProviders: [], paidDataForSeo: [selected] });
    await assert.rejects(preflight({ ...approval, connectionId: otherConnection }), /review the saved DataForSEO connection/iu);
    await assert.rejects(preflight({ ...approval, secretVersion: 2 }), /renew its paid scheduling approval/u);
    await assert.rejects(preflight({ ...approval, assets: [...approval.assets, { asset: 'unlisted.example', families: ['serp-panel'] }] }), /assets selected/u);
    writeConstants(east, { ...settings, monthly_caps: { data_usd: 0 } });
    await assert.rejects(preflight(approval), /positive monthly data cap/u);
    writeConstants(east, settings);
    await preflight(approval);
    const store = openWorkspaceStore(db.address, { workspaceId: east, maxConnections: 1 });
    try {
      const paidJobs = async value => (await customerSchedules(store, null, customerCollectionPolicy(value)))
        .filter(({ job }) => job.startsWith('dataforseo')).map(({ job }) => job);
      assert.deepEqual(await paidJobs({}), []);
      assert.deepEqual(await paidJobs({ paidDataForSeo: [{ ...approval, weekly: false, recovery: true }] }), ['dataforseo-recovery']);
    } finally { await store.close(); }
    const file = path.join(root, 'settings.json');
    writeFileSync(file, JSON.stringify({
      format: 'noticeos-customer-operating/1', database: { app: db.address, identity: db.identityDatabase, grant: db.grantConnectionString },
      identitySecret, credentialsKey, workspaces, mailRecipients: app.workspaces.map(({ email }) => email), paidDataForSeo: [approval],
    }), { mode: 0o600 });
    assert.deepEqual(paidCalls, []);
    await app.close(); app = undefined;
    app = await startAttachedCustomer(attached, file, { dataForSeoTransport: transport, startSchedules(options) {
      workers = options;
      bucket = options.bucket;
      return startLocalCustomerSchedules({ ...options, now: () => scheduledAt,
        paidWorker: { async fetch(request) {
          regularWorkerStatus.push((await options.worker.fetch(request.clone())).status);
          return options.paidWorker.fetch(request);
        } } });
    } });
    await app.whenIdle();
    const receipts = db.cluster.sql(`SELECT workspace_id,lane,state,occurrence
      FROM noticeos.hosted_job_occurrences WHERE lane LIKE 'dataforseo%'`);
    assert.deepEqual(paidCalls, [
      ['/v3' + DATAFORSEO_REPORT_PATHS.backlinksSummary, alpha], ['/v3' + DATAFORSEO_REPORT_PATHS.competitors, beta],
    ], JSON.stringify({ receipts, errors: db.cluster.sql(`SELECT report,error_code
      FROM noticeos.archive_runs WHERE integration='dataforseo' AND status='error'`) }));
    assert.deepEqual(regularWorkerStatus, [403]);
    assert.equal(accountCalls.length, 1);
    const reports = db.cluster.sql(`SELECT r.workspace_id,r.asset_id,r.report,a.object_key,r.cost_usd::text AS cost
      FROM noticeos.archive_runs r JOIN noticeos.archive_objects a USING(workspace_id,object_seq)
      WHERE r.integration='dataforseo' AND r.status='success' ORDER BY r.asset_id`);
    assert.deepEqual(reports.map(({ workspace_id, asset_id, report, cost }) => [workspace_id, asset_id, report, cost]),
      [[east, alpha, 'backlinks-summary', '0.020000'], [east, beta, 'serp-competitors', '0.020000']]);
    for (const { object_key } of reports) {
      assert.ok(object_key.startsWith('workspaces/' + east + '/raw/'));
      assert.ok(await bucket.head(object_key));
    }
    const charges = db.cluster.sql(`SELECT workspace_id,asset_id,provider_cost_usd::text AS cost,provider_completed::text
      FROM noticeos.dataforseo_request_charges ORDER BY asset_id`);
    assert.deepEqual(charges, [alpha, beta].map(asset_id => ({ workspace_id: east, asset_id, cost: '0.020000', provider_completed: 'true' })));
    assert.deepEqual(receipts, [{ workspace_id: east, lane: 'dataforseo', state: 'exhausted', occurrence }]);
    assert.deepEqual(db.cluster.sql(`SELECT workspace_id,asset_id,error_code FROM noticeos.archive_runs
      WHERE integration='dataforseo' AND status='error'`), [{ workspace_id: east, asset_id: gamma, error_code: 'budget_exhausted' }]);
    const repeat = new Request('https://scheduler.internal/collect', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: east, asset: null, job: 'dataforseo', occurrence }) });
    assert.equal((await workers.paidWorker.fetch(repeat)).status, 403);
    assert.equal((await workers.paidWorker.fetch(CUSTOMER_GOOGLE_ARCHIVE_PLAN_URL, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId: east }) })).status, 403);
    assert.equal(paidCalls.length, 2);

    const captureAt = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 60_000;
    const reportDate = new Date(captureAt).toISOString().slice(0, 10);
    const capturedApproval = { ...approval, approvedMonthlyCapUsd: 1, assets: [{ asset: gamma, families: ['backlinks-summary'] }] };
    const blockArchiveStatus = status => db.cluster.run(`CREATE FUNCTION public.reject_fixture_paid_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic manifest write failed'; END $$;
      CREATE TRIGGER fixture_paid_recovery BEFORE INSERT ON noticeos.archive_runs FOR EACH ROW
      WHEN (NEW.workspace_id=:'workspace'::uuid AND NEW.asset_id=:'asset'
        AND NEW.report_date=:'date'::date AND NEW.status=:'status') EXECUTE FUNCTION public.reject_fixture_paid_recovery();`,
    { vars: { workspace: east, asset: gamma, date: reportDate, status } });
    const permitArchive = () => db.cluster.run('DROP TRIGGER fixture_paid_recovery ON noticeos.archive_runs; DROP FUNCTION public.reject_fixture_paid_recovery();');
    writeConstants(east, { ...settings, monthly_caps: { data_usd: 1 } });
    const { runCustomerDataForSeo, DATAFORSEO_CHECKPOINT_PREFIX } = await loadCustomerWorkflowModule(plan.root, root, `
      export { runCustomerDataForSeo } from './customer-dataforseo.ts';
      export { DATAFORSEO_CHECKPOINT_PREFIX } from './dataforseo-dumps.ts';
    `);
    const priorStore = openWorkspaceStore(db.address, { workspaceId: east });
    try {
      blockArchiveStatus('error');
      await assert.rejects(runCustomerDataForSeo({
        STORE: priorStore, NOTICEOS_WORKSPACE_PROFILE: 'hosted', CREDENTIALS_KEY: credentialsKey,
        RAW_SIGNALS: { get: key => bucket.get(key), async put(key, body, metadata) {
          if (key.startsWith(`workspaces/${east}/raw/`)) throw new Error('Synthetic final archive write failed');
          return bucket.put(key, body, metadata);
        } },
      }, { job: 'dataforseo', approval: capturedApproval, signal: new AbortController().signal, authorizePurchase: async () => {} },
      { nowMs: captureAt, fetchImpl: transport }), /Synthetic manifest write failed/u);
    } finally { await priorStore.close(); permitArchive(); }
    const listed = await bucket.list({ prefix: `workspaces/${east}/${DATAFORSEO_CHECKPOINT_PREFIX}/${gamma}/${reportDate}/` });
    assert.equal(listed.objects.length, 1);
    const checkpointKey = listed.objects[0].key;
    const checkpoint = await bucket.get(checkpointKey);
    const staged = await checkpoint.text();
    const metadata = checkpoint.customMetadata;
    assert.equal(paidCalls.length, 3);
    assert.equal(accountCalls.length, 1);
    await bucket.put(checkpointKey, staged, { customMetadata: { ...metadata, workspaceId: west } });
    const runtime = JSON.parse(readFileSync(file, 'utf8'));
    writeConstants(east, settings);
    writeFileSync(file, JSON.stringify({ ...runtime,
      paidDataForSeo: [{ ...approval, weekly: false, recovery: true, assets: capturedApproval.assets }],
    }), { mode: 0o600 });
    const restartForRecovery = async offset => {
      await app.close(); app = undefined;
      app = await startAttachedCustomer(attached, file, { dataForSeoTransport: transport, startSchedules(options) {
        bucket = options.bucket;
        return startLocalCustomerSchedules({ ...options, now: () => scheduledAt + offset * 60_000 });
      } });
      await app.whenIdle();
    };
    const recoveryRows = () => db.cluster.script(`SELECT report_date::text,status,error_code,cost_usd::text AS cost
      FROM noticeos.archive_runs WHERE workspace_id=:'workspace'::uuid AND asset_id=:'asset'
        AND report_date=:'date'::date ORDER BY finished_at, run_id;`, { vars: { workspace: east, asset: gamma, date: reportDate } });
    await restartForRecovery(1);
    assert.deepEqual(recoveryRows().map(row => row.error_code), ['dataforseo_checkpoint_incomplete']);
    assert.ok(await bucket.head(checkpointKey));
    await bucket.put(checkpointKey, staged, { customMetadata: metadata });

    blockArchiveStatus('success');
    await restartForRecovery(2);
    assert.deepEqual(recoveryRows().map(row => row.error_code), ['dataforseo_checkpoint_incomplete', 'local_store_failed']);
    assert.ok(await bucket.head(checkpointKey));
    permitArchive();
    await restartForRecovery(3);
    assert.deepEqual(recoveryRows().at(-1), { report_date: reportDate, status: 'success', error_code: null, cost: '0.000000' });
    assert.equal(await bucket.head(checkpointKey), null);
    const [published] = db.cluster.script(`SELECT o.object_key
      FROM noticeos.archive_runs r JOIN noticeos.archive_objects o USING (workspace_id, object_seq)
      WHERE r.workspace_id=:'workspace'::uuid AND r.asset_id=:'asset'
        AND r.report_date=:'date'::date AND r.status='success';`, { vars: { workspace: east, asset: gamma, date: reportDate } });
    const envelope = JSON.parse(gunzipSync(Buffer.from(await (await bucket.get(published.object_key)).arrayBuffer())));
    assert.equal(envelope.reportDate, reportDate);
    assert.deepEqual(envelope.pages[0].response, JSON.parse(staged).page.response);
    assert.deepEqual(db.cluster.sql(`SELECT state FROM noticeos.hosted_job_occurrences
      WHERE lane='dataforseo-recovery' ORDER BY occurrence`),
    [{ state: 'exhausted' }, { state: 'exhausted' }, { state: 'succeeded' }]);
    assert.deepEqual(db.cluster.sql(`SELECT asset_id,provider_cost_usd::text AS cost FROM noticeos.dataforseo_request_charges ORDER BY asset_id`),
      [{ asset_id: alpha, cost: '0.020000' }, { asset_id: beta, cost: '0.020000' }, { asset_id: gamma, cost: '0.020000' }]);
    assert.equal(paidCalls.length, 3);
    assert.equal(accountCalls.length, 1);
  } finally {
    try { await app?.close(); }
    finally { await db?.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
