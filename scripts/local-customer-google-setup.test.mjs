import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { composeCustomerPlan } from '../deploy/compose/customer-entry.mjs';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { ACCEPT_INVITATION_PATH, EMAIL_CODE_PATHS, EMAIL_ENROLLMENT_HEADERS } from './identity-protocol.mjs';
import { startPreparedCustomer } from './local-customer-attach.mjs';
import { localCustomerOutbound } from './local-customer-egress.mjs';
import { openCustomerTarget } from './local-customer-operating.mjs';
import { buildCustomer, startLocalCustomer } from './local-customer.mjs';
import { startPlan } from './start.mjs';
import { openDevelopmentStart } from './start-development.mjs';
import { testFixtureRoot } from './test-fixture-root.mjs';
import { availableCustomerPort } from './test/customer-ports.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';

const tokenUrl = 'https://oauth2.googleapis.com/token';
const userInfo = 'https://www.googleapis.com/oauth2/v3/userinfo';
const authCode = new URLSearchParams({ grant_type: 'authorization_code', code: 'synthetic' });

test('Google setup admits read-only setup requests, and refuses other destinations, grants, and redirects', async () => {
  const called = [];
  const transport = async (url, init) => {
    called.push([url, init.method, init.redirect]);
    return new Response(null, { status: 302, headers: { location: 'https://unexpected.example.test' } });
  };
  const authenticate = () => new Request(tokenUrl, { method: 'POST', body: authCode });
  const make = (url, method = 'GET') => new Request(url, { method, headers: { authorization: 'Bearer fixture' } });
  assert.equal((await localCustomerOutbound({ transport })(authenticate())).status, 403);
  const setup = localCustomerOutbound({ googleSetup: true, transport });
  for (const req of [
    make(tokenUrl), make('https://accounts.google.com/o/oauth2/v2/auth'),
    make('https://oauth2.googleapis.com.example.test/token', 'POST'),
    make('https://analyticsdata.googleapis.com/v1beta/properties/1:runReport', 'POST'),
    make('https://adsense.googleapis.com/v2/accounts/pub-1/reports:generate?pageSize=100'),
    make('https://adsense.googleapis.com/v2/accounts?pageSize=100&arbitrary=true'),
    new Request(tokenUrl, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials' }) }),
    new Request(userInfo),
  ]) assert.equal((await setup(req)).status, 403);
  assert.deepEqual(called, []);
  for (const req of [authenticate(), make(userInfo), make('https://www.googleapis.com/webmasters/v3/sites'),
    make('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200'),
    make('https://adsense.googleapis.com/v2/accounts/pub-1/sites?pageSize=100&pageToken=next')]) {
    assert.equal((await setup(req)).status, 502);
  }
  assert.equal(called.length, 5);
  assert.ok(called.every(([, , redirect]) => redirect === 'manual'));
});

// Use the native gateway with the real Host header while every connection goes
// to the fixture's loopback socket, including the simulated home-network URL.
function browser(origin, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const json = body === undefined ? undefined : JSON.stringify(body);
    const send = request({ hostname: '127.0.0.1', port: url.port, method, path: route,
      headers: { host: url.host, ...(method === 'GET' ? {} : { origin }),
        ...(json === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) }),
        ...headers }, signal: AbortSignal.timeout(30000) },
    reply => {
      const parts = [];
      reply.on('data', chunk => parts.push(chunk));
      reply.on('error', reject);
      reply.on('end', () => resolve({
        status: reply.statusCode, headers: reply.headers, json: () => JSON.parse(Buffer.concat(parts).toString('utf8')),
      }));
    });
    send.on('error', reject);
    send.end(json);
  });
}

