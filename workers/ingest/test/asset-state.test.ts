import { afterEach, describe, expect, it } from 'vitest';
import { OPERATOR_TOKEN } from './fixtures.js';
import { call } from './helpers.js';
import { changeSites, storeSites, siteInStore } from './sites';

// These tests edit seeded sites and restore their fixture state after each test.
const SEEDED = {
  'meals.example': { status: 'onboarding', sense_only: 0, display_name: 'Meal Planner' },
  'fees.example': { status: 'pre-launch', sense_only: 1, display_name: 'Fee Codes' },
} as const;
const SEEDED_AT = '2026-07-05T00:00:00.000Z';

afterEach(async () => {
  for (const [id, row] of Object.entries(SEEDED)) {
    await changeSites([id], { status: row.status, senseOnly: row.sense_only, displayName: row.display_name, updatedAt: SEEDED_AT });
  }
});

interface StateBody {
  asset?: string;
  known?: boolean;
  columns?: { status: string; sense_only: number; display_name: string } | null;
  updatedAt?: string | null;
  updated?: boolean;
  column?: string;
  value?: string | number;
  error?: string;
  detail?: string;
  issues?: { path: string; code: string; message: string }[];
}

function headers(token: string | null): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function read(
  asset: string,
  token: string | null = OPERATOR_TOKEN,
): Promise<{ status: number; body: StateBody }> {
  const res = await call(
    new Request(`https://ingest.local/api/asset-state?asset=${encodeURIComponent(asset)}`, {
      headers: headers(token),
    }),
  );
  return { status: res.status, body: (await res.json()) as StateBody };
}

