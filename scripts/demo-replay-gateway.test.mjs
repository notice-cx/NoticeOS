import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { DemoVisits, DEMO_VISIT_TTL_MS, DEMO_LAUNCH_MAX_MS } from './demo-visit.mjs';
import { createDemoGateway } from './demo-replay-gateway.mjs';
import { crossOrigin } from '../apps/tower/vite/lane.ts';
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

test('actual loopback requests keep two visitors and refresh on complete selected generations', async () => {
  const reads = [], servers = [];
  let clock = 1000, id = 0;
  const visits = new DemoVisits(A, clock, DEMO_LAUNCH_MAX_MS, () => (++id).toString(16).padStart(32, '0'));
  const backends = new Map();
  let gateway;
  try {
    for (const generation of [A, B]) {
      const server = http.createServer((request, response) => {
        reads.push({ generation, path: request.url });
        response.setHeader('content-type', request.url.startsWith('/api/') ? 'application/json' : 'text/html');
        response.end(JSON.stringify({ generation, path: request.url }));
      });
      servers.push(server);
      backends.set(generation, { port: await listen(server), base: `/generation/${generation}/` });
    }
    gateway = createDemoGateway({ visits, backends, now: () => clock });
    const origin = `http://127.0.0.1:${await listen(gateway.server)}`;
    const open = async () => (await fetch(origin + '/', { redirect: 'manual' })).headers.get('location');
    const old = await open();
    const document = await (await fetch(origin + old)).json();
    assert.equal(document.generation, A); assert.equal(document.path, `/generation/${A}/`);
    visits.publish(B, ++clock);
    const current = await open();
    assert.notEqual(current, old);
    for (const suffix of ['', 'assets/example?tab=activity', 'api/wall', 'api/workflows?run=one', 'tasks?assignee=codex%2Fbuilder&label=a%2Fb', 'api/tasks?assignee=codex%2Fbuilder']) {
      assert.equal((await (await fetch(origin + old + suffix)).json()).generation, A);
      assert.equal((await (await fetch(origin + current + suffix)).json()).generation, B);
    }
    assert.equal((await (await fetch(`${origin}/generation/${A}/src/main.tsx`)).json()).generation, A);
    assert.equal((await (await fetch(`${origin}/generation/${B}/src/main.tsx`)).json()).generation, B);
    const before = reads.length;
    assert.equal((await fetch(`${origin}/api/wall`)).status, 400);
    assert.equal((await fetch(`${origin}/generation/${A}/api/wall`)).status, 400);
    clock = 1000 + DEMO_VISIT_TTL_MS;
    const expired = await fetch(origin + old + 'api/wall');
    assert.equal(expired.status, 410); assert.deepEqual(await expired.json(), { error: 'demo_visit_expired' });
    const refresh = await fetch(origin + old + 'assets/example');
    assert.equal(refresh.status, 410);
    assert.match(await refresh.text(), /Demo visit ended\./u);
    assert.equal(reads.length, before, 'refusals never read a successor or backend');
    assert.equal((await (await fetch(origin + current + 'api/wall')).json()).generation, B);
  } finally {
    await gateway?.stop();
    await Promise.all(servers.map(close));
  }
});

