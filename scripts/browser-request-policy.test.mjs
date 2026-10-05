import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRequestRefused, createBrowserRequestPolicy } from './browser-request-policy.mjs';

const origin = 'https://fixture.example.test';
const request = (headers = {}, url = origin, method = 'POST') => new Request(url, { headers, method });

test('the server origin is exact, HTTPS or explicit loopback; no wildcard or coercion', () => {
  for (const value of ['', null, {}, 'https://*.example.test', `${origin}/`, `${origin}/path`,
    'https://user:pass@fixture.example.test', 'http://fixture.example.test']) {
    assert.throws(() => createBrowserRequestPolicy(value), BrowserRequestRefused);
  }
  for (const value of [origin, 'http://localhost:6500', 'http://127.0.0.1:6500', 'http://[::1]:6500']) {
    assert.equal(createBrowserRequestPolicy(value).origin, value);
  }
});

test('first login refuses absent or contradictory evidence before an identity read', () => {
  const policy = createBrowserRequestPolicy(origin); let identityReads = 0;
  const enter = proof => { policy.assertEffect(proof); identityReads++; };
  for (const headers of [{}, { origin: 'null' }, { origin: 'https://foreign.example.test' },
    { origin, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' },
    { origin, 'sec-fetch-site': 'same-site' }, { origin, 'sec-fetch-mode': 'navigate' },
    { origin, 'sec-fetch-dest': 'document' }, { origin: `${origin}/` },
    { referer: `${origin}/login` }, { origin: `${origin}, ${origin}` }]) {
    assert.throws(() => enter(request(headers)), BrowserRequestRefused);
  }
  assert.equal(identityReads, 0);
});

test('trusted Origin or same-origin metadata permits the existing browser fallback', () => {
  const policy = createBrowserRequestPolicy(origin);
  for (const headers of [{ origin }, { 'sec-fetch-site': 'same-origin' },
    { origin: 'null', 'sec-fetch-site': 'same-origin' },
    { origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }]) {
    policy.assertEffect(request(headers));
  }
});

test('claimed Host or forwarded headers cannot repair a foreign request target', () => {
  const policy = createBrowserRequestPolicy(origin);
  assert.throws(() => policy.assertEffect(request({ origin, host: 'fixture.example.test',
    'x-forwarded-host': 'fixture.example.test', 'sec-fetch-site': 'same-origin' },
  'https://foreign.example.test')), BrowserRequestRefused);
  assert.throws(() => policy.assertEffect({ url: origin, headers: new Headers({ origin }) }), BrowserRequestRefused);
});

test('evidence checking preserves original URL, headers and body without granting identity', async () => {
  const policy = createBrowserRequestPolicy(origin);
  const proof = new Request(`${origin}/login?next=desk`, { method: 'POST',
    headers: { origin, 'sec-fetch-site': 'same-origin', referer: `${origin}/login` }, body: 'fixture body' });
  const headers = [...proof.headers]; const url = proof.url;
  policy.assertEffect(proof);
  assert.equal(proof.url, url); assert.deepEqual([...proof.headers], headers);
  assert.equal(await proof.text(), 'fixture body');
  assert.deepEqual(Object.keys(policy), ['origin', 'assertEffect']); assert.ok(Object.isFrozen(policy));
  // Effects are semantic; an authenticated provider GET needs the same proof.
  assert.throws(() => policy.assertEffect(request({}, origin, 'GET')), BrowserRequestRefused);
});
