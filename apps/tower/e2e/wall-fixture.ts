// A synthetic, healthy six-site Wall for the Wall journeys and every Wall
// capture. The Wall's own read models need weeks of provider rows to draw a
// full site row, so the journeys answer /api/wall, /api/ga4/realtime and the
// source-health reads from here: the shapes are the Tower's payload types,
// the values are invented, and the sites are on the reserved `.example`
// domain. `WallFixtureVariant` is the same Wall at every site count the
// contract budgets for, and on fire.
import type {
  CalendarUpcoming, CredentialSummary, Ga4MinuteRow, Ga4RealtimeAsset, Ga4RealtimePayload, IntegrationHealthItem,
  IntegrationHealthPayload,
} from "@noticeos/contract";
import { ga4MinuteBuckets } from "@noticeos/contract";
import type {
  AssetCard, AttentionItem, CardDataSource, PortfolioBand, SeriesPoint, SystemBand, WallPayload, WorkSummary,
} from "@shared/wall";

/** 12:30 PM PT on a Tuesday; the journey fixes the browser clock here. */
export const WALL_FIXTURE_NOW = "2026-09-22T19:30:00.000Z";
/** The zone the fixture's hours and revenue days are in, and the browser's. */
export const WALL_FIXTURE_TIME_ZONE = "America/Los_Angeles";
const NOW = Date.parse(WALL_FIXTURE_NOW);
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const TODAY = "2026-09-22";
const TZ = WALL_FIXTURE_TIME_ZONE;

function days(values: number[]): SeriesPoint[] {
  const endMs = Date.parse(`${TODAY}T00:00:00.000Z`);
  return values.map((v, i) => ({ t: new Date(endMs - (values.length - 1 - i) * DAY).toISOString().slice(0, 10), v }));
}

/** Ninety days of a weekly-seasonal series, as the payload carries them: the
 * 28 the Wall draws and the 62 before them (`contextSeries`); the last point
 * is today, provisional. */
function trend(scale: number, seed: number): AssetCard["activeUsers"] {
  const values = Array.from({ length: 90 }, (_, k) => {
    const i = k - 55;
    const weekday = new Date(Date.parse(`${TODAY}T00:00:00.000Z`) - (89 - k) * DAY).getUTCDay();
    const wave = Math.sin((i + seed) / 3.1) * 0.12 + i * 0.006;
    return Math.max(1, Math.round(scale * (weekday === 0 || weekday === 6 ? 0.72 : 1) * (1 + wave)));
  });
  values[89] = Math.round(values[89]! * 0.55);
  const all = days(values);
  return { contextSeries: all.slice(0, 62), series: all.slice(62), provisionalFrom: TODAY, timeZoneChanges: [], collectedAt: iso(6 * MINUTE) };
}

function sources(overrides: Partial<Record<string, CardDataSource["state"]>> = {}): CardDataSource[] {
  const base: [string, string, CardDataSource["state"]][] = [
    ["nightly-report", "Nightly report", "live"], ["gsc", "Google Search Console", "live"],
    ["bing-webmaster", "Bing Webmaster Tools", "live"], ["ga4", "Google Analytics 4", "live"],
    ["clarity", "Microsoft Clarity", "skipped"], ["posthog", "PostHog", "needs-setup"],
    ["dataforseo", "DataForSEO", "live"], ["uptime", "Uptime", "needs-setup"],
  ];
  return base.map(([id, label, state]) => {
    const effective = overrides[id] ?? state;
    return effective === "live"
      ? { id, label, state: effective, observedAt: iso(20 * MINUTE), verification: { kind: "collection-success" as const, laneId: id } }
      : { id, label, state: effective };
  });
}

const work = (open: number, high: number, doing: number, blocked: number, closed: number, p: number[]): WorkSummary => ({
  open, highPriority: high, inProgress: doing, blocked, closedRecent: closed, priorities: p, capturedAt: iso(9 * MINUTE),
});
const ZERO = { currency: 'USD', revenue: 0, cost: 0, net: 0 };
const NO_TREND = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };

function card(id: string, displayName: string, extra: Partial<AssetCard>): AssetCard {
  return { netByMonthCurrency: 'USD',
    id, displayName, status: "live", senseOnly: false, worstSeverity: null, openError: 0, openWarn: 0,
    booked: ZERO, forecast: ZERO, netPeriod: "2026-09",
    pulseReceivedAt: iso(17 * HOUR), firstReportAt: iso(80 * DAY), reportDays: 28, dataSources: sources(),
    activeUsers: NO_TREND, searchClicks: NO_TREND, netByMonth: [], netByMonthProvisionalFrom: null,
    work: work(4, 1, 1, 0, 3, [0, 1, 2, 1, 0]),
    panelReview: null, latestPanelDate: null,
    ...extra,
  };
}

