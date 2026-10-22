import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { javascriptInstant, openWorkspaceStore } from '@noticeos/postgres';
import { forgetConfigCache } from '../src/config-store.js';
import { putCredential } from '../src/credentials.js';
import { parseGa4MinuteRows, runGa4Realtime, readGa4Realtime } from '../src/ga4-realtime.js';
import { asOwner, reset } from './helpers.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
interface QuotaFixture { realtime?: unknown }
interface MinutesFixture { rows?: Array<[string, string]>; body?: unknown; status?: number }
const MINUTE_ROWS: Array<[string, string]> = [['00', '3'], ['01', '5'], ['04', '2'], ['12', '1'], ['29', '4']];
const isMinutesRequest = (body: string) => body.includes('"minutesAgo"');
function realtimeFetch(status = 200, quota: QuotaFixture = {}, _unused = {}, minutes: MinutesFixture = {}) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? '');
    calls.push({ url, body });
    if (url === TOKEN_URL) return Response.json({ access_token: 'synthetic-realtime-token', expires_in: 3600 });
    if (!url.endsWith(':runRealtimeReport')) throw new Error(`unexpected provider read: ${url}`);
    if (status !== 200) return Response.json({ error: { message: 'GA4 access denied' } }, { status });
    if (isMinutesRequest(body)) return Response.json(minutes.body ?? {
      dimensionHeaders: [{ name: 'minutesAgo' }], metricHeaders: [{ name: 'activeUsers' }],
      rows: (minutes.rows ?? MINUTE_ROWS).map(([minute, users]) => ({ dimensionValues: [{ value: minute }], metricValues: [{ value: users }] })),
      ...(quota.realtime === undefined ? {} : { propertyQuota: quota.realtime }),
    }, { status: minutes.status ?? 200 });
    return Response.json({ dimensionHeaders: [{ name: 'dateRange' }], metricHeaders: [{ name: 'activeUsers' }],
      rows: [['last_5_minutes', '7'], ['last_30_minutes', '26']].map(([range, users]) => ({ dimensionValues: [{ value: range }], metricValues: [{ value: users }] })),
      ...(quota.realtime === undefined ? {} : { propertyQuota: quota.realtime }),
    });
  };
  return { fetchImpl, calls };
}
beforeEach(reset);

