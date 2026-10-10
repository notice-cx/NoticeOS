import { describe, expect, it } from 'vitest';
import { GA4_PULSE_MINUTES, ga4MinuteBuckets } from '../src/ga4-realtime.js';

// The minute pulse's one derivation: GA4's per-minute rows become the 30
// buckets the Wall draws.

const MINUTE = 60_000;
/** 12:00:20 — twenty seconds into the minute the reading is taken in. */
const READ_AT = Date.parse('2026-09-23T12:00:20.000Z');

describe('the minute pulse buckets', () => {
  it('are thirty clock minutes, oldest first, ending with the minute the reading was taken in', () => {
    const buckets = ga4MinuteBuckets(
      [
        { minutesAgo: 0, activeUsers: 4 },
        { minutesAgo: 1, activeUsers: 9 },
        { minutesAgo: 29, activeUsers: 2 },
      ],
      READ_AT,
      READ_AT + 15_000,
    );
    expect(buckets).toHaveLength(GA4_PULSE_MINUTES);
    expect(buckets[0]).toBe(2);
    expect(buckets.at(-2)).toBe(9);
    expect(buckets.at(-1)).toBe(4);
  });

  it('reads a minute the report has no row for as nobody active, never as unknown', () => {
    const buckets = ga4MinuteBuckets([{ minutesAgo: 3, activeUsers: 1 }], READ_AT, READ_AT);
    expect(buckets.filter((value) => value === null)).toEqual([]);
    expect(buckets.filter((value) => value === 0)).toHaveLength(29);
    // A quiet half hour is thirty zeros: a legitimate reading, not a gap.
    expect(ga4MinuteBuckets([], READ_AT, READ_AT)).toEqual(Array.from({ length: 30 }, () => 0));
  });

  it('leaves the minutes after the reading absent when it is served later, never zero', () => {
    const rows = Array.from({ length: 30 }, (_, minutesAgo) => ({ minutesAgo, activeUsers: 30 - minutesAgo }));
    // Served in the next minute but one: the two newest minutes were never read.
    const later = ga4MinuteBuckets(rows, READ_AT, READ_AT + 2 * MINUTE);
    expect(later.slice(-2)).toEqual([null, null]);
    // Everything shifts two minutes left: the reading's own minute is third
    // from the end, and its two oldest minutes have left the window.
    expect(later.at(-3)).toBe(30);
    expect(later[0]).toBe(3);
    // Half an hour later none of the reading is inside the window.
    expect(ga4MinuteBuckets(rows, READ_AT, READ_AT + 30 * MINUTE)).toEqual(Array.from({ length: 30 }, () => null));
  });

  it('never places a reading taken after the window it is asked for', () => {
    // A clock that runs behind the reading: the minutes the reading has but the
    // window ends before are simply outside it, and the window's oldest
    // minutes, before the reading's thirty, are unknown.
    const rows = [{ minutesAgo: 0, activeUsers: 5 }, { minutesAgo: 1, activeUsers: 6 }];
    const buckets = ga4MinuteBuckets(rows, READ_AT, READ_AT - MINUTE);
    expect(buckets.at(-1)).toBe(6);
    expect(buckets[0]).toBeNull();
  });
});
