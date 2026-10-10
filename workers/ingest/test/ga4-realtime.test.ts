import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { OS_TIME_ZONE } from '@noticeos/contract';
import { javascriptInstant, openWorkspaceStore } from '@noticeos/postgres';
import { forgetConfigCache } from '../src/config-store.js';
import { putCredential } from '../src/credentials.js';
import { parseGa4MinuteRows, runGa4Realtime } from '../src/ga4-realtime.js';
import { recordTimeZoneChange } from '../src/time-zone-change.js';
import { asOwner, pgCount, reset, forgetConfigDocuments, storedCount } from './helpers.js';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface QuotaFixture {
  realtime?: unknown;
  core?: unknown;
}

/** One `runReport` row: date-range name, GA4 `dateHour`, metric value. */
type IntradayRow = [range: string, dateHour: string, value: string];

interface IntradayFixture {
  /** The property's reporting timezone; `null` omits `metadata` entirely. */
  timeZone?: string | null;
  rows?: IntradayRow[];
}

// Pacific rows on the days NOW implies, so the property clock and the OS
// clock agree and the re-bucketing is an identity.
const PACIFIC_INTRADAY_ROWS: IntradayRow[] = [
  ['today', '2026072900', '3'],
  ['same_day_last_week', '2026072200', '2'],
  ['today', '2026072902', '7'],
  ['today', '2026072923', '0'],
  ['same_day_last_week', '2026072202', '5'],
  ['same_day_last_week', '2026072223', '9'],
];

/** GA4's per-minute realtime answer: `minutesAgo` rows, or a whole body or
 * HTTP status standing in for a bad one. */
interface MinutesFixture {
  rows?: Array<[minutesAgo: string, value: string]>;
  body?: unknown;
  status?: number;
}

// Minutes with traffic, newest first; every other minute has no row.
const MINUTE_ROWS: Array<[string, string]> = [
  ['00', '3'],
  ['01', '5'],
  ['04', '2'],
  ['12', '1'],
  ['29', '4'],
];

const isMinutesRequest = (body: string) => body.includes('"minutesAgo"');

