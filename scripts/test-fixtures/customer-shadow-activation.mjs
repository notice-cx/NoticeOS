import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from '../browser-request-policy.mjs';
import { LOOPBACK_HBA } from '../postgres-dev.mjs';
import { applyMigrations, bootstrapWorkspace } from '../postgres-migrate.mjs';
import { openNtasksPlatformProvisioning, ntasksActivationVerifier } from '../ntasks-activation.mjs';
import { REPO_ROOT } from '../test-config-isolation.mjs';
import { bundleWorkerFixture, Miniflare } from '../worker-entry-test-fixture.mjs';
import { openEmailCodeLogin, EMAIL_CODE_PATHS } from '../../packages/postgres/src/email-code.mjs';
import { openIdentity } from '../../packages/postgres/src/identity.mjs';
import { shadowEvidence } from './customer-shadow-evidence.mjs';

/** Verify platform activation and restore a narrow evidence sample into that
 * workspace. Inputs belong only to the two disposable local test services. */
export async function assertNtasksShadowActivation({ root, cluster, ntasksOrigin, ntasks, t }) {
  const owner = cluster.onDatabase('postgres');
  const sourceName = 'noticeos_rehearsal_source_dev', targetName = 'noticeos_rehearsal_shadow_dev';
  owner.run(`CREATE DATABASE ${sourceName}; CREATE DATABASE ${targetName};`);
  const source = cluster.onDatabase(sourceName), target = cluster.onDatabase(targetName);
  applyMigrations(source); applyMigrations(target);
  const workspaceId = randomUUID();
  bootstrapWorkspace(source, { workspaceId, slug: 'retained-fixture', displayName: 'Retained fixture' });
  const asset = 'canopy.example', date = '2026-10-02', at = `${date}T23:30:00.000Z`;
  source.run(`INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position)
    VALUES (:'workspace'::uuid,:'asset',:'asset','Canopy','live',1);
    INSERT INTO noticeos.pulses(workspace_id,pulse_number,asset_id,pulse_date,generated_at,received_at,capabilities,envelope)
    VALUES (:'workspace'::uuid,1,:'asset',:'date'::date,:'at'::timestamptz,:'at'::timestamptz,'["signups"]',:'envelope'::json)`,
  { vars: { workspace: workspaceId, asset, date, at,
    envelope: JSON.stringify({ asset, generatedAt: at, capabilities: ['signups'], metrics: { signups: { last24h: 7, avg7d: 5, total: 70 } } }) } });
  const evidence = await shadowEvidence({ root, source, target, asset, date, at, workspaceId });
  const dump = path.join(root, 'synthetic-shadow-evidence.dump');
  const binaries = path.dirname(cluster.tools.psql);
  const socket = [`--host=${cluster.socketDir}`, `--port=${cluster.loopbackPort}`, '--username=postgres', '--no-password'];
  execFileSync(path.join(binaries, 'pg_dump'), [...socket, '--format=custom', '--data-only', '--table=noticeos.assets',
    '--table=noticeos.pulses', `--file=${dump}`, sourceName]);

  const login = cluster.applicationLogin();
  const role = name => {
    const secret = randomBytes(32).toString('hex');
    owner.run(`ALTER ROLE ${name} LOGIN PASSWORD '${secret}'`);
    appendFileSync(path.join(cluster.root, LOOPBACK_HBA), `host all ${name} 127.0.0.1/32 scram-sha-256\n`);
    const url = new URL(login.url(targetName)); url.username = name; url.password = secret;
    return url.href;
  };
  const platformConnectionString = role('noticeos_platform'), identityConnectionString = role('noticeos_identity');
  execFileSync(cluster.tools.pgCtl, ['reload', '-D', path.join(cluster.root, 'data')], { stdio: 'pipe' });
  const trustedOrigin = 'https://shadow.example.test', sessionSecret = randomBytes(48).toString('base64url');
  const options = { platformConnectionString, identityConnectionString, trustedOrigin, sessionSecret };
  const binding = { workspaceId, projectId: ntasks.projectId, origin: ntasksOrigin, ntasksWorkspaceId: ntasks.workspaceId,
    executorRef: randomUUID(), credentialRef: randomUUID(), databaseKey: `n_${randomUUID().replaceAll('-', '')}`, serviceToken: ntasks.token };
  const platform = openNtasksPlatformProvisioning(options, binding);
  const wrongRole = openNtasksPlatformProvisioning({ ...options, platformConnectionString: identityConnectionString }, binding);
  const readOnly = openNtasksPlatformProvisioning(options, { ...binding, serviceToken: ntasks.readonlyToken });
  const messages = [];
  const email = 'shadow-owner@example.test';
  const signIn = openEmailCodeLogin({ connectionString: identityConnectionString, trustedOrigin, sessionSecret, peerAddress: '192.0.2.42',
    deliver: async message => { messages.push(message); } });
  let identity, runtime, standalone;
  try {
    const prepared = await platform.prepare({ workspaceId, slug: 'retained-fixture', displayName: 'Retained fixture', intendedEmail: email,
      expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const enrollment = { kind: 'platform', id: prepared.enrollmentId };
    const request = (action, body = {}) => new Request(`${trustedOrigin}${EMAIL_CODE_PATHS[action]}`, {
      method: 'POST', headers: { origin: trustedOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await signIn.requestCode(request('request', { email }), enrollment)).status, 202);
    assert.equal(messages.length, 1);
    const verified = await signIn.verifyCode(request('verify', { email, otp: messages[0].code }), enrollment);
    assert.equal(verified.status, 200);
    const cookie = verified.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
    identity = await openIdentity({ connectionString: identityConnectionString, trustedOrigin, sessionSecret });
    const session = await identity.session(new Headers({ cookie }));
    assert.ok(session);
    assert.equal(await identity.membership(new Headers({ cookie }), workspaceId), null);
    target.run(`INSERT INTO noticeos_platform.task_project_directory(workspace_id,project_id,executor_ref,credential_ref,database_key)
      VALUES (:'workspace'::uuid, :'project'::uuid, :'executor'::uuid, :'credential'::uuid, :'database')`,
    { vars: { workspace: workspaceId, project: binding.projectId, executor: binding.executorRef, credential: binding.credentialRef, database: binding.databaseKey } });
    const activation = { ...prepared, projectId: binding.projectId };
    await assert.rejects(wrongRole.activate(activation));
    await assert.rejects(readOnly.activate(activation));
    await assert.rejects(platform.activate({ ...activation, projectId: randomUUID() }));
    assert.equal(await identity.membership(new Headers({ cookie }), workspaceId), null);

    const controller = new AbortController();
    let started, cleaned = false;
    const entered = new Promise(resolve => { started = resolve; });
    const blocked = ntasksActivationVerifier(binding, async (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { cleaned = true; reject(init.signal.reason); }, { once: true });
      started();
    }));
    const pending = assert.rejects(blocked(binding, { signal: controller.signal, deadline: Date.now() + 5000 }));
    await entered;
    controller.abort();
    await pending;
    assert.equal(cleaned, true);

    assert.deepEqual(await platform.activate(activation), prepared);
    assert.equal((await identity.membership(new Headers({ cookie }), workspaceId)).role, 'owner');
    const beforeCopy = evidence.targetCounts();
    execFileSync(path.join(binaries, 'pg_restore'), [...socket, '--single-transaction', '--exit-on-error',
      '--data-only', `--dbname=${targetName}`, dump]);

    const [tower, ingest] = await Promise.all(['tower', 'ingest'].map(name => bundleWorkerFixture(root, `shadow-${name}`,
      path.join(REPO_ROOT, name === 'tower' ? 'apps/tower/worker/index.ts' : 'workers/ingest/src/index.ts'))));
    const bindings = { NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_WORKSPACE_ORIGIN: trustedOrigin,
      NOTICEOS_WORKSPACE_DATABASE_URL: login.url(targetName), NOTICEOS_IDENTITY_DATABASE_URL: identityConnectionString,
      NOTICEOS_IDENTITY_SESSION_SECRET: sessionSecret };
    const denyOutbound = async () => assert.fail('The copied evidence is read without provider traffic');
    const sourceOrigin = 'https://standalone.example.test';
    const standaloneOperator = randomBytes(32).toString('base64url');
    standalone = new Miniflare({ workers: [
      { ...tower, name: 'standalone-tower', bindings: { NOTICEOS_WORKSPACE_PROFILE: 'standalone' },
        hyperdrives: { POSTGRES: login.url(sourceName) }, serviceBindings: { INGEST: 'standalone-ingest' }, outboundService: denyOutbound },
      { ...ingest, name: 'standalone-ingest', bindings: { NOTICEOS_WORKSPACE_PROFILE: 'standalone',
        OPERATOR_TOKEN: standaloneOperator, CREDENTIALS_KEY: evidence.sourceKey }, hyperdrives: { POSTGRES: login.url(sourceName) },
      r2Buckets: { RAW_SIGNALS: 'standalone-signals' }, outboundService: denyOutbound },
    ] });
    const sourceBucket = await standalone.getR2Bucket('RAW_SIGNALS', 'standalone-ingest');
    await evidence.initializeSourceBucket(sourceBucket);
    const regularReport = () => standalone.dispatchFetch(`${sourceOrigin}/api/assets/${asset}`, { signal: AbortSignal.timeout(30000) });
    const regularSettings = () => standalone.dispatchFetch(`${sourceOrigin}/api/settings?view=preferences`);
    const standaloneIngest = await standalone.getWorker('standalone-ingest');
    const legacy = () => standaloneIngest.fetch(`${sourceOrigin}/api/panel-object?key=${encodeURIComponent(evidence.legacyKey)}`, {
      headers: { authorization: `Bearer ${standaloneOperator}` },
    });
    const standaloneConnection = async () => {
      const answer = await standaloneIngest.fetch(`${sourceOrigin}/api/task-service`, {
        headers: { authorization: `Bearer ${standaloneOperator}` },
      });
      assert.equal(answer.status, 200);
      return answer.json();
    };
    const original = await regularReport();
    assert.equal(original.status, 200);
    assert.ok((await original.text()).includes(at));
    assert.equal((await (await regularSettings()).json()).clock.timeZone, evidence.zone);
    const originalLegacy = await legacy();
    assert.equal(originalLegacy.status, 200);
    const originalLegacyBody = await originalLegacy.text();
    const originalConnection = await standaloneConnection();
    assert.equal(originalConnection.connected, true);

    const shadowKey = randomBytes(32).toString('base64');
    let reconnect = false;
    const providerReads = [];
    const fixtureTaskService = async request => {
      const url = new URL(request.url);
      if (!reconnect || request.method !== 'GET' || url.origin !== ntasksOrigin
        || !['/api/access/me', '/api/tasks/projects'].includes(url.pathname)) return denyOutbound();
      providerReads.push(url.pathname);
      return fetch(url, { headers: Object.fromEntries(request.headers), method: 'GET', redirect: 'error' });
    };
    runtime = new Miniflare({ workers: [
      { ...tower, name: 'shadow-tower', bindings, serviceBindings: { INGEST: 'shadow-ingest' }, outboundService: denyOutbound },
      { ...ingest, name: 'shadow-ingest', bindings: { ...bindings, NOTICEOS_NTASKS_ORIGIN: ntasksOrigin, CREDENTIALS_KEY: shadowKey },
        r2Buckets: { RAW_SIGNALS: 'shadow-signals' }, outboundService: fixtureTaskService },
    ] });
    const shadowBucket = await runtime.getR2Bucket('RAW_SIGNALS', 'shadow-ingest');
    const copied = await evidence.copy({ sourceBucket, shadowBucket, sourceUrl: login.url(sourceName), shadowUrl: login.url(targetName) });
    assert.equal(beforeCopy.connections + beforeCopy.secrets + beforeCopy.jobs, 0);
    assert.deepEqual(copied, { ...beforeCopy, assets: 1, reports: 1, runs: 1, objects: 1, audits: beforeCopy.audits + 1 });
    const headers = { cookie, [WORKSPACE_SESSION_HEADER]: session.sessionId, [WORKSPACE_SELECTION_HEADER]: workspaceId };
    const read = route => runtime.dispatchFetch(`${trustedOrigin}${route}`, { headers, signal: AbortSignal.timeout(30000) });
    const report = await read(`/api/assets/${asset}`);
    assert.equal(report.status, 200, await report.clone().text());
    const shown = await report.text();
    assert.match(shown, /Canopy/u);
    assert.ok(shown.includes(at), 'the shadow report retains the source generation time');
    assert.equal((await runtime.dispatchFetch(`${trustedOrigin}/api/assets/${asset}`, { headers: { ...headers, [WORKSPACE_SELECTION_HEADER]: randomUUID() } })).status, 403);
    const settings = await read('/api/settings?view=preferences');
    assert.equal(settings.status, 200);
    assert.deepEqual((await settings.json()).clock, { owner: 'config/constants.json', chosen: true, timeZone: evidence.zone });
    const feed = await read('/api/wall/feed');
    assert.equal(feed.status, 200);
    const audit = (await feed.json()).items.find(item => item.kind === 'setting-saved' && item.at === evidence.changedAt);
    assert.ok(audit?.text.includes(evidence.reason));
    assert.equal((await read(`/api/panel-object?key=${encodeURIComponent(evidence.ownKey)}`)).status, 403);
    assert.equal((await (await read('/api/tasks/service')).json()).connected, false);
    assert.deepEqual(providerReads, []);
    assert.deepEqual(evidence.targetCounts(), copied);

    // Reconnecting is separate from the finished read-only rehearsal.
    reconnect = true;
    target.run(`UPDATE noticeos.config_documents SET body=:'body'::json WHERE workspace_id=:'workspace'::uuid AND document_key='beads'`,
      { vars: { workspace: workspaceId, body: JSON.stringify({ spokes: [{ asset, prefix: ntasks.prefix, database: ntasks.prefix }] }) } });
    const connected = await runtime.dispatchFetch(trustedOrigin + '/api/integrations/ntasks/connect', {
      method: 'POST', headers: { ...headers, origin: trustedOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { NTASKS_URL: ntasksOrigin, NTASKS_WORKSPACE_ID: ntasks.workspaceId, NTASKS_TOKEN: ntasks.token } }),
    });
    assert.equal(connected.status, 200, await connected.clone().text());
    assert.equal((await connected.json()).verdict, 'accepted');
    assert.equal((await (await read('/api/tasks/service')).json()).connected, true);
    assert.deepEqual([...new Set(providerReads)].sort(), ['/api/access/me', '/api/tasks/projects']);
    const reconnected = evidence.targetCounts();
    assert.deepEqual(reconnected, { ...copied, connections: 1, secrets: 1 });
    evidence.verifyReconnection();
    await runtime.dispose(); runtime = undefined;
    const rolledBack = await regularReport();
    assert.equal(rolledBack.status, 200);
    assert.ok((await rolledBack.text()).includes(at));
    assert.equal((await (await regularSettings()).json()).clock.timeZone, evidence.zone);
    assert.equal(await (await legacy()).text(), originalLegacyBody);
    assert.deepEqual(await standaloneConnection(), originalConnection);
    await evidence.verifyRollback(sourceBucket);
    assert.deepEqual(source.sql('SELECT workspace_id,display_name FROM noticeos.assets'), [{ workspace_id: workspaceId, display_name: 'Canopy' }]);
    assert.deepEqual(source.sql('SELECT pulse_date::text AS date FROM noticeos.pulses'), [{ date }]);
    t.diagnostic(`Source before and after rollback: ${JSON.stringify(evidence.before)}. Shadow before copy: ${JSON.stringify(beforeCopy)}. Shadow after copy: ${JSON.stringify(copied)}. Shadow after a fresh Ntasks connection: ${JSON.stringify(reconnected)}.`);
  } finally {
    await Promise.allSettled([runtime?.dispose(), standalone?.dispose(), identity?.close(), signIn.close(), readOnly.close(), wrongRole.close(), platform.close()]);
  }
}
