import { getConfigDocuments } from './config-store.js';
import { type LaneRegister, laneDeclined } from './lane-mapping.js';
// On-demand GA4 realtime read for the Tower, in ingest because ingest alone
// owns the Google credential; neither the key nor an access token enters the
// Tower. GA4 answers in the property's own reporting timezone; the hourly
// series is re-bucketed onto the operator's saved `os_time_zone` (store first,
// compiled `OS_TIME_ZONE` as fallback), and each snapshot names the zone so the
// Wall labels its axis with the clock the hours are really on.

import type {
  Ga4HourlyActiveUsers,
  Ga4MinuteRow,
  Ga4PropertyQuota,
  Ga4QuotaStatus,
  Ga4RealtimeAsset,
  Ga4RealtimePayload,
  Ga4RealtimeQuota,
} from '@noticeos/contract';
import { GA4_PULSE_MINUTES, OS_TIME_ZONE, ga4MinuteBuckets, savedOsTimeZone } from '@noticeos/contract';
import {
  dateInTimeZone,
  hourInTimeZone,
  isValidTimeZone,
  shiftCalendarDate,
  zonedHourStartMs,
} from './time-zone.js';
import {
  googleCredentialResolver,
  groupGoogleTargetsByAccount,
  googleTargets,
  type GooglePropertyTarget,
} from './google-signals.js';
import {
  GOOGLE_SCOPES,
  googleAccessToken,
  googleAuthCacheKey,
  responseJson,
  type GoogleAuth,
} from './google-auth.js';
import { resolveGoogleCredential } from './google-oauth.js';
import { Ga4ReadError, ga4ReadFailure } from './ga4-read-errors.js';
import { cachedGa4Read, ga4CacheScope, type Ga4ReadCache } from './ga4-read-cache.js';
import { observeIntegration, tryHealthConnection } from './integration-health-context.js';
import { parseGa4PropertyQuota } from './ga4-quota.js';
import {
  reportingTimeZoneOn,
  timeZoneChangesFor,
  type TimeZoneChange,
} from './time-zone-change.js';
import {
  normalizeSignalError,
  SignalError,
} from './signal-store.js';
import { isolateState } from './isolate-state.js';

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REUSE_MS = 50 * 60 * 1_000;
const LAST_5_MINUTES = 'last_5_minutes';
const LAST_30_MINUTES = 'last_30_minutes';
const TODAY = 'today';
const SAME_DAY_LAST_WEEK = 'same_day_last_week';

/**
 * One live reading a minute: two realtime requests read together, the exact 5-
 * and 30-minute windows and the per-minute rows. The pulse cannot show
 * anything finer than a minute, and two requests every 30 seconds would run
 * the daily realtime token budget out before the day ends.
 */
const LIVE_READING_TTL_MS = 60_000;
/** Names the cached reading's shape: a reading cached before the pulse existed
 * has no minutes and must not be served as one that does. */
const LIVE_READING_VERSION = 'minutes-v1';

interface TokenEntry {
  accessToken: string;
  validUntil: number;
}

const sharedTokenCache = new Map<string, TokenEntry>();
isolateState('GA4 token cache', { forget: () => sharedTokenCache.clear(), held: () => sharedTokenCache.size > 0 });

export interface Ga4RealtimeOptions {
  nowMs?: number;
  fetchImpl?: typeof fetch;
  rawConfig?: string;
  /** Tests can inject an isolated cache; `null` disables reuse. */
  tokenCache?: Map<string, TokenEntry> | null;
  /** Production uses the platform cache plus a DB lease. Injected fetches
   * bypass it by default. */
  responseCache?: Cache | null;
  clock?: () => number;
}

/**
 * Query every configured GA4 property. Failures are isolated per account and
 * property, so one authorization error is not a portfolio-wide blank.
 */
