import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appliedEnv, applyStack, describeChange, parseOptions, recordApplied } from './stack-apply.mjs';
import { parseDeclaredHashes, parseRunningHashes } from './stack-drift.mjs';
import { stackControl } from './stack-control.mjs';

const hash = (letter) => letter.repeat(64);
const SERVICES = ['postgres', 'dolt', 'backup', 'noticeos'];

/** A running stack and a Docker that answers for it; `declared` overrides a service's declared hash. */
function fixture(t, { declared = {}, model: change = (model) => model, failUp = () => false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nos-apply-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, 'installation.env');
  writeFileSync(envFile, 'NOTICEOS_TOWER_PORT="5173"\n');
  const compose = path.join(dir, 'stack.yaml');
  writeFileSync(compose, 'services: {}\n');
  const local = path.join(dir, 'local');
  mkdirSync(local);
  const selector = { project: 'noticeos', files: [compose], envFile, dockerHost: 'unix:///var/run/docker.sock' };
  const selectorFile = path.join(local, 'stack.json');
  writeFileSync(selectorFile, JSON.stringify(selector));
  const model = change({
    name: 'noticeos',
    services: {
      postgres: { ports: [{ host_ip: '127.0.0.1', target: 5432, published: '5432' }], volumes: [{ type: 'volume', source: 'postgres-data', target: '/var/lib/postgresql' }] },
      dolt: { ports: [{ host_ip: '127.0.0.1', target: 3306, published: '3306' }], volumes: [{ type: 'volume', source: 'dolt-data', target: '/var/lib/dolt' }] },
      backup: { volumes: [] },
      noticeos: { user: '501:20', environment: { TOWER_ALLOWED_HOSTS: '' }, ports: [{ host_ip: '127.0.0.1', target: 5173, published: '5173' }],
        volumes: [{ type: 'bind', source: '/srv/n/state', target: '/state' }] },
    },
    volumes: { 'postgres-data': { name: 'noticeos_postgres-data' }, 'dolt-data': { name: 'noticeos_dolt-data' } },
  });
  const containers = {
    postgres: { HostConfig: { PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] } }, Config: { Env: [] }, Mounts: [{ Type: 'volume', Name: 'noticeos_postgres-data', Destination: '/var/lib/postgresql' }] },
    dolt: { HostConfig: { PortBindings: { '3306/tcp': [{ HostIp: '127.0.0.1', HostPort: '3306' }] } }, Config: { Env: [] }, Mounts: [{ Type: 'volume', Name: 'noticeos_dolt-data', Destination: '/var/lib/dolt' }] },
    backup: { HostConfig: { PortBindings: {} }, Config: { Env: [] }, Mounts: [] },
    noticeos: { HostConfig: { PortBindings: { '5173/tcp': [{ HostIp: '127.0.0.1', HostPort: '5173' }] } }, Config: { User: '501:20', Env: ['TOWER_ALLOWED_HOSTS=', 'PATH=/usr/bin'] },
      Mounts: [{ Type: 'bind', Source: '/srv/n/state', Destination: '/state' }] },
  };
  const calls = [];
  const run = async (command, args) => {
    const words = args.join(' ');
    calls.push(words);
    if (words.includes('config --hash')) return { code: 0, stdout: SERVICES.map((name) => `${name} ${declared[name] ?? hash('a')}`).join('\n') };
    if (args.includes('ps')) {
      return { code: 0, stdout: SERVICES.map((name, index) => JSON.stringify({ Project: 'noticeos', Service: name, ID: String(index + 1).repeat(12), State: 'running', Health: 'healthy',
        Labels: `com.docker.compose.project=noticeos,com.docker.compose.config-hash=${hash('a')},com.docker.compose.service=${name}` })).join('\n') };
    }
    if (words.includes('config --format json')) return { code: 0, stdout: JSON.stringify(model) };
    if (args[2] === 'inspect') return { code: 0, stdout: JSON.stringify([containers[SERVICES[Number(args[3][0]) - 1]]]) };
    if (args.includes('up')) return { code: failUp(args) ? 1 : 0, stdout: '' };
    return { code: 0, stdout: '' };
  };
  return { dir, selector, selectorFile, envFile, calls, run };
}

const quiet = { write() {} };
const options = (box, ...argv) => parseOptions(['--config', box.selectorFile, ...argv]);
const steps = (box) => box.calls.filter((line) => / (stop|up) /u.test(line)).map((line) => {
  const words = line.split(' ');
  const at = words.findIndex((word) => word === 'stop' || word === 'up');
  return `${words[at]} ${words.slice(at + 1).filter((word) => !word.startsWith('-') && !/^\d+$/u.test(word) && word !== 'never').join(' ')}`;
});

