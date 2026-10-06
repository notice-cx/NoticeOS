// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PulseEnvelope, REPORT_MAX_AGE_HOURS, isAllFresh } from "@noticeos/contract";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { beforeEach, describe, expect, it } from "vitest";
import { type AssetDetailDeps, buildAssetDetailPayload } from "../worker/asset-detail-payload";
import { loadLatestBeadsSnapshot } from "../worker/beads-snapshot";
import { LATEST_COUNTER_TOTALS_SQL, type CounterReading, type CountersConfig, resolveCounterCards, resolveWallCounters } from "../worker/counters";
import type { IntegrationsConfig } from "../shared/integrations";
import { isAmber } from "../shared/freshness";
import {
  AMBER_MULTIPLIER,
  CADENCE_HOURS,
  type PanelReview,
  cardHasMoney,
  figureHasMoney,
  panelReviewState,
  portfolioHasData,
} from "../shared/wall";
import { loadDataForSeoSpend } from "../worker/metered-spend";
import { PANEL_LANDING_WINDOW_DAYS, loadLatestPanelLandings } from "../worker/panel-review";
import { loadSignalTrends, timeZoneChangesSql } from "../worker/signal-trends";
import { WALL_CHANGES_SQL, buildWallPayload } from "../worker/wall-payload";
import { handleAlertHistoryRequest } from "../worker/alert-history";
import { PULSE_COVERAGE_SQL, readPulseCoverage } from "../worker/pulse-history";
import { type AlertRow, type ReportRow, storeAlert, storeAlerts, storeReading, storeReport, storeReports } from "./alert-rows";
import { writeSignalRun, writeSignalValues } from "./collected-metrics";
import { type TestStore, createTestStore, recordingStore } from "./postgres-store";
import { storeChange, storeWatchWindow } from "./change-rows";

import { writeArchiveRun, writeResearch } from "./provider-reports";
import { bookLedger } from "./money";
import { addSites } from "./sites";
import {
  insertDataForSeoCollection,
  insertPanelRun,
  panelReviewBead,
  seedSnapshot,
  workCounts,
  workProject,
} from "./panel-fixtures";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-07-05T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;
const CONSTANTS = { dataUsd: 25 };

// config/counters.json's two shapes: a fast-lane asset (meals, with a
// scrape source) and a fallback-only one (nom, no source — its totals come from
// its own nightly report). pacer declares nothing, so it gets none.
const COUNTERS: CountersConfig = {
  assets: {
    "meals.example": {
      source: { kind: "prometheus", url: "https://meals.example/api/internal/metrics", enabled: true },
      cards: [
        { metric: "signups", counter: "profiles", label: "Accounts" },
        { metric: "plansSaved", counter: "saved", label: "Plans saved" },
        { metric: "leads", counter: "leads", label: "Leads" },
      ],
    },
    "nosh.example": {
      heading: "Current catalog",
      cards: [{ metric: "items", label: "Items" }],
    },
    // An entry stubbed before anyone chose its totals — still nothing to render.
    "root-os": { cards: [] },
  },
};

const INTEGRATIONS: IntegrationsConfig = {
  catalog: [
    {
      id: "gsc",
      label: "Google Search Console",
      docRef: "docs/11-integrations.md",
    },
    {
      id: "ga4",
      label: "Google Analytics 4",
      docRef: "docs/11-integrations.md",
    },
    {
      id: "bing-webmaster",
      label: "Bing Webmaster",
      docRef: "docs/11-integrations.md",
    },
  ],
  assets: {
    "meals.example": {
      gsc: { status: "live", note: "collector live", since: "2026-07-05" },
      ga4: { status: "live", note: "collector live", since: "2026-07-05" },
      "bing-webmaster": { status: "live", note: "collector live", since: "2026-07-05" },
    },
  },
};
// config/serp-panel.json's real shape: a MINORITY of assets buy a tracked
// panel (meals.example since 2026-07, nosh.example since 2026-08-03). This fixture
// names one, so every other card here is an asset that owes the SAME weekly
// read in the other noun — signal collection, never SERP panel (bead ro-z0g).
// Membership stopped gating the marker at ro-1tu; it picks the words only.
const SERP_PANEL = { assets: { "meals.example": { queries: ["meals"] } } };
const PANEL_ASSETS = new Set(Object.keys(SERP_PANEL.assets));

/** The operator's clock these fixtures are written on (bead `ro-ujb9.88`).
 * UTC, because the month-boundary cases below say "half an hour into August"
 * of 00:30Z; the saved-zone behaviour itself is pinned by
 * test/saved-time-zone.test.ts. */
const OS_TIME_ZONE = "UTC";

const OPTIONS = {
  now: NOW,
  osTimeZone: OS_TIME_ZONE,
  constants: CONSTANTS,
  integrations: INTEGRATIONS,
  serpPanel: SERP_PANEL,
  pullConfig: [],
  counters: COUNTERS,
  dashboard: {
    countdown: {
      emoji: "🌁",
      label: "SF Trip - August 2026",
      targetAt: "2026-08-01T07:00:00.000Z",
    },
  },
};

/** The asset page's own inputs, so one test can read the SAME ledger rows
 * through both payloads and hold the two to the same cents. */
const DETAIL_DEPS: AssetDetailDeps = {
  now: NOW,
  flagDefaults: { alpha: 0.01, min_baseline_per_day: 3, low_volume_window_hours: 72 },
  pullConfig: [],
  monthlyCaps: CONSTANTS,
  operatorRateUsdPerMin: 2,
  integrations: INTEGRATIONS,
  counters: COUNTERS,
  // The same file the Wall reads, so a card and the page it links to are gated
  // on one key set rather than two copies of it (bead ro-elf).
  serpPanel: SERP_PANEL,
  // Only the asset page reads this one, and only to say what a delete removes.
  signalPanels: { assets: {} },
  // The GA4 declarations only the asset page's Sources tab reads — nothing this
  // file asserts touches them.
  valueEvents: { assets: {} },
  ga4EventParams: { assets: {} },
  // Nobody has said who owns these assets, and nothing this file asserts turns
  // on it.
  osTimeZone: OS_TIME_ZONE,
};

const OS_RECEIVED = new Date(NOW_MS - 3 * HOUR).toISOString();
const MEALS_RECEIVED = new Date(NOW_MS - 4 * HOUR).toISOString();
const NOM_RECEIVED = new Date(NOW_MS - 3 * DAY).toISOString();

/** A site in both of the test's stores (test/sites.ts): the Wall reads the
 * site list on Postgres and joins D1's copy of it. */
async function insertAsset(
  raw: TestStore,
  id: string,
  name: string,
  status: string,
  senseOnly: number,
  isOs: number,
) {
  // Each site is added a second after the store's last one, as sites added
  // through the product are. The cards keep the order the fixture adds them in
  // because each new site takes the next place in the list (`SITE_ORDER`).
  const createdAt = new Date(Date.parse("2026-07-01T00:00:00.000Z") + ((await raw.call.read((tx) => tx.query<{ n: number }>("SELECT count(*)::int AS n FROM noticeos.assets")))[0]!.n + 1) * 1000).toISOString();
  await addSites(raw, [{ id, domain: `${id}.example`, displayName: name, status, senseOnly, isOs, createdAt }]);
}

type ReportMetrics = Record<string, { last24h: number; avg7d?: number; total?: number }>;

/** One nightly report as the store holds it (bead ro-ujb9.76.5.2): a second one
 * for a site's day is that day's newest revision, which replaces it. */
function report(asset: string, date: string, receivedAt: string, metrics: ReportMetrics, capabilities?: string[]): ReportRow {
  return { asset, date, receivedAt, capabilities: capabilities ?? null, envelope: capabilities ? { capabilities, metrics } : { metrics } };
}

/** A nightly report, on Postgres in the test's copy of its sites: the site's
 * row must be added first, and a copy written to serves no other test. */
async function insertPulse(
  ctx: TestStore,
  asset: string,
  date: string,
  receivedAt: string,
  metrics: ReportMetrics,
  capabilities?: string[],
) {
  await storeReport(ctx.call, report(asset, date, receivedAt, metrics, capabilities));
}

interface LedgerRow {
  id: number;
  kind: "revenue" | "cost";
  asset: string;
  period: string;
  family: string;
  /** DOLLARS, for readable fixtures — the store never sees this number. It is
   * rounded to exact cents on the way in, which is all `/api/revenue` writes. */
  amount: number;
  booking_state: "estimated" | "reconciled";
  supersedes_id?: number | null;
  recorded_at: string;
}

/** Writes `amount_minor` and nothing else, exactly as `/api/revenue` does since
 * db/0020 dropped the `amount REAL` mirror — a fixture still filling a column
 * the store no longer has would test a shape no writer produces. On Postgres
 * (bead ro-ujb9.76.6.1), in the test's own copy of its sites (test/money.ts):
 * the sites must be added first, and a copy written to serves no other test.
 * `id` and `supersedes_id` are the fixture's names for its entries. */
async function insertLedger(ctx: TestStore, row: LedgerRow) {
  await bookLedger(ctx.call, [{
    id: row.id,
    kind: row.kind,
    asset: row.asset,
    period: row.period,
    family: row.family,
    amount_minor: Math.round(row.amount * 100),
    booking_state: row.booking_state,
    supersedes_id: row.supersedes_id ?? null,
    recorded_at: row.recorded_at,
  }]);
}

/** The populated store's ledger: id=1 estimate superseded by id=2 reconciled —
 * id=1 must drop out. Written by the tests that read money, so the rest of
 * `seed` stays a copy every test shares. */
async function seedLedger(ctx: TestStore) {
  await insertLedger(ctx, { id: 1, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 100, booking_state: "estimated", recorded_at: "2026-07-02T00:00:00.000Z" });
  await insertLedger(ctx, { id: 2, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 150, booking_state: "reconciled", supersedes_id: 1, recorded_at: "2026-07-04T00:00:00.000Z" });
  await insertLedger(ctx, { id: 3, kind: "cost", asset: "meals.example", period: "2026-07", family: "inference", amount: 20, booking_state: "reconciled", recorded_at: "2026-07-04T00:00:00.000Z" });
  await insertLedger(ctx, { id: 4, kind: "revenue", asset: "nosh.example", period: "2026-07", family: "affiliate", amount: 30, booking_state: "estimated", recorded_at: "2026-07-03T00:00:00.000Z" });
  await insertLedger(ctx, { id: 5, kind: "revenue", asset: "meals.example", period: "2026-06", family: "ads", amount: 90, booking_state: "reconciled", recorded_at: "2026-06-30T00:00:00.000Z" });
}

/** A counters-lane reading, on Postgres where the site's totals read it (bead
 * ro-ujb9.76.5.1), in the test's own copy of its sites (test/sites.ts): the
 * site's row must be added first, and a copy written to serves no other test. */
async function insertCounterReading(
  ctx: TestStore,
  asset: string,
  metric: string,
  value: number,
  observedAt: string,
) {
  await (ctx.call).write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.counter_readings (workspace_id, asset_id, metric, value, observed_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz)`,
      [tx.workspaceId, asset, metric, value, observedAt],
    ),
  );
}

/** meals' counter readings (the 15-min fast lane), minutes old. plansSaved is
 * deliberately BELOW its nightly total — magnitude must not decide which lane
 * wins. `leads` has no reading and no pulse metric: the both-lanes-empty entry.
 * nom gets none, so its totals fall back to its nightly report. Written by the
 * tests that read them, so the rest of `seed` stays a copy every test shares. */
async function insertMealsReadings(ctx: TestStore) {
  await insertCounterReading(ctx, "meals.example", "signups", 4310, new Date(NOW_MS - 5 * 60_000).toISOString());
  await insertCounterReading(ctx, "meals.example", "plansSaved", 1900, new Date(NOW_MS - 5 * 60_000).toISOString());
}

/** One lane's daily values under that lane's one run, on Postgres where the
 * collectors write them (bead ro-ujb9.76.5.3), in the test's own copy of its
 * sites (test/sites.ts): the run on the lane's first call, more values under
 * it on the next (the store never rewrites a run, so its counts are the first
 * call's). */
async function insertSignalSnapshot(
  ctx: TestStore,
  integration: "ga4" | "gsc" | "bing-webmaster",
  metric:
    | "active_users"
    | "sessions"
    | "page_views"
    | "event_count"
    | "clicks"
    | "impressions"
    | "ctr"
    | "position",
  values: number[],
  startDate = "2026-07-03",
  asset = "meals.example",
) {
  const runId = `${asset}-${integration}-run`;
  const startMs = Date.parse(`${startDate}T00:00:00.000Z`);
  const dates = values.map((_, index) =>
    new Date(startMs + index * DAY).toISOString().slice(0, 10),
  );
  const endDate = dates.at(-1) ?? startDate;
  const store = ctx.call;
  const written = values.map((value, index) => ({ date: dates[index]!, metric, value }));
  const [existing] = await store.read((tx) =>
    tx.query<{ id: string }>(`SELECT run_id AS id FROM noticeos.signal_runs WHERE run_id = $1`, [runId]),
  );
  if (existing) {
    await writeSignalValues(store, runId, written);
    return;
  }
  await writeSignalRun(store, {
    id: runId, asset, integration, credentialRef: "studio-signals",
    propertyRef: integration === "ga4" ? "123456" : integration === "gsc" ? `sc-domain:${asset}` : `https://${asset}/`,
    startedAt: "2026-07-05T11:54:00.000Z", finishedAt: "2026-07-05T11:55:00.000Z",
    windowStart: startDate, windowEnd: endDate,
    provisionalFrom: integration === "bing-webmaster" ? null : endDate,
    providerRows: values.length, observationCount: values.length,
  }, written);
}

/** meals' collected metrics: GA4 users, Search Console and Bing clicks and
 * impressions. Written by the tests that read them, so the rest of `seed`
 * stays a copy every test shares. */
async function insertMealsSignals(ctx: TestStore) {
  await insertSignalSnapshot(ctx, "ga4", "active_users", [101, 116, 48]);
  await insertSignalSnapshot(ctx, "gsc", "clicks", [12, 17, 5]);
  await insertSignalSnapshot(ctx, "gsc", "impressions", [420, 510, 180]);
  await insertSignalSnapshot(ctx, "bing-webmaster", "clicks", [7, 9]);
  await insertSignalSnapshot(ctx, "bing-webmaster", "impressions", [140, 190]);
}

interface FlagRow {
  asset: string;
  fired_at: string;
  severity: "info" | "warn" | "error";
  kind: "anomaly" | "opportunity" | "milestone";
  rule_id: string;
  metric?: string | null;
  message?: string | null;
  rule_inputs?: Record<string, unknown> | null;
  disposition?: string | null;
  /** For `disposition: "snooze"` — when the condition returns (`ro-c7qq`). */
  snooze_until?: string | null;
  resolved_at?: string | null;
}

function alertRow(f: FlagRow): AlertRow {
  return {
    asset: f.asset,
    firedAt: f.fired_at,
    severity: f.severity,
    kind: f.kind,
    metric: f.metric ?? null,
    message: f.message ?? null,
    ruleId: f.rule_id,
    ruleInputs: f.rule_inputs ?? null,
    disposition: f.disposition ?? null,
    dispositionAt: f.disposition ? "2026-07-05T11:00:00.000Z" : null,
    snoozeUntil: f.snooze_until ?? null,
    resolvedAt: f.resolved_at ?? null,
  };
}

/** One alert, on Postgres in the test's copy of its sites (bead
 * ro-ujb9.76.5.2): its number, which the Wall shows as its id. */
async function insertFlag(ctx: TestStore, f: FlagRow): Promise<number> {
  return storeAlert(ctx.call, alertRow(f));
}

/** One change, on Postgres in the test's copy of its sites (bead
 * ro-ujb9.76.5.7). */
async function insertAnnotation(
  ctx: TestStore,
  asset: string,
  at: string,
  kind: string,
  ref: string | null,
  note: string | null,
): Promise<void> {
  await storeChange(ctx.call, { asset, at, kind, ref, note });
}

/** One open readback window, on Postgres in the test's copy of its sites
 * (bead ro-ujb9.76.5.7). */
async function insertOpenWatch(
  ctx: TestStore,
  {
    id,
    asset,
    registeredAt,
    note,
    readings = [],
  }: {
    id: string;
    asset: string;
    registeredAt: string;
    note: string;
    readings?: number[];
  },
): Promise<void> {
  await storeWatchWindow(ctx.call, {
    id,
    asset,
    ref: id,
    registeredAt,
    baselineStart: "2026-06-01",
    baselineEnd: registeredAt.slice(0, 10),
    offsets: [7, 14, 28],
    read: readings,
    note });
}

async function seed(raw: TestStore, hasOs = true) {
  // Insertion order IS the fixed card order (rowid). The OS row keeps the
  // owner's pre-rename stored name, which no payload shows (ro-ujb9.77.10).
  await insertAsset(raw, "root-os", "ReindexOS", "live", 0, hasOs ? 1 : 0);
  await insertAsset(raw, "meals.example", "Meal Planner", "onboarding", 0, 0);
  await insertAsset(raw, "nosh.example", "Nosh", "onboarding", 0, 0);
  await insertAsset(raw, "pacer.example", "Pacer Test", "onboarding", 1, 0);

  // Nightly reports and alerts are on Postgres: `seedReportsAndAlerts`.
  // meals' counter readings are on Postgres: `insertMealsReadings`; so are
  // its collected metrics: `insertMealsSignals`.

  // The ledger is on Postgres: `seedLedger`, written by the tests that read money.

  // Annotations. meals deployed 14h before its alert fired (correlates), and
  // again a week earlier (outside the window). Nosh's config change lands AFTER
  // its alert — a change that happened later cannot explain it.
  // The changes are on Postgres: the test that reads them files them.
}

/**
 * `seed`'s nightly reports and alerts, on Postgres (bead ro-ujb9.76.5.2), in
 * the test's copy of its sites: written by the tests that read them, so the
 * rest of `seed` stays a copy every test in a file shares.
 */
async function seedReportsAndAlerts(ctx: TestStore, { withoutOsReport = false }: { withoutOsReport?: boolean } = {}) {
  // The OS's own report, unless a test is about the night it sent none.
  const reports: ReportRow[] = withoutOsReport ? [] : [
    report("root-os", "2026-07-05", OS_RECEIVED, {
      spend: { last24h: 2.4 },
      agentsRunning: { last24h: 2 },
      queueDepth: { last24h: 14 },
    }),
  ];
  // meals DECLARES its capabilities — signups leads, so the activity panel
  // charts signups even though plansSaved is the busier metric.
  const mealsCaps = ["signups", "plansSaved"];
  reports.push(
    report(
      "meals.example",
      "2026-07-03",
      new Date(NOW_MS - 2 * DAY).toISOString(),
      { signups: { last24h: 10, avg7d: 9 }, plansSaved: { last24h: 240, avg7d: 250 } },
      mealsCaps,
    ),
    report(
      "meals.example",
      "2026-07-04",
      new Date(NOW_MS - 28 * HOUR).toISOString(),
      { signups: { last24h: 12, avg7d: 10 }, plansSaved: { last24h: 265, avg7d: 252 } },
      mealsCaps,
    ),
    report(
      "meals.example",
      "2026-07-05",
      MEALS_RECEIVED,
      {
        signups: { last24h: 15, avg7d: 11, total: 4233 },
        plansSaved: { last24h: 230, avg7d: 248, total: 1907 },
      },
      mealsCaps,
    ),
    // nom declares NOTHING — the fallback picks its busiest metric by avg7d.
    report("nosh.example", "2026-07-02", NOM_RECEIVED, {
      items: { last24h: 500, avg7d: 40, total: 12954 },
      receiptVisits: { last24h: 12, avg7d: 55 },
    }),
  );
  const store = ctx.call;
  await storeReports(store, reports);

  // Flags: two open (error on meals, warn on nom); two closed (resolved + acked).
  // The open pair carries the rule_inputs its rule really writes — the attention
  // row ships them so the client can translate the alert into plain language.
  await storeAlerts(store, [
    alertRow({ asset: "meals.example", fired_at: "2026-07-05T09:00:00.000Z", severity: "error", kind: "anomaly", rule_id: "ingest-freshness", metric: "pulse", message: "no pulse in 41h (> 36h threshold)", rule_inputs: { rule: "ingest-freshness", lastReceivedAt: "2026-07-03T16:00:00.000Z", thresholdHours: 36, ageHours: 41 } }),
    alertRow({ asset: "nosh.example", fired_at: "2026-07-05T10:00:00.000Z", severity: "warn", kind: "anomaly", rule_id: "flow-poisson-low", metric: "receiptVisits", message: "12 in last24h (avg7d 55.0, P(<=12)~=0.0000)", rule_inputs: { metric: "receiptVisits", observed: 12, baselinePerDay: 55, alpha: 0.01, pLowerTail: 0.0000004 } }),
    alertRow({ asset: "nosh.example", fired_at: "2026-07-01T10:00:00.000Z", severity: "warn", kind: "anomaly", rule_id: "poisson-drop", resolved_at: "2026-07-02T10:00:00.000Z" }),
    alertRow({ asset: "meals.example", fired_at: "2026-07-04T10:00:00.000Z", severity: "error", kind: "anomaly", rule_id: "poisson-drop", disposition: "ack" }),
  ]);
}

