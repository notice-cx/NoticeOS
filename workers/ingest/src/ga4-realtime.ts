import { updateComparison, type SharedComparisons } from './ga4-comparison.js';
import { timeZoneChangesFor } from './time-zone-change.js';
import { getConfigDocuments } from './config-store.js';
import { readGa4Reading, saveGa4Reading, realtimeReadDue, realtimeNextReadAt } from './ga4-realtime-store.js';
import { type LaneRegister, laneDeclined } from './lane-mapping.js';
// Scheduled realtime collection owns Google credentials. Display reads use
// retained observations, so refreshing a dashboard spends no provider quota.

import type {
  Ga4MinuteRow,
  Ga4PropertyQuota,
  Ga4QuotaStatus,
  Ga4RealtimeAsset,
  Ga4RealtimePayload,
  Ga4RealtimeQuota,
} from '@noticeos/contract';
import { GA4_PULSE_MINUTES, OS_TIME_ZONE, ga4MinuteBuckets, savedOsTimeZone } from '@noticeos/contract';
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
import { parseGa4PropertyQuota, recordGa4Quota } from './ga4-quota.js';
import {
  normalizeSignalError,
  SignalError,
} from './signal-store.js';
import { isolateState } from './isolate-state.js';
import { arrayField, asRecord, stringField } from './shared.js';

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REUSE_MS = 50 * 60 * 1_000;
const LAST_5_MINUTES = 'last_5_minutes';
const LAST_30_MINUTES = 'last_30_minutes';

/**
 * One live reading a minute: two realtime requests read together, the exact 5-
 * and 30-minute windows and the per-minute rows. The pulse cannot show
 * anything finer than a minute, and two requests every 30 seconds would run
 * the daily realtime token budget out before the day ends.
 */
const LIVE_READING_TTL_MS = 60_000;
/** Names the cached reading's shape: a reading cached before the pulse existed
 * has no minutes and must not be served as one that does. */
