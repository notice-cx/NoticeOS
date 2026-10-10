import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';

// Every guarded Chromium context uses this transport before creating a page.
// Route handlers alone cannot intercept later redirect hops or WebSocket
// handshakes.
// Chromium's <-loopback> rule removes its implicit localhost proxy bypass.
const transports = new WeakMap();
export async function startOfflineProxy(origin) {
  const source = new URL(origin);
  if (source.origin !== origin || source.protocol !== 'http:' || source.hostname !== '127.0.0.1' || !source.port || source.username || source.password) {
    throw new Error('The offline proxy requires an explicit owned loopback origin.');
  }
  const sockets = new Set(), escapes = [];
  let closing = false, requestFailed = false, closePromise;
  const trackSocket = socket => {
    sockets.add(socket);
    socket.on('error', () => {}); // Request/CONNECT handlers report transport failures.
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const target = (request, tunnel = false) => {
    try {
      // Reject userinfo, relative paths and authority/header disagreement.
      // CONNECT is an authority, never an absolute URL or a path.
      if (tunnel && /[\/@?#]/u.test(request.url)) throw new Error();
      const url = new URL(tunnel ? `http://${request.url}` : request.url);
      if (url.origin !== origin || url.username || url.password || url.hash ||
          request.headers.host?.toLowerCase() !== url.host.toLowerCase()) throw new Error();
      return url;
    } catch {
      const attempted = tunnel ? `http://${request.url}` : request.url;
      if (!escapes.includes(attempted)) escapes.push(attempted);
      return null;
    }
  };
  const server = http.createServer((request, response) => {
    const url = target(request);
    if (!url || closing) { response.writeHead(403); response.end(); return; }
    const headers = { ...request.headers, host: source.host };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    // The destination is fixed by construction, not resolved from an input
    // hostname. Node does not follow this response's redirects.
    const upstream = http.request({ hostname: source.hostname, port: source.port, path: url.pathname + url.search,
      method: request.method, headers, agent: false }, incoming => {
      const location = incoming.headers.location;
      if (incoming.statusCode >= 300 && incoming.statusCode < 400 && location) {
        let redirect;
        try { redirect = new URL(location, url); } catch { requestFailed = true; }
        if (!redirect || redirect.origin !== origin || redirect.username || redirect.password) {
          if (redirect && !escapes.includes(redirect.href)) escapes.push(redirect.href);
          incoming.resume(); response.destroy(); return;
        }
      }
      response.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(response);
      incoming.on('error', () => { if (!closing && !response.destroyed) requestFailed = true; response.destroy(); });
    });
    upstream.on('socket', trackSocket);
    upstream.on('error', () => {
      if (!closing && !response.destroyed) requestFailed = true;
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.once('close', () => upstream.destroy());
    request.on('error', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('connection', trackSocket);
  server.on('connect', (request, client, head) => {
    if (!target(request, true) || closing) { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const upstream = trackSocket(net.connect({ host: source.hostname, port: Number(source.port) }));
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => { if (!closing && !client.destroyed) requestFailed = true; client.destroy(); });
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  });
  // Chromium tunnels WebSockets with CONNECT. Refuse any other upgrade form
  // rather than letting Node leave an unhandled socket open.
  server.on('upgrade', (request, socket) => { target(request); socket.destroy(); });
  server.requestTimeout = 30_000;
  server.headersTimeout = 30_000;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const boundary = {
    proxy: { server: `http://127.0.0.1:${server.address().port}`, bypass: '<-loopback>' },
    escapes: () => [...escapes],
    failed: () => requestFailed,
    clear() { escapes.length = 0; },
    close() {
      closePromise ??= new Promise((resolve, reject) => {
        closing = true;
        // Destroy both tunnel ends and outstanding HTTP requests. Shutdown
        // never waits indefinitely for keep-alive or a held WebSocket.
        const timer = setTimeout(() => reject(new Error('The offline proxy could not finish cleanup.')), 1000);
        server.close(error => { clearTimeout(timer); error ? reject(new Error('The offline proxy could not finish cleanup.')) : resolve(); });
        for (const socket of sockets) socket.destroy();
      });
      return closePromise;
    },
  };
  transports.set(boundary, origin);
  return boundary;
}

// A browser test never leaves its fixture, not even by a redirect. Playwright
// hands a route handler only the first request of a redirect chain, so a
// fixture answering a navigation with a 302 to another host would take the
// browser to the real internet unseen. google-consent.mjs closes that for one
// route; this closes it for every route, in both runners:
//
//   - the owned proxy refuses every foreign HTTP or CONNECT target before
//     connecting, retaining native redirect and WebSocket semantics;
//   - `check()` names the first recorded URL; the runner fails the test on it.
//
// Requests to other origins that are not redirect hops are aborted silently:
// they never left, so they are not a failure.

/** Is `url` on `origin`? Browser-internal schemes never leave the machine. */
function onOrigin(url, origin) {
  if (/^(?:data|blob|about|chrome|chrome-error):/u.test(url)) return true;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Keep `context` on `origin`. Install before any other route: later routes
 * (a test's own stubs, google-consent.mjs) run first and fall back to this.
 */
export async function installOfflineGuard(context, origin, { transport } = {}) {
  if (transports.get(transport) !== origin) {
    throw new Error('The offline browser requires its owned proxy transport.');
  }
  const escapes = [];
  const pending = new Set();
  const closeReason = `offline-guard-close-${randomUUID()}`;
  let closing = false, closePromise, requestFailed = false;
  const failure = (code, message) => Object.assign(new Error(message), { code });
  const recordFailure = error => {
    // Playwright includes our explicit close reason when context.close cancels
    // a route still in flight. Other errors, even during cleanup, remain
    // failures.
    if (!closing || !String(error?.message).includes(closeReason)) requestFailed = true;
  };
  const track = (action, abort) => {
    const run = Promise.resolve().then(action).catch(async error => {
      recordFailure(error);
      if (abort) try { await abort(); } catch (error) { recordFailure(error); }
    }).finally(() => pending.delete(run));
    pending.add(run);
    return run;
  };
  await context.route("**/*", route => track(async () => {
    if (!onOrigin(route.request().url(), origin)) return route.abort("blockedbyclient");
    return route.fallback();
  }, () => route.abort("blockedbyclient")));
  context.on("request", (request) => {
    if (request.redirectedFrom() && !onOrigin(request.url(), origin)) escapes.push(request.url());
  });
  return {
    /** The foreign URLs a redirect or WebSocket tried to reach, in order. */
    escapes: () => [...new Set([...escapes, ...transport.escapes()])],
    /** Null, or the failure naming the first foreign URL. */
    check() {
      if (requestFailed || transport.failed()) return 'The offline browser could not complete an internal request.';
      const attempted = this.escapes();
      if (!attempted.length) return null;
      return `The browser attempted to leave the fixture for ${attempted[0]}${attempted.length > 1 ? ` (and ${attempted.length - 1} more)` : ""}. ` +
        "A test reaches only its fixture server: answer that route in the fixture, or rewrite the redirect (see google-consent.mjs).";
    },
    /** Forget what was recorded (a test that provoked it on purpose). */
    clear() {
      escapes.length = 0;
      transport.clear();
    },
    /** Keep denial installed until pages close, then drain cancelled callbacks. */
    close() {
      closePromise ??= (async () => {
        closing = true;
        let closeFailed = false;
        try { await context.close({ reason: closeReason }); } catch { closeFailed = true; }
        while (pending.size) await Promise.all([...pending]);
        if (closeFailed) throw failure('OFFLINE_BROWSER_CLEANUP_FAILED', 'The offline browser could not finish cleanup.');
        if (requestFailed) throw failure('OFFLINE_BROWSER_REQUEST_FAILED', 'The offline browser could not complete an internal request.');
      })();
      return closePromise;
    },
  };
}