const projection = (projected: number, earned: number): NonNullable<AssetCard["revenueProjection"]> => ({
  period: "2026-09", status: "ready", reason: null, reportedThrough: "2026-09-21", earnedMinor: earned,
  projectedMinor: projected, dailyPaceMinor: Math.round((projected - earned) / 9), previousPeriod: "2026-08",
  previousMonthMinor: Math.round(projected * 0.86), changePercent: 16.3, historyDays: 84, holidayHistoryDays: 2,
  points: Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, cumulativeMinor: Math.round((projected / 30) * (i + 1)), projected: i >= 21 })),
});

const ASSETS: AssetCard[] = [
  card("plate.example", "Plate Planner", {
    counters: {
      heading: "All-time totals", cadenceHours: 0.25, defaultMetrics: ["accounts", "leads"],
      cards: [
        { metric: "accounts", label: "Accounts", value: 6267, observedAt: iso(8 * MINUTE), source: "counters" },
        { metric: "leads", label: "Leads", value: 1316, observedAt: iso(8 * MINUTE), source: "counters" },
        { metric: "plansSaved", label: "Plans saved", value: 41280, observedAt: iso(17 * HOUR), source: "nightly" },
      ],
    },
    worstSeverity: "warn", openWarn: 1, activeUsers: trend(1480, 1),
    dailyRevenue: { date: "2026-09-21", amountMinor: 4_318, reportedThrough: "2026-09-21", timeZone: TZ },
    revenueProjection: projection(131_000, 92_400), dataSources: sources({ posthog: "live", uptime: "live" }),
    work: work(176, 14, 4, 9, 58, [3, 11, 98, 47, 17]),
  }),
  card("menus.example", "Menu Finder", {
    counters: {
      heading: "Current catalog", cadenceHours: 0.25, defaultMetrics: ["itemsRated", "restaurants"],
      cards: [
        { metric: "itemsRated", label: "Items rated", value: 13904, observedAt: iso(6 * MINUTE), source: "counters" },
        { metric: "restaurants", label: "Restaurants", value: 1286, observedAt: iso(6 * MINUTE), source: "counters" },
      ],
    },
    activeUsers: trend(640, 4),
    dailyRevenue: { date: "2026-09-21", amountMinor: 1_207, reportedThrough: "2026-09-21", timeZone: TZ },
    revenueProjection: projection(38_500, 26_100), work: work(64, 5, 2, 3, 19, [1, 4, 33, 18, 8]),
  }),
  card("fitness.example", "Fitness Test", { activeUsers: trend(210, 7), work: work(12, 2, 1, 0, 4, [0, 2, 6, 3, 1]) }),
  card("areas.example", "Area Lookup", { activeUsers: trend(95, 2), work: work(9, 0, 1, 0, 2, [0, 0, 5, 3, 1]) }),
  card("rates.example", "Rate Codes", {
    senseOnly: true, activeUsers: trend(38, 5), dataSources: sources({ "bing-webmaster": "needs-setup" }),
    work: work(6, 1, 0, 0, 1, [0, 1, 3, 2, 0]),
  }),
  card("standards.example", "Standards", {
    status: "onboarding", pulseReceivedAt: null, firstReportAt: null, reportDays: 0,
    dataSources: sources({ "nightly-report": "needs-setup", gsc: "needs-setup", "bing-webmaster": "needs-setup", ga4: "needs-setup", dataforseo: "needs-setup" }),
    work: work(14, 4, 2, 1, 5, [1, 3, 6, 3, 1]),
  }),
];

const PORTFOLIO = { netTrendCurrency: 'USD', netTrendAllCurrency: 'USD',
  period: "2026-09", periodIsCurrent: true, booked: ZERO, forecast: { currency: 'USD', revenue: 1_184.5, cost: 96.4, net: 1_088.1 },
  netTrend: [612, 744, 803, 931].map((v, i) => ({ t: `2026-0${5 + i}`, v })),
  netTrendAll: [612, 744, 803, 931, 1088].map((v, i) => ({ t: `2026-0${5 + i}`, v })),
  trendGranularity: "monthly",
  // The longest comparison the band draws: "AUG ↑$128 VS JUL".
  bookedDelta: { currency: 'USD', value: 128, percent: 15.9, period: "2026-08", priorPeriod: "2026-07" },
  residue: { booked: ZERO, forecast: ZERO }, firstRun: false, daysIn: 22,
} as PortfolioBand;

