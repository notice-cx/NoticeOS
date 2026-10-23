import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { DEFAULT_DOOR, doorIsHeld, fireScheduledTrigger } from './ingest-door.mjs';

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

test('only the explicit reload response skips a failed scheduled request', async () => {
  for (const [status, body, outcome] of [
    [503, { error: 'runtime_reloading' }, 'skipped'],
    [500, { error: 'runtime_reloading' }, 'failed'],
    [503, { error: 'scheduled_failed' }, 'failed'],
    [500, { error: 'scheduled_failed' }, 'failed'],
  ]) {
    const logs = [];
    const result = await fireScheduledTrigger('http://127.0.0.1:1', '* * * * *', {
      fetchImpl: async () => Response.json(body, { status }),
      emit: (level) => logs.push(level),
    });
    assert.equal(result.outcome, outcome);
    assert.deepEqual(logs, [outcome === 'skipped' ? 'INFO' : 'ERROR']);
    if (outcome === 'skipped') assert.equal(result.detail, 'interrupted: server reloading');
  }
});

test('ordinary network failures and request timeouts remain failures', async () => {
  const timeout = AbortSignal.abort(new Error('request timed out'));
  const result = await fireScheduledTrigger('http://127.0.0.1:1', '* * * * *', {
    signal: timeout,
    fetchImpl: async (_url, { signal }) => { throw signal.reason; },
  });
  assert.equal(result.outcome, 'failed');
  const network = await fireScheduledTrigger('http://127.0.0.1:1', '* * * * *', {
    fetchImpl: async () => { throw new Error('socket hang up'); },
  });
  assert.equal(network.outcome, 'failed');
});

test('shutdown cancels an in-flight loopback request without reporting a failure', async (t) => {
  const server = http.createServer();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const controller = new AbortController();
  const request = once(server, 'request');
  const logs = [];
  const firing = fireScheduledTrigger(`http://127.0.0.1:${server.address().port}`, '* * * * *', {
    shutdownSignal: controller.signal, emit: (level) => logs.push(level),
  });
  await request;
  controller.abort();
  assert.deepEqual(await firing, { outcome: 'skipped', detail: 'interrupted: runner shutting down' });
  assert.deepEqual(logs, ['INFO']);
});

test('a response cut off after its headers still settles as a real transport failure', { timeout: 2_000 }, async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"outcome":');
    setImmediate(() => response.destroy());
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = await fireScheduledTrigger(`http://127.0.0.1:${server.address().port}`, '* * * * *');
  assert.equal(result.outcome, 'failed');
});

test('an already stopped runner sends no request', async () => {
  const result = await fireScheduledTrigger('http://127.0.0.1:1', '* * * * *', {
    shutdownSignal: AbortSignal.abort(),
    fetchImpl: () => assert.fail('shutdown must not start another request'),
  });
  assert.equal(result.outcome, 'skipped');
});