export async function runGa4Realtime(
  env: IngestEnv,
  options: Ga4RealtimeOptions = {},
): Promise<Ga4RealtimePayload> {
  const clock = options.clock ?? (options.nowMs === undefined ? Date.now : () => options.nowMs!);
  const nowMs = clock();
  const observedAt = new Date(nowMs).toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const responseCache = options.responseCache === undefined ? options.fetchImpl ? null : caches.default : options.responseCache;
  const tokenCache =
    options.tokenCache === undefined ? sharedTokenCache : options.tokenCache;
  // Polled every 30 seconds by the Wall, so this read does not stamp
  // `last_used_at`: a status column is not worth two writes a minute.
  const resolved = await resolveGoogleCredential(env);
  const health = await tryHealthConnection(env, 'google', resolved.credential, [resolved.oauth?.clientId ?? '', resolved.oauth?.clientSecret ?? '']);
  let monitoringAvailable = health !== null;
  const accounts = options.rawConfig ?? resolved.accounts;
  // Signed in with nothing mapped yet is an empty read, not a failure. An
  // unreadable saved credential is still connected (`resolved.connected`).
  if (accounts === undefined && !resolved.connected) {
    return { generatedAt: new Date(nowMs).toISOString(), assets: [] };
  }
  // One store read for both documents this read depends on.
  const [registerRead, constantsRead] = await getConfigDocuments(env, [
    'config/integrations.json',
    'config/constants.json',
  ]);
  const register = registerRead?.body as LaneRegister;
  const osTimeZone = savedOsTimeZone(constantsRead?.body, OS_TIME_ZONE);
  const targets = googleTargets(
    { accounts, oauth: resolved.oauth },
    resolved.source,
    googleCredentialResolver(env),
    options.rawConfig === undefined ? register : undefined,
    osTimeZone,
  ).filter(
    (target): target is GooglePropertyTarget & { integration: 'ga4' } =>
      target.integration === 'ga4' &&
      // Declined on its Data sources row (Not using): not read.
      !laneDeclined(target.asset, 'ga4', options.rawConfig === undefined ? register : undefined),
  );
  const assets: Ga4RealtimeAsset[] = [];
  // One query for the whole portfolio, and a failure is allowed to throw:
  // falling back to "no changes" would silently convert a property that has
  // moved zones with the wrong clock.
  const timeZoneChanges = await timeZoneChangesFor(env.STORE, 'ga4');

  for (const [account, accountTargets] of groupGoogleTargetsByAccount(targets)) {
    let accessToken: string;
    try {
      accessToken = await accessTokenFor(
        accountTargets[0]!.auth,
        env.STORE,
        clock(),
        fetchImpl,
        tokenCache,
      );
    } catch (error) {
      const normalized = normalizeSignalError(
        error,
        'Google authentication failed.',
      );
      assets.push(
        ...accountTargets.map((target) =>
          errorResult(target.asset, observedAt, normalized),
        ),
      );
      for (const target of accountTargets) for (const capability of ['ga4-realtime', 'ga4-hourly']) {
        const recorded = await observeIntegration(env, health, { capability, asset: target.asset, target: target.propertyRef, observedAt: new Date(clock()).toISOString(), ok: false, code: normalized.code });
        monitoringAvailable = recorded && monitoringAvailable;
      }
      continue;
    }

    for (const target of accountTargets) {
      try {
        const cache = responseCache ? { store: env.STORE, cache: responseCache, clock, scope: await ga4CacheScope({
          auth: target.auth, asset: target.asset, property: target.propertyRef,
          clock: timeZoneChanges.get(target.asset) ?? [],
        }) } : null;
        const values = await collectGa4Realtime(
          target.propertyRef,
          accessToken,
          fetchImpl,
          clock(),
          osTimeZone,
          timeZoneChanges.get(target.asset) ?? [],
          cache,
          async (observation) => {
            const recorded = await observeIntegration(env, health, { ...observation, asset: target.asset, target: target.propertyRef });
            monitoringAvailable = recorded && monitoringAvailable;
          },
        );
        assets.push({
          asset: target.asset,
          status: 'success',
          activeUsers5m: values.activeUsers5m,
          activeUsers30m: values.activeUsers30m,
          activeUsersByMinute: values.activeUsersByMinute,
          hourlyActiveUsers: values.hourlyActiveUsers,
          hourlyErrorCode: values.hourlyErrorCode,
          hourlyObservedAt: values.hourlyObservedAt,
          ...(values.hourlyNextAttemptAt ? { hourlyNextAttemptAt: values.hourlyNextAttemptAt } : {}),
          quota: values.quota,
          observedAt: values.observedAt,
          timeZone: osTimeZone,
          errorCode: null,
        });
      } catch (error) {
        const normalized = normalizeSignalError(
          error,
          'GA4 realtime request failed.',
        );
        assets.push(errorResult(target.asset, observedAt, normalized));
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    assets,
    ...(!monitoringAvailable ? { monitoringAvailable: false } : {}),
  };
}

async function accessTokenFor(
  auth: GoogleAuth,
  store: IngestEnv['STORE'],
  nowMs: number,
  fetchImpl: typeof fetch,
  tokenCache: Map<string, TokenEntry> | null,
): Promise<string> {
  // Keyed on the credential rather than the account label: a rotated key or a
  // re-granted sign-in must never be served the token minted for its predecessor.
  const cacheKey = await ga4CacheScope([
    store.where, await store.workspaceId(), googleAuthCacheKey(auth, GOOGLE_SCOPES.ga4),
  ]);
  const cached = tokenCache?.get(cacheKey);
  if (cached && cached.validUntil > nowMs) return cached.accessToken;

  const accessToken = await googleAccessToken(auth, GOOGLE_SCOPES.ga4, nowMs, fetchImpl);
  tokenCache?.set(cacheKey, {
    accessToken,
    // Google issues a one-hour token; fifty minutes keeps clock skew from
    // putting an expired one on the hot path.
    validUntil: nowMs + TOKEN_REUSE_MS,
  });
  return accessToken;
}

export async function collectGa4Realtime(
  propertyId: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  nowMs: number,
  /** The operator's saved clock the hourly series is re-bucketed onto. */
  osTimeZone: string,
  timeZoneChanges: readonly TimeZoneChange[] = [],
  cache: Ga4ReadCache | null = null,
  observe?: (value: { capability: string; observedAt: string; ok: boolean; code?: string; nextAttemptAt?: string }) => Promise<void>,
): Promise<{
  activeUsers5m: number;
  activeUsers30m: number;
  activeUsersByMinute: (number | null)[] | null;
  hourlyActiveUsers: Ga4HourlyActiveUsers[] | null;
  hourlyErrorCode: string | null;
  hourlyObservedAt: string;
  hourlyNextAttemptAt?: string;
  observedAt: string;
  quota: Ga4RealtimeQuota | null;
}> {
  const [windowsRead, hourlyRead] = await Promise.allSettled([
    cachedGa4Read(cache && { ...cache, version: LIVE_READING_VERSION }, 'realtime', nowMs, LIVE_READING_TTL_MS, () => collectGa4RealtimeWindows(propertyId, accessToken, fetchImpl, cache?.clock?.() ?? nowMs, cache?.clock)),
    // The cached hours are only good for the day and the clock they were
    // bucketed on: a Settings save that moves the zone must not be answered
    // with hours placed on the old one.
    cachedGa4Read(cache && { ...cache, version: `${dateInTimeZone(nowMs, osTimeZone)}@${encodeURIComponent(osTimeZone)}` }, 'hourly', nowMs, 15 * 60_000, () => collectGa4HourlyActiveUsers(
      propertyId,
      accessToken,
      fetchImpl,
      cache?.clock?.() ?? nowMs,
      osTimeZone,
      timeZoneChanges,
      cache?.clock,
    )),
  ]);
  if (observe) for (const [capability, result] of [['ga4-realtime', windowsRead], ['ga4-hourly', hourlyRead]] as const) {
    if (result.status === 'fulfilled') await observe({ capability, observedAt: result.value.observedAt, ok: true });
    else {
      const error = normalizeSignalError(result.reason, 'Traffic unavailable');
      if (error.code === 'ga4_read_in_progress') continue;
      await observe({ capability, observedAt: error instanceof Ga4ReadError ? error.observedAt : new Date(nowMs).toISOString(), ok: false,
        code: error instanceof Ga4ReadError ? error.rateLimit ?? error.code : error.code,
        ...(error instanceof Ga4ReadError ? { nextAttemptAt: error.nextAttemptAt } : {}) });
    }
  }
  if (windowsRead.status === 'rejected') throw windowsRead.reason;
  const windows = windowsRead.value.value;
  const hourly = hourlyRead.status === 'fulfilled' ? hourlyRead.value.value : null;
  const hourlyError = hourlyRead.status === 'rejected' ? normalizeSignalError(hourlyRead.reason, 'Hourly traffic is unavailable.') : null;
  const quota =
    windows.quota === null && !hourly?.quota
      ? null
      : { realtime: windows.quota, core: hourly?.quota ?? null };
  return {
    activeUsers5m: windows.activeUsers5m,
    activeUsers30m: windows.activeUsers30m,
    // Placed on the clock of this answer, not of the reading: a reading served
    // from the cache a minute on has not seen the newest minute.
    activeUsersByMinute: windows.minutes === null
      ? null
      : ga4MinuteBuckets(windows.minutes, Date.parse(windowsRead.value.observedAt), cache?.clock?.() ?? nowMs),
    observedAt: windowsRead.value.observedAt,
    hourlyActiveUsers: hourly?.hourlyActiveUsers ?? null,
    hourlyErrorCode: hourlyError?.code ?? null,
    hourlyObservedAt: hourlyRead.status === 'fulfilled' ? hourlyRead.value.observedAt : hourlyError instanceof Ga4ReadError ? hourlyError.observedAt : new Date(nowMs).toISOString(),
    ...(hourlyError instanceof Ga4ReadError ? { hourlyNextAttemptAt: hourlyError.nextAttemptAt } : {}),
    quota,
  };
}

/** The per-minute rows' dimension: "00" is the minute the reading is taken in,
 * "29" the oldest of GA4's standard 30. */
const MINUTES_AGO_PATTERN = /^\d{2}$/;
const METRIC_COUNT_PATTERN = /^\d+$/;

async function runRealtimeReport(
  propertyId: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  request: Record<string, unknown>,
  nowMs: number,
  clock: () => number,
): Promise<Record<string, unknown> | null> {
  const response = await fetchImpl(
    `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runRealtimeReport`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...request, returnPropertyQuota: true }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const body = await responseJson(response);
  if (!response.ok) throw ga4ReadFailure('ga4_realtime', response, body, nowMs, clock());
  return asRecord(body);
}

/**
 * One live reading: the windows and the per-minute rows, asked for together so
 * the figure and the pulse describe the same moment. The windows are the
 * reading; the minutes only add the pulse, so a failed or malformed per-minute
 * answer is refused and logged and the reading stands without a pulse.
 */
async function collectGa4RealtimeWindows(
  propertyId: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  nowMs: number,
  clock: () => number = () => nowMs,
): Promise<{
  activeUsers5m: number;
  activeUsers30m: number;
  minutes: Ga4MinuteRow[] | null;
  quota: Ga4PropertyQuota | null;
}> {
  const [windowsRead, minutesRead] = await Promise.allSettled([
    runRealtimeReport(propertyId, accessToken, fetchImpl, {
      metrics: [{ name: 'activeUsers' }],
      minuteRanges: [
        {
          name: LAST_5_MINUTES,
          startMinutesAgo: 4,
          endMinutesAgo: 0,
        },
        {
          name: LAST_30_MINUTES,
          startMinutesAgo: 29,
          endMinutesAgo: 0,
        },
      ],
    }, nowMs, clock),
    // No minute range: GA4's default is the last 30 minutes, and a single
    // unnamed range adds no `dateRange` column to parse around.
    runRealtimeReport(propertyId, accessToken, fetchImpl, {
      dimensions: [{ name: 'minutesAgo' }],
      metrics: [{ name: 'activeUsers' }],
    }, nowMs, clock),
  ]);
  if (windowsRead.status === 'rejected') throw windowsRead.reason;
  const record = windowsRead.value;
  const dimensionHeaders = arrayField(record, 'dimensionHeaders');
  const metricHeaders = arrayField(record, 'metricHeaders');
  if (
    dimensionHeaders.length !== 1 ||
    stringField(asRecord(dimensionHeaders[0]), 'name') !== 'dateRange' ||
    metricHeaders.length !== 1 ||
    stringField(asRecord(metricHeaders[0]), 'name') !== 'activeUsers'
  ) {
    throw new SignalError(
      'ga4_realtime_invalid_response',
      'GA4 returned unexpected realtime report headers.',
    );
  }

  const values = new Map<string, number>([
    [LAST_5_MINUTES, 0],
    [LAST_30_MINUTES, 0],
  ]);
  const seen = new Set<string>();
  for (const rowValue of arrayField(record, 'rows')) {
    const row = asRecord(rowValue);
    const range = stringField(
      asRecord(arrayField(row, 'dimensionValues')[0]),
      'value',
    );
    const rawValue = stringField(
      asRecord(arrayField(row, 'metricValues')[0]),
      'value',
    );
    const value = Number(rawValue);
    if (
      !range ||
      !values.has(range) ||
      seen.has(range) ||
      !Number.isInteger(value) ||
      value < 0
    ) {
      throw new SignalError(
        'ga4_realtime_invalid_response',
        'GA4 returned a malformed realtime report row.',
      );
    }
    values.set(range, value);
    seen.add(range);
  }

  let minutes: Ga4MinuteRow[] | null = null;
  if (minutesRead.status === 'fulfilled') {
    try {
      minutes = parseGa4MinuteRows(minutesRead.value);
    } catch (error) {
      logMinutesRefused(propertyId, error);
    }
  } else {
    logMinutesRefused(propertyId, minutesRead.reason);
  }

  return {
    activeUsers5m: values.get(LAST_5_MINUTES)!,
    activeUsers30m: values.get(LAST_30_MINUTES)!,
    minutes,
    quota: combineRealtimeQuota(
      parseGa4PropertyQuota(record),
      minutesRead.status === 'fulfilled' ? parseGa4PropertyQuota(minutesRead.value) : undefined,
    ),
  };
}

function logMinutesRefused(propertyId: string, error: unknown): void {
  const normalized = normalizeSignalError(error, 'GA4 per-minute realtime read failed.');
  console.warn(JSON.stringify({ event: 'ga4_minutes_refused', propertyRef: propertyId, code: normalized.code }));
}

/**
 * GA4's per-minute realtime rows, parsed as strictly as the windows are.
 * Anything else is refused whole: a pulse with a guessed bar is worse than none.
 */
export function parseGa4MinuteRows(record: Record<string, unknown> | null): Ga4MinuteRow[] {
  const dimensionHeaders = arrayField(record, 'dimensionHeaders');
  const metricHeaders = arrayField(record, 'metricHeaders');
  if (
    dimensionHeaders.length !== 1 ||
    stringField(asRecord(dimensionHeaders[0]), 'name') !== 'minutesAgo' ||
    metricHeaders.length !== 1 ||
    stringField(asRecord(metricHeaders[0]), 'name') !== 'activeUsers'
  ) {
    throw new SignalError(
      'ga4_realtime_invalid_response',
      'GA4 returned unexpected per-minute report headers.',
    );
  }
  const rows = new Map<number, number>();
  for (const rowValue of arrayField(record, 'rows')) {
    const row = asRecord(rowValue);
    const dimensions = arrayField(row, 'dimensionValues');
    const metrics = arrayField(row, 'metricValues');
    const minute = stringField(asRecord(dimensions[0]), 'value');
    const rawValue = stringField(asRecord(metrics[0]), 'value');
    const minutesAgo = minute !== null && MINUTES_AGO_PATTERN.test(minute) ? Number(minute) : Number.NaN;
    if (
      dimensions.length !== 1 ||
      metrics.length !== 1 ||
      !Number.isInteger(minutesAgo) ||
      minutesAgo >= GA4_PULSE_MINUTES ||
      rows.has(minutesAgo) ||
      rawValue === null ||
      !METRIC_COUNT_PATTERN.test(rawValue) ||
      !Number.isSafeInteger(Number(rawValue))
    ) {
      throw new SignalError(
        'ga4_realtime_invalid_response',
        'GA4 returned a malformed per-minute report row.',
      );
    }
    rows.set(minutesAgo, Number(rawValue));
  }
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([minutesAgo, activeUsers]) => ({ minutesAgo, activeUsers }));
}

/**
 * The realtime budget one reading drew on. Both requests spend the same
 * property's tokens, so `consumed` is their sum, unknown unless both reported
 * it, and `remaining` the lower of what they reported.
 */
function combineRealtimeQuota(
  windows: Ga4PropertyQuota | null,
  minutes: Ga4PropertyQuota | null | undefined,
): Ga4PropertyQuota | null {
  const bucket = (a: Ga4QuotaStatus | null | undefined, b: Ga4QuotaStatus | null | undefined): Ga4QuotaStatus | null => {
    if (!a && !b) return null;
    const consumed = a?.consumed != null && b?.consumed != null ? a.consumed + b.consumed : null;
    const reported = [a?.remaining, b?.remaining].filter((value): value is number => value != null);
    return { consumed, remaining: reported.length ? Math.min(...reported) : null };
  };
  const tokensPerDay = bucket(windows?.tokensPerDay, minutes?.tokensPerDay);
  const tokensPerHour = bucket(windows?.tokensPerHour, minutes?.tokensPerHour);
  return tokensPerDay || tokensPerHour ? { tokensPerDay, tokensPerHour } : null;
}

const DATE_HOUR_PATTERN = /^\d{10}$/;

async function collectGa4HourlyActiveUsers(
  propertyId: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  nowMs: number,
  osTimeZone: string,
  timeZoneChanges: readonly TimeZoneChange[],
  clock: () => number = () => nowMs,
): Promise<{
  hourlyActiveUsers: Ga4HourlyActiveUsers[];
  quota: Ga4PropertyQuota | null;
}> {
  const response = await fetchImpl(
    `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      // GA4 resolves both the relative dates and the hour bucket in the
      // property's reporting timezone. The OS day straddles two property days,
      // so both neighbours are asked for and the re-bucketing below discards
      // whatever falls outside the OS day.
      body: JSON.stringify({
        dimensions: [{ name: 'dateHour' }],
        metrics: [{ name: 'activeUsers' }],
        dateRanges: [
          { name: TODAY, startDate: 'yesterday', endDate: 'today' },
          {
            name: SAME_DAY_LAST_WEEK,
            startDate: '8daysAgo',
            endDate: '6daysAgo',
          },
        ],
        orderBys: [{ dimension: { dimensionName: 'dateHour' } }],
        returnPropertyQuota: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  const body = await responseJson(response);
  if (!response.ok) throw ga4ReadFailure('ga4_intraday', response, body, nowMs, clock());

  const record = asRecord(body);
  const dimensionHeaders = arrayField(record, 'dimensionHeaders').map((value) =>
    stringField(asRecord(value), 'name'),
  );
  const rangeIndex = dimensionHeaders.indexOf('dateRange');
  const dateHourIndex = dimensionHeaders.indexOf('dateHour');
  const metricHeaders = arrayField(record, 'metricHeaders');
  if (
    dimensionHeaders.length !== 2 ||
    rangeIndex < 0 ||
    dateHourIndex < 0 ||
    metricHeaders.length !== 1 ||
    stringField(asRecord(metricHeaders[0]), 'name') !== 'activeUsers'
  ) {
    throw new SignalError(
      'ga4_intraday_invalid_response',
      'GA4 returned unexpected intraday report headers.',
    );
  }

  // Without the property's own zone the hours cannot be placed on the
  // operator's clock, and guessing one would silently shift the whole chart.
  const propertyTimeZone = stringField(
    asRecord(record?.metadata),
    'timeZone',
  );
  if (propertyTimeZone === null || !isValidTimeZone(propertyTimeZone)) {
    throw new SignalError(
      'ga4_intraday_invalid_response',
      'GA4 returned no usable reporting timezone.',
    );
  }

  const osToday = dateInTimeZone(nowMs, osTimeZone);
  const osLastWeek = shiftCalendarDate(osToday, -7);
  const providerToday = dateInTimeZone(nowMs, propertyTimeZone);
  const today = new Map<number, number>();
  const sameDayLastWeek = new Map<number, number>();
  const seen = new Set<string>();
  for (const rowValue of arrayField(record, 'rows')) {
    const row = asRecord(rowValue);
    const dimensions = arrayField(row, 'dimensionValues');
    const range = stringField(asRecord(dimensions[rangeIndex]), 'value');
    const dateHour = stringField(asRecord(dimensions[dateHourIndex]), 'value');
    const rawValue = stringField(
      asRecord(arrayField(row, 'metricValues')[0]),
      'value',
    );
    const value = Number(rawValue);
    const propertyHour =
      dateHour !== null && DATE_HOUR_PATTERN.test(dateHour)
        ? Number(dateHour.slice(8))
        : Number.NaN;
    const key = `${range}\0${dateHour}`;
    if (
      (range !== TODAY && range !== SAME_DAY_LAST_WEEK) ||
      dateHour === null ||
      !Number.isInteger(propertyHour) ||
      propertyHour < 0 ||
      propertyHour > 23 ||
      seen.has(key) ||
      !Number.isInteger(value) ||
      value < 0
    ) {
      throw new SignalError(
        'ga4_intraday_invalid_response',
        'GA4 returned a malformed intraday report row.',
      );
    }
    seen.add(key);

    // The dateRange name is validated but never routes a row: the OS calendar
    // date the property hour lands on decides which line it joins.
    const propertyDate = `${dateHour.slice(0, 4)}-${dateHour.slice(4, 6)}-${dateHour.slice(6, 8)}`;
    // Each row carries the clock the provider used the day it bucketed that
    // row: GA4 never reprocesses history, so each side of a change converts
    // with its own zone.
    const propertyZone = reportingTimeZoneOn(
      timeZoneChanges,
      propertyDate,
      propertyTimeZone,
      providerToday,
    );
    const startMs = zonedHourStartMs(propertyDate, propertyHour, propertyZone);
    const osDate = dateInTimeZone(startMs, osTimeZone);
    const osHour = hourInTimeZone(startMs, osTimeZone);
    const target =
      osDate === osToday ? today : osDate === osLastWeek ? sameDayLastWeek : null;
    // Buckets accumulate rather than reject a collision: on the property's
    // fall-back day two property-local hours land in one OS hour.
    if (target !== null) target.set(osHour, (target.get(osHour) ?? 0) + value);
  }

  // GA4 includes future clock hours as explicit zero rows in a `today` report.
  // Stop at the newest hour with observed traffic so the chart never depicts
  // the unelapsed rest of the day as a forecast of zero.
  const observedTodayHours = [...today.entries()]
    .filter(([, value]) => value > 0)
    .map(([hour]) => hour);
  const latestHour =
    observedTodayHours.length === 0 ? -1 : Math.max(...observedTodayHours);
  return {
    hourlyActiveUsers: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      today: hour <= latestHour ? (today.get(hour) ?? 0) : null,
      sameDayLastWeek: sameDayLastWeek.get(hour) ?? 0,
    })),
    quota: parseGa4PropertyQuota(record),
  };
}

function errorResult(
  asset: string,
  observedAt: string,
  error: SignalError,
): Ga4RealtimeAsset {
  return {
    asset,
    status: 'error',
    activeUsers5m: null,
    activeUsers30m: null,
    hourlyActiveUsers: null,
    observedAt: error instanceof Ga4ReadError ? error.observedAt : observedAt,
    errorCode: error.code,
    ...(error instanceof Ga4ReadError ? { nextAttemptAt: error.nextAttemptAt, ...(error.rateLimit ? { rateLimit: error.rateLimit } : {}) } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  record: Record<string, unknown> | null,
  field: string,
): string | null {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function arrayField(
  record: Record<string, unknown> | null,
  field: string,
): unknown[] {
  const value = record?.[field];
  return Array.isArray(value) ? value : [];
}