const SYSTEM = {
  assetId: "root-os", hasPulse: true, spendTodayUsd: 0.41, dailyCapUsd: 0.83,
  ingest: { fresh: 5, stale: 0, notExpected: 2, expected: 5 },
  scheduledLanes: [{ job: "backup", outcome: "ran", startedAt: iso(3 * HOUR) }],
} as SystemBand;

const ATTENTION = [{
  id: 9001, asset: "plate.example", assetDisplayName: "Plate Planner", severity: "warn", kind: "anomaly",
  message: "19 in last24h (avg7d 58.2, P(<=19)~=0.0000)", firedAt: iso(2 * HOUR), metric: "plansSaved",
  ruleId: "flow-poisson-low", ruleInputs: { metric: "plansSaved", observed: 19, baselinePerDay: 58.2, alpha: 0.01, pLowerTail: 0.0000041 },
  correlatedChanges: [], occurrences: 1, firstFiredAt: iso(2 * HOUR),
}] as AttentionItem[];

/**
 * The Wall at every size the contract budgets for, all from the six sites above:
 *
 *   one, two, three  the first one, two or three sites (the focus and roomier tiers)
 *   six              the fixture as it is: healthy, one warning, one site still waiting
 *   seven, eight     the six plus invented seventh and eighth sites, the room test
 *   fire             the six with a site down, a failing source and an overdue report
 */
export type WallFixtureVariant = "one" | "two" | "three" | "six" | "seven" | "eight" | "fire";
export const WALL_FIXTURE_VARIANTS: readonly WallFixtureVariant[] = ["one", "two", "three", "six", "seven", "eight", "fire"];
const FIRST_SITES: Partial<Record<WallFixtureVariant, number>> = { one: 1, two: 2, three: 3 };

function scaledTrend(trend: AssetCard["activeUsers"], factor: number): AssetCard["activeUsers"] {
  const scale = (points: SeriesPoint[]) => points.map((p) => ({ t: p.t, v: Math.max(1, Math.round(p.v * factor)) }));
  return { ...trend, series: scale(trend.series), contextSeries: scale(trend.contextSeries ?? []) };
}

/** The sites past the fixture's six: the third site's shape, scaled down. */
function extraSites(variant: WallFixtureVariant): AssetCard[] {
  if (variant !== "seven" && variant !== "eight") return [];
  const template = ASSETS[2]!;
  const seventh: AssetCard = { ...template, id: "seventh.example", displayName: "Seventh Site", activeUsers: scaledTrend(template.activeUsers, 0.62) };
  const eighth: AssetCard = { ...seventh, id: "eighth.example", displayName: "Eighth Site", activeUsers: scaledTrend(template.activeUsers, 0.4) };
  return variant === "eight" ? [seventh, eighth] : [seventh];
}

/** `fire`: the second site's analytics collection failing, the fourth site's
 * home page down, the fifth site's nightly report 62 hours old. */
function onFire(): Pick<WallPayload, "assets" | "attention"> {
  const [, second, , fourth, fifth] = ASSETS as [AssetCard, AssetCard, AssetCard, AssetCard, AssetCard, AssetCard];
  const assets = ASSETS.map((asset): AssetCard => {
    if (asset.id === second.id) {
      return {
        ...asset,
        dataSources: asset.dataSources.map((s) =>
          s.id === "ga4" ? { ...s, state: "degraded", detail: "Collection failing", observedAt: iso(3 * HOUR) } : s,
        ),
      };
    }
    if (asset.id === fourth.id) return { ...asset, worstSeverity: "error", openError: 1 };
    if (asset.id === fifth.id) return { ...asset, worstSeverity: "warn", openWarn: 1, pulseReceivedAt: iso(62 * HOUR) };
    return asset;
  });
  const down = {
    id: 9002, asset: fourth.id, assetDisplayName: fourth.displayName, severity: "error", kind: "anomaly",
    message: `home page did not serve: https://${fourth.id}/ answered HTTP 503`, firedAt: iso(25 * MINUTE),
    metric: "home", ruleId: "hygiene-home-unreachable",
    ruleInputs: { url: `https://${fourth.id}/`, http_status: 503, evaluatedAt: iso(25 * MINUTE) },
    correlatedChanges: [], occurrences: 1, firstFiredAt: iso(25 * MINUTE),
  } as unknown as AttentionItem;
  const stale = {
    id: 9003, asset: fifth.id, assetDisplayName: fifth.displayName, severity: "warn", kind: "anomaly",
    message: "no pulse for 62h", firedAt: iso(14 * HOUR), metric: "pulse", ruleId: "ingest-freshness",
    ruleInputs: { rule: "ingest-freshness", state: "stale", lastReceivedAt: iso(62 * HOUR), ageHours: 62, thresholdHours: 48 },
    correlatedChanges: [], occurrences: 1, firstFiredAt: iso(14 * HOUR),
  } as unknown as AttentionItem;
  return { assets, attention: [down, ...ATTENTION, stale] };
}

