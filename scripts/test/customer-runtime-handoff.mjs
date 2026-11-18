import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../browser-request-policy.mjs';
import { CONFIG_DOCUMENT_FILES, configDocumentKey } from '../config-documents.mjs';
import { hostedTaskAuthorization } from '../hosted-task-request.mjs';
import { buildHostedApp } from '../hosted-demo-build.mjs';
import { startPreparedCustomer } from '../local-customer-attach.mjs';
import { openCustomerTarget } from '../local-customer-operating.mjs';
import { applyMigrations, bootstrapWorkspace } from '../postgres-migrate.mjs';
import { REPO_ROOT } from '../test-config-isolation.mjs';
import { shadowEvidence } from '../test-fixtures/customer-shadow-evidence.mjs';
import { bundleWorkerFixture, Miniflare } from '../worker-entry-test-fixture.mjs';
import { openEmailCodeLogin, EMAIL_CODE_PATHS } from '../../packages/postgres/src/email-code.mjs';
import { openIdentity } from '../../packages/postgres/src/identity.mjs';
import { openWorkspaceServiceGrant } from '../../packages/postgres/src/service-grant.mjs';
import { customerReadinessStatus } from '../../deploy/compose/health.mjs';
import { verifyComposeCustomerWorkspace } from '../../deploy/compose/customer-entry.mjs';

