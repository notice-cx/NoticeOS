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
import { createHostedTaskMcp, TASK_MCP_PATH } from './hosted-task-mcp.mjs';
import { fakeTaskExecutor, memoryReceipts } from './test-fixtures/hosted-task-fakes.mjs';
import { AGENT_ACCESS_PATHS, AUTHORIZATION_SERVER_METADATA_PATH, WORKSPACE_CLAIM, protectedResourceMetadataPath } from './agent-access.mjs';
import { WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './test/postgres-skip.mjs';
import { applyMigrations } from './postgres-migrate.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';

// Agent sign-in (epic ro-cvl9; migration 0014, packages/postgres/src/
// agent-sign-in.mts): the maintained OAuth provider behind fixed routes, a
// person approving an agent for one workspace, and the token it receives.

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

test('an agent registers, its person approves one workspace, and its token names that workspace and endpoint', { timeout: 120_000 }, async t => {
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

    // Discovery: each MCP endpoint names this server; this server describes itself.
    const resource = await (await call(protectedResourceMetadataPath('tasks'))).json();
    assert.deepEqual(resource, { resource: `${origin}/api/tasks/mcp`, authorization_servers: [`${origin}/api/auth`],
      scopes_supported: ['tasks:read', 'tasks:write'], bearer_methods_supported: ['header'], resource_name: 'NoticeOS tasks' });
    const server = await (await call(AUTHORIZATION_SERVER_METADATA_PATH)).json();
    assert.equal(server.issuer, `${origin}/api/auth`);
    assert.equal(server.authorization_endpoint, `${origin}/api/auth/oauth2/authorize`);
    assert.equal(server.token_endpoint, `${origin}/api/auth/oauth2/token`);
    assert.equal(server.registration_endpoint, `${origin}/api/auth/oauth2/register`);
    assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
    assert.equal(server.authorization_response_iss_parameter_supported, true);

    // Dynamic registration of a public client with a loopback redirect.
    const registered = await call('/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Example agent', redirect_uris: [redirect], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
    const client = await registered.json();
    assert.equal(registered.status, 201, JSON.stringify(client));
    assert.equal(client.client_secret, undefined);

    const authorize = async (resourceUri, extra = {}) => {
      const verifier = base64url(randomBytes(32));
      const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect,
        scope: 'tasks:read tasks:write offline_access', state: base64url(randomBytes(12)), resource: resourceUri,
        code_challenge: base64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', ...extra });
      const response = await call(`/api/auth/oauth2/authorize?${params}`, { headers: { cookie } });
      assert.equal(response.status, 302, await response.clone().text());
      const location = new URL(response.headers.get('location'), origin);
      assert.equal(location.pathname, '/agent-access', 'the person is asked, never skipped');
      return { verifier, query: location.search.slice(1), state: params.get('state') };
    };
    const page = (pathname, body, headers = {}) => call(pathname, { method: 'POST',
      headers: { ...browser, 'content-type': 'application/json', cookie, ...headers }, body: JSON.stringify(body) });

    // The person signed out is sent to the same page to sign in first.
    const anonymous = await call(`/api/auth/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id,
      redirect_uri: redirect, scope: 'tasks:read', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })}`);
    assert.equal(new URL(anonymous.headers.get('location'), origin).pathname, '/agent-access');

    const first = await authorize(`${origin}/api/tasks/mcp`);
    const described = await (await page(AGENT_ACCESS_PATHS.request, { oauth_query: first.query })).json();
    assert.deepEqual(described, { client: { name: 'Example agent', uri: null }, scopes: ['tasks:read', 'tasks:write'], signedIn: true });
    assert.equal((await page(AGENT_ACCESS_PATHS.request, { oauth_query: first.query.replace(/sig=[^&]+/u, 'sig=forged') })).status, 403);

    // Approval needs the tab's own session and a workspace the person belongs to.
    const approve = (query, body, headers = { [WORKSPACE_SESSION_HEADER]: sessionId }) =>
      page(AGENT_ACCESS_PATHS.approve, { oauth_query: query, ...body }, headers);
    assert.equal((await approve(first.query, { accept: true, workspaceId: operated }, { [WORKSPACE_SESSION_HEADER]: randomUUID() })).status, 403);
    assert.equal((await approve(first.query, { accept: true, workspaceId: randomUUID() })).status, 403);
    const approved = await approve(first.query, { accept: true, workspaceId: operated });
    const next = new URL((await approved.json()).url);
    assert.equal(next.origin + next.pathname, redirect);
    assert.equal(next.searchParams.get('state'), first.state);
    assert.equal(next.searchParams.get('iss'), `${origin}/api/auth`);
    assert.equal((await admin.query('SELECT active_organization_id FROM noticeos_identity.auth_session WHERE id=$1', [sessionId])).rows[0].active_organization_id,
      null, 'the choice lasts only for its approval');

    // The code becomes a token for that one endpoint and workspace.
    const exchange = async (code, verifier, resourceUri) => call('/api/auth/oauth2/token', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: client.client_id,
        code_verifier: verifier, resource: resourceUri }) });
    const tokens = await (await exchange(next.searchParams.get('code'), first.verifier, `${origin}/api/tasks/mcp`)).json();
    assert.equal(tokens.token_type.toLowerCase(), 'bearer', JSON.stringify(tokens));
    assert.ok(tokens.refresh_token);
    const access = claims(tokens.access_token);
    assert.equal(access.iss, `${origin}/api/auth`);
    assert.deepEqual([access.aud].flat(), [`${origin}/api/tasks/mcp`]);
    assert.equal(access.sub, person.id);
    assert.equal(access[WORKSPACE_CLAIM], operated);
    assert.deepEqual(access.scope.split(' ').sort(), ['offline_access', 'tasks:read', 'tasks:write']);
    assert.ok(access.exp - access.iat <= 3600);

    // A refresh keeps the workspace and the endpoint.
    const refresh = token => call('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: client.client_id,
        resource: `${origin}/api/tasks/mcp` }) });
    const refreshed = await (await refresh(tokens.refresh_token)).json();
    assert.ok(refreshed.access_token, JSON.stringify(refreshed));
    assert.equal(claims(refreshed.access_token)[WORKSPACE_CLAIM], operated);
    // A replayed code is refused and revokes what it issued.
    assert.equal((await exchange(next.searchParams.get('code'), first.verifier, `${origin}/api/tasks/mcp`)).status, 400, 'a code is used once');
    assert.equal((await refresh(refreshed.refresh_token)).status, 400, 'a replayed code revokes its refresh tokens');

    // A viewer's agent may read and never write.
    const second = await authorize(`${origin}/api/tasks/mcp`);
    const viewerNext = new URL((await (await approve(second.query, { accept: true, workspaceId: viewed })).json()).url);
    const viewerTokens = await (await exchange(viewerNext.searchParams.get('code'), second.verifier, `${origin}/api/tasks/mcp`)).json();
    assert.ok(viewerTokens.access_token, JSON.stringify({ viewerTokens, viewerNext: viewerNext.href }));
    const viewer = claims(viewerTokens.access_token);
    assert.deepEqual([viewer[WORKSPACE_CLAIM], viewer.scope.split(' ').sort()], [viewed, ['offline_access', 'tasks:read']]);

    // Denying sends the agent access_denied and records nothing.
    const third = await authorize(`${origin}/api/tasks/mcp`);
    const consents = (await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_oauth_consent')).rows[0].n;
    const denied = new URL((await (await approve(third.query, { accept: false })).json()).url);
    assert.equal(denied.searchParams.get('error'), 'access_denied');
    assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_oauth_consent')).rows[0].n, consents);

    // Only the fixed routes answer; the library's other endpoints stay private.
    assert.equal(await call('/api/auth/oauth2/consent', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }), null);
    assert.equal((await call('/api/auth/oauth2/token')).status, 405);

    // The resource side: a token is checked against this deployment's key, its
    // endpoint, and the person's live membership, consent and client.
    identity = await openIdentity(options);
    const bearer = (token, pathname = TASK_MCP_PATH) => new Request(origin + pathname, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    const operator = refreshed.access_token, reader = viewerTokens.access_token;
    const facts = await identity.agentAuthority(bearer(operator), 'tasks');
    assert.deepEqual({ ...facts, scopes: [...facts.scopes].sort() }, { principalId: person.id, clientId: client.client_id,
      workspaceId: operated, role: 'operator', workspaceStatus: 'active', expiresAt: facts.expiresAt, scopes: ['tasks:read', 'tasks:write'] });
    assert.equal(await identity.agentAuthority(bearer(operator), 'evidence'), null, 'a token works only at its own endpoint');
    assert.equal(await identity.agentAuthority(bearer(`${operator.slice(0, -4)}AAAA`), 'tasks'), null, 'a forged signature is refused');
    assert.equal(await identity.agentAuthority(new Request(origin + TASK_MCP_PATH), 'tasks'), null);
    const revoke = async (statement, restore) => {
      await admin.query(statement[0], statement[1]);
      assert.equal(await identity.agentAuthority(bearer(operator), 'tasks'), null, statement[0]);
      await admin.query(restore[0], restore[1]);
      assert.ok(await identity.agentAuthority(bearer(operator), 'tasks'), restore[0]);
    };
    await revoke(['UPDATE noticeos_identity.auth_oauth_client SET disabled=true WHERE client_id=$1', [client.client_id]],
      ['UPDATE noticeos_identity.auth_oauth_client SET disabled=NULL WHERE client_id=$1', [client.client_id]]);
    await revoke(["UPDATE noticeos_identity.auth_oauth_consent SET reference_id='x' WHERE reference_id=$1", [operated]],
      ["UPDATE noticeos_identity.auth_oauth_consent SET reference_id=$1 WHERE reference_id='x'", [operated]]);
    await revoke(['DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [operated, person.id]],
      ["INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES(gen_random_uuid(),$1,$2,'operator',now())", [operated, person.id]]);


    // Admission: the person's role bounds the token's scopes, and no scope
    // reaches a decision. No browser evidence is needed or accepted.
    const admission = createWorkspaceAdmission({ kind: 'hosted', profile: Symbol(), trustedOrigin: origin,
      membership: async () => assert.fail('an agent request never reads a browser session'),
      agent: request => identity.agentAuthority(request, 'tasks') });
    const admitted = (token, action, requestedWorkspaceId) => admission.withAdmission(action,
      { correlationId: 'agent-test', ...(requestedWorkspaceId ? { requestedWorkspaceId } : {}) }, bearer(token), async context => context);
    const context = await admitted(operator, 'tasks.write');
    assert.deepEqual([context.principalKind, context.principalId, context.workspaceId, context.agentClientId, context.sessionId],
      ['agent', person.id, operated, client.client_id, undefined]);
    assert.deepEqual([...context.allowedActions].sort(), ['tasks.read', 'tasks.write']);
    await assert.rejects(admitted(operator, 'tasks.decide'));
    await assert.rejects(admitted(operator, 'evidence.read'));
    await assert.rejects(admitted(operator, 'tasks.read', viewed), 'a selection cannot move a token to another workspace');
    assert.equal((await admitted(reader, 'tasks.read')).workspaceId, viewed);
    await assert.rejects(admitted(reader, 'tasks.write'));
    await enginePool.query("UPDATE noticeos_identity.auth_member SET role='viewer' WHERE organization_id=$1", [operated]);
    await assert.rejects(admitted(operator, 'tasks.write'), 'a role change narrows a live token at once');
    await enginePool.query("UPDATE noticeos_identity.auth_member SET role='operator' WHERE organization_id=$1", [operated]);
    await admin.query("UPDATE noticeos.workspaces SET status='suspended' WHERE workspace_id=$1", [operated]);
    await assert.rejects(admitted(operator, 'tasks.read'), 'a suspended workspace admits no agent');
    await admin.query("UPDATE noticeos.workspaces SET status='active' WHERE workspace_id=$1", [operated]);

    // The task MCP endpoint: a 401 naming where to sign in, a 403 naming the
    // missing scope, and the call itself under the token's workspace.
    const project = randomUUID();
    const fake = fakeTaskExecutor({ principal: () => person.id, clock: Date.now });
    const mcp = createHostedTaskMcp({ profile: 'hosted', trustedOrigin: origin, agents: { verify: request => identity.agentAuthority(request, 'tasks') },
      operations: createHostedTaskOperations({ admission, executor: fake.executor, receipts: memoryReceipts(Date.now),
        directory: { catalog: async () => Object.freeze([{ projectId: project, logicalKey: 'example', displayName: 'Example', prefix: 'tt' }]) } }) });
    const rpc = (headers, name, args = {}) => mcp(new Request(origin + TASK_MCP_PATH, { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
    const missing = await rpc({}, 'list_projects');
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('www-authenticate'),
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/tasks/mcp", scope="tasks:read tasks:write"`);
    const stale = await rpc({ authorization: `Bearer ${operator.slice(0, -4)}AAAA` }, 'list_projects');
    assert.equal(stale.status, 401); assert.match(stale.headers.get('www-authenticate'), /error="invalid_token"/u);
    const listed = await (await rpc({ authorization: `Bearer ${reader}` }, 'list_projects')).json();
    assert.deepEqual(listed.result.structuredContent.projects.map(row => row.projectId), [project]);
    const narrow = await rpc({ authorization: `Bearer ${reader}` }, 'create_task', { project, title: 'x', idempotency_key: 'agent-create-0001' });
    assert.equal(narrow.status, 403);
    assert.equal(narrow.headers.get('www-authenticate'), `Bearer error="insufficient_scope", resource_metadata="${origin}/.well-known/oauth-protected-resource/api/tasks/mcp", scope="tasks:write"`);
    const created = await (await rpc({ authorization: `Bearer ${operator}` }, 'claim_task', { project, task: 'tt-1', idempotency_key: 'agent-claim-0001' })).json();
    assert.equal(created.result.isError, undefined, JSON.stringify(created));
    assert.deepEqual(fake.calls.map(call => [call.workspace, call.operation.kind]), [[operated, 'update']]);
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