test('Compose\'s two hashes are read as written: one per declared service, one per container', () => {
  assert.deepEqual([...parseDeclaredHashes(`app ${hash('b')}\ndb ${hash('c')}\n`)], [['app', hash('b')], ['db', hash('c')]]);
  assert.throws(() => parseDeclaredHashes('app not-a-hash'), /unexpected service hash/u);
  const running = parseRunningHashes(`${JSON.stringify({ Service: 'app', ID: 'x', State: 'running', Labels: `a=b,com.docker.compose.config-hash=${hash('d')}` })}\n${JSON.stringify({ Service: 'job', OneOff: true })}`);
  assert.deepEqual([...running.keys()], ['app']);
  assert.equal(running.get('app').hash, hash('d'));
});

test('a change is named in the operator\'s terms: ports, settings, user and folders', () => {
  const container = { HostConfig: { PortBindings: { '5173/tcp': [{ HostIp: '127.0.0.1', HostPort: '5173' }] } }, Config: { User: '501:20', Env: ['TOWER_ALLOWED_HOSTS='] },
    Mounts: [{ Type: 'bind', Source: '/old/state', Destination: '/state' }, { Type: 'volume', Name: 'noticeos_data', Destination: '/data' }] };
  const service = { user: '502:20', environment: { TOWER_ALLOWED_HOSTS: 'tower.example.com' }, ports: [{ host_ip: '127.0.0.1', target: 5173, published: '5180' }],
    volumes: [{ type: 'bind', source: '/new/state', target: '/state' }, { type: 'volume', source: 'data', target: '/data' }, { type: 'tmpfs', target: '/tmp' }] };
  assert.deepEqual(describeChange('noticeos', container, service, { data: { name: 'noticeos_data' } }), [
    'noticeos: port 127.0.0.1:5173->5173 becomes 127.0.0.1:5180->5173',
    'noticeos: TOWER_ALLOWED_HOSTS "" becomes "tower.example.com"',
    'noticeos: runs as 502:20 instead of 501:20',
    'noticeos: /state comes from /new/state instead of /old/state',
  ]);
});

test('with nothing to apply it says so and records the settings the stack runs with', async (t) => {
  const box = fixture(t);
  let shown = '';
  assert.equal(await applyStack(options(box), { run: box.run, out: { write: (text) => { shown += text; } }, interactive: false }), 0);
  assert.match(shown, /Nothing to apply/u);
  assert.equal(readFileSync(appliedEnv(box.selectorFile, box.selector), 'utf8'), readFileSync(box.envFile, 'utf8'));
  assert.deepEqual(steps(box), []);
});

test('the plan names the change and recreates nothing until apply is typed', async (t) => {
  const box = fixture(t, { declared: { noticeos: hash('b') }, model: (model) => {
    model.services.noticeos.ports[0].published = '5180';
    model.services.noticeos.environment.TOWER_ALLOWED_HOSTS = 'tower.example.com';
    return model;
  } });
  let shown = '';
  assert.equal(await applyStack(options(box), { run: box.run, out: { write: (text) => { shown += text; } }, interactive: false, held: async () => false }), 0);
  assert.match(shown, /noticeos: port 127\.0\.0\.1:5173->5173 becomes 127\.0\.0\.1:5180->5173/u);
  assert.match(shown, /Recreated: noticeos\./u);
  assert.match(shown, /No earlier settings are recorded/u);
  assert.match(shown, /To apply it: pnpm os:apply -- --confirm apply/u);
  assert.deepEqual(steps(box), []);

  await applyStack(options(box, '--confirm', 'apply'), { run: box.run, out: quiet, interactive: false, held: async () => false });
  assert.deepEqual(steps(box), ['up noticeos']);
  assert.ok(appliedEnv(box.selectorFile, box.selector), 'a successful apply records its settings');
});

test('opening the Tower to the network says plainly that it has no login', async (t) => {
  const box = fixture(t, { declared: { noticeos: hash('b') }, model: (model) => { model.services.noticeos.ports[0].host_ip = '0.0.0.0'; return model; } });
  let shown = '';
  await applyStack(options(box), { run: box.run, out: { write: (text) => { shown += text; } }, interactive: false, held: async () => false });
  assert.match(shown, /noticeos: port 127\.0\.0\.1:5173->5173 becomes 0\.0\.0\.0:5173->5173/u);
  assert.match(shown, /answer other devices on your network\. It has no login/u);
});

