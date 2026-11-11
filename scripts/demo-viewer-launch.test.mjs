import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { demoInspectionEnvironment, demoViewerEnvironment, main, parseDemoViewerArgs, prepareDemoViewerRuntime, serveDemoViewer, verifyDemoResources, verifyDemoStore } from './demo-viewer.mjs';
import { runCommand } from './run-command.mjs';
import { PRODUCT_ENV } from './product-env.mjs';

function resources(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-demo-resource-proof-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'public'); fs.mkdirSync(root);
  const project = 'noticeos-start-1234567890abcdef';
  const installation = { home, postgresProject: project, postgresPort: 6202 };
  const definitions = {}, containers = {}, volumes = {};
  for (const [service, port, target, destination, id] of [['postgres', 6202, 5432, '/var/lib/postgresql', 'a'.repeat(64)]]) {
    const secretDir = path.join(home, service, 'secrets'); fs.mkdirSync(secretDir, { recursive: true });
    const secret = path.join(secretDir, 'own'); fs.writeFileSync(secret, 'synthetic verifier');
    const volumeName = `${project}_${service}-data`, image = `synthetic-${service}@sha256:${'1'.repeat(64)}`;
    definitions[service] = { name: project, services: { [service]: { image, secrets: [{ source: 'own' }], volumes: [] } },
      volumes: { [`${service}-data`]: { name: volumeName } }, secrets: { own: { file: secret } } };
    containers[id] = { id, image, labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service, 'com.docker.compose.oneoff': 'False' },
      state: { Running: true, Health: { Status: 'healthy' } }, ports: { [`${target}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(port) }] },
      mounts: [{ Type: 'volume', Name: volumeName, Destination: destination, RW: true }, { Type: 'bind', Source: secret, Destination: '/run/secrets/own', RW: false }] };
    volumes[volumeName] = { Name: volumeName, Labels: { 'com.docker.compose.project': project, 'com.docker.compose.volume': `${service}-data` } };
  }
  const calls = [];
  const run = async (command, args, options) => {
    calls.push(args); assert.equal(command, 'docker'); assert.equal(options.timeoutMs, 10_000);
    let body;
    if (args[0] === 'compose') {
      assert.equal(args[2], project); assert.deepEqual(args.slice(5), ['--env-file', '/dev/null', 'config', '--format', 'json']);
      assert.equal(args[4], path.join(root, 'db/postgres/host/compose.yaml'));
      body = definitions.postgres;
    } else if (args[1] === 'ls') {
      assert.deepEqual(args, ['container', 'ls', '--all', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
      return { code: 0, stdout: Object.keys(containers).join('\n') };
    } else if (args[0] === 'container') body = containers[args[2]];
    else if (args[0] === 'volume') body = volumes[args[2]];
    else assert.fail('Unexpected operation');
    return { code: 0, stdout: JSON.stringify(body) };
  };
  return { installation, root, run, calls, definitions, containers, volumes };
}
test('resource acceptance reads only the exact project, its one service ID and declared volume', async t => {
  const f = resources(t);
  const accepted = await verifyDemoResources(f.installation, { root: f.root, env: {}, run: f.run });
  assert.deepEqual(accepted.services, ['postgres']); assert.equal(Object.isFrozen(accepted), true);
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls.some(args => args.some(arg => ['up', 'down', 'exec', 'run', 'stop', 'rm', 'prune'].includes(arg))), false);
});
test('unpublished image ports do not add host listeners to the declared services', async t => {
  const f = resources(t);
  Object.assign(f.containers['a'.repeat(64)].ports, { '15433/tcp': null, '7007/tcp': null, '15432/tcp': [] });
  const accepted = await verifyDemoResources(f.installation, { root: f.root, env: {}, run: f.run });
  assert.deepEqual(accepted.services, ['postgres']);
});
test('any extra published listener, duplicate binding or malformed port map refuses', async t => {
  for (const defect of ['loopback', 'public', 'duplicate', 'missing', 'malformed', 'array']) {
    const f = resources(t), c = f.containers['a'.repeat(64)];
    Object.assign(c.ports, { '15433/tcp': null, '7007/tcp': null });
    if (defect === 'loopback') c.ports['7007/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '6207' }];
    if (defect === 'public') c.ports['7007/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '6207' }];
    if (defect === 'duplicate') c.ports['5432/tcp'].push({ HostIp: '127.0.0.1', HostPort: '6204' });
    if (defect === 'missing') c.ports['5432/tcp'] = null;
    if (defect === 'malformed') c.ports['7007/tcp'] = {};
    if (defect === 'array') c.ports = [];
    await assert.rejects(verifyDemoResources(f.installation, { root: f.root, env: {}, run: f.run }), /declared local profile/u, defect);
  }
});
test('replacement images, foreign labels, extra services, bad mounts and wrong published ports refuse', async t => {
  for (const defect of ['image', 'project', 'service', 'oneoff', 'health', 'port', 'host', 'extra', 'volume', 'bind', 'extraMount']) {
    const f = resources(t), c = f.containers['a'.repeat(64)];
    if (defect === 'image') c.image = 'replacement';
    if (defect === 'project') c.labels['com.docker.compose.project'] = 'another';
    if (defect === 'service') c.labels['com.docker.compose.service'] = 'noticeos';
    if (defect === 'oneoff') c.labels['com.docker.compose.oneoff'] = 'True';
    if (defect === 'health') c.state.Health.Status = 'starting';
    if (defect === 'port') c.ports['5432/tcp'][0].HostPort = '5432';
    if (defect === 'host') c.ports['5432/tcp'][0].HostIp = '0.0.0.0';
    if (defect === 'extra') f.containers['c'.repeat(64)] = c;
    if (defect === 'volume') c.mounts[0].Name = 'another-volume';
    if (defect === 'bind') c.mounts[1].RW = true;
    if (defect === 'extraMount') c.mounts.push({ Type: 'bind', Source: '/private/another', Destination: '/another', RW: false });
    await assert.rejects(verifyDemoResources(f.installation, { root: f.root, env: {}, run: f.run }), /declared local profile/u, defect);
  }
});
test('volume ownership changes and failed or unbounded inspection never authorize a viewer', async t => {
  const f = resources(t); f.volumes[`${f.installation.postgresProject}_postgres-data`].Labels['com.docker.compose.project'] = 'another';
  await assert.rejects(verifyDemoResources(f.installation, { root: f.root, env: {}, run: f.run }));
  for (const result of [{ code: 1, stdout: 'private diagnostic' }, { code: 0, timedOut: true, stdout: '{}' }, { code: 0, stdout: ' '.repeat(2 * 1024 * 1024 + 1) }]) {
    await assert.rejects(verifyDemoResources(f.installation, { root: f.root, env: {}, run: async () => result }), /declared local profile/u);
  }
});

test('the launcher requires explicit local targets and a bounded lifetime', () => {
  const good = ['--dir', '/private/tmp/own-demo', '--port', '6200', '--release', '1'.repeat(40)];
  assert.equal(parseDemoViewerArgs(good).durationMs, 12 * 60 * 60 * 1000);
  for (const argv of [[], [...good, '--port', '6200'], [...good, '--unexpected', 'value'], good.map(value => value === '6200' ? '5173' : value),
    [...good, '--bd-bin', '/private/tmp/owned-bd'], [...good, '--duration-ms', 'Infinity'], [...good, '--duration-ms', '1'], [...good, '--duration-ms', String(12 * 60 * 60 * 1000 + 1)]]) assert.throws(() => parseDemoViewerArgs(argv));
  assert.throws(() => demoInspectionEnvironment({ DOCKER_HOST: 'tcp://another.example:2375' }));
  assert.equal(demoInspectionEnvironment({ DOCKER_CONTEXT: 'remote', HOME: '/private/tmp/own-home' }).DOCKER_CONTEXT, 'default');
});

test('viewer environment replaces installation selectors and never carries caller or cloud credentials', t => {
  const f = resources(t), databaseFile = path.join(f.installation.home, 'database.url'); fs.writeFileSync(databaseFile, 'synthetic-own-address');
  const env = demoViewerEnvironment({ ...f.installation, databaseFile }, { runtime: path.join(f.installation.home, 'viewer-fixture'), port: 6200 });
  assert.equal(env.NOTICEOS_HOME, f.installation.home);
  assert.equal(env.OS_UP_INGEST_DOOR_PORT, '6201'); assert.equal(env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, 'false');
  assert.equal(env.NOTICEOS_VITE_CACHE_DIR, path.join(f.installation.home, 'viewer-fixture/vite-cache'));
  for (const key of ['NODE_OPTIONS', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_INCLUDE_PROCESS_ENV', 'CLOUDFLARE_ENV', 'DATABASE_URL',
    'GOOGLE_SIGNAL_ACCOUNTS', 'ASSET_TOKENS', 'DOCKER_CONFIG']) assert.equal(env[key], undefined);
});

test('each failed identity boundary stops before later reads or any runtime preparation', async () => {
  const args = ['--dir', '/private/tmp/owned-demo', '--port', '6200', '--release', '1'.repeat(40)];
  for (const failed of ['source', 'files', 'resources', 'store', 'after']) {
    const calls = []; let sourceCalls = 0;
    const call = name => { calls.push(name); if (name === failed) throw new Error('private details must not print'); };
    const installation = { home: '/private/tmp/owned-demo', postgresPort: 6202 };
    let error = '';
    const result = await main(args, { root: '/private/tmp/public-source', env: {}, err: { write: text => { error += text; } },
      verifySource: async () => { call(sourceCalls++ ? 'after' : 'source'); return { release: '1'.repeat(40), tree: '2'.repeat(40) }; },
      readInstallation: () => { call('files'); return installation; },
      verifyResources: async () => call('resources'), verifyStore: async () => call('store'),
      prepareRuntime: () => { assert.fail('An uncertain generation prepared runtime state'); }, serve: () => { assert.fail('An uncertain viewer started'); } });
    assert.equal(result, 1); assert.equal(calls.at(-1), failed); assert.doesNotMatch(error, /private details/u);
  }
});

test('inherited selectors refuse before source, resource or database reads', async () => {
  const args = ['--dir', '/private/tmp/owned-demo', '--port', '6200', '--release', '1'.repeat(40)];
  for (const key of ['DATABASE_URL', PRODUCT_ENV.home.name, PRODUCT_ENV.installationDir.name,
    'NOTICEOS_DEMO_VIEWER_FILE', PRODUCT_ENV.workerConfigRoot.name,
    PRODUCT_ENV.installationDir.legacy, PRODUCT_ENV.workerConfigRoot.legacy]) {
    assert.equal(await main(args, { env: { [key]: 'another-installation' }, err: { write() {} }, verifySource: () => assert.fail('Read after selector refusal') }), 1);
  }
});

test('store identity checks are read-only and close their pool on every refusal', async t => {
  const f = resources(t), databaseFile = path.join(f.installation.home, 'database.url'); fs.writeFileSync(databaseFile, 'synthetic-own-address');
  const installation = { ...f.installation, databaseFile, viewer: { workspaceId: 'own-workspace' }, assetIds: ['example.com'],
    projects: [{ asset: 'example.com', prefix: 'ex', database: 'demo_ex', projectId: '8b3adafa-0d35-8bd9-b981-7a238b7cf410' }],
    display: { 'config/tower.json': { countdown: { label: 'Portfolio review' } }, 'config/counters.json': { assets: {} } },
    integrations: { 'example.com': { ga4: { status: 'live', since: '2026-01-01' } } } };
  for (const defect of [null, 'workspace', 'profile', 'credentials', 'assets', 'documents', 'taskRoster', 'providerRoster', 'display']) {
    let closed = 0, transactions = 0;
    const store = { onlyWorkspace: async () => defect === 'workspace' ? 'another' : 'own-workspace', close: async () => { closed++; },
      inWorkspace: async (workspace, work, options) => {
        transactions++; assert.equal(workspace, 'own-workspace'); assert.deepEqual(options, { readOnly: true });
        return work({ query: async (sql, params) => {
          assert.match(sql, /^SELECT/u); assert.doesNotMatch(sql, /INSERT|UPDATE|DELETE|ALTER/u);
          if (sql.includes('current_setting')) return [{ profile: defect === 'profile' ? 'installation' : 'development', connections: defect === 'credentials' ? '1' : '0' }];
          if (sql.includes('assets')) return [{ asset_id: defect === 'assets' ? 'another.example' : 'example.com' }];
          assert.deepEqual(params, [['beads', 'integrations', 'tower', 'counters']]);
          if (defect === 'documents') return [];
          // SQL stores slug keys and JSON text; object key order is not identity.
          return [{ document_key: 'beads', body: JSON.stringify({ spokes: [{ database: 'demo_ex', prefix: defect === 'taskRoster' ? 'foreign' : 'ex', asset: 'example.com' }] }) },
            { document_key: 'integrations', body: JSON.stringify({ assets: { 'example.com': defect === 'providerRoster' ? { ga4: { status: 'live', since: '2026-01-01', propertyId: '1' } } : installation.integrations['example.com'] } }) },
            { document_key: 'tower', body: JSON.stringify(defect === 'display' ? {} : installation.display['config/tower.json']) },
            { document_key: 'counters', body: JSON.stringify(installation.display['config/counters.json']) }];
        } });
      } };
    if (defect) await assert.rejects(verifyDemoStore(installation, { open: () => store }));
    else await verifyDemoStore(installation, { open: () => store });
    assert.equal(closed, 1); assert.equal(transactions, defect === 'workspace' ? 0 : 1);
  }
});

test('runtime preparation writes only owned local configs, removes all crons and carries no provider bindings', t => {
  const f = resources(t), databaseFile = path.join(f.installation.home, 'database.url'); fs.writeFileSync(databaseFile, 'own-synthetic-address');
  const sourceConfig = { main: 'src/index.ts', name: 'synthetic-worker', triggers: { crons: ['* * * * *'] },
    hyperdrive: [{ binding: 'POSTGRES', id: '0'.repeat(32) }], r2_buckets: [{ binding: 'RAW_SIGNALS', bucket_name: 'noticeos-signals' }] };
  for (const relative of ['apps/tower/wrangler.jsonc', 'workers/ingest/wrangler.jsonc']) {
    const file = path.join(f.root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(sourceConfig));
  }
  const prepared = prepareDemoViewerRuntime({ ...f.installation, databaseFile, tree: '2'.repeat(40), viewer: { synthetic: true } },
    { root: f.root, port: 6200, node: process.execPath });
  for (const relative of ['apps/tower', 'workers/ingest']) {
    const config = JSON.parse(fs.readFileSync(path.join(prepared.runtime, relative, 'wrangler.jsonc'), 'utf8'));
    assert.deepEqual(config.triggers, { crons: [] });
    assert.deepEqual(config.hyperdrive, sourceConfig.hyperdrive);
    const vars = fs.readFileSync(path.join(prepared.runtime, relative, '.dev.vars'), 'utf8');
    assert.match(vars, /^OPERATOR_TOKEN=/u); assert.doesNotMatch(vars, /DATABASE_URL|GOOGLE|ASSET_TOKENS/u);
  }
  assert.deepEqual(fs.readdirSync(path.join(prepared.runtime, 'bin')), ['node']);
  const secretFile = path.join(f.installation.home, 'workers/ingest/.dev.secrets.json');
  const before = fs.readFileSync(secretFile);
  const again = prepareDemoViewerRuntime({ ...f.installation, databaseFile, tree: '2'.repeat(40), viewer: { synthetic: true } },
    { root: f.root, port: 6210 });
  assert.notEqual(again.runtime, prepared.runtime); assert.deepEqual(fs.readFileSync(secretFile), before);
  const badFile = path.join(f.root, 'apps/tower/wrangler.jsonc'); fs.writeFileSync(badFile, JSON.stringify({ ...sourceConfig, r2_buckets: [{ remote: true }] }));
  assert.throws(() => prepareDemoViewerRuntime({ ...f.installation, databaseFile }, { root: f.root, port: 6220 }), /remote bindings/u);
});

test('real viewer child output is private and redacted, and EOF records the actual result', async t => {
  const f = resources(t), runtime = path.join(f.installation.home, 'own-viewer'); fs.mkdirSync(runtime);
  const entry = path.join(f.root, 'apps/tower/node_modules/vite/bin/vite.js'); fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'process.stdout.write("Bearer synthetic-token\\n"); process.stderr.write(process.env.OPERATOR_TOKEN + "\\n" + process.env.DATABASE_URL + "\\n");\n');
  const secrets = { OPERATOR_TOKEN: 'synthetic-private-token', DATABASE_URL: 'postgresql://noticeos_app:synthetic-secret@127.0.0.1:6202/noticeos' };
  let publicOutput = '';
  const result = await serveDemoViewer({ root: f.root, prepared: { runtime, secrets, env: { ...secrets, PATH: '/usr/bin:/bin' } },
    durationMs: 5000, port: 6200, out: { write: value => { publicOutput += value; } } });
  assert.equal(result, 0); assert.equal(publicOutput, 'Synthetic viewer: http://127.0.0.1:6200/\n');
  const log = fs.readFileSync(path.join(runtime, 'viewer.log'), 'utf8'); assert.match(log, /REDACTED/u);
  assert.doesNotMatch(log, /synthetic-private-token|synthetic-secret|synthetic-token/u);
  const receipt = JSON.parse(fs.readFileSync(path.join(runtime, 'viewer-result.json'), 'utf8'));
  assert.equal(receipt.code, 0); assert.equal(receipt.stoppedByLauncher, false);
});

test('bounded viewer lifetime stops only its generated child process group', async t => {
  const f = resources(t), runtime = path.join(f.installation.home, 'own-viewer'); fs.mkdirSync(runtime);
  const entry = path.join(f.root, 'apps/tower/node_modules/vite/bin/vite.js'); fs.mkdirSync(path.dirname(entry), { recursive: true });
  const pidFile = path.join(runtime, 'synthetic-child.pid');
  fs.writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 10000);\n`);
  assert.equal(await serveDemoViewer({ root: f.root, prepared: { runtime, secrets: {}, env: { PATH: '/usr/bin:/bin' } }, durationMs: 1000, port: 6200, out: { write() {} } }), 0);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const receipt = JSON.parse(fs.readFileSync(path.join(runtime, 'viewer-result.json'), 'utf8')); assert.equal(receipt.stoppedByLauncher, true);
});

