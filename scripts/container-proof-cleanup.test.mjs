import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { containerProofCleanup } from './container-proof-cleanup.mjs';
import { runCommand } from './run-command.mjs';
import { localDockerEndpoint } from './postgres-compose.mjs';

const project = 'noticeos-start-1234567890abcdef';
const image = 'noticeos-local:compose-proof-cleanup';
const id = 'a'.repeat(64);
const replacementId = 'b'.repeat(64);
const ok = (stdout = '', stderr = '') => ({ code: 0, stdout, stderr });
function fixture(t, overrides = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-cleanup-unit-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(base, 'fixture-data'), 'preserve until absence is proven');
  const mounts = [{ source: path.join(base, 'state'), destination: '/state' }];
  const calls = [];
  let container = null;
  let network = false;
  const metadata = name => ({ id, name: `/${name}`, image,
    labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': 'noticeos', 'com.docker.compose.oneoff': 'True' },
    mounts: [{ Type: 'bind', Source: mounts[0].source, Destination: '/state' }], ports: {} });
  const runDocker = async (args, options) => {
    calls.push({ args, options });
    const override = overrides.command?.(args, { container, network });
    if (override !== undefined) return override;
    const operation = args.slice(0, 2).join(' ');
    if (operation === 'container ls') return ok(container ? `${container.id}\n` : '');
    if (operation === 'network ls') return ok(network ? `${'c'.repeat(64)}\n` : '');
    if (operation === 'container inspect') return ok(JSON.stringify(container));
    if (operation === 'container wait') return overrides.wait ?? ok('1\n');
    if (operation === 'container logs') return ok('REFUSING to start\n', 'container refused\n');
    if (operation === 'container rm') { assert.equal(args[3], container.id); container = null; return ok(); }
    assert.fail(`unexpected Docker operation: ${operation}`);
  };
  const cleanup = containerProofCleanup({ base, project, image, mounts, runDocker });
  const launch = async args => {
    calls.push({ args, launch: true });
    assert.deepEqual(args.slice(0, 4), ['run', '--detach', '--no-deps', '--name']);
    assert.equal(args.includes('--rm'), false);
    container = metadata(args[4]);
    overrides.container?.(container);
    network = true;
    return overrides.start ?? ok(`${id}\n`);
  };
  const down = async () => { calls.push({ teardown: true }); network = false; return ok(); };
  const receipt = () => JSON.parse(fs.readFileSync(path.join(base, 'cleanup-receipt.json'), 'utf8'));
  return { base, calls, cleanup, launch, down, receipt, setContainer(value) { container = value; }, setNetwork(value) { network = value; } };
}

test('a timed-out wait removes its named one-off by verified ID before deleting fixture data', async t => {
  const f = fixture(t, { wait: { code: 124, timedOut: true, stdout: '', stderr: '' } });
  await f.cleanup.proveFresh();
  const result = await f.cleanup.oneOff(f.launch, { timeoutMs: 25 });
  assert.equal(result.code, 124); assert.equal(result.timedOut, true);
  const removal = f.calls.findIndex(call => call.args?.[1] === 'rm');
  assert.deepEqual(f.calls[removal].args, ['container', 'rm', '--force', id]);
  assert.ok(f.calls.slice(removal + 1).some(call => call.args?.[1] === 'ls'));
  assert.ok(fs.existsSync(path.join(f.base, 'fixture-data')));
  assert.equal(f.receipt().oneOffs[0].absent, true);
  await f.cleanup.finish([f.down]);
  assert.equal(fs.existsSync(f.base), false);
});

test('a completed refusal retains native exit status and both log streams until retirement', async t => {
  const f = fixture(t);
  const result = await f.cleanup.oneOff(f.launch);
  assert.equal(result.code, 1); assert.equal(result.timedOut, false);
  assert.match(result.stdout, /REFUSING/); assert.match(result.stderr, /container refused/);
  assert.ok(f.calls.findIndex(call => call.args?.[1] === 'logs') < f.calls.findIndex(call => call.args?.[1] === 'rm'));
  await f.cleanup.finish([f.down]);
});

test('creation timeout retires any known container but preserves files for uncertain late creation', async t => {
  const f = fixture(t, { start: { code: 124, timedOut: true, stdout: '', stderr: '' } });
  await assert.rejects(f.cleanup.oneOff(f.launch), /creation timed out/);
  assert.ok(f.calls.some(call => call.args?.[1] === 'rm'));
  await assert.rejects(f.cleanup.finish([f.down]), /preserved fixture/);
  assert.ok(fs.existsSync(path.join(f.base, 'fixture-data')));
  assert.equal(f.calls.some(call => call.teardown), false, 'uncertain creation also prevents Compose teardown');
  assert.match(f.receipt().failures.join(' '), /creation timed out/);
  assert.equal(fs.statSync(path.join(f.base, 'cleanup-receipt.json')).mode & 0o777, 0o600);
});

