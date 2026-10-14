import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILT_RELEASE_FILE, builtClientDir, builtClientMiddleware } from '../vite/built-client';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'built-client-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>');
  writeFileSync(path.join(dir, BUILT_RELEASE_FILE), 'release-a\n');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** One request through the middleware: what it answered, or that it passed. */
function serve(url: string, headers: Record<string, string> = {}, method = 'GET') {
  return new Promise<{ passed: boolean; status: number; headers: Record<string, string>; body: string }>((resolve) => {
    const chunks: Buffer[] = [];
    const answered: Record<string, string> = {};
    const res = Object.assign(new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }), {
      statusCode: 200, headersSent: false,
      setHeader(name: string, value: string) { answered[name] = value; },
    });
    res.on('finish', () => resolve({ passed: false, status: res.statusCode, headers: answered, body: Buffer.concat(chunks).toString() }));
    builtClientMiddleware(dir)({ method, url, headers } as unknown as IncomingMessage, res as unknown as ServerResponse,
      () => resolve({ passed: true, status: 0, headers: {}, body: '' }));
  });
}

describe("a production installation's built app", () => {
  it('is served only when it was built from this release', () => {
    expect(builtClientDir(dir, 'release-a')).toBe(dir);
    expect(builtClientDir(dir, 'release-b')).toBeNull();
    expect(builtClientDir(path.join(dir, 'missing'), 'release-a')).toBeNull();
  });

  it('answers its hashed files for a year and its other files checked each time, with 304 to a held copy', async () => {
    const asset = await serve('/assets/index-abc123.js');
    expect(asset.body).toBe('console.log(1)');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    const icon = await serve('/favicon.svg');
    expect(icon.headers['cache-control']).toBe('no-cache');
    expect((await serve('/favicon.svg', { 'if-none-match': icon.headers.etag! })).status).toBe(304);
  });

  it("answers a page a browser opens with the app's page, as the Worker's single-page handling does", async () => {
    for (const page of ['/', '/tasks', '/assets/meadow.example/overview']) {
      const reply = await serve(page, { accept: 'text/html,application/xhtml+xml' });
      expect(reply.body, page).toContain('<div id="root">');
      expect(reply.headers['cache-control']).toBe('no-cache');
    }
  });

  it('leaves the Worker, the dev server, missing files, writes and paths outside it to the next handler', async () => {
    const html = { accept: 'text/html' };
    for (const [url, headers, method] of [
      ['/api/wall', html, 'GET'], ['/.well-known/oauth-authorization-server/x', html, 'GET'], ['/@vite/client', {}, 'GET'],
      ['/assets/missing.js', {}, 'GET'], ['/tasks', {}, 'GET'], ['/tasks', html, 'POST'],
    ] as const) {
      expect((await serve(url, headers, method)).passed, `${method} ${url}`).toBe(true);
    }
  });

  it('never reads a file outside the built app', async () => {
    writeFileSync(path.join(dir, '..', `${path.basename(dir)}-outside.txt`), 'secret');
    const reply = await serve(`/..%2F${path.basename(dir)}-outside.txt`, { accept: 'text/html' });
    expect(reply.body).not.toContain('secret');
    rmSync(path.join(dir, '..', `${path.basename(dir)}-outside.txt`), { force: true });
  });
});
