import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { v4Miniflare } from './miniflare-v4.mjs';

const require = createRequire(new URL('../workers/ingest/package.json', import.meta.url));
const wrangler = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, Log } = v4Miniflare(wrangler);
const { buildSync } = wrangler('esbuild');
const script = buildSync({
  stdin: {
    contents: `
      import { checkLocalModel, discoverLocalModels, generateLocalModel } from './workers/ingest/src/local-model.ts';
      import { connectionFailureLabel } from './packages/contract/src/integrations.ts';
      export default { async fetch(request, env) {
        try {
          if (new URL(request.url).pathname === '/generate') {
            return Response.json(await generateLocalModel({ NOTICEOS_WORKSPACE_PROFILE: 'standalone' }, {
              LOCAL_MODEL_BASE_URL: env.BASE, LOCAL_MODEL_ID: 'fixture-model', LOCAL_MODEL_API_TOKEN: 'fixture-token'
            }, { messages: [{ role: 'user', content: 'Fixture' }] }));
          }
          if (new URL(request.url).pathname === '/discover') {
            return Response.json(await discoverLocalModels({ NOTICEOS_WORKSPACE_PROFILE: 'standalone' }, {
              fields: { LOCAL_MODEL_BASE_URL: env.BASE }
            }));
          }
          if (new URL(request.url).pathname === '/discover-failure') {
            const result = await discoverLocalModels({ NOTICEOS_WORKSPACE_PROFILE: 'standalone' }, {
              fields: { LOCAL_MODEL_BASE_URL: env.BASE, LOCAL_MODEL_API_TOKEN: 'fixture-secret-token' }
            });
            return Response.json({ result, ...(!result.ok ? { label: connectionFailureLabel(result.failure) } : {}) });
          }
          await checkLocalModel({ NOTICEOS_WORKSPACE_PROFILE: 'standalone' }, {
            LOCAL_MODEL_BASE_URL: env.BASE, LOCAL_MODEL_ID: 'fixture-model'
          });
          return Response.json({ connected: true });
        } catch (error) {
          return Response.json({ code: error.code, failure: error.failure }, { status: 502 });
        }
      } };
    `,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    sourcefile: 'local-model-native.fixture.ts', loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false,
}).outputFiles[0].text;

test('local-model discovery uses native workerd HTTP on a private address and preserves its port and path', { timeout: 30_000 }, async t => {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push({ path: request.url, method: request.method, authorization: request.headers.authorization });
    if (request.url.startsWith('/redirect/')) {
      response.writeHead(302, { Location: '/v1/models' });
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.method === 'POST'
      ? { choices: [{ finish_reason: 'stop', message: { content: 'Fixture answer.' } }] }
      : { data: [{ id: 'fixture-model' }] }));
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = new Miniflare({
    modules: true, script, compatibilityDate: '2026-07-06',
    compatibilityFlags: ['nodejs_compat'], cf: false, log: new Log(0),
    bindings: { BASE: `http://127.0.0.1:${server.address().port}/v1` },
    handleStructuredLogs: () => {},
  });
  t.after(() => runtime.dispose());
  const response = await runtime.dispatchFetch('http://fixture.invalid/');
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body, { connected: true });
  assert.deepEqual(calls, [{ path: '/v1/models', method: 'GET', authorization: undefined }]);
  const discovery = await runtime.dispatchFetch('http://fixture.invalid/discover');
  assert.deepEqual(await discovery.json(), { ok: true, models: ['fixture-model'] });
  const generated = await runtime.dispatchFetch('http://fixture.invalid/generate');
  assert.equal(await generated.json(), 'Fixture answer.');
  assert.deepEqual(calls.map(call => call.path), ['/v1/models', '/v1/models', '/v1/chat/completions']);
  assert.deepEqual(calls[2], { path: '/v1/chat/completions', method: 'POST', authorization: 'Bearer fixture-token' });
  await runtime.setOptions({
    modules: true, script, compatibilityDate: '2026-07-06',
    compatibilityFlags: ['nodejs_compat'], cf: false, log: new Log(0),
    bindings: { BASE: `http://127.0.0.1:${server.address().port}/redirect/v1` },
    handleStructuredLogs: () => {},
  });
  const redirected = await runtime.dispatchFetch('http://fixture.invalid/');
  assert.equal(redirected.status, 502);
  assert.equal((await redirected.json()).code, 'redirect');
  const redirectedGeneration = await runtime.dispatchFetch('http://fixture.invalid/generate');
  assert.equal(redirectedGeneration.status, 502);
  assert.equal((await redirectedGeneration.json()).code, 'redirect');
  assert.deepEqual(calls.map(call => call.path), [
    '/v1/models', '/v1/models', '/v1/chat/completions', '/redirect/v1/models', '/redirect/v1/chat/completions',
  ]);
});

test('native workerd closed-port discovery returns a safe generic network failure', { timeout: 30_000 }, async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const runtime = new Miniflare({
    modules: true, script, compatibilityDate: '2026-07-06',
    compatibilityFlags: ['nodejs_compat'], cf: false, log: new Log(0),
    bindings: { BASE: `http://127.0.0.1:${port}/v1` },
    handleStructuredLogs: () => {},
  });
  t.after(() => runtime.dispose());
  const response = await runtime.dispatchFetch('http://fixture.invalid/discover-failure');
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);
  assert.deepEqual(body.result, { ok: false, failure: { kind: 'network' } });
  assert.equal(body.label, 'Connection failed');
  for (const detail of ['fixture-secret-token', '127.0.0.1', String(port), 'DISCONNECTED', 'TypeError', 'stack', 'cause']) {
    assert.ok(!text.includes(detail), `Public response exposed ${detail}`);
  }
});