test('the actual CLI refuses incomplete arguments with exit one before any preparation', async () => {
  const result = await runCommand(process.execPath, [path.join(import.meta.dirname, 'demo-viewer.mjs')], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5000 });
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'The synthetic viewer could not verify its arguments.\n');
});

test('a generation reader forwards its exact base and exposes only its own stop handle', async t => {
  const f = resources(t), runtime = path.join(f.installation.home, 'based-viewer'); fs.mkdirSync(runtime);
  const entry = path.join(f.root, 'apps/tower/node_modules/vite/bin/vite.js'); fs.mkdirSync(path.dirname(entry), { recursive: true });
  const argsFile = path.join(runtime, 'argv.json');
  fs.writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2))); setInterval(() => {}, 10000);\n`);
  let handle;
  const base = `/generation/${'a'.repeat(64)}/`;
  const done = serveDemoViewer({ root: f.root, prepared: { runtime, secrets: {}, env: { PATH: '/usr/bin:/bin' } }, durationMs: 1000, port: 6200,
    base, out: { write() {} }, onStarted: value => { handle = value; } });
  assert.equal(Object.isFrozen(handle), true); assert.equal(Number.isInteger(handle.pid), true); await done;
  const args = JSON.parse(fs.readFileSync(argsFile, 'utf8')); assert.deepEqual(args.slice(-2), ['--base', base]);
  assert.throws(() => process.kill(handle.pid, 0), { code: 'ESRCH' });
  assert.throws(() => serveDemoViewer({ root: f.root, prepared: {}, base: '/ordinary/' }), /base is invalid/u);
});
