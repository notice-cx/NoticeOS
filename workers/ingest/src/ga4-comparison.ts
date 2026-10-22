import type { Ga4PropertyQuota, Ga4RealtimeDay } from '@noticeos/contract';
import { javascriptInstant, type WorkspaceStore } from '@noticeos/postgres';
import { cachedGa4Read, ga4CacheScope, type Ga4ReadCache } from './ga4-read-cache.js';
import { Ga4ReadError, ga4ReadFailure } from './ga4-read-errors.js';
import { parseGa4PropertyQuota, recordGa4Quota, quotaPressure } from './ga4-quota.js';
import { responseJson } from './google-auth.js';
import { normalizeSignalError, SignalError } from './signal-store.js';
import { arrayField, asRecord, stringField } from './shared.js';
import { dateInTimeZone, isValidTimeZone, shiftCalendarDate, zonedHourStartMs } from './time-zone.js';
import { reportingTimeZoneOn, type TimeZoneChange } from './time-zone-change.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
type Report = { day: Ga4RealtimeDay; quota: Ga4PropertyQuota | null };
export type SharedComparisons = Map<string, Promise<{ value: Report; observedAt: string }>>;
type Attempt = { observed_at: string; next_attempt_at: string; error_code: string | null; payload: string | null };

export async function comparisonAttempt(store: WorkspaceStore, asset: string, property: string, date: string, zone: string, successOnly = false): Promise<Attempt | null> {
  const [row] = await store.read(tx => tx.query<Attempt>(`SELECT observed_at, next_attempt_at, error_code, payload::text
    FROM noticeos.traffic_comparison_reports WHERE asset_id=$1 AND property_ref=$2 AND comparison_day=$3::date AND time_zone=$4
      AND ($5::boolean=false OR payload IS NOT NULL) ORDER BY observed_at DESC LIMIT 1`, [asset, property, date, zone, successOnly]));
  return row ?? null;
}

/** Calendar-clock alignment preserves the comparison across DST. Ambiguous
 * repeated minutes stay unknown instead of assigning traffic to a guessed fold. */
export function alignComparisonMinutes(values: (number | null)[], fromStart: number, toStart: number, length: number, zone: string): (number | null)[] {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const keys = Array.from({ length }, (_, i) => formatter.format(toStart + i * MINUTE));
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const prior = new Map<string, number | null>();
  values.forEach((value, index) => {
    const key = formatter.format(fromStart + index * MINUTE);
    prior.set(key, prior.has(key) ? null : value);
  });
  return keys.map(key => counts.get(key) === 1 ? prior.get(key) ?? null : null);
}

export function emptyComparison(nowMs: number, zone: string): Ga4RealtimeDay {
  const date = dateInTimeZone(nowMs, zone);
  const start = zonedHourStartMs(date, 0, zone), end = zonedHourStartMs(shiftCalendarDate(date, 1), 0, zone);
  return { date, timeZone: zone, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(),
    minutes: Array<number | null>((end - start) / MINUTE).fill(null), sameDayLastWeek: null };
}

/** Reports cover only two bounded calendar ranges, including neighbouring
 * property dates so an installation clock need not match its GA4 property. */
