// The Wall's site region as numbers (docs/14-design.md § Site rows and
// § Density, beads `ro-trai.5`, `ro-trai.13`). `SiteRows` draws; this file only
// reads the payload the Worker already built — nothing here is a new source.
//
// ONE SITE IS SHOWN IN DEPTH. With a single site the region becomes three tiles
// (today by hour, the month's visitors and money, search clicks), each read from
// data every site already carries: the GA4 realtime snapshot's hours, the Wall
// payload's `activeUsers` / `searchClicks` series, and the revenue projection's
// running total. A tile whose data this site does not have is `null` — the
// region leaves it out and the others widen, never an empty placeholder.

import type { Ga4RealtimeAsset } from "@noticeos/contract";
import { revenueCalendarDate, type DailyRevenueSummary } from "@shared/daily-revenue";
import type { RevenueProjection } from "@shared/revenue-projection";
import {
  distortedByTimeZoneChange,
  windowSpansTimeZoneChange,
  type AssetCard,
  type SeriesPoint,
  type SignalTrend,
} from "@shared/wall";
import { intradayUsersPace, type IntradayUsersPace } from "@/lib/intraday-pace";
import { performanceTone, type PerformanceTone } from "@/components/DeltaChip";
import { rollingDailyAverage, rollingWeeklyChange, shiftDate, spannedTimeZoneChange } from "@/lib/series";

export type HourlyActiveUsers = NonNullable<Extract<Ga4RealtimeAsset, { status: "success" }>["hourlyActiveUsers"]>;

/** The latest complete 7 days against the 7 before, as a percent and the tone
 * it may wear: neutral when the window spans a reporting-timezone change
 * (doc 14, `ro-jkp2`) — the number stays, only the verdict goes. */
export interface WeeklyChange {
  percent: number;
  tone: PerformanceTone;
}

export function weeklyChange(trend: SignalTrend): WeeklyChange | null {
  const percent = rollingWeeklyChange(
    rollingDailyAverage([...(trend.contextSeries ?? []), ...trend.series], 7, trend.provisionalFrom),
  );
  if (percent === null) return null;
  return { percent, tone: spannedTimeZoneChange(trend) ? "neutral" : performanceTone(percent) };
}

/** The days a provider has finished counting: the day still filling left out. */
export function completeDays(trend: SignalTrend): SeriesPoint[] {
  return trend.series.filter((point) => trend.provisionalFrom === null || point.t < trend.provisionalFrom);
}

/** Four weeks: a site row's line, the search tile's window, and each of the
 * two spans their % compares. Weekday to weekday: 28 days back is the same
 * day of the week. */
export const FOUR_WEEKS = 28;

/** One day of the four weeks a line draws, beside the same weekday four weeks
 * earlier. `null` is a day the provider reported nothing — never a zero. */
export interface FourWeekDay {
  date: string;
  value: number | null;
  prior: number | null;
}

/**
 * The last four complete weeks against the four before (bead `ro-trai.26`,
 * docs/14-design.md § Site rows): the one derivation a site row's line and
 * the one-site search tile both draw.
 *
 * - `days` are the 28 days ending on the newest day the provider has finished
 *   counting — the day still being counted is left out, as everywhere.
 * - `hasPrior` is true only when all 28 earlier days were reported; otherwise
 *   the dashed line is left out rather than drawn from part of a span.
 * - `change` compares the two spans' totals, and exists only when both are
 *   whole and the earlier one is not zero: never a fake 0. It is neutral when
 *   the 56 days span a reporting-timezone change (`ro-jkp2`, doc 14): the
 *   number stays, only the verdict goes.
 */
export interface FourWeeks {
  days: FourWeekDay[];
  hasPrior: boolean;
  change: WeeklyChange | null;
}

