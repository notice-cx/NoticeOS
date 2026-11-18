import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as deadline } from 'node:timers/promises';
import { APP_RELEASE_HEADER } from '../apps/tower/shared/app-release.ts';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { EMAIL_CODE_PATHS, PERSONAL_PROFILE_PATH } from './identity-protocol.mjs';
import { startLocalCustomerShadow } from './local-customer-shadow.mjs';
import { v4Miniflare } from './miniflare-v4.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { applyMigrations, bootstrapWorkspace } from './postgres-migrate.mjs';
import { scramVerifier } from './postgres-scram.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { useCustomerProfileBrowser } from './test-fixtures/customer-profile-browser.mjs';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

test('the customer shadow entry signs in an enrolled owner and serves stored evidence with jobs and writes disabled', { timeout: 180_000 }, async t => {
  const home = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'noticeos-shadow-'));
  const pgDir = path.join(home, 'postgres');
  const runtime = path.join(home, 'runtime.json');
  const receiptFile = path.join(home, 'shadow-target.json');
  const outbox = path.join(home, 'mail');
  const workerState = path.join(home, 'worker-state');
  let cluster, child, finished;
  try {
    mkdirSync(pgDir, { mode: 0o700 });
    cluster = await skipWithoutPostgres(t, () => openOnLoopbackPort(pgDir, findPostgres()));
    if (!cluster) return;
    const databasePort = cluster.loopbackPort;
    const origin = 'http://127.0.0.1:' + await freePort();
    cluster.run('CREATE DATABASE shadow_source;');
    const target = cluster;
    const source = cluster.onDatabase('shadow_source');
    const workspaceId = randomUUID();
    const ownerId = randomUUID();
    const ownerEmail = 'shadow-owner@example.test';
    const vars = { workspace: workspaceId, owner: ownerId, email: ownerEmail, member: randomUUID() };
    for (const [db, id] of [[target, 'target.example'], [source, 'source.example']]) {
      applyMigrations(db);
      bootstrapWorkspace(db, { workspaceId, slug: 'shadow', displayName: 'Shadow evidence' });
      db.run(`INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position)
        VALUES (:'workspace'::uuid,:'site',:'site',:'site','live',1)`, { vars: { ...vars, site: id } });
    }
    target.run(`UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=:'workspace'::uuid;
      INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at)
        VALUES (:'workspace'::uuid,'Shadow evidence','shadow',now());
      INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified) VALUES (:'owner'::uuid,'Owner',:'email',true);
      INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at)
        VALUES (:'member'::uuid,:'workspace'::uuid,:'owner'::uuid,'owner',now());`, { vars });
    const secret = randomBytes(32).toString('base64url');
    cluster.run("ALTER ROLE noticeos_identity LOGIN PASSWORD '" + scramVerifier(secret) + "';");
    appendFileSync(path.join(pgDir, LOOPBACK_HBA), 'host noticeos_dev noticeos_identity 127.0.0.1/32 scram-sha-256\n');
    execFileSync(cluster.tools.pgCtl, ['reload', '-D', path.join(pgDir, 'data')], { stdio: 'pipe' });
    const workspaceDatabaseUrl = cluster.applicationLogin().url();
    const identity = new URL(workspaceDatabaseUrl);
    identity.username = 'noticeos_identity';
    identity.password = secret;
    const input = { format: 'noticeos-customer-shadow/1', publicOrigin: origin, workspaceId, ownerEmail,
      workspaceDatabaseUrl, identityDatabaseUrl: identity.href, identitySecret: randomBytes(48).toString('base64url') };
    const manifest = data => writeFileSync(runtime, JSON.stringify(data), { mode: 0o600 });
    const [{ id: postgresSystemId }] = target.sql('SELECT system_identifier::text AS id FROM pg_control_system()');
    const receipt = { format: 'noticeos-shadow-target-v1', workspaceId, ownerEmail, postgresSystemId,
      dataDir: path.join(pgDir, 'data'), socketDir: realpathSync(cluster.socketDir), port: databasePort, database: 'noticeos_dev' };
    const saveReceipt = value => writeFileSync(receiptFile, JSON.stringify(value), { mode: 0o600 });
    const refuses = pattern => assert.rejects(async () => {
      const unexpected = await startLocalCustomerShadow(runtime);
      await unexpected.close();
    }, pattern);
    mkdirSync(outbox, { mode: 0o700 });
    mkdirSync(workerState, { mode: 0o700 });
    manifest(input);
    await refuses(/already activated target/u);
    saveReceipt({ ...receipt, postgresSystemId: '1' });
    await refuses(/already activated target/u);
    saveReceipt(receipt);
    manifest({ ...input, workspaceId: randomUUID() });
    await refuses(/already activated target/u);
    manifest({ ...input, ownerEmail: 'wrong-owner@example.test' });
    await refuses(/enrolled owner/u);
    const wrongDatabase = new URL(workspaceDatabaseUrl);
    wrongDatabase.pathname = '/shadow_source';
    const wrongIdentity = new URL(identity.href);
    wrongIdentity.pathname = '/shadow_source';
    manifest({ ...input, workspaceDatabaseUrl: wrongDatabase.href, identityDatabaseUrl: wrongIdentity.href });
    await refuses(/already activated target/u);

    let unexpectedConnections = 0;
    const otherEndpoint = net.createServer(socket => { unexpectedConnections++; socket.destroy(); });
    otherEndpoint.listen(0, '127.0.0.1');
    await once(otherEndpoint, 'listening');
    try {
      const otherApp = new URL(workspaceDatabaseUrl), otherIdentity = new URL(identity.href);
      otherApp.port = otherIdentity.port = String(otherEndpoint.address().port);
      manifest({ ...input, workspaceDatabaseUrl: otherApp.href, identityDatabaseUrl: otherIdentity.href });
      await refuses(/already activated target/u);
      assert.equal(unexpectedConnections, 0);
    } finally { await new Promise(resolve => otherEndpoint.close(resolve)); }
    manifest(input);

    const evidence = db => db.sql(`SELECT
      (SELECT md5(json_agg(a ORDER BY asset_id)::text) FROM noticeos.assets a) AS assets,
      (SELECT md5(json_agg(c ORDER BY document_key)::text) FROM noticeos.config_documents c) AS config,
      (SELECT count(*) FROM noticeos.task_snapshots) AS task_snapshots,
      (SELECT count(*) FROM noticeos.hosted_job_occurrences) AS jobs,
      (SELECT count(*) FROM noticeos.archive_objects) AS archive,
      (SELECT count(*) FROM noticeos.asset_insight_snapshots) AS reports`);
    const before = [evidence(source), evidence(target)];
    const script = fileURLToPath(new URL('./local-customer-shadow.mjs', import.meta.url));
    child = spawn(process.execPath, [script, runtime], { stdio: ['ignore', 'pipe', 'pipe'] });
    finished = once(child, 'close');
    let errors = '';
    child.stderr.on('data', chunk => { errors += String(chunk).slice(0, 2048); });
    const ready = new Promise(resolve => {
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes(origin)) resolve(true);
      });
    });
    assert.equal(await Promise.race([ready, finished.then(() => false), deadline(130_000, false, { ref: false })]), true, errors);
    await refuses(/already in use/u);
    const http = (route, { method = 'GET', body, headers = {} } = {}) => fetch(origin + route, {
      method, redirect: 'manual', signal: AbortSignal.timeout(20000),
      headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal((await http('/wall')).status, 200);
    const release = await http('/api/app-release');
    assert.equal(release.status, 200);
    const { release: appRelease } = await release.json();
    assert.match(appRelease, /^[0-9a-f]{64}$/u);
    assert.equal((await http('/api/wall')).status, 403);
    assert.equal((await http(EMAIL_CODE_PATHS.request, { method: 'POST', body: { email: 'other@example.test' } })).status, 403);
    assert.equal((await http(EMAIL_CODE_PATHS.request, { method: 'POST', body: { email: ownerEmail } })).status, 202);
    const [mail] = readdirSync(outbox).map(name => JSON.parse(readFileSync(path.join(outbox, name), 'utf8')));
    assert.equal(mail.to, ownerEmail);
    const otp = mail.text.match(/\b(\d{6})\.$/u)[1];
    const login = await http(EMAIL_CODE_PATHS.verify, { method: 'POST', body: { email: ownerEmail, otp } });
    assert.equal(login.status, 200, await login.clone().text());
    const cookie = login.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
    const session = await (await http('/api/session', { headers: { cookie, [WORKSPACE_SELECTION_HEADER]: workspaceId } })).json();
    assert.equal(session.selectedWorkspace.role, 'owner');
    assert.equal(session.backupPreview, true);
    const headers = { cookie, [APP_RELEASE_HEADER]: appRelease,
      [WORKSPACE_SESSION_HEADER]: session.session.sessionId, [WORKSPACE_SELECTION_HEADER]: workspaceId };
    const profile = await http(PERSONAL_PROFILE_PATH, { headers });
    assert.equal(profile.status, 200, await profile.clone().text());
    assert.equal(profile.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await profile.json(), { displayName: 'Owner', email: ownerEmail, editable: false });
    assert.equal((await http(PERSONAL_PROFILE_PATH, { headers: { ...headers, [WORKSPACE_SESSION_HEADER]: randomUUID() } })).status, 403);
    assert.equal((await http(PERSONAL_PROFILE_PATH, { method: 'PATCH', headers, body: { displayName: 'Other owner' } })).status, 403);
    assert.equal((await (await http(PERSONAL_PROFILE_PATH, { headers })).json()).displayName, 'Owner');
    if (process.env.NOTICEOS_TEST_CUSTOMER_PROFILE === '1') {
      await useCustomerProfileBrowser({ origin, outbox, email: ownerEmail, workspaceLabel: 'Shadow evidence',
        role: 'owner', initialName: 'Owner' });
    }
    const optional = await http('/api/tasks/capabilities', { headers });
    assert.equal(optional.status, 403);
    assert.equal(optional.headers.get(APP_RELEASE_HEADER), appRelease);
    const stale = await http('/api/tasks/capabilities', { headers: { ...headers, [APP_RELEASE_HEADER]: 'stale' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.headers.get(APP_RELEASE_HEADER), appRelease);
    assert.deepEqual(await stale.json(), { error: 'app_release_changed' });
    const wall = await http('/api/wall', { headers });
    assert.equal(wall.status, 200, await wall.clone().text());
    assert.equal(wall.headers.get(APP_RELEASE_HEADER), appRelease);
    const stored = await wall.json();
    assert.deepEqual(stored.assets.map(asset => asset.id), ['target.example']);
    assert.equal(stored.portfolioSummary.retained, false);
    assert.equal((await http('/api/wall', { headers: { ...headers, [WORKSPACE_SELECTION_HEADER]: randomUUID() } })).status, 403);
    for (const [route, method] of [
      ['/api/config', 'PUT'], ['/api/integrations/google/oauth/callback?state=blocked', 'GET'],
      ['/api/calendar/upcoming', 'GET'], ['/api/integrations/google/discovery', 'GET'],
      ['/api/mcp', 'POST'], ['/api/assets', 'POST'], ['/api/memberships', 'POST'], ['/api/tasks', 'POST'],
    ]) {
      assert.equal((await http(route, { method, headers, ...(method === 'GET' ? {} : { body: {} }) })).status, 403, route);
    }
    const works = await http('/api/work', { headers });
    assert.equal(works.status, 200, await works.clone().text());
    target.run('DELETE FROM noticeos_identity.auth_member WHERE id=:\'member\'::uuid;', { vars });
    assert.equal((await http('/api/wall', { headers })).status, 403);
    assert.deepEqual([evidence(source), evidence(target)], before);
    child.kill('SIGTERM');
    assert.deepEqual(await finished, [0, null], errors);
    child = undefined;
    assert.equal(existsSync(path.join(home, '.shadow-running')), false);
    await assert.rejects(http('/api/session'));

    const require = createRequire(new URL('../workers/ingest/package.json', import.meta.url));
    const { Miniflare, Log } = v4Miniflare(createRequire(require.resolve('wrangler/package.json')));
    const observer = new Miniflare({ host: '127.0.0.1', port: 0, log: new Log(0),
      telemetry: { enabled: false }, resourcePersistencePath: workerState, workers: [{ name: 'tower', modules: true,
        script: 'export default {}', r2Buckets: { NOTICEOS_PORTFOLIO: 'customer-portfolio-summaries' } }] });
    try {
      const bucket = await observer.getR2Bucket('NOTICEOS_PORTFOLIO', 'tower');
      assert.equal(await bucket.head(`workspaces/${workspaceId}/portfolio/summary-v1.json`), null);
    } finally { await observer.dispose(); }
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await finished;
    }
    cluster?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
