import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoVisits, DEMO_VISIT_TTL_MS, DEMO_LAUNCH_MAX_MS, DEMO_REQUEST_MAX_MS } from './demo-visit.mjs';
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
function fixture(duration = DEMO_LAUNCH_MAX_MS) {
  let id = 0;
  return new DemoVisits(A, 1000, duration, () => (++id).toString(16).padStart(32, '0'));
}
const status = n => error => error.status === n;
test('navigation, refresh and polling retain a fixed visit across publication', () => {
  const visits = fixture(), old = visits.begin(1000);
  visits.publish(B, 2000);
  const fresh = visits.begin(2001);
  assert.equal(old.generation, A); assert.equal(fresh.generation, B);
  for (const now of [2002, 3000, old.expiresAt - 1]) {
    for (const route of ['/assets/example?tab=activity', '/api/wall', '/api/workflows?run=one']) {
      const read = visits.resolve(`/visit/${old.id}${route}`, now);
      assert.equal(read.visit, old); assert.equal(read.path, route); read.release();
    }
  }
  assert.equal(old.expiresAt, 1000 + DEMO_VISIT_TTL_MS);
  assert.throws(() => visits.resolve(`/visit/${old.id}/api/wall`, old.expiresAt), status(410));
  assert.throws(() => visits.resolve(`/visit/${old.id}/assets/example`, old.expiresAt), status(410));
  assert.equal(visits.state().current, B);
});
test('the finite launcher clips visits and never extends after publication', () => {
  const visits = fixture(5000), pin = visits.begin(5999);
  assert.equal(pin.expiresAt, 6000);
  visits.publish(B, 5999);
  assert.equal(visits.state().deadline, 6000);
  assert.throws(() => visits.begin(6000), status(410));
  assert.throws(() => visits.resolve(`/visit/${pin.id}/api/wall`, 6000), status(410));
});
test('an unpublished candidate and attempted third generation never replace current', () => {
  const visits = fixture(), old = visits.begin(1000);
  assert.equal(visits.state().current, A);
  visits.publish(B, 2000);
  assert.throws(() => visits.publish(C, 2001), status(409));
  assert.equal(visits.state().current, B); assert.equal(visits.state().previous.generation, A);
  const read = visits.resolve(`/visit/${old.id}/api/tasks`, 2002); read.release();
});
test('bounded requests release once and retirement waits for its fixed drain deadline', () => {
  const visits = fixture(), pin = visits.begin(1000);
  const reads = Array.from({ length: 8 }, () => visits.resolve(`/visit/${pin.id}/api/wall`, 1100));
  assert.throws(() => visits.resolve(`/visit/${pin.id}/api/wall`, 1100), status(429));
  reads[0].release(); reads[0].release();
  const ninth = visits.resolve(`/visit/${pin.id}/api/wall`, 1100);
  visits.publish(B, 2000);
  const end = 2000 + DEMO_VISIT_TTL_MS + DEMO_REQUEST_MAX_MS;
  assert.throws(() => visits.retired(A, end - 1), status(409));
  assert.throws(() => visits.retired(A, end), status(409));
  for (const read of [...reads, ninth]) read.release();
  visits.retired(A, end); assert.equal(visits.state().previous, null);
  assert.throws(() => visits.resolve(`/visit/${pin.id}/api/wall`, end), status(410));
});
test('selector and lifetime ambiguity refuse instead of adopting a target', () => {
  const visits = fixture(), pin = visits.begin(1000);
  for (const path of ['/api/wall', '/visit/unknown/api/wall', `/visit/${pin.id}/../api/wall`,
    `/visit/${pin.id}/%2e%2e/api/wall`, `/visit/${pin.id}/api%2fwall`, `/visit/${pin.id}/api\\wall`]) {
    assert.throws(() => visits.resolve(path, 2000), status(400));
  }
  assert.throws(() => visits.resolve(`/visit/${'f'.repeat(32)}/api/wall`, 2000), status(404));
  assert.throws(() => new DemoVisits(A, 0, DEMO_LAUNCH_MAX_MS + 1, () => '0'.repeat(32)), status(400));
});
test('visit issuance has a finite run-wide bound, even after expiry', () => {
  const visits = fixture();
  for (let index = 0; index < 1024; index++) visits.begin(1000 + index);
  assert.throws(() => visits.begin(DEMO_VISIT_TTL_MS + 3000), status(429));
});

test('encoded ordinary filter values survive navigation and refresh without loosening the pathname guard', () => {
  const visits = new DemoVisits('a'.repeat(64), 1000, DEMO_LAUNCH_MAX_MS, () => '1'.repeat(32));
  const visit = visits.begin(1000);
  const query = '/tasks?assignee=codex%2Fbuilder&label=a%5Cb';
  for (const now of [1001, 1002]) {
    const request = visits.resolve(`/visit/${visit.id}${query}`, now);
    assert.equal(request.path, query); request.release();
  }
  for (const path of ['/tasks%2Fadmin', '/tasks%5Cadmin', '/%2e%2e/tasks', '/api/tasks\r\nInjected:yes']) assert.throws(() => visits.resolve(`/visit/${visit.id}${path}`, 1002));
});
