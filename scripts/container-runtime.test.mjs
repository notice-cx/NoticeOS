import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import { HOST_FACTS, containerCommand, containerEnvironment, main as containerMain } from '../deploy/compose/entrypoint.mjs';
import { ContainerRefusal } from '../deploy/compose/development.mjs';
import { composeArchiveBucket, composeArchiveState, composeBridgePeer, composeCustomerPlan, runningContainerProfile, selectedCustomerProfile } from '../deploy/compose/customer-entry.mjs';
import { containerHealthy } from '../deploy/compose/health.mjs';
import { BACKUP_APP_ORIGIN } from './container-backup-profile.mjs';
import { readComposeCustomerOperating } from './local-customer-operating.mjs';
import { customerWorkerdReady } from './local-customer.mjs';
import { actionArgs } from './stack-control.mjs';
import { towerAllowedHosts } from '../apps/tower/vite/allowed-hosts.ts';

function io(defect) {
  return { lstatSync(file) {
    if (defect === file) throw new Error('Missing synthetic file');
    const secret = file.endsWith('.json');
    return { isDirectory: () => !secret, isFile: () => secret, isSymbolicLink: () => false, mode: 0o600, size: 200 };
  }, readFileSync() { return JSON.stringify({ DATABASE_URL: 'postgresql://noticeos_app:synthetic-private@postgres:5432/noticeos', CREDENTIALS_KEY: 'synthetic', OPERATOR_TOKEN: 'synthetic' }); } };
}

test('container startup declares its mounts and internal services and strips ambient installation selectors', () => {
  const env = containerEnvironment({ PATH: '/own/bin', DATABASE_URL: 'private', NOTICEOS_HOME: '/other', OTHER_SERVICE_PASSWORD: 'private', DOCKER_HOST: 'foreign', OS_UP_HOST: '0', TOWER_ALLOWED_HOSTS: 'office.example' }, { fs: io() });
  assert.equal(env.NOTICEOS_HOME, '/state'); assert.equal(env.HOME, '/state/home');
  assert.equal(env.OS_UP_HOST, '1');
  // The backup worker's requests reach the app by its service name in every mode.
  assert.equal(env.TOWER_ALLOWED_HOSTS, 'office.example,noticeos');
  assert.equal(containerEnvironment({}, { fs: io() }).TOWER_ALLOWED_HOSTS, 'noticeos');
  assert.equal(containerEnvironment({ NOTICEOS_CONTAINER_MODE: 'development' }, { fs: io(), checkDependencies: () => {} }).TOWER_ALLOWED_HOSTS, 'noticeos');
  assert.ok(towerAllowedHosts({ hostname: 'container-id', env: { TOWER_ALLOWED_HOSTS: env.TOWER_ALLOWED_HOSTS } }).includes(new URL(BACKUP_APP_ORIGIN).hostname));
  assert.equal(env.NOTICEOS_IMMUTABLE_APP, '1');
  assert.equal(env.NOTICEOS_VITE_CACHE_DIR, '/state/.local/vite-cache');
  assert.equal(env.CLOUDFLARE_CF_FETCH_ENABLED, 'false');
  assert.equal(env.NOTICEOS_BACKUP_CLIENT_PROFILE, '/state/backup-client.json');
  for (const key of ['DATABASE_URL', 'OTHER_SERVICE_PASSWORD', 'DOCKER_HOST']) assert.equal(env[key], undefined);
  assert.ok(!JSON.stringify(env).includes('synthetic-private'));
  assert.throws(() => containerEnvironment({}, { fs: io('/state/.wrangler') }), /Missing/);
  assert.throws(() => containerEnvironment({}, { fs: { ...io(), readFileSync: () => JSON.stringify({ DATABASE_URL: 'postgresql://noticeos_app:synthetic@postgres/noticeos' }) } }), /incomplete/);
  assert.throws(() => containerEnvironment({}, { fs: { ...io(), readFileSync: () => JSON.stringify({ DATABASE_URL: 'postgresql://noticeos_app:synthetic@foreign/noticeos' }) } }), /internal database/);
});

