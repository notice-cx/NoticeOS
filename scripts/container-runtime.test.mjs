import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
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
  assert.equal(env.NOTICEOS_IMMUTABLE_APP, '1');
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


test('container Vite serve supplies the refresh runtime even when ambient NODE_ENV is production', async () => {
  const env = containerEnvironment({ NODE_ENV: 'production' }, { fs: io(), readClient: () => profile });
  assert.equal(env.NODE_ENV, 'development');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const require = createRequire(path.join(root, 'apps/tower/package.json'));
  const { createServer } = await import(require.resolve('vite'));
  const { default: react } = await import(require.resolve('@vitejs/plugin-react'));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-container-refresh-'));
  const previous = process.env.NODE_ENV;
  const httpServer = createHttpServer();
  let server;
  try {
    process.env.NODE_ENV = env.NODE_ENV;
    fs.symlinkSync(path.join(root, 'apps/tower/node_modules'), path.join(fixture, 'node_modules'));
    fs.writeFileSync(path.join(fixture, 'Brand.tsx'), 'export function Brand() { return <strong>NoticeOS</strong>; }\n');
    server = await createServer({ root: fixture, configFile: false, envFile: false,
      cacheDir: path.join(fixture, 'cache'), plugins: [react()],
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, hmr: { server: httpServer } } });
    assert.equal(server.config.isProduction, false);
    const html = await server.transformIndexHtml('/', '<html><body><div id="root"></div></body></html>');
    assert.match(html, /window\.\$RefreshReg\$/u);
    assert.match(html, /\/@react-refresh/u);
    const component = await server.transformRequest('/Brand.tsx');
    assert.ok(component);
    assert.match(component.code, /\$RefreshReg\$/u);
    assert.match(component.code, /\/@react-refresh/u, 'refresh registrations have their runtime wrapper');
  } finally {
    await server?.close();
    await new Promise(resolve => httpServer.close(() => resolve()));
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
