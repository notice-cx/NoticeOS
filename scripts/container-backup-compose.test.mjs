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
import { openStore } from '../packages/postgres/src/store.mjs';
import { CONFIG_DOCUMENT_FILES, configDocumentKey } from './config-documents.mjs';
import { SCHEDULED_JOBS } from './scheduled-jobs.mjs';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { restoreDolt } from './dolt-backup.mjs';
import { FILES as PG_SECRET_FILES, VERIFIERS } from './postgres-secrets.mjs';
import { INITIAL_DOCUMENTS } from '../apps/tower/e2e/fixtures.ts';
import { heldHistory, heldRows } from './test-fixtures/analytical-history.mjs';
import { verifyAnalyticalHistoryBackup } from './analytical-history-backup.mjs';
import { readCurrentGeneration } from './history-files.mjs';
import { containerProofCleanup } from './container-proof-cleanup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const enabled = process.env.NOTICEOS_TEST_CONTAINER_BACKUP === '1';
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
  for (let port = 5900; port <= 5944; port += 4) {
    const servers = await Promise.all([0, 1, 2, 3].map(offset => new Promise(resolve => {
      const server = net.createServer(); server.once('error', () => resolve(null));
      server.listen(port + offset, '127.0.0.1', () => resolve(server));
    })));
    await Promise.all(servers.filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
    if (servers.every(Boolean)) return port;
  }
  throw new Error('The disposable backup proof needs a free block in 5900–5949.');
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

test('the fixed backup worker publishes private complete sets and restores every store into new own resources', { skip: !enabled, timeout: 720_000 }, async t => {
  const image = process.env.NOTICEOS_TEST_APP_IMAGE;
  assert.match(image ?? '', /^noticeos-local:ro-ujb9-9-4-[a-z0-9]+$/u, 'use the explicitly built local proof image');
  assert.ok(typeof process.getuid === 'function' && process.getuid() > 0, 'Use a nonroot operator for the real permission and restore proof');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-container-backup-proof-'));
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
  const cleanupBase = path.join(base, 'source-cleanup'); fs.mkdirSync(cleanupBase, { mode: 0o700 });
  const sourceCleanup = containerProofCleanup({ base: cleanupBase, project: pg.project, image, mounts: [],
    runDocker: (args, options) => runCommand('docker', args, { env, ...options }) });
  await sourceCleanup.proveFresh();
  const tasks = await preflightStartedTasks(plan, { env, binary: process.env.BEADS_BD_BIN });
  assert.equal(tasks.ok, true, tasks.line);
  assert.equal(tasks.fresh, true);
  const appFile = path.join(ROOT, 'deploy/compose/compose.yaml');
  const backupFile = path.join(ROOT, 'deploy/compose/backup.compose.yaml');
  const privateDirs = Object.fromEntries(['worker-profile', 'transport', 'staging', 'assets', 'offsite'].map(name => [name, path.join(base, name)]));
  for (const directory of Object.values(privateDirs)) fs.mkdirSync(directory, { mode: 0o700 });
  const isolatedDatabases = path.join(base, 'databases.json');
  const databaseEnv = { ...env, ...doltEnvironment(dolt, env), NOTICEOS_POSTGRES_SECRETS: pg.secrets, NOTICEOS_POSTGRES_PORT: String(pg.port) };
  const databases = (args) => runCommand('docker', ['compose', '-p', pg.project,
    ...(fs.existsSync(isolatedDatabases) ? ['-f', isolatedDatabases] : ['-f', pg.compose, '-f', dolt.composeFile]),
    '--env-file', os.devNull, ...args], { cwd: ROOT, env: databaseEnv, timeoutMs: 120_000 });
  const appEnv = { ...env, NOTICEOS_APP_IMAGE: image, NOTICEOS_STATE_DIR: state, NOTICEOS_SPOKES_DIR: spokes,
    NOTICEOS_NETWORK: `${pg.project}_default`, NOTICEOS_TOWER_PORT: String(plan.port),
    NOTICEOS_APP_UID: String(process.getuid()), NOTICEOS_APP_GID: String(process.getgid()),
    NOTICEOS_POSTGRES_SECRETS: pg.secrets, NOTICEOS_DOLT_SECRETS: dolt.secretsDir,
    NOTICEOS_DOLT_BACKUP_VOLUME: `${pg.project}_dolt-data`,
    NOTICEOS_BACKUP_PROFILE_DIR: privateDirs['worker-profile'], NOTICEOS_BACKUP_TRANSPORT_DIR: privateDirs.transport,
    NOTICEOS_BACKUP_STAGING_DIR: privateDirs.staging, NOTICEOS_BACKUP_ASSETS_DIR: privateDirs.assets,
    NOTICEOS_BACKUP_OFFSITE_PARENT: privateDirs.offsite };
  const compose = args => runCommand('docker', ['compose', '-p', pg.project, '-f', isolatedDatabases, '-f', appFile, '-f', backupFile, '--env-file', os.devNull, ...args], { cwd: ROOT, env: appEnv, timeoutMs: 240_000 });
  let ownsDatabaseResources = false;
  const run = (command, args, options) => {
    // Fresh preparation requests its first up only after checking the exact
    // project and volume absent. A refusal before that cannot authorize down.
    if (command === 'docker' && args[0] === 'compose' && args[1] === '-p' && args[2] === pg.project
      && args.includes('up') && args.at(-1) === 'postgres') ownsDatabaseResources = true;
    return runCommand(command, args, options).then(result => {
      if (result.code !== 0 && command === 'docker' && !args.includes('inspect')) t.diagnostic(`owned Compose command failed: ${result.stderr.slice(-1500)}`);
      return result;
    });
  };
  // The preflight proved the task service absent. PG preparation proves its
  // own absence before creating it; cleanup is confined to these exact names.
  cleanupServices = async () => {
    if (!ownsDatabaseResources) return;
    await sourceCleanup.finish([
      () => fs.existsSync(isolatedDatabases) ? compose(['down']) : Promise.resolve({ code: 0 }),
      () => databases(['down', '--volumes']),
    ]);
  };
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
            enabled: false,
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
    combined.volumes['pg-backup-socket'] = {};
    combined.services.postgres.volumes.push({ type: 'volume', source: 'pg-backup-socket', target: '/var/run/postgresql' });
    combined.services.dolt.volumes.push({ type: 'bind', source: privateDirs.staging, target: '/backup-staging', bind: { create_host_path: false } });
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
    write(path.join(state, 'backup-client.json'), { format: 'noticeos-backup-client-v1', transportDir: '/backup-transport' });
    write(path.join(privateDirs['worker-profile'], 'profile.json'), { format: 'noticeos-backup-worker-v1', retentionDays: 30 });
    const assetRoot = path.join(privateDirs.assets, 'synthetic'); fs.mkdirSync(assetRoot, { mode: 0o755 });
    const exporter = 'node export.mjs';
    const exportedSql = "CREATE TABLE synthetic_asset (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO synthetic_asset VALUES (1, 'Preserved export');\n";
    fs.writeFileSync(path.join(assetRoot, 'package.json'), JSON.stringify({ scripts: { 'backup:prod': exporter,
      'prebackup:prod': 'node -e "process.exit(77)"', 'postbackup:prod': 'node -e "process.exit(78)"' } }), { mode: 0o644 });
    fs.writeFileSync(path.join(assetRoot, 'export.mjs'), `import fs from 'node:fs';import path from 'node:path';fs.writeFileSync(path.join(process.env.BACKUP_OUTPUT_DIR,'synthetic.sql'),${JSON.stringify(exportedSql)},{mode:0o600});`, { mode: 0o644 });
    const analyticalHistory = await heldHistory(plan.installation);
    write(path.join(privateDirs['worker-profile'], 'host-backup.json'), { offsiteBackupDir: '/backup-offsite/backups', analyticalHistoryDirectory: 'analytical-history',
      assetBackups: [{ asset: 'synthetic', repo: '/backup-assets/synthetic', scriptSha256: createHash('sha256').update(exporter).digest('hex'), args: [] }] });
    const ownerSql = (sql, args = []) => databases(['exec', '-T', '--user', 'postgres', 'postgres', 'psql', '-X', '-q', '-A', '-t',
      '-v', 'ON_ERROR_STOP=1', '--host=/var/run/postgresql', '--username=postgres', '--dbname=noticeos', ...args, '--command', sql]);
    const pgRows = async (sql, execute = ownerSql) => {
      const result = await execute(`SELECT coalesce(json_agg(t),'[]'::json) FROM (${sql}) t;`);
      assert.equal(result.code, 0, 'Only the owned Postgres query completes; diagnostics withheld');
      return JSON.parse(result.stdout.trim());
    };
    const pgFingerprint = async execute => {
      const tables = await pgRows("SELECT format('%I.%I',n.nspname,c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('noticeos','noticeos_ref','noticeos_migrations') AND c.relkind='r' ORDER BY 1", execute);
      const rows = {};
      for (const { name } of tables) rows[name] = (await pgRows(`SELECT count(*) AS rows,md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) AS digest FROM ${name} t`, execute))[0];
      return { rows,
        objects: await pgRows("SELECT n.nspname,c.relname,c.relkind,c.relowner::regrole::text AS owner,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('noticeos','noticeos_ref','noticeos_migrations') ORDER BY 1,2", execute),
        constraints: await pgRows("SELECT n.nspname,c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN ('noticeos','noticeos_ref','noticeos_migrations') ORDER BY 1,2,3", execute),
        policies: await pgRows("SELECT * FROM pg_policies WHERE schemaname='noticeos' ORDER BY tablename,policyname", execute),
        sequences: await pgRows("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='noticeos' ORDER BY 1", execute),
      };
    };
    const sqlDolt = async (query, execute = databases) => {
      const result = await execute(['exec', '-T', 'dolt', '/bin/bash', '/etc/noticeos/sql.sh', 'root', query]);
      assert.equal(result.code, 0, 'Only the owned task SQL completes; diagnostics withheld');
      return JSON.parse(result.stdout.trim().split('\n').at(-1)).rows ?? [];
    };
    // Start the worker before the app. The internal network was already checked.
    const started = await compose(['up', '--detach', '--wait', '--wait-timeout', '180', 'backup', 'noticeos']);
    if (started.code !== 0) {
      const logs = await compose(['logs', '--no-color', '--tail', '80', 'backup', 'noticeos']);
      let safe = `${started.stderr}\n${logs.stdout}\n${logs.stderr}`;
      for (const secret of [password, internalAddress.password, ...Object.values(read(plan.secrets)).filter(v => typeof v === 'string')]) if (secret) safe = safe.replaceAll(secret, '[redacted]');
      assert.fail(safe);
    }
    const request = async (route, method = 'GET', body) => {
      const result = await compose(['exec', '-T', 'noticeos', 'node', '--input-type=module', '-e',
        'const r=await fetch("http://127.0.0.1:5173/"+process.argv[1],{method:process.argv[2],headers:{"content-type":"application/json",origin:"http://127.0.0.1:5173"},...(process.argv[3]?{body:process.argv[3]}:{}),signal:AbortSignal.timeout(20000)});console.log(JSON.stringify({status:r.status,body:await r.json()}));',
        route, method, ...(body === undefined ? [] : [JSON.stringify(body)])]);
      assert.equal(result.code, 0); return JSON.parse(result.stdout);
    };
    const created = await request('api/tasks', 'POST', { project: core.asset, title: 'Restorable synthetic task', type: 'task', priority: 2 });
    assert.equal(created.status, 201);
    assert.equal((await request(`api/tasks/${created.body.id}`)).body.task.title, 'Restorable synthetic task');
    // Synthetic history includes committed, staged and working roots.
    await sqlDolt(`USE ${core.database}; CREATE TABLE backup_notes (id int PRIMARY KEY, body text); INSERT INTO backup_notes VALUES (1,'Committed'); CALL DOLT_ADD('.'); CALL DOLT_COMMIT('-m','Synthetic backup history','--author','Synthetic <synthetic@example.com>'); CALL DOLT_BRANCH('backup-side'); CALL DOLT_TAG('backup-tag'); INSERT INTO backup_notes VALUES (2,'Staged'); CALL DOLT_ADD('backup_notes'); INSERT INTO backup_notes VALUES (3,'Working');`);
    const doltFingerprint = async execute => ({
      roots: await sqlDolt(`USE ${core.database}; SELECT DOLT_HASHOF_DB('HEAD') AS head,DOLT_HASHOF_DB('STAGED') AS staged,DOLT_HASHOF_DB('WORKING') AS working`, execute),
      notes: await sqlDolt(`USE ${core.database}; SELECT * FROM backup_notes ORDER BY id`, execute),
      issues: await sqlDolt(`USE ${core.database}; SELECT id,title,status FROM issues ORDER BY id`, execute),
      history: await sqlDolt(`USE ${core.database}; SELECT commit_hash FROM dolt_log ORDER BY commit_hash`, execute),
      branches: await sqlDolt(`USE ${core.database}; SELECT name,hash FROM dolt_branches ORDER BY name`, execute),
      tags: await sqlDolt(`USE ${core.database}; SELECT tag_name,tag_hash FROM dolt_tags ORDER BY tag_name`, execute),
      accounts: await sqlDolt('SELECT User,Host FROM mysql.user ORDER BY User,Host', execute),
      grants: await sqlDolt('SELECT GRANTEE,PRIVILEGE_TYPE,IS_GRANTABLE FROM information_schema.USER_PRIVILEGES ORDER BY GRANTEE,PRIVILEGE_TYPE', execute),
    });
    // Every baseline table gets synthetic rows in the already prepared workspace.
    const archiveBytes = Buffer.alloc(1024, 'a');
    const archiveHash = createHash('sha256').update(archiveBytes).digest('hex');
    let fixture = fs.readFileSync(path.join(ROOT, 'db/postgres/tests/fixture.sql'), 'utf8');
    fixture = fixture.replace(/INSERT INTO noticeos\.workspaces[^;]+;/u, '')
      .replace(/INSERT INTO noticeos\.assets[^;]+;/u, "INSERT INTO noticeos.assets (workspace_id,asset_id,domain,display_name,status,sense_only,is_os) VALUES (:'ws',:'site',:'site',:'site','live',true,false);")
      .replace(/(INSERT INTO noticeos\.config_documents[^;]+);/u, '$1 ON CONFLICT DO NOTHING;')
      .replace("repeat('a', 64), 1024", `'${archiveHash}',1024`);
    const seedFile = path.join(base, 'seed.sql'); fs.writeFileSync(seedFile, `SET ROLE noticeos_owner;\n${fixture}`);
    assert.equal((await databases(['cp', seedFile, 'postgres:/tmp/backup-fixture.sql'])).code, 0);
    const seed = await databases(['exec', '-T', '--user', 'postgres', 'postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1',
      '-v', `ws=${workspace}`, '-v', 'slug=backup', '-v', 'site=backup.example', '--host=/var/run/postgresql', '--username=postgres', '--dbname=noticeos', '--file=/tmp/backup-fixture.sql']);
    assert.equal(seed.code, 0, seed.stderr);
    const connection = randomUUID(); const plaintext = randomBytes(24).toString('hex'); const iv = randomBytes(12);
    const encryptionKey = Buffer.from(read(plan.secrets).CREDENTIALS_KEY, 'base64');
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ apiKey: plaintext })), cipher.final(), cipher.getAuthTag()]);
    assert.equal((await ownerSql(`INSERT INTO noticeos.integration_connections (workspace_id,connection_id,provider,scope,created_at,updated_at) VALUES ('${workspace}','${connection}','backup-fixture','shared',now(),now()); INSERT INTO noticeos.connection_secrets (workspace_id,connection_id,secret_version,ciphertext,iv,key_version,field_names,created_at) VALUES ('${workspace}','${connection}',1,decode('${ciphertext.toString('hex')}','hex'),decode('${iv.toString('hex')}','hex'),1,'["apiKey"]',now());`)).code, 0);
    const r2 = path.join(state, '.wrangler/state/v3/r2');
    fs.mkdirSync(path.join(r2, 'miniflare-R2BucketObject'), { recursive: true }); fs.mkdirSync(path.join(r2, 'raw-signals/blobs'), { recursive: true });
    const objects = await pgRows('SELECT object_key,object_bytes,content_sha256 FROM noticeos.archive_objects ORDER BY object_key');
    const metadata = new DatabaseSync(path.join(r2, 'miniflare-R2BucketObject/fixture.sqlite'));
    metadata.exec('PRAGMA journal_mode=WAL; CREATE TABLE _mf_objects (key TEXT PRIMARY KEY,blob_id TEXT,size INTEGER,custom_metadata TEXT)');
    for (const object of objects) metadata.prepare('INSERT INTO _mf_objects VALUES (?,?,?,?)').run(object.object_key, archiveHash, archiveBytes.length, JSON.stringify({ contentSha256: archiveHash }));
    fs.writeFileSync(path.join(r2, 'raw-signals/blobs', archiveHash), archiveBytes);
    t.after(() => metadata.close()); // Keep committed WAL data live through capture.
    const beforePG = await pgFingerprint(ownerSql); const beforeDolt = await doltFingerprint(databases);
    assert.ok(Object.values(beforePG.rows).every(row => Number(row.rows) > 0));
    const backup = async () => {
      const result = await compose(['exec', '-T', 'noticeos', 'node', '--input-type=module', '-e',
        'import {requestContainerBackup} from "./scripts/container-backup-channel.mjs";console.log(JSON.stringify(await requestContainerBackup("/state/backup-client.json",{timeoutMs:120000})));']);
      assert.equal(result.code, 0, 'The application contacts only its declared backup worker'); return JSON.parse(result.stdout);
    };
    const first = await backup(); assert.equal(first.ok, true, first.detail);
    const day = new Date().toISOString().slice(0, 10); const set = path.join(state, '.local/backups', day);
    const handoff = path.join(privateDirs.offsite, 'backups', day);
    assert.equal(read(path.join(set, 'backup.json')).complete, true); assert.equal(read(path.join(handoff, 'backup.json')).complete, true);
    const historyCustody = read(path.join(set, 'backup.json')).analyticalHistory;
    assert.equal(historyCustody.complete, true);
    for (const destination of [set, handoff]) {
      assert.deepEqual(await verifyAnalyticalHistoryBackup(path.join(destination, 'history')), historyCustody);
    }
    assert.deepEqual(await pgFingerprint(ownerSql), beforePG, 'Capture never writes to source Postgres');
    assert.deepEqual(await doltFingerprint(databases), beforeDolt, 'Capture preserves source roots and history');
    const readAsOperator = await compose(['exec', '-T', '--user', `${process.getuid()}:${process.getgid()}`, 'backup', 'node', '--input-type=module', '-e',
      'import fs from "node:fs";const walk=p=>{for(const n of fs.readdirSync(p)){const f=p+"/"+n,s=fs.lstatSync(f);if(s.isDirectory())walk(f);else{if(!s.isFile()||s.uid!==process.getuid()||(s.mode&511)!==384)throw Error("private ownership");fs.readFileSync(f);}}};for(const p of process.argv.slice(1))walk(p);console.log("operator reads complete private sets");',
      `/state/.local/backups/${day}`, `/backup-offsite/backups/${day}`]);
    assert.equal(readAsOperator.code, 0, readAsOperator.stderr);
    assert.equal(gunzipSync(fs.readFileSync(path.join(set, 'assets/synthetic/synthetic.sql.gz'))).toString(), exportedSql);
    const copiedMetadata = new DatabaseSync(path.join(set, 'r2/miniflare-R2BucketObject/fixture.sqlite'), { readOnly: true });
    try { assert.equal(copiedMetadata.prepare('SELECT count(*) AS count FROM _mf_objects').get().count, objects.length); assert.equal(copiedMetadata.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); } finally { copiedMetadata.close(); }
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(set, 'r2/raw-signals/blobs', archiveHash))).digest('hex'), archiveHash);
    // New own projects, volumes and credentials; nothing is overwritten.
    const restoredPlan = startPlan({ root: plan.root, dir: path.join(base, 'restored'), port: await freePortBlock() });
    const restoredPG = startPostgresPlan(restoredPlan); const restoredDolt = startDoltPlan(restoredPlan);
    const restoreCleanupBase = path.join(base, 'restore-cleanup'); fs.mkdirSync(restoreCleanupBase, { mode: 0o700 });
    const restoreCleanup = containerProofCleanup({ base: restoreCleanupBase, project: restoredPG.project, image, mounts: [],
      runDocker: (args, options) => runCommand('docker', args, { env, ...options }) });
    await restoreCleanup.proveFresh();
    const restoreEnv = { ...env, NOTICEOS_POSTGRES_SECRETS: restoredPG.secrets, NOTICEOS_POSTGRES_PORT: String(restoredPG.port) };
    const restoreDatabases = args => runCommand('docker', ['compose', '-p', restoredPG.project, '-f', restoredPG.compose, '--env-file', os.devNull, ...args], { cwd: ROOT, env: restoreEnv, timeoutMs: 120_000 });
    const cleanupSource = cleanupServices;
    let ownsRestoredPostgres = false, ownsRestoredDolt = false, restoreUncertain = false;
    cleanupServices = async () => {
      assert.equal(restoreUncertain, false, `An interrupted restore preserves its resources and fixture at ${base}`);
      await restoreCleanup.finish([
        () => ownsRestoredPostgres ? restoreDatabases(['down', '--volumes']) : Promise.resolve({ code: 0 }),
        () => ownsRestoredDolt ? runCommand('docker', ['compose', '-p', restoredDolt.project, '-f', restoredDolt.composeFile, '--env-file', os.devNull, 'down', '--volumes'], { cwd: ROOT, env: { ...env, ...doltEnvironment(restoredDolt, env) }, timeoutMs: 120_000 }) : Promise.resolve({ code: 0 }),
      ]);
      await cleanupSource();
    };
    const freshRestore = await prepareFreshPostgres(restoredPlan, { env, apply: () => true, run: async (command, args, options) => {
      if (args.includes('up')) {
        ownsRestoredPostgres = true;
        for (const name of PG_SECRET_FILES) {
          let contents = fs.readFileSync(path.join(set, 'recovery/postgres', name), 'utf8');
          if (name.endsWith('.url')) { const url = new URL(contents.trim()); url.port = String(restoredPG.port); contents = url.href + '\n'; }
          fs.writeFileSync(path.join(restoredPG.secrets, name), contents); fs.chmodSync(path.join(restoredPG.secrets, name), VERIFIERS.includes(name) ? 0o644 : 0o600);
        }
      }
      return await runCommand(command, args, options);
    } });
    assert.equal(freshRestore.ok, true, freshRestore.line); assert.equal(freshRestore.created, true);
    assert.equal(databaseEmpty(restoredPG), true);
    assert.equal((await restoreDatabases(['cp', path.join(set, 'postgres/noticeos.dump'), 'postgres:/tmp/noticeos.dump'])).code, 0);
    // Docker cp keeps the private file's ownership. Adapt only this new copy
    // to the server's existing nonroot restore identity; source modes stay 600.
    assert.equal((await restoreDatabases(['exec', '-T', '--user', 'root', 'postgres', 'chown', 'postgres:postgres', '--', '/tmp/noticeos.dump'])).code, 0);
    const restore = await restoreDatabases(['exec', '-T', '--user', 'postgres', 'postgres', 'pg_restore', '--host=/var/run/postgresql', '--username=postgres', '--dbname=noticeos', '--no-password', '--exit-on-error', '/tmp/noticeos.dump']);
    assert.equal(restore.code, 0, restore.stderr);
    const restoredSql = sql => restoreDatabases(['exec', '-T', '--user', 'postgres', 'postgres', 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '--host=/var/run/postgresql', '--username=postgres', '--dbname=noticeos', '--command', sql]);
    assert.deepEqual(await pgFingerprint(restoredSql), beforePG, 'All rows, identities, schema, grants, RLS and sequences restore exactly');
    const [sealed] = await pgRows(`SELECT encode(ciphertext,'hex') AS ciphertext,encode(iv,'hex') AS iv FROM noticeos.connection_secrets WHERE connection_id='${connection}'`, restoredSql);
    const recoveredCiphertext = Buffer.from(sealed.ciphertext, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(read(path.join(set, 'recovery/bootstrap.json')).CREDENTIALS_KEY, 'base64'), Buffer.from(sealed.iv, 'hex'));
    decipher.setAuthTag(recoveredCiphertext.subarray(-16));
    const recoveredValue = JSON.parse(Buffer.concat([decipher.update(recoveredCiphertext.subarray(0, -16)), decipher.final()]).toString());
    assert.ok(recoveredValue.apiKey === plaintext, 'Protected recovery key decrypts the exact restored synthetic provider credential');
    const restoredStore = openStore(fs.readFileSync(path.join(restoredPG.secrets, 'database.url'), 'utf8').trim(), { maxConnections: 1 });
    try {
      assert.equal(await restoredStore.onlyWorkspace(), workspace);
      await restoredStore.inWorkspace(workspace, async tx => {
        assert.ok((await tx.query('SELECT asset_id FROM noticeos.assets')).some(row => row.asset_id === 'backup.example'));
        await tx.execute('UPDATE noticeos.assets SET display_name=$1 WHERE asset_id=$2', ['Restored application writes', 'backup.example']);
        assert.equal((await tx.query('SELECT display_name FROM noticeos.assets WHERE asset_id=$1', ['backup.example']))[0].display_name, 'Restored application writes');
      });
    } finally { await restoredStore.close(); }
    restoreUncertain = true;
    await restoreDolt(restoredDolt, path.join(set, 'beads'), { env, run: (command, args, options) => {
      // The restore creates resources only after checking this exact target absent.
      if (command === 'docker' && args[0] === 'compose' && args[1] === '-p' && args[2] === restoredDolt.project
        && args.includes('create') && args.at(-1) === 'dolt') ownsRestoredDolt = true;
      return runCommand(command, args, options);
    } });
    restoreUncertain = false;
    const restoredTaskDb = args => runCommand('docker', ['compose', '-p', restoredDolt.project, '-f', restoredDolt.composeFile, '--env-file', os.devNull, ...args], { cwd: ROOT, env: { ...env, ...doltEnvironment(restoredDolt, env) }, timeoutMs: 120_000 });
    assert.deepEqual(await doltFingerprint(restoredTaskDb), beforeDolt, 'Tasks, staged/working content, history, refs and access restore exactly');
    assert.equal(read(path.join(set, 'recovery/spokes/core/.beads/metadata.json')).dolt_database, core.database);
    assert.ok(read(path.join(set, 'recovery/bootstrap.json')).CREDENTIALS_KEY === read(plan.secrets).CREDENTIALS_KEY, 'Bootstrap custody preserves the same protected key generation');
    const restoredSpoke = path.join(base, 'restored-spokes/core'); fs.mkdirSync(restoredSpoke, { recursive: true, mode: 0o700 });
    fs.cpSync(path.join(set, 'recovery/spokes/core/.beads'), path.join(restoredSpoke, '.beads'), { recursive: true });
    const restoredMeta = path.join(restoredSpoke, '.beads/metadata.json');
    write(restoredMeta, { ...read(restoredMeta), dolt_server_host: '127.0.0.1', dolt_server_port: restoredDolt.port });
    fs.writeFileSync(path.join(restoredSpoke, '.beads.gate.lock'), '', { mode: 0o600, flag: 'wx' });
    const taskShow = await runCommand(process.env.BEADS_BD_BIN, ['-C', restoredSpoke, 'show', created.body.id, '--json'], { cwd: base, env: doltEnvironment(restoredDolt, env) });
    assert.equal(taskShow.code, 0, 'The restored task authority admits the preserved application identity');
    const shown = JSON.parse(taskShow.stdout); assert.equal((Array.isArray(shown) ? shown[0] : shown).title, 'Restorable synthetic task');
    const taskUpdate = await runCommand(process.env.BEADS_BD_BIN, ['-C', restoredSpoke, 'update', created.body.id, '--status', 'in_progress', '--json'], { cwd: base, env: doltEnvironment(restoredDolt, env) });
    assert.equal(taskUpdate.code, 0, 'The restored task authority accepts the preserved task writer');
    const concurrent = backup();
    await until(() => fs.existsSync(path.join(privateDirs.transport, 'request.lock/request.json')));
    const overlap = await backup(); assert.equal(overlap.ok, false); assert.match(overlap.detail, /already in progress/u);
    assert.equal((await concurrent).ok, true, 'Only one overlapping request can run the fixed backup');
    // A failed same-day exporter cannot replace either earlier complete set.
    const preserved = createHash('sha256').update(fs.readFileSync(path.join(set, 'postgres/noticeos.dump'))).digest('hex');
    fs.writeFileSync(path.join(assetRoot, 'export.mjs'), 'process.exit(19);');
    const failed = await backup(); assert.equal(failed.ok, false); assert.match(failed.detail, /Asset databases: failed/u);
    assert.ok(failed.detail.split(/\s+/u).length <= 18);
    assert.doesNotMatch(failed.detail, /\/state|Backup command|exit|SQL/u);
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(set, 'postgres/noticeos.dump'))).digest('hex'), preserved);
    assert.equal(read(path.join(handoff, 'backup.json')).complete, true);
    const foreign = path.join(state, '.local/backups', `.backup-claim-2000000000-${randomUUID()}`);
    fs.mkdirSync(foreign, { mode: 0o700 });
    const namespace = read(path.join(privateDirs.transport, 'worker-health.json')).namespace;
    write(path.join(foreign, 'owner.json'), { format: 'noticeos-backup-claim-v1', namespace: (namespace[0] === 'a' ? 'b' : 'a') + namespace.slice(1), pid: 2000000000 });
    try {
      const blocked = await backup(); assert.equal(blocked.ok, false); assert.match(blocked.detail, /previous backup owner cannot be verified/u);
      assert.equal(fs.existsSync(foreign), true, 'A foreign namespace claim is never reaped');
      assert.equal(createHash('sha256').update(fs.readFileSync(path.join(set, 'postgres/noticeos.dump'))).digest('hex'), preserved);
    } finally { fs.rmSync(foreign, { recursive: true }); }
    assert.equal((await compose(['stop', 'backup'])).code, 0);
    const unavailable = await compose(['exec', '-T', 'noticeos', 'node', 'deploy/compose/health.mjs']);
    assert.equal(unavailable.code, 1); assert.equal(JSON.parse(unavailable.stdout).backup.available, false);
    assert.equal((await compose(['up', '--detach', '--wait', '--wait-timeout', '30', 'backup'])).code, 0);
    assert.equal((await compose(['restart', 'noticeos'])).code, 0);
    await until(async () => (await compose(['exec', '-T', 'noticeos', 'node', 'deploy/compose/health.mjs'])).code === 0);
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(set, 'postgres/noticeos.dump'))).digest('hex'), preserved);
    // Restore held rows without consulting any original analytical directory.
    fs.rmSync(analyticalHistory.output, { recursive: true });
    for (const destination of [set, handoff]) {
      const history = path.join(destination, 'history');
      await verifyAnalyticalHistoryBackup(history, { expected: historyCustody });
      const manifest = await readCurrentGeneration(history);
      assert.deepEqual(await heldRows(history, manifest), analyticalHistory.rows);
      assert.deepEqual(await heldRows(history, manifest, 'insight_snapshots'), analyticalHistory.insightRows);
    }
  } finally { await store.close(); }
});