describe('scheduled GA4 realtime collection', () => {
  it('keeps identical grants and provider results inside the calling workspace', async () => {
    const workspaceId = crypto.randomUUID();
    await asOwner(`INSERT INTO noticeos.workspaces (workspace_id, slug, display_name)
      VALUES ('${workspaceId}', 'realtime-fixture', 'Realtime fixture');
      INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status, list_position)
      VALUES ('${workspaceId}', 'meadow.example', 'meadow.example', 'Meadow', 'live', 1),
             ('${workspaceId}', 'northwind.example', 'northwind.example', 'Northwind', 'live', 2);`);
    const store = openWorkspaceStore(env.POSTGRES.connectionString, { workspaceId });
    const tokenCache = new Map();
    const responseCache = await caches.open(crypto.randomUUID());
    function fixture(name: string, users: string) {
      const original = realtimeFetch(200, {}, {}, { rows: [['00', users]] });
      let refreshes = 0;
      const authorized: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        if (String(input) === TOKEN_URL) {
          refreshes += 1;
          return Response.json({ access_token: `fixture-${name}`, expires_in: 3600 });
        }
        authorized.push(new Headers(init?.headers).get('authorization') ?? '');
        return original.fetchImpl(input, init);
      };
      return { fetchImpl, authorized, refreshes: () => refreshes };
    }
    const first = fixture('a', '3');
    const second = fixture('b', '9');
    const run = (target: IngestEnv, fetchImpl: typeof fetch) => runGa4Realtime(target, {
      nowMs: NOW, fetchImpl, tokenCache, responseCache,
    });
    function minutes(payload: Awaited<ReturnType<typeof run>>) {
      const reading = payload.assets[0];
      expect(reading?.status).toBe('success');
      if (reading?.status !== 'success') throw new Error('The fixture expected a successful reading');
      return reading.activeUsersByMinute;
    }
    try {
      const a = await run(env, first.fetchImpl);
      const b = await run({ ...env, STORE: store }, second.fetchImpl);
      expect(minutes(b)).not.toEqual(minutes(a));
      expect(minutes(await run(env, first.fetchImpl))).toEqual(minutes(a));
      expect(minutes(await run({ ...env, STORE: store }, second.fetchImpl))).toEqual(minutes(b));
      expect(first.refreshes()).toBe(1);
      expect(second.refreshes()).toBe(1);
      expect(first.authorized.length).toBeGreaterThan(0);
      expect(second.authorized.length).toBeGreaterThan(0);
      expect(first.authorized.every((value) => value === 'Bearer fixture-a')).toBe(true);
      expect(second.authorized.every((value) => value === 'Bearer fixture-b')).toBe(true);
    } finally {
      await store.close();
      forgetConfigCache();
      await asOwner(['integration_health_events', 'integration_capability_state', 'capability_targets',
        'integration_leases', 'realtime_traffic_readings', 'assets', 'workspace_counters', 'workspaces'].map((table) =>
        `DELETE FROM noticeos.${table} WHERE workspace_id = '${workspaceId}';`).join('\n'));
    }
  });

  it('reuses the same grant but refreshes after an equal-length reconnection', async () => {
    const target = { ...env };
    delete (target as Partial<IngestEnv>).GOOGLE_SIGNAL_ACCOUNTS;
    expect((await putCredential(target, {
      provider: 'google-oauth-app',
      fields: { GOOGLE_OAUTH_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: crypto.randomUUID() },
    })).ok).toBe(true);
    const tokens = [crypto.randomUUID(), crypto.randomUUID()];
    expect(tokens[0]!.length).toBe(tokens[1]!.length);
    const saveGrant = async (refreshToken: string) => {
      expect((await putCredential(target, {
        provider: 'google', fields: { GOOGLE_OAUTH_REFRESH_TOKEN: refreshToken },
        metadata: { account: 'reader@example.test', scopes: [], connectedAt: new Date(NOW).toISOString(), expiresAt: null, expirySource: null },
      })).ok).toBe(true);
    };
    const fixture = realtimeFetch();
    const refreshed: string[] = [];
    const authorized: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input) === TOKEN_URL) {
        const token = new URLSearchParams(String(init?.body)).get('refresh_token');
        expect(token).not.toBeNull();
        refreshed.push(token!);
        return Response.json({ access_token: `fixture-access-${refreshed.length}`, expires_in: 3600 });
      }
      authorized.push(new Headers(init?.headers).get('authorization') ?? '');
      return fixture.fetchImpl(input, init);
    };
    const tokenCache = new Map();
    const rawConfig = JSON.stringify({ fixture: { properties: { 'meadow.example': { ga4_property_id: '123456' } } } });
    let nowMs = NOW;
    const run = () => runGa4Realtime(target, { nowMs, fetchImpl, tokenCache, rawConfig });
    await saveGrant(tokens[0]!);
    expect((await run()).assets[0]?.status).toBe('success');
    expect((await run()).assets[0]?.status).toBe('success');
    expect(refreshed.length).toBe(1);
    expect(refreshed[0] === tokens[0]).toBe(true);
    expect(authorized.every((value) => value === 'Bearer fixture-access-1')).toBe(true);
    authorized.length = 0;
    await saveGrant(tokens[1]!);
    nowMs += 60_000;
    expect((await run()).assets[0]?.status).toBe('success');
    expect(refreshed.length).toBe(2);
    expect(refreshed.every((value, index) => value === tokens[index])).toBe(true);
    expect(authorized.length).toBeGreaterThan(0);
    expect(authorized.every((value) => value === 'Bearer fixture-access-2')).toBe(true);
    for (const key of tokenCache.keys()) for (const token of tokens) expect(key).not.toContain(token);
  });

  it('claims a fresh lease for later properties after an earlier read is delayed', async () => {
    let now = NOW;
    let liveCalls = 0;
    const fixture = realtimeFetch();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      // The windows request of each property; its per-minute twin is asked
      // for in the same breath, under the same lease.
      if (url.endsWith(':runRealtimeReport') && !isMinutesRequest(String(init?.body))) {
        liveCalls += 1;
        if (liveCalls === 1) now += 45_000;
        else {
          const rows = await env.STORE.read((tx) => tx.query<{ expires_at: string }>(
            "SELECT expires_at FROM noticeos.integration_leases WHERE lease_key LIKE 'ga4-read:%:realtime' AND expires_at > 'epoch'"));
          expect(rows.length).toBeGreaterThan(0);
          expect(rows.every((row) => Date.parse(javascriptInstant(row.expires_at)) > now)).toBe(true);
        }
      }
      return fixture.fetchImpl(input, init);
    };
    const result = await runGa4Realtime(env, { fetchImpl, responseCache: await caches.open(crypto.randomUUID()), tokenCache: new Map(), clock: () => now });
    expect(result.assets[1]?.observedAt).toBe(new Date(NOW + 45_000).toISOString());
  });
  it('shares one two-request reading per minute and never calls Core reporting', async () => {
    const fixture = realtimeFetch();
    const options = { fetchImpl: fixture.fetchImpl, tokenCache: new Map(), responseCache: await caches.open(crypto.randomUUID()) };
    await runGa4Realtime(env, { ...options, nowMs: NOW });
    await runGa4Realtime(env, { ...options, nowMs: NOW + 30_000 });
    expect(fixture.calls.filter(call => call.url.endsWith(':runRealtimeReport'))).toHaveLength(4);
    await runGa4Realtime(env, { ...options, nowMs: NOW + 60_000 });
    expect(fixture.calls.filter(call => call.url.endsWith(':runRealtimeReport'))).toHaveLength(8);
    expect(fixture.calls.some(call => call.url.endsWith(':runReport'))).toBe(false);
  });

  it('serves retained counters and a full-day chart without any provider calls', async () => {
    await runGa4Realtime(env, { nowMs: NOW, fetchImpl: realtimeFetch().fetchImpl });
    const fetch = vi.fn(() => { throw new Error('a display must not contact a provider'); });
    vi.stubGlobal('fetch', fetch);
    try {
      const first = await readGa4Realtime(env, NOW + 30_000);
      const second = await readGa4Realtime(env, NOW + 70_000);
      expect(fetch).not.toHaveBeenCalled();
      expect(first.assets[0]).toMatchObject({ status: 'success', activeUsers5m: 7, activeUsers30m: 26, observedAt: new Date(NOW).toISOString() });
      const reading = second.assets[0];
      if (reading?.status !== 'success') throw new Error('expected retained reading');
      expect(reading.activeUsersByMinute?.at(-1)).toBeNull();
      expect(reading.activeUsersByMinute?.slice(-6, -1)).toEqual([2, 0, 0, 5, 3]);
      const day = reading.realtimeDay!;
      const index = (NOW - Date.parse(day.startAt)) / 60_000;
      expect(day.minutes[index]).toBe(3);
      expect(day.minutes[index + 1]).toBeNull();
      expect(day.minutes[index - 29]).toBe(4);
    } finally { vi.unstubAllGlobals(); }
  });

  it('does not erase a retained chart or manufacture zero after a failed collection', async () => {
    await runGa4Realtime(env, { nowMs: NOW, fetchImpl: realtimeFetch().fetchImpl });
    const failed = await runGa4Realtime(env, { nowMs: NOW + 60_000, fetchImpl: realtimeFetch(403).fetchImpl });
    expect(failed.assets.every(reading => reading.status === 'error')).toBe(true);
    const saved = await readGa4Realtime(env, NOW + 60_000);
    expect(saved.assets[0]).toMatchObject({ status: 'success', activeUsers5m: 7, observedAt: new Date(NOW).toISOString() });
  });

  it('retains exact window counts without summing minute users and reports only Realtime quota', async () => {
    const result = await runGa4Realtime(env, { nowMs: NOW, fetchImpl: realtimeFetch(200, { realtime: {
      tokensPerDay: { consumed: 3, remaining: 199_997 }, tokensPerHour: { consumed: 3, remaining: 39_997 },
    } }).fetchImpl });
    expect(result.assets[0]).toMatchObject({ activeUsers5m: 7, activeUsers30m: 26, hourlyActiveUsers: null,
      quota: { core: null, realtime: { tokensPerDay: { consumed: 6, remaining: 199_997 } } } });
  });

  it('slows background collection while realtime quota is scarce', async () => {
    const fixture = realtimeFetch(200, { realtime: { tokensPerDay: { consumed: 8, remaining: 30_000 } } });
    await runGa4Realtime(env, { nowMs: NOW, fetchImpl: fixture.fetchImpl });
    await runGa4Realtime(env, { nowMs: NOW + 60_000, fetchImpl: fixture.fetchImpl });
    expect(fixture.calls.filter(call => call.url.endsWith(':runRealtimeReport'))).toHaveLength(4);
    await runGa4Realtime(env, { nowMs: NOW + 300_000, fetchImpl: fixture.fetchImpl });
    expect(fixture.calls.filter(call => call.url.endsWith(':runRealtimeReport'))).toHaveLength(8);
  });

  it('refuses minute placement across a clock boundary while retaining the counters', async () => {
    let now = NOW + 59_000;
    const fixture = realtimeFetch();
    const result = await runGa4Realtime(env, { clock: () => now, fetchImpl: async (input, init) => {
      const response = await fixture.fetchImpl(input, init);
      if (isMinutesRequest(String(init?.body))) now += 2_000;
      return response;
    } });
    expect(result.assets[0]).toMatchObject({ status: 'success', activeUsers5m: 7, activeUsersByMinute: null });
  });

  it('returns an empty inventory for an unconfigured install and rejects malformed configuration', async () => {
    const target = { ...env };
    delete (target as Partial<IngestEnv>).GOOGLE_SIGNAL_ACCOUNTS;
    const fixture = realtimeFetch();
    expect((await runGa4Realtime(target, { nowMs: NOW, fetchImpl: fixture.fetchImpl })).assets).toEqual([]);
    expect(fixture.calls).toHaveLength(0);
    await expect(runGa4Realtime(env, { nowMs: NOW, fetchImpl: fixture.fetchImpl, rawConfig: '{' })).rejects.toThrow();
  });
});

