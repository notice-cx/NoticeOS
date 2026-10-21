import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(new URL('../workers/ingest/package.json', import.meta.url));
const wrangler = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, Log } = wrangler('miniflare');
const { buildSync } = wrangler('esbuild');
const account = 'a'.repeat(32), database = '11111111-1111-4111-8111-111111111111';
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database?page=1&per_page=100`;
const script = buildSync({
  stdin: {
    contents: `
      import { listD1Databases } from './workers/ingest/src/cloudflare-d1-client.ts';
      export default { async fetch(request, env) {
        try {
          return Response.json(await listD1Databases({ CLOUDFLARE_ACCOUNT_ID: env.ACCOUNT, CLOUDFLARE_API_TOKEN: env.TOKEN }));
        } catch (error) {
          return Response.json({ code: error.code, failure: error.failure }, { status: 502 });
        }
      } };
    `,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    sourcefile: 'cloudflare-d1-native.fixture.ts', loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', write: false,
}).outputFiles[0].text;

async function fixture(t, respond) {
  const token = randomUUID(), calls = [];
  const runtime = new Miniflare({
    modules: true, script, compatibilityDate: '2026-07-06', compatibilityFlags: ['nodejs_compat'],
    cf: false, log: new Log(0), bindings: { ACCOUNT: account, TOKEN: token },
    handleRuntimeStdio: (stdout, stderr) => { stdout.resume(); stderr.resume(); },
    outboundService: async request => {
      calls.push({ url: request.url, method: request.method });
      assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
      return respond(request);
    },
  });
  t.after(async () => { await runtime.dispose(); });
  return { runtime, calls, token };
}

test('Cloudflare inventory uses native Worker fetch with no external network', { timeout: 30_000 }, async t => {
  const { runtime, calls, token } = await fixture(t, () => Response.json({
    success: true, result: [{ uuid: database, name: 'Fixture database' }],
  }));
  const response = await runtime.dispatchFetch('https://fixture.invalid/');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), [{ id: database, name: 'Fixture database' }]);
  assert.ok(!body.includes(token));
  assert.deepEqual(calls, [{ url: endpoint, method: 'GET' }]);
});

test('native Worker fetch refuses a redirect without forwarding the bearer', { timeout: 30_000 }, async t => {
  const { runtime, calls, token } = await fixture(t, () => new Response(null, {
    status: 302, headers: { location: 'https://other.example/credential-target' },
  }));
  const response = await runtime.dispatchFetch('https://fixture.invalid/');
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { code: 'provider_unavailable', failure: { kind: 'http', status: 302 } });
  assert.ok(!body.includes(token));
  assert.deepEqual(calls, [{ url: endpoint, method: 'GET' }]);
});
