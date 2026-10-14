import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANSWER_TIMES_HEADER, namesValidator, withReadValidator } from '../shared/read-validator';
import { sendReply } from '../vite/lane';
import { createBrowserRuntime } from '@/lib/browser-runtime';

const origin = 'https://desk.example';
const get = (path: string, headers: Record<string, string> = {}) => new Request(`${origin}${path}`, { headers });
const json = (body: unknown) => Response.json(body, { headers: { 'cache-control': 'no-store' } });

describe('a read the browser already holds', () => {
  it('answers 304 with no body to its own validator, and in full once the data changes', async () => {
    const first = await withReadValidator(get('/api/work'), json({ open: 3 }));
    const validator = first.headers.get('etag')!;
    expect(first.status).toBe(200);
    expect(validator).toMatch(/^"[0-9a-f]{32}"$/u);
    expect(await first.json()).toEqual({ open: 3 });

    const same = await withReadValidator(get('/api/work', { 'if-none-match': validator }), json({ open: 3 }));
    expect(same.status).toBe(304);
    expect(same.headers.get('etag')).toBe(validator);
    expect(same.headers.get('cache-control')).toBe('no-store');
    expect(await same.text()).toBe('');

    const changed = await withReadValidator(get('/api/work', { 'if-none-match': validator }), json({ open: 4 }));
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(validator);
    expect(await changed.json()).toEqual({ open: 4 });
  });

  it('answers 304 when only the time the answer was made differs, and carries the new time', async () => {
    const first = await withReadValidator(get('/api/wall'), json({ generatedAt: '2026-10-14T00:00:00.000Z', open: 3 }));
    const again = await withReadValidator(get('/api/wall', { 'if-none-match': first.headers.get('etag')! }),
      json({ generatedAt: '2026-10-14T00:00:30.000Z', open: 3 }));
    expect(again.status).toBe(304);
    expect(JSON.parse(again.headers.get(ANSWER_TIMES_HEADER)!)).toEqual({ generatedAt: '2026-10-14T00:00:30.000Z' });
  });

  it('leaves writes, failures, other content and paths outside the API as they are', async () => {
    const post = new Request(`${origin}/api/work`, { method: 'POST', body: '{}' });
    for (const [request, response] of [
      [post, json({ ok: true })],
      [get('/api/work'), Response.json({ error: 'not_found' }, { status: 404 })],
      [get('/api/work'), new Response('text', { headers: { 'content-type': 'text/plain' } })],
      [get('/assets/app.js'), json({})],
    ] as const) {
      expect((await withReadValidator(request, response)).headers.get('etag')).toBeNull();
    }
  });

  it('matches a listed or weak form of the same validator, never a wildcard', () => {
    expect(namesValidator('"a", W/"b"', '"b"')).toBe(true);
    expect(namesValidator('"a"', '"b"')).toBe(false);
    expect(namesValidator('*', '"b"')).toBe(false);
    expect(namesValidator(undefined, '"b"')).toBe(false);
  });

  it('is answered the same way by the local lanes', () => {
    const reply = (headers: Record<string, string | undefined> = {}) => {
      const written: { status?: number; headers: Record<string, string>; body?: string } = { headers: {} };
      const res = {
        set statusCode(value: number) { written.status = value; },
        setHeader(name: string, value: string) { written.headers[name] = value; },
        removeHeader(name: string) { delete written.headers[name]; },
        end(body?: string) { written.body = body; },
      } as unknown as ServerResponse;
      sendReply(res, { status: 200, body: { open: 3 } }, { method: 'GET', headers });
      return written;
    };
    const first = reply();
    expect(first.status).toBe(200);
    expect(first.body).toBe('{"open":3}');
    const same = reply({ 'if-none-match': first.headers.etag });
    expect(same.status).toBe(304);
    expect(same.body).toBeUndefined();
    expect(same.headers['cache-control']).toBe('no-store');
  });
});

describe("the page's copy of a read", () => {
  const retired: Array<() => void> = [];
  afterEach(() => { for (const retire of retired.splice(0)) retire(); });

  it('sends the validator it holds and hands back its copy, with the new answer time, for a 304', async () => {
    let at = 0;
    let open = 3;
    const sent: (string | null)[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      sent.push(request.headers.get('if-none-match'));
      return withReadValidator(request, json({ generatedAt: new Date(at++ * 1000).toISOString(), open }));
    });
    const runtime = createBrowserRuntime<string>({ mode: 'standalone', clientGeneration: 0 }, { origin, fetch, sendAnswer: async () => {} });
    retired.push(runtime.retire);

    expect(await runtime.api.fetchWork()).toEqual({ generatedAt: '1970-01-01T00:00:00.000Z', open: 3 });
    expect(await runtime.api.fetchWork()).toEqual({ generatedAt: '1970-01-01T00:00:01.000Z', open: 3 });
    open = 4;
    expect(await runtime.api.fetchWork()).toEqual({ generatedAt: '1970-01-01T00:00:02.000Z', open: 4 });
    expect(sent[0]).toBeNull();
    expect(sent[1]).toMatch(/^"[0-9a-f]{32}"$/u);
    expect(sent[2]).toBe(sent[1]);
    const statuses = await Promise.all(fetch.mock.results.map(async (result) => (await result.value as Response).status));
    expect(statuses).toEqual([200, 304, 200]);
  });
});