/** Open the same disposable stores one runtime at a time. */
export async function assertSameStoreHandoff({ root, postgres, ownerOrigin, ntasksOrigin, actor, t }) {
  const database = 'noticeos_handoff_dev';
  postgres.cluster.onDatabase('postgres').run(`CREATE DATABASE ${database};`);
  const copy = postgres.cluster.onDatabase(database);
  applyMigrations(copy);
  const workspaceId = randomUUID(), serviceId = randomUUID(), userId = randomUUID();
  const asset = 'canopy.example', email = 'handoff-owner@example.test';
  const slug = 'handoff-fixture';
  const configurationRoot = path.join(root, 'handoff', 'fixture-config');
  cpSync(path.join(REPO_ROOT, 'workers/ingest/test/fixture-config'), configurationRoot, { recursive: true });
  copyFileSync(path.join(REPO_ROOT, 'scripts/fixture-config/beads.json'), path.join(configurationRoot, 'beads.json'));
  const defaults = CONFIG_DOCUMENT_FILES.map(file => ({ key: configDocumentKey(file),
    body: readFileSync(path.join(configurationRoot, path.basename(file)), 'utf8') }));
  bootstrapWorkspace(copy, { workspaceId, slug, displayName: 'Handoff fixture' });
  copy.run(`INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position)
    VALUES (:'workspace'::uuid, :'asset', :'asset', 'Canopy', 'live', 1);
    INSERT INTO noticeos.config_documents(workspace_id,document_key,version,body,updated_at,updated_by)
    SELECT :'workspace'::uuid, key, 1, body::jsonb, now(), 'fixture'
      FROM jsonb_to_recordset(:'defaults'::jsonb) AS doc(key text, body text) WHERE key NOT IN ('beads','constants','tower');
    INSERT INTO noticeos.config_documents(workspace_id,document_key,version,body,updated_at,updated_by)
    VALUES (:'workspace'::uuid,'beads',1,:'spokes'::json,now(),'fixture');
    INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at)
    VALUES (:'workspace'::uuid, 'Handoff fixture', :'slug', now()) ON CONFLICT (id) DO NOTHING;
    INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified)
    VALUES (:'user'::uuid, 'Fixture owner', :'email', true);
    INSERT INTO noticeos_identity.auth_member(organization_id,user_id,role,created_at)
    VALUES (:'workspace'::uuid, :'user'::uuid, 'owner', now());
    INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at)
    VALUES (:'service'::uuid, :'workspace'::uuid, ARRAY['workflows.run'], now()+interval '1 hour');`, {
    vars: { workspace: workspaceId, asset, slug, user: userId, email, service: serviceId, defaults: JSON.stringify(defaults),
      spokes: JSON.stringify({ spokes: [{ asset, prefix: actor.prefix, database: actor.prefix }] }) },
  });
  const toCopy = connection => {
    const url = new URL(connection);
    url.pathname = '/' + database;
    return url.href;
  };
  const appAddress = toCopy(postgres.address), identityAddress = toCopy(postgres.identityDatabase);
  const grantAddress = toCopy(postgres.grantConnectionString);
  const serviceGrant = openWorkspaceServiceGrant({ connectionString: grantAddress,
    workspaceId, principalId: serviceId });
  try { assert.deepEqual((await serviceGrant.facts()).actions, ['workflows.run']); }
  finally { await serviceGrant.close(); }

  const date = '2026-10-02', at = date + 'T18:00:00Z';
  const evidence = await shadowEvidence({ root, source: copy, asset, date, at, workspaceId, taskConnection: {
    NTASKS_URL: ntasksOrigin, NTASKS_WORKSPACE_ID: actor.workspaceId, NTASKS_TOKEN: actor.token,
  } });
  const credentialsKey = evidence.sourceKey;
  const sessionSecret = randomBytes(48).toString('base64url');
  const mail = [];
  const identityInput = { connectionString: identityAddress, trustedOrigin: ownerOrigin, sessionSecret };
  const login = openEmailCodeLogin({ ...identityInput, peerAddress: '127.0.0.1', deliver: async message => { mail.push(message); } });
  const authenticate = (route, body) => new Request(ownerOrigin + route, { method: 'POST',
    headers: { origin: ownerOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ email, ...body }) });
  let session;
  try {
    assert.equal((await login.requestCode(authenticate(EMAIL_CODE_PATHS.request))).status, 202);
    const verified = await login.verifyCode(authenticate(EMAIL_CODE_PATHS.verify, { otp: mail[0].code }));
    assert.equal(verified.status, 200);
    const cookie = verified.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const reader = await openIdentity(identityInput);
    try { session = { cookie, sessionId: (await reader.session(new Headers({ cookie }))).sessionId }; }
    finally { await reader.close(); }
  } finally { await login.close(); }
  const owner = { cookie: session.cookie, [WORKSPACE_SELECTION_HEADER]: workspaceId,
    [WORKSPACE_SESSION_HEADER]: session.sessionId, origin: ownerOrigin };
  const board = { cookie: session.cookie, origin: ownerOrigin,
    authorization: 'Bearer ' + hostedTaskAuthorization(workspaceId, session.sessionId, null) };

  const [tower, ingest] = await Promise.all([
    bundleWorkerFixture(root, 'handoff-tower', path.join(REPO_ROOT, 'apps/tower/worker/index.ts')),
    bundleWorkerFixture(root, 'handoff-ingest', path.join(REPO_ROOT, 'workers/ingest/src/index.ts')),
  ]);
  const archiveRoot = path.join(root, 'handoff', '.wrangler', 'state', 'v3');
  const output = 'noticeos-raw-signals';
  const operator = randomBytes(32).toString('base64url'), sender = randomBytes(32).toString('base64url');
  const allowLocalNtasks = async request => {
    const url = new URL(request.url);
    if (url.origin !== ntasksOrigin) return assert.fail('The handoff makes no external collection requests.');
    return fetch(url, { method: request.method, headers: Object.fromEntries(request.headers), redirect: 'error',
      ...(request.body ? { body: await request.arrayBuffer() } : {}) });
  };
  const startStandalone = () => {
    const bindings = { NOTICEOS_WORKSPACE_PROFILE: 'standalone', CREDENTIALS_KEY: credentialsKey };
    // Wrangler expands --persist-to to this same v3 root and opens RAW_SIGNALS
    // under the bucket name in its standalone worker configuration.
    return new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, resourcePersistencePath: archiveRoot,
      workers: [
        { ...tower, name: 'handoff-tower', bindings, hyperdrives: { POSTGRES: appAddress },
          serviceBindings: { INGEST: 'handoff-ingest' } },
        { ...ingest, name: 'handoff-ingest', bindings: { ...bindings, OPERATOR_TOKEN: operator,
          ASSET_TOKENS: JSON.stringify({ [asset]: sender }) }, hyperdrives: { POSTGRES: appAddress },
          r2Buckets: { RAW_SIGNALS: output }, outboundService: allowLocalNtasks },
      ],
    });
  };
  const readReport = async (runtime, headers = {}) => {
    const worker = await runtime.getWorker('handoff-tower');
    const response = await worker.fetch(ownerOrigin + '/api/assets/' + asset, { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  const sendReport = (worker, token, generatedAt, signups) => worker.fetch(ownerOrigin + '/api/pulse', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ asset, generatedAt, capabilities: ['signups'],
      metrics: { signups: { last24h: signups, avg7d: 3, total: 100 + signups } } }) });
  const readStandaloneProject = async (runtime, route) => {
    const worker = await runtime.getWorker('handoff-ingest');
    const result = await worker.fetch(ownerOrigin + '/api/task-service', { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + operator },
      body: JSON.stringify({ method: 'GET', path: route }) });
    assert.equal(result.status, 200);
    const reply = await result.json();
    assert.equal(reply.status, 200);
    return reply.body;
  };
  const archives = (runtime, profile) => runtime.getR2Bucket('RAW_SIGNALS', 'handoff-ingest')
    .then(bucket => evidence.readSourceArchives({ bucket, databaseUrl: appAddress, profile }));
  let runtime, hostedApp;
  try {
    runtime = startStandalone();
    const before = await runtime.getWorker('handoff-ingest');
    await evidence.initializeSourceBucket(await runtime.getR2Bucket('RAW_SIGNALS','handoff-ingest'));
    assert.equal((await sendReport(before, sender, at, 7)).status, 201);
    assert.equal((await readReport(runtime)).metrics.find(metric => metric.name === 'signups')?.last24h, 7);
    const originalKeys = [evidence.legacyKey, evidence.ownKey].sort();
    assert.deepEqual(await archives(runtime, 'standalone'), originalKeys);
    assert.deepEqual((await readStandaloneProject(runtime, '/api/tasks/projects')).projects.map(row => row.projectId), [actor.projectId]);
    await runtime.dispose(); runtime = undefined;

    const artifactRoot = path.join(root, 'handoff', 'hosted-artifacts');
    await buildHostedApp({ out: artifactRoot, configurationRoot, profile: 'hosted' });
    const customerState = path.join(root, 'handoff', 'customer');
    mkdirSync(customerState, { mode: 0o700 });
    const plan = { root: REPO_ROOT, url: ownerOrigin, port: Number(new URL(ownerOrigin).port) };
    const operating = { address: appAddress, identityAddress, grantAddress, credentialsKey, identitySecret: sessionSecret,
      siteReports: true, googleDaily: false, ntasksOrigin, mailRecipients: [email], workspaces: [{ workspaceId, serviceId }],
      target: new URL(appAddress).host + '/' + database };
    await verifyComposeCustomerWorkspace(ownerOrigin, operating);
    const unusableIdentity = new URL(identityAddress);
    unusableIdentity.password = 'incorrect-fixture-password';
    await assert.rejects(verifyComposeCustomerWorkspace(ownerOrigin, { ...operating, identityAddress: unusableIdentity.href }), /identity role/u);
    const receipt = path.join(customerState, 'target.json');
    const open = () => openCustomerTarget(plan, operating, path.join(customerState, 'app'), receipt);
    hostedApp = await startPreparedCustomer(plan, await open(), { deployment: { artifactRoot, archiveBucket: output, workerState: archiveRoot,
      listenPort: plan.port, bridgePeer: '172.17.0.1' } });
    await assert.rejects(open(), /already owns/u);
    const readiness = host => customerReadinessStatus(ownerOrigin + '/_noticeos/ready', { host, signal: AbortSignal.timeout(3_000) });
    assert.equal(await readiness(new URL(ownerOrigin).host), 204);
    assert.equal(await readiness('foreign.example'), 400);
    const report = await fetch(ownerOrigin + '/api/assets/' + asset, { headers: owner });
    assert.equal(report.status, 200);
    assert.equal((await report.json()).metrics.find(metric => metric.name === 'signups')?.last24h, 7);
    assert.equal((await fetch(ownerOrigin + '/api/assets/' + asset)).status, 403);
    const mcp = await fetch(ownerOrigin + '/api/mcp', { method: 'POST', headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(mcp.status, 200);
    assert.ok((await mcp.json()).result.tools.some(tool => tool.name === 'property_report'));
    const issue = await fetch(ownerOrigin + '/api/assets/' + asset + '/report-token', { method: 'POST', headers: owner });
    assert.equal(issue.status, 201);
    const pilotAt = '2026-10-03T18:00:00Z';
    const { token: pilotToken } = await issue.json();
    assert.equal((await sendReport({ fetch }, sender, pilotAt, 99)).status, 401);
    assert.equal((await sendReport({ fetch }, pilotToken, pilotAt, 9)).status, 201);
    const task = await fetch(ownerOrigin + '/api/tasks', { method: 'POST', headers: { ...board, 'content-type': 'application/json',
      'idempotency-key': 'same-store-handoff-write' }, body: JSON.stringify({ projectId: actor.projectId, title: 'Retain the pilot decision' }) });
    assert.equal(task.status, 200);
    const { id } = await task.json();
    await hostedApp.close(); hostedApp = undefined;

    const approved = activation => openCustomerTarget(plan, { ...operating, googleDaily: true }, path.join(customerState, 'app'), receipt, { activation });
    const withActivation = async (activation, check) => {
      const target = await approved(activation);
      try { check(target); } finally { await target.close(); }
    };
    await withActivation('first', target => { assert.equal(target.resumeSince, undefined); target.ready(); });
    await withActivation('first', target => assert.ok(Number.isFinite(target.resumeSince)));
    await withActivation('after-standalone', target => assert.equal(target.resumeSince, undefined));

    runtime = startStandalone();
    assert.equal((await readReport(runtime)).metrics.find(metric => metric.name === 'signups')?.last24h, 9);
    const originalIntake = await runtime.getWorker('handoff-ingest');
    assert.equal((await sendReport(originalIntake, pilotToken, pilotAt, 99)).status, 401);
    const resumedTask = await readStandaloneProject(runtime, `/api/tasks/${id}?project=${actor.projectId}`);
    assert.equal(resumedTask.task.title, 'Retain the pilot decision');
    assert.deepEqual(await archives(runtime, 'standalone'), originalKeys);
    await evidence.verifyPreservedStorage(await runtime.getR2Bucket('RAW_SIGNALS','handoff-ingest'));
    const dates = copy.sql(`SELECT pulse_date::text AS day, envelope->'metrics'->'signups'->>'last24h' AS signups
      FROM noticeos.current_pulses ORDER BY pulse_date`);
    assert.deepEqual(dates, [{ day: date, signups: '7' }, { day: '2026-10-03', signups: '9' }]);
    t.diagnostic('The same database, raw bucket and pinned Ntasks project served standalone, then the packaged runtime, then standalone.');
  } finally { try { await hostedApp?.close(); } finally { await runtime?.dispose(); } }
}
