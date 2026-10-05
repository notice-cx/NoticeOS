import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKUP_PATHS, readBackupWorker, backupWorkerEnvironment } from './container-backup-profile.mjs';
import { writeSecrets } from './postgres-secrets.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-backup-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const map = file => path.join(root, file);
  const write = (file, contents) => {
    fs.mkdirSync(path.dirname(map(file)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(map(file), contents, { mode: 0o600 });
  };
  for (const name of ['state', 'transport', 'staging', 'data', 'spokes', 'postgresSocket', 'doltSecrets']) fs.mkdirSync(map(BACKUP_PATHS[name]), { recursive: true, mode: 0o700 });
  writeSecrets(map(BACKUP_PATHS.postgresSecrets), { port: 5772 });
  write(BACKUP_PATHS.profile, JSON.stringify({ format: 'noticeos-backup-worker-v1', retentionDays: 14 }));
  write(BACKUP_PATHS.client, JSON.stringify({ format: 'noticeos-backup-client-v1', transportDir: BACKUP_PATHS.transport }));
  for (const name of ['root', 'noticeos']) write(path.join(BACKUP_PATHS.doltSecrets, name), 'a'.repeat(64) + '\n');
  write('/state/workers/ingest/.dev.secrets.json', JSON.stringify({
    DATABASE_URL: 'postgresql://noticeos_app:synthetic@postgres:5432/noticeos',
    CREDENTIALS_KEY: 'synthetic', OPERATOR_TOKEN: 'synthetic',
  }));
  const io = { lstatSync: file => fs.lstatSync(map(file)), readFileSync: (file, ...args) => fs.readFileSync(map(file), ...args) };
  return { root, map, write, io };
}

test('worker validates exact fixed mounts, private bootstrap custody and existing Postgres verifier modes', t => {
  const f = fixture(t);
  const profile = readBackupWorker({ fs: f.io });
  assert.equal(profile.retentionDays, 14);
  assert.equal(profile.clientUid, process.getuid());
  assert.equal(fs.statSync(f.map('/run/postgres-secrets/noticeos_app')).mode & 0o777, 0o644);
  f.write(BACKUP_PATHS.profile, JSON.stringify({ format: 'noticeos-backup-worker-v1', retentionDays: 14, command: 'anything' }));
  assert.throws(() => readBackupWorker({ fs: f.io }), /not prepared/u);
});

test('wrong endpoints, exposed credentials and aliased storage refuse the worker', t => {
  const f = fixture(t);
  fs.chmodSync(f.map('/run/postgres-secrets/owner.url'), 0o644);
  assert.throws(() => readBackupWorker({ fs: f.io }), /not prepared/u);
  fs.chmodSync(f.map('/run/postgres-secrets/owner.url'), 0o600);
  f.write(BACKUP_PATHS.client, JSON.stringify({ format: 'noticeos-backup-client-v1', transportDir: '/other' }));
  assert.throws(() => readBackupWorker({ fs: f.io }), /not prepared/u);
  f.write(BACKUP_PATHS.client, JSON.stringify({ format: 'noticeos-backup-client-v1', transportDir: BACKUP_PATHS.transport }));
  fs.rmdirSync(f.map(BACKUP_PATHS.staging)); fs.symlinkSync(f.map(BACKUP_PATHS.data), f.map(BACKUP_PATHS.staging));
  assert.throws(() => readBackupWorker({ fs: f.io }), /not prepared/u);
});

test('a different client UID or GID refuses before an exporter can enter the private backup tree', t => {
  const f = fixture(t);
  for (const identity of ['uid', 'gid']) {
    const io = { ...f.io, lstatSync: file => {
      const stat = f.io.lstatSync(file);
      if (file === BACKUP_PATHS.client) stat[identity] += 1;
      return stat;
    } };
    assert.throws(() => readBackupWorker({ fs: io }), /not prepared/u);
  }
  assert.equal(readBackupWorker({ fs: f.io }).clientUid, process.getuid());
});

test('worker children inherit no ambient database, cloud or Docker selection', () => {
  const env = backupWorkerEnvironment({ PATH: '/prepared/bin', DATABASE_URL: 'foreign', DOLT_CLI_PASSWORD: 'foreign',
    BEADS_DOLT_SERVER_HOST: 'foreign', DOCKER_HOST: 'foreign', CLOUDFLARE_API_TOKEN: 'foreign', HOME: '/foreign' });
  assert.equal(env.PATH, '/prepared/bin'); assert.equal(env.HOME, BACKUP_PATHS.clientHome);
  for (const key of ['DATABASE_URL', 'DOLT_CLI_PASSWORD', 'BEADS_DOLT_SERVER_HOST', 'DOCKER_HOST', 'CLOUDFLARE_API_TOKEN']) assert.equal(env[key], undefined);
});
