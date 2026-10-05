// Loopback-only generation routing for the finite local demo launcher.
import http from 'node:http';
import { DemoVisitRefusal, DEMO_REQUEST_MAX_MS } from './demo-visit.mjs';

const GENERATION = /^\/generation\/([a-f0-9]{64})(\/[^#]*)?$/u;
const EXPIRED = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Demo visit ended</title><main><h1>Demo visit ended.</h1><a href="/open">Open current demo</a></main></html>';
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function headersOf(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== 'host'));
}
function reply(response, status, body, html = false) {
  response.statusCode = status;
  response.setHeader('content-type', html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8');
  response.end(html ? body : JSON.stringify(body));
}

/** The only upstreams are exact owned readers supplied by the launcher.
 * This selector neither authenticates callers nor broadens viewer permissions. */
export function createDemoGateway({ visits, backends, now, request = http.request }) {
  const inFlight = new Set();
  const sockets = new Map();
  const server = http.createServer((incoming, response) => {
    let selected;
    let timer;
    let upstream;
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      selected?.release();
      inFlight.delete(cancel);
    };
    const cancel = () => { upstream?.destroy(); if (!response.writableEnded) response.destroy(); finish(); };
    response.once('close', cancel);
    response.once('finish', finish);
    try {
      const raw = incoming.url ?? '';
      if (incoming.method === 'GET' && (raw === '/' || raw === '/open')) {
        const visit = visits.begin(now());
        response.writeHead(302, { location: `/visit/${visit.id}/` });
        response.end();
        return;
      }
      let generation, relative, asset = false;
      const match = raw.match(GENERATION);
      if (match) {
        if (now() >= visits.deadline) throw new DemoVisitRefusal(410, 'demo_launcher_expired');
        generation = match[1]; relative = match[2] ?? '/'; asset = true;
        const pathname = relative.split('?')[0];
        if (incoming.method !== 'GET' || /[\\\r\n\0]/u.test(raw) || /%(?:2e|2f|5c|00|0a|0d)/iu.test(pathname)
          || pathname.split('/').some(part => part === '.' || part === '..')
          || pathname === '/' || pathname.startsWith('/api/') || pathname.startsWith('/cdn-cgi/')) {
          throw new DemoVisitRefusal(400, 'demo_asset_invalid');
        }
      } else {
        selected = visits.resolve(raw, now());
        generation = selected.visit.generation; relative = selected.path;
      }
      const backend = backends.get(generation);
      if (!backend || !Number.isInteger(backend.port) || backend.port < 1024 || backend.port > 65534
        || backend.base !== `/generation/${generation}/`) throw new DemoVisitRefusal(503, 'demo_generation_unavailable');
      const pathname = relative.split('?')[0];
      // Native readers register their original /api paths before Vite's base
      // middleware. Documents and module imports use that backend's own base.
      const api = pathname.startsWith('/api/') || pathname.startsWith('/cdn-cgi/');
      const target = asset ? raw : api ? relative : backend.base + relative.slice(1);
      inFlight.add(cancel);
      timer = setTimeout(() => {
        upstream?.destroy();
        if (!response.headersSent) reply(response, 504, { error: 'demo_read_timeout' });
        else response.destroy();
        finish();
      }, DEMO_REQUEST_MAX_MS);
      upstream = request({ hostname: '127.0.0.1', port: backend.port, method: incoming.method,
        // The TCP destination is the owned reader. Host remains the browser's
        // actual origin, alongside its untouched Origin/Referer evidence.
        path: target, headers: { ...headersOf(incoming.headers), host: incoming.headers.host } }, result => {
        const headers = headersOf(result.headers);
        const location = headers.location;
        if (location !== undefined) {
          // Never bounce a pinned document to an upstream or successor origin.
          if (!selected || typeof location !== 'string' || !location.startsWith(backend.base)) {
            result.destroy(); reply(response, 502, { error: 'demo_redirect_refused' }); finish(); return;
          }
          headers.location = `/visit/${selected.visit.id}/` + location.slice(backend.base.length);
        }
        response.writeHead(result.statusCode ?? 502, headers);
        result.on('error', cancel);
        result.pipe(response);
      });
      upstream.once('error', () => {
        if (!response.headersSent) reply(response, 502, { error: 'demo_reader_unavailable' });
        else response.destroy();
        finish();
      });
      incoming.once('aborted', cancel);
      incoming.pipe(upstream);
    } catch (error) {
      const status = error instanceof DemoVisitRefusal ? error.status : 503;
      const code = error instanceof DemoVisitRefusal ? error.code : 'demo_reader_unavailable';
      const document = incoming.method === 'GET' && !String(incoming.url).includes('/api/');
      reply(response, status, status === 410 && document ? EXPIRED : { error: code }, status === 410 && document);
      finish();
    }
  });
  // Vite's development channel belongs to the same sealed generation as its
  // modules. No application WebSocket route or arbitrary destination exists.
  server.on('upgrade', (incoming, socket, head) => {
    const match = String(incoming.url).match(/^\/generation\/([a-f0-9]{64})\/\?token=([a-zA-Z0-9_-]{1,256})$/u);
    const backend = match && backends.get(match[1]);
    if (!backend || now() >= visits.deadline || incoming.headers['sec-websocket-protocol'] !== 'vite-hmr'
      || !Number.isInteger(backend.port) || backend.port < 1024 || backend.port > 65534 || backend.base !== `/generation/${match[1]}/`) { socket.destroy(); return; }
    let known = sockets.get(match[1]);
    if (!known) { known = new Set(); sockets.set(match[1], known); }
    if (known.size >= 1024) { socket.destroy(); return; }
    const pending = request({ hostname: '127.0.0.1', port: backend.port, method: 'GET', path: incoming.url,
      headers: { ...incoming.headers, host: `127.0.0.1:${backend.port}` } });
    let peer;
    const close = () => { pending.destroy(); peer?.destroy(); socket.destroy(); known.delete(close); };
    known.add(close);
    const timer = setTimeout(close, DEMO_REQUEST_MAX_MS);
    pending.once('upgrade', (result, upstream, initial) => {
      clearTimeout(timer); peer = upstream;
      socket.write(`HTTP/1.1 ${result.statusCode} ${result.statusMessage}\r\n`);
      for (const [name, value] of Object.entries(result.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) socket.write(`${name}: ${item}\r\n`);
      }
      socket.write('\r\n');
      if (initial.length) socket.write(initial);
      if (head.length) upstream.write(head);
      upstream.on('error', close); upstream.on('close', close);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    pending.once('response', close); pending.once('error', close);
    socket.on('error', close); socket.on('close', () => { clearTimeout(timer); close(); });
    pending.end();
  });
  const retire = generation => {
    for (const close of [...(sockets.get(generation) ?? [])]) close();
    sockets.delete(generation);
  };
  return Object.freeze({ server, retire, stop: async () => {
    for (const generation of [...sockets.keys()]) retire(generation);
    for (const cancel of [...inFlight]) cancel();
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } });
}
