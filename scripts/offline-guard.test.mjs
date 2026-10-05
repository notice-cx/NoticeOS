import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { installOfflineGuard, startOfflineProxy } from '../apps/tower/e2e/offline-guard.mjs';
import { exerciseCopiedStoreBrowser, withOfflineContext } from '../apps/tower/e2e/rehearsal-browser.mjs';

test('normal contexts require their own fixture transport and the proxy rejects foreign authorities', async t => {
  await assert.rejects(installOfflineGuard({}, 'http://127.0.0.1:5333'), /owned proxy transport/);
  for (const origin of ['https://127.0.0.1:5333', 'http://localhost:5333', 'http://127.0.0.1:5333/path']) {
    await assert.rejects(startOfflineProxy(origin), /owned loopback origin/);
  }
  const servers = [http.createServer((request, response) => response.end('owned source')), http.createServer((request, response) => response.end('owned sentinel'))];
  let foreignContacts = 0;
  servers[1].on('connection', () => foreignContacts++);
  for (const server of servers) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  t.after(async () => {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  const [source, foreign] = servers.map(server => new URL(`http://127.0.0.1:${server.address().port}`));
  const transport = await startOfflineProxy(source.origin);
  t.after(() => transport.close());
  await assert.rejects(installOfflineGuard({}, foreign.origin, { transport }), /owned proxy transport/);
  const proxy = new URL(transport.proxy.server);
  for (const [method, path, host] of [
    ['GET', foreign.origin + '/refused', foreign.host],
    ['GET', source.origin + '/authority-mismatch', foreign.host],
    ['GET', '/relative-path', source.host],
    ['CONNECT', foreign.host, foreign.host],
    ['CONNECT', source.host + '/extra', source.host],
  ]) {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: proxy.hostname, port: proxy.port, method, path, headers: { host } }, response => {
        response.resume(); resolve(response.statusCode);
      });
      request.on('connect', (response, socket) => { socket.destroy(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(status, 403);
  }
  assert.equal(transport.escapes().length, 5);
  assert.equal(transport.failed(), false);
  assert.equal(foreignContacts, 0);
});

test('the proxy retains a truncated owned response as a failure and closes held requests', async t => {
  let arrived;
  const pending = new Promise(resolve => { arrived = resolve; });
  const source = http.createServer((request, response) => {
    if (request.url === '/held') { arrived(); return; }
    response.writeHead(200, { 'content-length': 100 });
    response.write('truncated');
    response.socket.destroy();
  });
  source.listen(0, '127.0.0.1'); await once(source, 'listening');
  t.after(async () => { source.closeAllConnections(); await new Promise(resolve => source.close(resolve)); });
  const origin = `http://127.0.0.1:${source.address().port}`;
  const transport = await startOfflineProxy(origin);
  t.after(() => transport.close());
  const proxy = new URL(transport.proxy.server);
  const call = path => new Promise(resolve => {
    const request = http.request({ hostname: proxy.hostname, port: proxy.port, path: origin + path, headers: { host: new URL(origin).host } }, response => {
      response.on('error', () => {}); response.resume(); response.on('close', resolve);
    });
    request.on('error', () => resolve()); request.end();
  });
  await call('/truncated');
  assert.equal(transport.failed(), true);
  transport.clear(); assert.equal(transport.failed(), true);
  const held = call('/held'); await pending;
  await transport.close(); await held;
});

test('route failures remain generic caller-visible failures instead of rejected event callbacks', async () => {
  let handler;
  const context = { async route(_, handle) { handler = handle; }, async routeWebSocket() {}, on() {}, async close() {} };
  const guard = await installOfflineGuard(context, 'http://127.0.0.1:5333', { strict: true });
  await handler({ request: () => ({ url: () => 'http://127.0.0.1:5333/private-url-sentinel' }),
    async fetch() { throw new Error('private-url-sentinel'); }, async abort() {} });
  assert.equal(guard.check(), 'The offline browser could not complete an internal request.');
  await assert.rejects(guard.close(), error => error.code === 'OFFLINE_BROWSER_REQUEST_FAILED' && !error.message.includes('sentinel'));
});

test('fallback, fulfil, abort and WebSocket failures are retained without exposing diagnostics', async t => {
  for (const operation of ['fallback', 'fulfill', 'abort', 'websocket']) {
    let handler, websocket;
    const context = { async route(_, handle) { handler = handle; }, async routeWebSocket(_, handle) { websocket = handle; }, on() {}, async close() {} };
    const transport = operation === 'fallback' ? await startOfflineProxy('http://127.0.0.1:5333') : undefined;
    if (transport) t.after(() => transport.close());
    const guard = await installOfflineGuard(context, 'http://127.0.0.1:5333', { strict: operation !== 'fallback', transport });
    const fail = async () => { throw new Error('private-url-sentinel'); };
    if (operation === 'websocket') await websocket({ close: fail });
    else await handler({ request: () => ({ url: () => operation === 'abort' ? 'http://127.0.0.1:5334/private-url-sentinel' : 'http://127.0.0.1:5333/save',
      isNavigationRequest: () => false }), fallback: fail, fulfill: fail,
      async fetch() { return { status: () => 200, headers: () => ({}) }; }, abort: operation === 'abort' ? fail : async () => {} });
    guard.clear(); // Refusal can be reset; transport failure cannot.
    await assert.rejects(guard.close(), error => error.code === 'OFFLINE_BROWSER_REQUEST_FAILED' && !error.message.includes('sentinel'));
  }
});

test('denial stays installed during close and cancellation is recognized only by its owned close reason', async () => {
  let handler, websocket, rejectFetch, started;
  const inFlight = new Promise(resolve => { started = resolve; });
  let aborted = 0, socketClosed = 0;
  const context = { async route(_, handle) { handler = handle; }, async routeWebSocket(_, handle) { websocket = handle; }, on() {},
    async close({ reason }) {
      await handler({ request: () => ({ url: () => 'http://127.0.0.1:5334/private-url-sentinel' }), async abort() { aborted++; } });
      await websocket({ async close() { socketClosed++; } });
      rejectFetch(new Error(reason));
    } };
  const guard = await installOfflineGuard(context, 'http://127.0.0.1:5333', { strict: true });
  const pending = handler({ request: () => ({ url: () => 'http://127.0.0.1:5333/delayed' }),
    fetch() { started(); return new Promise((_, reject) => { rejectFetch = reject; }); }, async abort() {} });
  await inFlight;
  await guard.close();
  await pending;
  assert.deepEqual([aborted, socketClosed], [1, 1]);
  assert.equal(guard.check(), 'The offline browser refused an external request.');
});

test('genuine request failure during teardown still reaches the caller', async () => {
  let handler, rejectFetch, started;
  const inFlight = new Promise(resolve => { started = resolve; });
  const context = { async route(_, handle) { handler = handle; }, async routeWebSocket() {}, on() {},
    async close() { rejectFetch(new Error('private-url-sentinel genuine failure')); } };
  const guard = await installOfflineGuard(context, 'http://127.0.0.1:5333', { strict: true });
  const pending = handler({ request: () => ({ url: () => 'http://127.0.0.1:5333/delayed' }),
    fetch() { started(); return new Promise((_, reject) => { rejectFetch = reject; }); }, async abort() {} });
  await inFlight;
  await assert.rejects(guard.close(), error => error.code === 'OFFLINE_BROWSER_REQUEST_FAILED');
  await pending;
});

test('guarded context cleanup preserves its primary failed check and reports late failures', async () => {
  const primary = new Error('original required check');
  const context = () => ({ async route() {}, async routeWebSocket() {}, on() {}, async close() { throw new Error('private cleanup sentinel'); } });
  const browser = { async newContext() { return context(); } };
  await assert.rejects(withOfflineContext(browser, 'http://127.0.0.1:5333', async () => { throw primary; }), error => error === primary);
  await assert.rejects(withOfflineContext(browser, 'http://127.0.0.1:5333', async () => {}), error => error.code === 'OFFLINE_BROWSER_CLEANUP_FAILED' && !error.message.includes('sentinel'));
  const steps = [];
  await assert.rejects(exerciseCopiedStoreBrowser({ rateValue: NaN, onStep: step => steps.push(step) }), error =>
    error.code === 'COPIED_BROWSER_CHECK_FAILED' && error.step === 'input' && !error.message.includes('NaN'));
  assert.deepEqual(steps, ['input']);
});

test('primary assertion survives cancellation of a route still in flight', async () => {
  const primary = new Error('original required check');
  let handler, rejectFetch, started;
  const inFlight = new Promise(resolve => { started = resolve; });
  const context = { async route(_, handle) { handler = handle; }, async routeWebSocket() {}, on() {},
    async close({ reason }) { rejectFetch(new Error(reason)); } };
  const browser = { async newContext() { return context; } };
  await assert.rejects(withOfflineContext(browser, 'http://127.0.0.1:5333', async () => {
    void handler({ request: () => ({ url: () => 'http://127.0.0.1:5333/delayed' }),
      fetch() { started(); return new Promise((_, reject) => { rejectFetch = reject; }); }, async abort() {} });
    await inFlight;
    throw primary;
  }), error => error === primary);
});

const enabled = process.env.NOTICEOS_TEST_OFFLINE_BROWSER === '1';
test('owned proxy preserves native redirects and HMR while foreign redirects and sockets make zero contacts', { skip: !enabled, timeout: 30000 }, async () => {
  const { JOURNEY_BROWSERS } = await import('../apps/tower/e2e/journey-browsers.mjs');
  process.env.PLAYWRIGHT_BROWSERS_PATH = JOURNEY_BROWSERS;
  const { chromium } = await import('../apps/tower/node_modules/@playwright/test/index.mjs');
  const { createHash } = await import('node:crypto');
  let foreignContacts = 0;
  const foreign = http.createServer((request, response) => response.end('owned foreign sentinel'));
  foreign.on('connection', () => foreignContacts++);
  foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening');
  const foreignOrigin = `http://127.0.0.1:${foreign.address().port}`;
  const seen = [];
  const ownedSockets = new Set();
  const source = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    seen.push({ path: request.url, method: request.method, body });
    const redirect = (status, location) => { response.writeHead(status, { location }); response.end(); };
    if (request.url === '/own-start') return redirect(302, '/own-second');
    if (request.url === '/own-second') return redirect(301, '/own-final');
    if (request.url === '/foreign-start') return redirect(302, '/foreign-second');
    if (request.url === '/foreign-second') return redirect(302, foreignOrigin + '/navigation');
    if (request.url.startsWith('/foreign-post/')) return redirect(Number(request.url.split('/').at(-1)), foreignOrigin + '/post');
    if (request.url.startsWith('/own-post/')) return redirect(Number(request.url.split('/').at(-1)), '/own-result');
    if (request.url === '/own-result') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ method: request.method, body })); return; }
    response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>Owned browser fixture</title>');
  });
  source.on('connection', socket => { ownedSockets.add(socket); socket.once('close', () => ownedSockets.delete(socket)); });
  let ownWebSockets = 0;
  source.on('upgrade', (request, socket) => {
    ownWebSockets++;
    assert.equal(request.headers['sec-websocket-protocol'], 'vite-hmr');
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n');
    // One unmasked server text frame proves that the tunneled stream works.
    socket.write(Buffer.from([0x81, 5, ...Buffer.from('ready')]));
    socket.on('data', () => {});
  });
  source.listen(0, '127.0.0.1'); await once(source, 'listening');
  const origin = `http://127.0.0.1:${source.address().port}`;
  let browser, transport, guard;
  try {
    transport = await startOfflineProxy(origin);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block', proxy: transport.proxy });
    guard = await installOfflineGuard(context, origin, { transport });
    let page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(origin + '/own-start');
    assert.equal(page.url(), origin + '/own-final');
    for (const status of [302, 303, 307, 308]) {
      const result = await page.evaluate(async status => {
        const response = await fetch('/own-post/' + status, { method: 'POST', body: 'preserved=body' });
        return { url: response.url, ...await response.json() };
      }, status);
      assert.deepEqual(result, { url: origin + '/own-result', method: status < 307 ? 'GET' : 'POST', body: status < 307 ? '' : 'preserved=body' });
    }
    const hmr = await page.evaluate(() => new Promise((resolve, reject) => {
      const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/hmr', 'vite-hmr');
      socket.onerror = () => reject(new Error('Owned HMR failed'));
      socket.onmessage = event => { window.ownedHmr = socket; resolve({ protocol: socket.protocol, message: event.data }); };
    }));
    assert.deepEqual(hmr, { protocol: 'vite-hmr', message: 'ready' });
    assert.equal(ownWebSockets, 1);
    assert.equal(guard.check(), null);

    await assert.rejects(page.goto(origin + '/foreign-start'));
    assert.ok(!page.url().startsWith(foreignOrigin));
    assert.notEqual(guard.check(), null); guard.clear();
    await page.close(); page = await context.newPage(); page.setDefaultTimeout(5000);
    await page.goto(origin);
    for (const status of [302, 303, 307, 308]) {
      await page.evaluate(async status => { await fetch('/foreign-post/' + status, { method: 'POST', body: 'foreign=refused' }).catch(() => {}); }, status);
      assert.notEqual(guard.check(), null); guard.clear();
    }
    const refusedForm = page.waitForEvent('requestfailed', { predicate: request => request.url() === origin + '/foreign-post/307' });
    await page.evaluate(() => {
      const form = document.createElement('form'); form.method = 'POST'; form.action = '/foreign-post/307';
      const field = document.createElement('input'); field.name = 'form'; field.value = 'refused'; form.append(field); document.body.append(form); form.submit();
    });
    await refusedForm;
    assert.ok(!page.url().startsWith(foreignOrigin));
    assert.notEqual(guard.check(), null); guard.clear();
    await page.close(); page = await context.newPage(); page.setDefaultTimeout(5000);
    await page.goto(origin);
    for (const scheme of ['ws:', 'wss:']) {
      await page.evaluate(url => new Promise(resolve => {
        const socket = new WebSocket(url); socket.onerror = () => resolve(); socket.onclose = () => resolve();
      }), foreignOrigin.replace('http:', scheme) + '/socket');
      assert.notEqual(guard.check(), null); guard.clear();
    }
    assert.equal(foreignContacts, 0, 'no TCP connection reaches the owned foreign sentinel');
    assert.deepEqual(seen.filter(request => request.path.startsWith('/own-post/')).map(request => [request.method, request.body]), Array(4).fill(['POST', 'preserved=body']));
    assert.equal(guard.check(), null);
    // Leave HMR open: cleanup must close its tunnel rather than await it.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/hmr', 'vite-hmr');
      socket.onerror = () => reject(new Error('Owned HMR failed'));
      socket.onmessage = () => { window.ownedHmr = socket; resolve(); };
    }));
    await guard.close();
    await transport.close();
    assert.equal(guard.check(), null);
  } finally {
    try { await guard?.close(); } finally {
      try { await browser?.close(); } finally {
        await transport?.close();
        for (const socket of ownedSockets) socket.destroy();
        for (const server of [source, foreign]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      }
    }
  }
});

