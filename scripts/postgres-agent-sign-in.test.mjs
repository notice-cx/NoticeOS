import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AGENT_NAMES, IDENTITY_NAMES, agentPlugins } from '../packages/postgres/src/identity.mjs';
import { openAgentSignIn } from '../packages/postgres/src/agent-sign-in.mjs';
import { openIdentity } from '../packages/postgres/src/identity.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';
import { createHostedTaskOperations } from './hosted-task-operations.mjs';
import { createHostedMcp, MCP_PATH } from './hosted-mcp.mjs';
import { fakeTaskExecutor, memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';
import { AGENT_ACCESS_PATHS, AUTHORIZATION_SERVER_METADATA_PATH, PROTECTED_RESOURCE_METADATA_PATH } from './agent-access.mjs';
import { WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';

// Agent sign-in (epic ro-cvl9; migration 0014, packages/postgres/src/
// agent-sign-in.mts): the maintained OAuth provider behind fixed routes, a
// person approving an agent once, and one token that reaches each of the
// person's workspaces as far as the person's role there allows.

const requireIdentity = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = requireIdentity('pg');
const { betterAuth } = await import(requireIdentity.resolve('better-auth/minimal'));
const { getMigrations } = await import(requireIdentity.resolve('better-auth/db/migration'));
const { organization, emailOTP } = await import(requireIdentity.resolve('better-auth/plugins'));
const { kyselyAdapter } = await import(requireIdentity.resolve('@better-auth/kysely-adapter'));
const { Kysely, PostgresDialect } = await import(requireIdentity.resolve('kysely'));

const origin = 'https://tower.example.test';
const redirect = 'http://127.0.0.1:33418/callback';
const browser = { origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const base64url = buffer => buffer.toString('base64url');
const claims = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

test('an agent registers, its person approves it once, and its token reaches each workspace as far as the role allows', { timeout: 120_000 }, async t => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'n-agent-sign-in-'));
  let owner, admin, enginePool, signIn, identity, primaryError;
  try {
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return;
    admin = new Pool({ host: owner.socketDir, port: owner.loopbackPort, database: 'noticeos_dev', user: 'postgres', max: 1 });
    // 0014 is exactly what the maintained generator builds for these plugins.
    const before = path.join(root, 'before'); mkdirSync(before);
    for (const name of readdirSync(path.join(REPO_ROOT, 'db/postgres/migrations')).filter(name => !name.startsWith('0014_'))) {
      copyFileSync(path.join(REPO_ROOT, 'db/postgres/migrations', name), path.join(before, name));
    }
    applyMigrations(owner, { dir: before });
    const generated = await (await getMigrations({
      database: { dialect: new PostgresDialect({ pool: admin }), type: 'postgres', schemaName: 'noticeos_identity', transaction: true },
      baseURL: origin, advanced: { database: { generateId: 'uuid' } }, logger: { disabled: true },
      user: IDENTITY_NAMES.user, account: IDENTITY_NAMES.account, verification: IDENTITY_NAMES.verification, session: IDENTITY_NAMES.session,
      rateLimit: { enabled: true, storage: 'database', modelName: 'auth_rate_limit', fields: { key: 'key', count: 'count', lastRequest: 'last_request' } },
      plugins: [organization({ schema: IDENTITY_NAMES.organization }), emailOTP({ sendVerificationOTP: async () => {} }), ...agentPlugins(origin)],
    })).compileMigrations();
    const shapes = sql => sql.split('\n').filter(line => /^create (unique )?(table|index)/u.test(line));
    assert.deepEqual(shapes(readFileSync(path.join(REPO_ROOT, 'db/postgres/migrations/0014_agent_sign_in.sql'), 'utf8')), shapes(generated));
    assert.ok(Object.values(AGENT_NAMES.oauth).every(model => /^auth_[a-z_]+$/u.test(model.modelName)));
    assert.deepEqual(applyMigrations(owner).applied, ['0014_agent_sign_in']);

    const password = randomBytes(32).toString('base64url');
    await admin.query('ALTER ROLE noticeos_identity LOGIN');
    await admin.query(`ALTER ROLE noticeos_identity PASSWORD '${password}'`);
    appendFileSync(path.join(owner.root, LOOPBACK_HBA), 'host all noticeos_identity 127.0.0.1/32 scram-sha-256\n');
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
    const url = new URL(owner.applicationLogin().url()); url.username = 'noticeos_identity'; url.password = password;
    const sessionSecret = randomBytes(48).toString('base64url');
    const options = { connectionString: url.href, trustedOrigin: origin, sessionSecret };

    // A person with a session, operator of one workspace and viewer of another.
    enginePool = new Pool({ connectionString: url.href, max: 1 });
    const fixture = betterAuth({
      database: kyselyAdapter(new Kysely({ dialect: new PostgresDialect({ pool: enginePool }) }).withSchema('noticeos_identity'), { type: 'postgres', transaction: true }),
      baseURL: origin, trustedOrigins: [origin], secret: sessionSecret, telemetry: { enabled: false }, logger: { disabled: true },
      advanced: { database: { generateId: 'uuid' } }, emailAndPassword: { enabled: true },
      user: IDENTITY_NAMES.user, account: IDENTITY_NAMES.account, verification: IDENTITY_NAMES.verification,
      session: { ...IDENTITY_NAMES.session, cookieCache: { enabled: false } },
      plugins: [organization({ allowUserToCreateOrganization: false, schema: IDENTITY_NAMES.organization })],
    });
    const signup = await fixture.handler(new Request(`${origin}/api/auth/sign-up/email`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Agent owner', email: 'person@example.test', password: randomBytes(24).toString('base64url') }) }));
    assert.equal(signup.status, 200);
    const person = (await signup.json()).user;
    const cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const [{ id: sessionId }] = (await enginePool.query('SELECT id FROM noticeos_identity.auth_session WHERE user_id=$1', [person.id])).rows;
    const [operated, viewed] = [randomUUID(), randomUUID()];
    for (const [id, slug, role] of [[operated, 'operated', 'operator'], [viewed, 'viewed', 'viewer']]) {
      await admin.query("INSERT INTO noticeos.workspaces(workspace_id,slug,display_name,status) VALUES($1,$2,$2,'active')", [id, slug]);
      await enginePool.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [id, slug]);
      await enginePool.query('INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,$4,now())', [randomUUID(), id, person.id, role]);
    }

    signIn = openAgentSignIn({ ...options, peerAddress: '203.0.113.7' });
    const call = (pathname, init = {}) => signIn.handle(new Request(origin + pathname, init));

    // Discovery: the MCP endpoint names this server; this server describes itself.
    const resource = await (await call(PROTECTED_RESOURCE_METADATA_PATH)).json();
    assert.deepEqual(resource, { resource: `${origin}/api/mcp`, authorization_servers: [`${origin}/api/auth`],
      scopes_supported: ['tasks:read', 'tasks:write', 'evidence:read'], bearer_methods_supported: ['header'], resource_name: 'NoticeOS' });
    const server = await (await call(AUTHORIZATION_SERVER_METADATA_PATH)).json();
    assert.equal(server.issuer, `${origin}/api/auth`);
    assert.equal(server.authorization_endpoint, `${origin}/api/auth/oauth2/authorize`);
    assert.equal(server.token_endpoint, `${origin}/api/auth/oauth2/token`);
    assert.equal(server.registration_endpoint, `${origin}/api/auth/oauth2/register`);
    assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
    assert.equal(server.authorization_response_iss_parameter_supported, true);

    // Dynamic registration of a public client with a loopback redirect.
    const register = async name => {
      const registered = await call('/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
      const client = await registered.json();
      assert.equal(registered.status, 201, JSON.stringify(client));
      assert.equal(client.client_secret, undefined);
      return client;
    };
    const client = await register('Example agent');
    const mcpUri = `${origin}/api/mcp`;
    const authorize = async (forClient = client) => {
      const verifier = base64url(randomBytes(32));
      const params = new URLSearchParams({ response_type: 'code', client_id: forClient.client_id, redirect_uri: redirect,
        scope: 'tasks:read tasks:write evidence:read offline_access', state: base64url(randomBytes(12)), resource: mcpUri,
        code_challenge: base64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
      const response = await call(`/api/auth/oauth2/authorize?${params}`, { headers: { cookie } });
      assert.equal(response.status, 302, await response.clone().text());
      return { verifier, location: new URL(response.headers.get('location'), origin), state: params.get('state') };
    };
    const page = (pathname, body, headers = {}) => call(pathname, { method: 'POST',
      headers: { ...browser, 'content-type': 'application/json', cookie, ...headers }, body: JSON.stringify(body) });

    // The person signed out is sent to the same page to sign in first.
    const anonymous = await call(`/api/auth/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id,
      redirect_uri: redirect, scope: 'tasks:read', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })}`);
    assert.equal(new URL(anonymous.headers.get('location'), origin).pathname, '/agent-access');

    // Signed in, the person is asked once: no workspace to choose.
    const first = await authorize();
    assert.equal(first.location.pathname, '/agent-access', 'a new agent is asked about, never skipped');
    const query = first.location.search.slice(1);
    const described = await (await page(AGENT_ACCESS_PATHS.request, { oauth_query: query })).json();
    assert.deepEqual(described, { client: { name: 'Example agent', uri: null }, scopes: ['tasks:read', 'tasks:write', 'evidence:read'], signedIn: true });
    assert.equal((await page(AGENT_ACCESS_PATHS.request, { oauth_query: query.replace(/sig=[^&]+/u, 'sig=forged') })).status, 403);
    // Approval needs the tab's own session.
    const approve = (signed, accept, headers = { [WORKSPACE_SESSION_HEADER]: sessionId }) =>
      page(AGENT_ACCESS_PATHS.approve, { oauth_query: signed, accept }, headers);
    assert.equal((await approve(query, true, { [WORKSPACE_SESSION_HEADER]: randomUUID() })).status, 403);
    assert.equal((await page(AGENT_ACCESS_PATHS.approve, { oauth_query: query, accept: true, workspaceId: operated },
      { [WORKSPACE_SESSION_HEADER]: sessionId })).status, 403, 'an approval names no workspace');
    const next = new URL((await (await approve(query, true)).json()).url);
    assert.equal(next.origin + next.pathname, redirect);
    assert.equal(next.searchParams.get('state'), first.state);
    assert.equal(next.searchParams.get('iss'), `${origin}/api/auth`);

    // The code becomes a token for the one MCP endpoint, naming no workspace.
    const exchange = async (code, verifier, forClient = client) => call('/api/auth/oauth2/token', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: forClient.client_id,
        code_verifier: verifier, resource: mcpUri }) });
    const tokens = await (await exchange(next.searchParams.get('code'), first.verifier)).json();
    assert.equal(tokens.token_type.toLowerCase(), 'bearer', JSON.stringify(tokens));
    assert.ok(tokens.refresh_token);
    const access = claims(tokens.access_token);
    assert.equal(access.iss, `${origin}/api/auth`);
    assert.deepEqual([access.aud].flat(), [mcpUri]);
    assert.equal(access.sub, person.id);
    assert.equal(Object.keys(access).some(name => /workspace/u.test(name)), false);
    assert.deepEqual(access.scope.split(' ').sort(), ['evidence:read', 'offline_access', 'tasks:read', 'tasks:write']);
    assert.ok(access.exp - access.iat <= 3600);

    // A refresh keeps the scopes and the endpoint; a replayed code is refused
    // and revokes what it issued.
    const refresh = (refreshToken, forClient = client) => call('/api/auth/oauth2/token', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: forClient.client_id, resource: mcpUri }) });
    const refreshed = await (await refresh(tokens.refresh_token)).json();
    assert.ok(refreshed.access_token, JSON.stringify(refreshed));
    assert.deepEqual([claims(refreshed.access_token).aud].flat(), [mcpUri]);
    assert.equal((await exchange(next.searchParams.get('code'), first.verifier)).status, 400, 'a code is used once');
    assert.equal((await refresh(refreshed.refresh_token)).status, 400, 'a replayed code revokes its refresh tokens');

    // An agent already allowed connects again without asking.
    const again = await authorize();
    assert.equal(again.location.origin + again.location.pathname, redirect, 'a consented agent is not asked twice');
    const live = await (await exchange(again.location.searchParams.get('code'), again.verifier)).json();
    const operator = live.access_token;

    // Denying sends the agent access_denied and records nothing.
    const other = await register('Other agent');
    const otherQuery = (await authorize(other)).location.search.slice(1);
    const consents = (await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_oauth_consent')).rows[0].n;
    const denied = new URL((await (await approve(otherQuery, false)).json()).url);
    assert.equal(denied.searchParams.get('error'), 'access_denied');
    assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_oauth_consent')).rows[0].n, consents);

    // Only the fixed routes answer; the library's other endpoints stay private.
    assert.equal(await call('/api/auth/oauth2/consent', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }), null);
    assert.equal((await call('/api/auth/oauth2/token')).status, 405);

    // The resource side: a token is checked against this deployment's key and
    // the MCP endpoint, a live consent and an enabled client; each workspace a
    // call names against the person's membership there.
    identity = await openIdentity(options);
    const bearer = token => new Request(origin + MCP_PATH, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    const verified = await identity.agentToken(bearer(operator));
    assert.deepEqual({ ...verified, scopes: [...verified.scopes].sort() }, { principalId: person.id, clientId: client.client_id,
      expiresAt: verified.expiresAt, scopes: ['evidence:read', 'tasks:read', 'tasks:write'] });
    assert.deepEqual([(await identity.agentAuthority(bearer(operator), operated)).role, (await identity.agentAuthority(bearer(operator), viewed)).role],
      ['operator', 'viewer']);
    assert.equal(await identity.agentAuthority(bearer(operator), randomUUID()), null, 'a workspace the person is not in');
    assert.deepEqual((await identity.agentWorkspaces(bearer(operator))).map(row => [row.workspaceId, row.role]).sort(),
      [[operated, 'operator'], [viewed, 'viewer']].sort());
    assert.equal(await identity.agentToken(bearer(`${operator.slice(0, -4)}AAAA`)), null, 'a forged signature is refused');
    assert.equal(await identity.agentToken(new Request(origin + MCP_PATH)), null);
    const lapse = async (check, statements, restore) => {
      for (const [sql, values] of statements) await admin.query(sql, values);
      assert.equal(await check(), null, statements[0][0]);
      for (const [sql, values] of restore) await admin.query(sql, values);
      assert.ok(await check(), restore[0][0]);
    };
    await lapse(() => identity.agentToken(bearer(operator)), [['UPDATE noticeos_identity.auth_oauth_client SET disabled=true WHERE client_id=$1', [client.client_id]]],
      [['UPDATE noticeos_identity.auth_oauth_client SET disabled=NULL WHERE client_id=$1', [client.client_id]]]);
    await lapse(() => identity.agentToken(bearer(operator)),
      [['CREATE TEMP TABLE kept_consent AS SELECT * FROM noticeos_identity.auth_oauth_consent WHERE client_id=$1', [client.client_id]],
        ['DELETE FROM noticeos_identity.auth_oauth_consent WHERE client_id=$1', [client.client_id]]],
      [['INSERT INTO noticeos_identity.auth_oauth_consent SELECT * FROM kept_consent', []], ['DROP TABLE kept_consent', []]]);
    await lapse(() => identity.agentAuthority(bearer(operator), operated),
      [['DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [operated, person.id]]],
      [["INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES(gen_random_uuid(),$1,$2,'operator',now())", [operated, person.id]]]);

    // Admission: each call names its workspace, the person's role there bounds
    // the token's scopes, and no scope reaches a decision.
    const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin,
      membership: async () => assert.fail('an agent request never reads a browser session'),
      agent: (request, workspace) => identity.agentAuthority(request, workspace) });
    const admitted = (action, requestedWorkspaceId) => admission.withAdmission(action,
      { correlationId: 'agent-test', ...(requestedWorkspaceId ? { requestedWorkspaceId } : {}) }, bearer(operator), async context => context);
    const context = await admitted('tasks.write', operated);
    assert.deepEqual([context.principalKind, context.principalId, context.workspaceId, context.agentClientId, context.sessionId],
      ['agent', person.id, operated, client.client_id, undefined]);
    assert.deepEqual([...context.allowedActions].sort(), ['evidence.read', 'tasks.read', 'tasks.write']);
    await assert.rejects(admitted('tasks.decide', operated));
    await assert.rejects(admitted('tasks.read'), 'an agent call always names its workspace');
    await assert.rejects(admitted('tasks.read', randomUUID()));
    assert.equal((await admitted('tasks.read', viewed)).workspaceId, viewed);
    await assert.rejects(admitted('tasks.write', viewed), 'a viewer workspace only reads');
    await enginePool.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1", [operated]);
    await assert.rejects(admitted('tasks.write', operated), 'a role change narrows a live token at once');
    await enginePool.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE organization_id=$1", [operated]);
    await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [operated]);
    await assert.rejects(admitted('tasks.read', operated), 'a suspended workspace admits no agent');
    await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [operated]);

    // The one MCP endpoint over these facts: a 401 naming where to sign in,
    // the person's workspaces, and each call in the workspace it names.
    const project = randomUUID();
    const fake = fakeTaskExecutor({ principal: () => person.id, clock: Date.now });
    const forwarded = [];
    const mcp = createHostedMcp({ profile: 'hosted', trustedOrigin: origin,
      agents: { verify: request => identity.agentToken(request), workspaces: request => identity.agentWorkspaces(request) },
      readModels: async request => { forwarded.push(request); return Response.json({ jsonrpc: '2.0', id: 1, result: {
        content: [{ type: 'text', text: '{}' }], structuredContent: { properties: [] } } }); },
      operations: createHostedTaskOperations({ admission, executor: fake.executor, receipts: memoryReceipts(Date.now),
        directory: { catalog: async () => Object.freeze([{ projectId: project, logicalKey: 'example', displayName: 'Example', prefix: 'tt' }]) } }) });
    const rpc = (headers, name, args = {}) => mcp(new Request(origin + MCP_PATH, { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
    const missing = await rpc({}, 'list_workspaces');
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'),
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp", scope="tasks:read tasks:write evidence:read"`);
    const authorized = { authorization: `Bearer ${operator}` };
    const listed = (await (await rpc(authorized, 'list_workspaces')).json()).result.structuredContent.workspaces;
    assert.deepEqual(listed.map(row => [row.workspaceId, row.access]).sort(), [[operated, ['tasks:read', 'tasks:write', 'evidence:read']],
      [viewed, ['tasks:read', 'evidence:read']]].sort());
    const claimed = await (await rpc(authorized, 'claim_task', { workspace: operated, project, task: 'tt-1', idempotency_key: 'agent-claim-0001' })).json();
    assert.equal(claimed.result.isError, undefined, JSON.stringify(claimed));
    const refusedWrite = await (await rpc(authorized, 'claim_task', { workspace: viewed, project, task: 'tt-1', idempotency_key: 'agent-claim-0002' })).json();
    assert.match(refusedWrite.result.content[0].text, /^refused:/u);
    assert.deepEqual(fake.calls.map(entry => [entry.workspace, entry.operation.kind]), [[operated, 'update']]);
    await rpc(authorized, 'list_properties', { workspace: viewed });
    assert.deepEqual([forwarded[0].headers.get('authorization'), forwarded[0].headers.get('x-noticeos-workspace-id')], [`Bearer ${operator}`, viewed]);
  } catch (error) { primaryError = error; throw error; } finally {
    const failures = [];
    for (const cleanup of [() => signIn?.close(), () => identity?.close(), () => enginePool?.end(), () => admin?.end(), () => owner?.close()]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (existsSync(path.join(root, 'pg/data/postmaster.pid'))) failures.push(new Error('Owned Postgres PID marker remains'));
    if (failures.length) throw new AggregateError(primaryError ? [primaryError, ...failures] : failures, 'Agent sign-in fixture retirement refused');
    rmSync(root, { recursive: true, force: true });
  }
});
