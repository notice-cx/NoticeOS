import assert from 'node:assert/strict';
import test from 'node:test';
import { containerEnvironment } from '../deploy/compose/entrypoint.mjs';
import { containerHealthy } from '../deploy/compose/health.mjs';

const profile = { host: 'dolt', port: 3306, user: 'noticeos', credentialsFile: '/state/dolt/credentials', clientHome: '/state/dolt/client-home' };
function io(defect) {
  return { lstatSync(file) {
    if (defect === file) throw new Error('Missing synthetic file');
    const secret = file.endsWith('.json');
    return { isDirectory: () => !secret, isFile: () => secret, isSymbolicLink: () => false, mode: 0o600, size: 200 };
  }, readFileSync() { return JSON.stringify({ DATABASE_URL: 'postgresql://noticeos_app:synthetic-private@postgres:5432/noticeos', CREDENTIALS_KEY: 'synthetic', OPERATOR_TOKEN: 'synthetic' }); } };
}

test('container startup declares its mounts and internal services and strips ambient installation selectors', () => {
  const env = containerEnvironment({ PATH: '/own/bin', DATABASE_URL: 'private', NOTICEOS_HOME: '/other', BEADS_DOLT_PASSWORD: 'private', DOCKER_HOST: 'foreign', OS_UP_HOST: '0', TOWER_ALLOWED_HOSTS: 'office.example' }, { fs: io(), readClient: () => profile });
  assert.equal(env.NOTICEOS_HOME, '/state'); assert.equal(env.NOTICEOS_TASK_CLIENT_PROFILE, '/state/task-client.json');
  assert.equal(env.OS_UP_HOST, '1');
  assert.equal(env.TOWER_ALLOWED_HOSTS, 'office.example');
  assert.equal(containerEnvironment({}, { fs: io(), readClient: () => profile }).TOWER_ALLOWED_HOSTS, undefined);
  assert.equal(env.NOTICEOS_VITE_CACHE_DIR, '/state/.local/vite-cache');
  assert.equal(env.CLOUDFLARE_CF_FETCH_ENABLED, 'false');
  assert.equal(env.NOTICEOS_BACKUP_CLIENT_PROFILE, '/state/backup-client.json');
  for (const key of ['DATABASE_URL', 'BEADS_DOLT_PASSWORD', 'DOCKER_HOST']) assert.equal(env[key], undefined);
  assert.ok(!JSON.stringify(env).includes('synthetic-private'));
  assert.throws(() => containerEnvironment({}, { fs: io('/state/.wrangler'), readClient: () => profile }), /Missing/);
  assert.throws(() => containerEnvironment({}, { fs: io(), readClient: () => ({ ...profile, host: 'foreign' }) }), /internal task/);
  assert.throws(() => containerEnvironment({}, { fs: { ...io(), readFileSync: () => JSON.stringify({ DATABASE_URL: 'postgresql://noticeos_app:synthetic@postgres/noticeos' }) }, readClient: () => profile }), /incomplete/);
  assert.throws(() => containerEnvironment({}, { fs: { ...io(), readFileSync: () => JSON.stringify({ DATABASE_URL: 'postgresql://noticeos_app:synthetic@foreign/noticeos' }) }, readClient: () => profile }), /internal database/);
});

test('container health requires a fresh supervised runner and both answering internal doors', async () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const state = { status: 'healthy', homeRoot: '/state', towerReady: true, schedulerArmed: true, updatedAt: new Date(now - 1000).toISOString() };
  const calls = [];
  const check = (patch = {}, fetchImpl = async url => { calls.push(url); return { ok: true }; }) => containerHealthy({ now: () => now, read: async () => JSON.stringify({ ...state, ...patch }), fetchImpl });
  assert.equal(await check(), true);
  assert.deepEqual(calls, ['http://127.0.0.1:5173/api/health', 'http://127.0.0.1:8791/healthz']);
  for (const patch of [{ status: 'starting' }, { towerReady: false }, { schedulerArmed: false }, { homeRoot: '/other' }, { updatedAt: new Date(now - 60001).toISOString() }]) assert.equal(await check(patch), false);
  assert.equal(await check({}, async () => ({ ok: false })), false);
  assert.equal(await check({}, async () => { throw new Error('Own fixture refused'); }), false);
  assert.equal(await containerHealthy({ read: async () => JSON.stringify(state), now: () => now,
    backupStatus: async () => ({ configured: true, available: false }) }), false);
});
