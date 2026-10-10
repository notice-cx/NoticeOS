/** Cross-Worker contract for the on-demand GA4 realtime read.
 *
 * The ingest Worker owns the Google credential and returns one result per
 * configured GA4 property through a private Service Binding. The Tower proxies
 * this plain-data shape to the browser; no credential or provider response
 * leaves ingest.
 */
interface Ga4RealtimeAssetBase {
  asset: string;
  /** When this provider attempt started. Values are one snapshot at this time. */
  observedAt: string;
  /** The next allowed provider attempt after a failed read; not a promised recovery time. */
  nextAttemptAt?: string;
}

export type Ga4RateLimit = 'daily-tokens' | 'daily-requests' | 'hourly-tokens' | 'project-hourly-tokens' | 'concurrency' | 'server-errors' | 'requests-per-minute' | 'requests-per-second' | 'unspecified';

/** One OS-timezone hour in today's intraday pace comparison. */
export interface Ga4HourlyActiveUsers {
  /**
   * 0–23 on the operator's clock — the snapshot's `timeZone`. GA4 reports in
   * the property's own timezone; ingest re-buckets, so an Eastern property's
   * 9 AM lands at hour 6 for an operator on Pacific time.
   */
  hour: number;
  /**
   * Distinct active users whose activity fell in this hour today. `null`
   * means the hour has not been reported yet; it is never a forecast zero.
   */
  today: number | null;
  /** The same clock hour on the same weekday one week earlier. */
  sameDayLastWeek: number;
}

/** How many minutes a live pulse spans: GA4's standard realtime window, the
 * one `activeUsers30m` counts. */
export const GA4_PULSE_MINUTES = 30;

/** How many of the pulse's newest minutes are drawn bright: the window
 * `activeUsers5m` counts. */
export const GA4_PULSE_RECENT_MINUTES = 5;

/** One row of GA4's per-minute realtime report (`minutesAgo` dimension). */
export interface Ga4MinuteRow {
  /** 0 is the minute the reading was taken in, 29 the oldest it covers. */
  minutesAgo: number;
  /** Distinct users active in that minute. Not additive across minutes: a
   * person active in two minutes is in both. */
  activeUsers: number;
}

/**
 * The one derivation from GA4's per-minute rows to a live pulse: the
 * {@link GA4_PULSE_MINUTES} clock minutes ending with the minute `asOfMs`
 * falls in, oldest first.
 *
 * GA4 returns no row for a minute nobody was active in, so a minute the reading
 * covers without a row is `0`. A minute the reading does NOT cover — after the
 * minute it was taken in (a reading served later than it was read), or before
 * its 30 minutes — was never reported, so it is `null`: absent, never a zero.
 */
export function ga4MinuteBuckets(
  rows: readonly Ga4MinuteRow[],
  readAtMs: number,
  asOfMs: number,
): (number | null)[] {
  const byMinute = new Map(rows.map((row) => [row.minutesAgo, row.activeUsers]));
  const readMinute = Math.floor(readAtMs / 60_000);
  const lastMinute = Math.floor(asOfMs / 60_000);
  return Array.from({ length: GA4_PULSE_MINUTES }, (_, index) => {
    const minutesAgo = readMinute - (lastMinute - (GA4_PULSE_MINUTES - 1 - index));
    if (minutesAgo < 0 || minutesAgo >= GA4_PULSE_MINUTES) return null;
    return byMinute.get(minutesAgo) ?? 0;
  });
}

/** One GA4 token bucket as the Data API reports it. A field the provider
 * omitted stays `null`; it is never read as a zero. */
export interface Ga4QuotaStatus {
  consumed: number | null;
  remaining: number | null;
}

/** The token buckets returned for a property when a request asks for its
 * quota. Only the two that bound this collector's cadence are kept. */
export interface Ga4PropertyQuota {
  tokensPerDay: Ga4QuotaStatus | null;
  tokensPerHour: Ga4QuotaStatus | null;
}

/**
 * Realtime and Core requests draw on separate GA4 budgets, so each request's
 * quota is reported against its own pool. The two are never summed.
 */
export interface Ga4RealtimeQuota {
  /**
   * From the two `runRealtimeReport` calls behind the 5/30-minute windows and
   * the minute pulse, read together: `consumed` is what both cost (unknown
   * unless both said), `remaining` the lower of the two reports.
   */
  realtime: Ga4PropertyQuota | null;
  /** From the Core `runReport` call behind the hourly pace comparison. */
  core: Ga4PropertyQuota | null;
}

export interface Ga4RealtimeSuccess extends Ga4RealtimeAssetBase {
  status: 'success';
  /** Distinct active users observed in the inclusive 0–4 minute window. */
  activeUsers5m: number;
  /** Distinct active users observed in the inclusive 0–29 minute window. */
  activeUsers30m: number;
  /**
   * The minute pulse: {@link GA4_PULSE_MINUTES} buckets, oldest first, ending
   * with the minute this snapshot was served in —
   * {@link ga4MinuteBuckets} over the per-minute rows read with the windows
   * above. `0` is a minute nobody was active; `null` a minute the reading did
   * not cover. Absent or `null` as a whole when the per-minute read failed
   * (the windows still stand) or the ingest predates the pulse.
   */
  activeUsersByMinute?: (number | null)[] | null;
  /**
   * One full day on the operator's clock (`timeZone`). Last week's line has
   * all 24 hours; today's future hours are null so the current line stops at
   * the newest observed bucket. These values are not additive DAU totals: a
   * person active in two hours can appear in both.
   */
  hourlyActiveUsers: Ga4HourlyActiveUsers[] | null;
  /**
   * The operator's clock the hours above were bucketed in: the saved
   * `os_time_zone` when this read ran. A chart labels its axis with this
   * rather than with a zone of its own.
   */
  timeZone: string;
  /** Hourly Core reports fail independently of working realtime counts. */
  hourlyErrorCode?: string | null;
  hourlyObservedAt?: string;
  hourlyNextAttemptAt?: string;
  /**
   * What this snapshot cost against the property's GA4 budgets. Optional: a
   * consumer that does not care about cadence headroom ignores it, and a
   * provider response without quota leaves it `null`.
   */
  quota?: Ga4RealtimeQuota | null;
  errorCode: null;
}

export interface Ga4RealtimeFailure extends Ga4RealtimeAssetBase {
  status: 'error';
  activeUsers5m: null;
  activeUsers30m: null;
  hourlyActiveUsers: null;
  /** Stable internal/provider error code; never a credential or raw response. */
  errorCode: string;
  rateLimit?: Ga4RateLimit;
}

export type Ga4RealtimeAsset = Ga4RealtimeSuccess | Ga4RealtimeFailure;

export interface Ga4RealtimePayload {
  /** False when usable data could not be recorded in operational health. */
  monitoringAvailable?: boolean;
  /** When ingest finished assembling the portfolio snapshot. */
  generatedAt: string;
  /** Configured GA4 properties only, in credential-map order. */
  assets: Ga4RealtimeAsset[];
}