export function fourWeeks(trend: SignalTrend): FourWeeks | null {
  const finished = [...(trend.contextSeries ?? []), ...trend.series].filter(
    (point) => CALENDAR_DAY.test(point.t) && (trend.provisionalFrom === null || point.t < trend.provisionalFrom),
  );
  const end = finished.at(-1)?.t;
  if (end === undefined) return null;
  const value = new Map(finished.map((point) => [point.t, point.v]));
  const days = Array.from({ length: FOUR_WEEKS }, (_, index) => {
    const date = shiftDate(end, index - (FOUR_WEEKS - 1));
    return { date, value: value.get(date) ?? null, prior: value.get(shiftDate(date, -FOUR_WEEKS)) ?? null };
  });
  const hasPrior = days.every((day) => day.prior !== null);
  const whole = hasPrior && days.every((day) => day.value !== null);
  const now = days.reduce((sum, day) => sum + (day.value ?? 0), 0);
  const before = days.reduce((sum, day) => sum + (day.prior ?? 0), 0);
  const percent = whole && before > 0 ? ((now - before) / before) * 100 : null;
  const spansMove = windowSpansTimeZoneChange(trend.timeZoneChanges, {
    start: shiftDate(end, -(2 * FOUR_WEEKS - 1)),
    end,
  });
  return {
    days,
    hasPrior,
    change: percent === null ? null : { percent, tone: spansMove ? "neutral" : performanceTone(percent) },
  };
}

/**
 * Each reported day's own revenue, in dollars, keyed by date: the difference of
 * a ready projection's running total from one reported day to the next, plus
 * yesterday's saved estimate when the projection does not reach it. A projected
 * day is never money, and a day with no report is absent, never zero.
 */
export function revenueByDay(
  projection: RevenueProjection | undefined,
  yesterday: DailyRevenueSummary | undefined,
): Map<string, number> {
  const days = new Map<string, number>();
  let runningMinor = 0;
  for (const point of projection?.points ?? []) {
    if (point.projected) break;
    days.set(point.date, (point.cumulativeMinor - runningMinor) / 100);
    runningMinor = point.cumulativeMinor;
  }
  if (yesterday && yesterday.amountMinor !== null && !days.has(yesterday.date)) {
    days.set(yesterday.date, yesterday.amountMinor / 100);
  }
  return days;
}

/** Today by hour against the same weekday last week, with the live count's
 * snapshot, the pace, and today's users when the daily series has today. */
export interface TodayTile {
  snapshot: Extract<Ga4RealtimeAsset, { status: "success" }>;
  hourly: HourlyActiveUsers;
  pace: IntradayUsersPace | null;
  /** Today's distinct users from the daily series — never a sum of hours,
   * which counts a person once per hour (doc 14). */
  todayUsers: number | null;
}

export interface VisitorsDay {
  date: string;
  /** Day of the month, 1-based. */
  day: number;
  visitors: number | null;
  /** Still being counted: drawn dimmed. */
  provisional: boolean;
  revenue: number | null;
}

/** The month's visitors as bars and its money per day as a line. */
export interface VisitorsTile {
  /** 'YYYY-MM'. */
  period: string;
  /** Every day of the month from the 1st through the newest day with data. */
  days: VisitorsDay[];
  hasMoney: boolean;
  /** Dollars per 1,000 visitors on the newest day with both a revenue report
   * and a finished visitor count. */
  perThousand: { date: string; value: number } | null;
  /** The newest finished day's visitors. */
  latest: SeriesPoint | null;
  change: WeeklyChange | null;
}

/** The last four weeks of search clicks (Google and Bing read as one) over
 * the four before, as a site row's line (`fourWeeks`). */
export interface SearchTile {
  weeks: FourWeeks;
  /** The newest finished day with clicks. */
  latest: SeriesPoint;
}

export interface FocusTiles {
  today: TodayTile | null;
  visitors: VisitorsTile | null;
  search: SearchTile | null;
}

/** Hourly buckets belong to the saved clock's date when they were observed.
 * A retained prior-day snapshot cannot supply a chart labelled Today. */
export function currentHourlyReading(
  snapshot: Ga4RealtimeAsset | undefined,
  nowMs: number,
): Extract<Ga4RealtimeAsset, { status: "success" }> | null {
  if (snapshot?.status !== "success" || !snapshot.hourlyActiveUsers?.some((hour) => hour.today !== null)) return null;
  try {
    const observed = new Date(snapshot.hourlyObservedAt ?? snapshot.observedAt);
    return revenueCalendarDate(observed, snapshot.timeZone) === revenueCalendarDate(new Date(nowMs), snapshot.timeZone)
      ? snapshot : null;
  } catch {
    return null;
  }
}

