import assert from 'node:assert/strict';
import test from 'node:test';
import { localDocker, localDockerEndpoint } from './postgres-compose.mjs';

test('local Docker reads only selected context metadata and honors context over host override', async () => {
  for (const env of [{}, { DOCKER_HOST: 'unix:///own.sock' }, { DOCKER_HOST: 'ssh://remote', DOCKER_CONTEXT: 'local' }]) {
    const calls = [];
    assert.equal(await localDocker(async (binary, args, options) => (calls.push({ binary, args, options }), { code: 0, stdout: 'unix:///context.sock' }), { env }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].binary, 'docker');
    assert.deepEqual(calls[0].args.slice(0, 4), ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
    if (env.DOCKER_CONTEXT) assert.deepEqual(calls[0].args.slice(-2), ['--', 'local']);
  }
});

test('remote, ambiguous and failed Docker endpoints refuse without a resource request or raw error', async () => {
  for (const env of [{ DOCKER_HOST: 'ssh://remote' }, { DOCKER_HOST: 'unix:///own.sock', DOCKER_CONTEXT: 'remote' }, {}]) {
    assert.equal(await localDocker(async () => ({ code: 0, stdout: 'ssh://remote' }), { env }), false);
  }
  assert.equal(await localDocker(async () => ({ code: 1, stdout: 'unix:///context.sock' })), false);
  assert.equal(await localDocker(async () => { throw new Error('private detail'); }), false);
  assert.equal(await localDocker(async () => ({ code: 0, stdout: 'npipe:////./pipe/docker_engine' })), true);
});

test('validated local endpoint can be frozen for owned-resource creation and cleanup', async () => {
  const run = async () => ({ code: 0, stdout: 'unix:///selected-context.sock\n' });
  assert.equal(await localDockerEndpoint(run, { env: { DOCKER_CONTEXT: 'selected', DOCKER_HOST: 'ssh://ignored' } }), 'unix:///selected-context.sock');
  assert.equal(await localDockerEndpoint(run, { env: { DOCKER_HOST: 'unix:///explicit.sock' } }), 'unix:///explicit.sock');
  assert.equal(await localDockerEndpoint(async () => ({ code: 0, stdout: 'unix:///one.sock\nunix:///two.sock' }), { env: {} }), null);
  assert.equal(await localDockerEndpoint(run, { env: { DOCKER_HOST: 'unix:///one.sock\nssh://other' } }), null);
});