test('delayed actual route is cancelled and drained before context teardown completes', { skip: !enabled, timeout: 30000 }, () => {
  // Child isolation is intentional: the old route callback exits the process
  // before caller cleanup can report its failure.
  const script = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import { once } from 'node:events';
    import { JOURNEY_BROWSERS } from './apps/tower/e2e/journey-browsers.mjs';
    import { installOfflineGuard } from './apps/tower/e2e/offline-guard.mjs';
    process.env.PLAYWRIGHT_BROWSERS_PATH = JOURNEY_BROWSERS;
    const { chromium } = await import('./apps/tower/node_modules/@playwright/test/index.mjs');
    let arrived;
    const pending = new Promise(resolve => arrived = resolve);
    const source = http.createServer((req, res) => {
      if (req.url === '/private-url-sentinel') { arrived(); return; }
      res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Owned delayed request</title>');
    });
    source.listen(0, '127.0.0.1'); await once(source, 'listening');
    const origin = 'http://127.0.0.1:' + source.address().port;
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const guard = await installOfflineGuard(context, origin, { strict: true });
      const page = await context.newPage();
      await page.goto(origin);
      await page.evaluate(() => { void fetch('/private-url-sentinel').catch(() => {}); });
      await pending;
      // The fallback makes this same reproduction executable against the
      // original guard, where closing the request context causes the crash.
      await (guard.close ? guard.close() : context.close());
      assert.equal(guard.check(), null);
    } finally {
      await browser.close(); source.closeAllConnections();
      await new Promise(resolve => source.close(resolve));
    }
    console.log('owned teardown complete');
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 25000,
    env: Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) });
  assert.equal(run.status, 0, 'delayed teardown must reach the caller without an unhandled rejection');
  assert.equal(run.stdout.trim(), 'owned teardown complete');
  assert.equal(run.stderr, '');
});
