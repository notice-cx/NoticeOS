export interface CountdownParts {
  months: number;
  days: number;
  hours: number;
  minutes: number;
  complete: boolean;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function addLocalMonthsClamped(source: Date, months: number): Date {
  const result = new Date(source);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0,
  ).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

/**
 * Calendar-month countdown followed by exact elapsed days/hours/minutes.
 * Months are not treated as a misleading fixed 30-day unit.
 */
export function countdownParts(nowMs: number, targetAt: string): CountdownParts {
  const targetMs = Date.parse(targetAt);
  if (!Number.isFinite(targetMs) || targetMs <= nowMs) {
    return { months: 0, days: 0, hours: 0, minutes: 0, complete: true };
  }

  const now = new Date(nowMs);
  const target = new Date(targetMs);
  let months =
    (target.getFullYear() - now.getFullYear()) * 12 +
    target.getMonth() -
    now.getMonth();
  let anchor = addLocalMonthsClamped(now, months);

  while (months > 0 && anchor.getTime() > targetMs) {
    months -= 1;
    anchor = addLocalMonthsClamped(now, months);
  }
  while (addLocalMonthsClamped(now, months + 1).getTime() <= targetMs) {
    months += 1;
    anchor = addLocalMonthsClamped(now, months);
  }

  let remaining = targetMs - anchor.getTime();
  const days = Math.floor(remaining / DAY_MS);
  remaining -= days * DAY_MS;
  const hours = Math.floor(remaining / HOUR_MS);
  remaining -= hours * HOUR_MS;
  const minutes = Math.floor(remaining / MINUTE_MS);

  return { months, days, hours, minutes, complete: false };
}

export type CountdownProximity =
  | "far"
  | "approaching"
  | "near"
  | "soon"
  | "imminent"
  | "reached";

export interface CountdownBand {
  id: CountdownProximity;
  /** Lowest days-remaining that still reads as this band. */
  minDays: number;
  /** The tint the countdown VALUE wears; unit captions stay muted. */
  valueClassName: string;
  /**
   * Surface behind the primary value. Empty below `soon`: only the two hot
   * bands earn a background, without turning each measure into its own card.
   */
  surfaceClassName: string;
}

/** The hot end of the ramp, and the fallback for a target we cannot place. */
const IMMINENT: CountdownBand = {
  id: "imminent",
  minDays: Number.NEGATIVE_INFINITY,
  valueClassName: "text-error",
  surfaceClassName: "bg-error-soft",
};

/**
 * Past the target. Outside COUNTDOWN_BANDS and selected by the clock: an event
 * that already happened asks for nothing, so no tint and quieter than `far`
 * (half the muted token), legible when looked at and invisible when scanning.
 */
const REACHED: CountdownBand = {
  id: "reached",
  minDays: Number.NEGATIVE_INFINITY,
  valueClassName: "text-muted-foreground/50",
  surfaceClassName: "",
};

/**
 * Proximity bands, roughly log-spaced (30 / 14 / 7 / 2 days) so each step is
 * about half the remaining wait rather than an even slice of the calendar: a
 * month out is background information, the last two days are now. Ordered
 * widest-first; a target belongs to the first band whose `minDays` it still
 * clears, so 30d reads far and 14d reads approaching.
 *
 * The colors are the attention tokens (muted, foreground, warn, urgent, error);
 * only `--urgent` is the ramp's own, the step between amber and red. The last
 * two bands add a tinted field behind the value.
 */
export const COUNTDOWN_BANDS: readonly CountdownBand[] = [
  {
    id: "far",
    minDays: 30,
    valueClassName: "text-muted-foreground",
    surfaceClassName: "",
  },
  {
    id: "approaching",
    minDays: 14,
    valueClassName: "text-foreground",
    surfaceClassName: "",
  },
  {
    id: "near",
    minDays: 7,
    valueClassName: "text-warn",
    surfaceClassName: "",
  },
  {
    id: "soon",
    minDays: 2,
    valueClassName: "text-urgent",
    surfaceClassName: "bg-urgent/10",
  },
  IMMINENT,
];

/**
 * How close the target is, from the same clock the digits are rendered from —
 * tint and value can never disagree. A target that has passed leaves the ramp
 * entirely for `reached`. An unparseable one does NOT: it says "Invalid date"
 * in words and is a configuration error somebody still has to fix, so it keeps
 * the hot treatment that gray would now hide.
 */
export function countdownProximity(
  nowMs: number,
  targetAt: string,
): CountdownBand {
  const targetMs = Date.parse(targetAt);
  if (!Number.isFinite(targetMs)) return IMMINENT;
  if (targetMs <= nowMs) return REACHED;
  const days = (targetMs - nowMs) / DAY_MS;
  return COUNTDOWN_BANDS.find((band) => days >= band.minDays) ?? IMMINENT;
}

/** Convert an absolute instant to the native datetime-local input's value. */
export function toLocalDateTimeInput(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}