export function wallFixturePayload(variant: WallFixtureVariant = "six"): WallPayload {
  const base = {
    generatedAt: iso(40_000), portfolio: PORTFOLIO, system: SYSTEM,
    dashboard: { countdown: { emoji: "🌁", label: "SF Trip", targetAt: new Date(NOW + 12 * DAY).toISOString() } },
    assets: ASSETS, attention: ATTENTION, snoozed: [],
    operator: { waiting: 4, urgent: 1, measuredProjects: 6, urgentMeasuredProjects: 6, projectCount: 6, capturedAt: iso(9 * MINUTE) },
    ledgerRecordedAt: iso(2 * DAY),
  } as WallPayload;
  const first = FIRST_SITES[variant];
  if (first) {
    const assets = ASSETS.slice(0, first);
    const ids = new Set(assets.map((asset) => asset.id));
    return { ...base, assets, attention: ATTENTION.filter((item) => ids.has(item.asset)) };
  }
  if (variant === "fire") return { ...base, ...onFire() };
  return { ...base, assets: [...ASSETS, ...extraSites(variant)] };
}

function hourly(scale: number): NonNullable<Extract<Ga4RealtimeAsset, { status: "success" }>["hourlyActiveUsers"]> {
  const shape = [0.3, 0.2, 0.15, 0.12, 0.14, 0.25, 0.45, 0.7, 0.85, 1, 1.05, 1.1, 1.08, 1.02, 0.98, 0.95, 0.9, 0.88, 0.85, 0.8, 0.7, 0.6, 0.48, 0.38];
  return shape.map((f, hour) => ({ hour, today: hour <= 12 ? Math.round(scale * f * 1.07) : null, sameDayLastWeek: Math.round(scale * f) }));
}

/** A site's last 30 minutes as GA4 sends them, newest first, quiet minutes
 * left out, for the minute pulse. */
function minuteRows(scale: number): Ga4MinuteRow[] {
  return Array.from({ length: 30 }, (_, minutesAgo) => ({
    minutesAgo,
    activeUsers: Math.max(0, Math.round((scale / 12) * (1 + Math.sin(minutesAgo / 2.3) * 0.35 - minutesAgo * 0.01))),
  })).filter((row) => row.activeUsers > 0);
}

/** Every site reading live, except the first site's reading is `staleMinutes`
 * old. The variants read what their Wall draws: fewer sites, the extra sites
 * at the third site's hours scaled down, or the fourth site down since noon
 * (`fire`). */
