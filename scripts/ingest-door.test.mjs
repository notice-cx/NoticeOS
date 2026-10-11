import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { DEFAULT_DOOR, doorIsHeld } from './ingest-door.mjs';

// The door probe every script that must not run beside a live runtime asks
// (ingest-dev.mjs, start.mjs).

/** A socket that behaves the way `net.connect` does for a port with, or without,
 * a listener — enough of one for doorIsHeld, without binding anything. */
function stubSocket(outcome) {
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  queueMicrotask(() => socket.emit(outcome));
  return socket;
}

test('doorIsHeld: a listener means held, a refused connect means free', async () => {
  assert.equal(
    await doorIsHeld(DEFAULT_DOOR, { connect: () => stubSocket('connect') }),
    true,
  );
  assert.equal(await doorIsHeld(DEFAULT_DOOR, { connect: () => stubSocket('error') }), false);
  // A door that accepts nothing in time is treated as free — the same call
  // scripts/os-up.mjs makes, and a hung socket is not a runtime holding the file.
  assert.equal(await doorIsHeld(DEFAULT_DOOR, { connect: () => stubSocket('timeout') }), false);
});