test('the container runs the runner, or one named job beside it, and nothing else', () => {
  assert.deepEqual(containerCommand([]), ['scripts/os-up.mjs']);
  assert.deepEqual(containerCommand(['backup']), ['scripts/os-up.mjs', '--backup']);
  assert.deepEqual(containerCommand(['run-job', '0 6 * * *']), ['scripts/os-up.mjs', '--tick', '0 6 * * *']);
  assert.deepEqual(containerCommand(['capacity']), ['scripts/os-capacity.mjs']);
  assert.deepEqual(containerCommand(['capacity', '--json']), ['scripts/os-capacity.mjs', '--json']);
  assert.deepEqual(containerCommand(['setup']), ['scripts/os-setup-container.mjs']);
  assert.deepEqual(containerCommand(['seed-settings']), ['scripts/config-seed.mjs']);
  assert.deepEqual(containerCommand(['mcp']), ['scripts/local-mcp.mjs']);
  assert.deepEqual(containerCommand(['mcp', '--actor', 'agent-1']), ['scripts/local-mcp.mjs', '--actor', 'agent-1']);
  assert.deepEqual(containerCommand(['collect', '--asset', 'example.com', '--families', 'posthog-inp-targets']),
    ['scripts/signal-collect.mjs', '--asset', 'example.com', '--families', 'posthog-inp-targets']);
  for (const argv of [['shell'], ['backup', '--now'], ['run-job'], ['run-job', '$(id)'], ['run-job', '0 6 * * *', 'x'], ['capacity', '--all'],
    ['setup', '--force'], ['seed-settings', '--force', 'config/tower.json'], ['mcp', '--http'], ['mcp', '--actor'], ['bd'], ['bd', 'list', '--json'],
    ['collect'], ['collect', '--asset', '$(id)'], ['collect', '--asset', 'example.com', '--door', 'http://example.org'],
    ['collect', '--asset', 'example.com', '--families', 'everything']]) {
    assert.equal(containerCommand(argv), null, argv.join(' '));
  }
});

test('a refused container says why in its own words, and never repeats another error', async () => {
  let written = '';
  const err = { write: (text) => { written += text; } };
  const refuse = (error) => () => { throw error; };
  assert.equal(await containerMain([], { err, environment: refuse(new ContainerRefusal("The checkout's packages changed since this image was built; pnpm os:dev builds a matching one.")) }), 1);
  assert.equal(written, "NoticeOS container refused: The checkout's packages changed since this image was built; pnpm os:dev builds a matching one.\n");
  written = '';
  assert.equal(await containerMain([], { err, environment: refuse(new SyntaxError('Unexpected token in JSON near "PRIVATE-SENTINEL"')) }), 1);
  assert.equal(written, 'NoticeOS container refused: prepare its mounted installation and internal service credentials.\n');
});

