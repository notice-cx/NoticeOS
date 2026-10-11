import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dockerPortFree, imageInstallation, onInstallationNetwork } from './image-installation.mjs';
import { publishedRevision } from './published-image.mjs';

test('the commands know they run from an image only when the launcher says so, and name its launcher', () => {
  assert.equal(imageInstallation({}), null);
  assert.equal(imageInstallation({ NOTICEOS_DIR: '/srv/noticeos' }), null);
  assert.deepEqual(imageInstallation({ NOTICEOS_CLI_IMAGE: 'ghcr.io/example/noticeos:main', NOTICEOS_DIR: '/srv/noticeos' }),
    { image: 'ghcr.io/example/noticeos:main', dir: '/srv/noticeos', launcher: '/srv/noticeos/noticeos' });
  assert.equal(imageInstallation({ NOTICEOS_CLI_IMAGE: 'x', NOTICEOS_DIR: '/srv/noticeos', NOTICEOS_LAUNCHER: './noticeos' }).launcher, './noticeos');
  assert.throws(() => imageInstallation({ NOTICEOS_CLI_IMAGE: 'x', NOTICEOS_DIR: 'relative' }), /invalid installation folder/u);
});

test('a port is free when Docker can publish it; taken when Docker says so; anything else is not a guess', async () => {
  const calls = [];
  const answer = (code, stderr = '') => async (command, args) => { calls.push(args); return { code, stderr }; };
  const options = { dockerHost: 'unix:///var/run/docker.sock', image: 'sha256:' + 'a'.repeat(64), env: {} };
  assert.equal(await dockerPortFree(5173, { ...options, run: answer(0) }), true);
  assert.deepEqual(calls[0].slice(0, 2), ['--host', 'unix:///var/run/docker.sock']);
  assert.ok(calls[0].includes('127.0.0.1:5173:9'), calls[0].join(' '));
  assert.equal(await dockerPortFree(5432, { ...options, address: '0.0.0.0', run: answer(125, 'Bind for 0.0.0.0:5432 failed: port is already allocated') }), false);
  assert.ok(calls[1].includes('0.0.0.0:5432:9'));
  assert.equal(await dockerPortFree(3306, { ...options, run: answer(125, 'ports are not available: listen tcp 127.0.0.1:3306: bind: address already in use') }), false);
  await assert.rejects(dockerPortFree(3307, { ...options, run: answer(125, 'Unable to find image') }), /could not test whether port 3307/u);
});

test('Postgres is reached by its service name on the installation network', () => {
  const address = { url: 'postgresql://owner:secret@127.0.0.1:5433/noticeos', database: 'noticeos', where: '/x/owner.url' };
  assert.deepEqual(onInstallationNetwork(address), { ...address, url: 'postgresql://owner:secret@postgres:5432/noticeos' });
});

/** A registry that answers the given paths with JSON, and anything else with 404. */
function registry(routes) {
  const asked = [];
  return {
    asked,
    fetch: async (url, init = {}) => {
      asked.push({ url: String(url), accept: init.headers?.Accept ?? null, auth: init.headers?.Authorization ?? null });
      const path = new URL(url).pathname + new URL(url).search;
      const body = routes[path];
      return body === undefined ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => body };
    },
  };
}

test('the newest published commit is read from the index annotation, with an anonymous pull token', async () => {
  const commit = 'c'.repeat(40);
  const own = registry({
    '/token?scope=repository:example/noticeos:pull': { token: 'anonymous' },
    '/v2/example/noticeos/manifests/main': { annotations: { 'org.opencontainers.image.revision': commit }, manifests: [] },
  });
  assert.equal(await publishedRevision({ repository: 'ghcr.io/example/noticeos', fetch: own.fetch }), commit);
  assert.equal(own.asked[1].auth, 'Bearer anonymous');
  assert.match(own.asked[1].accept, /image\.index/u);
});

test('an index without the annotation is read through one Linux image\'s configuration', async () => {
  const commit = 'd'.repeat(40);
  const linux = `sha256:${'1'.repeat(64)}`;
  const config = `sha256:${'2'.repeat(64)}`;
  const own = registry({
    '/token?scope=repository:example/noticeos:pull': { token: 't' },
    '/v2/example/noticeos/manifests/main': { manifests: [{ digest: `sha256:${'0'.repeat(64)}`, platform: { os: 'unknown' } }, { digest: linux, platform: { os: 'linux', architecture: 'arm64' } }] },
    [`/v2/example/noticeos/manifests/${linux}`]: { config: { digest: config } },
    [`/v2/example/noticeos/blobs/${config}`]: { config: { Labels: { 'org.opencontainers.image.revision': commit } } },
  });
  assert.equal(await publishedRevision({ repository: 'ghcr.io/example/noticeos', fetch: own.fetch }), commit);
});

test('a registry that is private, unreachable or says nothing usable gives no answer rather than a guess', async () => {
  assert.equal(await publishedRevision({ repository: 'ghcr.io/example/noticeos', fetch: registry({}).fetch }), null);
  assert.equal(await publishedRevision({ repository: 'ghcr.io/example/noticeos', fetch: async () => { throw new Error('offline'); } }), null);
  const odd = registry({
    '/token?scope=repository:example/noticeos:pull': { token: 't' },
    '/v2/example/noticeos/manifests/main': { annotations: { 'org.opencontainers.image.revision': 'not-a-commit' } },
  });
  assert.equal(await publishedRevision({ repository: 'ghcr.io/example/noticeos', fetch: odd.fetch }), null);
});
