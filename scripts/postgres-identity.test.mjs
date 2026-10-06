import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openIdentity, IDENTITY_NAMES, IdentityRefused } from '../packages/postgres/src/identity.mjs';
import { openEmailCodeLogin, EMAIL_CODE_PATHS } from '../packages/postgres/src/email-code.mjs';
import { openStore } from '../packages/postgres/src/store.mjs';
import { findPostgres, LOOPBACK_HBA } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { skipWithoutPostgres } from './postgres-test-skip.mjs';
import { checkDatabase } from './database-address.mjs';
import { applyMigrations, bootstrapWorkspace, readMigrations } from './postgres-migrate.mjs';
import { stopLocalSecretReads } from './worker-config-folder.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';

const requireIdentity = createRequire(path.join(REPO_ROOT, 'packages/postgres/package.json'));
const { Pool } = requireIdentity('pg');
const { betterAuth } = await import(requireIdentity.resolve('better-auth/minimal'));
const { getMigrations } = await import(requireIdentity.resolve('better-auth/db/migration'));
const { organization } = await import(requireIdentity.resolve('better-auth/plugins'));
const { kyselyAdapter } = await import(requireIdentity.resolve('@better-auth/kysely-adapter'));
const { Kysely, PostgresDialect } = await import(requireIdentity.resolve('kysely'));

test('identity requires explicit origin, secret and connection before any socket', async () => {
  for (const trustedOrigin of ['https://example.test/path', 'http://foreign.example.test', 'not-an-origin', 'https://u:p@example.test']) {
    await assert.rejects(openIdentity({ trustedOrigin, sessionSecret: randomBytes(48).toString('hex'), connectionString: 'postgres:///not_contacted' }), IdentityRefused);
  }
  await assert.rejects(openIdentity({ trustedOrigin: 'https://example.test', connectionString: '', sessionSecret: '' }), IdentityRefused);
  for (const connectionString of ['not-a-url', 'https://secret@example.test/db', 'postgresql://127.0.0.1/db', 'postgresql://noticeos_identity@127.0.0.1/']) {
    await assert.rejects(openIdentity({ trustedOrigin: 'https://example.test', connectionString, sessionSecret: randomBytes(48).toString('hex') }), (error) => error instanceof IdentityRefused && !error.message.includes(connectionString));
  }
});

