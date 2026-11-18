// Opt-in proof. Every resource is new, local, and belongs to this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { get as getHttp } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startPlan, prepareFolder } from './start.mjs';
import { prepareFreshPostgres, startPostgresPlan, databaseEmpty } from './start-postgres.mjs';
import { createFreshOsAsset, writeInstallationDocuments } from './os-setup-container.mjs';
import { localDockerEndpoint } from './postgres-compose.mjs';
import { runCommand } from './run-command.mjs';
import { containerProofCleanup } from './container-proof-cleanup.mjs';
import { openStore } from '../packages/postgres/src/store.mjs';
import { CONFIG_DOCUMENT_FILES, configDocumentKey } from './config-documents.mjs';
import { SCHEDULED_JOBS } from './scheduled-jobs.mjs';
import { INITIAL_DOCUMENTS } from '../apps/tower/e2e/fixtures.ts';
import { EMAIL_CODE_PATHS } from './identity-protocol.mjs';
import { WORKSPACE_SELECTION_HEADER, WORKSPACE_SESSION_HEADER } from './browser-request-policy.mjs';
import { prepareContainerContext } from './container-context.mjs';
import { developStack } from './stack-development.mjs';
import { DEPENDENCY_PATHS } from '../deploy/compose/development.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const enabled = process.env.NOTICEOS_TEST_CONTAINER === '1';
const customerDevelopment = process.env.NOTICEOS_TEST_CONTAINER_CUSTOMER_DEVELOPMENT === '1';
const customer = customerDevelopment || process.env.NOTICEOS_TEST_CONTAINER_CUSTOMER === '1';
const customerLan = customerDevelopment || (customer && process.env.NOTICEOS_TEST_CONTAINER_CUSTOMER_LAN === '1');
const googleSetup = process.env.NOTICEOS_TEST_CONTAINER_CUSTOMER_GOOGLE_SETUP === '1';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
function fixtureSource(base) {
  const root = path.join(base, 'source');
  // Reuse the browser harness's synthetic documents, never checkout config.
  for (const file of CONFIG_DOCUMENT_FILES) {
    assert.ok(Object.hasOwn(INITIAL_DOCUMENTS, file), `declare a synthetic document for ${file}`);
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    write(path.join(root, file), structuredClone(INITIAL_DOCUMENTS[file]));
  }
  const files = [
    'apps/tower/wrangler.jsonc', 'workers/ingest/wrangler.jsonc',
    'db/postgres/roles.sql', 'db/postgres/frozen-migrations.sha256',
    ...['compose.yaml', 'pg_hba.conf', 'first-start.sh'].map(name => `db/postgres/host/${name}`),
    ...fs.readdirSync(path.join(ROOT, 'db/postgres/migrations')).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).map(name => `db/postgres/migrations/${name}`),
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  }
  return root;
}
async function freePortBlock() {
  for (let port = 5750; port <= 5796; port += 4) {
    const servers = await Promise.all([0, 1, 2, 3].map(offset => new Promise(resolve => {
      const server = net.createServer(); server.once('error', () => resolve(null));
      server.listen(port + offset, '127.0.0.1', () => resolve(server));
    })));
    await Promise.all(servers.filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
    if (servers.every(Boolean)) return port;
  }
  throw new Error('The disposable container proof needs a free block in 5750–5799.');
}
async function until(check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  return await new Promise((resolve, reject) => {
    const attempt = async () => {
      try { const value = await check(); if (value) { resolve(value); return; } }
      catch (error) { if (Date.now() >= deadline) { reject(error); return; } }
      if (Date.now() >= deadline) { reject(new Error('The owned container did not reach the expected state.')); return; }
      setTimeout(attempt, 250);
    };
    void attempt();
  });
}

test('the application container runs its schedules with no task service, preserving state across its own restart', { skip: !enabled, timeout: 480_000 }, async t => {
  const image = process.env.NOTICEOS_TEST_APP_IMAGE;
  assert.match(image ?? '', /^noticeos-local:compose-proof-[a-z0-9]+$/u, 'use the explicitly built local proof image');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-container-proof-'));
  // Nothing else exists yet; an early preflight refusal still owns this folder.
  let cleanupServices = null;
  t.after(async () => {
    await cleanupServices?.();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const state = path.join(base, 'state');
  const spokes = path.join(base, 'spokes');
  const plan = startPlan({ root: fixtureSource(base), dir: state, port: await freePortBlock() });
  if (customer) fs.appendFileSync(path.join(plan.root, 'db/postgres/host/pg_hba.conf'),
    'host noticeos noticeos_identity all scram-sha-256\nhost noticeos noticeos_service_grant all scram-sha-256\n');
  const pg = startPostgresPlan(plan);
  const toolEnv = Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'TMPDIR', 'LANG'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const endpoint = await localDockerEndpoint(runCommand, { cwd: ROOT, env: toolEnv });
  assert.ok(endpoint, 'prove a local Docker endpoint before any resource request');
  const env = { ...toolEnv, DOCKER_HOST: endpoint };
  const appFile = path.join(ROOT, 'deploy/compose/compose.yaml');
  const isolatedDatabases = path.join(base, 'databases.json');
  const databaseEnv = { ...env, NOTICEOS_POSTGRES_SECRETS: pg.secrets, NOTICEOS_POSTGRES_PORT: String(pg.port) };
  const databases = (args) => runCommand('docker', ['compose', '-p', pg.project,
    ...(fs.existsSync(isolatedDatabases) ? ['-f', isolatedDatabases] : ['-f', pg.compose]),
    '--env-file', os.devNull, ...args], { cwd: ROOT, env: databaseEnv, timeoutMs: 120_000 });
  const appEnv = { ...env, ...(customerLan ? { TOWER_ALLOWED_HOSTS: 'fixture-tower.local' } : {}), NOTICEOS_APP_IMAGE: image, NOTICEOS_STATE_DIR: state, NOTICEOS_SPOKES_DIR: spokes,
    NOTICEOS_NETWORK: `${pg.project}_default`, NOTICEOS_TOWER_PORT: String(plan.port),
    NOTICEOS_APP_UID: String(process.getuid()), NOTICEOS_APP_GID: String(process.getgid()) };
  let developmentOverride;
  const compose = (args, override = developmentOverride) => runCommand('docker', ['compose', '-p', pg.project, '-f', appFile,
    ...(override ? ['-f', override] : []), '--env-file', os.devNull, ...args], { cwd: ROOT, env: appEnv, timeoutMs: 240_000 });
  const run = (command, args, options) => {
    return runCommand(command, args, options).then(async result => {
      if (result.code !== 0 && command === 'docker' && !args.includes('inspect')) {
        t.diagnostic(`owned Compose command failed: ${result.stderr.slice(-1500)}`);
        const up = args.lastIndexOf('up');
        if (up >= 0 && args.includes('compose') && args.at(-1) === 'noticeos') {
          const logs = await runCommand(command, [...args.slice(0, up), 'logs', '--no-color', '--tail', '40', 'noticeos'], options);
          const safe = (logs.stdout + logs.stderr).replaceAll(/postgres(?:ql)?:\/\/\S+/gu, '[redacted]');
          t.diagnostic(`owned app logs before recovery: ${safe.slice(-4000)}`);
        }
      }
      return result;
    });
  };
  // PG preparation proves its own absence before creating it; cleanup is
  // confined to these exact names.
  const cleanup = containerProofCleanup({ base, project: pg.project, image,
    mounts: [{ source: state, destination: '/state' }, { source: spokes, destination: '/spokes' }],
    runDocker: (args, options) => runCommand('docker', args, { cwd: ROOT, env, ...options }) });
  await cleanup.proveFresh();
  const sourceOverride = path.join(base, 'stack-development', 'source.json');
  cleanupServices = () => cleanup.finish([() => compose(['down', '--volumes'], fs.existsSync(sourceOverride) ? sourceOverride : undefined),
    () => databases(['down', '--volumes'])]);
  const prepared = await prepareFreshPostgres(plan, { env, run, empty(own) {
    try { return databaseEmpty(own); }
    catch (error) {
      let safe = String(error.message);
      for (const name of ['postgres', 'noticeos_owner', 'noticeos_maint', 'noticeos_app']) {
        const file = path.join(own.secrets, name); if (fs.existsSync(file)) safe = safe.replaceAll(fs.readFileSync(file, 'utf8').trim(), '[redacted]');
      }
      t.diagnostic(`own Postgres empty-check failed: ${safe}`); throw error;
    }
  } });
  assert.equal(prepared.ok, true, prepared.line);
  assert.equal(prepared.created, true);
  await prepareFolder(plan);
  const hostAddress = fs.readFileSync(path.join(pg.secrets, 'database.url'), 'utf8').trim();
  const osAsset = await createFreshOsAsset(hostAddress);
  fs.mkdirSync(plan.installation, { recursive: true, mode: 0o700 });
  writeInstallationDocuments(osAsset, { root: plan.root, installation: plan.installation });
  fs.mkdirSync(spokes, { mode: 0o700 });
  const internalAddress = new URL(hostAddress); internalAddress.hostname = 'postgres'; internalAddress.port = '5432';
  write(plan.secrets, { ...read(plan.secrets), DATABASE_URL: internalAddress.href });
  fs.mkdirSync(path.join(state, '.wrangler'), { recursive: true, mode: 0o700 });
  const store = openStore(hostAddress, { maxConnections: 1 });
  try {
    const workspace = await store.onlyWorkspace();
    // Prepared fixture settings, never the checkout's installation documents.
    await store.inWorkspace(workspace, async tx => {
      for (const file of CONFIG_DOCUMENT_FILES) {
        const exported = path.join(plan.installation, path.basename(file));
        const body = read(fs.existsSync(exported) ? exported : path.join(plan.root, file));
        if (file === 'config/constants.json') {
          body.schedules = Object.fromEntries(SCHEDULED_JOBS.map(job => [job.id, {
            enabled: ['asset-zero', 'beads-snapshot', 'beads-hub'].includes(job.id),
            cron: job.id === 'asset-zero' ? '* * * * *' : job.cron,
          }]));
        }
        await tx.execute('INSERT INTO noticeos.config_documents (workspace_id,document_key,body,version,updated_at,updated_by) VALUES ($1,$2,$3::json,1,now(),$4)', [workspace, configDocumentKey(file), JSON.stringify(body), 'synthetic-container-preparation']);
      }
    });
    await store.close();
    // The standalone proof isolates its network. The customer proof uses the
    // real bridge and published loopback address with providers disabled.
    const config = await runCommand('docker', ['compose', '-p', pg.project, '-f', pg.compose, '--env-file', os.devNull, 'config', '--format', 'json'], { cwd: ROOT, env: databaseEnv });
    assert.equal(config.code, 0);
    const definition = JSON.parse(config.stdout);
    write(isolatedDatabases, { name: pg.project, services: definition.services, volumes: definition.volumes ?? {}, secrets: definition.secrets ?? {},
      networks: { default: { name: `${pg.project}_default`, internal: !customer } } });
    assert.equal((await databases(['down'])).code, 0);
    const isolated = await databases(['up', '--detach', '--wait', '--wait-timeout', '90', 'postgres'], true);
    if (isolated.code !== 0) assert.fail(isolated.stderr);
    const network = await runCommand('docker', ['network', 'inspect', `${pg.project}_default`, '--format', '{{.Internal}}'], { env });
    assert.equal(network.code, 0); assert.equal(network.stdout.trim(), String(!customer));
    const secretsHeld = `${plan.secrets}.held`;
    fs.renameSync(plan.secrets, secretsHeld);
    try {
      const refusal = await cleanup.oneOff(compose);
      assert.equal(refusal.code, 1); assert.match(refusal.stderr, /container refused/);
    } finally { fs.renameSync(secretsHeld, plan.secrets); }
    const ownerSql = sql => databases(['exec', '-T', '--user', 'postgres', 'postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--host=/var/run/postgresql', '--username=postgres', '--dbname=noticeos', '--command', sql]);
    assert.equal((await ownerSql('UPDATE noticeos_migrations.applied SET version = 999999 WHERE version = 1')).code, 0);
    try {
      const refusal = await cleanup.oneOff(compose);
      assert.notEqual(refusal.code, 0); assert.match(refusal.stdout, /REFUSING to start/);
      const preserved = await ownerSql('SELECT version FROM noticeos_migrations.applied WHERE version = 999999');
      assert.equal(preserved.code, 0); assert.ok(preserved.stdout.includes('999999'), 'startup never repairs or applies schema');
    } finally { assert.equal((await ownerSql('UPDATE noticeos_migrations.applied SET version = 1 WHERE version = 999999')).code, 0); }
    const start = await compose(['up', '--detach', '--wait', '--wait-timeout', '180', 'noticeos']);
    if (start.code !== 0) {
      const logs = await compose(['logs', '--no-color', '--tail', '120', 'noticeos']);
      const privateValues = [internalAddress.password, ...Object.values(read(plan.secrets)).filter(value => typeof value === 'string')];
      let safe = `${start.stderr}\n${logs.stdout}\n${logs.stderr}`;
      for (const value of privateValues) if (value) safe = safe.replaceAll(value, '[redacted]');
      assert.fail(safe);
    }
    // The isolated network also suppresses host routing on some Docker hosts.
    // Exercise the actual API through loopback inside this exact app service.
    const request = async (route, method = 'GET', body) => {
      const result = await compose(['exec', '-T', 'noticeos', 'node', '--input-type=module', '-e',
        'const response=await fetch("http://127.0.0.1:5173/"+process.argv[1],{method:process.argv[2],headers:{"content-type":"application/json",origin:"http://127.0.0.1:5173"},...(process.argv[3]?{body:process.argv[3]}:{}),signal:AbortSignal.timeout(20000)});console.log(JSON.stringify({status:response.status,body:await response.json()}));',
        route, method, ...(body === undefined ? [] : [JSON.stringify(body)])]);
      assert.equal(result.code, 0, 'the owned app API request completed'); return JSON.parse(result.stdout);
    };
    const get = async route => { const response = await request(route); assert.equal(response.status, 200); return response.body; };
    const action = (route, body) => request(route, 'POST', body);
    const query = async sql => {
      const result = await compose(['exec', '-T', 'noticeos', 'node', '--input-type=module', '-e',
        'import fs from "node:fs";import {openStore} from "./packages/postgres/src/store.mjs";const db=openStore(JSON.parse(fs.readFileSync("/state/workers/ingest/.dev.secrets.json","utf8")).DATABASE_URL);try{const workspace=await db.onlyWorkspace();console.log(JSON.stringify(await db.inWorkspace(workspace,tx=>tx.query(process.argv[1]),{readOnly:true})));}finally{await db.close();}', sql]);
      assert.equal(result.code, 0, 'the owned store read completed'); return JSON.parse(result.stdout);
    };
    const containerId = await compose(['ps', '--quiet', 'noticeos']); assert.equal(containerId.code, 0);
    const bindings = await runCommand('docker', ['inspect', containerId.stdout.trim(), '--format', '{{json .HostConfig.PortBindings}}'], { env });
    assert.deepEqual(JSON.parse(bindings.stdout), { '5173/tcp': [{ HostIp: '127.0.0.1', HostPort: String(plan.port) }] });
    const resources = await runCommand('docker', ['inspect', containerId.stdout.trim(), '--format', '{{json .Mounts}}|{{.HostConfig.ReadonlyRootfs}}'], { env });
    const [mounts, readonly] = resources.stdout.trim().split('|');
    assert.equal(readonly, 'true'); assert.ok(JSON.parse(mounts).every(row => !row.Source.endsWith('docker.sock') && !row.Destination.endsWith('docker.sock')));
    assert.equal((await get('api/health')).ok, true);
    // No task service is connected: the task routes say so, and the snapshot lane files nothing.
    assert.deepEqual(await get('api/tasks/service'), { connected: false, origin: null, projects: null, required: true });
    const board = await request(`api/tasks?project=${osAsset}`);
    assert.equal(board.status, 409); assert.equal(board.body.error, 'task_service_not_connected');
    const created = await action('api/tasks', { project: osAsset, title: 'Synthetic container task', type: 'task', priority: 2 });
    assert.equal(created.status, 409);
    const recordsFile = path.join(state, '.local/logs/job-runs.jsonl');
    await until(() => fs.existsSync(recordsFile) && fs.readFileSync(recordsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(row => row.job === 'beads-snapshot' && row.outcome === 'skipped'));
    assert.equal((await query("SELECT job FROM noticeos.job_runs WHERE job = 'beads-snapshot' AND outcome = 'ran'")).length, 0);
    await until(async () => (await query("SELECT job FROM noticeos.job_runs WHERE job = 'cron 0 3 * * *' AND outcome = 'ran'")).length > 0);
    const scheduling = await compose(['logs', '--no-color', '--tail', '200', 'noticeos']);
    assert.match(scheduling.stdout, /cron "0 3 \* \* \*" fired → HTTP 200/u);
    assert.doesNotMatch(scheduling.stdout, /STANDING DOWN/u, 'the scheduler owns its ingest runtime');
    const before = fs.readFileSync(recordsFile, 'utf8');
    assert.equal((await compose(['stop', 'noticeos'])).code, 0);
    // Stopping the application leaves the independently owned Postgres available.
    const running = await databases(['ps', '--status', 'running', '--quiet', 'postgres']);
    assert.equal(running.code, 0); assert.ok(running.stdout.trim());
    assert.equal((await compose(['up', '--detach', '--wait', '--wait-timeout', '180', 'noticeos'])).code, 0);
    assert.equal((await get('api/health')).ok, true);
    assert.ok(fs.readFileSync(recordsFile, 'utf8').startsWith(before), 'scheduled-lane evidence survives an app restart');
    const settings = await query('SELECT document_key FROM noticeos.config_documents');
    assert.equal(settings.length, CONFIG_DOCUMENT_FILES.length);
    if (customer) await t.test('customer mode uses the same app, database and ingress and can return to standalone', async () => {
      const identity = randomBytes(32).toString('base64url'), grant = randomBytes(32).toString('base64url');
      const user = randomUUID(), serviceId = randomUUID(), email = 'fixture-owner@example.test';
      const prepared = await ownerSql(`ALTER ROLE noticeos_identity LOGIN PASSWORD '${identity}';
        ALTER ROLE noticeos_service_grant LOGIN PASSWORD '${grant}';
        GRANT CONNECT ON DATABASE noticeos TO noticeos_identity, noticeos_service_grant;
        INSERT INTO noticeos_identity.auth_organization(id,name,slug,created_at) VALUES ('${workspace}','Fixture','container-fixture',now()) ON CONFLICT (id) DO NOTHING;
        INSERT INTO noticeos_identity.auth_user(id,email,name,email_verified) VALUES ('${user}','${email}','Fixture owner',true);
        INSERT INTO noticeos_identity.auth_member(organization_id,user_id,role,created_at) VALUES ('${workspace}','${user}','owner',now());
        INSERT INTO noticeos_platform.workspace_service_grants(service_id,workspace_id,actions,expires_at)
          VALUES ('${serviceId}','${workspace}',ARRAY['workflows.run'],now()+interval '1 hour');`);
      assert.equal(prepared.code, 0, 'prepare only this disposable identity and schedule grant');
      const address = (role, password) => {
        const url = new URL(internalAddress);
        url.username = role; url.password = password;
        return url.href;
      };
      const lanOrigin = `http://fixture-tower.local:${plan.port}`;
      write(path.join(plan.installation, 'customer-runtime.json'), { format: 'noticeos-compose-customer/1',
        ...(customerLan ? { towerOrigin: lanOrigin, siteReports: true } : {}),
        database: { identity: address('noticeos_identity', identity), grant: address('noticeos_service_grant', grant) },
        identitySecret: randomBytes(48).toString('base64url'), mailRecipients: [email], workspaces: [{ workspaceId: workspace, serviceId }] });
      let source, selectorFile, currentContainer = containerId.stdout.trim();
      if (customerDevelopment) {
        source = path.join(fs.realpathSync(base), 'mounted-checkout');
        const inventory = await runCommand('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, env: toolEnv });
        assert.equal(inventory.code, 0);
        const files = inventory.stdout.split('\0').filter(file => file && !file.startsWith('config/'));
        prepareContainerContext({ root: ROOT, destination: source, files });
        fs.cpSync(path.join(plan.root, 'config'), path.join(source, 'config'), { recursive: true });
        for (const relative of DEPENDENCY_PATHS) fs.mkdirSync(path.join(source, relative));
        const envFile = path.join(base, 'development.env');
        fs.writeFileSync(envFile, Object.entries(appEnv).filter(([key]) => key.startsWith('NOTICEOS_') || key === 'TOWER_ALLOWED_HOSTS')
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
        selectorFile = path.join(base, 'stack.json');
        write(selectorFile, { dockerHost: endpoint, project: pg.project, files: [appFile, isolatedDatabases], envFile });
        const image = process.env.NOTICEOS_TEST_DEVELOPMENT_IMAGE;
        assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/u, 'select the prepared local proof image');
        const developed = await developStack({ root: source, selectorFile, image, env, run, out: { write() {} } });
        assert.equal(developed.mode, 'development');
        assert.equal(developed.image, image);
        developmentOverride = sourceOverride;
        currentContainer = (await compose(['ps', '--quiet', 'noticeos'])).stdout.trim();
        assert.notEqual(currentContainer, containerId.stdout.trim());
      }
      const preflight = await compose(['exec', '-T', 'noticeos', 'node', 'deploy/compose/entrypoint.mjs', 'customer-check']);
      assert.equal(preflight.code, 0, preflight.stderr);
      const db = async () => (await databases(['ps', '--status', 'running', '--quiet', 'postgres'])).stdout.trim();
      const dbId = await db();
      assert.match(dbId, /^[a-f0-9]{12,64}$/u);
      const marker = path.join(plan.installation, 'customer-runtime.enabled');
      fs.writeFileSync(marker, 'noticeos-compose-customer/1\n', { mode: 0o600, flag: 'wx' });
      const restart = async () => {
        assert.equal((await compose(['stop', 'noticeos'])).code, 0);
        const start = await compose(['start', '--wait', '--wait-timeout', '180', 'noticeos']);
        assert.equal(start.code, 0, start.stderr);
        assert.equal(await db(), dbId);
        assert.equal((await compose(['ps', '--quiet', 'noticeos'])).stdout.trim(), currentContainer);
      };
      await restart();
      if (customerLan) {
        const { useLanTower } = await import('./test-fixtures/customer-lan-browser.mjs');
        await useLanTower({ origin: lanOrigin, state, email, ...(source ? { liveEdit: async page => {
          const template = path.join(source, 'apps/tower/index.html');
          const api = path.join(source, 'apps/tower/shared/app-release.ts');
          const initial = await page.evaluate(() => fetch('/api/app-release').then(r => r.json()));
          assert.match(initial.release, /^[a-f0-9]{64}$/u);
          const client = fs.readFileSync(template, 'utf8');
          const worker = fs.readFileSync(api, 'utf8');
          assert.match(client, /<title>[^<]*<\/title>/u);
          assert.ok(worker.includes('Response.json({ release })'));
          // A failed compile leaves the current version and its session live.
          fs.writeFileSync(api, '{');
          await until(async () => (await compose(['logs', '--tail', '50', 'noticeos'])).stdout.includes('The previous app is still serving.'));
          assert.deepEqual(await page.evaluate(() => fetch('/api/app-release').then(r => r.json())), initial);
          fs.writeFileSync(template, client.replace(/<title>[^<]*<\/title>/u, '<title>Checkout edit fixture</title>'));
          fs.writeFileSync(path.join(source, 'scripts/checkout-release.ts'), "export const fixture = 'checkout-worker';\n");
          fs.writeFileSync(api, "import { fixture } from '../../../scripts/checkout-release';\n"
            + worker.replace('Response.json({ release })', 'Response.json({ release, fixture })'));
          await page.locator('[data-app-update]').waitFor({ timeout: 90_000 });
          const updated = await page.evaluate(() => fetch('/api/app-release').then(r => r.json()));
          assert.equal(updated.fixture, 'checkout-worker');
          assert.notEqual(updated.release, initial.release);
          await page.reload();
          assert.equal(await page.title(), 'Checkout edit fixture');
          await page.locator('[data-home-brief], [data-first-run]').waitFor();
          assert.equal((await compose(['ps', '--quiet', 'noticeos'])).stdout.trim(), currentContainer);
          assert.equal(await db(), dbId);
          const lease = await ownerSql("SELECT count(*) FROM pg_stat_activity WHERE application_name='noticeos-local-customer-scheduler'");
          assert.equal(lease.code, 0, lease.stderr);
          assert.match(lease.stdout, /^\s*1\s*$/mu);
          assert.equal(fs.existsSync(path.join(source, 'customer-artifacts')), false);
          assert.equal(fs.existsSync(path.join(source, 'apps/tower/dist')), false);
        } } : {}) });
      } else {
        const origin = `http://127.0.0.1:${plan.port}`;
        const post = (route, body, headers) => fetch(origin + route, { method: 'POST', signal: AbortSignal.timeout(10_000),
          headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
        assert.equal((await fetch(origin + '/api/assets/' + osAsset)).status, 403);
        assert.equal((await post(EMAIL_CODE_PATHS.request, { email })).status, 202);
        const outbox = path.join(state, '.local/compose-customer/customer/mail');
        const message = fs.readdirSync(outbox).map(file => read(path.join(outbox, file))).find(item => item.to === email);
        const otp = message?.text.match(/\b([0-9]{6})\.$/u)?.[1];
        assert.ok(otp, 'the fixture mailbox receives the ordinary code');
        const verified = await post(EMAIL_CODE_PATHS.verify, { email, otp });
        assert.equal(verified.status, 200);
        const cookie = verified.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        const session = await (await fetch(origin + '/api/session', { headers: { cookie } })).json();
        const headers = { cookie, [WORKSPACE_SELECTION_HEADER]: workspace, [WORKSPACE_SESSION_HEADER]: session.session.sessionId };
        const mcp = await post('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers);
        assert.equal(mcp.status, 200);
        assert.ok((await mcp.json()).result.tools.some(tool => tool.name === 'property_report'));
      }
      if (googleSetup) {
        assert.ok(customerLan, 'the Google setup proof starts with the customer LAN profile');
        if (!selectorFile) {
          const envFile = path.join(base, 'customer-lan-fixture.env');
          fs.writeFileSync(envFile, Object.entries(appEnv).filter(([key]) => key.startsWith('NOTICEOS_') || key === 'TOWER_ALLOWED_HOSTS')
            .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600 });
          selectorFile = path.join(base, 'stack.json');
          write(selectorFile, { dockerHost: endpoint, project: pg.project, files: [appFile, isolatedDatabases], envFile });
        }
        const settingsFile = read(selectorFile).envFile;
        const savedSettings = fs.readFileSync(settingsFile);
        const control = verb => runCommand(process.execPath, [path.join(ROOT, 'scripts/stack-control.mjs'),
          'customer-google-setup', verb, '--config', selectorFile], { cwd: ROOT, env: toolEnv, timeoutMs: 150_000 });
        const status = host => new Promise((resolve, reject) => {
          getHttp({ hostname: '127.0.0.1', port: plan.port, path: '/api/session', headers: { host },
            signal: AbortSignal.timeout(10_000) }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
        });
        const loopback = `127.0.0.1:${plan.port}`, lanHost = new URL(lanOrigin).host;
        assert.equal(await status(lanHost), 200);
        assert.equal(await status(loopback), 400);
        const opened = await control('open');
        assert.equal(opened.code, 0, opened.stderr);
        assert.ok(opened.stdout.includes(`http://${loopback}/integrations`));
        const openedId = (await compose(['ps', '--quiet', 'noticeos'])).stdout.trim();
        assert.notEqual(openedId, currentContainer);
        assert.equal(await db(), dbId);
        assert.equal((await compose(['port', 'noticeos', '5173'])).stdout.trim(), loopback);
        assert.equal(await status(loopback), 200);
        assert.equal(await status(lanHost), 400);
        const closed = await control('close');
        assert.equal(closed.code, 0, closed.stderr);
        currentContainer = (await compose(['ps', '--quiet', 'noticeos'])).stdout.trim();
        assert.notEqual(currentContainer, openedId);
        assert.equal(await db(), dbId);
        assert.equal(await status(lanHost), 200);
        assert.equal(await status(loopback), 400);
        assert.deepEqual(fs.readFileSync(settingsFile), savedSettings);
        assert.match((await ownerSql("SELECT count(*) FROM pg_stat_activity WHERE application_name='noticeos-local-customer-scheduler'")).stdout, /^\s*1\s*$/mu);
      }
      fs.unlinkSync(marker);
      await restart();
      assert.equal((await get('api/health')).ok, true);
      assert.equal((await query('SELECT document_key FROM noticeos.config_documents')).length, settings.length);
      if (source) {
        const options = { root: source, selectorFile, disable: true, env, run, out: { write() {} } };
        assert.equal((await ownerSql("INSERT INTO noticeos_migrations.applied(version,name,sha256) VALUES(9999,'9999_fixture',repeat('a',64))")).code, 0);
        try {
          await assert.rejects(developStack(options), /database migrations differ/u);
          assert.equal((await compose(['ps', '--quiet', 'noticeos'])).stdout.trim(), currentContainer);
          assert.equal((await get('api/health')).ok, true);
        } finally {
          assert.equal((await ownerSql("DELETE FROM noticeos_migrations.applied WHERE version=9999 AND name='9999_fixture'")).code, 0);
        }
        const release = process.env.NOTICEOS_TEST_PREPARED_CHECKOUT;
        const restored = await developStack(release ? { ...options, root: release, image: process.env.NOTICEOS_TEST_DEVELOPMENT_IMAGE } : options);
        if (release) assert.equal(restored.image, process.env.NOTICEOS_TEST_DEVELOPMENT_IMAGE);
        assert.equal(restored.mode, 'prepared');
        developmentOverride = undefined;
        assert.equal(await db(), dbId);
        assert.equal((await get('api/health')).ok, true);
      }
    });
  } finally { await store.close(); }
});
