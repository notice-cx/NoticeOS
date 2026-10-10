import { beforeEach, describe, expect, it } from 'vitest';
import {
  INSIGHT_MAX_ITEMS,
  INSIGHT_PAYLOAD_MAX_BYTES,
  insightSnapshotId,
} from '../src/insight-snapshots.js';
import { sha256Hex } from '../src/shared.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { INSIGHT_SNAPSHOTS, call, pgCount, pgRows, reset } from './helpers.js';

beforeEach(reset);

interface SnapshotBody {
  created?: boolean;
  duplicate?: boolean;
  id?: string;
  asset?: string;
  contentSha256?: string;
  generatedAt?: string;
  error?: string;
  detail?: string;
  issues?: { path: string; code: string; message: string }[];
}

/** What `signal-history-analyze.mjs` writes to executive.json, trimmed to the
 * fields this boundary cares about. */
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    asset: 'meadow.example',
    generatedAt: '2026-07-29T12:00:00.000Z',
    windowStart: '2026-07-25',
    windowEnd: '2026-07-28',
    sourceArchiveCount: 17,
    items: [],
    methodology: ['Missing rows remain unknown.'],
    ...overrides,
  };
}

function publishRequest(payload: string, token: string | null): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('https://ingest.local/api/insight-snapshot', {
    method: 'POST',
    headers,
    body: payload,
  });
}

async function publish(
  body: Record<string, unknown> | string = snapshot(),
  token: string | null = OPERATOR_TOKEN,
): Promise<{ status: number; body: SnapshotBody; payload: string }> {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await call(publishRequest(payload, token));
  return { status: res.status, body: (await res.json()) as SnapshotBody, payload };
}

describe('POST /api/insight-snapshot — the door', () => {
  // The route must not be an unauthenticated write.
  it('rejects a write with no operator token (401)', async () => {
    const { status, body } = await publish(snapshot(), null);
    expect(status).toBe(401);
    expect(body.error).toBe('unauthorized');
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.asset_insight_snapshots`)).toBe(0);
  });

  it('rejects a wrong operator token (401)', async () => {
    expect((await publish(snapshot(), 'nope')).status).toBe(401);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.asset_insight_snapshots`)).toBe(0);
  });

  it('refuses a body that is not a JSON object (400)', async () => {
    expect((await publish('not json')).status).toBe(400);
    expect((await publish('[1,2,3]')).status).toBe(400);
  });

  it('refuses a payload past the size ceiling (400)', async () => {
    const huge = JSON.stringify(
      snapshot({ methodology: ['x'.repeat(INSIGHT_PAYLOAD_MAX_BYTES)] }),
    );
    const { status, body } = await publish(huge);
    expect(status).toBe(400);
    expect(body.detail).toMatch(/limit is/);
  });
});

describe('POST /api/insight-snapshot — what it stores', () => {
  it('stores the snapshot exactly as published, content-addressed', async () => {
    const { status, body, payload } = await publish();
    expect(status).toBe(201);
    expect(body.created).toBe(true);
    expect(body.duplicate).toBe(false);

    const expectedSha = await sha256Hex(payload);
    expect(body.contentSha256).toBe(expectedSha);
    expect(body.id).toBe(insightSnapshotId('meadow.example', expectedSha));
    expect(body.id).toMatch(/^insight:meadow\.example:[a-f0-9]{24}$/);

    const [row] = await pgRows(
      `SELECT id, asset, generated_at, window_start, window_end,
              source_archive_count, content_sha256, payload
         FROM ${INSIGHT_SNAPSHOTS}`,
    );
    expect(row).toMatchObject({
      id: body.id,
      asset: 'meadow.example',
      generated_at: '2026-07-29T12:00:00.000Z',
      window_start: '2026-07-25',
      window_end: '2026-07-28',
      source_archive_count: 17,
      content_sha256: expectedSha,
      // Verbatim, not re-serialized: the digest names these exact bytes.
      payload,
    });
  });

  it('stores an open-window snapshot with both bounds null', async () => {
    const { status } = await publish(snapshot({ windowStart: null, windowEnd: null }));
    expect(status).toBe(201);
    const [row] = await pgRows<{ window_start: string | null; window_end: string | null }>(
      `SELECT window_start, window_end FROM ${INSIGHT_SNAPSHOTS}`,
    );
    expect(row).toEqual({ window_start: null, window_end: null });
  });

  // Content-addressing is what makes the lane safe to re-run: the operator who
  // is not sure whether the publish landed can simply run it again.
  it('treats an identical re-publish as a no-op (200, created:false)', async () => {
    const first = await publish();
    expect(first.status).toBe(201);
    const again = await publish();
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.id).toBe(first.body.id);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.asset_insight_snapshots`)).toBe(1);
  });

  it('a changed analysis is a new row, not a replacement', async () => {
    await publish();
    const changed = await publish(snapshot({ sourceArchiveCount: 18 }));
    expect(changed.status).toBe(201);
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.asset_insight_snapshots`)).toBe(2);
  });
});

describe('POST /api/insight-snapshot — validation', () => {
  async function issues(body: Record<string, unknown>): Promise<string[]> {
    const { status, body: answer } = await publish(body);
    expect(status).toBe(422);
    expect(answer.error).toBe('validation');
    return (answer.issues ?? []).map((issue) => issue.path);
  }

  it('refuses an unsupported schema version', async () => {
    expect(await issues(snapshot({ schemaVersion: 2 }))).toContain('schemaVersion');
  });

  it('refuses a missing or malformed asset', async () => {
    expect(await issues(snapshot({ asset: 'NOT VALID' }))).toContain('asset');
    expect(await issues(snapshot({ asset: 42 }))).toContain('asset');
  });

  // A snapshot claiming to be from the future would pin itself to the top of the
  // Tower's newest-first read and make a stale analysis look like today's.
  it('refuses a future generatedAt', async () => {
    const ahead = new Date(Date.now() + 86_400_000).toISOString();
    expect(await issues(snapshot({ generatedAt: ahead }))).toContain('generatedAt');
  });

  it('refuses a half-open or reversed window', async () => {
    expect(await issues(snapshot({ windowEnd: null }))).toContain('windowStart');
    expect(await issues(snapshot({ windowStart: '2026-07-30' }))).toContain('windowEnd');
    expect(await issues(snapshot({ windowStart: 'last week' }))).toContain('windowStart');
  });

  it('refuses a negative or fractional archive count', async () => {
    expect(await issues(snapshot({ sourceArchiveCount: -1 }))).toContain('sourceArchiveCount');
    expect(await issues(snapshot({ sourceArchiveCount: 1.5 }))).toContain('sourceArchiveCount');
  });

  it('refuses items that are not a bounded array', async () => {
    expect(await issues(snapshot({ items: 'none' }))).toContain('items');
    expect(
      await issues(snapshot({ items: Array.from({ length: INSIGHT_MAX_ITEMS + 1 }, () => ({})) })),
    ).toContain('items');
  });

  // A clean error, not a raw FK failure — same posture as the annotation lane.
  it('refuses a property the store does not know (422 unknown_asset)', async () => {
    const { status, body } = await publish(snapshot({ asset: 'not-a-property.test' }));
    expect(status).toBe(422);
    expect(body.error).toBe('unknown_asset');
    expect(body.detail).toBe('not-a-property.test');
  });

  it('writes nothing at all when validation fails', async () => {
    await publish(snapshot({ schemaVersion: 2 }));
    await publish(snapshot({ asset: 'not-a-property.test' }));
    expect(await pgCount(`SELECT count(*) AS n FROM noticeos.asset_insight_snapshots`)).toBe(0);
  });
});