export function wallFixtureRealtime(staleMinutes = 20, variant: WallFixtureVariant = "six"): Ga4RealtimePayload {
  const scales: Record<string, number> = { "plate.example": 150, "menus.example": 64, "fitness.example": 22, "areas.example": 10, "rates.example": 5 };
  const readAt = (asset: string) => NOW - (asset === "plate.example" ? staleMinutes * MINUTE : 12_000);
  const base: Ga4RealtimePayload = {
    generatedAt: iso(12_000), monitoringAvailable: true,
    assets: Object.entries(scales).map(([asset, scale]) => ({
      asset, status: "success", activeUsers5m: Math.max(1, Math.round(scale / 9)), activeUsers30m: Math.max(2, Math.round(scale / 3)),
      // Placed by the product's one derivation, served now: a stale reading's
      // newest minutes are unread.
      activeUsersByMinute: ga4MinuteBuckets(minuteRows(scale), readAt(asset), NOW - 12_000),
      observedAt: new Date(readAt(asset)).toISOString(),
      hourlyActiveUsers: hourly(scale), timeZone: TZ, errorCode: null,
    })),
  };
  const first = FIRST_SITES[variant];
  if (first) return { ...base, assets: base.assets.slice(0, first) };
  if (variant === "seven" || variant === "eight") {
    const template = base.assets.find((a) => a.asset === ASSETS[2]!.id)!;
    if (template.status !== "success") return base;
    const copy = (asset: string, factor: number) => {
      const scale = (n: number | null) => (n === null ? null : Math.max(0, Math.round(n * factor)));
      return {
        ...template,
        asset,
        activeUsers5m: Math.max(1, Math.round(template.activeUsers5m * factor)),
        activeUsers30m: Math.max(1, Math.round(template.activeUsers30m * factor)),
        activeUsersByMinute: template.activeUsersByMinute?.map(scale) ?? null,
        hourlyActiveUsers: template.hourlyActiveUsers?.map((h) => ({ hour: h.hour, today: scale(h.today), sameDayLastWeek: scale(h.sameDayLastWeek) ?? 0 })) ?? null,
      };
    };
    const extra = extraSites(variant).map((site, index) => copy(site.id, index === 0 ? 0.62 : 0.4));
    return { ...base, assets: [...base.assets, ...extra] };
  }
  if (variant === "fire") {
    return {
      ...base,
      assets: base.assets.map((a) => {
        if (a.asset !== ASSETS[3]!.id || a.status !== "success") return a;
        // The site went down at noon: the current hour and the live count fall to zero.
        return {
          ...a, activeUsers5m: 0, activeUsers30m: 0,
          activeUsersByMinute: a.activeUsersByMinute?.map((minute) => (minute === null ? null : 0)) ?? null,
          hourlyActiveUsers: a.hourlyActiveUsers?.map((h) => (h.hour === 12 ? { ...h, today: 1 } : h)) ?? null,
        };
      }),
    };
  }
  return base;
}

/** The sites whose analytics collection the fixture monitors: every site
 * that reports, the extra sites included. */
const MONITORED = [...ASSETS.filter((asset) => asset.pulseReceivedAt !== null).map((asset) => asset.id), "seventh.example", "eighth.example"];

/** GA4's daily collection for every site that reports, plus `extra` sites a
 * capture adds; in `fire`, the second site's has been failing since a success
 * three hours ago — the one source the strip counts as failing. */
export function wallFixtureHealth(variant: WallFixtureVariant = "six", extra: readonly string[] = []): IntegrationHealthPayload {
  const items: IntegrationHealthItem[] = [...MONITORED, ...extra].map((asset) => {
    const failing = variant === "fire" && asset === ASSETS[1]!.id;
    return {
      id: `ga4-daily-${asset}`, provider: "google", capability: "ga4-daily", label: "Analytics daily reports", asset, detail: null, report: null, reportDate: null,
      state: failing ? "failing" : "healthy", lastAttemptAt: iso(HOUR / 4), lastSuccessAt: failing ? iso(3 * HOUR) : iso(HOUR / 4),
      nextAttemptAt: null, failure: failing ? "access" : null, code: failing ? "access" : null,
      action: "Review.", cadence: "Every 15 minutes", coverage: "monitored",
    };
  });
  return { generatedAt: iso(10_000), available: true, items, events: [] };
}

/** The Google credential the analytics sources run on, so a source reads its
 * own status rather than Unknown. */
export function wallFixtureProviders() {
  const google: CredentialSummary = {
    provider: "google", source: "store", fields: ["GOOGLE_OAUTH_REFRESH_TOKEN"], assetsHeld: [], missingFields: [], auth: null,
    metadata: null, keyVersion: 1, createdAt: iso(40 * DAY), updatedAt: iso(40 * DAY),
    lastUsedAt: iso(HOUR / 4), lastOkAt: iso(HOUR / 4), lastError: null,
  };
  return {
    generatedAt: new Date(NOW).toISOString(), keyPresent: true, keyReason: null,
    providers: [{ provider: { id: "google" }, credential: google }],
  };
}

export function wallFixtureCalendar(): CalendarUpcoming {
  return {
    monitoringAvailable: true, fetchedAt: iso(MINUTE), feedsConfigured: 1, feedsOk: 1,
    calendars: [{ id: "work", color: null, status: "ok" }],
    meetings: [{ calendar: "work", title: "Partner sync", startsAt: new Date(NOW + 2.5 * HOUR).toISOString(), endsAt: new Date(NOW + 3 * HOUR).toISOString(), allDay: false, location: null }],
  } as CalendarUpcoming;
}