test('app jobs wait for the running profile and customer startup cannot dispatch standalone work', async () => {
  const err = { write() {} };
  const environment = () => ({ NOTICEOS_IMMUTABLE_APP: '1' });
  const startup = start => ({
    lstatSync: () => ({ isFile: () => true, uid: process.getuid(), size: 15, mode: 0o600 }),
    readFileSync: file => file === '/proc/1/stat' ? `1 (test init) S ${Array(18).fill(0).join(' ')} ${start} 0` : '100 standalone\n',
  });
  assert.equal(runningContainerProfile(startup(100)), 'standalone');
  assert.equal(runningContainerProfile(startup(101)), null);
  assert.equal(await containerMain(['backup'], { err, environment, runningProfile: () => runningContainerProfile(startup(101)) }), 1);
  for (const argv of [['run-job', '0 6 * * *'], ['customer-archive', '--plan']]) {
    assert.equal(await containerMain(argv, { err, environment, runningProfile: () => runningContainerProfile(startup(101)) }), 1);
    assert.equal(await containerMain(argv, { err, environment, runningProfile: () => 'customer' }), 2);
  }
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

test('the same container explicitly selects one customer clock, exact loopback ingress and its existing raw storage', t => {
  const missing = () => { throw Object.assign(new Error(), { code: 'ENOENT' }); };
  const select = (value, mode = 0o600) => selectedCustomerProfile({ lstatSync: () => ({
    isFile: () => true, uid: process.getuid(), size: value.length, mode,
  }), readFileSync: () => value });
  assert.equal(selectedCustomerProfile({ lstatSync: missing }), 'standalone');
  assert.equal(select('noticeos-compose-customer/1\n'), 'customer');
  assert.throws(() => select('noticeos-compose-customer/1\n', 0o644), ContainerRefusal);
  assert.throws(() => select('unknown\n'), ContainerRefusal);
  assert.deepEqual(containerCommand([], 'customer'), ['deploy/compose/customer-entry.mjs']);
  assert.deepEqual(containerCommand(['capacity'], 'customer'), ['scripts/os-capacity.mjs']);
  assert.deepEqual(actionArgs('customer-check', []), { job: ['customer-check'] });
  assert.deepEqual(containerCommand(['customer-check']), ['deploy/compose/customer-entry.mjs', '--check']);
  assert.throws(() => actionArgs('customer-check', ['--apply']));
  assert.deepEqual(containerCommand(['backup'], 'customer'), ['deploy/compose/customer-entry.mjs', '--backup']);
  for (const command of [['backup', '--unknown'], ['mcp'], ['run-job', '0 6 * * *'], ['collect', '--asset', 'example.com'], ['customer-archive', '--plan']]) {
    assert.equal(containerCommand(command, 'customer'), null);
  }

  const plan = composeCustomerPlan({ NOTICEOS_HOST_TOWER_ADDRESS: '127.0.0.1', NOTICEOS_HOST_TOWER_PORT: '25173' });
  assert.equal(plan.url, 'http://127.0.0.1:25173');
  assert.throws(() => composeCustomerPlan({ NOTICEOS_HOST_TOWER_ADDRESS: '0.0.0.0', NOTICEOS_HOST_TOWER_PORT: '25173' }), ContainerRefusal);
  const lan = { NOTICEOS_HOST_TOWER_ADDRESS: '0.0.0.0', NOTICEOS_HOST_TOWER_PORT: '25173', TOWER_ALLOWED_HOSTS: 'test-tower.local' };
  assert.equal(composeCustomerPlan(lan, 'http://test-tower.local:25173').url, 'http://test-tower.local:25173');
  const setup = { ...lan, NOTICEOS_CUSTOMER_GOOGLE_SETUP: '1' };
  assert.throws(() => composeCustomerPlan(setup, 'http://test-tower.local:25173'), ContainerRefusal);
  assert.deepEqual(composeCustomerPlan({ ...setup, NOTICEOS_HOST_TOWER_ADDRESS: '127.0.0.1' }, 'http://test-tower.local:25173'), {
    ...plan, googleSetup: true, savedTowerOrigin: 'http://test-tower.local:25173',
  });
  for (const origin of ['http://other.local:25173', 'http://test-tower.local:25174', 'http://public.example:25173']) {
    assert.throws(() => composeCustomerPlan(lan, origin), ContainerRefusal);
  }
  const header = 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n';
  const route = 'eth0 00000000 010011AC 0003 0 0 0 00000000 0 0 0\n';
  const subnet = 'eth0 000011AC 00000000 0001 0 0 0 0000FFFF 0 0 0\n';
  assert.equal(composeBridgePeer(header + route + subnet), '172.17.0.1');
  assert.throws(() => composeBridgePeer(header + subnet), ContainerRefusal);
  assert.throws(() => composeBridgePeer(header + route + route), ContainerRefusal);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-compose-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(composeArchiveBucket(root), 'noticeos-raw-signals');
  fs.writeFileSync(path.join(root, 'resource-names.json'), JSON.stringify({ rawSignalsBucket: 'fixture-legacy-raw-signals' }));
  assert.equal(composeArchiveBucket(root), 'fixture-legacy-raw-signals');
  fs.writeFileSync(path.join(root, 'resource-names.json'), JSON.stringify({ rawSignalsBucket: '../escape' }));
  assert.throws(() => composeArchiveBucket(root), ContainerRefusal);
  const archive = composeArchiveState(root, fs, dir => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }));
  fs.writeFileSync(path.join(archive, 'existing'), 'keep');
  assert.equal(composeArchiveState(root, fs, () => {}), path.join(root, '.wrangler/state/v3'));
  assert.equal(fs.readFileSync(path.join(archive, 'existing'), 'utf8'), 'keep');
  const alternate = path.join(root, 'alternate');
  fs.mkdirSync(alternate);
  fs.symlinkSync(path.join(root, '.wrangler'), path.join(alternate, '.wrangler'));
  assert.throws(() => composeArchiveState(alternate, fs, () => {}), ContainerRefusal);

  const file = path.join(fs.realpathSync(root), 'prepared.json');
  const database = { identity: 'postgresql://noticeos_identity:fixture@postgres/product',
    grant: 'postgresql://noticeos_service_grant:fixture@postgres:5432/product' };
  const bootstrap = { DATABASE_URL: 'postgresql://noticeos_app:fixture@postgres:5432/product', CREDENTIALS_KEY: 'A'.repeat(43) + '=' };
  const options = { format: 'noticeos-compose-customer/1', database, identitySecret: 'fixture'.repeat(8),
    mailRecipients: ['owner@example.test'], workspaces: [{ workspaceId: '00000000-0000-4000-8000-000000000001', serviceId: '00000000-0000-4000-8000-000000000002' }] };
  const read = (value = {}, bindings = bootstrap) => {
    fs.writeFileSync(file, JSON.stringify({ ...options, ...value }), { mode: 0o600 });
    return readComposeCustomerOperating(file, plan, bindings);
  };
  const prepared = read();
  assert.equal(prepared.target, 'postgres:5432/product');
  assert.deepEqual(prepared.mailRecipients, ['owner@example.test']);
  assert.equal(prepared.googleDaily, false);
  assert.equal(prepared.ntasksOrigin, null);
  assert.throws(() => read({ database: { ...database, grant: database.grant.replace('/product', '/different') } }), /existing database/u);
  assert.throws(() => read({ database: { ...database, identity: database.identity.replace('@postgres', '@foreign.example') } }), /existing database/u);
  assert.throws(() => read({ database: { ...database, app: bootstrap.DATABASE_URL } }), /existing database/u);
  const site = { workspaceId: options.workspaces[0].workspaceId, asset: 'fixture-site', urls: ['https://example.test/metrics'] };
  const tokens = { 'fixture-site': 'fixture-bearer', 'different-site': 'unused-bearer' };
  for (const ASSET_TOKENS of [tokens, JSON.stringify(tokens)]) {
    assert.deepEqual(read({ sitePulls: [site] }, { ...bootstrap, ASSET_TOKENS }).sitePulls, [
      { ...site, token: tokens['fixture-site'] },
    ]);
  }
  assert.throws(() => read({ sitePulls: [site] }), /existing bearer in ASSET_TOKENS/u);
  const bound = { ...bootstrap, ASSET_TOKENS: tokens };
  assert.throws(() => read({ sitePulls: [{ ...site, token: 'replacement-bearer' }] }, bound), /existing database/u);
  assert.throws(() => read({ sitePulls: [{ ...site, workspaceId: options.workspaces[0].serviceId }] }, bound), /existing database/u);
  assert.throws(() => read({ mailDelivery: 'relay.json' }), /Restore the private SMTP mail file/u);
  assert.throws(() => read({ mailRecipients: undefined }), { name: 'Error' });
  assert.throws(() => read({ mailRecipients: undefined, mailDelivery: 'relay.json' }), /Restore the private SMTP mail file/u);
  fs.writeFileSync(path.join(root, 'relay.json'), JSON.stringify({ format: 'noticeos-identity-smtp/1', url: 'smtps://relay.example.test:465',
    from: 'tower@example.test', username: 'relay', password: 'synthetic' }), { mode: 0o600 });
  const scopedRelay = read({ mailDelivery: 'relay.json', mailRecipients: ['Allowed@example.test'] });
  assert.deepEqual(scopedRelay.mailRecipients, ['allowed@example.test']);
  const membershipRelay = read({ mailDelivery: 'relay.json', mailRecipients: undefined });
  assert.equal(membershipRelay.mailDelivery.from, 'tower@example.test');
  assert.equal(membershipRelay.mailRecipients, undefined);
  for (const mailRecipients of [null, [], ['invalid']]) {
    assert.throws(() => read({ mailDelivery: 'relay.json', mailRecipients }), /existing database/u);
  }
});