async function signIn(app, workspace, invitationId) {
  const http = (route, options) => browser(app.publicOrigin, route, options);
  const enrollment = invitationId ? { [EMAIL_ENROLLMENT_HEADERS.kind]: 'invitation', [EMAIL_ENROLLMENT_HEADERS.id]: invitationId } : {};
  const before = new Set(readdirSync(app.outbox));
  const email = workspace.email;
  assert.equal((await http(EMAIL_CODE_PATHS.request, { method: 'POST', body: { email }, headers: enrollment })).status, 202);
  const message = readdirSync(app.outbox).filter(file => !before.has(file))
    .map(file => JSON.parse(readFileSync(path.join(app.outbox, file), 'utf8')))
    .find(mail => mail.to === email && /\b\d{6}\.$/u.test(mail.text));
  assert.ok(message);
  const otp = message.text.match(/\b(\d{6})\.$/u)[1];
  const verified = await http(EMAIL_CODE_PATHS.verify, { method: 'POST', body: { email, otp }, headers: enrollment });
  assert.equal(verified.status, 200);
  const cookie = verified.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  const session = (await http('/api/session', { headers: { cookie } })).json();
  const headers = { cookie, [WORKSPACE_SESSION_HEADER]: session.session.sessionId };
  if (invitationId) {
    assert.equal((await http(ACCEPT_INVITATION_PATH, { method: 'POST', body: { invitationId }, headers })).status, 200);
  }
  return { ...headers, [WORKSPACE_SELECTION_HEADER]: workspace.workspaceId };
}

