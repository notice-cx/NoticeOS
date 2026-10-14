import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { chosenEncoding, compressReply } from '../vite/compress-replies';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done)))); });

/** A server whose every reply passes through the compression wrapper. */
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer((req, res) => { compressReply(req, res); handler(req, res); });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function get(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer; chunks: number }>((resolve, reject) => {
    httpRequest(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks), chunks: chunks.length }));
    }).on('error', reject).end();
  });
}
const json = JSON.stringify({ tasks: Array.from({ length: 200 }, (_, index) => ({ id: `ex-${index}`, title: 'A task with a title' })) });

describe('replies from the standalone Tower', () => {
  it('are compressed with Brotli or gzip when the browser accepts it, and decode to the same bytes', async () => {
    const base = await serve((_req, res) => { res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(json); });
    const br = await get(base, { 'accept-encoding': 'gzip, deflate, br' });
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toContain('Accept-Encoding');
    expect(br.body.length).toBeLessThan(json.length / 4);
    expect(brotliDecompressSync(br.body).toString()).toBe(json);
    const gzip = await get(base, { 'accept-encoding': 'gzip' });
    expect(gzip.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(gzip.body).toString()).toBe(json);
    const plain = await get(base);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString()).toBe(json);
  });

  it('compress a reply relayed with writeHead and streamed in pieces, as the Worker relay and Vite write them', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': String(json.length) });
      res.write(json.slice(0, 1000));
      res.end(json.slice(1000));
    });
    const reply = await get(base, { 'accept-encoding': 'gzip' });
    expect(reply.headers['content-encoding']).toBe('gzip');
    expect(reply.headers['content-length']).toBeUndefined();
    expect(gunzipSync(reply.body).toString()).toBe(json);
  });

  it('leave a 304, a small reply, a non-text reply and the change stream as they are', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/unchanged') { res.statusCode = 304; res.setHeader('etag', '"a"'); res.end(); return; }
      if (req.url === '/small') { res.setHeader('content-type', 'application/json'); res.setHeader('content-length', '2'); res.end('{}'); return; }
      if (req.url === '/image') { res.setHeader('content-type', 'image/png'); res.end(Buffer.alloc(4096)); return; }
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.write('event: change\ndata: {}\n\n');
      setTimeout(() => res.end('event: fresh\ndata: {}\n\n'), 50);
    });
    const accept = { 'accept-encoding': 'br, gzip' };
    expect((await get(`${base}/unchanged`, accept)).headers['content-encoding']).toBeUndefined();
    expect((await get(`${base}/small`, accept)).body.toString()).toBe('{}');
    expect((await get(`${base}/image`, accept)).headers['content-encoding']).toBeUndefined();
    const stream = await get(`${base}/changes`, accept);
    expect(stream.headers['content-encoding']).toBeUndefined();
    expect(stream.chunks).toBeGreaterThan(1);
    expect(stream.body.toString()).toBe('event: change\ndata: {}\n\nevent: fresh\ndata: {}\n\n');
  });

  it('read Accept-Encoding with its weights', () => {
    expect(chosenEncoding('gzip, br;q=0')).toBe('gzip');
    expect(chosenEncoding('identity')).toBeNull();
    expect(chosenEncoding(undefined)).toBeNull();
  });
});
