import test from 'node:test';
import assert from 'node:assert/strict';
import { comparisonRefreshLines, main } from './ga4-comparison-refresh.mjs';
import { containerCommand } from '../deploy/compose/entrypoint.mjs';

function output() { let text = ''; return { write: (value) => { text += value; }, text: () => text }; }
const AT = '2026-07-29T12:00:00.000Z';

test('the container runs the refresh only with no arguments', () => {
  assert.deepEqual(containerCommand(['refresh-comparison']), ['scripts/ga4-comparison-refresh.mjs']);
  assert.equal(containerCommand(['refresh-comparison', '--asset', 'example.com']), null);
});

test('help and stray arguments perform no credential or network access', async () => {
  const out = output(), fail = () => assert.fail('unexpected credential or request');
  assert.equal(await main(['--help'], { token: fail, fetchImpl: fail, out, err: out }), 0);
  assert.equal(await main(['--asset', 'example.com'], { token: fail, fetchImpl: fail, out, err: out }), 2);
  assert.match(out.text(), /pnpm os:refresh-comparison/);
});

test('one authenticated loopback call prints a line per site and fails when any site was refused', async () => {
  const calls = [];
  const sites = [{ asset: 'meadow.example', ok: true, observedAt: AT }, { asset: 'northwind.example', ok: false, code: 'ga4_comparison_incomplete_row_count', observedAt: AT }];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return Response.json({ sites }); };
  const out = output();
  assert.equal(await main([], { token: async () => 'PRIVATE-CREDENTIAL', fetchImpl, door: 'http://127.0.0.1:8791', out, err: out }), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8791/api/ga4-comparison-refresh');
  assert.equal(calls[0].init.headers.authorization, 'Bearer PRIVATE-CREDENTIAL');
  assert.equal(out.text(), 'meadow.example: comparison stored\nnorthwind.example: refused (ga4_comparison_incomplete_row_count)\n');
  const all = output();
  assert.equal(await main([], { token: async () => 'PRIVATE-CREDENTIAL', fetchImpl: async () => Response.json({ sites: sites.slice(0, 1) }), out: all, err: all }), 0);
});

test('no configured property, a refusal and a lost answer are each said plainly without raw detail or credentials', async () => {
  assert.deepEqual(comparisonRefreshLines([]), ['No site has a GA4 property to read.']);
  assert.deepEqual(comparisonRefreshLines([{ asset: 'meadow.example', ok: false, code: 'Raw <provider> text', observedAt: AT }]), ['meadow.example: refused (unknown)']);
  const out = output();
  assert.equal(await main([], { token: async () => 'PRIVATE-CREDENTIAL', out, err: out,
    fetchImpl: async () => Response.json({ error: 'unauthorized', detail: 'PRIVATE-CREDENTIAL' }, { status: 401 }) }), 1);
  assert.match(out.text(), /refused: unauthorized/);
  assert.equal(await main([], { token: async () => 'PRIVATE-CREDENTIAL', out, err: out, fetchImpl: async () => { throw new Error('PRIVATE-CREDENTIAL'); } }), 1);
  assert.match(out.text(), /did not return a result/);
  assert.doesNotMatch(out.text(), /PRIVATE-CREDENTIAL/);
});
