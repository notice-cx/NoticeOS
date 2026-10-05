// Opt-in proof. Every resource is new, local, and belongs to this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startPlan, prepareFolder } from './start.mjs';
import { prepareFreshPostgres, startPostgresPlan, databaseEmpty } from './start-postgres.mjs';
import { preflightStartedTasks, prepareStartedTasks } from './start-dolt.mjs';
import { startDoltPlan, doltEnvironment } from './dolt-host.mjs';
import { localDockerEndpoint } from './postgres-compose.mjs';
import { runCommand } from './run-command.mjs';
import { containerProofCleanup } from './container-proof-cleanup.mjs';
import { openStore } from '../packages/postgres/src/store.mjs';
import { CONFIG_DOCUMENT_FILES, configDocumentKey } from './config-documents.mjs';
import { SCHEDULED_JOBS } from './scheduled-jobs.mjs';
import { INITIAL_DOCUMENTS } from '../apps/tower/e2e/fixtures.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const enabled = process.env.NOTICEOS_TEST_CONTAINER === '1';
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
    ...['compose.yaml', 'server.yaml', 'start.sh', 'sql.sh', 'capture.sh', 'backup-metadata.sh', 'restore.sh', 'restore-native.sh'].map(name => `db/dolt/host/${name}`),
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

