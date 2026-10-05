// Calendar arithmetic in a named IANA zone.
//
// Every conversion here goes through `Intl.DateTimeFormat`, which workerd and
// Node both carry with full tzdata. No timezone library is a dependency of
// this repo, and none needs to be: a zone's offset at an instant is exactly
// what formatting that instant in the zone tells us.

/** Formats an instant into the zone's own wall-clock parts. */
function zonedParts(
  ms: number,
  timeZone: string,
): Map<Intl.DateTimeFormatPartTypes, string> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  return new Map(parts.map((part) => [part.type, part.value]));
}

/** The calendar date `ms` falls on in `timeZone`, as `YYYY-MM-DD`. */
export function dateInTimeZone(ms: number, timeZone: string): string {
  const values = zonedParts(ms, timeZone);
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

/** The wall-clock hour `ms` falls in, 0–23, in `timeZone`. */
export function hourInTimeZone(ms: number, timeZone: string): number {
  // `hourCycle: 'h23'` keeps midnight at 00 rather than the 24 an `hour12:
  // false` formatter reports in some engines; the modulo is belt and braces.
  return Number(zonedParts(ms, timeZone).get('hour')) % 24;
}

/** `date` (`YYYY-MM-DD`) moved by whole days, still `YYYY-MM-DD`. */
export function shiftCalendarDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * The UTC instant at which local `date hour:00` begins in `timeZone`.
 *
 * The offset is discovered by formatting rather than tabulated: guess the
 * instant as if the zone were UTC, measure how far the zone's wall clock sits
 * from that guess, and subtract. A second pass catches the case where the
 * correction itself crosses a DST transition.
 *
 * A local hour that occurs twice (the fall-back hour) resolves to the earlier
 * of the two instants. A local hour that never occurs (the spring-forward
 * gap) resolves to the instant one hour before the gap.
 */
export function zonedHourStartMs(
  date: string,
  hour: number,
  timeZone: string,
): number {
  const [year, month, day] = date.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const guess = Date.UTC(year, month - 1, day, hour);
  const first = zoneOffsetMs(guess, timeZone);
  let ms = guess - first;
  const second = zoneOffsetMs(ms, timeZone);
  if (second !== first) ms = guess - second;
  return ms;
}

/** True when `Intl` recognizes the zone. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** How far the zone's wall clock runs ahead of UTC at `ms`, in milliseconds. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const values = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(
    Number(values.get('year')),
    Number(values.get('month')) - 1,
    Number(values.get('day')),
    Number(values.get('hour')) % 24,
    Number(values.get('minute')),
    Number(values.get('second')),
  );
  // Zone offsets are whole seconds, so the sub-second part of `ms` is noise.
  return asUtc - Math.floor(ms / 1_000) * 1_000;
}