const LIVE_READING_VERSION = 'retained-minutes-v1';

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
  // Health observations carry each attempt; reading a credential does not
  // stamp its last-used column once per minute.
  const { resolved, osTimeZone, targets } = await realtimeTargets(env, options.rawConfig);
  const health = await tryHealthConnection(env, 'google', resolved.credential, [resolved.oauth?.clientId ?? '', resolved.oauth?.clientSecret ?? '']);
  let monitoringAvailable = health !== null;
  const assets: Ga4RealtimeAsset[] = [];
  const zoneChanges = await timeZoneChangesFor(env.STORE, 'ga4');
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
      for (const target of accountTargets) for (const capability of ['ga4-realtime']) {
        const recorded = await observeIntegration(env, health, { capability, asset: target.asset, target: target.propertyRef, observedAt: new Date(clock()).toISOString(), ok: false, code: normalized.code });
        monitoringAvailable = recorded && monitoringAvailable;
      }
      continue;
    }

    const sharedComparisons: SharedComparisons = new Map();
    const sharedReadings = new Map<string, Promise<Awaited<ReturnType<typeof collectGa4Realtime>>>>();
    for (const target of accountTargets) {
      try {
        const prior = await readGa4Reading(env.STORE, target.asset, target.propertyRef);
        if (prior && !realtimeReadDue(prior, clock())) { assets.push(prior); continue; }
        const cache = responseCache ? { store: env.STORE, cache: responseCache, clock, scope: await ga4CacheScope({
          auth: target.auth, property: target.propertyRef,
        }) } : null;
        let shared = sharedReadings.get(target.propertyRef);
        if (!shared) {
          shared = collectGa4Realtime(
          target.propertyRef,
          accessToken,
          fetchImpl,
          clock(),
          osTimeZone,
          cache,
          undefined,
          clock,
        );
          sharedReadings.set(target.propertyRef, shared);
        }
        const values = await shared;
        const reading: Ga4RealtimeAsset = {
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
        };
        reading.nextAttemptAt = new Date(realtimeNextReadAt(reading, clock())).toISOString();
        await saveGa4Reading(env.STORE, target.propertyRef, reading);
        const recorded = await observeIntegration(env, health, { capability: 'ga4-realtime', asset: target.asset, target: target.propertyRef,
          observedAt: reading.observedAt, ok: true, nextAttemptAt: reading.nextAttemptAt });
        monitoringAvailable = recorded && monitoringAvailable;
        await recordGa4Quota(env, { asset: target.asset, lane: 'ga4-realtime', propertyRef: target.propertyRef, quota: values.quota?.realtime ?? null, at: values.observedAt });
        assets.push(reading);
      } catch (error) {
        const normalized = normalizeSignalError(
          error,
          'GA4 realtime request failed.',
        );
        assets.push(errorResult(target.asset, observedAt, normalized));
        if (normalized.code !== 'ga4_read_in_progress') {
          const recorded = await observeIntegration(env, health, { capability: 'ga4-realtime', asset: target.asset, target: target.propertyRef,
            observedAt: error instanceof Ga4ReadError ? error.observedAt : new Date(clock()).toISOString(), ok: false, code: normalized.code,
            ...(error instanceof Ga4ReadError ? { nextAttemptAt: error.nextAttemptAt } : {}) });
          monitoringAvailable = recorded && monitoringAvailable;
        }
      } finally {
        try {
          const cache = responseCache ? { store: env.STORE, cache: responseCache, clock,
            scope: await ga4CacheScope({ auth: target.auth, property: target.propertyRef }) } : null;
          const comparison = await updateComparison(env, { asset: target.asset, property: target.propertyRef, token: accessToken,
            zone: osTimeZone, nowMs: clock(), fetchImpl, cache, shared: sharedComparisons, changes: zoneChanges.get(target.asset) });
          if (comparison) {
            const recorded = await observeIntegration(env, health, { capability: 'ga4-comparison', asset: target.asset,
              target: target.propertyRef, ...comparison });
            monitoringAvailable = recorded && monitoringAvailable;
          }
        } catch {
          monitoringAvailable = false;
        }
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    assets,
    ...(!monitoringAvailable ? { monitoringAvailable: false } : {}),
  };
}

async function realtimeTargets(env: IngestEnv, rawConfig?: string) {
  const resolved = await resolveGoogleCredential(env);
  const accounts = rawConfig ?? resolved.accounts;
  // Signed in with nothing mapped yet is an empty read, not a failure. An
  // unreadable saved credential is still connected (`resolved.connected`).
  if (accounts === undefined && !resolved.connected) {
    return { resolved, osTimeZone: OS_TIME_ZONE, targets: [] };
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
    rawConfig === undefined ? register : undefined,
    osTimeZone,
  ).filter(
    (target): target is GooglePropertyTarget & { integration: 'ga4' } =>
      target.integration === 'ga4' &&
      // Declined on its Data sources row (Not using): not read.
      !laneDeclined(target.asset, 'ga4', rawConfig === undefined ? register : undefined),
  );
  return { resolved, osTimeZone, targets };
}

