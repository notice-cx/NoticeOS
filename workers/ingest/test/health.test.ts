import { describe, expect, it } from 'vitest';
import { call } from './helpers.js';

describe('GET /healthz', () => {
  it('returns 200 ok', async () => {
    const res = await call(new Request('https://ingest.local/healthz'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'ingest' });
  });

  it('returns 404 for an unknown route', async () => {
    const res = await call(new Request('https://ingest.local/nope'));
    expect(res.status).toBe(404);
  });
});