test('an absence-check daemon refusal preserves files instead of meaning not found', async t => {
  let refusing = false;
  const f = fixture(t, { command: args => refusing && args[1] === 'ls' ? { code: 1, stdout: '', stderr: 'daemon unavailable' } : undefined });
  await f.cleanup.proveFresh();
  refusing = true;
  await assert.rejects(f.cleanup.finish([f.down]), /preserved fixture/);
  assert.ok(fs.existsSync(path.join(f.base, 'fixture-data')));
  assert.match(f.receipt().failures.join(' '), /verify resource absence/);
});

for (const [field, mutate] of [
  ['foreign project', container => { container.labels['com.docker.compose.project'] = 'foreign'; }],
  ['foreign image', container => { container.image = 'foreign-image'; }],
  ['replacement service', container => { container.labels['com.docker.compose.oneoff'] = 'False'; }],
  ['foreign bind source', container => { container.mounts[0].Source = '/foreign'; }],
  ['published port', container => { container.ports = { '5173/tcp': [{ HostPort: '5173' }] }; }],
]) {
  test(`cleanup refuses ${field} without removing that container`, async t => {
    const f = fixture(t, { container: mutate });
    await assert.rejects(f.cleanup.oneOff(f.launch), /outside its declared ownership/);
    await assert.rejects(f.cleanup.finish([f.down]), /preserved fixture/);
    assert.equal(f.calls.some(call => call.args?.[1] === 'rm'), false);
    assert.equal(f.calls.some(call => call.teardown), false, 'Compose cannot bypass the ownership refusal');
    assert.ok(fs.existsSync(path.join(f.base, 'fixture-data')));
  });
}

test('a replacement under the same name is never removed after the original ID was recorded', async t => {
  const f = fixture(t, { command: (args, state) => {
    if (args[1] === 'logs') state.container.id = replacementId;
    return undefined;
  } });
  await assert.rejects(f.cleanup.oneOff(f.launch), /outside its declared ownership/);
  assert.equal(f.calls.some(call => call.args?.[1] === 'rm'), false);
  await assert.rejects(f.cleanup.finish([f.down]), /preserved fixture/);
  assert.equal(f.calls.some(call => call.teardown), false);
});