test('customer readiness does not fall back to stale standalone state or ignore a declared backup', async () => {
  const env = { NOTICEOS_HOST_TOWER_ADDRESS: '127.0.0.1', NOTICEOS_HOST_TOWER_PORT: '25173' };
  const checks = [];
  const health = { profile: () => 'customer', env, read: async () => assert.fail('stale runner state'),
    backupStatus: async () => ({ configured: false }), customerProbe: async (url, options) => {
      checks.push([url, options.host]); return 204;
    } };
  assert.equal(await containerHealthy(health), true);
  assert.deepEqual(checks, [['http://127.0.0.1:5173/_noticeos/ready', '127.0.0.1:5173']]);
  assert.equal(await containerHealthy({ ...health, customerProbe: async () => 404 }), false);
  for (const available of [true, false]) {
    assert.equal(await containerHealthy({ ...health, backupStatus: async () => ({ configured: true, available }) }), available);
  }
  assert.equal(await containerHealthy({ ...health, customerProbe: async () => 404,
    backupStatus: async () => ({ configured: true, available: true }) }), false);
  assert.equal(await containerHealthy({ ...health, profile: () => null }), false);
});

test('customer readiness fails when the private Worker stops responding', async () => {
  const planned = () => true;
  assert.equal(await customerWorkerdReady(planned, async () => new Response(null, { status: 204 })), true);
  assert.equal(await customerWorkerdReady(planned, async () => { throw new Error('Worker process exited'); }), false);
  assert.equal(await customerWorkerdReady(planned, async () => new Response(null, { status: 503 })), false);
  let probes = 0;
  assert.equal(await customerWorkerdReady(() => false, async () => { probes++; return new Response(null, { status: 204 }); }), false);
  assert.equal(probes, 0);
});

