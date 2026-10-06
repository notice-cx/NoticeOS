// A FIXED DEADLINE, PROVED ON A FAKE CLOCK (issue #7).
//
// Several request handlers end a stalled body read at a fixed deadline that no
// URL, header, setting or variable can change. A test used to wait it out in
// real time, two seconds at a go. With node:test's mock timers on, from the
// real time (`fakeClock(t)`), this drives the
// handler's own clock instead: one millisecond short of the deadline it must
// still be waiting, and at the deadline it must settle. That is stricter than
// the old wall-clock bound, and takes no real time. The product code is
// unchanged.

import assert from 'node:assert/strict';

/** Fake `setTimeout` and `Date` for test `t`, starting at the real time, so
 * session and expiry checks read a present-day clock. */
export function fakeClock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
}

/** A few real event-loop turns, so stream reads and promise chains move on. */
async function turns(count = 10) {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * `settling`, once the fake clock has reached `ms`: still pending one
 * millisecond before, then settled at the deadline. The caller has called
 * `fakeClock(t)`.
 * @template T
 * @param {{ mock: { timers: { tick(ms: number): void } } }} t
 * @param {Promise<T>} settling
 * @param {number} ms
 * @returns {Promise<T>}
 */
export async function atDeadline(t, settling, ms) {
  let settled = false;
  const watched = settling.finally(() => { settled = true; });
  watched.catch(() => {});
  await turns();
  t.mock.timers.tick(ms - 1);
  await turns();
  assert.equal(settled, false, `settled before its ${ms} ms deadline`);
  t.mock.timers.tick(1);
  return watched;
}
