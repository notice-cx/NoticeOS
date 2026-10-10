// The by-hand pulse relay (`pnpm pulse:relay`) reads WHICH site to relay, and
// from where, out of the installation's saved pull roster — never a site
// written into the script. No secret file is read here: the
// token is handed in, as the script's own main hands it over.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envelopeTargets, relayPulse } from './pulse-relay.mjs';

// The real config/pull.json shape: a Prometheus-scraped site and an
// envelope-serving one.
const ROSTER = [
  {
    asset: 'shop.example',
    url: 'https://shop.example/api/internal/metrics',
    enabled: true,
    format: 'prometheus',
    metrics: { signups: { counter: 'profiles' } },
  },
  {
    asset: 'orders.example',
    url: 'https://orders.example/api/admin/overview',
    enabled: true,
    format: 'envelope',
  },
  { asset: 'retired.example', url: 'https://retired.example/api/admin/overview', enabled: false, format: 'envelope' },
];

test('with no --asset, every enabled envelope site in the roster is relayed, and nothing else', () => {
  assert.deepEqual(envelopeTargets(ROSTER), [
    { asset: 'orders.example', url: 'https://orders.example/api/admin/overview' },
  ]);
  assert.deepEqual(envelopeTargets([]), []);
  assert.deepEqual(envelopeTargets(undefined), []);
});

test('--asset picks that site, and refuses one that does not serve an envelope', () => {
  assert.deepEqual(envelopeTargets(ROSTER, 'orders.example'), [
    { asset: 'orders.example', url: 'https://orders.example/api/admin/overview' },
  ]);
  assert.throws(() => envelopeTargets(ROSTER, 'shop.example'), /shop\.example is not an enabled pull site that serves an envelope/);
  assert.throws(() => envelopeTargets(ROSTER, 'retired.example'), /retired\.example is not an enabled pull site/);
});

test('the envelope is fetched with the site token and forwarded verbatim with the same token', async () => {
  const envelope = {
    asset: 'orders.example',
    generatedAt: '2026-09-23T00:00:00.000Z',
    capabilities: [],
    metrics: { orders: { last24h: 3, avg7d: 2.5, total: 40 } },
    flags: [],
  };
  const calls = [];
  const lines = [];
  const ok = await relayPulse({
    asset: 'orders.example',
    url: 'https://orders.example/api/admin/overview',
    token: 'synthetic-site-token',
    ingestUrl: 'http://127.0.0.1:6951',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      return url.endsWith('/api/pulse') ? new Response('', { status: 201 }) : Response.json(envelope);
    },
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
  });
  assert.equal(ok, true);
  assert.equal(calls[0].url, 'https://orders.example/api/admin/overview');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer synthetic-site-token');
  assert.equal(calls[1].url, 'http://127.0.0.1:6951/api/pulse');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer synthetic-site-token');
  assert.deepEqual(JSON.parse(calls[1].init.body), envelope);
  assert.ok(lines.some((line) => /orders\.example pulse for 2026-09-23 is in the store/.test(line)));
});

test("a refused token names that site's ASSET_TOKENS entry, and nothing is forwarded", async () => {
  const calls = [];
  const lines = [];
  const ok = await relayPulse({
    asset: 'orders.example',
    url: 'https://orders.example/api/admin/overview',
    token: 'wrong',
    ingestUrl: 'http://127.0.0.1:6951',
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response('unauthorized', { status: 401 });
    },
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
  });
  assert.equal(ok, false);
  assert.deepEqual(calls, ['https://orders.example/api/admin/overview']);
  assert.ok(lines.some((line) => line.includes('ASSET_TOKENS["orders.example"]')));
});