function realtimeFetch(
  status = 200,
  quota: QuotaFixture = {},
  intraday: IntradayFixture = {},
  minutes: MinutesFixture = {},
) {
  const timeZone =
    intraday.timeZone === undefined ? 'America/Los_Angeles' : intraday.timeZone;
  const intradayRows = intraday.rows ?? PACIFIC_INTRADAY_ROWS;
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({
      url,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    if (url === TOKEN_URL) {
      return Response.json({
        access_token: 'realtime-test-token',
        expires_in: 3600,
      });
    }
    if (url.endsWith(':runRealtimeReport')) {
      if (status !== 200) {
        return Response.json(
          { error: { message: 'GA4 realtime access denied' } },
          { status },
        );
      }
      if (typeof init?.body === 'string' && isMinutesRequest(init.body)) {
        if (minutes.status !== undefined) {
          return Response.json({ error: { message: 'GA4 minutes unavailable' } }, { status: minutes.status });
        }
        return Response.json(minutes.body ?? {
          dimensionHeaders: [{ name: 'minutesAgo' }],
          metricHeaders: [{ name: 'activeUsers' }],
          rows: (minutes.rows ?? MINUTE_ROWS).map(([minute, value]) => ({
            dimensionValues: [{ value: minute }],
            metricValues: [{ value }],
          })),
          ...(quota.realtime === undefined ? {} : { propertyQuota: quota.realtime }),
        });
      }
      return Response.json({
        dimensionHeaders: [{ name: 'dateRange' }],
        metricHeaders: [{ name: 'activeUsers' }],
        rows: [
          {
            dimensionValues: [{ value: 'last_5_minutes' }],
            metricValues: [{ value: '7' }],
          },
          {
            dimensionValues: [{ value: 'last_30_minutes' }],
            metricValues: [{ value: '26' }],
          },
        ],
        ...(quota.realtime === undefined
          ? {}
          : { propertyQuota: quota.realtime }),
      });
    }
    if (url.endsWith(':runReport')) {
      if (status !== 200) {
        return Response.json(
          { error: { message: 'GA4 intraday access denied' } },
          { status },
        );
      }
      return Response.json({
        ...(timeZone === null ? {} : { metadata: { timeZone } }),
        dimensionHeaders: [{ name: 'dateRange' }, { name: 'dateHour' }],
        metricHeaders: [{ name: 'activeUsers' }],
        rows: intradayRows.map(([range, dateHour, value]) => ({
          dimensionValues: [{ value: range }, { value: dateHour }],
          metricValues: [{ value }],
        })),
        ...(quota.core === undefined ? {} : { propertyQuota: quota.core }),
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(reset);


/** A constants document the store holds, as a Settings save leaves it. */
async function saveConstants(body: Record<string, unknown>): Promise<void> {
  await env.STORE.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.config_documents (workspace_id, document_key, body, version, updated_at, updated_by)
       VALUES ($1::uuid, 'constants', $2::json, 1, $3::timestamptz, 'settings')`,
      [tx.workspaceId, JSON.stringify(body), new Date(NOW).toISOString()],
    ),
  );
}

describe('GA4 realtime service read', () => {
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
        'integration_leases', 'assets', 'workspace_counters', 'workspaces'].map((table) =>
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
    const run = () => runGa4Realtime(target, { nowMs: NOW, fetchImpl, tokenCache, rawConfig });
    await saveGrant(tokens[0]!);
    expect((await run()).assets[0]?.status).toBe('success');
    expect((await run()).assets[0]?.status).toBe('success');
    expect(refreshed.length).toBe(1);
    expect(refreshed[0] === tokens[0]).toBe(true);
    expect(authorized.every((value) => value === 'Bearer fixture-access-1')).toBe(true);
    authorized.length = 0;
    await saveGrant(tokens[1]!);
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
  it('shares one live reading a minute across dashboards and refreshes the hourly chart only every 15 minutes', async () => {
    const { fetchImpl, calls } = realtimeFetch();
    const responseCache = await caches.open(crypto.randomUUID());
    const options = { fetchImpl, responseCache, tokenCache: new Map() };
    const live = () => calls.filter((call) => call.url.endsWith(':runRealtimeReport'));
    const first = await runGa4Realtime(env, { ...options, nowMs: NOW });
    const second = await runGa4Realtime(env, { ...options, nowMs: NOW + 10_000 });
    expect(second.assets[0]?.observedAt).toBe(first.assets[0]?.observedAt);
    // A reading is two realtime requests per property — the windows and the
    // minutes — and it is good for a minute: the pulse's own resolution.
    expect(live()).toHaveLength(4);
    expect(live().filter((call) => isMinutesRequest(call.body))).toHaveLength(2);
    await runGa4Realtime(env, { ...options, nowMs: NOW + 30_000 });
    expect(live()).toHaveLength(4);
    await runGa4Realtime(env, { ...options, nowMs: NOW + 60_000 });
    expect(live()).toHaveLength(8);
    expect(calls.filter((call) => call.url.endsWith(':runReport'))).toHaveLength(2);
  });

  it('draws the minute pulse on the clock it is served at, the minutes after the reading absent', async () => {
    const { fetchImpl } = realtimeFetch();
    const responseCache = await caches.open(crypto.randomUUID());
    const options = { fetchImpl, responseCache, tokenCache: new Map() };
    // Read half a minute in; served again 40 seconds later, in the next minute.
    const read = await runGa4Realtime(env, { ...options, nowMs: NOW + 30_000 });
    const served = await runGa4Realtime(env, { ...options, nowMs: NOW + 70_000 });
    if (read.assets[0]?.status !== 'success' || served.assets[0]?.status !== 'success') {
      throw new Error('expected GA4 realtime success');
    }
    expect(served.assets[0].observedAt).toBe(read.assets[0].observedAt);
    const fresh = read.assets[0].activeUsersByMinute!;
    expect(fresh).toHaveLength(30);
    expect(fresh.slice(-5)).toEqual([2, 0, 0, 5, 3]);
    expect(fresh[0]).toBe(4);
    // The same reading a minute on: nobody has read the new minute yet.
    const later = served.assets[0].activeUsersByMinute!;
    expect(later.at(-1)).toBeNull();
    expect(later.slice(-6, -1)).toEqual([2, 0, 0, 5, 3]);
    expect(later.filter((value) => value === null)).toHaveLength(1);
  });
  it('returns an empty live inventory for a genuinely unconfigured install without asking Google', async () => {
    const { fetchImpl, calls } = realtimeFetch();
    const unconfigured: Partial<IngestEnv> = { ...env };
    delete unconfigured.GOOGLE_SIGNAL_ACCOUNTS;
    // The generated test env requires this legacy field; fresh installs may
    // omit it. Exercise that runtime case without changing the shared binding.
    const result = await runGa4Realtime(unconfigured as IngestEnv, { nowMs: NOW, fetchImpl });
    expect(result.assets).toEqual([]);
    expect(calls).toHaveLength(0);
  });
  it('does not turn malformed configuration into an empty live inventory', async () => {
    const { fetchImpl, calls } = realtimeFetch();
    await expect(runGa4Realtime(env, { nowMs: NOW, fetchImpl, rawConfig: '{' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it('returns exact live windows plus an hourly same-weekday pace comparison', async () => {
    const { fetchImpl, calls } = realtimeFetch();
    const tokenCache = new Map();
    const result = await runGa4Realtime(env, {
      nowMs: NOW,
      fetchImpl,
      tokenCache,
    });

    // Both configured properties are read, on one minted token.
    expect(result.assets.map((asset) => asset.asset)).toEqual([
      'meadow.example',
      'northwind.example',
    ]);
    expect(result.assets[0]).toMatchObject({
      asset: 'meadow.example',
      status: 'success',
      activeUsers5m: 7,
      activeUsers30m: 26,
      observedAt: '2026-07-29T12:00:00.000Z',
      errorCode: null,
    });
    if (result.assets[0]?.status !== 'success') {
      throw new Error('expected GA4 realtime success');
    }
    expect(result.assets[0].hourlyActiveUsers).toHaveLength(24);
    // A Pacific property already reports on the operator's clock, so the
    // re-bucketing leaves its hours where GA4 put them.
    expect(result.assets[0].hourlyActiveUsers!.slice(0, 3)).toEqual([
      { hour: 0, today: 3, sameDayLastWeek: 2 },
      { hour: 1, today: 0, sameDayLastWeek: 0 },
      { hour: 2, today: 7, sameDayLastWeek: 5 },
    ]);
    expect(result.assets[0].hourlyActiveUsers!.at(-1)).toEqual({
      hour: 23,
      today: null,
      sameDayLastWeek: 9,
    });
    const realtimeCalls = calls.filter((call) =>
      call.url.endsWith(':runRealtimeReport'),
    );
    // Two realtime requests per property: the windows, and the minutes.
    expect(realtimeCalls).toHaveLength(4);
    expect(JSON.parse(realtimeCalls[0]!.body)).toMatchObject({
      metrics: [{ name: 'activeUsers' }],
      minuteRanges: [
        { name: 'last_5_minutes', startMinutesAgo: 4, endMinutesAgo: 0 },
        { name: 'last_30_minutes', startMinutesAgo: 29, endMinutesAgo: 0 },
      ],
      returnPropertyQuota: true,
    });
    // GA4's default range is the 30 minutes the windows count, so the
    // per-minute request names none.
    expect(JSON.parse(realtimeCalls[1]!.body)).toEqual({
      dimensions: [{ name: 'minutesAgo' }],
      metrics: [{ name: 'activeUsers' }],
      returnPropertyQuota: true,
    });
    // Thirty buckets, oldest first; a minute with no row is nobody, not a gap.
    expect(result.assets[0].activeUsersByMinute).toEqual([
      4, ...Array.from({ length: 16 }, () => 0), 1, ...Array.from({ length: 7 }, () => 0), 2, 0, 0, 5, 3,
    ]);
    const intradayCalls = calls.filter((call) =>
      call.url.endsWith(':runReport'),
    );
    expect(intradayCalls).toHaveLength(2);
    // Both neighbouring property days are asked for: one OS day straddles two
    // of them whenever the property does not report on the operator's clock.
    expect(JSON.parse(intradayCalls[0]!.body)).toMatchObject({
      dimensions: [{ name: 'dateHour' }],
      metrics: [{ name: 'activeUsers' }],
      dateRanges: [
        { name: 'today', startDate: 'yesterday', endDate: 'today' },
        {
          name: 'same_day_last_week',
          startDate: '8daysAgo',
          endDate: '6daysAgo',
        },
      ],
      orderBys: [{ dimension: { dimensionName: 'dateHour' } }],
    });
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs`)).toBe(0);

    await runGa4Realtime(env, {
      nowMs: NOW + 30_000,
      fetchImpl,
      tokenCache,
    });
    expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(1);
    expect(
      calls.filter((call) => call.url.endsWith(':runRealtimeReport')),
    ).toHaveLength(8);
    expect(calls.filter((call) => call.url.endsWith(':runReport'))).toHaveLength(
      4,
    );
  });

  it('re-buckets an Eastern property onto the OS clock', async () => {
    // 2026-07-29T17:00Z is 10:00 in Los Angeles and 13:00 in New York, so the
    // OS day being filled is 2026-07-29 Pacific and its comparison day is
    // 2026-07-22 Pacific.
    const nowMs = Date.parse('2026-07-29T17:00:00.000Z');
    const { fetchImpl } = realtimeFetch(
      200,
      {},
      {
        timeZone: 'America/New_York',
        rows: [
          // Eastern midnight and 2 AM are the previous Pacific evening.
          ['today', '2026072900', '5'],
          ['today', '2026072902', '4'],
          // Eastern 3 AM opens the Pacific day.
          ['today', '2026072903', '2'],
          ['today', '2026072909', '11'],
          ['today', '2026072912', '13'],
          // Last week's Pacific day likewise runs from Eastern 3 AM on the
          // 22nd to Eastern 2 AM on the 23rd.
          ['same_day_last_week', '2026072300', '8'],
          ['same_day_last_week', '2026072302', '6'],
          ['same_day_last_week', '2026072203', '3'],
          // Outside the Pacific comparison day on either side.
          ['same_day_last_week', '2026072309', '99'],
          ['same_day_last_week', '2026072123', '77'],
        ],
      },
    );

    const result = await runGa4Realtime(env, {
      nowMs,
      fetchImpl,
      tokenCache: new Map(),
    });

    if (result.assets[0]?.status !== 'success') {
      throw new Error('expected GA4 realtime success');
    }
    expect(
      result.assets[0].hourlyActiveUsers!.map((point) => point.today),
    ).toEqual([
      2,
      0,
      0,
      0,
      0,
      0,
      11,
      0,
      0,
      13,
      ...Array.from({ length: 14 }, () => null),
    ]);
    expect(
      result.assets[0].hourlyActiveUsers!.map((point) => point.sameDayLastWeek),
    ).toEqual([3, ...Array.from({ length: 20 }, () => 0), 8, 0, 6]);
    expect(result.assets[0].hourlyActiveUsers!.map((point) => point.hour)).toEqual(
      Array.from({ length: 24 }, (_, hour) => hour),
    );
    // An on-demand read for the Tower writes nothing to the nightly ledger.
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs`)).toBe(0);
  });

  it('re-buckets onto the zone saved in Settings and names it on the snapshot', async () => {
    // A Pacific property read by an operator who saved Eastern time in
    // Settings. The store answers, not the zone compiled into this Worker: at
    // 2026-07-29T12:00Z it is 08:00 in New York, and Pacific midnight is
    // Eastern 3 AM.
    const { fetchImpl } = realtimeFetch();
    await saveConstants({ os_time_zone: 'America/New_York', monthly_caps: { data_usd: 25 }, operator_rate_usd_per_min: 1, flag_defaults: {} });
    forgetConfigCache();
    try {
      const saved = await runGa4Realtime(env, { nowMs: NOW, fetchImpl, tokenCache: new Map() });
      if (saved.assets[0]?.status !== 'success') throw new Error('expected GA4 realtime success');
      expect(saved.assets[0].timeZone).toBe('America/New_York');
      expect(saved.assets[0].hourlyActiveUsers!.map((point) => point.today)).toEqual([
        0, 0, 0, 3, 0, 7, ...Array.from({ length: 18 }, () => null),
      ]);
      // Last week's Pacific 11 PM is Eastern 2 AM the NEXT day: outside it.
      expect(saved.assets[0].hourlyActiveUsers!.map((point) => point.sameDayLastWeek)).toEqual([
        0, 0, 0, 2, 0, 5, ...Array.from({ length: 18 }, () => 0),
      ]);
    } finally {
      await forgetConfigDocuments(['config/constants.json']);
      forgetConfigCache();
    }
    // Nothing saved: the compiled clock, named just the same.
    const compiled = await runGa4Realtime(env, { nowMs: NOW, fetchImpl, tokenCache: new Map() });
    if (compiled.assets[0]?.status !== 'success') throw new Error('expected GA4 realtime success');
    expect(compiled.assets[0].timeZone).toBe(OS_TIME_ZONE);
  });

  it('does not serve hours bucketed on the old zone from cache after a Settings save', async () => {
    const { fetchImpl, calls } = realtimeFetch();
    const options = { fetchImpl, responseCache: await caches.open(crypto.randomUUID()), tokenCache: new Map() };
    const before = await runGa4Realtime(env, { ...options, nowMs: NOW });
    expect(calls.filter((call) => call.url.endsWith(':runReport'))).toHaveLength(2);
    await saveConstants({ os_time_zone: 'America/New_York', flag_defaults: {} });
    forgetConfigCache();
    try {
      // Ten seconds later, inside the hourly chart's 15-minute cooldown. The
      // hours cached on the old clock are not served under the new zone's
      // name; the new clock's key has nothing cached, so it is read at once
      // rather than leaving the chart blank for the rest of the cooldown — one
      // extra report per property.
      const during = await runGa4Realtime(env, { ...options, nowMs: NOW + 10_000 });
      expect(calls.filter((call) => call.url.endsWith(':runReport'))).toHaveLength(4);
      if (before.assets[0]?.status !== 'success' || during.assets[0]?.status !== 'success') throw new Error('expected GA4 realtime success');
      expect(before.assets[0].timeZone).toBe(OS_TIME_ZONE);
      expect(during.assets[0].timeZone).toBe('America/New_York');
      expect(during.assets[0].hourlyActiveUsers![3]).toEqual({ hour: 3, today: 3, sameDayLastWeek: 2 });
      // And that reading is shared: the next poll asks the provider nothing.
      const after = await runGa4Realtime(env, { ...options, nowMs: NOW + 15 * 60_000 + 1_000 });
      expect(calls.filter((call) => call.url.endsWith(':runReport'))).toHaveLength(4);
      if (after.assets[0]?.status !== 'success') throw new Error('expected GA4 realtime success');
      expect(after.assets[0].hourlyActiveUsers![3]).toEqual({ hour: 3, today: 3, sameDayLastWeek: 2 });
    } finally {
      await forgetConfigDocuments(['config/constants.json']);
      forgetConfigCache();
    }
  });

  it('converts last week with the clock the provider used then, so the pace compares the same real hours', async () => {
    // GA4 buckets at processing time and never reprocesses history, so after a
    // PT→ET move last week's rows are PT-bucketed and today's are ET-bucketed
    // while `metadata.timeZone` says ET for both.
    await recordTimeZoneChange(env, {
      asset: 'meadow.example',
      integration: 'ga4',
      from: 'America/Los_Angeles',
      to: 'America/New_York',
      effectiveOn: '2026-07-26',
    });
    const nowMs = Date.parse('2026-07-29T17:00:00.000Z');
    const { fetchImpl } = realtimeFetch(
      200,
      {},
      {
        timeZone: 'America/New_York',
        rows: [
          // Today: Eastern-bucketed, so 3 AM ET opens the Pacific day.
          ['today', '2026072903', '2'],
          ['today', '2026072909', '11'],
          // Last week: Pacific-bucketed, because Jul 22 predates the change.
          ['same_day_last_week', '2026072200', '5'],
          ['same_day_last_week', '2026072209', '40'],
          ['same_day_last_week', '2026072223', '7'],
          ['same_day_last_week', '2026072300', '9'],
        ],
      },
    );

    const result = await runGa4Realtime(env, {
      nowMs,
      fetchImpl,
      tokenCache: new Map(),
    });

    if (result.assets[0]?.status !== 'success') {
      throw new Error('expected GA4 realtime success');
    }
    expect(
      result.assets[0].hourlyActiveUsers!.map((point) => point.today),
    ).toEqual([
      2,
      0,
      0,
      0,
      0,
      0,
      11,
      ...Array.from({ length: 17 }, () => null),
    ]);
    // Last week's 9 AM Pacific stays at hour 9. Converting it with the
    // property's current Eastern clock would have put it at hour 6, and the
    // pace chip would compare today's 6–9 AM against last week's 3–6 AM.
    expect(
      result.assets[0].hourlyActiveUsers!.map((point) => point.sameDayLastWeek),
    ).toEqual([
      5,
      ...Array.from({ length: 8 }, () => 0),
      40,
      ...Array.from({ length: 13 }, () => 0),
      7,
    ]);
    // The realtime read files nothing: the one annotation is the seeded change.
    expect(await storedCount(`SELECT count(*)::int AS n FROM noticeos.signal_runs`)).toBe(0);
    expect(await pgCount(`SELECT COUNT(*) AS n FROM noticeos.annotations`)).toBe(1);
  });

  it('refuses to place hours when GA4 names no reporting timezone', async () => {
    const { fetchImpl } = realtimeFetch(200, {}, { timeZone: null });

    const result = await runGa4Realtime(env, {
      nowMs: NOW,
      fetchImpl,
      tokenCache: new Map(),
    });

    // Guessing a zone would shift the whole chart silently, so the property
    // leaves only the hourly chart unavailable; working live counts survive.
    expect(result.assets[0]).toMatchObject({
      asset: 'meadow.example',
      status: 'success',
      activeUsers5m: 7,
      activeUsers30m: 26,
      hourlyActiveUsers: null,
      observedAt: '2026-07-29T12:00:00.000Z',
      errorCode: null,
      hourlyErrorCode: 'ga4_intraday_invalid_response',
    });
  });

  it('returns an isolated error state instead of inventing zero active users', async () => {
    const { fetchImpl } = realtimeFetch(403);
    const result = await runGa4Realtime(env, {
      nowMs: NOW,
      fetchImpl,
      tokenCache: new Map(),
    });

    // A provider refusal is per property, and every property gets its own
    // honest null state rather than one blank standing in for the account.
    expect(result.assets).toEqual(
      ['meadow.example', 'northwind.example'].map((asset) => ({
        asset,
        status: 'error',
        activeUsers5m: null,
        activeUsers30m: null,
        hourlyActiveUsers: null,
        observedAt: '2026-07-29T12:00:00.000Z',
        errorCode: 'ga4_realtime_http_403',
        nextAttemptAt: '2026-07-29T12:01:00.000Z',
      })),
    );
  });

  it('treats an empty valid report as two legitimate zero windows and a flat pulse', async () => {
    const fetchImpl = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url === TOKEN_URL) {
        return Response.json({ access_token: 'token', expires_in: 3600 });
      }
      if (url.endsWith(':runReport')) {
        return Response.json({
          metadata: { timeZone: 'America/Los_Angeles' },
          dimensionHeaders: [{ name: 'dateRange' }, { name: 'dateHour' }],
          metricHeaders: [{ name: 'activeUsers' }],
          rows: [],
        });
      }
      return Response.json({
        dimensionHeaders: [{ name: isMinutesRequest(String(init?.body)) ? 'minutesAgo' : 'dateRange' }],
        metricHeaders: [{ name: 'activeUsers' }],
        rows: [],
      });
    }) as typeof fetch;

    const result = await runGa4Realtime(env, {
      nowMs: NOW,
      fetchImpl,
      tokenCache: new Map(),
    });
    expect(result.assets[0]).toMatchObject({
      status: 'success',
      activeUsers5m: 0,
      activeUsers30m: 0,
      activeUsersByMinute: Array.from({ length: 30 }, () => 0),
      hourlyActiveUsers: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        today: null,
        sameDayLastWeek: 0,
      })),
      // Neither response carried `propertyQuota`.
      quota: null,
    });
  });

  describe('property quota', () => {
    it('keeps the realtime and core budgets the two requests report', async () => {
      const { fetchImpl } = realtimeFetch(200, {
        realtime: {
          tokensPerDay: { consumed: 3, remaining: 199_997 },
          tokensPerHour: { consumed: 3, remaining: 39_997 },
          concurrentRequests: { consumed: 1, remaining: 9 },
        },
        core: {
          tokensPerDay: { consumed: 11, remaining: 199_989 },
          tokensPerHour: { consumed: 11, remaining: 39_989 },
        },
      });

      const result = await runGa4Realtime(env, {
        nowMs: NOW,
        fetchImpl,
        tokenCache: new Map(),
      });

      if (result.assets[0]?.status !== 'success') {
        throw new Error('expected GA4 realtime success');
      }
      // Realtime and Core draw on separate budgets, so they stay separate.
      // The windows and the minutes both spend the realtime one: the fixture
      // reports 3 tokens for each, so the reading cost 6.
      expect(result.assets[0].quota).toEqual({
        realtime: {
          tokensPerDay: { consumed: 6, remaining: 199_997 },
          tokensPerHour: { consumed: 6, remaining: 39_997 },
        },
        core: {
          tokensPerDay: { consumed: 11, remaining: 199_989 },
          tokensPerHour: { consumed: 11, remaining: 39_989 },
        },
      });
    });

    it('reports the buckets one response omits as null without dropping the other', async () => {
      const { fetchImpl } = realtimeFetch(200, {
        core: { tokensPerDay: { consumed: 11, remaining: 199_989 } },
      });

      const result = await runGa4Realtime(env, {
        nowMs: NOW,
        fetchImpl,
        tokenCache: new Map(),
      });

      if (result.assets[0]?.status !== 'success') {
        throw new Error('expected GA4 realtime success');
      }
      expect(result.assets[0].quota).toEqual({
        realtime: null,
        core: {
          tokensPerDay: { consumed: 11, remaining: 199_989 },
          tokensPerHour: null,
        },
      });
    });

    it('leaves a malformed quota unknown rather than reading it as zero', async () => {
      const { fetchImpl } = realtimeFetch(200, {
        realtime: 'unlimited',
        core: {
          tokensPerDay: { consumed: -1, remaining: 'plenty' },
          tokensPerHour: { remaining: 39_989 },
        },
      });

      const result = await runGa4Realtime(env, {
        nowMs: NOW,
        fetchImpl,
        tokenCache: new Map(),
      });

      if (result.assets[0]?.status !== 'success') {
        throw new Error('expected GA4 realtime success');
      }
      expect(result.assets[0].quota).toEqual({
        realtime: null,
        core: {
          tokensPerDay: null,
          tokensPerHour: { consumed: null, remaining: 39_989 },
        },
      });
    });

    it('leaves the reading\'s cost unknown when the per-minute request got no answer', async () => {
      const { fetchImpl } = realtimeFetch(
        200,
        { realtime: { tokensPerDay: { consumed: 46, remaining: 150_000 } } },
        {},
        { status: 503 },
      );
      const result = await runGa4Realtime(env, { nowMs: NOW, fetchImpl, tokenCache: new Map() });
      if (result.assets[0]?.status !== 'success') throw new Error('expected GA4 realtime success');
      // Half a sum would understate it; what remains is still reported.
      expect(result.assets[0].quota?.realtime).toEqual({
        tokensPerDay: { consumed: null, remaining: 150_000 },
        tokensPerHour: null,
      });
    });

    it('carries no quota on a failed property', async () => {
      const { fetchImpl } = realtimeFetch(403, {
        realtime: { tokensPerDay: { consumed: 3, remaining: 199_997 } },
      });

      const result = await runGa4Realtime(env, {
        nowMs: NOW,
        fetchImpl,
        tokenCache: new Map(),
      });

      expect(result.assets[0]).toEqual({
        asset: 'meadow.example',
        status: 'error',
        activeUsers5m: null,
        activeUsers30m: null,
        hourlyActiveUsers: null,
        observedAt: '2026-07-29T12:00:00.000Z',
        errorCode: 'ga4_realtime_http_403',
        nextAttemptAt: '2026-07-29T12:01:00.000Z',
      });
    });
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