test('live source is explicit, checks dependencies and keeps the same installation boundaries', () => {
  let checked=0;const options={fs:io(),checkDependencies:()=>{checked++;}};
  const prepared=containerEnvironment({NOTICEOS_LIVE_SOURCE_ROOT:'/foreign'},options);
  assert.equal(checked,0);assert.equal(prepared.NOTICEOS_LIVE_SOURCE_ROOT,undefined);
  const dev=containerEnvironment({NOTICEOS_CONTAINER_MODE:'development'},options);
  assert.equal(checked,1);assert.equal(dev.NOTICEOS_IMMUTABLE_APP,'0');assert.equal(dev.NOTICEOS_LIVE_SOURCE_ROOT,'/source');
  for(const key of ['NOTICEOS_HOME','HOME','NOTICEOS_BACKUP_CLIENT_PROFILE']) assert.equal(dev[key],prepared[key]);
  assert.throws(()=>containerEnvironment({NOTICEOS_CONTAINER_MODE:'unknown'},options),/Choose/);
  assert.throws(()=>containerEnvironment({NOTICEOS_CONTAINER_MODE:'development'},{...options,checkDependencies:()=>{throw new Error('lock drift');}}),/lock drift/);
});


test('container Vite serve supplies the refresh runtime even when ambient NODE_ENV is production', async () => {
  const env = containerEnvironment({ NODE_ENV: 'production' }, { fs: io() });
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

test('the image prints its launcher for a Docker-only install, before it checks any installation', async () => {
  let printed = '';
  const code = await containerMain(['launcher'], { out: { write: (bytes) => { printed += String(bytes); } }, err: { write: () => assert.fail('it refused') },
    environment: () => assert.fail('the installation was checked') });
  assert.equal(code, 0);
  assert.equal(printed, fs.readFileSync(fileURLToPath(new URL('../deploy/compose/noticeos', import.meta.url)), 'utf8'));
  assert.match(printed, /^#!\/bin\/sh\n/u);
});

test('the app sees the installation as the host does, and nothing else of the host\'s', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../deploy/compose/compose.yaml', import.meta.url)), 'utf8');
  const passed = [...source.matchAll(/^ {6}(NOTICEOS_HOST_[A-Z_]+):/gmu)].map((match) => match[1]);
  assert.ok(passed.length > 0);
  assert.deepEqual([...HOST_FACTS].sort(), passed.sort(), 'each fact compose.yaml passes reaches the Tower');
});