/** An actual finished daily GA4 observation, never a filled gap or a total of
 * hourly users. The date remains the provider's stored calendar date. */
export function latestFinishedUsers(trend: SignalTrend): SeriesPoint | null {
  return completeDays(trend).filter((point) => {
    if (!CALENDAR_DAY.test(point.t) || !Number.isFinite(point.v) || point.v < 0) return false;
    const date = new Date(`${point.t}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === point.t;
  }).sort((a, b) => a.t.localeCompare(b.t)).at(-1) ?? null;
}

export function todayTile(asset: AssetCard, snapshot: Ga4RealtimeAsset | undefined, nowMs: number): TodayTile | null {
  snapshot = currentHourlyReading(snapshot, nowMs) ?? undefined;
  if (snapshot?.status !== "success" || snapshot.hourlyActiveUsers === null) return null;
  const pace = intradayUsersPace(asset, snapshot);
  // The daily series' newest point is today only while the operator's clock
  // (the zone the hours were bucketed in) is still on that date.
  let today: string | null = null;
  try {
    today = revenueCalendarDate(new Date(nowMs), snapshot.timeZone);
  } catch {
    today = null;
  }
  const todayUsers = pace !== null && pace.today !== null && pace.todayDate === today ? pace.today : null;
  return { snapshot, hourly: snapshot.hourlyActiveUsers, pace, todayUsers };
}

function daysInMonth(period: string): number {
  return new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).getUTCDate();
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function visitorsTile(asset: AssetCard): VisitorsTile | null {
  const users = asset.activeUsers;
  const revenue = revenueByDay(asset.revenueProjection, asset.dailyRevenue);
  const period =
    asset.revenueProjection?.period ?? users.series.filter((point) => CALENDAR_DAY.test(point.t)).at(-1)?.t.slice(0, 7);
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return null;

  const inPeriod = (date: string) => CALENDAR_DAY.test(date) && date.startsWith(period);
  const visitors = new Map(users.series.filter((point) => inPeriod(point.t)).map((point) => [point.t, point.v]));
  const inMonth = [...visitors.keys(), ...[...revenue.keys()].filter(inPeriod)];
  if (inMonth.length === 0) return null;
  const through = Math.min(daysInMonth(period), Math.max(...inMonth.map((date) => Number(date.slice(8, 10)))));
  const days: VisitorsDay[] = Array.from({ length: through }, (_, index) => {
    const date = `${period}-${String(index + 1).padStart(2, "0")}`;
    return {
      date,
      day: index + 1,
      visitors: visitors.get(date) ?? null,
      provisional: users.provisionalFrom !== null && date >= users.provisionalFrom,
      revenue: revenue.get(date) ?? null,
    };
  });

  // Revenue per 1,000 visitors: a like-for-like day only — the report and a
  // finished count, on a day a reporting-timezone move did not distort.
  const finished = new Map(
    [...(users.contextSeries ?? []), ...completeDays(users)]
      .filter((point) => point.v > 0 && distortedByTimeZoneChange(users.timeZoneChanges, point.t) === null)
      .map((point) => [point.t, point.v]),
  );
  const rateDate = [...revenue.keys()].filter((date) => finished.has(date)).sort().at(-1);
  const perThousand =
    rateDate === undefined ? null : { date: rateDate, value: (revenue.get(rateDate)! / finished.get(rateDate)!) * 1000 };

  return {
    period,
    days,
    hasMoney: days.some((day) => day.revenue !== null),
    perThousand,
    latest: completeDays(users).at(-1) ?? null,
    change: weeklyChange(users),
  };
}

export function searchTile(asset: AssetCard): SearchTile | null {
  const weeks = fourWeeks(asset.searchClicks);
  const reported = weeks?.days.filter((day) => day.value !== null) ?? [];
  if (!weeks || reported.length < 2) return null;
  const latest = reported.at(-1)!;
  return { weeks, latest: { t: latest.date, v: latest.value! } };
}

/** What one site can show in depth; every tile is `null` when its data is
 * absent for this site. */
export function focusTiles(asset: AssetCard, snapshot: Ga4RealtimeAsset | undefined, nowMs: number): FocusTiles {
  return { today: todayTile(asset, snapshot, nowMs), visitors: visitorsTile(asset), search: searchTile(asset) };
}
