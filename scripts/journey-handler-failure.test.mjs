// What a failed journey fixture call says (apps/tower/e2e/handler-failure.mjs,
// bead ro-ujb9.76.56): the error's own words and its causes', in the failing
// test's output, and never an address, a socket or the run's database
// password. The harness test (apps/tower/e2e/harness.test.mjs) proves a real
// refused reset reaches the answer and the server's marked line; this proves
// what is withheld from a failure that names all three.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HANDLER_FAILURE_MARK, handlerFailureText } from '../apps/tower/e2e/handler-failure.mjs';

test("a failure's own words never carry an address, a socket or a password", () => {
  const password = 'journey-password-0123456789';
  const text = handlerFailureText(
    new Error(`the copy service refused reset: could not reach postgresql://noticeos_app:${password}@127.0.0.1:5601/noticeos_c1_dev?sslmode=disable`, {
      cause: new Error('connection to server on socket "/var/folders/xy/T/nos-AbCd12/.s.PGSQL.5601" failed: timeout expired (localhost:5601)'),
    }),
    [password],
  );
  assert.match(text, /the copy service refused reset/u);
  assert.match(text, /timeout expired/u);
  for (const leak of [password, '127.0.0.1', '5601', '/var/folders', 'postgresql://']) assert.equal(text.includes(leak), false, leak);
});

test('a failure with no words, or a thrown value that is not an error, still says something', () => {
  assert.equal(handlerFailureText(new Error('')), 'no reason given');
  assert.equal(handlerFailureText('refused'), 'refused');
  assert.equal(HANDLER_FAILURE_MARK, 'JOURNEY_HANDLER_FAILED');
});