test('the local customer setup window connects and replaces both accounts on the same store, then restores the LAN Tower', { timeout: 180000 }, async t => {
  const root = testFixtureRoot('n-customer-google-setup-');
  const port = await availableCustomerPort();
  const fixture = startPlan({ dir: path.join(root, 'fixture'), port });
  const loopbackOrigin = `http://127.0.0.1:${port}`;
  const lanOrigin = `http://fixture-tower.local:${port}`;
  const lan = { NOTICEOS_HOST_TOWER_ADDRESS: '0.0.0.0', NOTICEOS_HOST_TOWER_PORT: String(port), TOWER_ALLOWED_HOSTS: 'fixture-tower.local' };
  const daily = { ...composeCustomerPlan(lan, lanOrigin), root: fixture.root };
  const loopback = { ...composeCustomerPlan({ ...lan, NOTICEOS_HOST_TOWER_ADDRESS: '127.0.0.1',
    NOTICEOS_CUSTOMER_GOOGLE_SETUP: '1' }, lanOrigin), root: fixture.root };
  const artifactRoot = path.join(root, 'artifact');
  const customer = path.join(root, 'attached');
  const receipt = path.join(root, 'target.json');
  let db, app;
  try {
    db = await skipWithoutPostgres(t, () => openDevelopmentStart(fixture, { profile: 'hosted' }));
    if (!db) return;
    app = await startLocalCustomer(fixture, db);
    const people = app.workspaces;
    const [east, west] = people;
    const accept = person => signIn(app, person, new URLSearchParams(new URL(person.url).hash.slice(1)).get('invitation'));
    const initialOwner = await accept(east);
    await accept(west);
    const { identitySecret, credentialsKey } = JSON.parse(readFileSync(path.join(db.customer, 'settings.json'), 'utf8'));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const account = Buffer.from(JSON.stringify({ client_email: 'collector@example.test',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) })).toString('base64');
    const existing = JSON.stringify({ fixture: { service_account_b64: account, properties: {} } });
    const storeAccount = await browser(app.publicOrigin, '/api/integrations/google/credential', {
      method: 'PUT', headers: initialOwner, body: { fields: { GOOGLE_SIGNAL_ACCOUNTS: existing } },
    });
    assert.equal(storeAccount.status, 204);
    await app.close(); app = undefined;
    await buildCustomer(root, artifactRoot);
    const exchanges = [];
    const transport = async (url, init) => {
      assert.equal(init.redirect, 'manual');
      if (url === userInfo) return Response.json({ email: 'collector@example.test' });
      assert.equal(url, tokenUrl);
      assert.equal(init.method, 'POST');
      const form = new URLSearchParams(Buffer.from(init.body).toString('utf8'));
      const redirect = new URL(form.get('redirect_uri'));
      const provider = redirect.pathname.split('/')[3];
      const code = form.get('code');
      assert.equal(redirect.origin, loopbackOrigin);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), provider + '-fixture.apps.googleusercontent.com');
      exchanges.push([provider, code]);
      if (code === 'refused') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const scopes = provider === 'adsense' ? ['adsense.readonly'] : ['analytics.readonly', 'webmasters.readonly'];
      return Response.json({ refresh_token: 'synthetic-' + code, access_token: 'synthetic-access',
        scope: scopes.map(scope => `https://www.googleapis.com/auth/${scope}`).join(' ') });
    };
    const operating = { target: 'owned-fixture', address: db.address, identityAddress: db.identityDatabase,
      grantAddress: db.grantConnectionString, identitySecret, credentialsKey,
      workspaces: people.map(({ workspaceId, serviceId }) => ({ workspaceId, serviceId })),
      googleDaily: false, collectorProviders: [], sitePulls: [], siteChecks: [], revenueNotices: [], taskFollowups: [],
      ntasksOrigin: null, mailRecipients: people.map(({ email }) => email) };
    const open = async plan => {
      const host = await openCustomerTarget(plan, operating, customer, receipt);
      return startPreparedCustomer(plan, host, {
        deployment: { artifactRoot, bridgePeer: '127.0.0.1', listenPort: port }, googleSetupTransport: transport,
      });
    };
    const schedulerCount = () => Number(db.cluster.sql("SELECT count(*) AS count FROM pg_stat_activity WHERE application_name='noticeos-local-customer-scheduler'")[0].count);
    const start = (provider, owner) => browser(app.publicOrigin, `/api/integrations/${provider}/oauth/start`, { method: 'POST', headers: owner });
    const callback = async (provider, state, code, owner) => {
      const response = await browser(app.publicOrigin, `/api/integrations/${provider}/oauth/callback?state=${state}&code=${code}`,
        { headers: { cookie: owner.cookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
      assert.equal(response.status, 302);
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
      const target = new URL(response.headers.location);
      assert.equal(target.origin, app.publicOrigin);
      assert.equal(target.searchParams.get('connect'), provider);
      assert.equal(target.searchParams.has('code'), false);
      return target.searchParams.get('google');
    };
    const credential = provider => db.cluster.script(`SELECT encode(s.ciphertext,'hex') AS ciphertext, encode(s.iv,'hex') AS iv
      FROM noticeos.integration_connections c JOIN noticeos.connection_secrets s USING(workspace_id,connection_id)
      WHERE c.workspace_id=:'workspace'::uuid AND c.provider=:'provider' ORDER BY s.secret_version DESC LIMIT 1`,
    { vars: { workspace: east.workspaceId, provider } })[0];
    const key = await crypto.subtle.importKey('raw', Buffer.from(credentialsKey, 'base64'), 'AES-GCM', false, ['decrypt']);
    const fields = async provider => {
      const { iv, ciphertext } = credential(provider);
      const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'hex') }, key, Buffer.from(ciphertext, 'hex'));
      return JSON.parse(Buffer.from(clear).toString('utf8'));
    };
    const serviceAccount = (await fields('google')).GOOGLE_SIGNAL_ACCOUNTS;
    app = await open(daily);
    assert.equal(schedulerCount(), 1);
    const lanOwner = await signIn(app, east);
    assert.equal((await browser(lanOrigin, '/api/session', { headers: lanOwner })).json().googleSetupRequired, true);
    assert.equal((await start('google', lanOwner)).json().error, 'redirect_unusable');
    assert.deepEqual(exchanges, []);
    const originalReceipt = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.equal(originalReceipt.publicOrigin, lanOrigin);
    assert.equal((await browser(loopbackOrigin, '/api/session')).status, 400);
    await app.close(); app = undefined;
    assert.equal(schedulerCount(), 0);

    app = await open(loopback);
    assert.equal(schedulerCount(), 1);
    assert.equal((await browser(lanOrigin, '/api/session', { headers: lanOwner })).status, 400);
    assert.equal((await browser(loopbackOrigin, '/api/session')).json().session, null);
    db.cluster.run("DELETE FROM noticeos_identity.auth_rate_limit WHERE key LIKE '%|/email-otp/send-verification-otp' OR key LIKE '%|/sign-in/email-otp'");
    const setupOwner = await signIn(app, east);
    const other = await signIn(app, west);
    assert.notEqual(setupOwner[WORKSPACE_SESSION_HEADER], lanOwner[WORKSPACE_SESSION_HEADER]);
    const setupSession = (await browser(loopbackOrigin, '/api/session', { headers: setupOwner })).json();
    assert.equal(setupSession.googleSetupRequired, undefined);
    assert.equal(setupSession.selectedWorkspace.workspaceId, east.workspaceId);
    for (const [provider, prefix] of [['google', 'GOOGLE'], ['adsense', 'ADSENSE']]) {
      const save = await browser(loopbackOrigin, `/api/integrations/${provider}-oauth-app/credential`, { method: 'PUT', headers: setupOwner, body: { fields: {
        [prefix + '_OAUTH_CLIENT_ID']: provider + '-fixture.apps.googleusercontent.com',
        [prefix + '_OAUTH_CLIENT_SECRET']: 'fixture-client-secret',
      } } });
      assert.equal(save.status, 204);
      assert.equal((await start(provider, { ...other, [WORKSPACE_SELECTION_HEADER]: east.workspaceId })).status, 403);
      const issue = async () => {
        const result = await start(provider, setupOwner);
        assert.equal(result.status, 200);
        const { authorizeUrl } = result.json();
        const target = new URL(authorizeUrl);
        assert.equal(target.origin, 'https://accounts.google.com');
        assert.equal(target.searchParams.get('redirect_uri'), loopbackOrigin + `/api/integrations/${provider}/oauth/callback`);
        return target.searchParams.get('state');
      };
      const initial = await issue();
      assert.equal(await callback(provider, initial, 'wrong-tenant', other), 'state_invalid');
      assert.equal(await callback(provider, initial, 'first', setupOwner), 'connected');
      const before = credential(provider);
      assert.ok(before);
      assert.notEqual(await callback(provider, await issue(), 'refused', setupOwner), 'connected');
      assert.deepEqual(credential(provider), before);
      assert.equal(await callback(provider, await issue(), 'replacement', setupOwner), 'connected');
      assert.notDeepEqual(credential(provider), before);
    }
    assert.ok((await fields('google')).GOOGLE_SIGNAL_ACCOUNTS === serviceAccount);
    assert.ok((await fields('google')).GOOGLE_OAUTH_REFRESH_TOKEN === 'synthetic-replacement');
    assert.ok((await fields('adsense')).ADSENSE_REFRESH_TOKEN === 'synthetic-replacement');
    assert.deepEqual(db.cluster.script("SELECT 1 FROM noticeos.integration_connections WHERE workspace_id=:'workspace'::uuid AND provider IN ('google','adsense')",
      { vars: { workspace: west.workspaceId } }), []);
    assert.deepEqual(exchanges, [['google','first'], ['google','refused'], ['google','replacement'],
      ['adsense','first'], ['adsense','refused'], ['adsense','replacement']]);
    const saved = ['google', 'adsense'].map(credential);
    await app.close(); app = undefined;

    app = await open(daily);
    assert.equal(schedulerCount(), 1);
    assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), originalReceipt);
    const restored = (await browser(lanOrigin, '/api/session', { headers: lanOwner })).json();
    assert.equal(restored.selectedWorkspace.workspaceId, east.workspaceId);
    assert.equal(restored.googleSetupRequired, true);
    assert.equal((await browser(loopbackOrigin, '/api/session', { headers: setupOwner })).status, 400);
    assert.deepEqual(['google', 'adsense'].map(credential), saved);
    assert.equal(exchanges.length, 6);
  } finally {
    try { await app?.close(); } finally { db?.close(); }
    rmSync(root, { recursive: true, force: true });
  }
});
