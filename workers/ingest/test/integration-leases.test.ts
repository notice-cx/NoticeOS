import { env } from 'cloudflare:test';
import { MediavineError } from '@noticeos/mediavine';
import { beforeEach, describe, expect, it } from 'vitest';
import { cachedGa4Read } from '../src/ga4-read-cache.js';
import { Ga4ReadError } from '../src/ga4-read-errors.js';
import { MEDIAVINE_LEASE, withMediavineLease } from '../src/mediavine-connection.js';
import { POSTHOG_LEASE_MS, claimPosthogLease, posthogLeaseKey, releasePosthogLease } from '../src/posthog-dumps.js';
import { reset } from './helpers.js';

// One collector at a time, on Postgres. A lease is one row of
// `noticeos.integration_leases`, taken by one INSERT … ON CONFLICT DO UPDATE …
// WHERE the row has expired. Postgres locks the row, so of two takers at the
// same instant the second waits for the first and then finds it held: exactly
// one gets it. Each lease the ingest takes is proved here — the Mediavine
// account's, a PostHog site's and a GA4 read's — with both takers sent at once
// over separate connections, round after round, and each with an expired
// lease that can be taken and a live one that cannot.

beforeEach(reset);

const NOW = Date.parse('2026-09-29T12:00:00Z');
const ROUNDS = 8;

/** A lease held by someone else until `expiresAt`, as a crashed run leaves it. */
async function leftBehind(key: string, expiresAt: number): Promise<void> {
  await env.STORE.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.integration_leases (workspace_id, lease_key, owner, expires_at) VALUES ($1::uuid, $2, 'crashed-run', $3::timestamptz)
       ON CONFLICT (workspace_id, lease_key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at`,
      [tx.workspaceId, key, new Date(expiresAt)],
    ),
  );
}

/** A gate a lease holder waits on, so its lease is held while the other taker decides. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('the Mediavine lease', () => {
  it('goes to exactly one of two takers at the same instant, round after round', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const held = gate();
      let inside = 0;
      const work = async () => {
        inside += 1;
        await held.wait;
      };
      const takers = [withMediavineLease(env, work, { nowMs: NOW }), withMediavineLease(env, work, { nowMs: NOW })];
      // The holder waits inside its work, so the first to settle is the one refused.
      const first = await Promise.race(takers.map((taker) => taker.then(() => 'ran', (error: unknown) => error)));
      expect(first).toBeInstanceOf(MediavineError);
      expect((first as MediavineError).kind).toBe('busy');
      expect(inside).toBe(1);
      held.open();
      const settled = await Promise.allSettled(takers);
      expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    }
  });

  it('can be taken once it has expired, and not a millisecond before', async () => {
    await leftBehind(MEDIAVINE_LEASE, NOW + 600_000);
    await expect(withMediavineLease(env, async () => 'ran', { nowMs: NOW + 599_999 })).rejects.toMatchObject({ kind: 'busy' });
    await expect(withMediavineLease(env, async () => 'ran', { nowMs: NOW + 600_000 })).resolves.toBe('ran');
  });
});

describe('a PostHog site lease', () => {
  it('goes to exactly one of two runs asking at the same instant, round after round', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const at = NOW + round * 1000;
      const claims = await Promise.all([
        claimPosthogLease(env.STORE, 'meals.example', at),
        claimPosthogLease(env.STORE, 'meals.example', at),
      ]);
      const owners = claims.filter((claim) => claim.owner !== null);
      expect(owners).toHaveLength(1);
      expect(claims.find((claim) => claim.owner === null)?.heldBy).toMatchObject({
        leaseExpiresAt: new Date(at + POSTHOG_LEASE_MS).toISOString(),
      });
      // Given back, so the next round's two runs find no row at all.
      await releasePosthogLease(env.STORE, 'meals.example', owners[0]!.owner!);
    }
  });

  it('goes to exactly one of two runs taking over the same expired lease', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      await leftBehind(posthogLeaseKey('meals.example'), NOW);
      const claims = await Promise.all([
        claimPosthogLease(env.STORE, 'meals.example', NOW),
        claimPosthogLease(env.STORE, 'meals.example', NOW),
      ]);
      expect(claims.filter((claim) => claim.owner !== null)).toHaveLength(1);
    }
  });

  it('can be taken once it has expired, and not a millisecond before', async () => {
    await leftBehind(posthogLeaseKey('meals.example'), NOW + 1);
    expect((await claimPosthogLease(env.STORE, 'meals.example', NOW)).owner).toBeNull();
    expect((await claimPosthogLease(env.STORE, 'meals.example', NOW + 1)).owner).not.toBeNull();
  });
});

describe('a GA4 read lease', () => {
  const cold = async () => ({ store: env.STORE, cache: await caches.open(crypto.randomUUID()), scope: 'property-a' });

  it('lets exactly one of two cold readers at the same instant ask Google, round after round', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const at = NOW + round * 60_000;
      const held = gate();
      let reads = 0;
      const read = async () => {
        reads += 1;
        await held.wait;
        return 7;
      };
      const [a, b] = [await cold(), await cold()];
      const readers = [cachedGa4Read(a, 'realtime', at, 30_000, read), cachedGa4Read(b, 'realtime', at, 30_000, read)];
      const first = await Promise.race(readers.map((reader) => reader.then(() => 'read', (error: unknown) => error)));
      expect(first).toBeInstanceOf(Ga4ReadError);
      expect((first as Ga4ReadError).code).toBe('ga4_read_in_progress');
      expect(reads).toBe(1);
      held.open();
      const settled = await Promise.allSettled(readers);
      expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    }
  });

  it('can be taken once it has expired, and not a millisecond before', async () => {
    await leftBehind('ga4-read:property-a:realtime', NOW + 30_000);
    await expect(cachedGa4Read(await cold(), 'realtime', NOW + 29_999, 30_000, async () => 7)).rejects.toMatchObject({
      code: 'ga4_read_in_progress',
    });
    await expect(cachedGa4Read(await cold(), 'realtime', NOW + 30_000, 30_000, async () => 7)).resolves.toMatchObject({ value: 7 });
  });
});