test('owned identity migration, fresh session/membership and Worker lifecycle preserve standalone access', async (t) => {
  const tools = findPostgres();
  const root = mkdtempSync(path.join(os.tmpdir(), 'noticeos-identity-'));
  const opened = [];
  let owner, admin, enginePool, mf, standalone;
  try {
    owner = await skipWithoutPostgres(t, () => openOnLoopbackPort(path.join(root, 'pg'), tools)); if (!owner) return;
    const port = owner.loopbackPort;
    admin = new Pool({ host: owner.socketDir, port, database: 'noticeos_dev', user: 'postgres', max: 1 });
    // Compile against the owned empty database, before the append-only migration.
    const generation = await getMigrations({
      database: { dialect: new PostgresDialect({ pool: admin }), type: 'postgres', schemaName: 'noticeos_identity', transaction: true },
      advanced: { database: { generateId: 'uuid' } },
      user: IDENTITY_NAMES.user, account: IDENTITY_NAMES.account, verification: IDENTITY_NAMES.verification,
      session: IDENTITY_NAMES.session, logger: { disabled: true },
      plugins: [organization({ schema: IDENTITY_NAMES.organization })],
    });
    const generatedDdl = await generation.compileMigrations();
    const baselineDir = path.join(root, 'baseline-migrations'); mkdirSync(baselineDir);
    writeFileSync(path.join(baselineDir, '0001_baseline.sql'), readFileSync(path.join(REPO_ROOT, 'db/postgres/migrations/0001_baseline.sql')));
    assert.deepEqual(applyMigrations(owner, { dir: baselineDir }).applied, ['0001_baseline']);
    owner.run('DROP ROLE noticeos_identity');
    assert.throws(() => applyMigrations(owner), /not noticeos_identity/u, 'existing clusters require the new role to be prepared explicitly');
    assert.equal(owner.sql('SELECT count(*) AS n FROM noticeos_migrations.applied')[0].n, '1');
    const identityRole = readFileSync(path.join(REPO_ROOT, 'db/postgres/roles.sql'), 'utf8').split('\n').find(line => line.startsWith('CREATE ROLE noticeos_identity '));
    assert.ok(identityRole); owner.run(identityRole);
    writeFileSync(path.join(baselineDir, '0002_identity.sql'), readFileSync(path.join(REPO_ROOT, 'db/postgres/migrations/0002_identity.sql')));
    const applied = applyMigrations(owner, { dir: baselineDir });
    const appUrl = owner.applicationLogin().url();
    assert.ok(applied.applied.includes('0002_identity'));
    assert.deepEqual(applyMigrations(owner, { dir: baselineDir }).applied, []);
    await t.test('additive identity schema preserves standalone reads with the 0001+0002 inventory', async () => {
      const workspace = bootstrapWorkspace(owner, { slug: 'fixture-one', name: 'Fixture One', dir: baselineDir }).workspaceId;
      standalone = openStore(appUrl);
      assert.equal(await standalone.onlyWorkspace(), workspace);
      await standalone.close(); standalone = null;
      assert.deepEqual(owner.sql('SELECT name FROM noticeos_migrations.applied ORDER BY version').map(row => row.name), ['0001_baseline', '0002_identity']);
      assert.deepEqual(await checkDatabase({ url: appUrl }, { where: 'owned standalone fixture', migrationsDir: baselineDir }), { ok: true }, 'current standalone reader accepts the complete additive migration inventory');
    });
    const password = randomBytes(32).toString('base64url');
    await admin.query('ALTER ROLE noticeos_identity LOGIN');
    await admin.query(`ALTER ROLE noticeos_identity PASSWORD '${password}'`);
    appendFileSync(path.join(owner.root, LOOPBACK_HBA), 'host all noticeos_identity 127.0.0.1/32 scram-sha-256\n');
    execFileSync(tools.pgCtl, ['reload', '-D', path.join(owner.root, 'data')], { stdio: 'pipe' });
    const url = new URL(appUrl); url.username = 'noticeos_identity'; url.password = password;
    const connectionString = url.href;
    const origin = 'https://fixture.example.test';
    const secret = randomBytes(48).toString('base64url');
    const input = { connectionString, trustedOrigin: origin, sessionSecret: secret };
    enginePool = new Pool({ connectionString, max: 1 });
    // The fixture engine creates signed sessions; no raw engine is exported by
    // the production adapter or wired to an application HTTP entry.
    const engine = betterAuth({
      database: kyselyAdapter(new Kysely({ dialect: new PostgresDialect({ pool: enginePool }) }).withSchema('noticeos_identity'), { type: 'postgres', transaction: true }),
      baseURL: origin, trustedOrigins: [origin], secret, telemetry: { enabled: false }, logger: { disabled: true },
      advanced: { database: { generateId: 'uuid' } }, emailAndPassword: { enabled: true },
      user: IDENTITY_NAMES.user, account: IDENTITY_NAMES.account, verification: IDENTITY_NAMES.verification,
      session: { ...IDENTITY_NAMES.session, cookieCache: { enabled: false } },
      plugins: [organization({ allowUserToCreateOrganization: false, schema: IDENTITY_NAMES.organization })],
    });
    await t.test('owned snake_case tables and indexes exactly match the maintained generator', async () => {
      const ddl = generatedDdl;
      const committed = readFileSync(path.join(REPO_ROOT, 'db/postgres/migrations/0002_identity.sql'), 'utf8');
      const shapes = sql => sql.split('\n').filter(line => /^create (table|index)/u.test(line));
      assert.deepEqual(shapes(committed), shapes(ddl));
      for (const [, name] of ddl.matchAll(/"([^"]+)"/gu)) assert.match(name, /^[a-z][a-z0-9_]*$/u);
    });
    const signupPassword = randomBytes(24).toString('base64url');
    const signup = await engine.handler(new Request(`${origin}/api/auth/sign-up/email`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Generated person', email: 'person@example.test', password: signupPassword }) }));
    assert.equal(signup.status, 200);
    const person = (await signup.json()).user;
    const cookie = signup.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const headers = new Headers({ cookie, origin });
    const [a, b] = [randomUUID(), randomUUID()];
    for (const [id, slug] of [[a, 'tenant-a'], [b, 'tenant-b']]) {
      await admin.query('INSERT INTO noticeos.workspaces(workspace_id,slug,display_name) VALUES($1,$2,$2)', [id, slug]);
      await enginePool.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [id, `identity-${id}`]);
    }
    for (const [id, role] of [[a, 'owner'], [b, 'viewer']]) await enginePool.query('INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,$4,now())', [randomUUID(), id, person.id, role]);
    const identity = await openIdentity(input); opened.push(identity);
    const actorA = randomUUID(), actorB = randomUUID();
    for (const [principal, workspace, name] of [[actorA, a, 'Workspace A member'], [actorB, b, 'Workspace B member']]) {
      await enginePool.query('INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified,created_at,updated_at) VALUES($1,$2,$3,true,now(),now())', [principal, name, `${principal}@example.test`]);
      await enginePool.query('INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,$4,now())', [randomUUID(), workspace, principal, 'viewer']);
    }
    const session = await identity.session(headers);
    assert.equal(session.principalId, person.id);
    assert.deepEqual(Object.keys(session).sort(), ['expiresAt', 'principalId', 'sessionId']);
    await t.test('workspace actors expose current owned principal names only, with immutable IDs', async () => {
      const actors = await identity.workspaceActors(a);
      assert.ok(Object.isFrozen(actors) && actors.every(Object.isFrozen));
      assert.deepEqual(actors.find(actor => actor.principalId === actorA), { principalId: actorA, displayName: 'Workspace A member' });
      assert.ok(!actors.some(actor => actor.principalId === actorB));
      assert.ok(actors.every(actor => Object.keys(actor).sort().join(',') === 'displayName,principalId'));
      await assert.rejects(identity.workspaceActors('not-a-workspace'), IdentityRefused);
      assert.deepEqual(await identity.workspaceActors(randomUUID()), []);
      await enginePool.query('UPDATE noticeos_identity.auth_user SET name=$1 WHERE id=$2', ['Current member name', actorA]);
      assert.equal((await identity.workspaceActors(a)).find(actor => actor.principalId === actorA).displayName, 'Current member name');
      await enginePool.query('DELETE FROM noticeos_identity.auth_member WHERE user_id=$1', [actorA]);
      assert.ok(!(await identity.workspaceActors(a)).some(actor => actor.principalId === actorA));
      const overBudget = randomUUID();
      await admin.query('INSERT INTO noticeos.workspaces(workspace_id,slug,display_name) VALUES($1,$2,$2)', [overBudget, 'roster-budget']);
      await enginePool.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [overBudget, 'roster-budget']);
      await enginePool.query(`WITH people AS (
        INSERT INTO noticeos_identity.auth_user(id,name,email,email_verified,created_at,updated_at)
        SELECT gen_random_uuid(),'Bounded member',gen_random_uuid()::text||'@example.test',true,now(),now()
        FROM generate_series(1,1001) RETURNING id)
        INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at)
        SELECT gen_random_uuid(),$1,id,'viewer',now() FROM people`, [overBudget]);
      await assert.rejects(identity.workspaceActors(overBudget), IdentityRefused, 'over-budget roster is unavailable, never a misleading sample');
    });
    await t.test('explicit memberships ignore active selection and return no secret/account data', async () => {
      await enginePool.query('UPDATE noticeos_identity.auth_session SET active_organization_id=$1 WHERE id=$2', [a, session.sessionId]);
      assert.equal((await identity.membership(headers, b)).role, 'viewer');
      await enginePool.query('UPDATE noticeos_identity.auth_session SET active_organization_id=$1 WHERE id=$2', [b, session.sessionId]);
      assert.equal((await identity.membership(headers, a)).role, 'owner');
      assert.equal(await identity.membership(headers, randomUUID()), null);
      await assert.rejects(identity.membership(headers, 'not-a-workspace'), IdentityRefused);
      assert.equal(await identity.session(new Headers()), null);
      assert.equal(await identity.session(new Headers({ cookie: `${cookie}tampered` })), null);
      await enginePool.query('UPDATE noticeos_identity.auth_member SET role=$1 WHERE organization_id=$2', ['admin', b]);
      assert.equal(await identity.membership(headers, b), null, 'library admin is not a product operator');
      await enginePool.query('UPDATE noticeos_identity.auth_member SET role=$1 WHERE organization_id=$2', ['operator', b]);
      assert.equal((await identity.membership(headers, b)).role, 'operator');
    });
    await t.test('actual 0002-only facts work while login refuses missing 0004 before counters/mail', async () => {
      assert.deepEqual(owner.sql('SELECT name FROM noticeos_migrations.applied ORDER BY version').map(row => row.name), ['0001_baseline', '0002_identity']);
      let oldSchema;
      const login = openEmailCodeLogin({ ...input, peerAddress: '192.0.2.1', deliver: async () => assert.fail('missing schema cannot deliver') });
      try {
        oldSchema = await openIdentity(input);
        assert.equal((await oldSchema.session(headers)).principalId, person.id);
        assert.equal((await oldSchema.membership(headers, a)).role, 'owner');
        await assert.rejects(login.requestCode(new Request(`${origin}${EMAIL_CODE_PATHS.request}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: person.email }) })), IdentityRefused);
        assert.equal((await admin.query('SELECT count(*)::int n FROM noticeos_identity.auth_verification')).rows[0].n, 0);
      } finally {
        await oldSchema?.close();
        await login.close();
      }
    });
    assert.deepEqual(applyMigrations(owner).applied, readMigrations().slice(2).map(migration => migration.name));
    await admin.query("UPDATE noticeos.workspaces SET status='provisioning' WHERE workspace_id=ANY($1::uuid[])", [[a, b]]);
    await t.test('narrow runtime cannot reach tenant data, DDL or a missing canonical workspace', async () => {
      await assert.rejects(enginePool.query('SELECT * FROM noticeos.assets'), { code: '42501' });
      await assert.rejects(enginePool.query('CREATE TABLE noticeos_identity.invalid(id text)'), { code: '42501' });
      await assert.rejects(enginePool.query('SET ROLE noticeos_owner'), { code: '42501' });
      await assert.rejects(enginePool.query('INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES($1,$2,$2,now())', [randomUUID(), 'invalid-anchor']), { code: '23503' });
      await assert.rejects(enginePool.query('INSERT INTO noticeos_identity.auth_member(id,organization_id,user_id,role,created_at) VALUES($1,$2,$3,$4,now())', [randomUUID(), a, person.id, 'viewer']), { code: '23505' });
      await assert.rejects(openIdentity({ ...input, connectionString: appUrl }), IdentityRefused);
      await admin.query('CREATE ROLE synthetic_elevated NOLOGIN CREATEROLE');
      await admin.query('GRANT synthetic_elevated TO noticeos_identity');
      await assert.rejects(openIdentity(input), IdentityRefused);
      await admin.query('REVOKE synthetic_elevated FROM noticeos_identity');
    });
    await t.test('warm facts immediately reflect member removal and role changes', async () => {
      await enginePool.query('DELETE FROM noticeos_identity.auth_member WHERE organization_id=$1 AND user_id=$2', [b, person.id]);
      assert.equal(await identity.membership(headers, b), null);
      await enginePool.query('UPDATE noticeos_identity.auth_member SET role=$1 WHERE organization_id=$2', ['viewer', a]);
      assert.equal((await identity.membership(headers, a)).role, 'viewer');
    });
    await t.test('admission facts join fresh membership with canonical lifecycle without tenant access', async () => {
      assert.equal((await identity.admissionMembership(headers, a)).workspaceStatus, 'provisioning');
      assert.deepEqual(await identity.workspaceSummary(a), { workspaceId: a, displayName: 'tenant-a', status: 'provisioning' });
      await admin.query('UPDATE noticeos.workspaces SET status=$1 WHERE workspace_id=$2', ['active', a]);
      assert.equal((await identity.admissionMembership(headers, a)).workspaceStatus, 'active');
      await admin.query('UPDATE noticeos.workspaces SET status=$1 WHERE workspace_id=$2', ['suspended', a]);
      assert.equal((await identity.admissionMembership(headers, a)).workspaceStatus, 'suspended');
      assert.equal(await identity.admissionMembership(headers, b), null, 'removed member cannot use canonical summary as admission');
      assert.equal(await identity.workspaceSummary(randomUUID()), null);
      await assert.rejects(enginePool.query('UPDATE noticeos.workspaces SET status=$1 WHERE workspace_id=$2', ['active', a]), { code: '42501' });
      await assert.rejects(enginePool.query('SELECT * FROM noticeos.workspaces'), { code: '42501' });
      await admin.query('UPDATE noticeos.workspaces SET status=$1 WHERE workspace_id=$2', ['active', a]);
    });
    await t.test('ordinary production bundle runs the same fresh facts in workerd and closes connections', async () => {
      const wranglerRequire = createRequire(createRequire(path.join(REPO_ROOT, 'workers/ingest/package.json')).resolve('wrangler/package.json'));
      const wranglerPath = wranglerRequire.resolve('wrangler/package.json');
      const metadata = JSON.parse(readFileSync(wranglerPath, 'utf8'));
      const build = path.join(root, 'build'); mkdirSync(build);
      const config = path.join(root, 'wrangler.json');
      writeFileSync(config, JSON.stringify({ name: 'noticeos-identity-fixture', main: path.join(REPO_ROOT, 'scripts/identity-worker.fixture.mjs'), compatibility_date: '2026-07-06', compatibility_flags: ['nodejs_compat'], send_metrics: false }));
      const clientHome = path.join(root, 'build-client'); mkdirSync(clientHome);
      const childEnv = {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: clientHome,
        TMPDIR: root, XDG_CONFIG_HOME: path.join(clientHome, 'config'), XDG_CACHE_HOME: path.join(clientHome, 'cache'),
        NODE_OPTIONS: `--import=${path.join(REPO_ROOT, 'scripts/script-tests-setup.mjs')}`,
        WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true', BETTER_AUTH_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', NO_COLOR: '1',
      };
      stopLocalSecretReads(childEnv);
      const result = spawnSync(process.execPath, [path.join(path.dirname(wranglerPath), metadata.bin.wrangler), 'deploy', '--dry-run', '--config', config, '--outdir', build], { cwd: root, encoding: 'utf8', timeout: 60000, env: childEnv });
      assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
      const bundle = path.join(build, 'identity-worker.fixture.js');
      assert.ok(!readFileSync(bundle, 'utf8').includes('node:sqlite'));
      const { Miniflare } = wranglerRequire('miniflare');
      let outside = 0;
      mf = new Miniflare({ modules: true, modulesRoot: build, scriptPath: bundle, compatibilityDate: '2026-07-06', compatibilityFlags: ['nodejs_compat'], bindings: { FIXTURE_CONNECTION: connectionString, FIXTURE_ORIGIN: origin, FIXTURE_SECRET: secret }, outboundService: async () => { outside++; throw new Error('No outside HTTP in identity fixture'); } });
      let workerCookie = cookie;
      const request = (workspace) => mf.dispatchFetch(`${origin}/${workspace ? `?workspace=${workspace}` : ''}`, { headers: { cookie: workerCookie, origin } });
      const actorsResponse = await mf.dispatchFetch(`${origin}/?workspace=${b}&actors=1`, { headers: { cookie: workerCookie, origin } });
      const workerActors = await actorsResponse.json();
      assert.deepEqual(workerActors.find(actor => actor.principalId === actorB), { principalId: actorB, displayName: 'Workspace B member' });
      assert.ok(!workerActors.some(actor => actor.principalId === actorA));
      assert.ok(workerActors.every(actor => Object.keys(actor).sort().join(',') === 'displayName,principalId'));
      assert.equal((await (await request(a)).json()).role, 'viewer');
      await enginePool.query('UPDATE noticeos_identity.auth_session SET expires_at=now()-interval \'1 second\' WHERE id=$1', [session.sessionId]);
      assert.equal(await (await request(a)).json(), null);
      assert.equal(await identity.session(headers), null);
      const signedIn = await engine.handler(new Request(`${origin}/api/auth/sign-in/email`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email: person.email, password: signupPassword }) }));
      assert.equal(signedIn.status, 200); await signedIn.arrayBuffer();
      workerCookie = signedIn.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
      const freshWorker = await (await request()).json();
      assert.equal(freshWorker.principalId, person.id);
      await enginePool.query('DELETE FROM noticeos_identity.auth_session WHERE id=$1', [freshWorker.sessionId]);
      assert.equal(await (await request(a)).json(), null);
      assert.equal(await identity.membership(headers, a), null);
      assert.equal(outside, 0);
      await mf.dispose(); mf = null;
      const workerConnections = await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='noticeos_identity'");
      assert.ok(workerConnections.rows[0].n <= 2, 'no Worker pool remains beyond the two explicitly held native pools');
    });
    await t.test('close is idempotent, awaits started facts and refuses later work', async () => {
      const second = await openIdentity(input); opened.push(second);
      const pending = second.session(new Headers());
      const closed = second.close();
      assert.equal(second.close(), closed);
      await pending; await closed;
      await assert.rejects(second.session(headers), IdentityRefused);
      await assert.rejects(second.membership(headers, a), IdentityRefused);
    });
    const identityPids = (await admin.query("SELECT pid FROM pg_stat_activity WHERE usename='noticeos_identity'")).rows.map(row => row.pid);
    await Promise.all(opened.map((identity) => identity.close()));
    await enginePool.end(); enginePool = null;
    // Closing the socket and PostgreSQL removing its backend are distinct
    // events. Await only these owned fixture PIDs, without accepting a leak.
    const deadline = performance.now() + 1000;
    while (performance.now() < deadline) {
      const remaining = await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE pid=ANY($1::int[])', [identityPids]);
      if (remaining.rows[0].n === 0) break;
    }
    assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE usename='noticeos_identity'")).rows[0].n, 0);
  } finally {
    const cleanup = await Promise.allSettled([
      ...(mf ? [mf.dispose()] : []), ...opened.map((identity) => identity.close()),
      ...(standalone ? [standalone.close()] : []), ...(enginePool ? [enginePool.end()] : []), ...(admin ? [admin.end()] : []),
    ]);
    if (owner) owner.close();
    assert.equal(existsSync(path.join(root, 'pg/data/postmaster.pid')), false, 'retain fixture if owned server absence is uncertain');
    rmSync(root, { recursive: true, force: true });
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
  }
});
