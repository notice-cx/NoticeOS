// Today's pace as arithmetic, with no rendering attached.

import type { Ga4RealtimeAsset } from "@noticeos/contract";
import type { AssetCard } from "@shared/wall";

/**
 * The least a pace needs before it states a percent. GA4 processes a standard
 * property's hours two to six hours behind the clock, so at breakfast today's
 * series can hold only the dead of night, and two such hours would read as a
 * red "↓48%" from a sample nobody would bet on. So a percent needs both
 * `minDataHours` completed hours with processed data (hours in the series,
 * never clock hours) and `minLastWeekUsers` of last week's users in those
 * hours: at 100 the percent's ordinary noise is about ±10% (1 / √100), so a
 * red reading is four times the noise. Below either, a surface names how far
 * the data reaches ("to 2 AM") and states no percent.
 */
export const PACE_VERDICT_MINIMUM = Object.freeze({ minDataHours: 4, minLastWeekUsers: 100 });

/** Today's pace, and everything a surface needs to caveat it honestly. */
export interface IntradayUsersPace {
  /** Distinct active users today so far, from the property's own daily series.
   * null when the daily series has not reached today — the pace below is still
   * true, and a surface may show it with no headline number beside it. */
  today: number | null;
  /** The daily point `today` came from, so a caller can ask the timezone
   * caveat about the right date. */
  todayDate: string | null;
  /** Completed hours today against the same hours a week ago, in percent —
   * or null while those hours cannot carry a verdict
   * (`PACE_VERDICT_MINIMUM`): a surface then states no percent and no tone. */
  paceChange: number | null;
  todayPace: number;
  lastWeekPace: number;
  /** The last hour that has elapsed IN FULL — the pace's right edge. */
  paceThroughHour: number;
  /** Completed hours with processed data the pace compares. */
  dataHours: number;
  /** The newest hour the provider has reported; it is still filling. */
  latestHour: number;
  /** "last Tue" where the prior day is known, else "last week". */
  priorDayLabel: string;
}

/** An hour of the day on a 12-hour clock: 0 and 24 are "12 AM", 12 "12 PM". */
export function clockHourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

/** Where the compared window ends, on the operator's clock: "to 2 AM" when
 * hours 0 and 1 are complete. Named beside the percent, and in its place while
 * the window carries no verdict. */
export function paceWindowLabel(pace: Pick<IntradayUsersPace, "paceThroughHour">): string {
  return `to ${clockHourLabel(pace.paceThroughHour + 1)}`;
}

/**
 * Now, as a fractional hour of the day on `timeZone`'s clock (7:25 → 7.4167),
 * or null for a zone the runtime cannot read. The hourly series is bucketed on
 * the snapshot's `timeZone`, so a chart's "now" is placed on that clock.
 */
export function clockHourNow(nowMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(new Date(nowMs));
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    return Number.isFinite(hour) && Number.isFinite(minute) ? (hour % 24) + minute / 60 : null;
  } catch {
    return null;
  }
}

/** A calendar date (`YYYY-MM-DD`) moved by whole days, on the calendar alone. */
export function offsetCalendarDate(value: string, days: number): string {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed)
    ? new Date(parsed + days * 86_400_000).toISOString().slice(0, 10)
    : value;
}

function weekdayName(value: string): string {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        timeZone: "UTC",
      }).format(parsed)
    : "week";
}

/**
 * The intraday pace. Three rules make it honest: the newest reported hour is
 * still filling, so pacing it against last week's whole hour would read as a
 * slump that is really just a clock; a comparison needs at least two reported
 * hours before there is a completed one to compare; and a percent only once
 * the completed hours can carry a verdict (`PACE_VERDICT_MINIMUM`), before
 * which `paceChange` is null and the window (`paceWindowLabel`) is what a
 * surface states. `null` means there is no pace to state. Never a zero, which
 * would claim flat.
 */
export function intradayUsersPace(
  asset: AssetCard,
  snapshot: Ga4RealtimeAsset | undefined,
): IntradayUsersPace | null {
  if (snapshot?.status !== "success" || snapshot.hourlyActiveUsers === null) return null;
  const reportedToday = snapshot.hourlyActiveUsers.filter(
    (point): point is typeof point & { today: number } => point.today !== null,
  );
  if (reportedToday.length < 2) return null;

  const latestHour = reportedToday.at(-1)!.hour;
  // Pace stops at the last hour that has elapsed in full; a chart may still
  // draw the hour in progress.
  const completedToday = reportedToday.slice(0, -1);
  const paceThroughHour = completedToday.at(-1)!.hour;
  const todayPace = completedToday.reduce((sum, point) => sum + point.today, 0);
  const lastWeekPace = snapshot.hourlyActiveUsers
    .filter((point) => point.hour <= paceThroughHour)
    .reduce((sum, point) => sum + point.sameDayLastWeek, 0);
  const dataHours = completedToday.length;
  const carriesVerdict =
    dataHours >= PACE_VERDICT_MINIMUM.minDataHours && lastWeekPace >= PACE_VERDICT_MINIMUM.minLastWeekUsers;
  const paceChange = !carriesVerdict ? null : ((todayPace - lastWeekPace) / lastWeekPace) * 100;

  const latestDaily = asset.activeUsers.series.at(-1) ?? null;
  const priorDaily =
    latestDaily === null
      ? null
      : ([
          ...(asset.activeUsers.contextSeries ?? []),
          ...asset.activeUsers.series,
        ].find((point) => point.t === offsetCalendarDate(latestDaily.t, -7)) ??
        null);

  return {
    today: latestDaily?.v ?? null,
    todayDate: latestDaily?.t ?? null,
    paceChange,
    todayPace,
    lastWeekPace,
    paceThroughHour,
    dataHours,
    latestHour,
    priorDayLabel:
      priorDaily === null ? "last week" : `last ${weekdayName(priorDaily.t)}`,
  };
}
