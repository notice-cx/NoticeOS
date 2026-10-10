import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, run } from './mediavine.mjs';

test('CLI reads saved status without requesting a provider refresh', async () => {
  const result = await run(parseArgs(['status', '--asset', 'meals.example']), async (url, init) => {
    assert.equal(url.pathname, '/api/integrations/mediavine/status');
    assert.equal(url.searchParams.get('asset'), 'meals.example');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    return Response.json({ ok: true, value: { reportedThrough: '2026-09-08' } });
  });
  assert.equal(result.reportedThrough, '2026-09-08');
});
test('CLI backfill calls the same NoticeOS collector exactly once', async () => {
  let calls = 0;
  await run(parseArgs(['sync', '--asset', 'meals.example', '--start', '2026-09-01', '--end', '2026-09-08']), async (url, init) => {
    calls++;
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(init.headers.origin, url.origin);
    assert.deepEqual(JSON.parse(init.body), { asset: 'meals.example', start: '2026-09-01', end: '2026-09-08' });
    return Response.json({ ok: true, value: {} });
  });
  assert.equal(calls, 1);
});
test('CLI refuses ambiguous dates and reports server backoff without retrying', async () => {
  assert.throws(() => parseArgs(['sync', '--asset', 'example.test', '--start', '2026-09-01']), /both/);
  assert.throws(() => parseArgs(['sites', '--url', 'https://user:password@example.test']), /without credentials/);
  await assert.rejects(run(parseArgs(['sync', '--asset', 'example.test']), async () => Response.json({ ok: false, message: 'Wait 15 minutes.' }, { status: 422 })), /Wait 15 minutes/);
});
test('CLI lists the account\'s sites through the connect panel\'s own read', async () => {
  const site = { lane: 'ad-network', ref: 'mv-1', label: 'example.test', host: 'example.test', mapping: { mediavineSiteId: 'mv-1' }, ready: true };
  const sites = await run(parseArgs(['sites']), async (url, init) => {
    assert.equal(url.pathname, '/api/integrations/mediavine/sites');
    assert.equal(init.method, 'GET');
    return Response.json({ discovery: { ok: true, provider: 'mediavine', kind: 'account', checkedAt: '2026-09-23T00:00:00Z', sites: [site] }, assets: [], spend: null });
  });
  assert.deepEqual(sites, [site]);
  await assert.rejects(run(parseArgs(['sites']), async () => Response.json({ discovery: { ok: false, provider: 'mediavine', checkedAt: '2026-09-23T00:00:00Z', reason: 'refused' }, assets: [], spend: null })), /refused/);
});
