import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emailEnrollmentUrl, parseEmailEnrollmentLanding } from './identity-protocol.mjs';

const origin = 'https://tower.example';
const id = '11111111-1111-4111-8111-111111111111';
test('ordinary sign-in and product fragments contain no enrollment selector', () => {
  assert.deepEqual(parseEmailEnrollmentLanding(`${origin}/sign-in`), { kind: 'none' });
  assert.deepEqual(parseEmailEnrollmentLanding(`${origin}/assets#section`), { kind: 'none' });
});
test('both enrollment kinds round-trip exactly and expose a fragment-free address', () => {
  for (const kind of ['platform', 'invitation']) {
    const url = emailEnrollmentUrl(origin, { kind, id });
    assert.equal(url, `${origin}/sign-in#${kind}=${id}`);
    const parsed = parseEmailEnrollmentLanding(url);
    assert.deepEqual(parsed, { kind: 'enrollment', enrollment: { kind, id }, cleanUrl: `${origin}/sign-in` });
    assert.equal(Object.isFrozen(parsed), true);
    assert.equal(Object.isFrozen(parsed.enrollment), true);
  }
});
test('malformed or extra enrollment selectors refuse instead of ordinary login', () => {
  for (const fragment of ['#other=1', '#platform=bad', `#platform=${id}&invitation=${id}`, `#platform=${id}&platform=${id}`,
    `#platform=${id}&`, `#platform=${id.toUpperCase().replace('1111', 'AAAA')}`, '#invitation=', '#platform%3D'+id]) {
    assert.deepEqual(parseEmailEnrollmentLanding(`${origin}/sign-in${fragment}`), { kind: 'invalid' });
  }
});
test('credentials, email queries, extra queries and overlong input refuse', () => {
  for (const input of [`https://person:secret@tower.example/sign-in#platform=${id}`,
    `${origin}/sign-in?email=person@example.com#platform=${id}`, `${origin}/sign-in?after=${id}`, 'not a URL',
    `${origin}/sign-in#${'x'.repeat(8192)}`]) {
    assert.deepEqual(parseEmailEnrollmentLanding(input), { kind: 'invalid' });
  }
});
test('link constructor accepts only canonical origins, kinds and UUIDs', () => {
  for (const badOrigin of [`${origin}/path`, `${origin}/`, `${origin}?email=person@example.com`, 'file:///tmp', 'https://person:secret@tower.example']) {
    assert.throws(() => emailEnrollmentUrl(badOrigin, { kind: 'platform', id }));
  }
  for (const selector of [{ kind: 'other', id }, { kind: 'platform', id: 'bad' }, { kind: 'invitation', id: id.replace('1111', 'AAAA') }]) {
    assert.throws(() => emailEnrollmentUrl(origin, selector));
  }
});