async function edit(
  body: unknown,
  token: string | null = OPERATOR_TOKEN,
): Promise<{ status: number; body: StateBody }> {
  const res = await call(
    new Request('https://ingest.local/api/asset-state', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers(token) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as StateBody };
}

/** The stored row for `asset`. */
async function stored(asset: string) {
  const row = await siteInStore(asset);
  return row && { status: row.status, sense_only: row.sense_only, display_name: row.display_name, updated_at: row.updated_at };
}

describe('GET /api/asset-state — the expect guard reads through the runtime', () => {
  it('rejects a read with no operator token (401)', async () => {
    expect((await read('meals.example', null)).status).toBe(401);
    expect((await read('meals.example', 'nope')).status).toBe(401);
  });

  it('answers every sanctioned column and nothing else', async () => {
    const { status, body } = await read('meals.example');
    expect(status).toBe(200);
    expect(body).toEqual({
      asset: 'meals.example',
      known: true,
      columns: { status: 'onboarding', sense_only: 0, display_name: 'Meal Planner' },
      updatedAt: SEEDED_AT,
    });
  });

  it('refuses a missing or malformed asset id (400)', async () => {
    expect((await read('')).status).toBe(400);
    expect((await read('NOT VALID')).status).toBe(400);
  });

  // A 404 would abort a whole `config:apply` run with a transport error. The
  // guard asked what the store holds, and "no such asset" is the answer — the
  // CLI renders it `(absent)` and reports the op as a mismatch to re-stage.
  it('answers known:false for a property the store does not have (200)', async () => {
    const { status, body } = await read('not-a-property.test');
    expect(status).toBe(200);
    expect(body).toEqual({
      asset: 'not-a-property.test',
      known: false,
      columns: null,
      updatedAt: null,
    });
  });
});

describe('asset column writes compare their expected value atomically', () => {
  it('allows only one of two concurrent edits based on the same stored value', async () => {
    const results = await Promise.all([
      edit({ asset: 'meals.example', column: 'display_name', value: 'First saved name', expect: 'Meal Planner' }),
      edit({ asset: 'meals.example', column: 'display_name', value: 'Second saved name', expect: 'Meal Planner' }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const winner = results.find(result => result.status === 200)!;
    const conflict = results.find(result => result.status === 409)!;
    expect(conflict.body).toMatchObject({ error: 'expect_mismatch', column: 'display_name', current: winner.body.value });
    expect((await stored('meals.example'))?.display_name).toBe(winner.body.value);
  });
});

describe('POST /api/asset-state — the door', () => {
  // This route exists because config:apply used to write through a second
  // runtime. It must not have traded that for an unauthenticated store edit.
  it('rejects an edit with no operator token (401)', async () => {
    const { status, body } = await edit({ asset: 'meals.example', column: 'status', value: 'live' }, null);
    expect(status).toBe(401);
    expect(body.error).toBe('unauthorized');
    expect(await stored('meals.example')).toMatchObject({ status: 'onboarding' });
  });

  it('rejects a wrong operator token (401)', async () => {
    expect(
      (await edit({ asset: 'meals.example', column: 'status', value: 'live' }, 'nope')).status,
    ).toBe(401);
    expect(await stored('meals.example')).toMatchObject({ status: 'onboarding' });
  });

  it('refuses a body that is not a JSON object (400/422)', async () => {
    expect((await edit('not json')).status).toBe(400);
    expect((await edit([1, 2, 3])).status).toBe(422);
  });
});

describe('POST /api/asset-state — what it will edit', () => {
  // db/README sanctions `status`, `sense_only` and `display_name`; every other
  // column is identity or entity metadata.
  it('refuses a column db/README does not sanction (422)', async () => {
    for (const column of ['domain', 'is_os', 'id', 'created_at', 'updated_at']) {
      const { status, body } = await edit({ asset: 'meals.example', column, value: 'x' });
      expect(status).toBe(422);
      expect(body.error).toBe('validation');
      expect((body.issues ?? []).map((issue) => issue.path)).toContain('column');
    }
    expect(await stored('meals.example')).toMatchObject({
      status: 'onboarding',
      sense_only: 0,
      updated_at: SEEDED_AT,
    });
  });

  it('refuses a status outside the lifecycle enum (422)', async () => {
    const { status, body } = await edit({
      asset: 'meals.example',
      column: 'status',
      value: 'shipping',
    });
    expect(status).toBe(422);
    expect((body.issues ?? []).map((issue) => issue.path)).toContain('value');
    expect(await stored('meals.example')).toMatchObject({ status: 'onboarding' });
  });

  it('refuses a sense_only that is not 0 or 1 (422)', async () => {
    for (const value of [2, -1, true, '1', null, 0.5]) {
      const { status, body } = await edit({ asset: 'meals.example', column: 'sense_only', value });
      expect(status).toBe(422);
      expect((body.issues ?? []).map((issue) => issue.path)).toContain('value');
      // Named as the Settings tab names it (bead ro-ujb9.183), never "value".
      expect(body.issues?.[0]?.message).toMatch(/^Automation /);
    }
    expect(await stored('meals.example')).toMatchObject({ sense_only: 0 });
  });

  it('refuses a missing or malformed asset (422)', async () => {
    expect(
      ((await edit({ column: 'status', value: 'live' })).body.issues ?? []).map((i) => i.path),
    ).toContain('asset');
    expect(
      (await edit({ asset: 'NOT VALID', column: 'status', value: 'live' })).body.issues,
    ).toEqual([{ path: 'asset', code: 'invalid_value', message: 'Site must be a site id' }]);
  });

  it('refuses a property the store does not know (422 unknown_asset)', async () => {
    const { status, body } = await edit({
      asset: 'not-a-property.test',
      column: 'status',
      value: 'live',
    });
    expect(status).toBe(422);
    expect(body.error).toBe('unknown_asset');
    expect(body.detail).toBe('not-a-property.test');
  });

  it("refuses a name for the OS's own row, and leaves the stored value alone (ro-ujb9.77.10)", async () => {
    const os = (await storeSites()).find((site) => site.is_os === 1);
    const before = await stored(os!.id);
    const { status, body } = await edit({ asset: os!.id, column: 'display_name', value: 'Something else' });
    expect(status).toBe(422);
    expect(body.error).toBe('validation');
    expect(body.issues).toEqual([
      { path: 'column', code: 'fixed', message: 'The OS is always called NoticeOS; its name is not a setting' },
    ]);
    expect(await stored(os!.id)).toEqual(before);
  });
});

describe('POST /api/asset-state — what it stores', () => {
  it('moves the lifecycle and stamps updated_at from the runtime clock', async () => {
    const { status, body } = await edit({
      asset: 'meals.example',
      column: 'status',
      value: 'baselining',
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      updated: true,
      asset: 'meals.example',
      column: 'status',
      value: 'baselining',
    });

    const row = await stored('meals.example');
    expect(row).toMatchObject({ status: 'baselining', sense_only: 0 });
    expect(row?.updated_at).toBe(body.updatedAt);
    expect(row?.updated_at).not.toBe(SEEDED_AT);
  });

  it('flips the posture flag and leaves the lifecycle alone', async () => {
    const { status, body } = await edit({
      asset: 'meals.example',
      column: 'sense_only',
      value: 1,
    });
    expect(status).toBe(200);
    expect(body.value).toBe(1);
    expect(await stored('meals.example')).toMatchObject({ status: 'onboarding', sense_only: 1 });
  });

  it('edits only the asset it was given', async () => {
    await edit({ asset: 'fees.example', column: 'status', value: 'onboarding' });
    expect(await stored('fees.example')).toMatchObject({ status: 'onboarding' });
    expect(await stored('meals.example')).toMatchObject({ status: 'onboarding', sense_only: 0 });
    expect((await stored('nosh.example'))?.updated_at).toBe(SEEDED_AT);
  });

  it('renames the stored site', async () => {
    const { status, body } = await edit({ asset: 'meals.example', column: 'display_name', value: 'Meal Planner Pro' });
    expect(status).toBe(200);
    expect(body.value).toBe('Meal Planner Pro');
    expect(await stored('meals.example')).toMatchObject({ display_name: 'Meal Planner Pro', updated_at: body.updatedAt });
  });
});

describe('the site list is read on Postgres', () => {
  it('reads the current stored value for the expect guard', async () => {
    await changeSites(['meals.example'], { displayName: 'Stored Name' });
    expect((await read('meals.example')).body.columns?.display_name).toBe('Stored Name');
  });
});
