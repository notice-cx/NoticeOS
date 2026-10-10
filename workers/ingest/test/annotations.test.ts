import { createExecutionContext, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CreateAnnotationInput } from '@noticeos/contract';
import IngestWorker from '../src/index.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { writeAnnotation } from '../src/annotations.js';
import { call, pgCount, reset } from './helpers.js';

beforeEach(reset);

interface AnnotationBody {
  created: boolean;
  duplicate: boolean;
  annotation: {
    id: number;
    asset: string;
    at: string;
    kind: string;
    ref: string | null;
    note: string | null;
  };
}

function annotationRequest(body: unknown, opts: { token?: string; raw?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request('https://ingest.local/api/annotations', {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

describe('POST /api/annotations — auth', () => {
  it('rejects a request without the operator token (401)', async () => {
    const res = await call(annotationRequest({ asset: 'meals.example', kind: 'deploy' }));
    expect(res.status).toBe(401);
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(0);
  });

  it('rejects a wrong operator token (401)', async () => {
    const res = await call(
      annotationRequest({ asset: 'meals.example', kind: 'deploy' }, { token: 'nope' }),
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/annotations — writes', () => {
  it('creates a deploy annotation and returns the row (201)', async () => {
    const res = await call(
      annotationRequest(
        {
          asset: 'meals.example',
          kind: 'deploy',
          at: '2026-07-12T18:04:00.000Z',
          ref: 'a1b2c3d',
          note: 'July SEO batch — 240 recipe titles',
        },
        { token: OPERATOR_TOKEN },
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as AnnotationBody;
    expect(body).toMatchObject({ created: true, duplicate: false });
    expect(body.annotation).toMatchObject({
      asset: 'meals.example',
      at: '2026-07-12T18:04:00.000Z',
      kind: 'deploy',
      ref: 'a1b2c3d',
      note: 'July SEO batch — 240 recipe titles',
    });
    expect(body.annotation.id).toBeGreaterThan(0);
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(1);
  });

  it('defaults `at` to now when it is omitted', async () => {
    const before = Date.now();
    const res = await call(
      annotationRequest({ asset: 'nosh.example', kind: 'config' }, { token: OPERATOR_TOKEN }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as AnnotationBody;
    const at = Date.parse(body.annotation.at);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    expect(body.annotation.ref).toBeNull();
  });

  // A batch that shipped in July has results that land mid-August. Annotating
  // it truthfully means writing it at the ship time, not at the time somebody
  // got around to recording it.
  it('accepts a backdated `at`', async () => {
    const res = await call(
      annotationRequest(
        { asset: 'meals.example', kind: 'deploy', at: '2026-07-02T09:00:00.000Z' },
        { token: OPERATOR_TOKEN },
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as AnnotationBody;
    expect(body.annotation.at).toBe('2026-07-02T09:00:00.000Z');
  });
});

describe('POST /api/annotations — validation', () => {
  it('rejects an unparseable body (400)', async () => {
    const res = await call(annotationRequest(null, { token: OPERATOR_TOKEN, raw: 'not json' }));
    expect(res.status).toBe(400);
  });

  it('rejects a non-object body (400)', async () => {
    const res = await call(annotationRequest([{ asset: 'meals.example' }], { token: OPERATOR_TOKEN }));
    expect(res.status).toBe(400);
  });

  it('rejects an unknown asset (422)', async () => {
    const res = await call(
      annotationRequest({ asset: 'ghost.site', kind: 'deploy' }, { token: OPERATOR_TOKEN }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'unknown_asset', detail: 'ghost.site' });
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(0);
  });

  it('rejects a kind outside the schema CHECK set (422)', async () => {
    const res = await call(
      annotationRequest({ asset: 'meals.example', kind: 'refactor' }, { token: OPERATOR_TOKEN }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; issues: { path: string; code: string }[] };
    expect(body.error).toBe('validation');
    expect(body.issues[0]).toMatchObject({ path: 'kind', code: 'invalid_value' });
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(0);
  });

  it('rejects a future `at` (422)', async () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const res = await call(
      annotationRequest({ asset: 'meals.example', kind: 'deploy', at }, { token: OPERATOR_TOKEN }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: { path: string; message: string }[] };
    expect(body.issues[0]).toMatchObject({ path: 'at' });
    expect(body.issues[0]?.message).toContain('future');
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(0);
  });

  it('rejects a note past the length cap (422)', async () => {
    const res = await call(
      annotationRequest(
        { asset: 'meals.example', kind: 'deploy', note: 'x'.repeat(1001) },
        { token: OPERATOR_TOKEN },
      ),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: { path: string; code: string }[] };
    expect(body.issues[0]).toMatchObject({ path: 'note', code: 'too_big' });
  });

  it('reports every bad field at once', async () => {
    const res = await call(
      annotationRequest(
        { asset: 42, kind: 'nope', ref: 'x'.repeat(300) },
        { token: OPERATOR_TOKEN },
      ),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues.map((issue) => issue.path).sort()).toEqual(['asset', 'kind', 'ref']);
  });
});

describe('POST /api/annotations — idempotence', () => {
  const row = {
    asset: 'meals.example',
    kind: 'deploy',
    at: '2026-07-12T18:04:00.000Z',
    ref: 'a1b2c3d',
    note: 'July SEO batch',
  };

  it('returns the existing row for an identical re-post instead of duplicating it', async () => {
    const first = await call(annotationRequest(row, { token: OPERATOR_TOKEN }));
    expect(first.status).toBe(201);
    const created = (await first.json()) as AnnotationBody;

    const second = await call(annotationRequest(row, { token: OPERATOR_TOKEN }));
    expect(second.status).toBe(200);
    const repeat = (await second.json()) as AnnotationBody;
    expect(repeat).toMatchObject({ created: false, duplicate: true });
    expect(repeat.annotation.id).toBe(created.annotation.id);
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(1);
  });

  // Identity is (asset, at, kind, ref) — the note is prose about the event, not
  // what makes it a different event.
  it('treats a re-post with a different note as the same event', async () => {
    await call(annotationRequest(row, { token: OPERATOR_TOKEN }));
    const second = await call(
      annotationRequest({ ...row, note: 'reworded' }, { token: OPERATOR_TOKEN }),
    );
    const body = (await second.json()) as AnnotationBody;
    expect(body.duplicate).toBe(true);
    expect(body.annotation.note).toBe('July SEO batch');
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(1);
  });

  it('collapses two ref-less events at the same instant, but keeps distinct refs apart', async () => {
    const refless = { asset: 'nosh.example', kind: 'incident', at: '2026-07-12T18:04:00.000Z' };
    await call(annotationRequest(refless, { token: OPERATOR_TOKEN }));
    await call(annotationRequest(refless, { token: OPERATOR_TOKEN }));
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(1);

    await call(annotationRequest({ ...refless, ref: 'inc-9' }, { token: OPERATOR_TOKEN }));
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(2);
  });

  // Postgres runs two writers side by side: the read and the insert hold the
  // event's identity, so posts of one event at once are one row and one answer.
  it('stores one row for one event posted several times at once', async () => {
    const posts = await Promise.all(
      Array.from({ length: 6 }, () => writeAnnotation(env, row as CreateAnnotationInput)),
    );
    const ids = posts.map((post) => (post.ok ? post.annotation.id : null));
    expect(new Set(ids)).toEqual(new Set([ids[0]]));
    expect(posts.filter((post) => post.ok && post.created)).toHaveLength(1);
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(1);
  });

  it('keeps two different kinds at the same instant as separate rows', async () => {
    await call(annotationRequest(row, { token: OPERATOR_TOKEN }));
    const other = await call(
      annotationRequest({ ...row, kind: 'config' }, { token: OPERATOR_TOKEN }),
    );
    expect(other.status).toBe(201);
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(2);
  });
});

// The Control Tower's lane. It cannot hold the operator bearer the HTTP route
// demands (it is served unauthenticated on the LAN), so it writes through the
// private Service Binding, where the binding itself is the capability. Same
// writer, same rules — these cases pin that.
describe('createAnnotation() RPC', () => {
  // The real WorkerEntrypoint over the real test store, constructed the way the
  // runtime constructs it for a Service Binding call. It is not reached through
  // a stub: this pool version's `SELF` is fetch-only and cannot carry RPC. What
  // that leaves untested here is the serialization hop, which the plain-data
  // contract (packages/contract/src/create-annotation.ts) is chosen to survive.
  const ingest = new IngestWorker(createExecutionContext(), env);

  it('writes the row a caller with the binding asks for (created)', async () => {
    const result = await ingest.createAnnotation({
      asset: 'meals.example',
      kind: 'deploy',
      at: '2026-07-12T18:04:00.000Z',
      ref: 'a1b2c3d',
      note: 'July SEO batch — 240 recipe titles',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a written annotation');
    expect(result.created).toBe(true);
    expect(result.annotation).toMatchObject({
      asset: 'meals.example',
      at: '2026-07-12T18:04:00.000Z',
      kind: 'deploy',
      ref: 'a1b2c3d',
      note: 'July SEO batch — 240 recipe titles',
    });
    expect(result.annotation.id).toBeGreaterThan(0);
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(1);
  });

  it('defaults `at` to now and leaves an omitted ref null', async () => {
    const before = Date.now();
    const result = await ingest.createAnnotation({ asset: 'nosh.example', kind: 'config' });
    if (!result.ok) throw new Error('expected a written annotation');
    const at = Date.parse(result.annotation.at);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    expect(result.annotation.ref).toBeNull();
  });

  it('reports a rejected field as a result, not an exception', async () => {
    // The Tower forwards what the browser typed, so an RPC argument is as
    // untrusted as an HTTP body and is validated the same way — the cast is
    // how a caller with a bad `kind` reaches the method at all.
    const result = await ingest.createAnnotation({
      asset: 'meals.example',
      kind: 'refactor',
      note: 'x'.repeat(1001),
    } as unknown as CreateAnnotationInput);

    expect(result).toMatchObject({ ok: false, error: 'validation' });
    if (result.ok || result.error !== 'validation') throw new Error('expected validation');
    expect(result.issues.map((issue) => issue.path).sort()).toEqual(['kind', 'note']);
    expect(result.issues[0]).toMatchObject({ path: 'kind', code: 'invalid_value' });
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(0);
  });

  it('rejects a future `at` and an unknown asset without writing', async () => {
    const future = await ingest.createAnnotation({
      asset: 'meals.example',
      kind: 'deploy',
      at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    if (future.ok || future.error !== 'validation') throw new Error('expected validation');
    expect(future.issues[0]?.path).toBe('at');
    expect(future.issues[0]?.message).toContain('future');

    const ghost = await ingest.createAnnotation({ asset: 'ghost.site', kind: 'deploy' });
    expect(ghost).toMatchObject({ ok: false, error: 'unknown_asset', asset: 'ghost.site' });
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(0);
  });

  it('returns the existing row for a re-post instead of duplicating it', async () => {
    const input = {
      asset: 'meals.example',
      kind: 'deploy',
      at: '2026-07-12T18:04:00.000Z',
      ref: 'a1b2c3d',
      note: 'July SEO batch',
    } as const;

    const first = await ingest.createAnnotation(input);
    if (!first.ok) throw new Error('expected a written annotation');
    expect(first.created).toBe(true);

    // A double-submitted composer, and then the same event reworded.
    const second = await ingest.createAnnotation(input);
    if (!second.ok) throw new Error('expected the existing annotation');
    expect(second.created).toBe(false);
    expect(second.annotation.id).toBe(first.annotation.id);

    const reworded = await ingest.createAnnotation({ ...input, note: 'reworded' });
    if (!reworded.ok) throw new Error('expected the existing annotation');
    expect(reworded.created).toBe(false);
    expect(reworded.annotation.note).toBe('July SEO batch');
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(1);
  });

  // The point of the collapse: one table, one writer, one identity. An event
  // recorded from the Tower and the same event re-posted by an operator script
  // are the same row, not two.
  it('shares its identity rule with the operator HTTP lane', async () => {
    const written = await ingest.createAnnotation({
      asset: 'meals.example',
      kind: 'incident',
      at: '2026-07-20T08:00:00.000Z',
    });
    if (!written.ok) throw new Error('expected a written annotation');

    const res = await call(
      annotationRequest(
        { asset: 'meals.example', kind: 'incident', at: '2026-07-20T08:00:00.000Z' },
        { token: OPERATOR_TOKEN },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnnotationBody;
    expect(body).toMatchObject({ created: false, duplicate: true });
    expect(body.annotation.id).toBe(written.annotation.id);
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(1);
  });
});
