import { describe, expect, it } from 'vitest';
import {
  dateInTimeZone,
  hourInTimeZone,
  isValidTimeZone,
  shiftCalendarDate,
  zonedHourStartMs,
} from '../src/time-zone.js';

describe('zonedHourStartMs', () => {
  it('resolves a local hour to its UTC instant across offsets', () => {
    // Daylight time: Eastern runs four hours behind UTC, Pacific seven.
    expect(zonedHourStartMs('2026-09-02', 9, 'America/New_York')).toBe(
      Date.UTC(2026, 8, 2, 13),
    );
    expect(zonedHourStartMs('2026-09-02', 9, 'America/Los_Angeles')).toBe(
      Date.UTC(2026, 8, 2, 16),
    );
    // Standard time in the same zone is one hour further from UTC.
    expect(zonedHourStartMs('2026-01-15', 9, 'America/New_York')).toBe(
      Date.UTC(2026, 0, 15, 14),
    );
    // Zones ahead of UTC, including one on a half-hour offset.
    expect(zonedHourStartMs('2026-09-02', 9, 'Asia/Tokyo')).toBe(
      Date.UTC(2026, 8, 2, 0),
    );
    expect(zonedHourStartMs('2026-09-02', 9, 'Asia/Kolkata')).toBe(
      Date.UTC(2026, 8, 2, 3, 30),
    );
  });

  it('takes the earlier instant when a local hour happens twice', () => {
    // 2026-11-01 01:00 in New York occurs at 05:00Z (EDT) and again at
    // 06:00Z (EST). The bucket starts at the first one.
    expect(zonedHourStartMs('2026-11-01', 1, 'America/New_York')).toBe(
      Date.UTC(2026, 10, 1, 5),
    );
  });

  it('takes the instant before the gap when a local hour never happens', () => {
    // Spring forward skips 2026-03-08 02:00 in New York; 01:00 EST is the
    // last instant before the jump.
    expect(zonedHourStartMs('2026-03-08', 2, 'America/New_York')).toBe(
      Date.UTC(2026, 2, 8, 6),
    );
  });
});

describe('dateInTimeZone and hourInTimeZone', () => {
  it('reads one instant on two clocks', () => {
    const ms = Date.UTC(2026, 8, 2, 13);
    expect(hourInTimeZone(ms, 'America/Los_Angeles')).toBe(6);
    expect(dateInTimeZone(ms, 'America/Los_Angeles')).toBe('2026-09-02');
    expect(hourInTimeZone(ms, 'America/New_York')).toBe(9);
  });

  it('keeps an instant on the calendar day the zone is actually in', () => {
    // Midnight Eastern on 2026-09-02 is still the previous evening out west.
    const ms = Date.UTC(2026, 8, 2, 4);
    expect(dateInTimeZone(ms, 'America/New_York')).toBe('2026-09-02');
    expect(hourInTimeZone(ms, 'America/New_York')).toBe(0);
    expect(dateInTimeZone(ms, 'America/Los_Angeles')).toBe('2026-09-01');
    expect(hourInTimeZone(ms, 'America/Los_Angeles')).toBe(21);
  });

  it('reports local midnight as hour 0, never 24', () => {
    const ms = Date.UTC(2026, 8, 2, 7, 30);
    expect(hourInTimeZone(ms, 'America/Los_Angeles')).toBe(0);
    expect(hourInTimeZone(Date.UTC(2026, 8, 2, 0), 'UTC')).toBe(0);
  });
});

describe('shiftCalendarDate', () => {
  it('moves whole days, including across month and year edges', () => {
    expect(shiftCalendarDate('2026-09-02', -7)).toBe('2026-08-26');
    expect(shiftCalendarDate('2026-09-02', 7)).toBe('2026-09-09');
    expect(shiftCalendarDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftCalendarDate('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('ignores daylight saving, which never moves a calendar date', () => {
    expect(shiftCalendarDate('2026-11-02', -7)).toBe('2026-10-26');
  });
});

describe('isValidTimeZone', () => {
  it('separates IANA names from anything else', () => {
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Pacific Time')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
