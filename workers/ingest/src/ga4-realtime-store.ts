import { GA4_PULSE_MINUTES, type Ga4RealtimeAsset, type Ga4RealtimeDay, type Ga4RealtimeQuota } from '@noticeos/contract';
import { javascriptInstant, type WorkspaceStore } from '@noticeos/postgres';
import { alignComparisonMinutes, backfillComparison } from './ga4-comparison.js';
import { dateInTimeZone, shiftCalendarDate, zonedHourStartMs } from './time-zone.js';

type Reading = Extract<Ga4RealtimeAsset, { status: 'success' }>;
type StoredReading = {
  observed_at: string;
  active_users_five_minutes: bigint;
  active_users_thirty_minutes: bigint;
  minutes: string | null;
  quota: string | null;
}
const COLUMNS = 'observed_at, active_users_five_minutes, active_users_thirty_minutes, minutes::text, quota::text';
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Retain the original clock, including on a shared-cache hit. */
export async function saveGa4Reading(store: WorkspaceStore, property: string, reading: Reading): Promise<void> {
  await store.write(tx => tx.execute(`INSERT INTO noticeos.realtime_traffic_readings
    (workspace_id, asset_id, property_ref, observed_at, active_users_five_minutes, active_users_thirty_minutes, minutes, quota)
    VALUES ($1::uuid,$2,$3,$4::timestamptz,$5,$6,$7::jsonb,$8::jsonb) ON CONFLICT DO NOTHING`,
  [tx.workspaceId, reading.asset, property, reading.observedAt, reading.activeUsers5m, reading.activeUsers30m,
    reading.activeUsersByMinute == null ? null : JSON.stringify(reading.activeUsersByMinute),
    reading.quota == null ? null : JSON.stringify(reading.quota)]));
}

/** Scarce quota slows the one collector, never each browser independently.
 * Daily buckets reset at midnight PST; hourly buckets refill within an hour. */
export function realtimeNextReadAt(reading: Reading, nowMs: number): number {
  const observed = Date.parse(reading.observedAt);
  const quota = reading.quota?.realtime;
  const dayChanged = Math.floor((nowMs - 8 * 3_600_000) / DAY_MS) !== Math.floor((observed - 8 * 3_600_000) / DAY_MS);
  const daily = dayChanged ? null : quota?.tokensPerDay?.remaining;
  const hourly = nowMs - observed >= 3_600_000 ? null : quota?.tokensPerHour?.remaining;
  const delay = daily != null && daily <= 1_000 || hourly != null && hourly <= 400 ? 3_600_000
    : daily != null && daily <= 10_000 || hourly != null && hourly <= 2_000 ? 15 * MINUTE_MS
      : daily != null && daily <= 40_000 || hourly != null && hourly <= 8_000 ? 5 * MINUTE_MS : MINUTE_MS;
  return observed + delay;
}

export function realtimeReadDue(reading: Reading, nowMs: number): boolean {
  return nowMs >= realtimeNextReadAt(reading, nowMs);
}

function asReading(asset: string, row: StoredReading, timeZone: string): Reading {
  const observedAt = javascriptInstant(row.observed_at);
  return { asset, status: 'success', activeUsers5m: Number(row.active_users_five_minutes), activeUsers30m: Number(row.active_users_thirty_minutes),
    activeUsersByMinute: row.minutes === null ? null : JSON.parse(row.minutes) as (number | null)[],
    observedAt, timeZone, hourlyActiveUsers: null, hourlyErrorCode: 'ga4_realtime_history',
    quota: row.quota === null ? null : JSON.parse(row.quota) as Ga4RealtimeQuota, errorCode: null };
}

/** Property mappings bound every read, so changing a mapping cannot reuse the
 * former property's traffic. WorkspaceStore supplies the workspace boundary. */
export async function readGa4Reading(store: WorkspaceStore, asset: string, property: string,
  day?: { nowMs: number; timeZone: string }): Promise<Reading | null> {
  const [row] = await store.read(tx => tx.query<StoredReading>(`SELECT ${COLUMNS} FROM noticeos.realtime_traffic_readings
    WHERE asset_id=$1 AND property_ref=$2 ORDER BY observed_at DESC LIMIT 1`, [asset, property]));
  if (!row) return null;
  const reading = asReading(asset, row, day?.timeZone ?? 'UTC');
  reading.nextAttemptAt = new Date(realtimeNextReadAt(reading, day?.nowMs ?? Date.parse(reading.observedAt))).toISOString();
  if (day) {
    reading.realtimeDay = await readRealtimeDay(store, asset, property, day.nowMs, day.timeZone);
    // Pulse placement advances on display reads; the retained history does not.
    const ageMinutes = Math.floor(day.nowMs / MINUTE_MS) - Math.floor(Date.parse(reading.observedAt) / MINUTE_MS);
    if (reading.activeUsersByMinute && ageMinutes > 0) reading.activeUsersByMinute = Array.from({ length: GA4_PULSE_MINUTES }, (_, index) =>
      index + ageMinutes < GA4_PULSE_MINUTES ? reading.activeUsersByMinute![index + ageMinutes]! : null);
  }
  return reading;
}

export async function readRealtimeDay(store: WorkspaceStore, asset: string, property: string, nowMs: number, timeZone: string): Promise<Ga4RealtimeDay> {
  const date = dateInTimeZone(nowMs, timeZone);
  const priorDate = shiftCalendarDate(date, -7);
  const bounds = (on: string) => ({ start: zonedHourStartMs(on, 0, timeZone), end: zonedHourStartMs(shiftCalendarDate(on, 1), 0, timeZone) });
  const today = bounds(date), prior = bounds(priorDate);
  // The next day's first readings can revise the previous day's last minutes.
  const rows = await store.read(tx => tx.query<StoredReading>(`SELECT ${COLUMNS} FROM noticeos.realtime_traffic_readings
    WHERE asset_id=$1 AND property_ref=$2 AND observed_at <= $3::timestamptz
      AND ((observed_at >= $4::timestamptz AND observed_at < $5::timestamptz)
        OR (observed_at >= $6::timestamptz AND observed_at < $7::timestamptz)) ORDER BY observed_at`,
  [asset, property, new Date(nowMs).toISOString(), new Date(today.start).toISOString(), new Date(today.end + 30 * MINUTE_MS).toISOString(),
    new Date(prior.start).toISOString(), new Date(prior.end + 30 * MINUTE_MS).toISOString()]));
  const minutes = Array<number | null>((today.end - today.start) / MINUTE_MS).fill(null);
  const sameDayLastWeek = Array<number | null>((prior.end - prior.start) / MINUTE_MS).fill(null);
  for (const row of rows) {
    if (row.minutes === null) continue;
    const values = JSON.parse(row.minutes) as (number | null)[];
    const endMinute = Math.floor(Date.parse(javascriptInstant(row.observed_at)) / MINUTE_MS);
    for (const [index, value] of values.entries()) {
      if (value === null) continue;
      const at = (endMinute - (GA4_PULSE_MINUTES - 1) + index) * MINUTE_MS;
      if (at >= today.start && at < today.end) minutes[(at - today.start) / MINUTE_MS] = value;
      if (at >= prior.start && at < prior.end) sameDayLastWeek[(at - prior.start) / MINUTE_MS] = value;
    }
  }
  const day: Ga4RealtimeDay = { date, timeZone, startAt: new Date(today.start).toISOString(), endAt: new Date(today.end).toISOString(), minutes,
    sameDayLastWeek: alignComparisonMinutes(sameDayLastWeek, prior.start, today.start, minutes.length, timeZone) };
  await backfillComparison(store, asset, property, day);
  return day;
}
