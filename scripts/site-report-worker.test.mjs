import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { openEmailCodeLogin } from '../packages/postgres/src/email-code.mjs';
import { openIdentity } from '../packages/postgres/src/identity.mjs';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { EMAIL_CODE_PATHS } from './identity-protocol.mjs';
import { LOOPBACK_HBA, findPostgres } from './postgres-dev.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { scramVerifier } from './postgres-scram.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { bundleWorkerFixture, Miniflare } from './worker-entry-test-fixture.mjs';

test('local hosted site reports use scoped, revocable grants and the existing daily revisions', { timeout: 90_000 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'noticeos-site-report-'));
  let postgres, runtime;
  try {
    const tools = findPostgres();
    postgres = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'db'), tools));
    if (!postgres) return;
    applyMigrations(postgres);
    const workspaceDatabase = postgres.applicationLogin().url();
    const password = randomBytes(32).toString('base64url');
    postgres.run("ALTER ROLE noticeos_identity LOGIN PASSWORD '" + scramVerifier(password) + "';");
    appendFileSync(path.join(postgres.root, LOOPBACK_HBA), 'host noticeos_dev noticeos_identity 127.0.0.1/32 scram-sha-256\n');
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(postgres.root, 'data')], { stdio: 'pipe' });
    const identityUrl = new URL(workspaceDatabase);
    identityUrl.username = 'noticeos_identity';
    identityUrl.password = password;
    const origin = 'http://127.0.0.1:54837';
    const shadowOrigin = 'https://fixture.example.test';
    const sessionSecret = randomBytes(48).toString('base64url');
    const [a, b] = [randomUUID(), randomUUID()];
    const [owner, viewer] = [randomUUID(), randomUUID()];
    const slug = 'shared.example';
    const different = 'other.example';
    const [ownerEmail, viewerEmail] = ['writer@example.test', 'reader@example.test'];
    postgres.run(`INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status)
      VALUES (:'a'::uuid,'one','One','active'), (:'b'::uuid,'two','Two','active');
      INSERT INTO noticeos.assets(workspace_id,asset_id,domain,display_name,status,list_position) VALUES
        (:'a'::uuid,:'slug',:'slug','One shared site','live',1), (:'b'::uuid,:'slug',:'slug','Two shared site','live',1),
        (:'a'::uuid,:'different',:'different','Other site','live',2);
      INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at)
        VALUES (:'a'::uuid,'One','one',now()), (:'b'::uuid,'Two','two',now());
      INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified)
        VALUES (:'owner'::uuid,'Writer',:'ownerEmail',true), (:'viewer'::uuid,'Viewer',:'viewerEmail',true);
      INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES
        (gen_random_uuid(),:'a'::uuid,:'owner'::uuid,'owner',now()), (gen_random_uuid(),:'b'::uuid,:'owner'::uuid,'operator',now()),
        (gen_random_uuid(),:'a'::uuid,:'viewer'::uuid,'viewer',now());`,
    { vars: { a, b, owner, viewer, ownerEmail, viewerEmail, slug, different } });
    const identity = { connectionString: identityUrl.href, trustedOrigin: origin, sessionSecret };
    async function signIn(email) {
      let otp;
      const login = openEmailCodeLogin({ ...identity, peerAddress: '127.0.0.1', async deliver(message) { otp = message.code; } });
      const request = (action, fields) => new Request(origin + EMAIL_CODE_PATHS[action], {
        method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, ...fields }),
      });
      try {
        assert.equal((await login.requestCode(request('request'))).status, 202);
        const verified = await login.verifyCode(request('verify', { otp }));
        assert.equal(verified.status, 200);
        const cookie = verified.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        const reader = await openIdentity(identity);
        try { return { cookie, [WORKSPACE_SESSION_HEADER]: (await reader.session(new Headers({ cookie }))).sessionId }; }
        finally { await reader.close(); }
      } finally { await login.close(); }
    }
    const ownerSession = await signIn(ownerEmail);
    const viewerSession = await signIn(viewerEmail);
    const [tower, ingest] = await Promise.all([
      bundleWorkerFixture(root, 'tower', path.join(REPO_ROOT, 'apps/tower/worker/index.ts')),
      bundleWorkerFixture(root, 'ingest', path.join(REPO_ROOT, 'workers/ingest/src/index.ts')),
    ]);
    const enabled = { NOTICEOS_WORKSPACE_PROFILE: 'hosted', NOTICEOS_WORKSPACE_ORIGIN: origin,
      NOTICEOS_WORKSPACE_DATABASE_URL: workspaceDatabase, NOTICEOS_IDENTITY_DATABASE_URL: identityUrl.href,
      NOTICEOS_IDENTITY_SESSION_SECRET: sessionSecret, NOTICEOS_LOCAL_SITE_REPORTS: '1' };
    let outbound = 0;
    const { NOTICEOS_LOCAL_SITE_REPORTS: _optIn, ...disabled } = enabled;
    const nonLocal = { ...enabled, NOTICEOS_WORKSPACE_ORIGIN: shadowOrigin };
    runtime = new Miniflare({ workers: [
      { ...tower, name: 'tower', bindings: enabled, serviceBindings: { INGEST: 'ingest' } },
      { ...tower, name: 'disabled', bindings: disabled, serviceBindings: { INGEST: 'ingest' } },
      { ...tower, name: 'non-local', bindings: nonLocal, serviceBindings: { INGEST: 'ingest' } },
      { ...ingest, name: 'ingest', bindings: { ...enabled, CREDENTIALS_KEY: randomBytes(32).toString('base64') },
        async outboundService() { outbound++; return new Response(null, { status: 403 }); } },
    ] });
    const worker = await runtime.getWorker('tower');
    const manage = (method, workspace, asset = slug, session = ownerSession, source = origin) =>
      worker.fetch(origin + '/api/assets/' + asset + '/report-token', { method, headers: { ...session, origin: source,
        [WORKSPACE_SELECTION_HEADER]: workspace } });
    const issue = async (workspace, asset) => {
      const response = await manage('POST', workspace, asset);
      assert.equal(response.status, 201, await response.clone().text());
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assert.equal(typeof body.token, 'string');
      return body.token;
    };
    const envelope = (count, asset = slug) => ({ asset, generatedAt: '2026-10-10T02:00:00Z',
      capabilities: ['signups'], metrics: { signups: { last24h: count, avg7d: 3, total: count + 100 } },
      flags: [{ severity: 'info', kind: 'milestone', metric: 'signups', msg: 'A site milestone' }] });
    const obtain = (instance, address, token, body, headers = {}) => instance.fetch(address + '/api/pulse', { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const report = (token, body, headers) => obtain(worker, origin, token, body, headers);
    const day = async (token, payload) => {
      const response = await report(token, payload);
      assert.equal(response.status, 201, await response.clone().text());
      return (await response.json()).pulseId;
    };

    assert.equal((await manage('POST', a, slug, viewerSession)).status, 403);
    assert.equal((await manage('GET', b, slug, viewerSession)).status, 403);
    assert.equal((await manage('POST', a, slug, ownerSession, shadowOrigin)).status, 403);
    assert.equal((await manage('POST', a, 'unknown.example')).status, 404);
    assert.deepEqual(await (await manage('GET', a, slug, viewerSession)).json(), { issued: false, mayIssue: false, mayRevoke: false });
    const first = await issue(a), other = await issue(b);
    const onOtherAsset = await issue(a, different);
    assert.notEqual(first, other);
    assert.equal((await report(first, envelope(1, different))).status, 401);
    assert.equal((await report(first.replace(a, b), envelope(1))).status, 401);
    assert.equal((await report(first, envelope(1), { [WORKSPACE_SELECTION_HEADER]: b })).status, 401);
    assert.equal((await report(ownerSession.cookie, envelope(1))).status, 401);
    const inactive = await runtime.getWorker('disabled');
    assert.equal((await obtain(inactive, origin, first, envelope(1))).status, 404);
    assert.equal((await obtain(await runtime.getWorker('non-local'), shadowOrigin, first, envelope(1))).status, 404);
    assert.equal((await report(first, { asset: slug, metrics: 3 })).status, 422);
    assert.equal((await report(first.replace(a, b), { asset: slug, metrics: 3 })).status, 401);

    const firstDay = await day(first, envelope(1));
    const otherDay = await day(other, envelope(11));
    assert.equal(await day(first, envelope(1)), firstDay);
    assert.equal(await day(other, envelope(11)), otherDay);
    const rotated = await issue(a);
    assert.notEqual(rotated, first);
    assert.equal((await report(first, envelope(99))).status, 401);
    assert.equal(await day(rotated, envelope(7)), firstDay);
    assert.equal(await day(other, envelope(17)), otherDay);
    assert.equal((await manage('DELETE', a)).status, 204);
    assert.equal((await report(rotated, envelope(99))).status, 401);
    assert.equal((await manage('GET', a)).status, 200);
    assert.equal((await (await manage('GET', a)).json()).issued, false);
    assert.ok(await day(onOtherAsset, envelope(25, different)));
    assert.equal((await (await manage('GET', b)).json()).issued, true);
    postgres.run("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=:'id'::uuid;", { vars: { id: b } });
    assert.equal((await report(other, envelope(99))).status, 401);
    const stored = postgres.sql(`SELECT workspace_id, array_agg((envelope->'metrics'->'signups'->>'last24h')::int ORDER BY revision)::text AS counts,
      max(revision)::text AS revisions FROM noticeos.pulses WHERE asset_id='shared.example' GROUP BY workspace_id`);
    assert.deepEqual(new Map(stored.map(row => [row.workspace_id, [row.counts, row.revisions]])),
      new Map([[a, ['{1,1,7}', '3']], [b, ['{11,11,17}', '3']]]));
    const current = postgres.sql("SELECT workspace_id, envelope->'metrics'->'signups'->>'last24h' AS latest FROM noticeos.current_pulses WHERE asset_id='shared.example'");
    assert.deepEqual(new Map(current.map(row => [row.workspace_id, row.latest])), new Map([[a, '7'], [b, '17']]));
    assert.deepEqual(postgres.sql(`SELECT workspace_id, count(*)::int AS n FROM noticeos.current_flags
      WHERE asset_id='shared.example' AND rule_id='asset-declared' GROUP BY workspace_id`).map(row => row.n), ['1', '1']);
    const vault = postgres.sql(`SELECT provider, encode(ciphertext, 'hex') AS ciphertext, field_names::text
      FROM noticeos.connection_secrets JOIN noticeos.integration_connections USING (workspace_id,connection_id)`);
    assert.equal(vault.length, 2);
    const hex = Buffer.from(other).toString('hex');
    const secretHash = createHash('sha256').update(other).digest('hex');
    assert.ok(vault.every(row => !row.ciphertext.includes(hex) && !row.ciphertext.includes(secretHash)));
    assert.equal(outbound, 0);
  } finally {
    try { await runtime?.dispose(); }
    finally { postgres?.close(); rmSync(root, { recursive: true, force: true }); }
  }
});
