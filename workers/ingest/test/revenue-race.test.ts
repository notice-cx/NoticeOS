import { env } from 'cloudflare:test';
import type { WorkspaceStore } from '@noticeos/postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleRevenue } from '../src/routes/revenue.js';
import { OPERATOR_TOKEN } from './fixtures.js';
import { effectiveRevenueMinor, reset, storedCount } from './helpers.js';

// The race, made deterministic. Two uploads correcting one estimate each read
// the store, see the estimate as current, and write. The route's pre-read
// cannot stop the second one — only the write can, by re-checking the target
// inside the INSERT itself and giving way to the correction the store's
// one-successor index already holds. `writesAfterAllReads` holds every
// upload's first write until all of them have finished reading, so the
// pre-read is guaranteed stale and the write is what is tested: the two
// transactions then run at once on Postgres, whose baseline always holds the
// chain guards.

/** A call's store whose `write` waits until `parties` callers have reached it. */
function writesAfterAllReads(store: WorkspaceStore, parties: number): WorkspaceStore {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    where: store.where,
    workspaceId: () => store.workspaceId(),
    read: (work) => store.read(work),
    write: async (work) => {
      arrived += 1;
      if (arrived >= parties) open();
      await gate;
      return store.write(work);
    },
    close: () => store.close(),
  };
}

interface UploadBody {
  inserted: number;
  failed: number;
  error?: string;
  results?: { ok: boolean; error?: string; detail?: string }[];
}

async function upload(store: WorkspaceStore, rows: unknown[]): Promise<{ status: number; body: UploadBody }> {
  const request = new Request('https://ingest.local/api/revenue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPERATOR_TOKEN}` },
    body: JSON.stringify(rows),
  });
  const res = await handleRevenue(request, { ...env, STORE: store });
  return { status: res.status, body: (await res.json()) as UploadBody };
}

const rows = () => storedCount('SELECT count(*)::int AS n FROM noticeos.ledger_entries');

const EST = 'raptive-report:est-may';
const estimate = {
  kind: 'revenue',
  asset: 'meals.example',
  period: '2026-05',
  family: 'ads',
  amount: 100,
  source: 'raptive-report',
  booking_state: 'estimated',
  external_id: 'est-may',
};
const correction = (externalId: string, amount: number, supersedes = EST, over: object = {}) => ({
  ...estimate,
  amount,
  booking_state: 'reconciled',
  external_id: externalId,
  supersedes_external_id: supersedes,
  ...over,
});

beforeEach(reset);

describe('POST /api/revenue on the store', () => {
  it('books exactly one of two corrections racing for one estimate', async () => {
    expect((await upload(env.STORE, [estimate])).status).toBe(200);

    const racing = writesAfterAllReads(env.STORE, 2);
    const [a, b] = await Promise.all([
      upload(racing, [correction('fix-a', 200)]),
      upload(racing, [correction('fix-b', 300)]),
    ]);

    // One booking, one per-row refusal — never a 409 from an index, and never
    // a second current figure.
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    const loser = a.status === 422 ? a : b;
    expect(loser.body.results?.[0]).toMatchObject({ ok: false, error: 'already_superseded' });
    expect(loser.body.results?.[0]?.detail).toContain(
      a.status === 200 ? "'raptive-report:fix-a'" : "'raptive-report:fix-b'",
    );
    expect(await rows()).toBe(2);
    expect(await effectiveRevenueMinor()).toBe(a.status === 200 ? 20000 : 30000);
  });

  it('keeps the same-key race to one row and one conflict', async () => {
    const racing = writesAfterAllReads(env.STORE, 2);
    const [a, b] = await Promise.all([upload(racing, [estimate]), upload(racing, [estimate])]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((a.status === 409 ? a : b).body.error).toBe('conflict');
    expect(await rows()).toBe(1);
    expect(await effectiveRevenueMinor()).toBe(10000);
  });

  it('refuses a correction for another asset and period', async () => {
    await upload(env.STORE, [estimate]);
    const { status, body } = await upload(env.STORE, [
      correction('fix-1', 200, EST, { asset: 'nosh.example', period: '2026-06' }),
    ]);
    expect(status).toBe(422);
    expect(body.results?.[0]).toMatchObject({ ok: false, error: 'supersedes_mismatch' });
    expect(await effectiveRevenueMinor()).toBe(10000);
  });

  it('refuses a correction of a replaced entry and books one of the current entry', async () => {
    await upload(env.STORE, [estimate, correction('fix-1', 200)]);
    const stale = await upload(env.STORE, [correction('fix-2', 300)]);
    expect(stale.body.results?.[0]).toMatchObject({ ok: false, error: 'already_superseded' });
    const current = await upload(env.STORE, [correction('fix-2', 300, 'raptive-report:fix-1')]);
    expect(current.status).toBe(200);
    expect(await effectiveRevenueMinor()).toBe(30000);
  });
});