test('ownership refusal still permits removing another independently verified one-off', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-cleanup-independent-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const containers = new Map(); const removed = [];
  const cleanup = containerProofCleanup({ base, project, image, mounts: [], runDocker: async args => {
    if (args[1] === 'ls') {
      const filter = args[args.indexOf('--filter') + 1];
      return ok([...containers.values()].filter(row => filter.startsWith('label=') || filter === `name=^${row.name}$`).map(row => row.id).join('\n'));
    }
    if (args[1] === 'inspect') return ok(JSON.stringify([...containers.values()].find(row => row.id === args[2])));
    if (args[1] === 'rm') { removed.push(args[3]); for (const [name, row] of containers) if (row.id === args[3]) containers.delete(name); return ok(); }
    if (args[1] === 'wait') return ok('1\n');
    if (args[1] === 'logs') return ok();
    assert.fail('unexpected resource command');
  } });
  let count = 0;
  const launch = async args => {
    const name = args[4]; count++;
    containers.set(name, { id: count === 1 ? id : replacementId, name: `/${name}`, image, mounts: [], ports: {},
      labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': 'noticeos', 'com.docker.compose.oneoff': count === 1 ? 'False' : 'True' } });
    return ok();
  };
  await assert.rejects(cleanup.oneOff(launch), /outside its declared ownership/);
  assert.equal((await cleanup.oneOff(launch)).code, 1);
  let teardown = false;
  await assert.rejects(cleanup.finish([async () => { teardown = true; return ok(); }]), /preserved fixture/);
  assert.deepEqual(removed, [replacementId]); assert.equal(teardown, false); assert.equal(containers.size, 1);
});

test('an untracked project container blocks fixture deletion without being removed', async t => {
  const f = fixture(t);
  f.setContainer({ id: replacementId });
  await assert.rejects(f.cleanup.finish([f.down]), /preserved fixture/);
  assert.equal(f.calls.some(call => call.args?.[1] === 'rm'), false);
  assert.match(f.receipt().failures.join(' '), /still has containers/);
});

test('a network remaining after successful down blocks fixture deletion', async t => {
  const f = fixture(t); f.setNetwork(true);
  await assert.rejects(f.cleanup.finish([async () => ok()]), /preserved fixture/);
  assert.match(f.receipt().failures.join(' '), /network remains/);
  assert.ok(fs.existsSync(path.join(f.base, 'fixture-data')));
});

test('teardown failure still attempts other owned teardowns and preserves the evidence', async t => {
  const f = fixture(t);
  let next = false;
  await assert.rejects(f.cleanup.finish([async () => ({ code: 124, timedOut: true }), async () => { next = true; return ok(); }]), /preserved fixture/);
  assert.equal(next, true); assert.ok(fs.existsSync(path.join(f.base, 'fixture-data')));
});

test('unexpected command exceptions cannot bypass the absence barrier', async t => {
  const f = fixture(t, { command: () => { throw new Error('untrusted process diagnostic'); } });
  await assert.rejects(f.cleanup.finish([f.down]), /preserved fixture/);
  assert.ok(fs.existsSync(path.join(f.base, 'fixture-data')));
  assert.equal(JSON.stringify(f.receipt()).includes('untrusted process diagnostic'), false);
});

// Opt in with an explicitly named, already-cached application proof image.
// Its entrypoint only runs a timer; no app, store or provider starts.
test('real detached one-off cleanup survives a wait timeout and removes its internal network', {
  skip: process.env.NOTICEOS_TEST_CONTAINER_CLEANUP !== '1', timeout: 60_000,
}, async t => {
  const baseImage = process.env.NOTICEOS_TEST_CLEANUP_BASE_IMAGE;
  assert.match(baseImage ?? '', /^noticeos-local:compose-proof-[a-z0-9]+$/u);
  const env = Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'TMPDIR', 'LANG'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const endpoint = await localDockerEndpoint(runCommand, { env });
  assert.ok(endpoint, 'prove a local Docker endpoint before resource requests');
  env.DOCKER_HOST = endpoint;
  const docker = (args, options = {}) => runCommand('docker', args, { env, timeoutMs: 30_000, ...options });
  const sourceImage = await docker(['image', 'inspect', baseImage, '--format', '{{.Id}}']);
  assert.equal(sourceImage.code, 0, 'use only the explicitly cached proof image');
  assert.match(sourceImage.stdout.trim(), /^sha256:[a-f0-9]{64}$/u);
  const nonce = randomBytes(8).toString('hex');
  const project = `noticeos-start-${nonce}`;
  const image = sourceImage.stdout.trim();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'noticeos-cleanup-compose-'));
  const base = path.join(parent, 'fixture'); fs.mkdirSync(base, { mode: 0o700 });
  const data = path.join(base, 'data'); fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(path.join(data, 'owned'), 'synthetic fixture');
  const composeFile = path.join(base, 'compose.json');
  fs.writeFileSync(composeFile, JSON.stringify({ services: { noticeos: { image, pull_policy: 'never', read_only: true,
    entrypoint: ['node'], command: ['-e', 'setInterval(() => {}, 1000)'], volumes: [`${data}:/fixture:ro`] } },
    networks: { default: { name: `${project}_default`, internal: true } } }), { mode: 0o600 });
  const compose = args => docker(['compose', '-p', project, '-f', composeFile, '--env-file', os.devNull, ...args]);
  const cleanup = containerProofCleanup({ base, project, image, mounts: [{ source: data, destination: '/fixture' }], runDocker: docker });
  let fresh = false; let completed = false;
  t.after(async () => {
    if (fresh && !completed) await cleanup.finish([() => compose(['down'])]);
    fs.rmSync(parent, { recursive: true, force: true });
  });
  await cleanup.proveFresh(); fresh = true;
  const result = await cleanup.oneOff(async args => {
    const started = await compose(args);
    const internal = await docker(['network', 'inspect', `${project}_default`, '--format', '{{.Internal}}']);
    assert.equal(internal.code, 0); assert.equal(internal.stdout.trim(), 'true');
    return started;
  }, { timeoutMs: 100 });
  assert.equal(result.code, 124); assert.equal(result.timedOut, true);
  assert.ok(fs.existsSync(path.join(data, 'owned')), 'data remains until project absence is proven');
  const proof = await cleanup.finish([() => compose(['down'])]); completed = true;
  assert.equal(proof.complete, true); assert.equal(proof.oneOffs.length, 1); assert.equal(proof.oneOffs[0].absent, true);
  assert.equal(fs.existsSync(base), false);
  t.diagnostic(JSON.stringify({ ...proof, image, internalNetwork: true }));
});
