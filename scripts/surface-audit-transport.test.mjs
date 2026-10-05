import assert from 'node:assert/strict';
import test from 'node:test';
import { connectDevTools, withChromePage } from './surface-audit.mjs';

class Socket {
  sent = [];
  closed = 0;
  open() { this.onopen?.(); }
  send(data) { this.sent.push(JSON.parse(data)); }
  reply(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  close() { this.closed++; this.onclose?.(); }
}

async function page(socket = new Socket()) {
  const opening = connectDevTools(socket, { timeoutMs: 100 });
  socket.open();
  return { socket, client: await opening };
}

test('a browser that never attaches fails at the connection deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new Socket();
  const rejected = assert.rejects(connectDevTools(socket, { timeoutMs: 100 }), /did not attach within 100ms/);
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(socket.closed, 1);
});

test('a stalled navigation rejects every pending command and future sends', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { socket, client } = await page();
  const navigation = assert.rejects(client.send('Page.navigate', { url: 'about:blank' }), /did not answer Page.navigate within 100ms/);
  const read = assert.rejects(client.evaluate('1'), /did not answer Page.navigate/);
  t.mock.timers.tick(100);
  await Promise.all([navigation, read]);
  await assert.rejects(client.send('Runtime.enable'), /did not answer Page.navigate/);
  assert.equal(socket.closed, 1);
});

for (const event of ['onclose', 'onerror']) {
  test(`${event} rejects all pending commands without waiting for a deadline`, async () => {
    const { socket, client } = await page();
    const reads = [assert.rejects(client.send('Page.enable'), /connection (closed|failed)/),
      assert.rejects(client.evaluate('1'), /connection (closed|failed)/)];
    socket[event]();
    await Promise.all(reads);
    assert.equal(socket.closed, 1);
  });
}

test('replies match their command, ignore events and cancel completed deadlines', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { socket, client } = await page();
  const first = client.send('Page.enable');
  const second = client.evaluate('42');
  socket.reply({ method: 'Page.loadEventFired', params: {} });
  socket.reply({ id: 2, result: { result: { value: 42 } } });
  socket.reply({ id: 1, result: {} });
  assert.equal(await second, 42);
  assert.deepEqual(await first, { id: 1, result: {} });
  t.mock.timers.tick(200);
  assert.equal(socket.closed, 0);
  client.close();
  assert.equal(socket.closed, 1);
});

test('protocol and page errors name the rejected operation', async () => {
  const { socket, client } = await page();
  const command = assert.rejects(client.send('Page.navigate'), /Chrome rejected Page.navigate: invalid target/);
  socket.reply({ id: 1, error: { message: 'invalid target' } });
  await command;
  const evaluation = assert.rejects(client.evaluate('missing()'), /page error: missing is not defined/);
  socket.reply({ id: 2, result: { exceptionDetails: { exception: { description: 'missing is not defined' } } } });
  await evaluation;
  client.close();
});

for (const data of ['invalid JSON', 'null']) {
  test(`an invalid response (${data}) rejects pending reads`, async () => {
    const { socket, client } = await page();
    const rejected = assert.rejects(client.evaluate('1'), /invalid DevTools response/);
    socket.onmessage({ data });
    await rejected;
    assert.equal(socket.closed, 1);
  });
}

test('a synchronous send failure rejects all waiting commands', async () => {
  const { socket, client } = await page();
  const waiting = assert.rejects(client.send('Page.enable'), /Could not send Runtime.enable/);
  socket.send = () => { throw new Error('socket failed'); };
  await assert.rejects(client.send('Runtime.enable'), /Could not send Runtime.enable/);
  await waiting;
  assert.equal(socket.closed, 1);
});

for (const failure of ['attach', 'read', 'close', null]) {
  test(`the owned browser and profile clean up after ${failure ?? 'success'}`, async () => {
    const calls = [];
    const client = { close() { calls.push('close'); if (failure === 'close') throw new Error('close failed'); } };
    const run = withChromePage('fixture-browser', { width: 390 }, async given => {
      assert.equal(given, client);
      calls.push('read');
      if (failure === 'read') throw new Error('read failed');
      return 42;
    }, {
      async launch(binary, viewport) {
        assert.equal(binary, 'fixture-browser');
        assert.equal(viewport.width, 390);
        return { port: 1234, async kill() { calls.push('cleanup'); } };
      },
      async attach(port) {
        assert.equal(port, 1234);
        if (failure === 'attach') throw new Error('attach failed');
        return client;
      },
    });
    if (failure) await assert.rejects(run, new RegExp(`${failure} failed`));
    else assert.equal(await run, 42);
    assert.deepEqual(calls, failure === 'attach' ? ['cleanup'] : ['read', 'close', 'cleanup']);
  });
}
