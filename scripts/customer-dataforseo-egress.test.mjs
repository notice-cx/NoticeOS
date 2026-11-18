import assert from 'node:assert/strict';
import test from 'node:test';
import { DATAFORSEO_ACCOUNT_PATH, DATAFORSEO_EGRESS_BEACONS, DATAFORSEO_ORIGIN, DATAFORSEO_REPORT_PATHS, localDataForSeoOutbound } from './customer-dataforseo-egress.mjs';

test('the paid transport forwards only one request to an approved report and sends no auth to health probes', async () => {
  const calls = [];
  const send = localDataForSeoOutbound({ async transport(url, options) {
    calls.push({ url, ...options });
    return new Response(null, { status: 307, headers: { location: 'https://foreign.example.test/' } });
  } });
  const headers = { authorization: `Basic ${Buffer.from('fixture:fixture').toString('base64')}`, 'content-type': 'application/json', cookie: 'drop' };
  const url = DATAFORSEO_ORIGIN + '/v3' + DATAFORSEO_REPORT_PATHS.rankedKeywords;
  const body = JSON.stringify([{ target: 'fixture.example.test' }]);
  for (const request of [new Request(url), new Request(url + '?expanded=yes', { method: 'POST', headers, body }),
    new Request(DATAFORSEO_ORIGIN + '/v3/serp/google/organic/task_post', { method: 'POST', headers, body }),
    new Request(url, { method: 'POST', headers, body: '[{},{}]' }), new Request(url, { method: 'POST', body })]) {
    assert.equal((await send(request)).status, 403);
  }
  assert.equal((await send(new Request(url, { method: 'POST', headers, body }))).status, 502);
  assert.equal((await send(new Request(DATAFORSEO_ORIGIN + DATAFORSEO_ACCOUNT_PATH, { headers }))).status, 502);
  assert.equal((await send(new Request(DATAFORSEO_EGRESS_BEACONS[0], { headers }))).status, 502);
  assert.deepEqual(calls.map(({ url, method, headers, body, redirect }) => [url, method, headers.authorization, headers.cookie, body, redirect]), [
    [url, 'POST', headers.authorization, undefined, body, 'manual'],
    [DATAFORSEO_ORIGIN + DATAFORSEO_ACCOUNT_PATH, 'GET', headers.authorization, undefined, undefined, 'manual'],
    [DATAFORSEO_EGRESS_BEACONS[0], 'GET', undefined, undefined, undefined, 'manual'],
  ]);
});