/** Browser reads never contact GA4. Scheduled collection owns provider quota. */
export async function readGa4Realtime(env: IngestEnv, nowMs = Date.now()): Promise<Ga4RealtimePayload> {
  const { osTimeZone, targets } = await realtimeTargets(env);
  const assets = await Promise.all(targets.map(async target => {
    const reading = await readGa4Reading(env.STORE, target.asset, target.propertyRef, { nowMs, timeZone: osTimeZone });
    return reading ?? errorResult(target.asset, new Date(nowMs).toISOString(), new SignalError('ga4_realtime_waiting', 'Waiting for traffic collection.'));
  }));
  return { generatedAt: new Date(nowMs).toISOString(), assets };
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
  _osTimeZone: string,
  cache: Ga4ReadCache | null = null,
  observe?: (value: { capability: string; observedAt: string; ok: boolean; code?: string; nextAttemptAt?: string }) => Promise<void>,
  clock: () => number = cache?.clock ?? (() => nowMs),
): Promise<Omit<Extract<Ga4RealtimeAsset, { status: 'success' }>, 'asset' | 'status' | 'errorCode' | 'timeZone'>> {
  try {
    const read = await cachedGa4Read(cache && { ...cache, version: LIVE_READING_VERSION }, 'realtime', nowMs, LIVE_READING_TTL_MS,
      () => collectGa4RealtimeWindows(propertyId, accessToken, fetchImpl, clock(), clock));
    if (observe) await observe({ capability: 'ga4-realtime', observedAt: read.observedAt, ok: true });
    const windows = read.value;
    return {
      activeUsers5m: windows.activeUsers5m,
      activeUsers30m: windows.activeUsers30m,
      // Anchor retained minutes to the provider read, never to a later cache hit.
      activeUsersByMinute: windows.minutes === null || Math.floor(windows.minuteAt / 60_000) !== Math.floor(Date.parse(read.observedAt) / 60_000) ? null : ga4MinuteBuckets(windows.minutes, Date.parse(read.observedAt), Date.parse(read.observedAt)),
      observedAt: read.observedAt,
      hourlyActiveUsers: null,
      hourlyErrorCode: 'ga4_realtime_history',
      hourlyObservedAt: read.observedAt,
      quota: windows.quota === null ? null : { realtime: windows.quota, core: null },
    };
  } catch (error) {
    const normalized = normalizeSignalError(error, 'Traffic unavailable');
    if (observe && normalized.code !== 'ga4_read_in_progress') await observe({
      capability: 'ga4-realtime', ok: false, code: normalized.code,
      observedAt: error instanceof Ga4ReadError ? error.observedAt : new Date(nowMs).toISOString(),
      ...(error instanceof Ga4ReadError ? { nextAttemptAt: error.nextAttemptAt } : {}),
    });
    throw error;
  }
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
  minuteAt: number;
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
      rawValue === null || !METRIC_COUNT_PATTERN.test(rawValue) || !Number.isSafeInteger(value) ||
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
      if (Math.floor(clock() / 60_000) !== Math.floor(nowMs / 60_000)) throw new SignalError('ga4_minute_boundary', 'The realtime read crossed a minute boundary.');
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
    minuteAt: nowMs,
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
 * A malformed row refuses the whole pulse, under a code naming the check: a
 * pulse with a guessed bar is worse than none. A well-formed row older than
 * the pulse's minutes draws no bar, so it is left out rather than refused.
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
      'ga4_minutes_malformed_headers',
      'GA4 returned unexpected per-minute report headers.',
    );
  }
  const malformed = (check: string) => new SignalError(`ga4_minutes_malformed_${check}`, 'GA4 returned a malformed per-minute report row.');
  const rows = new Map<number, number>();
  for (const rowValue of arrayField(record, 'rows')) {
    const row = asRecord(rowValue);
    const dimensions = arrayField(row, 'dimensionValues');
    const metrics = arrayField(row, 'metricValues');
    const minute = stringField(asRecord(dimensions[0]), 'value');
    const rawValue = stringField(asRecord(metrics[0]), 'value');
    if (dimensions.length !== 1 || metrics.length !== 1) throw malformed('row');
    if (minute === null || !MINUTES_AGO_PATTERN.test(minute)) throw malformed('minute');
    if (rawValue === null || !METRIC_COUNT_PATTERN.test(rawValue) || !Number.isSafeInteger(Number(rawValue))) throw malformed('count');
    const minutesAgo = Number(minute);
    if (rows.has(minutesAgo)) throw malformed('duplicate_minute');
    if (minutesAgo >= GA4_PULSE_MINUTES) continue;
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