export async function collectComparison(property: string, accessToken: string, fetchImpl: typeof fetch, nowMs: number,
  zone: string, changes: readonly TimeZoneChange[] = []): Promise<Report> {
  const day = emptyComparison(nowMs, zone), priorDate = shiftCalendarDate(day.date, -7);
  const response = await fetchImpl(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(property)}:runReport`, {
    method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ dimensions: [{ name: 'dateHourMinute' }], metrics: [{ name: 'activeUsers' }],
      dateRanges: [day.date, priorDate].map((date, i) => ({ name: i ? 'last_week' : 'today', startDate: shiftCalendarDate(date, -1), endDate: i ? shiftCalendarDate(date, 1) : 'today' })),
      orderBys: [{ dimension: { dimensionName: 'dateHourMinute' } }], limit: 10_000, returnPropertyQuota: true }),
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await responseJson(response);
  if (!response.ok) throw ga4ReadFailure('ga4_comparison', response, raw, nowMs, nowMs);
  const record = asRecord(raw), metadata = asRecord(record?.metadata);
  const dimensions = arrayField(record, 'dimensionHeaders').map(v => stringField(asRecord(v), 'name'));
  const timeIndex = dimensions.indexOf('dateHourMinute'), rangeIndex = dimensions.indexOf('dateRange');
  const propertyZone = stringField(metadata, 'timeZone');
  const invalid = () => new SignalError('ga4_comparison_invalid_response', 'GA4 returned an incomplete activity comparison.');
  if (dimensions.length !== 2 || timeIndex < 0 || rangeIndex < 0 || !propertyZone || !isValidTimeZone(propertyZone) ||
    arrayField(record, 'metricHeaders').length !== 1 || stringField(asRecord(arrayField(record, 'metricHeaders')[0]), 'name') !== 'activeUsers' ||
    metadata?.dataLossFromOtherRow === true || metadata?.subjectToThresholding === true || arrayField(metadata, 'samplingMetadatas').length > 0) throw invalid();
  const rows = arrayField(record, 'rows');
  if (typeof record?.rowCount !== 'number' || record.rowCount !== rows.length || rows.length > 10_000) throw invalid();
  const start = Date.parse(day.startAt), priorStart = zonedHourStartMs(priorDate, 0, zone);
  const priorEnd = zonedHourStartMs(shiftCalendarDate(priorDate, 1), 0, zone);
  const prior = Array<number | null>((priorEnd - priorStart) / MINUTE).fill(0);
  const today = new Map<number, number | null>(), seen = new Set<string>();
  const providerToday = dateInTimeZone(nowMs, propertyZone);
  const clocks = new Map<string, Intl.DateTimeFormat>();
  const hours = new Map<string, number>();
  for (const rawRow of rows) {
    const row = asRecord(rawRow), dims = arrayField(row, 'dimensionValues'), metrics = arrayField(row, 'metricValues');
    const stamp = stringField(asRecord(dims[timeIndex]), 'value'), range = stringField(asRecord(dims[rangeIndex]), 'value');
    const count = stringField(asRecord(metrics[0]), 'value');
    if (!stamp || !/^\d{12}$/.test(stamp) || !count || !/^\d+$/.test(count) || !Number.isSafeInteger(Number(count)) ||
      dims.length !== 2 || metrics.length !== 1 || !['today', 'last_week'].includes(range ?? '') || seen.has(`${range}:${stamp}`)) throw invalid();
    seen.add(`${range}:${stamp}`);
    const date = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
    const hour = Number(stamp.slice(8, 10)), minute = Number(stamp.slice(10));
    if (hour > 23 || minute > 59) throw invalid();
    const reportZone = reportingTimeZoneOn(changes, date, propertyZone, providerToday);
    const hourKey = `${reportZone}:${date}:${hour}`;
    let hourStart = hours.get(hourKey);
    if (hourStart === undefined) {
      hourStart = zonedHourStartMs(date, hour, reportZone);
      if (dateInTimeZone(hourStart, reportZone) !== date) throw invalid();
      hours.set(hourKey, hourStart);
    }
    const at = hourStart + minute * MINUTE;
    let formatter = clocks.get(reportZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-GB', { timeZone: reportZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      clocks.set(reportZone, formatter);
    }
    const key = `${stamp.slice(8, 10)}:${stamp.slice(10)}`;
    const ambiguous = [-HOUR, -HOUR / 2, HOUR / 2, HOUR].some(offset => formatter.format(at + offset) === key);
    if (formatter.format(at) !== key) throw invalid();
    const index = (at - start) / MINUTE, previous = (at - priorStart) / MINUTE;
    if (index >= 0 && index < day.minutes.length) {
      today.set(index, ambiguous ? null : Number(count));
      if (ambiguous && index + 60 < day.minutes.length) today.set(index + 60, null);
    }
    if (previous >= 0 && previous < prior.length) prior[previous] = ambiguous ? null : Number(count);
  }
  // Explicit/omitted trailing zeros in an intraday report do not prove that
  // GA4 processed those minutes. Keep the newest nonzero minute provisional.
  const edge = Math.min(Math.floor((nowMs - start) / MINUTE), Math.max(-1, ...[...today].filter(([, value]) => value !== null && value > 0).map(([index]) => index)));
  day.minutes = day.minutes.map((_, i) => i < edge ? today.has(i) ? today.get(i)! : 0 : null);
  day.sameDayLastWeek = alignComparisonMinutes(prior, priorStart, start, day.minutes.length, zone);
  return { day, quota: parseGa4PropertyQuota(record) };
}

export type ComparisonObservation = { observedAt: string; nextAttemptAt: string; ok: boolean; code?: string };
export async function updateComparison(env: IngestEnv, input: { asset: string; property: string; token: string; zone: string; nowMs: number;
  fetchImpl: typeof fetch; cache: Ga4ReadCache | null; changes?: readonly TimeZoneChange[];
  shared: SharedComparisons }): Promise<ComparisonObservation | null> {
  const { asset, property, token, zone, nowMs, fetchImpl, changes = [], shared } = input;
  const date = dateInTimeZone(nowMs, zone);
  const prior = await comparisonAttempt(env.STORE, asset, property, date, zone);
  if (prior && Date.parse(javascriptInstant(prior.next_attempt_at)) > nowMs) return null;
  let observedAt = new Date(nowMs).toISOString(), nextAttemptAt = new Date(nowMs + HOUR).toISOString();
  let payload: string | null = null, code: string | null = null;
  let quota: Ga4PropertyQuota | null = null;
  try {
    const key = JSON.stringify([property, date, zone, changes]);
    let read = shared.get(key);
    if (!read) {
      read = cachedGa4Read(input.cache && { ...input.cache, scope: await ga4CacheScope([input.cache.scope, changes]), version: `comparison-minutes-v1:${date}:${zone}` }, 'comparison', nowMs, HOUR,
        () => collectComparison(property, token, fetchImpl, nowMs, zone, changes));
      shared.set(key, read);
    }
    const result = await read;
    observedAt = result.observedAt;
    nextAttemptAt = new Date(Date.parse(observedAt) + (quotaPressure(result.value.quota).length ? 4 * HOUR : HOUR)).toISOString();
    payload = JSON.stringify(result.value.day);
    quota = result.value.quota;
  } catch (error) {
    const normalized = normalizeSignalError(error, 'The activity comparison is unavailable.');
    if (normalized.code === 'ga4_read_in_progress') return null;
    code = normalized.code;
    if (error instanceof Ga4ReadError) nextAttemptAt = new Date(Math.max(Date.parse(nextAttemptAt), Date.parse(error.nextAttemptAt))).toISOString();
  }
  await env.STORE.write(tx => tx.execute(`INSERT INTO noticeos.traffic_comparison_reports
    (workspace_id,asset_id,property_ref,comparison_day,time_zone,observed_at,next_attempt_at,payload,error_code)
    VALUES($1::uuid,$2,$3,$4::date,$5,$6::timestamptz,$7::timestamptz,$8::jsonb,$9) ON CONFLICT DO NOTHING`,
  [tx.workspaceId, asset, property, date, zone, observedAt, nextAttemptAt, payload, code]));
  if (code === null) await recordGa4Quota(env, { asset, lane: 'ga4-comparison', propertyRef: property, quota, at: observedAt });
  return { observedAt, nextAttemptAt, ok: code === null, ...(code ? { code } : {}) };
}

/** Display reads retain the last successful backfill through a failed refresh. */
export async function backfillComparison(store: WorkspaceStore, asset: string, property: string, day: Ga4RealtimeDay): Promise<void> {
  const latest = await comparisonAttempt(store, asset, property, day.date, day.timeZone);
  const success = latest?.payload ? latest : await comparisonAttempt(store, asset, property, day.date, day.timeZone, true);
  day.comparisonError = latest?.error_code ?? (success ? null : 'ga4_comparison_waiting');
  if (!success?.payload) return;
  const report = JSON.parse(success.payload) as Ga4RealtimeDay;
  if (report.startAt !== day.startAt || report.minutes.length !== day.minutes.length) return;
  day.comparisonObservedAt = javascriptInstant(success.observed_at);
  day.minutes = day.minutes.map((value, i) => report.minutes[i] ?? value);
  day.sameDayLastWeek = day.sameDayLastWeek?.map((value, i) => report.sameDayLastWeek?.[i] ?? value) ?? report.sameDayLastWeek;
}
