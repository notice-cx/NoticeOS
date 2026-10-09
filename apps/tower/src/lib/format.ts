import { currencyMinorDigits } from '@noticeos/contract/money';
// Number formatting. Presentation only — every metric renders through a stat
// component that bakes in tabular-nums, so these never worry about alignment.

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const USD_CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Dollars. An exact amount (`ExactUsd`, a number's digits as text) is
 * formatted from the decimal itself, never through a float. */
export function formatUsd(n: number | `${number}`, opts?: { cents?: boolean }): string {
  return (opts?.cents ? USD_CENTS : USD).format(n);
}

export function formatInt(n: number): string {
  return INT.format(n);
}

export function formatCompact(n: number): string {
  return COMPACT.format(n);
}

const COMPACT_WHOLE = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 0,
});

/**
 * A count-axis tick in at most four characters (bead `ro-oag5`).
 *
 * The Wall's count axis is a fixed 2rem column, and the midpoint of an odd
 * maximum is a half: a peak of 1,861 put "930.5" there, five characters that
 * painted 5px outside the column on every card whose chart reached it. The
 * tick keeps one decimal while that still fits ("59.5", "1.9K") and drops it
 * when it does not ("931", "12K"). A tick is already a rounded reading — the
 * top one says "1.9K" for 1,861 — and every bar's exact value is on its own
 * hover, so nothing is lost that the axis ever promised.
 */
export function formatAxisCount(n: number): string {
  const precise = COMPACT.format(n);
  return precise.length <= 4 ? precise : COMPACT_WHOLE.format(n);
}

/** Preserve small non-zero movement so a directional arrow never says 0%. */
export function formatPercent(n: number): string {
  if (n === 0) return "0";
  const formatted =
    Math.abs(n) < 10 ? n.toFixed(1) : Math.round(n).toString();
  return formatted.replace(/\.0$/, "");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A series label — a day (`YYYY-MM-DD`) or an accounting month (`YYYY-MM`) — as
 * the compact axis label a chart prints beside it: "Sep 5", "Sep '26".
 *
 * It lived in `Spark.tsx` until doc 14 split that component in two, which put a
 * second copy of the MONTHS table above it in a file that draws lines. Series
 * labels are calendar FACTS rather than instants, so it parses by hand: routing
 * one through `Date` would let the viewer's timezone move a provider's day.
 */
export function formatSeriesDate(value: string): string {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!match) return value;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return value;
  return match[3] ? `${month} ${Number(match[3])}` : `${month} '${match[1]!.slice(2)}`;
}

/** An accounting period ('YYYY-MM') as the month an operator says out loud
 * ("Jul"). Parsed by hand rather than through `Date`, which would drag the
 * viewer's timezone into a label that has none. Falls back to the raw string. */
export function formatPeriodMonth(period: string): string {
  const month = MONTHS[Number(period.slice(5, 7)) - 1];
  return month ?? period;
}

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** An accounting period's month in full ("August") — the Wall's revenue widget
 * names the month it is standing in and the one it is measured against. Same
 * hand parse as the short form. */
export function formatPeriodMonthLong(period: string): string {
  return MONTHS_LONG[Number(period.slice(5, 7)) - 1] ?? period;
}

/** An accounting period with its year ("August 2026") — for the one case where
 * a figure is NOT about the month the reader is standing in, and an abbreviated
 * month beside a current-month layout would be read as this month's (bead
 * `ro-bdkp`). Same hand parse, same timezone-free promise. */
export function formatPeriodMonthYear(period: string): string {
  const month = MONTHS_LONG[Number(period.slice(5, 7)) - 1];
  const year = period.slice(0, 4);
  return month && /^\d{4}$/.test(year) ? `${month} ${year}` : period;
}

function parseCalendarDate(
  value: string,
): { year: string; month: string; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  const day = Number(match[3]);
  if (!month || day < 1 || day > 31) return null;
  return { year: match[1]!, month, day };
}

/** Human-facing labels for date-only evidence. Parse without `Date` so the
 * viewer's timezone cannot move a provider report into a neighboring day. */
export function formatCalendarDate(value: string): string {
  const date = parseCalendarDate(value);
  return date ? `${date.month} ${date.day}, ${date.year}` : value;
}

export function formatCalendarRange(first: string, last: string): string {
  const start = parseCalendarDate(first);
  const end = parseCalendarDate(last);
  if (!start || !end) return `${first}–${last}`;
  if (first === last) return formatCalendarDate(first);
  if (start.year === end.year && start.month === end.month) {
    return `${start.month} ${start.day}–${end.day}, ${start.year}`;
  }
  if (start.year === end.year) {
    return `${start.month} ${start.day}–${end.month} ${end.day}, ${start.year}`;
  }
  return `${start.month} ${start.day}, ${start.year}–${end.month} ${end.day}, ${end.year}`;
}

/** An evidence instant in the viewer's local zone, explicitly labelled.
 * Date-only reporting periods must use formatCalendarDate instead. Callers
 * retain the original instant in a time element for exact machine readback. */
export function formatTimestamp(value: string, timeZone?: string): string {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit",
    timeZoneName: "short", timeZone,
  }).format(instant);
}

/** An IANA zone name as a person reads it: "America / New York". The Settings
 * picker and Home's first-run clock say a zone the same way. */
export function formatZoneName(zone: string): string {
  return zone.replaceAll("_", " ").replaceAll("/", " / ");
}

export type Direction = "up" | "down" | "flat";

export function direction(n: number): Direction {
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

/** A signed USD magnitude using a real minus glyph, e.g. "−$1,240" / "$1,240". */
export function formatSignedUsd(n: number, opts?: { cents?: boolean }): string {
  const body = formatUsd(Math.abs(n), opts);
  return n < 0 ? `−${body}` : body;
}


/** Ledger amounts always carry their own currency. Null is unavailable, never USD zero. */
export function formatMoney(amount: number | null, currency: string | null, opts?: { cents?: boolean }): string {
  if (currency === null || amount === null || !Number.isFinite(amount)) return 'Unavailable';
  const digits = currencyMinorDigits(currency);
  if (digits === null) return 'Unavailable';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency,
    minimumFractionDigits: opts?.cents ? digits : 0,
    maximumFractionDigits: opts?.cents ? digits : 0 }).format(amount);
}

export function formatSignedMoney(amount: number | null, currency: string | null, opts?: { cents?: boolean }): string {
  if (amount === null) return 'Unavailable';
  return `${amount > 0 ? '+' : amount < 0 ? '−' : ''}${formatMoney(Math.abs(amount), currency, opts)}`;
}