describe("buildWallPayload — populated store", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seed(ctx);
  });

  it("PORTFOLIO: the headline books reconciled rows only, estimates ride their own field", async () => {
    await seedLedger(ctx);
    const p = await buildWallPayload(ctx.call, OPTIONS);
    // Current July rows: 150 reconciled revenue (superseding the 100 estimate),
    // 20 reconciled cost, and nom's 30 estimated revenue. The old read model
    // summed all three into one "portfolio total" (doc 19 finding 4).
    expect(p.portfolio.booked).toEqual({ currency: 'USD', revenue: 150, cost: 20, net: 130 });
    expect(p.portfolio.forecast).toEqual({ currency: 'USD', revenue: 30, cost: 0, net: 30 });
    // The mixed total the band used to publish (160) appears nowhere.
    const mixed = p.portfolio.booked.net! + p.portfolio.forecast.net!;
    expect(mixed).toBe(160);
    expect(Object.values(p.portfolio.booked)).not.toContain(mixed);
    expect(p.portfolio.netTrend.map((point) => point.v)).not.toContain(mixed);
    expect(p.portfolio.firstRun).toBe(false);
    // The trend charts the same money the headline states.
    expect(p.portfolio.netTrend).toEqual([
      { t: "2026-06", v: 90 },
      { t: "2026-07", v: 130 },
    ]);
    expect(p.ledgerRecordedAt).toBe("2026-07-04T00:00:00.000Z");
    // …and this band has plenty to say, so every surface mounts it (ro-yf3).
    expect(portfolioHasData(p.portfolio)).toBe(true);
  });

  it("PORTFOLIO: the delta pairs two CLOSED months, mid-month, to the cent (bead ro-7yv)", async () => {
    await seedLedger(ctx);
    // NOW is the 5th of July: the current period is four days old and the band
    // used to compare it with the whole of June. May and June, both closed, are
    // the only pair either side of which covers a full month. The cents are the
    // repo's own float trap (ro-wtt): these rows add to 866.4000000000001 and
    // 1809.6499999999999 in dollars, and 1809.65 − 866.40 is 943.2500000000001,
    // so a delta taken anywhere but in cents lands beside the figures it sits
    // next to.
    await insertLedger(ctx, { id: 40, kind: "revenue", asset: "nosh.example", period: "2026-05", family: "ads", amount: 445.1, booking_state: "reconciled", recorded_at: "2026-05-31T00:00:00.000Z" });
    await insertLedger(ctx, { id: 41, kind: "revenue", asset: "nosh.example", period: "2026-05", family: "affiliate", amount: 421.3, booking_state: "reconciled", recorded_at: "2026-05-31T00:00:00.000Z" });
    await insertLedger(ctx, { id: 42, kind: "revenue", asset: "nosh.example", period: "2026-06", family: "ads", amount: 574.15, booking_state: "reconciled", recorded_at: "2026-06-30T00:00:00.000Z" });
    await insertLedger(ctx, { id: 43, kind: "revenue", asset: "nosh.example", period: "2026-06", family: "ads", amount: 271.2, booking_state: "reconciled", recorded_at: "2026-06-30T00:00:00.000Z" });
    await insertLedger(ctx, { id: 44, kind: "revenue", asset: "nosh.example", period: "2026-06", family: "affiliate", amount: 417.1, booking_state: "reconciled", recorded_at: "2026-06-30T00:00:00.000Z" });
    await insertLedger(ctx, { id: 45, kind: "revenue", asset: "nosh.example", period: "2026-06", family: "affiliate", amount: 457.2, booking_state: "reconciled", recorded_at: "2026-06-30T00:00:00.000Z" });

    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.portfolio.period).toBe("2026-07");
    expect(p.portfolio.netTrend).toEqual([
      { t: "2026-05", v: 866.4 },
      { t: "2026-06", v: 1809.65 }, // the seed's own 90, plus these four
      { t: "2026-07", v: 130 },
    ]);
    // Two closed months, named, and the partial one is neither of them.
    const delta = p.portfolio.bookedDelta!;
    expect(delta.value).toBe(943.25);
    expect(delta.value).not.toBe(1809.65 - 866.4); // the float road: …0000001
    expect(delta.period).toBe("2026-06");
    expect(delta.priorPeriod).toBe("2026-05");
    expect(delta.percent).toBeCloseTo(108.87, 2);
    // The comparison the old chip made — July's four days against all of June.
    expect(delta.value).not.toBe(130 - 1809.65);
    expect(delta.period).not.toBe(p.portfolio.period);
  });

  it("PORTFOLIO: one closed month is no delta at all — nothing is drawn", async () => {
    await seedLedger(ctx);
    // The seed's own shape on the 5th of July: June closed, July open. There is
    // no second closed month to measure June against, so the payload states
    // none. A first month has nothing to compare with and says so by absence.
    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.portfolio.netTrend).toEqual([
      { t: "2026-06", v: 90 },
      { t: "2026-07", v: 130 },
    ]);
    expect(p.portfolio.bookedDelta).toBeNull();
  });

  it("PORTFOLIO: the month boundary hands the delta its next pair", async () => {
    await seedLedger(ctx);
    // Half an hour into August: July has just closed, so the pair rolls forward
    // to July vs June. The delta moves when a month ENDS, not while it is
    // running.
    //
    // The headline beside it no longer states an empty August (bead ro-bdkp) —
    // thirty minutes in, nothing has been imported, so it falls back to July and
    // names it. "Closed" is still read off the CALENDAR rather than off the
    // headline's period, which is why July is one side of the pair even while it
    // is the month on the card.
    const p = await buildWallPayload(ctx.call, {
      ...OPTIONS,
      now: new Date("2026-08-01T00:30:00.000Z"),
    });
    expect(p.portfolio.period).toBe("2026-07");
    expect(p.portfolio.periodIsCurrent).toBe(false);
    expect(p.portfolio.booked).toEqual({ currency: 'USD', revenue: 150, cost: 20, net: 130 });
    expect(p.portfolio.bookedDelta).toMatchObject({
      value: 40, // 130 − 90
      period: "2026-07",
      priorPeriod: "2026-06",
    });
    expect(p.portfolio.bookedDelta!.percent).toBeCloseTo(44.44, 2);
  });

  it("PORTFOLIO: a closed month worth zero takes the tone off, not the delta", async () => {
    await seedLedger(ctx);
    // June reconciled to exactly nothing. The change from it is real money and
    // stays stated; the percent against zero is not a number anybody can divide
    // for, so it is null rather than an Infinity dressed up as growth.
    await insertLedger(ctx, { id: 44, kind: "cost", asset: "nosh.example", period: "2026-06", family: "inference", amount: 90, booking_state: "reconciled", recorded_at: "2026-06-30T00:00:00.000Z" });
    await insertLedger(ctx, { id: 45, kind: "revenue", asset: "nosh.example", period: "2026-05", family: "ads", amount: 20, booking_state: "reconciled", recorded_at: "2026-05-31T00:00:00.000Z" });

    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.portfolio.bookedDelta).toEqual({ currency: 'USD',
      value: -20,
      percent: -100,
      period: "2026-06",
      priorPeriod: "2026-05",
    });

    // …and the other way round: the PRIOR month is the zero.
    await insertLedger(ctx, { id: 46, kind: "cost", asset: "nosh.example", period: "2026-05", family: "inference", amount: 20, booking_state: "reconciled", recorded_at: "2026-05-31T00:00:00.000Z" });
    await insertLedger(ctx, { id: 47, kind: "revenue", asset: "nosh.example", period: "2026-06", family: "ads", amount: 12.5, booking_state: "reconciled", recorded_at: "2026-06-30T00:00:00.000Z" });
    const q = await buildWallPayload(ctx.call, OPTIONS);
    expect(q.portfolio.bookedDelta).toEqual({ currency: 'USD',
      value: 12.5,
      percent: null,
      period: "2026-06",
      priorPeriod: "2026-05",
    });
  });

  it("PORTFOLIO: one reconciled row cannot unlock a total made of estimates", async () => {
    await seedLedger(ctx);
    // The exact shape doc 19 named: the Wall waited for a single reconciled row
    // to exist and then summed everything current. Here that one row is $150
    // and the estimates around it are $2,400.
    await insertLedger(ctx, { id: 10, kind: "revenue", asset: "meals.example", period: "2026-07", family: "affiliate", amount: 800, booking_state: "estimated", recorded_at: "2026-07-05T00:00:00.000Z" });
    await insertLedger(ctx, { id: 11, kind: "revenue", asset: "nosh.example", period: "2026-07", family: "subs", amount: 900, booking_state: "estimated", recorded_at: "2026-07-05T00:00:00.000Z" });
    await insertLedger(ctx, { id: 12, kind: "revenue", asset: "pacer.example", period: "2026-07", family: "ads", amount: 700, booking_state: "estimated", recorded_at: "2026-07-05T00:00:00.000Z" });

    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.portfolio.booked).toEqual({ currency: 'USD', revenue: 150, cost: 20, net: 130 });
    expect(p.portfolio.forecast.revenue!).toBe(2430); // 30 + 800 + 900 + 700
    expect(p.portfolio.netTrend.at(-1)).toEqual({ t: "2026-07", v: 130 });
  });

  it("PORTFOLIO: sums exact cents, so the headline is provable", async () => {
    // Four figures whose float sum is 758.1999999999999 — the reason db/0018
    // added amount_minor (doc 19 finding 1).
    for (const [id, amount] of [[20, 512.4], [21, 168.2], [22, 55.5], [23, 22.1]] as const) {
      await insertLedger(ctx, { id, kind: "revenue", asset: "nosh.example", period: "2026-08", family: "ads", amount, booking_state: "reconciled", recorded_at: "2026-08-01T00:00:00.000Z" });
    }
    const p = await buildWallPayload(ctx.call, { ...OPTIONS, now: new Date("2026-08-05T12:00:00.000Z") });
    expect(p.portfolio.booked.revenue!).toBe(758.2);
    expect(p.portfolio.booked.net!).toBe(758.2);
  });

  it("PORTFOLIO: the headline, the card, and the asset's P&L state the same cents — on BOTH sides", async () => {
    // One month's rows read by three surfaces. Every figure is a float trap:
    // in dollars the revenue adds to 1809.6499999999999, the ads family to
    // 845.3499999999999, the costs to 866.4000000000001, and 1809.65 − 866.40
    // is 943.2500000000001. Any reader that divides before it adds lands a
    // fraction of a cent away from the other two (ro-wtt) — which is why db/0020
    // removed the dollars column those readers used to be able to reach (ro-k5s).
    //
    // The month is MIXED, because agreeing on exact cents is only half of it
    // (ro-jk7): three surfaces reading the same rows must also cut them at the
    // same place. The page rolled every current row into one figure, so before
    // the split it agreed with the headline here only when nothing was
    // estimated — which is the one case doc 19 finding 4 is not about.
    const rows = [
      [30, "revenue", "ads", 574.15],
      [31, "revenue", "ads", 271.2],
      [32, "revenue", "affiliate", 417.1],
      [33, "revenue", "affiliate", 547.2],
      [34, "cost", "inference", 445.1],
      [35, "cost", "inference", 421.3],
    ] as const;
    for (const [id, kind, family, amount] of rows) {
      await insertLedger(ctx, { id, kind, asset: "nosh.example", period: "2026-08", family, amount, booking_state: "reconciled", recorded_at: "2026-08-01T00:00:00.000Z" });
    }
    // …plus estimates on the same asset and month: 812.45 − 96.15 = 716.30,
    // which is 716.3000000000001 once either side has left integer cents.
    await insertLedger(ctx, { id: 36, kind: "revenue", asset: "nosh.example", period: "2026-08", family: "subs", amount: 812.45, booking_state: "estimated", recorded_at: "2026-08-01T00:00:00.000Z" });
    await insertLedger(ctx, { id: 37, kind: "cost", asset: "nosh.example", period: "2026-08", family: "infra", amount: 96.15, booking_state: "estimated", recorded_at: "2026-08-01T00:00:00.000Z" });

    const now = new Date("2026-08-05T12:00:00.000Z");
    const wall = await buildWallPayload(ctx.call, { ...OPTIONS, now });
    const detail = await buildAssetDetailPayload(ctx.call, "nosh.example", { ...DETAIL_DEPS, now });
    const august = detail!.ledger.periods.find((p) => p.period === "2026-08")!;
    const card = wall.assets.find((a) => a.id === "nosh.example")!;

    expect(wall.portfolio.booked).toEqual({ currency: 'USD', revenue: 1809.65, cost: 866.4, net: 943.25 });
    expect(wall.portfolio.forecast).toEqual({ currency: 'USD', revenue: 812.45, cost: 96.15, net: 716.3 });
    // The asset page's P&L over the same rows, to the cent, on each side…
    expect(august.booked.figure).toEqual(wall.portfolio.booked);
    expect(august.forecast.figure).toEqual(wall.portfolio.forecast);
    // …and the card's, which the Wall states beside the line that charts it.
    expect(card.booked).toEqual(august.booked.figure);
    expect(card.forecast).toEqual(august.forecast.figure);
    expect(wall.portfolio.netTrend.at(-1)).toEqual({ t: "2026-08", v: 943.25 });
    // The blend all three used to be able to say: no surface states it, and no
    // pair of fields on any of them adds up to it by accident.
    for (const figure of [august.booked.figure, august.forecast.figure, card.booked, card.forecast]) {
      expect(Object.values(figure)).not.toContain(1659.55); // 943.25 + 716.30
    }
  });

  it("PORTFOLIO: a superseded row cannot set the ledger's age", async () => {
    // A late-recorded estimate, corrected by a row that was itself recorded
    // earlier (a backfilled reconciliation). The estimate is no longer part of
    // the ledger, so the lane's age must not come from it.
    await insertLedger(ctx, { id: 6, kind: "revenue", asset: "nosh.example", period: "2026-07", family: "ads", amount: 80, booking_state: "estimated", recorded_at: "2026-07-05T00:00:00.000Z" });
    await insertLedger(ctx, { id: 7, kind: "revenue", asset: "nosh.example", period: "2026-07", family: "ads", amount: 64, booking_state: "reconciled", supersedes_id: 6, recorded_at: "2026-07-04T12:00:00.000Z" });

    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.ledgerRecordedAt).toBe("2026-07-04T12:00:00.000Z");
  });

  it("SYSTEM: carries what the strip and Home's System tile read, and nothing else", async () => {

    await seedReportsAndAlerts(ctx);
    const p = await buildWallPayload(ctx.call, OPTIONS);
    // Bead `ro-trai.44`: the old System card's agents, queue, monthly cap, work
    // widget and report age are not computed — no screen draws them.
    expect(Object.keys(p.system).sort()).toEqual(
      ["assetId", "dailyCapUsd", "hasPulse", "ingest", "scheduledLanes", "spendTodayUsd"],
    );
    expect(p.system.assetId).toBe("root-os");
    expect(p.system.hasPulse).toBe(true);
    // No metered call has been made today, and that is a MEASURED zero rather
    // than an absent reading (bead `ro-sq42`): the figure comes from the OS's
    // own record of the calls it made, so "nothing was spent" is knowable.
    expect(p.system.spendTodayUsd).toBe(0);
    // The metered data cap alone — the inference half was withdrawn with D6
    // (bead `ro-uj7x`), so the pace is drawn against money the OS can spend.
    expect(p.system.dailyCapUsd).toBeCloseTo(25 / 31, 6); // July has 31 days
    expect(p.system.scheduledLanes).toEqual([]);
    // meals + root-os fresh; nom (3d old) is stale; pacer has
    // never sent a report, so it expects none (D29 amended, ro-ujb9.121).
    expect(p.system.ingest).toEqual({
      fresh: 2, stale: 1, notExpected: 1, expected: 3,
    });
  });

  /** One metered DataForSEO call and what it cost, on the manifest rows both
   * the Wall's day and the Health page's month are summed from. On Postgres,
   * where the collector writes them (bead ro-ujb9.76.5.4). */
  async function insertMeteredCall(
    id: string,
    asset: string,
    requestedAt: string,
    costUsd: number,
  ): Promise<void> {
    await writeArchiveRun(ctx.call, {
      id, asset, integration: "dataforseo", report: "ranked-keywords", credential_ref: "cred",
      report_date: requestedAt.slice(0, 10), finished_at: requestedAt, provider_rows: 10, request_count: 1,
      object_key: `signals/${id}`, object_bytes: 100, provider_cost_usd: costUsd,
    });
  }

  // The defect bead `ro-sq42` closed: this figure was read from asset #0's
  // report envelope, nothing in the repo ever wrote one of its four candidate
  // keys, and the row was absent on every real Wall while `/integrations` was
  // summing the same money out of the store beside it.
  it("SYSTEM: sums TODAY's metered spend out of the store, not the report", async () => {
    await seedReportsAndAlerts(ctx);
    await insertMeteredCall("dfs-today-1", "meals.example", "2026-07-05T02:15:00.000Z", 0.4);
    await insertMeteredCall("dfs-today-2", "nosh.example", "2026-07-05T11:00:00.000Z", 0.15);
    // Yesterday's call is yesterday's pace, and June's is neither.
    await insertMeteredCall("dfs-yesterday", "meals.example", "2026-07-04T23:59:00.000Z", 9);
    await insertMeteredCall("dfs-june", "nosh.example", "2026-06-30T12:00:00.000Z", 4);

    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.system.spendTodayUsd).toBeCloseTo(0.55, 10);
    // And it is the same function `/integrations` reads, one window over: the
    // month holds both July days and drops June.
    const month = await loadDataForSeoSpend(ctx.call, NOW);
    expect(month.spentUsd).toBeCloseTo(9.55, 10);
  });

  // Bead `ro-ukus`: the pace inherited the desk's undercount. Ad-hoc research
  // spends the same DataForSEO account against the same daily share of the cap,
  // and the collector's gate has always counted it — so a Wall that did not was
  // showing a pace the OS would refuse to keep.
  it("SYSTEM: today's pace counts the ad-hoc research, not only the collection", async () => {
    await seedReportsAndAlerts(ctx);
    await insertMeteredCall("dfs-today", "meals.example", "2026-07-05T02:15:00.000Z", 0.4);
    await writeResearch(ctx.call, [{
      asset: "nosh.example", endpoint: "dataforseo_labs/google/keyword_overview/live", params_sha256: "a".repeat(64),
      question: "keyword overview, 1 term, US/en", cost_usd: 0.24, actor: "claude-opus-5", bought_at: "2026-07-05T09:00:00.000Z",
    }]);

    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.system.spendTodayUsd).toBeCloseTo(0.64, 10);
  });

  // Spend does not vanish with the report: the store remembers what the OS
  // spent even on the night it goes quiet.
  it("SYSTEM: keeps today's spend when asset #0 sent no report at all", async () => {
    await seedReportsAndAlerts(ctx, { withoutOsReport: true });
    await insertMeteredCall("dfs-quiet", "meals.example", "2026-07-05T06:00:00.000Z", 1.25);

    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.system.hasPulse).toBe(false);
    expect(p.system.spendTodayUsd).toBeCloseTo(1.25, 10);
  });

  // `hasPulse` is read off the coverage read every site's arrival already
  // comes from, not a query of its own (bead `ro-trai.44`): any report the OS
  // ever sent counts, however old, and a store with no OS row owes none.
  it("SYSTEM: hasPulse is any report from the OS's own row, however old", async () => {
    await seedReportsAndAlerts(ctx, { withoutOsReport: true });
    await insertPulse(ctx, "root-os", "2026-05-01", "2026-05-01T03:00:00.000Z", {});
    expect((await buildWallPayload(ctx.call, OPTIONS)).system.hasPulse).toBe(true);

    // An installation with no OS row: the report that site sends is a site's.
    // The same store, with the site changed before any report is written (a
    // test's Postgres copy takes no site change after a write, test/sites.ts).
    const noOsStore = await createTestStore();
    await seed(noOsStore, false);
    await seedReportsAndAlerts(noOsStore, { withoutOsReport: true });
    await insertPulse(noOsStore, "root-os", "2026-05-01", "2026-05-01T03:00:00.000Z", {});
    const noOs = await buildWallPayload(noOsStore.call, OPTIONS);
    expect(noOs.system.assetId).toBeNull();
    expect(noOs.system.hasPulse).toBe(false);
  });

  it("SYSTEM: Wall and asset #0 read the same latest firing for every scheduled lane", async () => {
    // The runner's record is on Postgres (bead ro-ujb9.76.4.3): this test's own copy.
    const runs: [string, string, string, string, string, string][] = [
      ["backup", "2026-07-05T08:00:00.000Z", "2026-07-05T08:01:00.000Z", "failed", "copy failed", "2026-07-05T08:01:01.000Z"],
      ["backup", "2026-07-05T09:00:00.000Z", "2026-07-05T09:01:00.000Z", "ran", "copy complete", "2026-07-05T09:01:01.000Z"],
      ["beads-snapshot", "2026-07-05T11:55:00.000Z", "2026-07-05T11:55:03.000Z", "failed", "hub unavailable", "2026-07-05T11:55:04.000Z"],
    ];
    await (ctx.call).write((tx) =>
      tx.execute(
        `INSERT INTO noticeos.job_runs (workspace_id, job, started_at, finished_at, outcome, detail, recorded_at)
         SELECT $1::uuid, r.job, r.started_at, r.finished_at, r.outcome, r.detail, r.recorded_at
           FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[], $5::text[], $6::text[], $7::timestamptz[])
             AS r(job, started_at, finished_at, outcome, detail, recorded_at)`,
        [tx.workspaceId, ...[0, 1, 2, 3, 4, 5].map((column) => runs.map((run) => run[column]!))],
      ),
    );

    const wall = await buildWallPayload(ctx.call, OPTIONS);
    const systemPage = await buildAssetDetailPayload(ctx.call, "root-os", DETAIL_DEPS);
    const ordinaryPage = await buildAssetDetailPayload(ctx.call, "meals.example", DETAIL_DEPS);
    expect(wall.system.scheduledLanes).toEqual([
      {
        job: "backup",
        outcome: "ran",
        startedAt: "2026-07-05T09:00:00.000Z",
      },
      {
        job: "beads-snapshot",
        outcome: "failed",
        startedAt: "2026-07-05T11:55:00.000Z",
      },
    ]);
    expect(systemPage?.scheduledLanes).toEqual(wall.system.scheduledLanes);
    expect(ordinaryPage?.scheduledLanes).toBeNull();
  });

  // docs/19 finding 5: the summary used to be counted FROM the pulses table, so
  // an asset that went quiet could vanish from its own denominator — letting
  // the Tower say "all fresh" over a sender that had stopped. Counted over the
  // asset rows, a stale sender stays in the denominator.
  it("SYSTEM: a sender that went quiet stays inside the denominator, and blocks all-fresh", async () => {
    await seedReportsAndAlerts(ctx);
    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.system.ingest.stale).toBe(1);
    expect(isAllFresh(p.system.ingest)).toBe(false);
    expect(p.system.ingest.expected).toBe(p.system.ingest.fresh + p.system.ingest.stale);
  });

  // D29 amended (ro-ujb9.121): a site expects a nightly report once it has
  // sent one. One that never has has no sender, so it is not silence — it is
  // outside the fraction, and all-fresh is reachable without it.
  it("SYSTEM: a site that never sent a report is outside the fraction, so every sender current is all fresh", async () => {
    await seedReportsAndAlerts(ctx);
    await insertPulse(ctx, "nosh.example", "2026-07-05", new Date(NOW_MS - 2 * HOUR).toISOString(), {
      items: { last24h: 520, avg7d: 45, total: 13000 },
    });

    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.system.ingest).toEqual({
      fresh: 3, stale: 0, notExpected: 1, expected: 3,
    });
    expect(isAllFresh(p.system.ingest)).toBe(true);
    // Its first report puts it in the fraction by itself.
    await insertPulse(ctx, "pacer.example", "2026-07-05", new Date(NOW_MS - HOUR).toISOString(), {
      visits: { last24h: 40, avg7d: 38, total: 900 },
    });
    expect((await buildWallPayload(ctx.call, OPTIONS)).system.ingest).toMatchObject({ fresh: 4, expected: 4, notExpected: 0 });
  });

  // ro-uwo.1: the ingest cron fired `ingest-freshness` at 36h while this count
  // called the same asset fresh until 48h, so one payload could carry an open
  // error in ATTENTION and a "fresh" tally in SYSTEM about one asset. Both
  // sides now age a report against the contract's REPORT_MAX_AGE_HOURS
  // (workers/ingest/test/freshness.test.ts asserts the cron half at the same
  // two ages).
  describe("SYSTEM: one staleness clock, shared with the ingest cron", () => {
    it("counts a 40h-old report fresh — the age the two surfaces used to disagree at", async () => {
      await seedReportsAndAlerts(ctx);
      await insertPulse(ctx, "nosh.example", "2026-07-03", new Date(NOW_MS - 40 * HOUR).toISOString(), {
        items: { last24h: 500, avg7d: 40, total: 12954 },
      });

      const p = await buildWallPayload(ctx.call, OPTIONS);
      expect(p.system.ingest.fresh).toBe(3);
      expect(p.system.ingest.stale).toBe(0);
    });

    it("turns stale one hour past the threshold, not before it", async () => {

      await seedReportsAndAlerts(ctx);
      const atAge = async (hours: number) => {
        // Replace nom's newest report outright: the coverage reads its NEWEST
        // report. A second report for the same day is that day's newest
        // revision, which replaces the first (bead ro-ujb9.76.5.2), and nom's
        // other report, of the 2nd, is older than both ages.
        await insertPulse(
          ctx,
          "nosh.example",
          "2026-07-03",
          new Date(NOW_MS - hours * HOUR).toISOString(),
          { items: { last24h: 500, avg7d: 40, total: 12954 } },
        );
        return (await buildWallPayload(ctx.call, OPTIONS)).system.ingest;
      };

      expect((await atAge(REPORT_MAX_AGE_HOURS)).stale).toBe(0);
      expect((await atAge(REPORT_MAX_AGE_HOURS + 1)).stale).toBe(1);
    });

    it("paints the age badge on the same threshold it counts staleness at", () => {
      // The badge every card carries reads CADENCE_HOURS.pulse × AMBER_MULTIPLIER.
      // If that ever drifts from the counted threshold, a card goes grey beside a
      // SYSTEM line calling the same asset stale — the bug, moved.
      expect(CADENCE_HOURS.pulse * AMBER_MULTIPLIER).toBe(REPORT_MAX_AGE_HOURS);
      expect(isAmber(NOW_MS, new Date(NOW_MS - 40 * HOUR).toISOString(), CADENCE_HOURS.pulse)).toBe(
        false,
      );
      expect(
        isAmber(
          NOW_MS,
          new Date(NOW_MS - (REPORT_MAX_AGE_HOURS + 1) * HOUR).toISOString(),
          CADENCE_HOURS.pulse,
        ),
      ).toBe(true);
    });
  });

  it("SYSTEM: pre-launch and retired assets sit outside the expected set", async () => {

    await seedReportsAndAlerts(ctx);
    // Neither owes a report, so neither can make coverage look worse — and
    // neither pads the denominator that "all fresh" is measured against.
    await insertAsset(ctx, "fees.example", "Fee Codes", "pre-launch", 1, 0);
    await insertAsset(ctx, "old.example", "Retired Thing", "retired", 1, 0);

    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.system.ingest).toEqual({
      fresh: 2, stale: 1, notExpected: 3, expected: 3,
    });
  });

  // ro-ujb9.121 — THIS installation, as the payload sees it: every sender keeps
  // its place in the fraction (a stopped one is stale), and a site declared as
  // sending none stays No report. The amendment changes only a site that has
  // never sent a report and was never declared, which it does not have.
  it("SYSTEM + ASSETS: an installation whose silent sites are all declared counts exactly as before", async () => {
    await seedReportsAndAlerts(ctx);
    const p = await buildWallPayload(ctx.call, { ...OPTIONS, noNightlyReport: ["pacer.example"] });
    expect(p.system.ingest).toEqual({ fresh: 2, stale: 1, notExpected: 1, expected: 3 });
    const card = (id: string) => p.assets.find((asset) => asset.id === id)!;
    // The stopped sender still reads Overdue in its strip.
    expect(card("nosh.example").dataSources.find((source) => source.id === "nightly-report")?.state).toBe("degraded");
    expect(card("meals.example").dataSources.find((source) => source.id === "nightly-report")?.state).toBe("live");
    // The declared site is still the operator's No report, in its strip too.
    expect(card("pacer.example").noNightlyReport).toBe(true);
    expect(card("pacer.example").dataSources.find((source) => source.id === "nightly-report")?.state).toBe("skipped");
  });

  // ro-ujb9.96.8 — the Tower half of a declared "no nightly report". The ingest
  // half is workers/ingest/test/freshness.test.ts "assets declared as sending no
  // nightly report": the same declaration makes the same asset not-expected
  // there, never earns it a flag, and resolves the one it had. Both sides ask
  // the contract's `owesNightlyReport`, so neither can count what the other
  // excuses.
  describe("an asset declared as sending no nightly report", () => {
    const DECLARED = { ...OPTIONS, noNightlyReport: ["pacer.example"] };
    const neverReported = () =>
      insertFlag(ctx, {
        asset: "pacer.example",
        fired_at: "2026-07-05T08:00:00.000Z",
        severity: "error",
        kind: "anomaly",
        rule_id: "ingest-freshness",
        metric: "pulse",
        message: "no pulse ever received (registered 2026-07-01T00:00:00.000Z)",
        rule_inputs: { rule: "ingest-freshness", state: "never-reported", lastReceivedAt: null, thresholdHours: REPORT_MAX_AGE_HOURS },
      });

    it("SYSTEM: sits outside the denominator, so all-fresh is reachable again", async () => {

      await seedReportsAndAlerts(ctx);
      await insertPulse(ctx, "nosh.example", "2026-07-05", new Date(NOW_MS - 2 * HOUR).toISOString(), {
        items: { last24h: 520, avg7d: 45, total: 13000 },
      });
      const p = await buildWallPayload(ctx.call, DECLARED);
      expect(p.system.ingest).toEqual({ fresh: 3, stale: 0, notExpected: 1, expected: 3 });
      expect(isAllFresh(p.system.ingest)).toBe(true);
    });

    it("ATTENTION + ASSETS: its released flag is no alert and no error count; the card says No report", async () => {

      await seedReportsAndAlerts(ctx);
      await neverReported();
      const before = await buildWallPayload(ctx.call, OPTIONS);
      expect(before.attention.some((item) => item.asset === "pacer.example")).toBe(true);

      const p = await buildWallPayload(ctx.call, DECLARED);
      expect(p.attention.some((item) => item.asset === "pacer.example")).toBe(false);
      const card = p.assets.find((asset) => asset.id === "pacer.example")!;
      expect(card.noNightlyReport).toBe(true);
      expect(card.openError).toBe(0);
      expect(card.worstSeverity).toBeNull();
      // The nightly slot in the source strip is the operator's decision — Not
      // using — rather than a lane that was never wired.
      expect(card.dataSources.find((source) => source.id === "nightly-report")?.state).toBe("skipped");
      // Everyone else still owes theirs.
      expect(p.assets.find((asset) => asset.id === "nosh.example")!.noNightlyReport).toBe(false);
    });

    it("shows a report it sends anyway, and still does not count it", async () => {

      await seedReportsAndAlerts(ctx);
      await insertPulse(ctx, "pacer.example", "2026-07-05", new Date(NOW_MS - 3 * HOUR).toISOString(), {
        visits: { last24h: 40, avg7d: 38, total: 900 },
      });
      const p = await buildWallPayload(ctx.call, DECLARED);
      const card = p.assets.find((asset) => asset.id === "pacer.example")!;
      expect(card.pulseReceivedAt).not.toBeNull();
      expect(card.dataSources.find((source) => source.id === "nightly-report")?.state).toBe("live");
      expect(p.system.ingest.notExpected).toBe(1);
    });

    it("the asset page says the same about the same asset", async () => {

      await seedReportsAndAlerts(ctx);
      await neverReported();
      const page = await buildAssetDetailPayload(ctx.call, "pacer.example", {
        ...DETAIL_DEPS,
        noNightlyReport: ["pacer.example"],
      });
      expect(page?.asset.noNightlyReport).toBe(true);
      expect(page?.asset.openError).toBe(0);
      expect(page?.wiring.ingestFreshness).toBeNull();
      expect(page?.wiring.noReportDeclarations).toEqual(["pacer.example"]);
      expect(page?.flags.open.some((flag) => flag.ruleId === "ingest-freshness")).toBe(false);
      expect(page?.integrations.sources.find((source) => source.id === "nightly-report")?.state).toBe("skipped");

      // Nobody has declared yet: the switch is told the list is absent, not empty.
      const undeclared = await buildAssetDetailPayload(ctx.call, "pacer.example", DETAIL_DEPS);
      expect(undeclared?.asset.noNightlyReport).toBe(false);
      expect(undeclared?.wiring.noReportDeclarations).toBeNull();
    });
  });

  it("DASHBOARD: carries applied display config into the polled Wall read model", async () => {
    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.dashboard).toEqual(OPTIONS.dashboard);
  });

  it("ASSETS: fixed seed order, open severity, series, and lifecycle facts", async () => {
    await seedLedger(ctx);
    await seedReportsAndAlerts(ctx);
    await insertMealsSignals(ctx);
    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.assets.map((a) => a.id)).toEqual([
      "meals.example",
      "nosh.example",
      "pacer.example",
    ]);

    const meals = p.assets[0]!;
    expect(meals.worstSeverity).toBe("error");
    expect(meals.openError).toBe(1);
    expect(meals.openWarn).toBe(0);
    // Net, not gross: July is 150 reconciled revenue − 20 cost.
    expect(meals.booked).toEqual({ currency: 'USD', revenue: 150, cost: 20, net: 130 });
    expect(meals.forecast).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(meals.pulseReceivedAt).toBe(MEALS_RECEIVED);
    // Arrival is a timestamp; recent coverage is measured separately.
    expect(meals.firstReportAt).toBe("2026-07-03T12:00:00.000Z");
    expect(meals.reportDays).toBe(2);
    expect(meals.dataSources.map(({ id, label, state }) => ({ id, label, state }))).toEqual([
      { id: "nightly-report", label: "Nightly report", state: "live" },
      { id: "gsc", label: "Google Search Console", state: "live" },
      { id: "ga4", label: "Google Analytics 4", state: "live" },
      { id: "bing-webmaster", label: "Bing Webmaster", state: "live" },
    ]);

    const nom = p.assets[1]!;
    expect(nom.worstSeverity).toBe("warn");
    expect(nom.openWarn).toBe(1);
    // Its only July row is an estimate, so nothing is booked here at all.
    expect(nom.booked).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(nom.forecast).toEqual({ currency: 'USD', revenue: 30, cost: 0, net: 30 });
    expect(nom.dataSources.map(({ id, label, state }) => ({ id, label, state }))).toEqual([
      { id: "nightly-report", label: "Nightly report", state: "degraded" },
      { id: "gsc", label: "Google Search Console", state: "not-applicable" },
      { id: "ga4", label: "Google Analytics 4", state: "not-applicable" },
      { id: "bing-webmaster", label: "Bing Webmaster", state: "not-applicable" },
    ]);

    const pft = p.assets[2]!;
    expect(pft.status).toBe("onboarding");
    expect(pft.senseOnly).toBe(true);
    expect(pft.worstSeverity).toBeNull();
    expect(pft.booked).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(pft.forecast).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(cardHasMoney(pft)).toBe(false);
    expect(pft.pulseReceivedAt).toBeNull();
    // Never reported: no first report and no covered dates — and no nightly
    // slot, since a site expects its report only once it has sent one (D29
    // amended, ro-ujb9.121).
    expect(pft.firstReportAt).toBeNull();
    expect(pft.reportDays).toBe(0);
    expect(pft.dataSources.map(({ id, label, state }) => ({ id, label, state }))).toEqual([
      { id: "gsc", label: "Google Search Console", state: "not-applicable" },
      { id: "ga4", label: "Google Analytics 4", state: "not-applicable" },
      { id: "bing-webmaster", label: "Bing Webmaster", state: "not-applicable" },
    ]);
  });

  // An open watch is the asset page's (materiality.ts "outcome-watches": the
  // Wall places it nowhere), so the Wall reads no watch at all (bead
  // `ro-trai.44`) and the asset page still answers for it.
  it("ASSETS: an open watch is the asset page's, and the Wall computes none of it", async () => {
    await insertOpenWatch(ctx, {
      id: "watch-oldest",
      asset: "meals.example",
      registeredAt: "2026-07-01T18:00:00.000Z",
      note: "Homepage answer-card experiment",
      readings: [7],
    });
    await insertOpenWatch(ctx, {
      id: "watch-newer",
      asset: "meals.example",
      registeredAt: "2026-07-02T18:00:00.000Z",
      note: "Meal-plan title experiment",
    });

    const wall = await buildWallPayload(ctx.call, OPTIONS);
    const meals = wall.assets.find((asset) => asset.id === "meals.example")!;
    expect(JSON.stringify(meals)).not.toContain("watch-oldest");
    expect(Object.keys(meals)).not.toContain("activeWatch");

    const detail = await buildAssetDetailPayload(ctx.call, "meals.example", DETAIL_DEPS);
    expect(detail?.watches.open[0]).toMatchObject({
      id: "watch-oldest",
      nextCheckDate: "2026-07-15",
      readings: 1,
      checks: 3,
    });
  });

  it("SIGNALS: reconstructs active-user bars with provisional tails", async () => {
    await insertMealsSignals(ctx);
    const meals = (await buildWallPayload(ctx.call, OPTIONS)).assets[0]!;
    expect(meals.activeUsers).toEqual({
      contextSeries: [],
      series: [
        { t: "2026-07-03", v: 101 },
        { t: "2026-07-04", v: 116 },
        { t: "2026-07-05", v: 48 },
      ],
      provisionalFrom: "2026-07-05",
      collectedAt: "2026-07-05T11:55:00.000Z",
      timeZoneChanges: [],
    });
    // Search history belongs to the asset page now (doc 10, 2026-08-01), and
    // the card carries no field for it at all — the loader still returns it for
    // the page's own call, asserted next.
    const detailTrends = (await loadSignalTrends(ctx.call)).get("meals.example")!;
    expect(detailTrends.webSearchClicks.google.series).toEqual([
      { t: "2026-07-03", v: 12 },
      { t: "2026-07-04", v: 17 },
      { t: "2026-07-05", v: 5 },
    ]);
    expect(detailTrends.webSearchClicks.bing).toEqual({
      contextSeries: [],
      series: [
        { t: "2026-07-03", v: 7 },
        { t: "2026-07-04", v: 9 },
      ],
      provisionalFrom: null,
      collectedAt: "2026-07-05T11:55:00.000Z",
      timeZoneChanges: [],
    });
    expect(detailTrends.webSearchImpressions.google.series).toEqual([
      { t: "2026-07-03", v: 420 },
      { t: "2026-07-04", v: 510 },
      { t: "2026-07-05", v: 180 },
    ]);
    expect(detailTrends.webSearchImpressions.bing.series).toEqual([
      { t: "2026-07-03", v: 140 },
      { t: "2026-07-04", v: 190 },
    ]);
    expect(meals.dataSources.find((source) => source.id === "ga4")).toMatchObject({
      state: "live",
      observedAt: "2026-07-05T11:55:00.000Z",
    });
  });

  it("SIGNALS: the Wall lane reads no search rows at all", async () => {
    await insertMealsSignals(ctx);
    // The card charts neither clicks nor impressions since the work widget took
    // that space, so the Wall must not pay to read either half of the search
    // lane. The asset page's default call, asserted above, still carries
    // both.
    const wall = (
      await loadSignalTrends(ctx.call, 28, { includeWebSearch: false })
    ).get("meals.example")!;
    expect(wall.activeUsers.series).toHaveLength(3);
    expect(wall.webSearchClicks.google.series).toEqual([]);
    expect(wall.webSearchClicks.bing.series).toEqual([]);
    expect(wall.webSearchImpressions.google.series).toEqual([]);
    expect(wall.webSearchImpressions.bing.series).toEqual([]);
  });

  it("SIGNALS: the supporting GA4/GSC series load only when a caller asks for them", async () => {
    await insertMealsSignals(ctx);
    // The 15-minute collectors have been writing these four series since the
    // lane was built, with nothing in the Tower reading them. They belong to the
    // asset page's supporting row, so the Wall must not pay to read them.
    await insertSignalSnapshot(ctx, "ga4", "sessions", [130, 141, 62]);
    await insertSignalSnapshot(ctx, "ga4", "page_views", [410, 455, 190]);
    await insertSignalSnapshot(ctx, "ga4", "event_count", [980, 1044, 430]);
    await insertSignalSnapshot(ctx, "gsc", "ctr", [0.041, 0.052, 0.038]);
    await insertSignalSnapshot(ctx, "gsc", "position", [12.4, 11.8, 12.1]);

    const wall = (
      await loadSignalTrends(ctx.call, 28, { includeWebSearch: false })
    ).get("meals.example")!;
    expect(wall.sessions.series).toEqual([]);
    expect(wall.pageViews.series).toEqual([]);
    expect(wall.events.series).toEqual([]);
    expect(wall.searchCtr.series).toEqual([]);
    expect(wall.searchPosition.series).toEqual([]);

    const detail = (
      await loadSignalTrends(ctx.call, 90, { includeSecondarySeries: true })
    ).get("meals.example")!;
    expect(detail.sessions.series).toEqual([
      { t: "2026-07-03", v: 130 },
      { t: "2026-07-04", v: 141 },
      { t: "2026-07-05", v: 62 },
    ]);
    expect(detail.pageViews.series.at(-1)).toEqual({ t: "2026-07-05", v: 190 });
    expect(detail.events.series.at(-1)).toEqual({ t: "2026-07-05", v: 430 });
    // CTR stays the provider's own 0–1 fraction; the store is never asked to
    // pre-format, so the client owns the percent sign.
    expect(detail.searchCtr.series.at(-1)).toEqual({ t: "2026-07-05", v: 0.038 });
    expect(detail.searchPosition.series.at(-1)).toEqual({
      t: "2026-07-05",
      v: 12.1,
    });
    // The headline series the page already charted are unchanged by the widening.
    expect(detail.activeUsers.series.at(-1)).toEqual({ t: "2026-07-05", v: 48 });
    expect(detail.webSearchImpressions.google.series).toHaveLength(3);
  });

  it("SIGNALS: a reporting-timezone change reaches only its OWN provider's series (bead ro-kukv.11)", async () => {
    await insertMealsSignals(ctx);
    // The payload used to stamp EVERY trend of an asset with EVERY change filed
    // for it. A reporting timezone is a setting on one provider's property: a
    // GA4 property changing its clock changes what a GA4 day is and says
    // nothing at all about what a Search Console day is, so carrying it onto a
    // GSC series would paint a mark that is knowingly wrong.
    await insertSignalSnapshot(ctx, "ga4", "sessions", [130, 141, 62]);
    await insertSignalSnapshot(ctx, "gsc", "ctr", [0.041, 0.052, 0.038]);
    await insertAnnotation(
      ctx,
      "meals.example",
      "2026-07-04T00:00:00.000Z",
      "config",
      "reporting-time-zone-changed:ga4:America/Los_Angeles->America/New_York",
      "GA4 reporting timezone changed",
    );
    // A second provider moved on a different day, so "the asset's changes" and
    // "this series' changes" cannot accidentally agree.
    await insertAnnotation(
      ctx,
      "meals.example",
      "2026-07-05T00:00:00.000Z",
      "config",
      "reporting-time-zone-changed:bing-webmaster:UTC->America/New_York",
      "Bing reporting timezone changed",
    );

    const trends = (
      await loadSignalTrends(ctx.call, 90, { includeSecondarySeries: true })
    ).get("meals.example")!;
    const ga4Change = [
      {
        effectiveOn: "2026-07-04",
        from: "America/Los_Angeles",
        to: "America/New_York",
      },
    ];
    expect(trends.activeUsers.timeZoneChanges).toEqual(ga4Change);
    expect(trends.sessions.timeZoneChanges).toEqual(ga4Change);
    // The Search Console series see neither move: nothing about their day
    // definition changed, so their charts draw ordinary days.
    expect(trends.searchCtr.timeZoneChanges).toEqual([]);
    expect(trends.searchPosition.timeZoneChanges).toEqual([]);
    expect(trends.webSearchClicks.google.timeZoneChanges).toEqual([]);
    expect(trends.webSearchImpressions.google.timeZoneChanges).toEqual([]);
    // And Bing's own move reaches Bing's two series and stops there.
    const bingChange = [
      { effectiveOn: "2026-07-05", from: "UTC", to: "America/New_York",
      },
    ];
    expect(trends.webSearchClicks.bing.timeZoneChanges).toEqual(bingChange);
    expect(trends.webSearchImpressions.bing.timeZoneChanges).toEqual(bingChange);
  });

  it("SIGNALS: the trend read seeks the run log rather than scanning it", async () => {
    // Bead ro-48p.1: `signal_runs` grows ~955 rows a day forever, and this query
    // returns at most eighteen. It used to rank the whole table to find them —
    // EXPLAIN reported `SCAN signal_runs USING INDEX idx_signal_runs_latest`,
    // a full index scan with no seek. Pinned as a PLAN rather than a duration
    // because the cost only shows up at a table size no fixture will ever have.
    await insertMealsSignals(ctx);
    const captured: string[] = [];
    // The series is read on Postgres since bead ro-ujb9.76.5.3: its statement
    // is recorded too.
    const store = ctx.call;
    const spyStore: WorkspaceStore = {
      where: store.where,
      workspaceId: () => store.workspaceId(),
      read: (work) => store.read((tx) => work({
        workspaceId: tx.workspaceId,
        query: (sql, params) => { captured.push(sql); return tx.query(sql, params); },
        execute: (sql, params) => { captured.push(sql); return tx.execute(sql, params); },
      })),
      write: (work) => store.write(work),
      close: () => store.close(),
    };
    await loadSignalTrends(spyStore, 28, { includeWebSearch: false, nowMs: NOW_MS });
    // TWO reads since ro-tzq: the series, and the reporting-timezone changes
    // that say which day-definition each point was measured under. The
    // invariant this test defends is about SCANNING `signal_runs`, not about
    // the query count. Both are on Postgres; the changes are annotations
    // (bead ro-ujb9.76.5.7): that read touches no run log, and its plan,
    // bound from the earliest charted point since ro-ujb9.102, is pinned in
    // signal-trends.test.ts.
    expect(captured).toHaveLength(2);
    expect(captured[1]).toBe(timeZoneChangesSql(0));

    // On Postgres, a table scan forbidden as an empty table is cheapest to
    // scan: the latest success per lane is a seek down the (asset,
    // integration, finished_at) index, and no read scans the run log.
    const plan = (await store.read(async (tx) => {
      await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
      return tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${captured[0]!}`, ["2025-01-01T00:00:00.000Z", 34]);
    })).map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).not.toMatch(/Seq Scan on signal_runs/);
    expect(plan).toMatch(/Index Scan using signal_runs_latest on signal_runs candidate/);
  });

  it("SIGNALS: one asset's trend is the portfolio's, narrowed — not a second query", async () => {
    // Bead ro-48p.2: the asset page used to compute every asset's
    // ninety-seven-day trend and keep one of them, every sixty seconds. It now
    // passes an asset, and that asset is pushed into the SQL. The risk a
    // narrowed read introduces is DIVERGENCE — two surfaces stating different
    // numbers for one asset is the failure sharing one derivation prevents
    // (ro-elf) — so the two call shapes are held to exact equality here.
    const ctx2 = await createTestStore();
    await insertAsset(ctx2, "meals.example", "Meal Planner", "live", 0, 0);
    await insertAsset(ctx2, "nosh.example", "Nosh", "live", 0, 0);
    // Two assets, different series, so narrowing has something to drop.
    await insertSignalSnapshot(ctx2, "ga4", "active_users", [101, 116, 48]);
    await insertSignalSnapshot(ctx2, "gsc", "clicks", [12, 17, 5]);
    await insertSignalSnapshot(ctx2, "gsc", "ctr", [0.041, 0.052, 0.038]);
    await insertSignalSnapshot(ctx2, "bing-webmaster", "impressions", [140, 190]);
    await insertSignalSnapshot(
      ctx2,
      "ga4",
      "active_users",
      [7, 9, 11],
      "2026-07-03",
      "nosh.example",
    );

    const options = { includeSecondarySeries: true, nowMs: NOW_MS };
    const portfolio = await loadSignalTrends(ctx2.call, 90, options);
    const single = await loadSignalTrends(ctx2.call, 90, {
      ...options,
      asset: "meals.example",
    });

    // Same points, same provisional flags, same collectedAt, same ordering —
    // the whole trend set, compared structurally rather than field by field.
    expect(single.get("meals.example")).toEqual(portfolio.get("meals.example"));
    expect(single.get("meals.example")!.activeUsers.series).toEqual([
      { t: "2026-07-03", v: 101 },
      { t: "2026-07-04", v: 116 },
      { t: "2026-07-05", v: 48 },
    ]);
    // And the narrowing happened in the store, not after it: the other
    // asset is in the portfolio map and absent from the single-asset one.
    expect(portfolio.has("nosh.example")).toBe(true);
    expect([...single.keys()]).toEqual(["meals.example"]);
  });

  it("SIGNALS: compact Wall asset charts stay capped at four complete weeks", async () => {
    const ctx2 = await createTestStore();
    await insertAsset(ctx2, "meals.example", "Meal Planner", "live", 0, 0);
    await insertSignalSnapshot(
      ctx2,
      "ga4",
      "active_users",
      Array.from({ length: 35 }, (_, index) => index + 1),
      "2026-06-01",
    );

    const activeUsers = (await buildWallPayload(ctx2.call, OPTIONS)).assets[0]!
      .activeUsers;
    expect(activeUsers.series).toHaveLength(28);
    expect(activeUsers.series[0]).toEqual({ t: "2026-06-08", v: 8 });
    expect(activeUsers.series.at(-1)).toEqual({ t: "2026-07-05", v: 35 });
    expect(activeUsers.contextSeries).toEqual(
      Array.from({ length: 7 }, (_, index) => ({
        t: `2026-06-${String(index + 1).padStart(2, "0")}`,
        v: index + 1,
      })),
    );
  });

  it("ANCHORS: each row's current value rides in the payload, not off the series", async () => {
    await seedLedger(ctx);
    const p = await buildWallPayload(ctx.call, OPTIONS);

    // Net anchor = THIS period's BOOKED net (150 − 20), named with its period.
    const meals = p.assets[0]!;
    expect(meals.booked.net!).toBe(130);
    expect(meals.netPeriod).toBe("2026-07");

    const nom = p.assets[1]!;
    expect(nom.forecast.net!).toBe(30);

    // No current ledger rows — both money sides are empty, so the row grows
    // no accounting block.
    const pft = p.assets[2]!;
    expect(cardHasMoney(pft)).toBe(false);
    expect(pft.netPeriod).toBe("2026-07");
  });

  // --- bead ro-uwo.2: the split doc 19 finding 4 named, one grain down -------
  it("NET: an asset's stated net is its RECONCILED rows, estimates beside it", async () => {
    await seedLedger(ctx);
    // The mixed asset: one reconciled pair already in the seed (150 revenue,
    // 20 cost) plus three estimates nobody has confirmed. The old card summed
    // all five into one "net · Jul" of 1,030.
    await insertLedger(ctx, { id: 20, kind: "revenue", asset: "meals.example", period: "2026-07", family: "affiliate", amount: 600, booking_state: "estimated", recorded_at: "2026-07-05T00:00:00.000Z" });
    await insertLedger(ctx, { id: 21, kind: "revenue", asset: "meals.example", period: "2026-07", family: "subs", amount: 340, booking_state: "estimated", recorded_at: "2026-07-05T00:00:00.000Z" });
    await insertLedger(ctx, { id: 22, kind: "cost", asset: "meals.example", period: "2026-07", family: "infra", amount: 40, booking_state: "estimated", recorded_at: "2026-07-05T00:00:00.000Z" });

    const p = await buildWallPayload(ctx.call, OPTIONS);
    const meals = p.assets[0]!;
    expect(meals.booked).toEqual({ currency: 'USD', revenue: 150, cost: 20, net: 130 });
    expect(meals.forecast).toEqual({ currency: 'USD', revenue: 940, cost: 40, net: 900 });
    // The mixed total the card used to publish exists nowhere in its payload.
    const mixed = meals.booked.net! + meals.forecast.net!;
    expect(mixed).toBe(1030);
    expect(Object.values(meals.booked)).not.toContain(mixed);
    expect(Object.values(meals.forecast)).not.toContain(mixed);
  });

  it("NET: every card's booked money adds up to the headline above it", async () => {
    await seedLedger(ctx);
    // The asset the bead is about: the Wall renders one booked headline and
    // three cards under it, and an operator can add the cards up. Mixed rows on
    // two assets, so this is not a one-row coincidence.
    await insertLedger(ctx, { id: 20, kind: "revenue", asset: "meals.example", period: "2026-07", family: "affiliate", amount: 600, booking_state: "estimated", recorded_at: "2026-07-05T00:00:00.000Z" });
    await insertLedger(ctx, { id: 21, kind: "revenue", asset: "nosh.example", period: "2026-07", family: "subs", amount: 12.34, booking_state: "reconciled", recorded_at: "2026-07-05T00:00:00.000Z" });
    await insertLedger(ctx, { id: 22, kind: "cost", asset: "pacer.example", period: "2026-07", family: "infra", amount: 5.67, booking_state: "reconciled", recorded_at: "2026-07-05T00:00:00.000Z" });

    const p = await buildWallPayload(ctx.call, OPTIONS);
    const sum = (pick: (card: (typeof p.assets)[number]) => number) =>
      p.assets.reduce((total, card) => total + pick(card), 0);

    expect(sum((c) => c.booked.revenue!)).toBeCloseTo(p.portfolio.booked.revenue!, 10);
    expect(sum((c) => c.booked.cost!)).toBeCloseTo(p.portfolio.booked.cost!, 10);
    expect(sum((c) => c.booked.net!)).toBeCloseTo(p.portfolio.booked.net!, 10);
    expect(sum((c) => c.forecast.net!)).toBeCloseTo(p.portfolio.forecast.net!, 10);
    // …and it is a real headline, not zero on both sides.
    expect(p.portfolio.booked.net!).toBeCloseTo(130 + 12.34 - 5.67, 10);
    // Every row belongs to an asset, so there is nothing left over.
    expect(p.portfolio.residue.booked).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(p.portfolio.residue.forecast).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
  });

  it("NET: a row against asset #0 is named, so the cards still reconcile (bead ro-t0z)", async () => {
    // The store the invariant above could not survive: the headline sums EVERY
    // asset and the ASSETS band excludes the OS, so this row is inside the
    // figure and on no card. Nothing writes one today — revenue.ts has no is_os
    // guard, so one POST is all it takes — and the Wall used to show no sign.
    await insertLedger(ctx, { id: 30, kind: "revenue", asset: "nosh.example", period: "2026-07", family: "subs", amount: 12.34, booking_state: "reconciled", recorded_at: "2026-07-05T00:00:00.000Z" });
    await insertLedger(ctx, { id: 31, kind: "cost", asset: "root-os", period: "2026-07", family: "infra", amount: 41.5, booking_state: "reconciled", recorded_at: "2026-07-05T00:00:00.000Z" });
    await insertLedger(ctx, { id: 32, kind: "cost", asset: "root-os", period: "2026-07", family: "infra", amount: 12, booking_state: "estimated", recorded_at: "2026-07-05T00:00:00.000Z" });

    const p = await buildWallPayload(ctx.call, OPTIONS);
    const sum = (pick: (card: (typeof p.assets)[number]) => number) =>
      p.assets.reduce((total, card) => total + pick(card), 0);

    // The OS has no card of its own.
    expect(p.assets.some((card) => card.id === "root-os")).toBe(false);
    // The cards alone no longer reach the headline — that is the defect.
    expect(sum((c) => c.booked.net!)).not.toBeCloseTo(p.portfolio.booked.net!, 10);
    // …and the difference is exactly what the band states.
    expect(p.portfolio.residue.booked).toEqual({ currency: 'USD', revenue: 0, cost: 41.5, net: -41.5 });
    expect(p.portfolio.residue.forecast).toEqual({ currency: 'USD', revenue: 0, cost: 12, net: -12 });
    expect(sum((c) => c.booked.net!) + p.portfolio.residue.booked.net!).toBeCloseTo(
      p.portfolio.booked.net!,
      10,
    );
    expect(sum((c) => c.forecast.net!) + p.portfolio.residue.forecast.net!).toBeCloseTo(
      p.portfolio.forecast.net!,
      10,
    );
    // Revenue and cost reconcile too, not just the net.
    expect(sum((c) => c.booked.cost!) + p.portfolio.residue.booked.cost!).toBeCloseTo(
      p.portfolio.booked.cost!,
      10,
    );
    expect(sum((c) => c.booked.revenue!) + p.portfolio.residue.booked.revenue!).toBeCloseTo(
      p.portfolio.booked.revenue!,
      10,
    );
  });

  it("NET: an asset with only estimates books nothing, and says so in its own field", async () => {
    await seedLedger(ctx);
    // nom's July is one estimated row. `booked` is three zeroes rather than a
    // null, so the card has a shape to render and never a number to mistake.
    const nom = (await buildWallPayload(ctx.call, OPTIONS)).assets[1]!;
    expect(nom.booked).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(figureHasMoney(nom.booked)).toBe(false);
    expect(nom.forecast).toEqual({ currency: 'USD', revenue: 30, cost: 0, net: 30 });
    expect(cardHasMoney(nom)).toBe(true);
  });

  it("NET: a fully reconciled asset carries no forecast at all", async () => {
    await seedLedger(ctx);
    // meals's July is reconciled end to end (its estimate was superseded), so
    // the forecast side is empty and the card draws no second line.
    const meals = (await buildWallPayload(ctx.call, OPTIONS)).assets[0]!;
    expect(figureHasMoney(meals.booked)).toBe(true);
    expect(figureHasMoney(meals.forecast)).toBe(false);
    expect(cardHasMoney(meals)).toBe(true);
  });

  it("NET: a card's net is subtracted in cents, not in dollars", async () => {
    // The trap pair from bead ro-wtt: 1809.65 − 866.40 is 943.2500000000001
    // once either side has left integer cents. One asset, so the card and
    // the headline are the same money read twice — they must not disagree.
    const ctx2 = await createTestStore();
    await insertAsset(ctx2, "meals.example", "Meal Planner", "live", 0, 0);
    await insertLedger(ctx2, { id: 1, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 1809.65, booking_state: "reconciled", recorded_at: "2026-07-04T00:00:00.000Z" });
    await insertLedger(ctx2, { id: 2, kind: "cost", asset: "meals.example", period: "2026-07", family: "infra", amount: 866.4, booking_state: "reconciled", recorded_at: "2026-07-04T00:00:00.000Z" });

    const p = await buildWallPayload(ctx2.call, OPTIONS);
    expect(p.assets[0]!.booked.net!).toBe(943.25);
    expect(p.portfolio.booked.net!).toBe(943.25);
  });

  it("NET: a card's money is exact cents, like the headline it rolls into", async () => {
    // Float dollars sum these four to 758.1999999999999 (doc 19 finding 1). The
    // card reads the same integer-cents column the portfolio band does.
    for (const [id, amount] of [[20, 512.4], [21, 168.2], [22, 55.5], [23, 22.1]] as const) {
      await insertLedger(ctx, { id, kind: "revenue", asset: "nosh.example", period: "2026-08", family: "ads", amount, booking_state: "reconciled", recorded_at: "2026-08-01T00:00:00.000Z" });
    }
    const p = await buildWallPayload(ctx.call, { ...OPTIONS, now: new Date("2026-08-05T12:00:00.000Z") });
    expect(p.assets[1]!.booked.revenue!).toBe(758.2);
    expect(p.assets[1]!.booked.net!).toBe(p.portfolio.booked.net!);
  });

  it("NET: the current monthly value is independent of history volume", async () => {
    // 18 months of ledger: the card contract carries only the current accounting
    // fact, not an unused copy of portfolio history.
    const ctx2 = await createTestStore();
    await insertAsset(ctx2, "meals.example", "Meal Planner", "live", 0, 0);
    // 2025-02 … 2026-07, the last one being NOW's period.
    for (let i = 0; i < 18; i += 1) {
      const month = i + 1;
      const period = `${2025 + Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, "0")}`;
      await insertLedger(ctx2, {
        id: i + 1,
        kind: "revenue",
        asset: "meals.example",
        period,
        family: "ads",
        amount: 10 + i,
        booking_state: "reconciled",
        recorded_at: `${period}-01T00:00:00.000Z`,
      });
    }
    const card = (await buildWallPayload(ctx2.call, OPTIONS)).assets[0]!;
    expect(card.netPeriod).toBe("2026-07");
    expect(card.booked.net!).toBe(27);
  });

  // A site's all-time totals left the Wall with D28 and live on its Overview,
  // from the asset page's own read (bead `ro-trai.21`); the Wall reads none of
  // them (bead `ro-trai.44`). Same store, same rule, read where it is drawn.
  async function siteTotals(store: TestStore, asset: string, deps: AssetDetailDeps = DETAIL_DEPS) {
    return (await buildAssetDetailPayload(store.call, asset, deps))!.counters!;
  }

  it("COUNTERS: the Wall restores the same labelled totals as Overview", async () => {
    await seedReportsAndAlerts(ctx);
    const p = await buildWallPayload(ctx.call, OPTIONS);
    for (const id of ["meals.example", "nosh.example"]) {
      const detail = await siteTotals(ctx, id);
      expect(p.assets.find((card) => card.id === id)!.counters).toEqual({
        ...detail, defaultMetrics: detail.cards.map((card) => card.metric),
      });
    }
    expect((await siteTotals(ctx, "nosh.example")).heading).toBe("Current catalog");
    expect((await siteTotals(ctx, "meals.example")).heading).toBe("All-time totals");
  });

  it("COUNTERS: Wall values preserve zero, missing and stale single-lane totals", async () => {
    await seedReportsAndAlerts(ctx);
    const staleAt = new Date(NOW_MS - 7 * DAY).toISOString();
    await insertCounterReading(ctx, "meals.example", "signups", 9000, staleAt);
    await insertCounterReading(ctx, "meals.example", "plansSaved", 0, NOW.toISOString());
    await insertCounterReading(ctx, "meals.example", "oldCatalog", 14, staleAt);
    const wall = await buildWallPayload(ctx.call, { ...OPTIONS, schedules: { counters: { enabled: true, cron: "0 * * * *" } } });
    const totals = wall.assets.find((card) => card.id === "meals.example")!.counters!;
    expect(totals.cadenceHours).toBe(1);
    expect(totals.defaultMetrics).toEqual(["signups", "plansSaved", "leads"]);
    expect(totals.cards).toEqual([
      { metric: "signups", label: "Accounts", value: 4233, observedAt: MEALS_RECEIVED, source: "nightly" },
      { metric: "plansSaved", label: "Plans saved", value: 0, observedAt: NOW.toISOString(), source: "counters" },
      { metric: "leads", label: "Leads", value: null, observedAt: null, source: null },
      { metric: "oldCatalog", label: "Old catalog", value: 14, observedAt: staleAt, source: "counters" },
    ]);
    expect(isAmber(NOW_MS, staleAt, totals.cadenceHours)).toBe(true);
    expect((await buildWallPayload(ctx.call, OPTIONS)).assets.find((card) => card.id === "pacer.example")!.counters)
      .toMatchObject({ cards: [], defaultMetrics: [] });
  });

  it("COUNTERS: discovery reads the newest report revision, not a late backfill or historical metric", async () => {
    await insertPulse(ctx, "pacer.example", "2026-07-04", NOW.toISOString(), {
      historicalOnly: { last24h: 10, total: 999 },
    });
    await insertPulse(ctx, "pacer.example", "2026-07-05", MEALS_RECEIVED, {
      signups: { last24h: 1, total: 12 }, oldRevisionOnly: { last24h: 1, total: 8 },
    });
    await insertPulse(ctx, "pacer.example", "2026-07-05", MEALS_RECEIVED, {
      signups: { last24h: 2, total: 0 }, plansSaved: { last24h: 10, total: 77 },
      dailyOnly: { last24h: 90 },
    });
    await insertCounterReading(ctx, "pacer.example", "leads", 21, NOW.toISOString());
    const statements: string[] = [];
    const wall = await buildWallPayload(recordingStore(ctx.call, statements), OPTIONS);
    const totals = wall.assets.find((card) => card.id === "pacer.example")!.counters!;
    expect(totals.defaultMetrics).toEqual([]);
    expect(totals.cards).toEqual([
      { metric: "leads", label: "Leads", value: 21, observedAt: NOW.toISOString(), source: "counters" },
      { metric: "plansSaved", label: "Plans saved", value: 77, observedAt: MEALS_RECEIVED, source: "nightly" },
      { metric: "signups", label: "Signups", value: 0, observedAt: MEALS_RECEIVED, source: "nightly" },
    ]);
    expect(statements.filter((sql) => sql === LATEST_COUNTER_TOTALS_SQL)).toHaveLength(1);
    expect(statements.filter((sql) => sql.includes("FROM noticeos.counter_readings"))).toHaveLength(1);
  });

  it("COUNTERS: a total with a reading takes its value and age from the fast lane", async () => {

    await seedReportsAndAlerts(ctx);
    await insertMealsReadings(ctx);
    const users = (await siteTotals(ctx, "meals.example")).cards.find((c) => c.metric === "signups")!;
    expect(users.label).toBe("Accounts");
    expect(users.value).toBe(4310);
    expect(users.observedAt).toBe(new Date(NOW_MS - 5 * 60_000).toISOString());
    expect(users.source).toBe("counters");
  });

  it("COUNTERS: a reading wins over the nightly total even when the total is LARGER", async () => {

    await seedReportsAndAlerts(ctx);
    // plansSaved: reading 1900 vs last night's total 1907. Freshness decides
    // which lane owns the number — never magnitude.
    await insertMealsReadings(ctx);
    const plans = (await siteTotals(ctx, "meals.example")).cards.find((c) => c.metric === "plansSaved")!;
    expect(plans.value).toBe(1900);
    expect(plans.source).toBe("counters");
  });

  it("COUNTERS: a STALE reading loses to a newer nightly total — freshest lane, not presence", async () => {
    // The fast lane stopped a week ago; last night's report is the newer fact,
    // so the site must carry the report's number and the report's age.
    const ctx2 = await createTestStore();
    await insertAsset(ctx2, "meals.example", "Meal Planner", "live", 0, 0);
    await insertPulse(ctx2, "meals.example", "2026-07-05", MEALS_RECEIVED, {
      signups: { last24h: 15, avg7d: 11, total: 4400 },
    });
    await insertCounterReading(
      ctx2,
      "meals.example",
      "signups",
      4310,
      new Date(NOW_MS - 7 * DAY).toISOString(),
    );

    const users = (await siteTotals(ctx2, "meals.example")).cards.find((c) => c.metric === "signups")!;
    expect(users.value).toBe(4400);
    expect(users.observedAt).toBe(MEALS_RECEIVED);
    expect(users.source).toBe("nightly");
  });

  it("COUNTERS: with no reading, a total falls back to the latest nightly report", async () => {

    await seedReportsAndAlerts(ctx);
    // Nosh has no scrape source at all — its totals exist purely on this fallback,
    // and their age is the report's received_at, not a counters read.
    const nom = await siteTotals(ctx, "nosh.example");
    expect(nom.cards).toEqual([{
      metric: "items",
      label: "Items",
      value: 12954,
      observedAt: NOM_RECEIVED,
      source: "nightly",
    }]);
  });

  it("COUNTERS: an entry neither lane has stays null — the site skips it, never zero", async () => {

    await seedReportsAndAlerts(ctx);
    await insertMealsReadings(ctx);
    const leads = (await siteTotals(ctx, "meals.example")).cards.find((c) => c.metric === "leads")!;
    expect(leads.value).toBeNull();
    expect(leads.observedAt).toBeNull();
    expect(leads.source).toBeNull();
  });

  it("COUNTERS: config order decides the row", async () => {

    await seedReportsAndAlerts(ctx);
    await insertMealsReadings(ctx);
    expect((await siteTotals(ctx, "meals.example")).cards.map((c) => c.metric)).toEqual([
      "signups",
      "plansSaved",
      "leads",
    ]);
  });

  it("COUNTERS: none for an asset that declares none (the site grows no row)", async () => {
    // pacer is absent from the config entirely.
    expect((await buildAssetDetailPayload(ctx.call, "pacer.example", DETAIL_DEPS))!.counters).toBeNull();
    // An asset present but with an empty card list is the same designed nothing.
    const stubbed = await buildAssetDetailPayload(ctx.call, "nosh.example", {
      ...DETAIL_DEPS,
      counters: { assets: { "nosh.example": { cards: [] } } },
    });
    expect(stubbed!.counters).toBeNull();
  });

  it("ATTENTION: only open error/warn, error before warn", async () => {

    await seedReportsAndAlerts(ctx);
    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.attention).toHaveLength(2);
    expect(p.attention[0]).toMatchObject({ asset: "meals.example", severity: "error", kind: "anomaly" });
    expect(p.attention[1]).toMatchObject({ asset: "nosh.example", severity: "warn", kind: "anomaly" });
  });

  /**
   * ro-kukv.1. Measured on the live store 2026-08-31: sixteen of twenty-six open
   * flags were `asset-declared` on nosh.example, one per night for four weeks, every
   * one re-stating the same standing condition against a fresh reading.
   */
  it("ATTENTION: a declared recurring rule is ONE row carrying its firing count", async () => {
    await seedReportsAndAlerts(ctx);
    const nightly = ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"];
    for (const day of nightly) {
      await insertFlag(ctx, {
        asset: "nosh.example",
        fired_at: `${day}T02:00:00.000Z`,
        severity: "warn",
        kind: "anomaly",
        rule_id: "asset-declared",
        metric: "apiRequests",
        message: "below baseline",
      });
    }
    const p = await buildWallPayload(ctx.call, OPTIONS);
    const rows = p.attention.filter((a) => a.ruleId === "asset-declared");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      asset: "nosh.example",
      occurrences: 4,
      // The NEWEST reading represents the group — the numbers an operator would
      // act on — while the age comes from the onset.
      firedAt: "2026-07-04T02:00:00.000Z",
      firstFiredAt: "2026-07-01T02:00:00.000Z",
    });
  });

  /**
   * The counter-example that decided the design, and the reason the obvious key
   * (asset, rule_id, metric) is NOT used on its own: `watch-window-closed` fires
   * twice on one asset with one metric, and each firing asks a different
   * question. Merging them would hide a decision — strictly worse than noise.
   */
  it("ATTENTION: an undeclared rule keeps a row per firing, even when it repeats", async () => {
    await seedReportsAndAlerts(ctx);
    for (const id of ["aaa", "bbb"]) {
      await insertFlag(ctx, {
        asset: "meals.example",
        fired_at: "2026-07-04T02:00:00.000Z",
        severity: "warn",
        kind: "anomaly",
        rule_id: "watch-window-closed",
        metric: "position",
        message: "watch window closed",
        rule_inputs: { watchWindowId: id },
      });
    }
    const p = await buildWallPayload(ctx.call, OPTIONS);
    const rows = p.attention.filter((a) => a.ruleId === "watch-window-closed");

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.occurrences === 1)).toBe(true);
  });

  it("ATTENTION: an ordinary single event reports occurrences 1 and dates itself", async () => {

    await seedReportsAndAlerts(ctx);
    const p = await buildWallPayload(ctx.call, OPTIONS);
    for (const row of p.attention) {
      expect(row.occurrences).toBe(1);
      expect(row.firstFiredAt).toBe(row.firedAt);
    }
  });

  /**
   * ro-kukv.5 — THE ANTI-DRIFT TEST. The Wall and the asset page read DIFFERENT
   * payloads over the same store, and until this bead they counted the same
   * condition differently: nosh.example's `asset-declared` condition was one row
   * reading "16× in 26d" on the Wall and sixteen identical rows on the asset
   * page. An operator moving between the two screens saw two portfolios.
   *
   * Both builders now call `groupConditionFirings`, so this pins the ONE thing a
   * future change could quietly break: the same store, read twice, answering the
   * same number and the same onset.
   */
  it("GROUPING: the Wall and the asset page count one condition identically", async () => {
    await seedReportsAndAlerts(ctx);
    // Sixteen nightly firings, exactly the shape measured on the live store.
    const nights = Array.from({ length: 16 }, (_, index) =>
      new Date(Date.UTC(2026, 5, 20 + index, 2, 0, 0)).toISOString(),
    );
    for (const firedAt of nights) {
      await insertFlag(ctx, {
        asset: "nosh.example",
        fired_at: firedAt,
        severity: "warn",
        kind: "anomaly",
        rule_id: "asset-declared",
        metric: "apiRequests",
        message: "below baseline",
      });
    }
    // A valid, fresh report still covers and declares this metric. This proves
    // recent confirmation independently from the sixteen historical firings.
    const envelope = PulseEnvelope.parse({
      asset: "nosh.example",
      generatedAt: "2026-07-05T02:00:00.000Z",
      capabilities: ["apiRequests"],
      metrics: { apiRequests: { last24h: 0, avg7d: 11, total: 100 } },
      flags: [{ severity: "warn", kind: "anomaly", metric: "apiRequests", msg: "below baseline" }],
    });
    await storeReport(ctx.call, {
      asset: "nosh.example",
      date: "2026-07-05",
      generatedAt: envelope.generatedAt,
      receivedAt: new Date(NOW_MS - 6 * HOUR).toISOString(),
      capabilities: envelope.capabilities,
      envelope,
    });

    const wall = await buildWallPayload(ctx.call, OPTIONS);
    const page = (await buildAssetDetailPayload(ctx.call, "nosh.example", DETAIL_DEPS))!;

    const band = wall.attention.filter((row) => row.ruleId === "asset-declared");
    const signals = page.flags.open.filter((row) => row.ruleId === "asset-declared");

    // One row on each surface, and the row says the same thing on both.
    expect(band).toHaveLength(1);
    expect(signals).toHaveLength(1);
    expect(band[0]!.occurrences).toBe(16);
    expect(signals[0]!.occurrences).toBe(16);
    expect(signals[0]!.firstFiredAt).toBe(band[0]!.firstFiredAt);
    expect(signals[0]!.firstFiredAt).toBe(nights[0]);
    // The newest reading represents the group on both — the numbers to act on.
    expect(signals[0]!.firedAt).toBe(band[0]!.firedAt);
    expect(signals[0]!.firedAt).toBe(nights.at(-1));
    expect(signals[0]!.liveness.state).toBe("live");
    expect(signals[0]!.verification).toMatchObject({
      state: "confirmed",
      lastConfirmedAt: "2026-07-05T06:00:00.000Z",
      lastEvaluatedAt: "2026-07-05T06:00:00.000Z",
    });
    expect(band[0]!.verification).toEqual(signals[0]!.verification);

    // Warning badges count the two conditions, matching actionable rows. The
    // full seventeen firings remain available as occurrence counts.
    const card = wall.assets.find((asset) => asset.id === "nosh.example")!;
    expect(page.flags.openWarn).toBe(card.openWarn);
    expect(page.flags.openError).toBe(card.openError);
    expect(card.openWarn).toBe(2); // one declared condition + one central warn
    expect(page.flags.open).toHaveLength(2);
    expect(page.flags.open.reduce((sum, row) => sum + row.occurrences, 0)).toBe(17);
  });

  /**
   * The same counter-example the Wall is held to, on the asset page: an
   * undeclared rule firing twice with one metric asks two questions, and merging
   * them would answer one the operator never read.
   */
  it("GROUPING: the asset page keeps an undeclared rule's firings apart", async () => {
    await seedReportsAndAlerts(ctx);
    for (const id of ["aaa", "bbb"]) {
      await insertFlag(ctx, {
        asset: "meals.example",
        fired_at: "2026-07-04T02:00:00.000Z",
        severity: "warn",
        kind: "anomaly",
        rule_id: "watch-window-closed",
        metric: "position",
        message: "watch window closed",
        rule_inputs: { watchWindowId: id },
      });
    }
    const page = (await buildAssetDetailPayload(ctx.call, "meals.example", DETAIL_DEPS))!;
    const rows = [...page.flags.open, ...page.flags.notCurrent].filter(
      (row) => row.ruleId === "watch-window-closed",
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.occurrences === 1)).toBe(true);
  });

  // Stored legacy flags keep their identities; retired current-state grouping is absent.
  it("ATTENTION: historical silence flags remain ordinary asset alerts with their own identities", async () => {
    await seedReportsAndAlerts(ctx);
    await insertAsset(ctx, "fees.example", "Fee Codes", "onboarding", 1, 0);
    await insertAsset(ctx, "pullups.example", "Pull-up Standards", "onboarding", 1, 0);
    await insertAsset(ctx, "areas.info", "Area Lookup", "onboarding", 1, 0);
    const silent: [string, string][] = [
      ["fees.example", "2026-06-08T04:00:00.000Z"],
      ["pullups.example", "2026-06-09T04:00:00.000Z"],
      ["areas.info", "2026-06-10T04:00:00.000Z"],
      ["pacer.example", "2026-06-11T04:00:00.000Z"],
    ];
    for (const [asset, firedAt] of silent) {
      await insertFlag(ctx, {
        asset,
        fired_at: firedAt,
        severity: "error",
        kind: "anomaly",
        rule_id: "ingest-freshness",
        metric: "pulse",
        message: `no pulse ever received (registered ${firedAt})`,
        rule_inputs: {
          rule: "ingest-freshness",
          state: "never-reported",
          registeredAt: firedAt,
          thresholdHours: 36,
        },
      });
    }

    const p = await buildWallPayload(ctx.call, OPTIONS);
    const never = p.attention.filter(
      (a) => a.ruleId === "ingest-freshness" && a.ruleInputs?.state === "never-reported",
    );

    expect(never).toHaveLength(4);
    expect(never.every(item => item.members === undefined && item.occurrences === 1)).toBe(true);
    expect(new Set(never.map(item => item.id)).size).toBe(4);
    expect(never.map(item => item.firstFiredAt).sort()).toEqual(silent.map(([, at]) => at).sort());
    expect(never.map(item => item.asset).sort()).toEqual(silent.map(([asset]) => asset).sort());
  });

  it("ATTENTION: the OTHER ingest-freshness failure — a lane that broke — is left alone", async () => {

    await seedReportsAndAlerts(ctx);
    // Current stale reports and historical flags remain separate asset alerts.
    await insertAsset(ctx, "fees.example", "Fee Codes", "onboarding", 1, 0);
    for (const asset of ["fees.example", "pacer.example"]) {
      await insertFlag(ctx, {
        asset,
        fired_at: "2026-06-10T04:00:00.000Z",
        severity: "error",
        kind: "anomaly",
        rule_id: "ingest-freshness",
        metric: "pulse",
        message: "no pulse ever received",
        rule_inputs: { rule: "ingest-freshness", state: "never-reported" },
      });
    }

    const p = await buildWallPayload(ctx.call, OPTIONS);
    const freshness = p.attention.filter((a) => a.ruleId === "ingest-freshness");

    expect(freshness).toHaveLength(3);
    const stale = freshness.find((a) => a.asset === "meals.example")!;
    expect(stale.members).toBeUndefined();
    expect(stale.occurrences).toBe(1);
  });

  it("ATTENTION: a LONE never-reported asset stays an ordinary row — no group of one", async () => {

    await seedReportsAndAlerts(ctx);
    // One asset that has never reported renders exactly as it always did: no
    // members, no plural sentence, no disclosure hiding a single row from itself.
    await insertFlag(ctx, {
      asset: "pacer.example",
      fired_at: "2026-06-11T04:00:00.000Z",
      severity: "error",
      kind: "anomaly",
      rule_id: "ingest-freshness",
      metric: "pulse",
      message: "no pulse ever received",
      rule_inputs: { rule: "ingest-freshness", state: "never-reported" },
    });

    const p = await buildWallPayload(ctx.call, OPTIONS);
    const lone = p.attention.find(
      (a) => a.ruleId === "ingest-freshness" && a.ruleInputs?.state === "never-reported",
    )!;

    expect(lone.members).toBeUndefined();
    expect(lone.occurrences).toBe(1);
    expect(lone.asset).toBe("pacer.example");
  });

  it("ATTENTION: ships the rule's id and parsed inputs, so the client can translate", async () => {

    await seedReportsAndAlerts(ctx);
    const p = await buildWallPayload(ctx.call, OPTIONS);

    const nom = p.attention.find((a) => a.asset === "nosh.example")!;
    expect(nom.ruleId).toBe("flow-poisson-low");
    expect(nom.ruleInputs).toMatchObject({ observed: 12, baselinePerDay: 55 });
    // The rule's own words still ride along, verbatim — the audit trail and the
    // fallback for any rule the translator hasn't met.
    expect(nom.message).toBe("12 in last24h (avg7d 55.0, P(<=12)~=0.0000)");
  });

  it("ATTENTION: a flag with no stored rule_inputs degrades to null, never throws", async () => {

    await seedReportsAndAlerts(ctx);
    await insertFlag(ctx, {
      asset: "nosh.example",
      fired_at: "2026-07-05T08:00:00.000Z",
      severity: "warn",
      kind: "anomaly",
      rule_id: "some-future-rule",
      message: "something the ingest lane started saying",
    });
    const p = await buildWallPayload(ctx.call, OPTIONS);
    const row = p.attention.find((a) => a.ruleId === "some-future-rule")!;
    expect(row.ruleInputs).toBeNull();
    expect(row.message).toBe("something the ingest lane started saying");
  });

  it("ATTENTION: correlates only changes inside the window BEFORE each alert", async () => {

    await seedReportsAndAlerts(ctx);
    await insertAnnotation(ctx, "meals.example", "2026-07-04T19:00:00.000Z", "deploy", "a1b2c3d", "ship product cards");
    await insertAnnotation(ctx, "meals.example", "2026-06-28T12:00:00.000Z", "deploy", "0ldc0de", "older deploy");
    await insertAnnotation(ctx, "nosh.example", "2026-07-05T18:00:00.000Z", "config", "config@9f2c", "threshold tuned after the alert");
    const p = await buildWallPayload(ctx.call, OPTIONS);

    // meals's alert fired 2026-07-05T09:00Z; the 07-04T19:00 deploy is 14h
    // before it. The 06-28 deploy is far outside the 48h window.
    const meals = p.attention.find((a) => a.asset === "meals.example")!;
    expect(meals.correlatedChanges.map((c) => c.ref)).toEqual(["a1b2c3d"]);

    // Nosh's only annotation is 8h AFTER its alert — it explains nothing.
    const nom = p.attention.find((a) => a.asset === "nosh.example")!;
    expect(nom.correlatedChanges).toEqual([]);
  });

  it("ATTENTION: reads each site's changes in the window through its (site, time) index (ro-ujb9.76.5.7)", async () => {
    const plan = await (ctx.call).read(async (tx) => {
      // An empty table is cheapest to scan; forbidding that shows the plan
      // the index offers once changes pile up.
      await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
      const rows = await tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${WALL_CHANGES_SQL}`, ["2026-07-03T00:00:00.000Z", "2026-07-05T09:00:00.000Z"]);
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toMatch(/using annotations_asset_at on annotations c\s.*\n\s+Index Cond: \(\(workspace_id = a\.workspace_id\) AND \(asset_id = a\.asset_id\) AND \(at >= /);
    expect(plan).not.toMatch(/Seq Scan/);
  });
});

describe("resolveCounterCards — which lane owns the number", () => {
  const CARD = [{ metric: "signups", label: "Accounts" }];
  const reading = (observedAt: string) =>
    new Map([{ metric: "signups", value: 4310, observedAt }].map((r) => [r.metric, r]));
  const nightly = (receivedAt: string | null) => ({
    metrics: { signups: { total: 4400 } },
    receivedAt,
  });

  it("gives an equal stamp to the fast lane — the reading is the more current-state row", () => {
    const at = "2026-07-05T08:00:00.000Z";
    expect(resolveCounterCards(CARD, reading(at), nightly(at))[0]).toMatchObject({
      value: 4310,
      source: "counters",
    });
  });

  it("yields to the lane that can prove its age when a stamp is unreadable", () => {
    const [card] = resolveCounterCards(
      CARD,
      reading("not-a-timestamp"),
      nightly("2026-07-05T08:00:00.000Z"),
    );
    expect(card).toMatchObject({ value: 4400, source: "nightly" });
  });

  it("keeps the single-lane cases: a reading with no nightly total still wins", () => {
    const [card] = resolveCounterCards(
      CARD,
      reading("2026-06-28T08:00:00.000Z"),
      { metrics: {}, receivedAt: "2026-07-05T08:00:00.000Z" },
    );
    expect(card).toMatchObject({ value: 4310, source: "counters",
    });
  });

  // A reading whose value does not parse used to win the lane on freshness and
  // then render as nothing, blanking a card the nightly report could still fill
  // (ro-kvk). Freshness ranks readable lanes; it does not promote an unreadable
  // one.
  const unreadable = (metric: string, value: unknown, observedAt: string): CounterReading => ({
    metric,
    value: value as number,
    observedAt,
  });

  it("treats an unreadable reading as absent, so a good nightly total keeps the card", () => {
    // The reading is an HOUR NEWER than the report and still does not win it.
    const [card] = resolveCounterCards(
      CARD,
      new Map([["signups", unreadable("signups", "n/a", "2026-07-05T09:00:00.000Z")]]),
      nightly("2026-07-05T08:00:00.000Z"),
    );
    expect(card).toMatchObject({ value: 4400, source: "nightly" });
  });

  it("degrades the one broken reading to a stated absence, never the cards beside it", () => {
    const cards = resolveCounterCards(
      [
        { metric: "signups", label: "Accounts" },
        { metric: "plansSaved", label: "Plans" },
        { metric: "leads", label: "Leads" },
      ],
      new Map([
        ["signups", unreadable("signups", Number.NaN, "2026-07-05T09:00:00.000Z")],
        ["plansSaved", { metric: "plansSaved", value: 812, observedAt: "2026-07-05T09:00:00.000Z" }],
        ["leads", unreadable("leads", "1,204", "2026-07-05T09:00:00.000Z")],
      ]),
      { metrics: { leads: { total: 77 } }, receivedAt: "2026-07-05T08:00:00.000Z" },
    );
    // No lane can be read: the card says so — no number, no age, no source —
    // instead of showing a figure it cannot back.
    expect(cards[0]).toEqual({
      metric: "signups",
      label: "Accounts",
      value: null,
      observedAt: null,
      source: null,
    });
    // The poisoned reading sits BESIDE these two, and neither notices it.
    expect(cards[1]).toMatchObject({ value: 812, source: "counters" });
    expect(cards[2]).toMatchObject({ value: 77, source: "nightly" });
  });
});

describe("Wall counter catalog", () => {
  it("discovers only actual nonnegative integer totals and retains saved missing cards", () => {
    const catalog = resolveWallCounters({ heading: " Catalog ", cards: [{ metric: "missing", label: "Saved label" }] }, undefined, {
      receivedAt: "2026-07-05T08:00:00.000Z",
      metrics: {
        zero: { total: 0 }, daily: {}, negative: { total: -1 }, fraction: { total: 1.5 },
        nan: { total: Number.NaN }, text: { total: "12" }, empty: { total: "" }, absent: undefined,
      },
    }, 0.25);
    expect(catalog).toEqual({ heading: "Catalog", cadenceHours: 0.25, defaultMetrics: ["missing"], cards: [
      { metric: "missing", label: "Saved label", value: null, observedAt: null, source: null },
      { metric: "zero", label: "Zero", value: 0, observedAt: "2026-07-05T08:00:00.000Z", source: "nightly" },
    ] });
  });

  it("has an indexed per-asset latest-envelope plan, not a history scan", async () => {
    const ctx = await createTestStore();
    const plan = await ctx.call.read(async (tx) => {
      await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
      return (await tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${LATEST_COUNTER_TOTALS_SQL}`)).map((row) => row["QUERY PLAN"]);
    });
    expect(plan.filter((line) => /Seq Scan on pulses/.test(line))).toEqual([]);
    expect(plan.some((line) => /Index (Only )?Scan (Backward )?using \w+ on pulses p\b/.test(line))).toBe(true);
    expect(plan.some((line) => /Index Cond: \(\(workspace_id = a\.workspace_id\) AND \(asset_id = a\.asset_id\)/.test(line))).toBe(true);
    expect(plan.some((line) => /Limit/.test(line))).toBe(true);
  });
});

describe("buildWallPayload — report coverage", () => {
  it("both payloads count only actual report dates in the last 28 completed UTC days", async () => {
    const ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "onboarding", 1, 0);
    for (const date of ["2026-01-01", "2026-06-06", "2026-06-07", "2026-06-20", "2026-07-04", "2026-07-05", "2026-07-06"]) {
      await insertPulse(ctx, "meals.example", date, `${date}T02:00:00.000Z`, {});
    }
    // A corrected report adds a revision, not coverage for a missing day.
    await insertPulse(ctx, "meals.example", "2026-06-20", "2026-07-05T03:00:00.000Z", { visits: { last24h: 2 } });
    const wall = await buildWallPayload(ctx.call, OPTIONS);
    const detail = (await buildAssetDetailPayload(ctx.call, "meals.example", DETAIL_DEPS))!;
    expect(wall.assets[0]?.reportDays).toBe(3);
    expect(detail.asset.reportDays).toBe(3);
    expect(detail.asset.firstReportAt).toBe("2026-01-01T02:00:00.000Z");
  });

  it("reports complete coverage only when all 28 recent dates exist", async () => {
    const ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "onboarding", 1, 0);
    for (let back = 1; back <= 28; back += 1) {
      const date = new Date(NOW_MS - back * DAY).toISOString().slice(0, 10);
      await insertPulse(ctx, "meals.example", date, `${date}T02:00:00.000Z`, {});
    }
    const wall = await buildWallPayload(ctx.call, OPTIONS);
    const detail = (await buildAssetDetailPayload(ctx.call, "meals.example", DETAIL_DEPS))!;
    expect(wall.assets[0]?.reportDays).toBe(28);
    expect(detail.asset.reportDays).toBe(28);
  });

  it("an old report alone leaves recent coverage at zero", async () => {
    const ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "onboarding", 1, 0);
    await insertPulse(ctx, "meals.example", "2026-01-01", "2026-01-02T02:00:00.000Z", {});
    const wall = await buildWallPayload(ctx.call, OPTIONS);
    const detail = (await buildAssetDetailPayload(ctx.call, "meals.example", DETAIL_DEPS))!;
    expect(wall.assets[0]?.reportDays).toBe(0);
    expect(detail.asset.reportDays).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pulse reads bounded by what is shown (bead `ro-ujb9.63`).
//
// Until this bead the Wall grouped every stored pulse for first/last arrival
// and 28-day coverage, so its work grew with each night of history while its
// answer did not. The statement below is that read as it stood at d6de54cd,
// written for Postgres over each day's current report (bead ro-ujb9.76.5.2):
// the specification the bounded read (`worker/pulse-history`) must reproduce
// row for row. The measurement at growing history is
// docs/artifacts/tower-perf-2026-09-23/measurements.md. (The Wall's ranked
// activity read it sat beside is gone: no screen drew the sparkline it fed,
// bead `ro-trai.44`.)
// ─────────────────────────────────────────────────────────────────────────────

const GROUPED_COVERAGE_SPEC = `SELECT asset_id AS asset, MAX(received_at) AS latest, MIN(received_at) AS first,
                COUNT(DISTINCT CASE WHEN pulse_date >= ($1::timestamptz AT TIME ZONE 'UTC')::date - $2::int
                                         AND pulse_date < ($1::timestamptz AT TIME ZONE 'UTC')::date THEN pulse_date END)::int AS "reportDays"
           FROM noticeos.current_pulses GROUP BY asset_id`;

const dayBefore = (days: number) => new Date(NOW_MS - days * DAY).toISOString().slice(0, 10);

/**
 * Four assets whose histories hit every edge the bounded read must keep:
 *  - meals: 45 reports with GAPS; a BACKFILL of an old date that arrived last
 *    and a REPORT for today (outside the completed-day window), so last
 *    arrival is not the newest date and first arrival is not the oldest;
 *  - nom: a few reports, sitting on both edges of the 28-day window;
 *  - pacer: exactly 30;
 *  - fees.example: never reported (no row, no map entry, zero coverage).
 */
async function seedPulseEdges(ctx: TestStore) {
  const raw = ctx;
  await insertAsset(raw, "root-os", "NoticeOS", "live", 0, 1);
  await insertAsset(raw, "meals.example", "Meal Planner", "live", 0, 0);
  await insertAsset(raw, "nosh.example", "Nosh", "live", 0, 0);
  await insertAsset(raw, "pacer.example", "Pacer Test", "live", 1, 0);
  await insertAsset(raw, "fees.example", "Fee Codes", "onboarding", 1, 0);

  await insertPulse(ctx, "root-os", dayBefore(1), new Date(NOW_MS - 8 * HOUR).toISOString(), { agentsRunning: { last24h: 2 } });
  let back = 0;
  for (let i = 0; i < 45; i += 1) {
    back += i % 4 === 3 ? 3 : 1; // a gap after every third report
    await insertPulse(ctx, "meals.example", dayBefore(back), `${dayBefore(back - 1)}T02:30:00.000Z`,
      { signups: { last24h: i, avg7d: 10 } }, ["signups"]);
  }
  // Today's report: newest date, but outside the completed-day window.
  await insertPulse(ctx, "meals.example", dayBefore(0), new Date(NOW_MS - 2 * HOUR).toISOString(),
    { signups: { last24h: 99, avg7d: 10 } }, ["signups"]);
  // A backfill of a night the window had skipped, delivered LAST of all.
  await insertPulse(ctx, "meals.example", dayBefore(4), new Date(NOW_MS - 1 * HOUR).toISOString(),
    { signups: { last24h: 7, avg7d: 10 } }, ["signups"]);
  // An old night delivered FIRST of all, long before its own date's neighbours.
  await insertPulse(ctx, "meals.example", dayBefore(400), "2025-01-01T00:00:00.000Z",
    { signups: { last24h: 1, avg7d: 10 } }, ["signups"]);

  // Both edges of "the last 28 completed days": 28 days back is in, 29 is out.
  for (const days of [29, 28, 12, 1]) {
    await insertPulse(ctx, "nosh.example", dayBefore(days), `${dayBefore(days - 1)}T03:00:00.000Z`, { items: { last24h: days, avg7d: 40 } });
  }
  for (let days = 30; days >= 1; days -= 1) {
    await insertPulse(ctx, "pacer.example", dayBefore(days), `${dayBefore(days - 1)}T04:00:00.000Z`, { visits: { last24h: days, avg7d: 5 } });
  }
}

describe("buildWallPayload — the pulse read stays bounded as history grows (ro-ujb9.63)", () => {
  it("first and last arrival and the 28-day count are exactly the grouped read's", async () => {
    const ctx = await createTestStore();
    await seedPulseEdges(ctx);
    const nowIso = NOW.toISOString();
    const store = ctx.call;
    const spec = (await store.read((tx) =>
      tx.query<{ asset: string; latest: string; first: string; reportDays: number }>(GROUPED_COVERAGE_SPEC, [nowIso, 28]),
    )).map((row) => ({ ...row, latest: javascriptInstant(row.latest), first: javascriptInstant(row.first) }));
    const bounded = await readPulseCoverage(store, nowIso);
    expect(Object.fromEntries(bounded)).toEqual(
      Object.fromEntries(spec.map(({ asset, ...rest }) => [asset, rest])),
    );
    // Last arrival is the backfill, first is the early delivery — neither is
    // the newest or oldest DATE — and today's report is not a completed day.
    expect(bounded.get("meals.example")?.latest).toBe(new Date(NOW_MS - 1 * HOUR).toISOString());
    expect(bounded.get("meals.example")?.first).toBe("2025-01-01T00:00:00.000Z");
    expect(bounded.get("nosh.example")?.reportDays).toBe(3);
    expect(bounded.get("pacer.example")?.reportDays).toBe(28);
    expect(bounded.has("fees.example")).toBe(false);
    // One asset is the same statement narrowed, with the same answer.
    const one = await readPulseCoverage(store, nowIso, "meals.example");
    expect([...one]).toEqual([["meals.example", bounded.get("meals.example")]]);
    expect((await readPulseCoverage(store, nowIso, "fees.example")).size).toBe(0);
  });

  it("both payloads state those facts, and a never-reported asset stays unreported and unexpected", async () => {
    const ctx = await createTestStore();
    await seedPulseEdges(ctx);
    const wall = await buildWallPayload(ctx.call, OPTIONS);
    const card = (id: string) => wall.assets.find((asset) => asset.id === id)!;
    expect(card("meals.example").pulseReceivedAt).toBe(new Date(NOW_MS - 1 * HOUR).toISOString());
    expect(card("meals.example").firstReportAt).toBe("2025-01-01T00:00:00.000Z");
    expect(card("nosh.example").reportDays).toBe(3);
    expect(card("fees.example")).toMatchObject({ pulseReceivedAt: null, firstReportAt: null, reportDays: 0 });
    // Counted over the asset rows: the site that never sent a report expects
    // none (D29 amended, ro-ujb9.121), so it is outside the denominator.
    expect(wall.system.ingest).not.toHaveProperty("neverReported");
    expect(wall.system.ingest.expected).toBe(4);

    const detail = (await buildAssetDetailPayload(ctx.call, "meals.example", DETAIL_DEPS))!;
    expect(detail.asset.firstReportAt).toBe(card("meals.example").firstReportAt);
    expect(detail.asset.reportDays).toBe(card("meals.example").reportDays);
    const silent = (await buildAssetDetailPayload(ctx.call, "fees.example", DETAIL_DEPS))!;
    expect(silent.asset).toMatchObject({ firstReportAt: null, reportDays: 0 });
  });

  it("years of older history leave the Wall's answer unchanged", async () => {
    const recent = await createTestStore();
    const long = await createTestStore();
    for (const ctx of [recent, long]) await seedPulseEdges(ctx);
    for (let days = 500; days <= 1600; days += 1) {
      await insertPulse(long, "pacer.example", dayBefore(days), `${dayBefore(days - 1)}T04:00:00.000Z`, { visits: { last24h: 1, avg7d: 5 } });
    }
    const a = await buildWallPayload(recent.call, OPTIONS);
    const b = await buildWallPayload(long.call, OPTIONS);
    const pick = (p: typeof a) => p.assets.map(({ id, pulseReceivedAt, reportDays }) =>
      ({ id, pulseReceivedAt, reportDays }));
    expect(pick(b)).toEqual(pick(a));
    // First arrival is the one fact older history is allowed to move.
    expect(b.assets.find((asset) => asset.id === "pacer.example")!.firstReportAt)
      .toBe(`${dayBefore(1599)}T04:00:00.000Z`);
  });

  it("seeks the pulse indexes per asset instead of scanning the pulse history", async () => {
    // Pinned as a PLAN, like the signal-trend read above: the cost only shows
    // at a history size no fixture will ever have. A sequential scan of
    // pulses is the regression; every pulse access must be an index scan
    // bounded by its site (on Postgres, bead ro-ujb9.76.5.2).
    const store = (await createTestStore()).call;
    const nowIso = NOW.toISOString();
    const explain = (sql: string, forbidSeqScan: boolean) =>
      store.read(async (tx) => {
        // An empty table is cheapest to scan; forbidding that shows the plan
        // the indexes offer once the history grows.
        if (forbidSeqScan) await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
        return (await tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, [nowIso, 28])).map((row) => row["QUERY PLAN"]);
      });
    const plan = await explain(PULSE_COVERAGE_SQL, true);
    expect(plan.filter((line) => /Seq Scan on pulses/.test(line))).toEqual([]);
    expect(plan.some((line) => /Index (Only )?Scan (Backward )?using \w+ on pulses p\b/.test(line))).toBe(true);
    expect(plan.some((line) => /Index Cond: \(\(workspace_id = a\.workspace_id\) AND \(asset_id = a\.asset_id\)/.test(line))).toBe(true);
    // Before: the statement read the whole history — every report of the
    // workspace, bounded by no site.
    const before = await explain(GROUPED_COVERAGE_SPEC, false);
    expect(before.some((line) => /Scan.* on pulses\b/.test(line))).toBe(true);
    expect(before.filter((line) => /Index Cond:.*asset_id/.test(line))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The asset card's work slice.
//
// `counts` is what the poller measured over the UNTRUNCATED `bd` output — the
// stored lists keep ten of however many there were — so these tests seed real
// snapshot payloads and assert the card reads that measurement rather than
// re-deriving anything from the lists. The epic exclusion itself is pinned
// where it happens, in `scripts/os-up.test.mjs`; what is pinned here is that
// the Tower never invents a number the snapshot did not carry.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildWallPayload — the card's work slice", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seed(ctx);
  });

  const cardFor = async (asset: string) =>
    (await buildWallPayload(ctx.call, OPTIONS)).assets.find((a) => a.id === asset)!;

  it('joins alert work by project, kind and every firing in the condition using one snapshot read', async () => {
    const base = { asset: 'meals.example', severity: 'warn', kind: 'anomaly', ruleId: 'asset-declared', metric: 'signups' };
    const [earlier, latest] = await storeAlerts(ctx.call, [
      { ...base, firedAt: '2026-07-05T10:00:00.000Z' },
      { ...base, firedAt: '2026-07-05T11:00:00.000Z' },
    ]);
    const unrelated = await storeAlert(ctx.call, { ...base, metric: 'leads', firedAt: '2026-07-05T11:00:00.000Z' });
    const handoff = { kind: 'alert', key: String(earlier), beadId: 'mp-repair', status: 'open', closedAt: null };
    const closed = { ...handoff, key: String(latest), beadId: 'mp-review', status: 'closed', closedAt: '2026-07-05T11:30:00.000Z' };
    await seedSnapshot(ctx, '2026-07-05T11:59:30.000Z', [
      workProject({ handoffs: [handoff, closed, { ...handoff, kind: 'query', beadId: 'mp-wrongkind' }] }),
      workProject({ asset: 'nosh.example', handoffs: [{ ...handoff, beadId: 'nom-wrongsite' }] }),
    ]);
    const statements: string[] = [];
    const wall = await buildWallPayload(recordingStore(ctx.call, statements), OPTIONS);
    expect(wall.attention.find((item) => item.id === latest)).toMatchObject({ occurrences: 2, handoffBeads: [handoff, closed] });
    expect(wall.attention.find((item) => item.id === unrelated)?.handoffBeads).toEqual([]);
    expect(statements.filter((statement) => statement.includes('noticeos.task_snapshots'))).toHaveLength(1);
  });

  it('does not revive an older alert handoff when the latest project read is missing or failed', async () => {
    const id = await storeAlert(ctx.call, { asset: 'meals.example', severity: 'warn', kind: 'anomaly',
      ruleId: 'asset-declared', metric: 'signups', firedAt: '2026-07-05T11:00:00.000Z' });
    const handoff = { kind: 'alert', key: String(id), beadId: 'mp-old', status: 'open', closedAt: null };
    await seedSnapshot(ctx, '2026-07-05T11:30:00.000Z', [workProject({ handoffs: [handoff] })]);
    await seedSnapshot(ctx, '2026-07-05T11:59:30.000Z', [workProject({ ok: false, handoffs: [handoff] })]);
    expect((await buildWallPayload(ctx.call, OPTIONS)).attention.find((item) => item.id === id)?.handoffBeads).toBeUndefined();
    await seedSnapshot(ctx, '2026-07-05T11:59:45.000Z', [workProject()]);
    expect((await buildWallPayload(ctx.call, OPTIONS)).attention.find((item) => item.id === id)?.handoffBeads).toBeUndefined();
  });

  // The old System card's work widget left the Wall with D28, and no screen
  // drew the OS's slice after it (bead `ro-trai.44`).
  it("carries each site's work from the newest snapshot, and none for the OS", async () => {
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject(),
      workProject({
        asset: "root-os",
        prefix: "ro",
        counts: workCounts({
          open: 21,
          highPriority: 5,
          inProgress: 4,
          blocked: 3,
          closedRecent: 8,
        }),
        priorities: [2, 3, 12, 6, 2],
      }),
    ]);

    const wall = await buildWallPayload(ctx.call, OPTIONS);
    expect(Object.keys(wall.system)).not.toContain("work");
    expect(wall.assets.some((asset) => asset.id === "root-os")).toBe(false);
    expect(wall.assets.find((asset) => asset.id === "meals.example")?.work).toMatchObject({
      open: 12,
      capturedAt: "2026-07-05T11:59:30.000Z",
    });
  });

  it("joins the newest snapshot onto each asset by asset id", async () => {
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject(),
      workProject({ asset: "nosh.example", prefix: "nom", counts: workCounts({ open: 1, highPriority: 0, closedRecent: 0 }) }),
    ]);

    expect((await cardFor("meals.example")).work).toEqual({
      open: 12,
      highPriority: 3,
      inProgress: 2,
      blocked: 1,
      closedRecent: 4,
      priorities: [1, 2, 8, 3, 1],
      capturedAt: "2026-07-05T11:59:30.000Z",
    });
    expect((await cardFor("nosh.example")).work).toMatchObject({ open: 1, highPriority: 0 });
    // An asset the snapshot never mentions has no work data — not zeros.
    expect((await cardFor("pacer.example")).work).toBeNull();
  });

  it("carries the counts verbatim, never re-derived from the truncated lists", async () => {
    // The real failure this guards: `bd ready` returned 39 rows on 2026-08-01
    // and the payload stores ten of them. A card that counted the list would
    // say 2 where the hub says 31.
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({
        counts: workCounts({ open: 31, ready: 31, highPriority: 7 }),
        ready: [
          { id: "mp-1", title: "One", status: "open", priority: 0, issueType: "task" },
          { id: "mp-2", title: "Two", status: "open", priority: 1, issueType: "task" },
        ],
      }),
    ]);

    expect((await cardFor("meals.example")).work).toMatchObject({
      open: 31,
      highPriority: 7,
    });
  });

  it("reads only the latest snapshot", async () => {
    await seedSnapshot(ctx, "2026-07-04T09:00:00.000Z", [
      workProject({ counts: workCounts({ open: 99 }) }),
    ]);
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [workProject()]);

    expect((await cardFor("meals.example")).work).toMatchObject({
      open: 12,
      capturedAt: "2026-07-05T11:59:30.000Z" });
  });

  it("says nothing rather than zero for a repo the poller could not read", async () => {
    // "We could not look" and "there is nothing to do" are different facts, and
    // only one of them is good news.
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({
        ok: false,
        error: "bd ready exited 1: no beads project found",
        counts: workCounts({ open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0 }) }),
    ]);

    expect((await cardFor("meals.example")).work).toBeNull();
  });

  it("keeps the counts a one-generation-behind poller DID send, and calls the rest unknown", async () => {
    // The 2026-08-01 skew incident: the poller is a long-running node process
    // and can be a generation behind the Worker. Such a row still knows how
    // much is open — dropping the whole widget over one missing field would be
    // its own dishonesty — but `highPriority` is unknown, not zero.
    const { highPriority: _notSentYet, ...olderCounts } = workCounts();
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ counts: olderCounts }),
    ]);

    expect((await cardFor("meals.example")).work).toEqual({
      open: 12,
      highPriority: null,
      inProgress: 2,
      blocked: 1,
      closedRecent: 4,
      priorities: [1, 2, 8, 3, 1],
      capturedAt: "2026-07-05T11:59:30.000Z" });
  });

  it("says nothing rather than zero when no snapshot has ever been filed", async () => {
    expect((await cardFor("meals.example")).work).toBeNull();
  });

  it("keeps a zeroed queue distinct from an absent one", async () => {
    // A project that genuinely has nothing queued reports zeros, and the card
    // renders them as "nothing queued" — which is a fact, unlike a null.
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({
        counts: workCounts({ open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0 }) }),
    ]);

    expect((await cardFor("meals.example")).work).toMatchObject({
      open: 0,
      highPriority: 0,
      closedRecent: 0,
    });
  });

  it("sums the actionable human inbox with explicit project coverage", async () => {
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ counts: workCounts({ waiting: 4 }), waitingUrgent: 3 }),
      workProject({
        asset: "nosh.example",
        prefix: "nom",
        counts: workCounts({ waiting: 7 }),
        waitingUrgent: 5,
      }),
    ]);

    expect((await buildWallPayload(ctx.call, OPTIONS)).operator).toEqual({
      waiting: 11,
      urgent: 8,
      measuredProjects: 2,
      urgentMeasuredProjects: 2,
      projectCount: 2,
      capturedAt: "2026-07-05T11:59:30.000Z",
    });
  });

  it("keeps a partial human count as a known lower bound instead of zeroing unreadable projects", async () => {
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ counts: workCounts({ waiting: 3 }), waitingUrgent: 2 }),
      workProject({ asset: "nosh.example", prefix: "nom" }),
      workProject({
        asset: "fees.example",
        prefix: "fin",
        ok: false,
        error: "bd ready exited 1",
        counts: workCounts({ waiting: 9 }),
        waitingUrgent: 9,
      }),
    ]);

    expect((await buildWallPayload(ctx.call, OPTIONS)).operator).toEqual({
      waiting: 3,
      urgent: 2,
      measuredProjects: 1,
      urgentMeasuredProjects: 1,
      projectCount: 3,
      capturedAt: "2026-07-05T11:59:30.000Z",
    });
  });

  it("keeps the core inbox explicitly unmeasured before any project has been read", async () => {
    const unknown = { waiting: 0, urgent: 0, measuredProjects: 0, urgentMeasuredProjects: 0, projectCount: 0, capturedAt: null };
    expect((await buildWallPayload(ctx.call, OPTIONS)).operator).toEqual(unknown);
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", []);
    expect((await buildWallPayload(ctx.call, OPTIONS)).operator).toEqual({ ...unknown, capturedAt: "2026-07-05T11:59:30.000Z" });
  });

  it("keeps a connected source's partial read a lower bound, never all-clear", async () => {
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ asset: "fees.example", prefix: "fin", ok: false, error: "bd ready exited 1" }),
    ]);
    expect((await buildWallPayload(ctx.call, OPTIONS)).operator).toEqual({
      waiting: 0,
      urgent: 0,
      measuredProjects: 0,
      urgentMeasuredProjects: 0,
      projectCount: 1,
      capturedAt: "2026-07-05T11:59:30.000Z",
    });
  });
});

/** One archived tracked-SERP collection. Fills the columns db/0016's CHECK
 * constraints demand for the status being written, so the fixture is a row the
 * real collector could have produced. */
/**
 * The panel-review state rule, on its own (bead `ro-rkp`).
 *
 * Four states and one clock. The function is pure so the boundary can be
 * pinned to the millisecond, which matters: `overdue` is the only state that
 * paints error, and painting it a moment early would make the loudest thing on
 * the Wall the thing that cries wolf.
 */
describe("panelReviewState — four states over one clock", () => {
  const PANEL_DAY = "2026-07-01";
  const DUE = "2026-07-08T06:00:00.000Z";
  const dueMs = Date.parse(DUE);
  const open: PanelReview = {
    beadId: "mp-4a2",
    panelDate: PANEL_DAY,
    dueAt: DUE,
    status: "open",
    closedAt: null,
    panel: true,
  };
  const closed: PanelReview = {
    ...open,
    status: "closed",
    closedAt: "2026-07-03T09:00:00.000Z",
  };

  it("says nothing at all when there is no review to speak of", () => {
    // No collection landed inside the window, none filed, or a snapshot too
    // old to carry the field — one answer, and it renders nothing.
    expect(panelReviewState(null, null, NOW_MS)).toBe("none");
    expect(panelReviewState(undefined, PANEL_DAY, NOW_MS)).toBe("none");
  });

  it("is pending while an open review is still inside its window", () => {
    expect(panelReviewState(open, PANEL_DAY, dueMs - DAY)).toBe("pending");
  });

  it("is still pending at EXACTLY the deadline, and overdue a millisecond later", () => {
    // The boundary the badge's color turns on. `>` matches isAmber: a review
    // looked at exactly on time is on time.
    expect(panelReviewState(open, PANEL_DAY, dueMs)).toBe("pending");
    expect(panelReviewState(open, PANEL_DAY, dueMs + 1)).toBe("overdue");
    expect(panelReviewState(open, PANEL_DAY, dueMs + 3 * DAY)).toBe("overdue");
  });

  it("is reviewed once the bead for the newest panel day is closed", () => {
    expect(panelReviewState(closed, PANEL_DAY, NOW_MS)).toBe("reviewed");
    // And it STAYS reviewed past the old deadline: the obligation was met, so
    // the deadline is no longer a fact about anything.
    expect(panelReviewState(closed, PANEL_DAY, dueMs + 30 * DAY)).toBe("reviewed");
  });

  it("falls back to pending when a NEWER panel day has landed", () => {
    // The failure this join exists to catch: a fresh result page nobody has
    // opened, sitting behind a card that says it was read. The bead for it has
    // not been filed yet, so there is no deadline to be late against — pending,
    // quietly, never `reviewed`.
    expect(panelReviewState(closed, "2026-07-08", NOW_MS)).toBe("pending");
  });

  it("reads the panel DAY, not the close time — a late close covers nothing new", () => {
    // The bug the close-time comparison had (agreed with ro-9hx): panel A lands,
    // panel B lands a week later, and the operator finally closes A's review
    // AFTER B arrived. The close is newer than B; the review still covers only
    // A, and B is a result page nobody has opened.
    const lateClose: PanelReview = {
      ...closed,
      closedAt: "2026-07-09T09:00:00.000Z",
    };
    expect(panelReviewState(lateClose, "2026-07-08", NOW_MS)).toBe("pending");
  });

  it("lets a close stand when no landing is readable at all", () => {
    expect(panelReviewState(closed, null, NOW_MS)).toBe("reviewed");
  });

  it("degrades every unreadable date to the QUIET state, never to overdue", () => {
    // An older writer's fields survive as absences. None of them may escalate:
    // error tone is earned off a deadline the OS can actually read.
    expect(panelReviewState({ ...open, dueAt: null }, PANEL_DAY, NOW_MS)).toBe("pending");
    expect(panelReviewState({ ...open, dueAt: "not a date" }, PANEL_DAY, NOW_MS)).toBe("pending");
    expect(panelReviewState({ ...closed, closedAt: null }, PANEL_DAY, NOW_MS)).toBe("pending");
    // A finished review that cannot name its own panel day cannot be shown to
    // cover the newest one.
    expect(panelReviewState({ ...closed, panelDate: null }, PANEL_DAY, NOW_MS)).toBe("pending");
  });
});

describe("buildWallPayload — the card's panel-review slice", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seed(ctx);
  });

  const cardFor = async (asset: string) =>
    (await buildWallPayload(ctx.call, OPTIONS)).assets.find((a) => a.id === asset)!;

  const review = panelReviewBead;

  it("carries the review bead and the panel day it has to be about", async () => {
    await insertDataForSeoCollection(
      ctx,
      "meals.example",
      "2026-07-01",
      "2026-07-01T06:00:00.000Z",
      { panel: true },
    );
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ panelReview: review() }),
    ]);

    const card = await cardFor("meals.example");
    expect(card.panelReview).toEqual({
      beadId: "mp-4a2",
      panelDate: "2026-07-01",
      dueAt: "2026-07-08T06:00:00.000Z",
      status: "open",
      closedAt: null,
      panel: true,
    });
    expect(card.latestPanelDate).toBe("2026-07-01");
    expect(panelReviewState(card.panelReview, card.latestPanelDate, NOW_MS)).toBe("pending");
  });

  it("marks an asset with no config/serp-panel.json entry as panel-less, not as review-less", async () => {
    // Bead ro-z0g. nosh.example is absent from this fixture's panel file but lands a
    // weekly collection, so it owes the read and the ONLY difference config
    // makes is the noun the marker states it in.
    await insertDataForSeoCollection(
      ctx,
      "nosh.example",
      "2026-07-01",
      "2026-07-01T06:00:00.000Z",
      { panel: false },
    );
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ asset: "nosh.example", prefix: "nom", panelReview: review({ beadId: "nom-f1c" }) }),
    ]);

    const card = await cardFor("nosh.example");
    expect(card.panelReview?.panel).toBe(false);
    expect(card.panelReview?.beadId).toBe("nom-f1c");
    expect(panelReviewState(card.panelReview, card.latestPanelDate, NOW_MS)).toBe("pending");
  });

  it("reads the newest complete collection day and ignores a newer partial day", async () => {
    await insertDataForSeoCollection(
      ctx,
      "meals.example",
      "2026-06-24",
      "2026-06-24T06:00:00.000Z",
      { panel: true },
    );
    await insertDataForSeoCollection(
      ctx,
      "meals.example",
      "2026-07-01",
      "2026-07-01T06:00:00.000Z",
      { panel: true },
    );
    // Same collection day, re-archived: byte-identical content, one landing.
    await insertPanelRun(ctx, "meals.example", "2026-07-01", "2026-07-01T07:00:00.000Z", "unchanged");
    // Five of six is a torn sweep, not a reviewable landing. The prior coherent
    // day remains the operator-facing identity until the panel family arrives.
    await insertDataForSeoCollection(
      ctx,
      "meals.example",
      "2026-07-04",
      "2026-07-04T06:00:00.000Z",
      { panel: true, omit: ["serp-panel"] },
    );
    // A failed attempt collected nothing, so it landed nothing.
    await insertPanelRun(ctx, "meals.example", "2026-07-05", "2026-07-05T06:00:00.000Z", "error");
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ panelReview: review() }),
    ]);

    expect((await cardFor("meals.example")).latestPanelDate).toBe("2026-07-01");

    await insertPanelRun(
      ctx,
      "meals.example",
      "2026-07-04",
      "2026-07-04T06:20:00.000Z",
      "success",
      "serp-panel",
    );
    expect((await cardFor("meals.example")).latestPanelDate).toBe("2026-07-04");
  });

  it("is not fooled by a backfill of an older panel written later", async () => {
    // Why the ordering is report_date first and finished_at only as tiebreak:
    // re-archiving June's panel today writes the LATEST finished_at in the
    // table, and a MAX(finished_at) read would promote June over July and
    // un-review a card that was perfectly fine.
    await insertDataForSeoCollection(ctx, "meals.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: true });
    await insertDataForSeoCollection(ctx, "meals.example", "2026-06-24", "2026-07-05T09:00:00.000Z", { panel: true });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({
        panelReview: review({ status: "closed", closedAt: "2026-07-03T09:00:00.000Z" }) }),
    ]);

    const card = await cardFor("meals.example");
    expect(card.latestPanelDate).toBe("2026-07-01");
    expect(panelReviewState(card.panelReview, card.latestPanelDate, NOW_MS)).toBe("reviewed");
  });

  it("shows the review of an asset that buys a collection but no panel", async () => {
    // Bead ro-1tu. nom is absent from the panel config THIS TEST WAS GIVEN, and
    // it used to be that absence that decided the card said nothing — so since
    // ro-478 widened the filer to every collecting asset, three assets
    // held open, due-dated reviews the Wall rendered nowhere. The collection is
    // what the review is about, so the collection is what the marker follows.
    await insertDataForSeoCollection(ctx, "nosh.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: false });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ asset: "nosh.example", prefix: "nom", panelReview: review({ beadId: "nom-f1c" }) }),
    ]);

    const card = await cardFor("nosh.example");
    expect(card.panelReview!.beadId).toBe("nom-f1c");
    expect(card.latestPanelDate).toBe("2026-07-01");
    // The same states a panel asset gets, off the same rule.
    expect(panelReviewState(card.panelReview, card.latestPanelDate, NOW_MS)).toBe("pending");
  });

  it("sheds the marker once the collection behind the review stops", async () => {
    // The other half of ro-1tu, and the job the old config gate was doing: a
    // review whose collection has gone quiet is an obligation nobody can
    // discharge, so it leaves the card rather than accusing the operator
    // forever. `PANEL_LANDING_WINDOW_DAYS` is the line — this landing is a day
    // past it, with a finished review that would otherwise read "reviewed".
    const stopped = new Date(
      NOW_MS - (PANEL_LANDING_WINDOW_DAYS + 1) * DAY,
    ).toISOString();
    await insertDataForSeoCollection(ctx, "nosh.example", stopped.slice(0, 10), stopped, { panel: false });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({
        asset: "nosh.example",
        prefix: "nom",
        panelReview: review({ beadId: "nom-f1c", status: "closed", closedAt: "2026-06-20T09:00:00.000Z" }),
      }),
    ]);

    const card = await cardFor("nosh.example");
    expect(card.panelReview).toBeNull();
    expect(card.latestPanelDate).toBeNull();
    expect(panelReviewState(card.panelReview, card.latestPanelDate, NOW_MS)).toBe("none");
  });

  it("answers for ONE asset by narrowing the same read, not by filtering the map", async () => {
    // Bead ro-ntu: the asset page windowed every asset's collections and
    // then took one key. It now passes an asset and the asset is pushed into the
    // SQL — the same shape ro-48p.2 gave loadSignalTrends. The risk a narrowed
    // read introduces is DIVERGENCE (ro-elf), so the two call shapes are held to
    // exact equality over a store where narrowing has something to drop.
    await insertDataForSeoCollection(ctx, "meals.example", "2026-06-24", "2026-06-24T06:00:00.000Z", { panel: true });
    await insertDataForSeoCollection(ctx, "meals.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: true });
    // The backfill trap, inside the narrowed read too: an older collection
    // re-archived today writes the newest finished_at in the table.
    await insertDataForSeoCollection(ctx, "meals.example", "2026-06-17", "2026-07-05T09:00:00.000Z", { panel: true });
    await insertDataForSeoCollection(ctx, "nosh.example", "2026-07-04", "2026-07-04T06:00:00.000Z", { panel: false });

    const portfolio = await loadLatestPanelLandings(ctx.call, NOW_MS, PANEL_ASSETS);
    const single = await loadLatestPanelLandings(
      ctx.call,
      NOW_MS,
      PANEL_ASSETS,
      "meals.example",
    );

    expect(single.get("meals.example")).toBe(portfolio.get("meals.example"));
    expect(single.get("meals.example")).toBe("2026-07-01");
    // Narrowed in the store, not after it.
    expect(portfolio.has("nosh.example")).toBe(true);
    expect([...single.keys()]).toEqual(["meals.example"]);
  });

  it("renders markers for exactly the landings the runner's filer files on", async () => {
    // One number in two repos: the Tower's window and the read the filer acts on
    // (workers/ingest/src/serp-panel-landings.ts). A Tower window shorter than
    // the filer's would hide a review the minute it was created; a longer one
    // would keep a marker on the board after the filer stopped renewing it.
    const ingestSource = readFileSync(
      path.resolve(here, "../../../workers/ingest/src/serp-panel-landings.ts"),
      "utf8",
    );
    const declared = ingestSource.match(
      /SERP_PANEL_LANDING_WINDOW_DAYS = (\d+)/,
    );
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(PANEL_LANDING_WINDOW_DAYS);
  });

  it("degrades a snapshot written before the field existed to absence", async () => {
    // The ordinary case until the operator restarts os:up: the poller is a
    // static node process, so every stored row still omits the key. An older
    // writer's payload is not damage, and it must not throw or invent.
    await insertDataForSeoCollection(ctx, "meals.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: true });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [workProject()]);

    const card = await cardFor("meals.example");
    expect(card.panelReview).toBeNull();
    // The landing is still readable — it is the REVIEW that is unknown, and an
    // unknown review renders nothing rather than an unmet obligation.
    expect(card.latestPanelDate).toBe("2026-07-01");
    expect(panelReviewState(card.panelReview, card.latestPanelDate, NOW_MS)).toBe("none");
  });

  it("keeps 'did not look' and 'looked, found none' apart in the snapshot", async () => {
    // The card's answer to both is the same nothing, so the payload collapses
    // them — but they are different measurements and the reader must not be the
    // place that loses one (agreed with ro-9hx).
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ panelReview: null }),
      workProject({ asset: "nosh.example", prefix: "nom" }),
    ]);

    const snapshot = (await loadLatestBeadsSnapshot(ctx.call))!;
    const [measured, notLooked] = snapshot.projects;
    expect(measured!.panelReview).toBeNull();
    expect(notLooked!.panelReview).toBeUndefined();
    expect((await cardFor("meals.example")).panelReview).toBeNull();
  });

  it("drops a review whose row cannot name a bead or a status", async () => {
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ panelReview: { panelDate: "2026-07-01", status: "open" } }),
    ]);
    expect((await cardFor("meals.example")).panelReview).toBeNull();

    ctx = await createTestStore();
    await seed(ctx);
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ panelReview: review({ status: "triaged" }) }),
    ]);
    expect((await cardFor("meals.example")).panelReview).toBeNull();
  });

  it("keeps a closed review, with the panel day that decides whether it counts", async () => {
    await insertDataForSeoCollection(ctx, "meals.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: true });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({
        panelReview: review({ status: "closed", closedAt: "2026-07-03T09:00:00.000Z" }) }),
    ]);

    const card = await cardFor("meals.example");
    expect(card.panelReview).toMatchObject({
      status: "closed",
      closedAt: "2026-07-03T09:00:00.000Z",
    });
    expect(panelReviewState(card.panelReview, card.latestPanelDate, NOW_MS)).toBe("reviewed");
  });

  it("says nothing for a repo the poller could not read", async () => {
    // Same `bd` read as the counts: a repo it could not open told it nothing
    // about a review bead either.
    await insertDataForSeoCollection(ctx, "meals.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: true });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ ok: false, error: "no beads project found", panelReview: review() }),
    ]);

    expect((await cardFor("meals.example")).panelReview).toBeNull();
  });

  it("leaves a configured asset with no landing yet holding no state", async () => {
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [workProject()]);
    const card = await cardFor("meals.example");
    expect(card.latestPanelDate).toBeNull();
    expect(card.panelReview).toBeNull();
  });

  it("states the same obligation on the page the card links to", async () => {
    // The whole point of bead ro-elf: the overdue badge on the Wall means "open
    // this asset page and act", so the badge that sent the operator and the
    // obligation they find on arrival have to be ONE fact. Both payloads, over
    // one store, through the same two readers and the same state rule.
    await insertDataForSeoCollection(ctx, "meals.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: true });
    await insertDataForSeoCollection(ctx, "nosh.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: false });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ panelReview: review({ dueAt: "2026-07-04T06:00:00.000Z" }) }),
      // An asset with no panel at all, checked on both surfaces at once.
      workProject({ asset: "nosh.example", prefix: "nom", panelReview: review({ beadId: "nom-f1c" }) }),
    ]);

    const wall = await buildWallPayload(ctx.call, OPTIONS);
    for (const asset of ["meals.example", "nosh.example"]) {
      const card = wall.assets.find((a) => a.id === asset)!;
      const page = (await buildAssetDetailPayload(ctx.call, asset, DETAIL_DEPS))!;
      expect(page.panelReview).toEqual(card.panelReview);
      expect(page.latestPanelDate).toBe(card.latestPanelDate);
      expect(panelReviewState(page.panelReview, page.latestPanelDate, NOW_MS)).toBe(
        panelReviewState(card.panelReview, card.latestPanelDate, NOW_MS),
      );
    }
    // …and the state is a real one on the asset that owes a review, not two
    // matching nulls (which every pair of surfaces agrees on).
    const meals = wall.assets.find((a) => a.id === "meals.example")!;
    expect(panelReviewState(meals.panelReview, meals.latestPanelDate, NOW_MS)).toBe("overdue");
  });
});

describe("buildWallPayload — empty store", () => {
  it("returns designed empties for every band", async () => {
    const ctx = await createTestStore();
    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.assets).toEqual([]);
    expect(p.attention).toEqual([]);
    expect(p.portfolio.firstRun).toBe(true);
    expect(p.portfolio.daysIn).toBe(0);
    expect(p.portfolio.netTrend).toEqual([]);
    expect(p.portfolio.bookedDelta).toBeNull();
    expect(p.portfolio.booked).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(p.portfolio.forecast).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(p.system.hasPulse).toBe(false);
    // No assets means nobody owes a report — which is not the same as everyone
    // being fresh, so the coverage claim stays unmade.
    expect(p.system.ingest).toEqual({
      fresh: 0, stale: 0, notExpected: 0, expected: 0,
    });
    expect(isAllFresh(p.system.ingest)).toBe(false);
    expect(p.ledgerRecordedAt).toBeNull();
    // Nothing booked, nothing estimated, no trend: the PORTFOLIO band carries
    // no number, so no surface mounts it at all (bead ro-yf3).
    expect(portfolioHasData(p.portfolio)).toBe(false);
  });
});

describe("buildWallPayload — a portfolio with assets but no ledger", () => {
  /** The real first day: assets registered, not a cent recorded either way. */
  async function storeWithNoLedger(): Promise<TestStore> {
    const ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "live", 0, 0);
    await insertAsset(ctx, "root-os", "NoticeOS", "live", 0, 1);
    return ctx;
  }

  it("has no number for the PORTFOLIO band to show", async () => {
    const ctx = await storeWithNoLedger();
    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.assets).toHaveLength(1); // the store is not empty — the ledger is
    expect(p.portfolio.firstRun).toBe(true);
    expect(p.portfolio.booked).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(p.portfolio.forecast).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(p.portfolio.netTrend).toEqual([]);
    expect(portfolioHasData(p.portfolio)).toBe(false);
  });

  it("the FIRST row brings the band back, even an estimate nobody reconciled", async () => {
    const ctx = await storeWithNoLedger();
    await insertLedger(ctx, { id: 1, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 45, booking_state: "estimated", recorded_at: "2026-07-04T00:00:00.000Z" });

    const p = await buildWallPayload(ctx.call, OPTIONS);
    // Still nothing booked — the headline stays unstated and the trend empty —
    // but there is money to report, so the card is no longer noise.
    expect(p.portfolio.firstRun).toBe(true);
    expect(p.portfolio.booked).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(p.portfolio.netTrend).toEqual([]);
    expect(p.portfolio.forecast).toEqual({ currency: 'USD', revenue: 45, cost: 0, net: 45 });
    expect(portfolioHasData(p.portfolio)).toBe(true);
  });

  it("a reconciled row worth nothing is data, not emptiness", async () => {
    // $0 revenue somebody actually confirmed. firstRun is false, so the booked
    // headline is a fact the operator asked for — the band must not hide it.
    const ctx = await storeWithNoLedger();
    await insertLedger(ctx, { id: 1, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 0, booking_state: "reconciled", recorded_at: "2026-07-04T00:00:00.000Z" });

    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.portfolio.firstRun).toBe(false);
    expect(p.portfolio.booked).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(p.portfolio.netTrend).toEqual([{ t: "2026-07", v: 0 }]);
    // The only month on record is the open one, so there is no pair to state.
    expect(p.portfolio.bookedDelta).toBeNull();
    expect(portfolioHasData(p.portfolio)).toBe(true);
  });
});

describe("buildWallPayload — the current month has no ledger row yet (bead ro-bdkp)", () => {
  /** 2026-09-04, the day the defect was observed: three months of imports
   * behind, nothing for September, and days to go before anything lands. */
  const SEPTEMBER = new Date("2026-09-04T12:00:00.000Z");
  const SEPT_OPTIONS = { ...OPTIONS, now: SEPTEMBER };

  /** Two properties and an OS, with July and August booked and September bare. */
  async function storeEndingInAugust(): Promise<TestStore> {
    const ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "live", 0, 0);
    await insertAsset(ctx, "nosh.example", "Nosh", "live", 0, 0);
    await insertAsset(ctx, "root-os", "NoticeOS", "live", 0, 1);
    await insertLedger(ctx, { id: 1, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 300, booking_state: "reconciled", recorded_at: "2026-08-01T00:00:00.000Z" });
    await insertLedger(ctx, { id: 2, kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", amount: 412.5, booking_state: "reconciled", recorded_at: "2026-09-01T00:00:00.000Z" });
    await insertLedger(ctx, { id: 3, kind: "cost", asset: "meals.example", period: "2026-08", family: "infra", amount: 66.4, booking_state: "reconciled", recorded_at: "2026-09-01T00:00:00.000Z" });
    await insertLedger(ctx, { id: 4, kind: "revenue", asset: "nosh.example", period: "2026-08", family: "subs", amount: 120, booking_state: "estimated", recorded_at: "2026-09-01T00:00:00.000Z" });
    return ctx;
  }

  it("shows August, and says out loud that August is not this month", async () => {
    // The defect: the band read '2026-09', found nothing, and the Wall's money
    // card left the top row for the first days of the month.
    const ctx = await storeEndingInAugust();
    const p = await buildWallPayload(ctx.call, SEPT_OPTIONS);

    expect(p.portfolio.period).toBe("2026-08");
    expect(p.portfolio.periodIsCurrent).toBe(false);
    expect(p.portfolio.booked).toEqual({ currency: 'USD', revenue: 412.5, cost: 66.4, net: 346.1 });
    expect(p.portfolio.forecast).toEqual({ currency: 'USD', revenue: 120, cost: 0, net: 120 });
    // …and the card mounts, which is the whole point.
    expect(portfolioHasData(p.portfolio)).toBe(true);
  });

  it("every property card quotes the SAME month the headline does", async () => {
    // `ro-uwo.2`'s invariant has to survive the fallback: one chosen period
    // feeds both grains, so the cards still add up to the number above them.
    const ctx = await storeEndingInAugust();
    const p = await buildWallPayload(ctx.call, SEPT_OPTIONS);

    for (const card of p.assets) {
      expect(card.netPeriod).toBe(p.portfolio.period);
    }
    const sum = (pick: (card: (typeof p.assets)[number]) => number) =>
      p.assets.reduce((total, card) => total + pick(card), 0);
    expect(sum((c) => c.booked.revenue!)).toBeCloseTo(p.portfolio.booked.revenue!, 10);
    expect(sum((c) => c.booked.cost!)).toBeCloseTo(p.portfolio.booked.cost!, 10);
    expect(sum((c) => c.booked.net!)).toBeCloseTo(p.portfolio.booked.net!, 10);
    expect(sum((c) => c.forecast.net!)).toBeCloseTo(p.portfolio.forecast.net!, 10);
    // Real money on both sides, so this is not two zeroes agreeing.
    expect(cardHasMoney(p.assets[0]!)).toBe(true);
    expect(cardHasMoney(p.assets[1]!)).toBe(true);
  });

  it("D13: a month holding only COSTS still leads, and still counts as rows", async () => {
    // The cost-led headline (config/decisions.md D13). A fallback that waited
    // for revenue would blank the card on exactly the months this OS is most
    // honest about — the ones where it only spent.
    const ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "live", 0, 0);
    await insertLedger(ctx, { id: 1, kind: "cost", asset: "meals.example", period: "2026-08", family: "infra", amount: 88.25, booking_state: "reconciled", recorded_at: "2026-09-01T00:00:00.000Z" });

    const p = await buildWallPayload(ctx.call, SEPT_OPTIONS);
    expect(p.portfolio.period).toBe("2026-08");
    expect(p.portfolio.periodIsCurrent).toBe(false);
    expect(p.portfolio.booked).toEqual({ currency: 'USD', revenue: 0, cost: 88.25, net: -88.25 });
    expect(p.assets[0]!.booked).toEqual({ currency: 'USD', revenue: 0, cost: 88.25, net: -88.25 });
    expect(portfolioHasData(p.portfolio)).toBe(true);
  });

  it("the moment September books a row, September is the month again", async () => {
    // The other 26 days of the month: identical to the behaviour before the
    // fallback existed, right down to `periodIsCurrent`.
    const ctx = await storeEndingInAugust();
    await insertLedger(ctx, { id: 9, kind: "revenue", asset: "nosh.example", period: "2026-09", family: "subs", amount: 15, booking_state: "estimated", recorded_at: "2026-09-04T00:00:00.000Z" });

    const p = await buildWallPayload(ctx.call, SEPT_OPTIONS);
    expect(p.portfolio.period).toBe("2026-09");
    expect(p.portfolio.periodIsCurrent).toBe(true);
    expect(p.portfolio.booked).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(p.portfolio.forecast).toEqual({ currency: 'USD', revenue: 15, cost: 0, net: 15 });
    expect(p.assets.every((card) => card.netPeriod === "2026-09")).toBe(true);
  });

  it("a month never loses its only row to a restatement in another month", async () => {
    // The fallback reads current rows, like every other figure on the card. On
    // D1 only a store without the ledger guards (db/0036, bead ro-ujb9.69)
    // could hold a July restatement of an August estimate, which left August
    // with nothing in it. The Postgres store refuses that restatement in every
    // workspace (0001_baseline.sql `ledger_correction_matches_target`), and
    // the importer refuses such a D1 pair by name, so August keeps its row.
    const ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "live", 0, 0);
    await insertLedger(ctx, { id: 1, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 300, booking_state: "reconciled", recorded_at: "2026-08-01T00:00:00.000Z" });
    await insertLedger(ctx, { id: 2, kind: "revenue", asset: "meals.example", period: "2026-08", family: "ads", amount: 50, booking_state: "estimated", recorded_at: "2026-09-01T00:00:00.000Z" });
    await expect(
      insertLedger(ctx, { id: 3, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 310, booking_state: "reconciled", supersedes_id: 2, recorded_at: "2026-09-02T00:00:00.000Z" }),
    ).rejects.toThrow(/same site, month, kind, family and currency/);

    const p = await buildWallPayload(ctx.call, SEPT_OPTIONS);
    expect(p.portfolio.period).toBe("2026-08");
    expect(p.portfolio.periodIsCurrent).toBe(false);
    expect(p.portfolio.forecast).toEqual({ currency: 'USD', revenue: 50, cost: 0, net: 50 });
  });

  it("the closed-month delta still measures against the CALENDAR, not the fallback", async () => {
    // "Closed" is a fact about the clock. A headline that fell back to August
    // must not thereby declare August unclosed and drop it from its own chip.
    const ctx = await storeEndingInAugust();
    const p = await buildWallPayload(ctx.call, SEPT_OPTIONS);

    expect(p.portfolio.bookedDelta).not.toBeNull();
    expect(p.portfolio.bookedDelta!.period).toBe("2026-08");
    expect(p.portfolio.bookedDelta!.priorPeriod).toBe("2026-07");
    expect(p.portfolio.bookedDelta!.value).toBeCloseTo(346.1 - 300, 10);
  });

  it("no ledger row anywhere is still an empty card, on the current month", async () => {
    // The absence `portfolioHasData` was written for (bead ro-yf3) survives:
    // the fallback has nothing to fall back TO, so the period stays honest and
    // the band renders nothing at all.
    const ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "live", 0, 0);

    const p = await buildWallPayload(ctx.call, SEPT_OPTIONS);
    expect(p.portfolio.period).toBe("2026-09");
    expect(p.portfolio.periodIsCurrent).toBe(true);
    expect(p.portfolio.booked).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(p.portfolio.forecast).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(p.portfolio.netTrend).toEqual([]);
    expect(portfolioHasData(p.portfolio)).toBe(false);
  });
});

/**
 * Snooze across the portfolio payload (`ro-c7qq`). "Open" is decided in ONE
 * place (`worker/flag-scope.ts`), so a parked condition has to disappear from
 * the attention rail, from the asset card's counts and from the card's worst
 * severity together — and return to all three together.
 */
describe("the OS's own row is called NoticeOS on the Wall, whatever it stores (ro-ujb9.77.10)", () => {
  it("names the OS's alerts and parked alerts by the product, and every site by its own name", async () => {
    const ctx = await createTestStore();
    await insertAsset(ctx, "os-row", "ReindexOS", "live", 0, 1);
    await insertAsset(ctx, "meals.example", "Meal Planner", "live", 0, 0);
    const alert = (asset: string, metric: string, snooze: string | null) =>
      insertFlag(ctx, {
        asset,
        fired_at: "2026-07-04T02:00:00.000Z",
        severity: "error",
        kind: "anomaly",
        metric,
        message: "18 in last24h (avg7d 40.0)",
        rule_id: "flow-poisson-low",
        disposition: snooze ? "snooze" : null,
        snooze_until: snooze,
      });
    await alert("os-row", "agentsRunning", null);
    await alert("os-row", "queueDepth", "2026-07-09T12:00:00.000Z");
    await alert("meals.example", "signups", null);

    const p = await buildWallPayload(ctx.call, OPTIONS);

    expect(p.attention.map((row) => [row.asset, row.assetDisplayName]).sort()).toEqual([
      ["meals.example", "Meal Planner"],
      ["os-row", "NoticeOS"],
    ]);
    expect(p.snoozed.map((row) => [row.asset, row.assetDisplayName])).toEqual([["os-row", "NoticeOS"]]);
    expect(p.system.assetId).toBe("os-row");
    expect(JSON.stringify(p)).not.toContain("ReindexOS");
  });
});

describe("a snoozed condition leaves the whole Wall, then comes back", () => {
  async function storeWithSnooze(until: string): Promise<TestStore> {
    const ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "live", 0, 0);
    await insertFlag(ctx, {
      asset: "meals.example",
      fired_at: "2026-07-04T02:00:00.000Z",
      severity: "error",
      kind: "anomaly",
      metric: "signups",
      message: "18 in last24h (avg7d 40.0)",
      rule_id: "flow-poisson-low",
      disposition: "snooze",
      snooze_until: until,
    });
    return ctx;
  }

  it("is off the rail and out of the card's counts while it is quiet", async () => {
    const ctx = await storeWithSnooze("2026-07-09T12:00:00.000Z");
    const p = await buildWallPayload(ctx.call, OPTIONS);

    expect(p.attention).toEqual([]);
    const card = p.assets.find((a) => a.id === "meals.example")!;
    expect(card.openError).toBe(0);
    // The card's colour comes off with the row: a snoozed condition that still
    // set `worstOpenSeverity` would keep the asset red on a TV nobody can act
    // from, about something the operator explicitly deferred.
    expect(card.worstSeverity).toBeNull();

    // But it IS on the page that owes it, with the date it returns.
    expect(p.snoozed).toHaveLength(1);
    expect(p.snoozed[0]).toMatchObject({
      asset: "meals.example",
      assetDisplayName: "Meal Planner",
      severity: "error",
      ruleId: "flow-poisson-low",
      snoozeUntil: "2026-07-09T12:00:00.000Z",
      occurrences: 1,
    });
  });

  /**
   * Bead `ro-ujb9.229` (decided with `ro-ujb9.194`): one row, one list. A
   * snooze is put off, not settled, so the row the Snoozed panel lists is not
   * also History's — GET /api/alerts/history, which the History tab and the
   * strip's "Settled · 7d" both read, does not return it.
   */
  it("is on Open's Snoozed panel and not in GET /api/alerts/history while it is quiet", async () => {
    const tomorrow = new Date(NOW_MS + 86_400_000).toISOString();
    const ctx = await storeWithSnooze(tomorrow);
    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.snoozed.map((row) => row.snoozeUntil)).toEqual([tomorrow]);

    const url = new URL("http://tower.test/api/alerts/history?limit=100");
    const res = await handleAlertHistoryRequest(new Request(url), url, ctx.call, { now: NOW });
    const history = (await res.json()) as { total: number; rows: unknown[] };
    expect(history).toMatchObject({ total: 0, rows: [] });
  });

  it("returns to the rail and the counts the moment the date passes", async () => {
    const ctx = await storeWithSnooze("2026-07-04T12:00:00.000Z");
    const p = await buildWallPayload(ctx.call, OPTIONS);

    expect(p.attention).toHaveLength(1);
    expect(p.attention[0]).toMatchObject({
      ruleId: "flow-poisson-low",
      severity: "error",
    });
    const card = p.assets.find((a) => a.id === "meals.example")!;
    expect(card.openError).toBe(1);
    expect(card.worstSeverity).toBe("error");
    // And it has left the snoozed ledger — one row, one list.
    expect(p.snoozed).toEqual([]);
  });

  /**
   * Bead `ro-w13s`. The ledger used to carry the open table's error/warn scope
   * while Snooze was offered on EVERY open row of the asset hero, so an
   * operator could park an info or milestone row and find it in no portfolio
   * list at all — the silent hide this section exists to prevent.
   */
  it("lists an info-severity snooze, which the open attention scope still excludes", async () => {
    const ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "live", 0, 0);
    await insertFlag(ctx, {
      asset: "meals.example",
      fired_at: "2026-07-04T02:00:00.000Z",
      severity: "info",
      kind: "milestone",
      metric: "signups",
      message: "1,000th signup",
      rule_id: "milestone-signups",
      disposition: "snooze",
      snooze_until: "2026-07-09T12:00:00.000Z",
    });

    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.snoozed).toHaveLength(1);
    expect(p.snoozed[0]).toMatchObject({
      asset: "meals.example",
      severity: "info",
      kind: "milestone",
      snoozeUntil: "2026-07-09T12:00:00.000Z",
    });

    // And nothing about the ATTENTION scope widened with it: an info row was
    // never something the portfolio owed an answer about, snoozed or not.
    expect(p.attention).toEqual([]);
    const card = p.assets.find((a) => a.id === "meals.example")!;
    expect(card.openError).toBe(0);
    expect(card.openWarn).toBe(0);
    expect(card.worstSeverity).toBeNull();
  });

  it("parks a recurring condition as ONE row, dated by its last firing", async () => {
    const ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "live", 0, 0);
    for (const [index, day] of ["01", "02", "03"].entries()) {
      await insertFlag(ctx, {
        asset: "meals.example",
        fired_at: `2026-07-${day}T02:00:00.000Z`,
        severity: "warn",
        kind: "anomaly",
        metric: "apiRequests",
        message: "below baseline",
        rule_id: "asset-declared",
        disposition: "snooze",
        snooze_until: `2026-07-1${index}T12:00:00.000Z`,
      });
    }

    const p = await buildWallPayload(ctx.call, OPTIONS);
    expect(p.snoozed).toHaveLength(1);
    expect(p.snoozed[0]).toMatchObject({
      occurrences: 3,
      // The LAST date, because the row is quiet until its last member is;
      // saying the earliest would promise a return that does not happen.
      snoozeUntil: "2026-07-12T12:00:00.000Z",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE THREE THINGS /assets' COMPARISON TABLE NEEDS (bead `ro-78qo.35`).
//
// Doc 21's Assets row is one table with a sparkline per measurement and a
// 7 · 28 · 90 range. It shipped with ONE column and a 7d/28d selector because
// the payload it reads — this one — carried active users, no search clicks, no
// per-asset monthly net, and twenty-eight days of anything. These pin the three
// fields that close that, and the one property that makes them safe: the Wall's
// own drawn window did not move.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildWallPayload — what the comparison table reads off a card", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "live", 0, 0);
    await insertAsset(ctx, "nosh.example", "Nosh", "live", 0, 0);
    await insertAsset(ctx, "root-os", "NoticeOS", "live", 0, 1);
  });

  const cardOf = async (id: string) =>
    (await buildWallPayload(ctx.call, OPTIONS)).assets.find((a) => a.id === id)!;

  /**
   * TWO PROVIDERS, ONE MEASUREMENT. A table column states clicks; it does not
   * state Google's clicks beside Bing's and leave the reader to add them —
   * which is the defect `ed58223` removed from the asset page, in the same
   * portfolio, over the same days.
   */
  it("merges Google and Bing clicks into one series per asset", async () => {
    await insertSignalSnapshot(ctx, "gsc", "clicks", [10, 20, 30]);
    await insertSignalSnapshot(ctx, "bing-webmaster", "clicks", [1, 2, 3]);

    const card = await cardOf("meals.example");
    expect(card.searchClicks.series).toEqual([
      { t: "2026-07-03", v: 11 },
      { t: "2026-07-04", v: 22 },
      { t: "2026-07-05", v: 33 },
    ]);
  });

  /**
   * A DAY ONLY ONE PROVIDER HAS REPORTED CARRIES ONLY THAT ONE. Bing trails
   * Google by days; filling its silence with a zero would draw a cliff on a day
   * nothing happened on, which is the same lie as a fabricated ledger month.
   */
  it("never turns a provider's latency into a zero", async () => {
    await insertSignalSnapshot(ctx, "gsc", "clicks", [10, 20, 30]);
    await insertSignalSnapshot(ctx, "bing-webmaster", "clicks", [1, 2], "2026-07-03");

    const card = await cardOf("meals.example");
    // The third day is Google's alone — 30, not 30 + 0, and not dropped.
    expect(card.searchClicks.series.at(-1)).toEqual({ t: "2026-07-05", v: 30 });
  });

  /** A day EITHER provider is still filling is provisional for the pair: the
   * alternative compares a settled Bing day against a Google day still being
   * counted and calls the pair complete. */
  it("takes the earlier provisional boundary of the two", async () => {
    await insertSignalSnapshot(ctx, "gsc", "clicks", [10, 20, 30]);
    await insertSignalSnapshot(ctx, "bing-webmaster", "clicks", [1, 2, 3]);

    const card = await cardOf("meals.example");
    // gsc is `includes-provisional` through its last day; bing is `final`.
    expect(card.searchClicks.provisionalFrom).toBe("2026-07-05");
  });

  /** Neither provider wired is a designed empty series, never a row of zeroes. */
  it("leaves search clicks empty for an asset with no webmaster provider", async () => {
    await insertSignalSnapshot(ctx, "gsc", "clicks", [10, 20, 30]);

    const card = await cardOf("nosh.example");
    expect(card.searchClicks.series).toEqual([]);
    expect(card.searchClicks.provisionalFrom).toBeNull();
  });

  /**
   * ONE DERIVATION, TWO PAYLOADS. `netByMonth` comes off the same grouping
   * /financials' by-asset table is built from, so the Wall, /assets and the
   * accounting page cannot disagree about a asset's month.
   */
  it("carries each asset's net month by month, direct costs only", async () => {
    await insertLedger(ctx, { id: 1, kind: "revenue", asset: "meals.example", period: "2026-05", family: "ads", amount: 100, booking_state: "reconciled", recorded_at: "2026-05-31T00:00:00.000Z" });
    await insertLedger(ctx, { id: 2, kind: "cost", asset: "meals.example", period: "2026-05", family: "api", amount: 5, booking_state: "reconciled", recorded_at: "2026-05-31T00:00:00.000Z" });
    await insertLedger(ctx, { id: 3, kind: "revenue", asset: "meals.example", period: "2026-06", family: "ads", amount: 200, booking_state: "estimated", recorded_at: "2026-06-30T00:00:00.000Z" });
    await insertLedger(ctx, { id: 4, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 300, booking_state: "estimated", recorded_at: "2026-07-02T00:00:00.000Z" });
    // Portfolio overhead. It books to asset #0 and reaches no asset's net.
    await insertLedger(ctx, { id: 5, kind: "cost", asset: "root-os", period: "2026-07", family: "inference", amount: 200, booking_state: "estimated", recorded_at: "2026-07-02T00:00:00.000Z" });

    const card = await cardOf("meals.example");
    expect(card.netByMonth).toEqual([
      { t: "2026-05", v: 95 },
      { t: "2026-06", v: 200 },
      { t: "2026-07", v: 300 },
    ]);
    // Not one cent of the $200 overhead reached it: July is 300, not 100.
    expect(card.netByMonth.at(-1)!.v).toBe(300);
    // And asset #0 has no card at all, so the overhead never lands in this
    // table under any month — it is /financials' own line.
    expect((await buildWallPayload(ctx.call, OPTIONS)).assets.map((a) => a.id)).not.toContain(
      "root-os",
    );
  });

  /** The month the store is standing in is still being counted, and the card
   * says which one that is rather than leaving a reader to find a clock. */
  it("names the open month as the provisional boundary", async () => {
    await insertLedger(ctx, { id: 1, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 300, booking_state: "estimated", recorded_at: "2026-07-02T00:00:00.000Z" });

    const card = await cardOf("meals.example");
    // NOW is 2026-07-05, so July is open — the clock's month, not the ledger's
    // newest, because those are different facts the moment a month goes by
    // without a row.
    expect(card.netByMonthProvisionalFrom).toBe("2026-07");
  });

  /**
   * A MONTH AN ASSET BOOKED NOTHING IN IS A HOLE, not a zero and not an
   * omission (bead `ro-78qo.37`). A sparkline spaces its points by position, so
   * omitting June would draw May next to July as though they were neighbours; a
   * zero would draw a trough the ledger never recorded. The axis is present and
   * the value is null, so the line breaks there.
   */
  it("puts a null on the axis for a month the asset has no row in", async () => {
    await insertLedger(ctx, { id: 1, kind: "revenue", asset: "meals.example", period: "2026-05", family: "ads", amount: 100, booking_state: "reconciled", recorded_at: "2026-05-31T00:00:00.000Z" });
    await insertLedger(ctx, { id: 2, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 300, booking_state: "estimated", recorded_at: "2026-07-02T00:00:00.000Z" });
    await insertLedger(ctx, { id: 3, kind: "revenue", asset: "nosh.example", period: "2026-06", family: "ads", amount: 10, booking_state: "estimated", recorded_at: "2026-06-30T00:00:00.000Z" });

    const card = await cardOf("meals.example");
    expect(card.netByMonth).toEqual([
      { t: "2026-05", v: 100 },
      { t: "2026-06", v: null },
      { t: "2026-07", v: 300 },
    ]);
  });

  /**
   * THE AXIS IS THE ASSET'S, NOT THE LEDGER'S. Nosh's first row is June, so it
   * has no May — prefixing one would invent a month it did not exist in, which
   * is a different mistake from the gap above.
   */
  it("starts each asset's axis at its own first row", async () => {
    await insertLedger(ctx, { id: 1, kind: "revenue", asset: "meals.example", period: "2026-05", family: "ads", amount: 100, booking_state: "reconciled", recorded_at: "2026-05-31T00:00:00.000Z" });
    await insertLedger(ctx, { id: 2, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 300, booking_state: "estimated", recorded_at: "2026-07-02T00:00:00.000Z" });
    await insertLedger(ctx, { id: 3, kind: "revenue", asset: "nosh.example", period: "2026-07", family: "ads", amount: 10, booking_state: "estimated", recorded_at: "2026-07-02T00:00:00.000Z" });

    expect((await cardOf("nosh.example")).netByMonth).toEqual([{ t: "2026-07", v: 10 }]);
  });

  /** A restated figure is a new row superseding the old one; counting both
   * would double the month the day it reconciles. */
  it("excludes a superseded row from the monthly net", async () => {
    await insertLedger(ctx, { id: 1, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 100, booking_state: "estimated", recorded_at: "2026-07-02T00:00:00.000Z" });
    await insertLedger(ctx, { id: 2, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 150, booking_state: "reconciled", supersedes_id: 1, recorded_at: "2026-07-04T00:00:00.000Z" });

    const card = await cardOf("meals.example");
    expect(card.netByMonth).toEqual([{ t: "2026-07", v: 150 }]);
  });

  /** No ledger at all is an empty series and no boundary — a provisional mark
   * on nothing is a claim about nothing. */
  it("carries no month and no boundary when the ledger is empty", async () => {
    const card = await cardOf("meals.example");
    expect(card.netByMonth).toEqual([]);
    expect(card.netByMonthProvisionalFrom).toBeNull();
  });

  /**
   * NINETY DAYS IN THE PAYLOAD, TWENTY-EIGHT ON THE TELEVISION.
   *
   * This is the property that makes the widening safe: the split, not the
   * total. `series` is the Wall's drawn window and did not move, so the card
   * chart and `wall:fit` are untouched; the other sixty-two days ride in
   * `contextSeries`, which nothing has ever drawn as chart days, and a desk
   * surface offering 90d reads the two together.
   */
  it("carries ninety days as twenty-eight drawn and sixty-two behind them", async () => {
    const values = Array.from({ length: 95 }, (_, index) => index + 1);
    await insertSignalSnapshot(ctx, "ga4", "active_users", values, "2026-04-02");

    const card = await cardOf("meals.example");
    expect(card.activeUsers.series).toHaveLength(28);
    expect(card.activeUsers.contextSeries).toHaveLength(62);
    expect([
      ...(card.activeUsers.contextSeries ?? []),
      ...card.activeUsers.series,
    ]).toHaveLength(90);
    // The drawn window still ends on the newest day and still starts 27 days
    // before it — the four complete weeks the TV's card is built around.
    expect(card.activeUsers.series.at(-1)).toEqual({ t: "2026-07-05", v: 95 });
    expect(card.activeUsers.series[0]).toEqual({ t: "2026-06-08", v: 68 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The nightly alert rollup (db/0033) is not the Wall's: no screen drew the
// series it carried, so a refresh no longer reads it (bead `ro-trai.44`).
// ─────────────────────────────────────────────────────────────────────────────

describe("a Wall refresh reads no alert rollup", () => {
  it("builds the same payload whether or not the store holds the rollup", async () => {
    // On Postgres (bead ro-ujb9.76.5.2) every store has the rollup's table, so
    // "without" is a store holding no row of it; and no statement names it.
    const withRollup = await createTestStore();
    await seed(withRollup);
    await seedReportsAndAlerts(withRollup);
    await (withRollup.call).write((tx) =>
      tx.execute(
        `INSERT INTO noticeos.alert_daily_counts
           (workspace_id, asset_id, day, observed_at, open, errors, warnings, median_open_age_hours)
         VALUES ($1, NULL, '2026-07-01', '2026-07-01T03:00:00.000Z', 2, 1, 1, 30)`,
        [tx.workspaceId],
      ),
    );
    const without = await createTestStore();
    await seed(without);
    await seedReportsAndAlerts(without);

    const statements: string[] = [];
    const a = await buildWallPayload(recordingStore(withRollup.call, statements), OPTIONS);
    const b = await buildWallPayload(without.call, OPTIONS);
    expect(Object.keys(a)).not.toContain("alertHistory");
    expect(b).toEqual(a);
    expect(statements.join("\n")).not.toMatch(/alert_daily_counts/);
  });
});

describe("an open fetch failure carries the nights behind it (ro-ujb9.220)", () => {
  const NIGHTS = [
    { at: "2026-07-04T02:30:00.000Z", error: "503 unconfigured", status: 503, count: 1 },
    { at: "2026-07-05T02:30:00.000Z", error: "401 unauthorized", status: 401, count: 2 },
  ];
  const inputs = (night: (typeof NIGHTS)[number]) => JSON.stringify({
    rule: "asset-pull-failed", url: "https://nosh.example/api/admin/overview", status: night.status,
    error: night.error, failureCount: night.count, lastFailedAt: night.at, evaluatedAt: night.at,
  });

  /** The outage's alert and, night by night, its readings, on Postgres (bead
   * ro-ujb9.76.5.2): its number. */
  async function insertOutage(ctx: TestStore, { snoozeUntil = null }: { snoozeUntil?: string | null } = {}): Promise<number> {
    const latest = NIGHTS.at(-1)!;
    const store = ctx.call;
    const id = await storeAlert(store, {
      asset: "nosh.example", firedAt: NIGHTS[0]!.at, severity: "warn", kind: "anomaly", metric: null,
      message: `pull failed: ${latest.error}`, ruleId: "asset-pull-failed", ruleInputs: inputs(latest),
      disposition: snoozeUntil ? "snooze" : null, dispositionAt: snoozeUntil ? NIGHTS[1]!.at : null,
      dispositionNote: snoozeUntil ? "parked" : null, snoozeUntil,
    });
    for (const night of NIGHTS) {
      await storeReading(store, id, { observedAt: night.at, severity: "warn", message: `pull failed: ${night.error}`, ruleInputs: inputs(night) });
    }
    return id;
  }

  it("the attention row lists each night, newest first; a parked one keeps them too", async () => {
    const ctx = await createTestStore();
    await seed(ctx);
    await seedReportsAndAlerts(ctx);
    const open = await insertOutage(ctx);
    const p = await buildWallPayload(ctx.call, OPTIONS);
    const row = p.attention.find((item) => item.id === open)!;
    expect(row.readings?.map((reading) => reading.ruleInputs?.error)).toEqual(["401 unauthorized", "503 unconfigured"]);
    for (const other of p.attention.filter((item) => item.id !== open)) expect(other).not.toHaveProperty("readings");

    const parkedStore = await createTestStore();
    await seed(parkedStore);
    await seedReportsAndAlerts(parkedStore);
    const parked = await insertOutage(parkedStore, { snoozeUntil: "2026-07-09T00:00:00.000Z" });
    const q = await buildWallPayload(parkedStore.call, OPTIONS);
    expect(q.snoozed.find((item) => item.id === parked)?.readings).toHaveLength(2);
  });
});


describe('month-start revenue evidence preserves reported zero separately from costs', () => {
  it.each([['cost', 'estimated'], ['cost', 'reconciled'], ['revenue', 'estimated'], ['revenue', 'reconciled']] as const)('preserves the %s / %s presence without changing money', async (kind, booking_state) => {
    const ctx = await createTestStore();
    try {
      await insertAsset(ctx, 'sample.test', 'Sample', 'live', 0, 0);
      await insertLedger(ctx, { id: 1, kind, asset: 'sample.test', period: '2026-10', family: kind === 'cost' ? 'inference' : 'ads', amount: kind === 'cost' ? 35 : 0, booking_state, recorded_at: '2026-10-01T00:00:00Z' });
      const payload = await buildWallPayload(ctx.call, { ...OPTIONS, now: new Date('2026-10-01T12:00:00Z') });
      expect(payload.portfolio.period).toBe('2026-10');
      expect(payload.portfolio.revenueRecorded).toEqual({ booked: kind === 'revenue' && booking_state === 'reconciled', forecast: kind === 'revenue' && booking_state === 'estimated' });
      const side = booking_state === 'reconciled' ? 'booked' : 'forecast';
      expect(payload.portfolio[side]).toEqual({ currency: 'USD', revenue: 0, cost: kind === 'cost' ? 35 : 0, net: kind === 'cost' ? -35 : 0 });
    } finally { await ctx.close(); }
  });
});