test('the prepared application container serves tasks and schedules, preserving state across its own restart', { skip: !enabled, timeout: 480_000 }, async t => {
  const image = process.env.NOTICEOS_TEST_APP_IMAGE;
  assert.match(image ?? '', /^noticeos-local:ro-ujb9-9-2-[a-z0-9]+$/u, 'use the explicitly built local proof image');
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
  const pg = startPostgresPlan(plan);
  const dolt = startDoltPlan(plan);
  const toolEnv = Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'TMPDIR', 'LANG'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const endpoint = await localDockerEndpoint(runCommand, { cwd: ROOT, env: toolEnv });
  assert.ok(endpoint, 'prove a local Docker endpoint before any resource request');
  const env = { ...toolEnv, DOCKER_HOST: endpoint, ...(process.env.BEADS_BD_BIN ? { BEADS_BD_BIN: process.env.BEADS_BD_BIN } : {}) };
  const tasks = await preflightStartedTasks(plan, { env, binary: process.env.BEADS_BD_BIN });
  assert.equal(tasks.ok, true, tasks.line);
  assert.equal(tasks.fresh, true);
  const appFile = path.join(ROOT, 'deploy/compose/compose.yaml');
  const isolatedDatabases = path.join(base, 'databases.json');
  const databaseEnv = { ...env, ...doltEnvironment(dolt, env), NOTICEOS_POSTGRES_SECRETS: pg.secrets, NOTICEOS_POSTGRES_PORT: String(pg.port) };
  const databases = (args) => runCommand('docker', ['compose', '-p', pg.project,
    ...(fs.existsSync(isolatedDatabases) ? ['-f', isolatedDatabases] : ['-f', pg.compose, '-f', dolt.composeFile]),
    '--env-file', os.devNull, ...args], { cwd: ROOT, env: databaseEnv, timeoutMs: 120_000 });
  const appEnv = { ...env, NOTICEOS_APP_IMAGE: image, NOTICEOS_STATE_DIR: state, NOTICEOS_SPOKES_DIR: spokes,
    NOTICEOS_NETWORK: `${pg.project}_default`, NOTICEOS_TOWER_PORT: String(plan.port),
    NOTICEOS_APP_UID: String(process.getuid()), NOTICEOS_APP_GID: String(process.getgid()) };
  const compose = args => runCommand('docker', ['compose', '-p', pg.project, '-f', appFile, '--env-file', os.devNull, ...args], { cwd: ROOT, env: appEnv, timeoutMs: 240_000 });
  const run = (command, args, options) => {
    return runCommand(command, args, options).then(result => {
      if (result.code !== 0 && command === 'docker' && !args.includes('inspect')) t.diagnostic(`owned Compose command failed: ${result.stderr.slice(-1500)}`);
      return result;
    });
  };
  // The preflight proved the task service absent. PG preparation proves its
  // own absence before creating it; cleanup is confined to these exact names.
  const cleanup = containerProofCleanup({ base, project: pg.project, image,
    mounts: [{ source: state, destination: '/state' }, { source: spokes, destination: '/spokes' }],
    runDocker: (args, options) => runCommand('docker', args, { cwd: ROOT, env, ...options }) });
  await cleanup.proveFresh();
  cleanupServices = () => cleanup.finish([() => compose(['down']), () => databases(['down', '--volumes'])]);
  const prepared = await prepareFreshPostgres(plan, { env, run, requireTasks: true, empty(own) {
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
  const corePrepared = await prepareStartedTasks(plan, tasks, { fresh: true, address: hostAddress, env, run });
  assert.equal(corePrepared.ok, true, corePrepared.line);
  const core = read(path.join(state, 'dolt/core.json'));
  fs.mkdirSync(spokes, { mode: 0o700 });
  fs.renameSync(core.repo, path.join(spokes, 'core'));
  const metaFile = path.join(spokes, 'core/.beads/metadata.json');
  write(metaFile, { ...read(metaFile), dolt_server_host: 'dolt', dolt_server_port: 3306 });
  write(path.join(plan.installation, 'task-host.json'), { version: 1, repositories: [{ asset: core.asset, prefix: core.prefix, database: core.database, repo: '/spokes/core' }] });
  const configFile = path.join(plan.installation, 'beads.json');
  write(configFile, { ...read(configFile), hub: { host: 'dolt', port: 3306, user: 'noticeos', dataDir: '/state/dolt' } });
  fs.unlinkSync(path.join(state, 'dolt/profile.json'));
  write(path.join(state, 'task-client.json'), { host: 'dolt', port: 3306, user: 'noticeos', credentialsFile: '/state/dolt/credentials', clientHome: '/state/dolt/client-home' });
  const password = fs.readFileSync(path.join(dolt.secretsDir, 'noticeos'), 'utf8').trim();
  fs.writeFileSync(dolt.credentialsFile, `[dolt:3306]\npassword=${password}\n`, { mode: 0o600 });
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
    // Preparation needs the disposable loopback ports. Before starting the
    // app, recreate only its owned network with external routing disabled;
    // the prepared database volumes remain untouched.
    // Resolve each original file separately: Compose otherwise rebases Dolt's
    // relative bind sources onto the first (Postgres) file's directory.
    const definitions = [];
    for (const file of [pg.compose, dolt.composeFile]) {
      const config = await runCommand('docker', ['compose', '-p', pg.project, '-f', file, '--env-file', os.devNull, 'config', '--format', 'json'], { cwd: ROOT, env: databaseEnv });
      assert.equal(config.code, 0); definitions.push(JSON.parse(config.stdout));
    }
    const combined = { name: pg.project, services: {}, volumes: {}, secrets: {}, networks: { default: { name: `${pg.project}_default`, internal: true } } };
    for (const definition of definitions) for (const key of ['services', 'volumes', 'secrets']) Object.assign(combined[key], definition[key]);
    write(isolatedDatabases, combined);
    assert.equal((await databases(['down'])).code, 0);
    const isolated = await databases(['up', '--detach', '--wait', '--wait-timeout', '90', 'postgres', 'dolt'], true);
    if (isolated.code !== 0) {
      const logs = await databases(['logs', '--no-color', '--tail', '50', 'dolt'], true);
      let safe = `${isolated.stderr}\n${logs.stdout}\n${logs.stderr}`;
      for (const name of ['root', 'noticeos']) safe = safe.replaceAll(fs.readFileSync(path.join(dolt.secretsDir, name), 'utf8').trim(), '[redacted]');
      assert.fail(safe);
    }
    const network = await runCommand('docker', ['network', 'inspect', `${pg.project}_default`, '--format', '{{.Internal}}'], { env });
    assert.equal(network.code, 0); assert.equal(network.stdout.trim(), 'true');
    const secretsHeld = `${plan.secrets}.held`;
    fs.renameSync(plan.secrets, secretsHeld);
    try {
      const refusal = await cleanup.oneOff(compose);
      assert.equal(refusal.code, 1); assert.match(refusal.stderr, /container refused/);
    } finally { fs.renameSync(secretsHeld, plan.secrets); }
    assert.equal((await databases(['stop', 'dolt'])).code, 0);
    try {
      const refusal = await cleanup.oneOff(compose);
      assert.equal(refusal.code, 1); assert.match(refusal.stderr, /container refused/);
    } finally { assert.equal((await databases(['up', '--detach', '--wait', '--wait-timeout', '90', 'dolt'])).code, 0); }
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
      const privateValues = [password, internalAddress.password, ...Object.values(read(plan.secrets)).filter(value => typeof value === 'string')];
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
    assert.equal((await get('api/tasks/capabilities')).live, true);
    const created = await action('api/tasks', { project: core.asset, title: 'Synthetic container task', type: 'task', priority: 2 });
    assert.equal(created.status, 201);
    assert.match(created.body.id, /^no-/u);
    assert.equal((await get(`api/tasks/${created.body.id}`)).task.title, 'Synthetic container task');
    assert.equal((await action(`api/tasks/${created.body.id}/close`, { reason: 'Synthetic container completion' })).status, 200);
    assert.equal((await get(`api/tasks/${created.body.id}`)).task.status, 'closed');
    await until(async () => (await get('api/task-source')).connected === 'beads');
    const recordsFile = path.join(state, '.local/logs/job-runs.jsonl');
    await until(() => fs.existsSync(recordsFile) && fs.readFileSync(recordsFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(row => row.job === 'beads-snapshot' && row.outcome === 'ran'));
    await until(async () => (await query("SELECT job FROM noticeos.job_runs WHERE job = 'beads-snapshot' AND outcome = 'ran'")).length > 0);
    await until(async () => (await query("SELECT job FROM noticeos.job_runs WHERE job = 'cron 0 3 * * *' AND outcome = 'ran'")).length > 0);
    const scheduling = await compose(['logs', '--no-color', '--tail', '200', 'noticeos']);
    assert.match(scheduling.stdout, /cron "0 3 \* \* \*" fired → HTTP 200/u);
    assert.doesNotMatch(scheduling.stdout, /STANDING DOWN/u, 'the scheduler owns its ingest runtime');
    const before = fs.readFileSync(recordsFile, 'utf8');
    assert.equal((await compose(['stop', 'noticeos'])).code, 0);
    // Stopping the application leaves the independently owned Dolt available.
    const running = await runCommand('docker', ['compose', '-p', pg.project, '-f', dolt.composeFile, '--env-file', os.devNull, 'ps', '--status', 'running', '--quiet', 'dolt'], { cwd: ROOT, env: { ...env, ...doltEnvironment(dolt, env) } });
    assert.equal(running.code, 0); assert.ok(running.stdout.trim());
    assert.equal((await compose(['up', '--detach', '--wait', '--wait-timeout', '180', 'noticeos'])).code, 0);
    assert.equal((await get(`api/tasks/${created.body.id}`)).task.status, 'closed');
    assert.ok(fs.readFileSync(recordsFile, 'utf8').startsWith(before), 'scheduled-lane evidence survives an app restart');
    const settings = await query('SELECT document_key FROM noticeos.config_documents');
    assert.equal(settings.length, CONFIG_DOCUMENT_FILES.length);
  } finally { await store.close(); }
});