test('two actual Vite-protocol channels stay on their exact generation and close on retirement', async () => {
  const servers = [], sockets = new Set(), upgrades = [];
  const visits = new DemoVisits(A, 1000, DEMO_LAUNCH_MAX_MS, () => '1'.repeat(32));
  const backends = new Map(); let clock = 1000, gateway, wsA, wsB;
  const event = (socket, name) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket ${name} timed out`)), 2000);
    socket.addEventListener(name, value => { clearTimeout(timer); resolve(value); }, { once: true });
    if (name !== 'close') socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket refused')); }, { once: true });
  });
  try {
    for (const id of [A, B]) {
      const server = http.createServer((_request, response) => response.end('owned module'));
      server.on('upgrade', (request, socket) => {
        upgrades.push({ id, path: request.url }); sockets.add(socket); socket.on('close', () => sockets.delete(socket));
        const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`);
        socket.write(Buffer.concat([Buffer.from([0x81, id.length]), Buffer.from(id)]));
      });
      servers.push(server); backends.set(id, { port: await listen(server), base: `/generation/${id}/` });
    }
    gateway = createDemoGateway({ visits, backends, now: () => clock }); const port = await listen(gateway.server);
    wsA = new WebSocket(`ws://127.0.0.1:${port}/generation/${A}/?token=owned`, 'vite-hmr');
    const first = event(wsA, 'message'); await event(wsA, 'open'); assert.equal((await first).data, A);
    visits.publish(B, ++clock);
    wsB = new WebSocket(`ws://127.0.0.1:${port}/generation/${B}/?token=owned`, 'vite-hmr');
    const second = event(wsB, 'message'); await event(wsB, 'open'); assert.equal((await second).data, B);
    assert.deepEqual(upgrades, [{ id: A, path: `/generation/${A}/?token=owned` }, { id: B, path: `/generation/${B}/?token=owned` }]);
    const oldClosed = event(wsA, 'close'); gateway.retire(A); backends.delete(A); await oldClosed;
    assert.equal((await fetch(`http://127.0.0.1:${port}/generation/${A}/src/main.tsx`)).status, 503);
    const unknown = new WebSocket(`ws://127.0.0.1:${port}/generation/${'c'.repeat(64)}/?token=owned`, 'vite-hmr'); await event(unknown, 'close');
    assert.equal(upgrades.length, 2); assert.equal(wsB.readyState, WebSocket.OPEN);
    clock = visits.deadline;
    assert.equal((await fetch(`http://127.0.0.1:${port}/generation/${B}/src/main.tsx`)).status, 410);
  } finally {
    wsA?.close(); wsB?.close(); await gateway?.stop(); for (const socket of sockets) socket.destroy(); await Promise.all(servers.map(close));
  }
});

test('owned gateway preserves browser origin for native task reads without normalizing foreign evidence', async () => {
  let gateway, dispatched = 0;
  const observed = [];
  const native = http.createServer((request, response) => {
    observed.push(request.headers);
    if (crossOrigin(request.headers)) { response.writeHead(403); response.end('refused'); return; }
    dispatched++; response.end(JSON.stringify({ task: 'repair', path: request.url }));
  });
  try {
    const nativePort = await listen(native);
    const visits = new DemoVisits(A, 1000, DEMO_LAUNCH_MAX_MS, () => '1'.repeat(32));
    gateway = createDemoGateway({ visits, backends: new Map([[A, { port: nativePort, base: `/generation/${A}/` }]]), now: () => 1000 });
    const port = await listen(gateway.server), host = `127.0.0.1:${port}`, origin = `http://${host}`;
    const visit = visits.begin(1000), referer = `${origin}/visit/${visit.id}/tasks`;
    const get = headers => new Promise((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port, path: `/visit/${visit.id}/api/tasks/repair`, headers }, response => {
        let body=''; response.setEncoding('utf8'); response.on('data', part => { body+=part; }); response.on('end', () => resolve({ status: response.statusCode, body }));
      }); request.on('error', reject);
    });
    const valid = await get({ referer, 'sec-fetch-site': 'same-origin' });
    assert.equal(valid.status, 200); assert.deepEqual(JSON.parse(valid.body), { task: 'repair', path: '/api/tasks/repair' });
    assert.equal(observed.at(-1).host, host); assert.equal(observed.at(-1).referer, referer);
    assert.equal((await get({ origin, 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.equal(dispatched, 2);
    for (const headers of [
      { origin: 'https://foreign.example' }, { referer: 'https://foreign.example/tasks' },
      { origin: `http://127.0.0.1:${nativePort}` }, { referer: `http://127.0.0.1:${nativePort}/tasks` },
      { origin: 'not-a-url' }, { referer: 'not-a-url' }, { referer, 'sec-fetch-site': 'cross-site' },
      { host: 'foreign.example', origin }, { host: 'malformed host', referer },
    ]) {
      assert.equal((await get(headers)).status, 403);
      assert.equal(dispatched, 2, 'foreign or malformed evidence cannot reach native task dispatch');
      for (const [name,value] of Object.entries(headers)) assert.equal(observed.at(-1)[name], value, 'the proxy preserves refusal evidence');
    }
  } finally { await gateway?.stop(); await close(native); }
});