test('a database change stops the app and backup worker, then brings each layer back in order', async (t) => {
  const box = fixture(t, { declared: { postgres: hash('b') }, model: (model) => { model.services.postgres.ports[0].published = '5440'; return model; } });
  await applyStack(options(box, '--confirm', 'apply'), { run: box.run, out: quiet, interactive: false, held: async () => false });
  assert.deepEqual(steps(box), ['stop noticeos backup', 'up postgres dolt', 'up backup', 'up noticeos']);
});

test('what apply never does: point a database at other data, rename the project, take a held port, create a service', async (t) => {
  const refused = async (box, pattern, held = async () => false) => {
    await assert.rejects(applyStack(options(box, '--confirm', 'apply'), { run: box.run, out: quiet, interactive: false, held }), pattern);
    assert.deepEqual(steps(box), []);
  };
  await refused(fixture(t, { declared: { postgres: hash('b') }, model: (model) => { model.volumes['postgres-data'].name = 'other_data'; return model; } }),
    /postgres's data would come from other_data instead of noticeos_postgres-data; apply never points a database at other data/u);
  await refused(fixture(t, { declared: { noticeos: hash('b') }, model: (model) => ({ ...model, name: 'renamed' }) }), /names the project renamed, but the stack is noticeos/u);
  await refused(fixture(t, { declared: { noticeos: hash('b') }, model: (model) => { model.services.noticeos.ports[0].published = '5180'; return model; } }),
    /port 5180 is in use/u, async () => true);
});

test('a service that does not become healthy returns the stack to its last applied settings; installation.env stays as edited', async (t) => {
  // Only the edited settings fail; the recorded ones bring the stack back.
  const box = fixture(t, { declared: { noticeos: hash('b') }, failUp: (args) => args[args.indexOf('--env-file') + 1]?.endsWith('installation.env') });
  writeFileSync(box.envFile, 'NOTICEOS_TOWER_PORT="5173"\n');
  recordApplied(box.selectorFile, box.selector);
  writeFileSync(box.envFile, 'NOTICEOS_TOWER_PORT="5180"\n');
  await assert.rejects(applyStack(options(box, '--confirm', 'apply'), { run: box.run, out: quiet, interactive: false, held: async () => false }),
    /The stack runs with its earlier settings again; installation\.env stays as you edited it\./u);
  const ups = box.calls.filter((line) => / up /u.test(line));
  assert.ok(ups[0].includes(box.envFile));
  assert.ok(ups.slice(1).every((line) => line.includes(path.join(box.dir, 'local', 'stack-apply', 'applied.env'))), ups.join('\n'));
  assert.equal(readFileSync(box.envFile, 'utf8'), 'NOTICEOS_TOWER_PORT="5180"\n');
  assert.equal(readFileSync(appliedEnv(box.selectorFile, box.selector), 'utf8'), 'NOTICEOS_TOWER_PORT="5173"\n', 'a failed apply records nothing');

  const bare = fixture(t, { declared: { noticeos: hash('b') }, failUp: () => true });
  await assert.rejects(applyStack(options(bare, '--confirm', 'apply'), { run: bare.run, out: quiet, interactive: false, held: async () => false }),
    /undo the edit and run pnpm os:apply again/u);
});

test('recorded settings belong to one installation.env, unchanged since they were recorded', (t) => {
  const box = fixture(t);
  recordApplied(box.selectorFile, box.selector);
  assert.ok(appliedEnv(box.selectorFile, box.selector));
  assert.equal(appliedEnv(box.selectorFile, { ...box.selector, envFile: path.join(box.dir, 'other.env') }), null);
  writeFileSync(path.join(box.dir, 'local', 'stack-apply', 'applied.env'), 'tampered\n');
  assert.equal(appliedEnv(box.selectorFile, box.selector), null);
});

test('status says when a service does not run as installation.env declares', async (t) => {
  const box = fixture(t, { declared: { noticeos: hash('b') } });
  let shown = '';
  const run = async (command, args) => {
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${'c'.repeat(40)}\n` };
    if (args.includes('--format') && args.includes('{{json .Config.Labels}}')) {
      return { code: 0, stdout: JSON.stringify({ 'com.docker.compose.project': 'noticeos', 'com.docker.compose.service': 'noticeos' }) };
    }
    return box.run(command, args);
  };
  await stackControl('status', box.selector, { run, out: { write: (text) => { shown += text; } }, database: async () => ({ ok: true }) });
  assert.match(shown, /settings: noticeos does not run as installation\.env declares; pnpm os:apply shows the change/u);
});
