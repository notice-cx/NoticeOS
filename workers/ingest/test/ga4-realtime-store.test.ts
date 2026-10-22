import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Ga4RealtimeAsset } from '@noticeos/contract';
import { readGa4Reading, readRealtimeDay, realtimeReadDue, saveGa4Reading } from '../src/ga4-realtime-store.js';
import { reset } from './helpers.js';

type Reading = Extract<Ga4RealtimeAsset, { status: 'success' }>;
const NOW = Date.parse('2026-07-29T12:00:00Z');
function reading(at: number, value = 3): Reading {
  return { asset: 'meadow.example', status: 'success', observedAt: new Date(at).toISOString(), timeZone: 'UTC',
    activeUsers5m: 7, activeUsers30m: 26, activeUsersByMinute: Array<number | null>(30).fill(value),
    hourlyActiveUsers: null, hourlyErrorCode: 'ga4_realtime_history', errorCode: null };
}
beforeEach(reset);

describe('retained realtime activity', () => {
  it('applies later overlapping revisions, including decreases, without adding them together', async () => {
    await saveGa4Reading(env.STORE, '123456', reading(NOW, 9));
    await saveGa4Reading(env.STORE, '123456', reading(NOW + 60_000, 2));
    // A late completion of an older read cannot replace the newer revision.
    await saveGa4Reading(env.STORE, '123456', reading(NOW - 60_000, 20));
    const day = await readRealtimeDay(env.STORE, 'meadow.example', '123456', NOW + 60_000, 'UTC');
    expect(day.minutes[12 * 60]).toBe(2);
    expect(day.minutes[12 * 60 - 29]).toBe(9);
    expect(day.minutes[12 * 60 - 31]).toBeNull();
    expect(day.minutes[12 * 60 + 2]).toBeNull();
  });

  it('keeps an outage longer than the API window as a gap and never invents a baseline', async () => {
    await saveGa4Reading(env.STORE, '123456', reading(NOW));
    await saveGa4Reading(env.STORE, '123456', reading(NOW + 3_600_000));
    const day = await readRealtimeDay(env.STORE, 'meadow.example', '123456', NOW + 3_600_000, 'UTC');
    expect(day.minutes[12 * 60 + 15]).toBeNull();
    expect(day.sameDayLastWeek?.every(value => value === null)).toBe(true);
  });

  it('does not replace known minutes with a malformed or missing minute report', async () => {
    await saveGa4Reading(env.STORE, '123456', reading(NOW, 9));
    await saveGa4Reading(env.STORE, '123456', { ...reading(NOW + 60_000), activeUsersByMinute: null });
    const day = await readRealtimeDay(env.STORE, 'meadow.example', '123456', NOW + 60_000, 'UTC');
    expect(day.minutes[12 * 60]).toBe(9);
    expect(day.minutes[12 * 60 + 1]).toBeNull();
  });

  it('keeps a reading idempotent and isolates asset and property identities', async () => {
    await saveGa4Reading(env.STORE, '123456', reading(NOW, 3));
    await saveGa4Reading(env.STORE, '123456', reading(NOW, 99));
    await saveGa4Reading(env.STORE, '654321', reading(NOW + 60_000, 80));
    expect((await readGa4Reading(env.STORE, 'meadow.example', '123456'))?.activeUsersByMinute?.at(-1)).toBe(3);
    expect(await readGa4Reading(env.STORE, 'northwind.example', '123456')).toBeNull();
    expect(await readGa4Reading(env.STORE, 'meadow.example', 'unknown')).toBeNull();
  });

  it('retains like-for-like last-week minute counts and rebuckets UTC evidence when the saved zone changes', async () => {
    await saveGa4Reading(env.STORE, '123456', reading(NOW - 7 * 86_400_000, 6));
    await saveGa4Reading(env.STORE, '123456', reading(NOW, 3));
    const utc = await readRealtimeDay(env.STORE, 'meadow.example', '123456', NOW, 'UTC');
    const shifted = await readRealtimeDay(env.STORE, 'meadow.example', '123456', NOW, 'America/Los_Angeles');
    expect(utc.minutes[12 * 60]).toBe(3);
    expect(shifted.minutes[5 * 60]).toBe(3);
    expect(shifted.sameDayLastWeek?.[5 * 60]).toBe(6);
  });

  it('preserves the previous day at midnight and splits an overlapping window across dates', async () => {
    const midnight = Date.parse('2026-07-30T00:00:00Z');
    await saveGa4Reading(env.STORE, '123456', reading(midnight + 60_000, 4));
    const day = await readRealtimeDay(env.STORE, 'meadow.example', '123456', midnight + 60_000, 'UTC');
    expect(day.date).toBe('2026-07-30');
    expect(day.minutes.slice(0, 3)).toEqual([4, 4, null]);
    expect(day.minutes.at(-1)).toBeNull();
  });

  it.each([['2026-03-08T20:00:00Z', 1380], ['2026-11-01T20:00:00Z', 1500]])('uses the actual local day length at %s', async (iso, minutes) => {
    const day = await readRealtimeDay(env.STORE, 'meadow.example', '123456', Date.parse(iso), 'America/Los_Angeles');
    expect(day.minutes).toHaveLength(minutes);
    expect(day.sameDayLastWeek).toHaveLength(minutes);
    expect(day.sameDayLastWeek?.every(value => value === null)).toBe(true);
  });
});

describe('realtime quota backoff', () => {
  const scarce = (at: number, remaining: number): Reading => ({ ...reading(at), quota: {
    core: null, realtime: { tokensPerDay: { consumed: 8, remaining }, tokensPerHour: null },
  } });
  it.each([[199_000, 60_000], [30_000, 300_000], [5_000, 900_000], [0, 3_600_000]])('waits %sms at %s daily tokens remaining', (remaining, delay) => {
    expect(realtimeReadDue(scarce(NOW, remaining), NOW + delay - 1)).toBe(false);
    expect(realtimeReadDue(scarce(NOW, remaining), NOW + delay)).toBe(true);
  });
  it('resumes at the daily reset without waiting out the former scarcity delay', () => {
    const at = Date.parse('2026-07-29T07:59:00Z');
    expect(realtimeReadDue(scarce(at, 0), Date.parse('2026-07-29T08:00:00Z'))).toBe(true);
  });
});
