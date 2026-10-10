import { env } from 'cloudflare:test';
import { javascriptInstant, openWorkspaceStore } from '@noticeos/postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedGa4Read, ga4CacheScope, type Ga4ReadCache } from '../src/ga4-read-cache.js';
import { Ga4ReadError, ga4ReadFailure, ga4RateLimitKind } from '../src/ga4-read-errors.js';
import { asOwner, reset } from './helpers.js';

const NOW = Date.parse('2026-09-11T00:00:00Z');
async function context(scope = 'property-a'): Promise<Ga4ReadCache> {
  return { store: env.STORE, cache: await caches.open(crypto.randomUUID()), scope };
}
beforeEach(reset);

describe('shared Google read budget', () => {
  it('separates identical reads and refusal cooldowns in two workspaces sharing one cache', async () => {
    const workspaceId = crypto.randomUUID();
    const first = await context();
    await asOwner(`INSERT INTO noticeos.workspaces (workspace_id, slug, display_name)
      VALUES ('${workspaceId}', 'cache-fixture', 'Cache fixture');`);
    const store = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId });
    const second = { ...first, store };
    try {
      const readA = vi.fn(async () => 'workspace A');
      const readB = vi.fn(async () => 'workspace B');
      expect((await cachedGa4Read(first, 'realtime', NOW, 30_000, readA)).value).toBe('workspace A');
      expect((await cachedGa4Read(second, 'realtime', NOW, 30_000, readB)).value).toBe('workspace B');
      expect((await cachedGa4Read(first, 'realtime', NOW + 1_000, 30_000, readA)).value).toBe('workspace A');
      expect((await cachedGa4Read(second, 'realtime', NOW + 1_000, 30_000, readB)).value).toBe('workspace B');
      expect(readA).toHaveBeenCalledTimes(1);
      expect(readB).toHaveBeenCalledTimes(1);
      const until = new Date(NOW + 300_000).toISOString();
      await expect(cachedGa4Read(first, 'hourly', NOW, 900_000, async () => {
        throw new Ga4ReadError('ga4_intraday_http_429', new Date(NOW).toISOString(), until);
      })).rejects.toMatchObject({ nextAttemptAt: until });
      await expect(cachedGa4Read(second, 'hourly', NOW, 900_000, readB)).resolves.toMatchObject({ value: 'workspace B' });
      await expect(cachedGa4Read(first, 'hourly', NOW + 1_000, 900_000, readA)).rejects.toMatchObject({ nextAttemptAt: until });
      expect(readA).toHaveBeenCalledTimes(1);
    } finally {
      await store.close();
      await asOwner(`DELETE FROM noticeos.integration_leases WHERE workspace_id = '${workspaceId}';
        DELETE FROM noticeos.workspaces WHERE workspace_id = '${workspaceId}';`);
    }
  });
  it('refuses unresolved ownership before consulting a cache or contacting the provider', async () => {
    const ctx = await context();
    const match = vi.fn(ctx.cache.match.bind(ctx.cache));
    const read = vi.fn(async () => 7);
    const store = { ...ctx.store, workspaceId: async (): Promise<string> => { throw new Error('Workspace unavailable'); } };
    const cache: Cache = { match, put: ctx.cache.put.bind(ctx.cache), delete: ctx.cache.delete.bind(ctx.cache) };
    await expect(cachedGa4Read({ ...ctx, store, cache }, 'realtime', NOW, 30_000, read))
      .rejects.toThrow('Workspace unavailable');
    expect(match).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it('serves many dashboards from one provider observation without redating it', async () => {
    const ctx = await context();
    const read = vi.fn(async () => ({ users: 7 }));
    const first = await cachedGa4Read(ctx, 'realtime', NOW, 30_000, read);
    const copies = await Promise.all(Array.from({ length: 8 }, () => cachedGa4Read(ctx, 'realtime', NOW + 5_000, 30_000, read)));
    expect(read).toHaveBeenCalledTimes(1);
    expect(copies.every((copy) => copy.observedAt === first.observedAt && copy.value.users === 7)).toBe(true);
    await cachedGa4Read(ctx, 'realtime', NOW + 30_000, 30_000, read);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('prevents concurrent cold clients from spending the same request budget', async () => {
    const ctx = await context();
    let release!: (value: number) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const first = cachedGa4Read(ctx, 'realtime', NOW, 30_000, () => {
      started();
      return new Promise<number>((resolve) => { release = resolve; });
    });
    await reading;
    const duplicate = vi.fn(async () => 99);
    await expect(cachedGa4Read(ctx, 'realtime', NOW, 30_000, duplicate)).rejects.toMatchObject({ code: 'ga4_read_in_progress' });
    expect(duplicate).not.toHaveBeenCalled();
    release(7);
    await expect(first).resolves.toMatchObject({ value: 7 });
  });
  it('retains refusals across cache loss and retries successfully after cooldown', async () => {
    const ctx = await context();
    const until = new Date(NOW + 300_000).toISOString();
    const refuse = vi.fn(async () => { throw new Ga4ReadError('ga4_realtime_http_429', new Date(NOW).toISOString(), until, 'daily-requests'); });
    await expect(cachedGa4Read(ctx, 'realtime', NOW, 30_000, refuse)).rejects.toMatchObject({ rateLimit: 'daily-requests' });
    const cold = { ...ctx, cache: await caches.open(crypto.randomUUID()) };
    const recover = vi.fn(async () => 0);
    await expect(cachedGa4Read(cold, 'realtime', NOW + 120_000, 30_000, recover)).rejects.toMatchObject({ nextAttemptAt: until, observedAt: new Date(NOW).toISOString() });
    expect(recover).not.toHaveBeenCalled();
    await expect(cachedGa4Read(cold, 'realtime', NOW + 300_000, 30_000, recover)).resolves.toMatchObject({ value: 0 });
    const row = await leaseRow('realtime');
    expect(row?.last_error).toBeNull();
  });
  it('keeps realtime, hourly, and unrelated properties independent', async () => {
    const ctx = await context();
    const fail = async () => { throw ga4ReadFailure('ga4_realtime', new Response(null, { status: 429 }), {}, NOW); };
    await expect(cachedGa4Read(ctx, 'realtime', NOW, 30_000, fail)).rejects.toThrow();
    const read = vi.fn(async () => 7);
    await cachedGa4Read(ctx, 'hourly', NOW, 900_000, read);
    await cachedGa4Read({ ...ctx, scope: 'property-b' }, 'realtime', NOW, 30_000, read);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('never serves yesterday’s chart: the new day’s key reads once at midnight, inside the last cooldown', async () => {
    const ctx = await context();
    await cachedGa4Read({ ...ctx, version: 'day-one' }, 'hourly', NOW, 900_000, async () => 'yesterday');
    const read = vi.fn(async () => 'today');
    await expect(cachedGa4Read({ ...ctx, version: 'day-two' }, 'hourly', NOW + 1000, 900_000, read)).resolves.toMatchObject({ value: 'today' });
    await expect(cachedGa4Read({ ...ctx, version: 'day-two' }, 'hourly', NOW + 2000, 900_000, read)).resolves.toMatchObject({ value: 'today' });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('uses the actual grant in an opaque scope, including same-length replacements', async () => {
    const a = await ga4CacheScope({ grant: 'fixture-one', property: 'a' });
    const b = await ga4CacheScope({ grant: 'fixture-two', property: 'a' });
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(b);
  });
});

/** Lease rows as the read left them, instants in epoch milliseconds: a lease
 * given back ends at the epoch (0), and no cooldown yet (NULL) reads as 0. */
async function leaseRow(capability = 'realtime', scope = 'property-a') {
  const [row] = await env.STORE.read((tx) => tx.query<{ expires_at: string; cooldown_until: string | null; last_error: string | null }>(
    'SELECT expires_at, cooldown_until, last_error FROM noticeos.integration_leases WHERE lease_key = $1', [`ga4-read:${scope}:${capability}`]));
  if (row === undefined) return null;
  const ms = (instant: string) => Date.parse(javascriptInstant(instant));
  return { expires_at: ms(row.expires_at), cooldown_until: row.cooldown_until === null ? 0 : ms(row.cooldown_until), last_error: row.last_error };
}

describe('an empty cache never blanks the Wall for a success cooldown', () => {
  it('reads at once when the cache is empty and only a success cooldown is held', async () => {
    const ctx = await context();
    await cachedGa4Read(ctx, 'hourly', NOW, 900_000, async () => 'before the deploy');
    // A deploy's new runtime: the lease still holds the 15-minute success
    // cooldown, and this cache has nothing to show.
    const cold = { ...ctx, cache: await caches.open(crypto.randomUUID()) };
    const read = vi.fn(async () => 'after the deploy');
    await expect(cachedGa4Read(cold, 'hourly', NOW + 60_000, 900_000, read)).resolves.toMatchObject({
      value: 'after the deploy', observedAt: new Date(NOW + 60_000).toISOString(),
    });
    expect(read).toHaveBeenCalledTimes(1);
    // The new reading is cached: the next poll is served without a read.
    await expect(cachedGa4Read(cold, 'hourly', NOW + 90_000, 900_000, read)).resolves.toMatchObject({ value: 'after the deploy' });
    expect(read).toHaveBeenCalledTimes(1);
    // The cooldown restarts from the early read, and its lease is held
    // through it.
    expect(await leaseRow('hourly')).toEqual({ expires_at: NOW + 960_000, cooldown_until: NOW + 960_000, last_error: null });
  });

  it('still refuses to read when the cache is empty and a provider refusal’s cooldown is held', async () => {
    const ctx = await context();
    const until = new Date(NOW + 600_000).toISOString();
    await expect(cachedGa4Read(ctx, 'hourly', NOW, 900_000, async () => {
      throw new Ga4ReadError('ga4_intraday_http_429', new Date(NOW).toISOString(), until, 'hourly-tokens');
    })).rejects.toMatchObject({ code: 'ga4_intraday_http_429' });
    const cold = { ...ctx, cache: await caches.open(crypto.randomUUID()) };
    const read = vi.fn(async () => 'too soon');
    await expect(cachedGa4Read(cold, 'hourly', NOW + 60_000, 900_000, read)).rejects.toMatchObject({
      code: 'ga4_intraday_http_429', rateLimit: 'hourly-tokens', nextAttemptAt: until,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('lets only one of two concurrent cold callers read, and admits no second early read in its cooldown', async () => {
    const ctx = await context();
    await cachedGa4Read(ctx, 'hourly', NOW, 900_000, async () => 'before');
    let release!: (value: string) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const first = cachedGa4Read({ ...ctx, cache: await caches.open(crypto.randomUUID()) }, 'hourly', NOW + 60_000, 900_000, () => {
      started();
      return new Promise<string>((resolve) => { release = resolve; });
    });
    await reading;
    const second = vi.fn(async () => 'duplicate');
    await expect(cachedGa4Read({ ...ctx, cache: await caches.open(crypto.randomUUID()) }, 'hourly', NOW + 60_000, 900_000, second))
      .rejects.toMatchObject({ code: 'ga4_read_in_progress' });
    release('early');
    await expect(first).resolves.toMatchObject({ value: 'early' });
    // A cache that keeps nothing: every caller is cold, and the lease still
    // spends no third read before the early read's cooldown ends.
    for (const at of [NOW + 90_000, NOW + 600_000, NOW + 959_999]) {
      await expect(cachedGa4Read({ ...ctx, cache: await caches.open(crypto.randomUUID()) }, 'hourly', at, 900_000, second))
        .rejects.toMatchObject({ code: 'ga4_read_in_progress' });
    }
    expect(second).not.toHaveBeenCalled();
    await expect(cachedGa4Read({ ...ctx, cache: await caches.open(crypto.randomUUID()) }, 'hourly', NOW + 960_000, 900_000, second))
      .resolves.toMatchObject({ value: 'duplicate' });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('leaves the cooldown in place when a claim finds the reading another caller just cached', async () => {
    const ctx = await context();
    await cachedGa4Read(ctx, 'hourly', NOW, 900_000, async () => 'before');
    const cooldown = (await leaseRow('hourly'))!.cooldown_until;
    // This caller looked before the reading landed; it claims, then finds it.
    const store = await caches.open(crypto.randomUUID());
    let looks = 0;
    const cache: Cache = {
      match: async (request, options) => (++looks === 1 ? undefined : store.match(request, options)),
      put: (request, response) => store.put(request, response),
      delete: (request, options) => store.delete(request, options),
    };
    const workspace = await ga4CacheScope([env.STORE.where, await env.STORE.workspaceId()]);
    await store.put(`https://noticeos-cache.internal/ga4/v2/${workspace}/property-a/hourly/current`, Response.json({
      ok: true, value: 'cached', observedAt: new Date(NOW + 50_000).toISOString(), refreshAt: new Date(NOW + 950_000).toISOString(),
    }, { headers: { 'cache-control': 'max-age=86400' } }));
    const read = vi.fn(async () => 'unneeded');
    await expect(cachedGa4Read({ ...ctx, cache }, 'hourly', NOW + 60_000, 900_000, read)).resolves.toMatchObject({ value: 'cached' });
    expect(read).not.toHaveBeenCalled();
    expect(await leaseRow('hourly')).toEqual({ expires_at: 0, cooldown_until: cooldown, last_error: null });
  });
});

describe('safe Google refusal diagnosis', () => {
  it.each([
    ['Exhausted daily requests for property', 'daily-requests'],
    ['Exhausted tokens per day', 'daily-tokens'],
    ['Tokens per project per hour exhausted', 'project-hourly-tokens'],
    ['Concurrent requests exceeded', 'concurrency'],
    ['Server errors per hour exceeded', 'server-errors'],
    ['Unknown refusal', 'unspecified'],
  ])('classifies %s without retaining the provider message', (message, expected) => {
    expect(ga4RateLimitKind(message)).toBe(expected);
    const failure = ga4ReadFailure('ga4_realtime', new Response(null, { status: 429 }), { error: { message } }, NOW);
    expect(failure.rateLimit).toBe(expected);
    expect(JSON.stringify(failure)).not.toContain(message);
  });
  it('honors Retry-After even when it is longer than one day', () => {
    const failure = ga4ReadFailure('ga4_realtime', new Response(null, { status: 429, headers: { 'retry-after': '172800' } }), {}, NOW);
    expect(Date.parse(failure.nextAttemptAt)).toBe(NOW + 172_800_000);
  });
  it('starts Retry-After at response time without redating the attempt', () => {
    const failure = ga4ReadFailure('ga4_realtime', new Response(null, { status: 429, headers: { 'retry-after': '60' } }), {}, NOW, NOW + 10_000);
    expect(Date.parse(failure.nextAttemptAt)).toBe(NOW + 70_000);
    expect(Date.parse(failure.observedAt)).toBe(NOW);
  });
});
