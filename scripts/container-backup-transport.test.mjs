import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import asyncFs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BACKUP_PATHS } from './container-backup-profile.mjs';
import { writeSecrets } from './postgres-secrets.mjs';
import { dumpContainerPostgres, copyContainerRecovery, verifyContainerRecovery, ownContainerBackup } from './container-backup-transport.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-backup-transport-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const map = file => path.join(root, file);
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(map(file)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(map(file), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  };
  for (const name of ['state', 'transport', 'staging', 'data', 'spokes', 'postgresSocket', 'doltSecrets']) fs.mkdirSync(map(BACKUP_PATHS[name]), { recursive: true, mode: 0o700 });
  writeSecrets(map(BACKUP_PATHS.postgresSecrets), { port: 5910 });
  write(BACKUP_PATHS.profile, { format: 'noticeos-backup-worker-v1', retentionDays: 30 });
  write(BACKUP_PATHS.client, { format: 'noticeos-backup-client-v1', transportDir: BACKUP_PATHS.transport });
  for (const name of ['root', 'noticeos']) write(path.join(BACKUP_PATHS.doltSecrets, name), 'a'.repeat(64) + '\n');
  write('/state/workers/ingest/.dev.secrets.json', { DATABASE_URL: 'postgresql://noticeos_app:synthetic@postgres:5432/noticeos', CREDENTIALS_KEY: 'synthetic-key', OPERATOR_TOKEN: 'synthetic-token' });
  write('/state/task-client.json', { host: 'dolt', port: 3306, user: 'noticeos', credentialsFile: '/state/dolt/credentials', clientHome: '/state/dolt/client-home' });
  write('/state/installation/task-host.json', { version: 1, repositories: [{ asset: 'synthetic', prefix: 'sy', database: 'synthetic', repo: '/spokes/core' }] });
  write('/state/installation/beads.json', { version: 1, projects: [] });
  write('/spokes/core/.beads/config.yaml', 'no-git-ops: true\n');
  write('/spokes/core/.beads/metadata.json', { dolt_database: 'synthetic' });
  fs.mkdirSync(map('/state/.local/backups/.backup-owned'), { recursive: true, mode: 0o700 });
  const sync = { lstatSync: file => fs.lstatSync(map(file)), readFileSync: (file, ...args) => fs.readFileSync(map(file), ...args) };
  const io = Object.fromEntries(['mkdir', 'open', 'writeFile', 'readFile', 'readdir', 'lstat', 'chmod', 'chown'].map(name => [name, (file, ...args) => asyncFs[name](map(file), ...args)]));
  return { root, map, write, sync, io, output: '/state/.local/backups/.backup-owned/recovery' };
}

test('recovery custody includes declared spokes and rejects credentials or declaration rotation', async t => {
  const f = fixture(t); const options = { fs: f.io, fsSync: f.sync };
  const result = await copyContainerRecovery(f.output, options);
  assert.ok(result.files >= 13);
  assert.equal(fs.statSync(f.map(path.join(f.output, 'bootstrap.json'))).mode & 0o777, 0o600);
  await verifyContainerRecovery(f.output, options);
  f.write('/spokes/core/.beads/metadata.json', { dolt_database: 'different' });
  await assert.rejects(verifyContainerRecovery(f.output, options), /no complete backup/u);
  f.write('/spokes/core/.beads/metadata.json', { dolt_database: 'synthetic' });
  f.write('/state/installation/task-host.json', { version: 1, repositories: [{ repo: '/other/core' }] });
  await assert.rejects(verifyContainerRecovery(f.output, options), /no complete backup/u);
});

test('an aliased spoke cannot draw undeclared metadata into a recovery set', async t => {
  const f = fixture(t);
  fs.renameSync(f.map('/spokes/core/.beads'), f.map('/spokes/core/private'));
  fs.symlinkSync(f.map('/spokes/core/private'), f.map('/spokes/core/.beads'));
  await assert.rejects(copyContainerRecovery(f.output, { fs: f.io, fsSync: f.sync }), /no complete backup/u);
  assert.equal(fs.existsSync(f.map(f.output)), false);
});

test('Postgres dump uses only the fixed private socket and does not inherit network or cloud authority', async t => {
  const f = fixture(t); const output = '/state/.local/backups/.backup-owned/postgres/noticeos.dump';
  const calls = [];
  await dumpContainerPostgres(output, { fs: f.io, fsSync: f.sync, env: { PATH: '/prepared/bin', DATABASE_URL: 'foreign', PGHOST: 'foreign', CLOUDFLARE_API_TOKEN: 'foreign' },
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      await asyncFs.writeFile(f.map(output), 'PGDMPsynthetic-custom-archive');
      return { code: 0, stdout: '', stderr: '' };
    } });
  assert.equal(calls.length, 1); assert.equal(calls[0].command, 'pg_dump');
  assert.deepEqual(calls[0].args, ['--host=/postgres-socket', '--port=5432', '--username=postgres', '--dbname=noticeos', '--no-password', '--format=custom', `--file=${output}`]);
  for (const name of ['DATABASE_URL', 'PGHOST', 'CLOUDFLARE_API_TOKEN', 'DOCKER_HOST']) assert.equal(calls[0].options.env[name], undefined);
  await assert.rejects(dumpContainerPostgres('/other/noticeos.dump', { run: () => assert.fail('no command may run') }), /no complete backup/u);
});

test('publication assigns private files and directories to the declared restore identity and refuses aliases', async t => {
  const f = fixture(t); const output = '/state/.local/backups/.backup-owned';
  f.write(path.join(output, 'recovery/key'), 'synthetic-private');
  const ownership = { operatorUid: process.getuid(), operatorGid: process.getgid() };
  await ownContainerBackup(output, ownership, { fs: f.io });
  for (const file of [output, path.join(output, 'recovery')]) assert.equal(fs.statSync(f.map(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.map(path.join(output, 'recovery/key'))).mode & 0o777, 0o600);
  fs.symlinkSync(f.map('/state/task-client.json'), f.map(path.join(output, 'alias')));
  await assert.rejects(ownContainerBackup(output, ownership, { fs: f.io }), /no complete backup/u);
});
