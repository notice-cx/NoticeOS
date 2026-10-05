// Actual dump and independent restore, synthetic records only. Docker's exec
// boundary is mapped to the same binaries on a private native test cluster;
// the production module still selects/validates its Compose profile itself.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { runBackup } from './host-backup.mjs';
import { DEV_DATABASE, MODEL_DIR, PostgresUnavailable, ROLES_SQL, checkedSession, findPostgres, inWorkspace, processAlive, psqlEnvironment } from './postgres-dev.mjs';
import { openOnLoopbackPort } from './postgres-test-cluster.mjs';
import { applyMigrations } from './postgres-migrate.mjs';

function fingerprint(db) {
  const tables = db.sql(`SELECT format('%I.%I', n.nspname, c.relname) AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('noticeos','noticeos_ref','noticeos_migrations') AND c.relkind='r' ORDER BY 1`);
  return {
    tables: Object.fromEntries(tables.map(({ name }) => [name, db.sql(`SELECT count(*) AS rows,
      md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text), '')) AS digest FROM ${name} t`)[0]])),
    schema: db.sql(`SELECT n.nspname,c.relname,c.relkind,c.relowner::regrole::text AS owner,
      c.relrowsecurity,c.relforcerowsecurity,c.relacl::text AS acl
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('noticeos','noticeos_ref','noticeos_migrations') ORDER BY 1,2`),
    constraints: db.sql(`SELECT n.nspname,c.conname,pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname IN ('noticeos','noticeos_ref','noticeos_migrations') ORDER BY 1,2,3`),
    policies: db.sql(`SELECT * FROM pg_policies WHERE schemaname='noticeos' ORDER BY tablename,policyname`),
    functions: db.sql(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
      p.proowner::regrole::text AS owner, md5(pg_get_functiondef(p.oid)) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='noticeos' ORDER BY 1,2`),
    sequences: db.sql(`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='noticeos' ORDER BY 1`),
    migrations: db.sql('SELECT version,name,sha256 FROM noticeos_migrations.applied ORDER BY version'),
    views: db.sql(`SELECT * FROM noticeos.financial_ledger ORDER BY entry_id`),
  };
}

test('the dated PG/R2 backup independently restores counts, identities, schema, sealed credentials and app reads/writes', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'noticeos-pg-backup-'));
  const tools = findPostgres();
  let source, recovered;
  t.after(async () => {
    for (const cluster of [recovered, source].filter(Boolean)) {
      const pid = Number((await fs.readFile(path.join(cluster.root, 'data', 'postmaster.pid'), 'utf8')).split('\n')[0]);
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      cluster.close();
      assert.equal(processAlive(pid), false, 'the owned server stops before its backup fixture is removed');
    }
    await fs.rm(home, { recursive: true, force: true });
  });
  try {
    source = await openOnLoopbackPort(path.join(home, 'source-cluster'), tools);
    recovered = await openOnLoopbackPort(path.join(home, 'restore-cluster'), tools);
  } catch (error) {
    if (error instanceof PostgresUnavailable && process.env.NOTICEOS_REQUIRE_POSTGRES !== '1') {
      t.skip(error.message); return;
    }
    throw error;
  }
  applyMigrations(source);
  const workspaceId = randomUUID();
  const archiveBytes = Buffer.alloc(1024, 'a');
  const archiveHash = createHash('sha256').update(archiveBytes).digest('hex');
  const fixture = await fs.readFile(path.join(MODEL_DIR, 'tests/fixture.sql'), 'utf8');
  const seed = path.join(home, 'seed.sql');
  await fs.writeFile(seed, 'SET ROLE noticeos_owner;\n' + fixture.replace("repeat('a', 64), 1024", `'${archiveHash}', 1024`));
  source.file(seed, { vars: { ws: workspaceId, slug: 'backup', site: 'backup.example' } });
  const rowCounts = fingerprint(source).tables;
  assert.ok(Object.values(rowCounts).every(row => Number(row.rows) > 0), 'the Postgres fixture exercises every table');
  const connectionId = randomUUID();
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const plaintext = 'SEKRIT-synthetic-provider-must-never-appear';
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ apiKey: plaintext })), cipher.final(), cipher.getAuthTag()]);
  inWorkspace(source, workspaceId, `INSERT INTO noticeos.integration_connections
    (workspace_id,connection_id,provider,scope,created_at,updated_at)
    VALUES (:'workspace_id','${connectionId}','backup-fixture','shared','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
    INSERT INTO noticeos.connection_secrets (workspace_id,connection_id,secret_version,ciphertext,iv,key_version,field_names,created_at)
    VALUES (:'workspace_id','${connectionId}',1,decode('${ciphertext.toString('hex')}','hex'),decode('${iv.toString('hex')}','hex'),1,'["apiKey"]','2026-09-01T00:00:00Z')`, { role: 'owner' });

  const profileDir = path.join(home, 'postgres');
  await fs.mkdir(path.join(profileDir, 'secrets'), { recursive: true });
  const profile = { project: 'noticeos-synthetic-backup', composeFile: path.join(profileDir, 'compose.yaml'), secretsDir: path.join(profileDir, 'secrets'), port: source.loopbackPort };
  await fs.writeFile(profile.composeFile, 'synthetic boundary; never sent to Docker');
  await fs.writeFile(path.join(profileDir, 'profile.json'), JSON.stringify(profile));
  await fs.writeFile(path.join(profile.secretsDir, 'database.url'), 'SEKRIT-bootstrap-url-not-backed-up', { mode: 0o600 });
  await fs.writeFile(path.join(profile.secretsDir, 'credentials-key'), key.toString('base64'), { mode: 0o600 });
  source.applicationLogin();
  const sourceRoleVerifier = source.sql("SELECT rolpassword FROM pg_authid WHERE rolname='noticeos_app'")[0].rolpassword;
  assert.match(sourceRoleVerifier, /^SCRAM-SHA-256/u);
  const r2 = path.join(home, '.wrangler/state/v3/r2');
  await fs.mkdir(path.join(r2, 'miniflare-R2BucketObject'), { recursive: true });
  await fs.mkdir(path.join(r2, 'raw-signals/blobs'), { recursive: true });
  const r2Metadata = new DatabaseSync(path.join(r2, 'miniflare-R2BucketObject/fixture.sqlite'));
  try {
    r2Metadata.exec('CREATE TABLE _mf_objects (key TEXT PRIMARY KEY, blob_id TEXT, size INTEGER, custom_metadata TEXT)');
    const objects = source.sql('SELECT object_key,object_bytes,content_sha256 FROM noticeos.archive_objects');
    assert.ok(objects.length > 0, 'backup exercises archive custody');
    for (const object of objects) {
      assert.equal(object.content_sha256, archiveHash);
      assert.equal(Number(object.object_bytes), archiveBytes.length);
      r2Metadata.prepare('INSERT INTO _mf_objects VALUES (?, ?, ?, ?)').run(object.object_key, archiveHash, archiveBytes.length, JSON.stringify({ contentSha256: archiveHash }));
    }
    await fs.writeFile(path.join(r2, 'raw-signals/blobs', archiveHash), archiveBytes);
  } finally { r2Metadata.close(); }
  const before = fingerprint(source);
  const pgDump = path.join(path.dirname(tools.psql), 'pg_dump');
  const pgRestore = path.join(path.dirname(tools.psql), 'pg_restore');
  const calls = [];
  const adapters = {
    claimNamespace: 'a'.repeat(64),
    env: { PATH: process.env.PATH, CREDENTIALS_KEY: key.toString('base64'), DATABASE_URL: 'SEKRIT-not-in-command-env' },
    spawn(binary, args, options) {
      calls.push({ binary, args, env: options.env });
      if (binary === 'docker' && args[0] === 'context') {
        const child = new EventEmitter(); child.stdout = new EventEmitter();
        queueMicrotask(() => { child.stdout.emit('data', 'unix:///synthetic/docker.sock'); child.emit('close', 0, null); });
        return child;
      }
      if (binary === 'docker') {
        assert.deepEqual(args.slice(0, 7), ['compose', '--env-file', '/dev/null', '-p', profile.project, '-f', profile.composeFile]);
        assert.deepEqual(args.slice(7), ['exec', '-T', '--user', 'postgres', 'postgres', 'pg_dump', '--host=/var/run/postgresql', '--username=postgres', '--dbname=noticeos', '--no-password', '--format=custom']);
        return spawn(pgDump, ['--host', source.socketDir, '--port', String(source.loopbackPort), '--username=postgres', '--dbname', DEV_DATABASE, '--no-password', '--format=custom'], { ...options, env: psqlEnvironment() });
      }
      assert.equal(binary, 'sqlite3', 'no task-hub or other external command is permitted');
      return spawn(binary, args, options);
    },
  };
  const result = await runBackup({ repoRoot: home, retentionDays: 30, offsiteBackupDir: null, taskHub: 'linked' }, adapters);
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.stages.postgres.copied, 1);
  assert.equal(result.stages.taskHub.status, 'not_configured');
  const dump = path.join(result.backupSet.path, 'postgres/noticeos.dump');
  const bytes = await fs.readFile(dump);
  assert.equal(bytes.subarray(0, 5).toString(), 'PGDMP');
  assert.equal(bytes.includes(Buffer.from(plaintext)), false);
  assert.equal(bytes.includes(key), false);
  assert.equal(bytes.includes(Buffer.from(key.toString('base64'))), false);
  const inspected = spawnSync(pgRestore, ['--file=-', dump], { encoding: 'utf8', env: psqlEnvironment(), maxBuffer: 8 * 1024 * 1024 });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(inspected.stdout.includes(plaintext), false);
  assert.equal(inspected.stdout.includes(key.toString('base64')), false);
  assert.equal(inspected.stdout.includes(sourceRoleVerifier), false);
  assert.doesNotMatch(inspected.stdout, /CREATE ROLE|ALTER ROLE .*PASSWORD/u);
  assert.deepEqual((await fs.readdir(result.backupSet.path)).sort(), ['RESTORE.md', 'backup.json', 'postgres', 'r2']);
  const manifest = JSON.parse(await fs.readFile(path.join(result.backupSet.path, 'backup.json'), 'utf8'));
  assert.equal(manifest.format, 'noticeos-backup-v1');
  assert.equal(manifest.complete, true);
  assert.equal((await fs.stat(dump)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(result).includes(plaintext), false);
  assert.equal(JSON.stringify(calls).includes('SEKRIT'), false);
  assert.deepEqual(fingerprint(source), before, 'backup wrote nothing to the source');

  // A genuinely empty second database: roles exist on its separate cluster,
  // but no application schema or migration is applied before pg_restore.
  recovered.file(ROLES_SQL);
  const admin = recovered.onDatabase('postgres');
  admin.sql('CREATE DATABASE noticeos_restore_dev OWNER noticeos_owner');
  const restored = recovered.onDatabase('noticeos_restore_dev');
  assert.equal(restored.sql("SELECT to_regnamespace('noticeos') IS NULL AS empty")[0].empty, 't');
  const restore = spawnSync(pgRestore, ['--host', recovered.socketDir, '--port', String(recovered.loopbackPort), '--username=postgres', '--no-password', '--dbname=noticeos_restore_dev', '--exit-on-error', dump], { encoding: 'utf8', env: psqlEnvironment() });
  assert.equal(restore.status, 0, restore.stderr);
  assert.deepEqual(fingerprint(restored), before, 'all table rows/IDs, sequences, owner/ACL/RLS/constraint/function definitions and recorded schema hashes survive');
  assert.equal(restored.sql(`SELECT encode(ciphertext,'hex') AS sealed FROM noticeos.connection_secrets WHERE connection_id='${connectionId}'`)[0].sealed, ciphertext.toString('hex'));

  // Each operational archive reference resolves through the copied R2
  // metadata to the same synthetic bytes and size. Metadata hashes are checked
  // where present; older size-only custody is not claimed as hash verification.
  const objects = restored.sql('SELECT object_key,object_bytes,content_sha256 FROM noticeos.archive_objects ORDER BY object_key');
  const metadataRoot = path.join(result.backupSet.path, 'r2/miniflare-R2BucketObject');
  const [metadataFile] = await fs.readdir(metadataRoot);
  const metadata = new DatabaseSync(path.join(metadataRoot, metadataFile), { readOnly: true });
  try {
    for (const object of objects) {
      const row = metadata.prepare('SELECT blob_id,size,custom_metadata FROM _mf_objects WHERE key=?').get(object.object_key);
      assert.ok(row, 'every PG object has copied R2 metadata');
      const blob = path.join(result.backupSet.path, 'r2/raw-signals/blobs', row.blob_id);
      assert.equal((await fs.stat(blob)).size, Number(object.object_bytes));
      assert.equal(row.size, Number(object.object_bytes));
      const copiedBytes = await fs.readFile(blob);
      assert.deepEqual(copiedBytes, archiveBytes);
      assert.equal(createHash('sha256').update(copiedBytes).digest('hex'), object.content_sha256);
      const hash = JSON.parse(row.custom_metadata).contentSha256;
      if (hash !== undefined) assert.equal(hash, object.content_sha256);
    }
  } finally { metadata.close(); }

  const appUrl = new URL(recovered.applicationLogin().url('noticeos_restore_dev'));
  const app = checkedSession({ host: appUrl.hostname, port: Number(appUrl.port), dbname: 'noticeos_restore_dev', user: 'noticeos_app', password: appUrl.password }, { tools, where: 'isolated restored application' });
  assert.equal(app.sql('SELECT current_user AS role')[0].role, 'noticeos_app');
  const sites = inWorkspace(app, workspaceId, '', { read: 'SELECT asset_id FROM noticeos.assets ORDER BY list_position' });
  assert.ok(sites.length > 0);
  const read = inWorkspace(app, workspaceId, `INSERT INTO noticeos.annotations (workspace_id,asset_id,at,kind,note)
    VALUES (:'workspace_id', :'asset', '2026-09-30T00:00:00Z', 'external', 'restored app write')`, {
    vars: { asset: sites[0].asset_id }, read: "SELECT annotation_number FROM noticeos.annotations WHERE note='restored app write'",
  });
  assert.equal(read.length, 1);
  assert.ok(Number(read[0].annotation_number) > 0);
  assert.deepEqual(inWorkspace(app, randomUUID(), '', { read: 'SELECT asset_id FROM noticeos.assets' }), [], 'restored RLS still isolates workspaces');
});
