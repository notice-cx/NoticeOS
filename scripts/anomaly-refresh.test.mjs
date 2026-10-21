import test from 'node:test';
import assert from 'node:assert/strict';
import { anomalyRefreshArgs } from './anomaly-refresh-args.mjs';
import { main } from './anomaly-refresh.mjs';
import { containerCommand } from '../deploy/compose/entrypoint.mjs';

const TOKEN = '1792584000000.' + 'a'.repeat(64);
function output() { let text = ''; return { write: (value) => { text += value; }, text: () => text }; }

test('refresh arguments require one explicit asset and a bounded apply token', () => {
  assert.deepEqual(anomalyRefreshArgs(['--asset', 'example.com']), { asset: 'example.com' });
  assert.deepEqual(anomalyRefreshArgs(['--asset', 'example.com', '--apply', TOKEN]), { asset: 'example.com', apply: TOKEN });
  for (const args of [[], ['--all'], ['--asset', 'example.com', '--asset', 'other.example'], ['--asset', 'example.com', '--apply', 'yes'],
    ['--asset', '--apply'], ['--asset', 'example.com', '--through', '2026-01-01'], ['--asset', 'x'.repeat(300)]]) {
    assert.throws(() => anomalyRefreshArgs(args));
    assert.equal(containerCommand(['refresh-anomalies', ...args]), null);
  }
  assert.deepEqual(containerCommand(['refresh-anomalies', '--asset', 'example.com', '--apply', TOKEN]),
    ['scripts/anomaly-refresh.mjs', '--asset', 'example.com', '--apply', TOKEN]);
});

test('help and malformed scope perform no credential or network access', async () => {
  const out = output(), fail = () => assert.fail('unexpected credential or request');
  assert.equal(await main(['--help'], { token: fail, fetchImpl: fail, out, err: out }), 0);
  assert.equal(await main(['--all'], { token: fail, fetchImpl: fail, out, err: out }), 2);
  assert.match(out.text(), /--asset/);
});

test('preview and apply each make one authenticated loopback call and never execute a collector', async () => {
  for (const apply of [undefined, TOKEN]) {
    const out = output(), calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return Response.json({ mode: apply ? 'applied' : 'preview', asset: 'example.com' }); };
    assert.equal(await main(['--asset', 'example.com', ...(apply ? ['--apply', apply] : [])],
      { token: async () => 'PRIVATE-CREDENTIAL', fetchImpl, door: 'http://127.0.0.1:8791', out, err: out }), 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:8791/api/anomaly-refresh');
    assert.equal(calls[0].init.headers.authorization, 'Bearer PRIVATE-CREDENTIAL');
    assert.deepEqual(JSON.parse(calls[0].init.body), { asset: 'example.com', ...(apply ? { apply } : {}) });
    assert.doesNotMatch(out.text(), /PRIVATE-CREDENTIAL/);
  }
});

test('errors report only a fixed refusal code and never print raw response or credentials', async () => {
  const out = output();
  assert.equal(await main(['--asset', 'example.com'], { token: async () => 'PRIVATE-CREDENTIAL', out, err: out,
    fetchImpl: async () => Response.json({ error: 'stale_plan', detail: 'PRIVATE-CREDENTIAL' }, { status: 409 }) }), 1);
  assert.match(out.text(), /stale_plan/); assert.doesNotMatch(out.text(), /PRIVATE-CREDENTIAL/);
  assert.equal(await main(['--asset', 'example.com', '--apply', TOKEN], { token: async () => 'PRIVATE-CREDENTIAL', out, err: out,
    fetchImpl: async () => { throw new Error('PRIVATE-CREDENTIAL'); } }), 1);
  assert.match(out.text(), /Retry the same apply token/); assert.doesNotMatch(out.text(), /PRIVATE-CREDENTIAL/);
});