// The per-minute rows behind the Wall's minute pulse are parsed as strictly as
// the windows, and refusing them never costs the reading its live figure.
describe('the per-minute realtime rows', () => {
  const report = (rows: unknown[], dimension = 'minutesAgo') => ({
    dimensionHeaders: [{ name: dimension }],
    metricHeaders: [{ name: 'activeUsers' }],
    rows,
  });
  const row = (minute: unknown, value: unknown) => ({
    dimensionValues: [{ value: minute }],
    metricValues: [{ value }],
  });

  it('reads each minute GA4 reports, oldest last, and nothing it does not', () => {
    expect(parseGa4MinuteRows(report([row('12', '1'), row('00', '3'), row('29', '40')]))).toEqual([
      { minutesAgo: 0, activeUsers: 3 },
      { minutesAgo: 12, activeUsers: 1 },
      { minutesAgo: 29, activeUsers: 40 },
    ]);
    expect(parseGa4MinuteRows(report([]))).toEqual([]);
  });

  it.each([
    ['a minute past the 30', [row('30', '1')]],
    ['a one-digit minute', [row('5', '1')]],
    ['a minute that is not a number', [row('ab', '1')]],
    ['the same minute twice', [row('03', '1'), row('03', '2')]],
    ['a negative count', [row('03', '-1')]],
    ['a fractional count', [row('03', '1.5')]],
    ['a missing count', [{ dimensionValues: [{ value: '03' }], metricValues: [] }]],
    ['a missing minute', [{ dimensionValues: [], metricValues: [{ value: '1' }] }]],
    ['a row with an extra dimension', [{ dimensionValues: [{ value: '03' }, { value: 'x' }], metricValues: [{ value: '1' }] }]],
  ])('refuses %s', (_case, rows) => {
    expect(() => parseGa4MinuteRows(report(rows))).toThrow(/malformed per-minute report row/);
  });

  it('refuses a report of anything but minutes', () => {
    expect(() => parseGa4MinuteRows(report([], 'dateRange'))).toThrow(/unexpected per-minute report headers/);
    expect(() => parseGa4MinuteRows({ ...report([]), metricHeaders: [{ name: 'eventCount' }] })).toThrow(/unexpected per-minute report headers/);
    expect(() => parseGa4MinuteRows(null)).toThrow(/unexpected per-minute report headers/);
  });

  it('keeps the live figure when the minutes are refused: no pulse, never a guessed one', async () => {
    for (const minutes of [{ body: report([row('31', '2')]) }, { status: 500 }] satisfies MinutesFixture[]) {
      await reset();
      const { fetchImpl } = realtimeFetch(200, {}, {}, minutes);
      const result = await runGa4Realtime(env, { nowMs: NOW, fetchImpl, tokenCache: new Map() });
      expect(result.assets[0]).toMatchObject({
        status: 'success',
        activeUsers5m: 7,
        activeUsers30m: 26,
        activeUsersByMinute: null,
        errorCode: null,
      });
    }
  });
});
