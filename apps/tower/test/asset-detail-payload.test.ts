// @vitest-environment node
import { PulseEnvelope } from "@noticeos/contract";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { beforeEach, describe, expect, it } from "vitest";
import type { PullConfigEntry } from "../worker/asset-config";
import {
  type AssetDetailDeps,
  buildAssetDetailPayload,
  buildAssetDetailView,
} from "../worker/asset-detail-payload";
import {
  ASSET_DETAIL_VIEWS,
  ASSET_VIEW_SECTIONS,
  type AssetDetailFor,
  type AssetDetailResponse,
  viewCovers,
} from "../shared/asset-detail-views";
import { ASSET_TABS } from "@/routes/asset-detail/AssetTabs";
import { loadSignalTrends } from "../worker/signal-trends";
import { figureHasMoney, panelReviewState } from "../shared/wall";
import { serpPanelScoreboard } from "../shared/asset-detail";
import posthogProduct from "../src/routes/kitchen-sink/posthog-product.json";
import { type AlertRow, type ReportRow, storeAlert, storeAlerts, storeReading, storeReport, storeReports } from "./alert-rows";
import { valuesOf, writeSignalRun, writeSignalValues } from "./collected-metrics";
import { writeInsightSnapshots } from "./provider-reports";
import { type TestStore, createTestStore, recordingStore } from "./postgres-store";
import { storeChange, storeChanges, storeWatchWindow } from "./change-rows";
import { bookLedger, bookedNumber, writeMediavine } from "./money";

import { addSites } from "./sites";
import {
  insertDataForSeoCollection,
  panelReviewBead,
  seedSnapshot,
  workProject,
} from "./panel-fixtures";

const NOW = new Date("2026-07-05T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

const FLAG_DEFAULTS = { alpha: 0.01, min_baseline_per_day: 3, low_volume_window_hours: 72 };
const INTEGRATIONS = {
  catalog: [
    { id: "gsc", label: "Google Search Console", docRef: "docs/11-integrations.md#the-catalog", credential: "shared" as const },
    { id: "ad-network", label: "Ad network reporting", docRef: "docs/11-integrations.md#the-catalog", credential: "shared" as const },
    { id: "affiliate-cj", label: "Affiliate — CJ", docRef: "docs/11-integrations.md#the-catalog", credential: "shared" as const },
  ],
  assets: {
    "meals.example": {
      gsc: { status: "needs-setup" as const, note: "central collector not built", since: "2026-07-06" },
      "ad-network": { status: "needs-setup" as const, note: "ingestion not built", since: "2026-07-06" },
      "affiliate-cj": { status: "needs-setup" as const, note: "manual CSV interim", since: "2026-07-06" },
    },
    "fees.example": {
      gsc: { status: "not-applicable" as const, note: "pre-launch", since: "2026-07-06" },
      "ad-network": { status: "not-applicable" as const, note: "pre-launch", since: "2026-07-06" },
      "affiliate-cj": { status: "not-applicable" as const, note: "pre-launch", since: "2026-07-06" },
    },
  },
};
// Both wire formats, exactly as config/pull.json carries them: a prometheus
// entry with its metric→counter map, and an envelope entry with NO `metrics`
// key at all (the endpoint already speaks the contract).
const PULL_CONFIG: PullConfigEntry[] = [
  {
    asset: "meals.example",
    url: "https://meals.example/api/internal/metrics",
    enabled: true,
    format: "prometheus",
    metrics: { signups: { counter: "profiles" }, plansSaved: { counter: "saved" } },
  },
  {
    asset: "nosh.example",
    url: "https://nosh.example/api/admin/overview",
    enabled: true,
    format: "envelope",
  },
];

// config/serp-panel.json's real shape: a MINORITY of assets buy a tracked
// panel (meals.example since 2026-07, nosh.example since 2026-08-03). This fixture
// names one, so every other asset here owes the SAME weekly read in the
// other noun — signal collection, never SERP panel (bead ro-z0g). Membership
// stopped gating the marker at ro-1tu; it picks the words only.
const SERP_PANEL = { assets: { "meals.example": { queries: ["meals"] } } };

// config/signal-panels.json's real shape: EVERY asset has a row, including the
// ones that are off — its README makes membership an invariant rather than an
// opt-in — so this fixture names an enabled asset and a disabled one. The
// payload reads it for the same one thing as counters: what a Delete would have
// to remove with the row (bead ro-sk7q).
const SIGNAL_PANELS = {
  assets: {
    "meals.example": {
      enabled: true,
      reason: "live-lanes",
      note: "GSC + GA4 live.",
      since: "2026-08-03",
    },
    "nosh.example": {
      enabled: false,
      reason: "no-lane-yet",
      note: "Enable when a search lane goes live.",
      since: "2026-08-03",
    },
  },
};

// config/counters.json's real shape: an asset with an entry declares total
// cards; one with none declares nothing. The payload reads it for ONE thing —
// what a Delete would have to remove with the row (bead ro-z349.2).
const COUNTERS = {
  assets: {
    "meals.example": {
      cards: [{ metric: "signups", counter: "profiles", label: "Accounts" }],
    },
  },
};

// The GA4 lane's two declarations (bead `ro-x5gu.3`). meals.example declares
// value events and nothing else; nosh.example has registered dimensions and declares
// no value event; every other asset is absent from both — which is the state
// these files are mostly in, and the one the payload has to keep distinct from
// an empty list.
const VALUE_EVENTS = {
  assets: {
    "meals.example": { valueEvents: ["calculation_complete", "sign_up"] },
    "nosh.example": { valueEvents: [] },
  },
};

const GA4_EVENT_PARAMS = {
  assets: {
    "nosh.example": { eventParams: ["message", "source"] },
  },
};

const DEPS: AssetDetailDeps = {
  now: NOW,
  flagDefaults: FLAG_DEFAULTS,
  pullConfig: PULL_CONFIG,
  monthlyCaps: { dataUsd: 25 },
  operatorRateUsdPerMin: 2,
  integrations: INTEGRATIONS,
  counters: COUNTERS,
  serpPanel: SERP_PANEL,
  signalPanels: SIGNAL_PANELS,
  valueEvents: VALUE_EVENTS,
  ga4EventParams: GA4_EVENT_PARAMS,
  // The checked-in file declares no entity, which is the state every assertion
  // below was written against. The one test that needs an owner brings its own
  // rows (bead `ro-xzxg`).
  // The operator's clock these fixtures were written in (bead `ro-ujb9.88`):
  // stated, rather than borrowed from the checkout's config/constants.json.
  osTimeZone: "America/Los_Angeles" };

async function insertAsset(
  raw: TestStore,
  id: string,
  name: string,
  status: string,
  senseOnly: number,
  isOs: number,
  domain: string | null = `${id}`,
) {
  // In both of the test's stores: the page reads the site from the site list
  // on Postgres and joins D1's copy of it (test/sites.ts).
  await addSites(raw, [{ id, domain, displayName: name, status, senseOnly, isOs, createdAt: "2026-07-01T00:00:00.000Z" }]);
}

type MetricMap = Record<string, { last24h: number; avg7d?: number; total?: number }>;

/** One nightly report as the store holds it (bead ro-ujb9.76.5.2). */
function report(asset: string, date: string, receivedAt: string, metrics: MetricMap): ReportRow {
  return { asset, date, receivedAt, envelope: { asset, metrics } };
}


interface FlagSpec {
  asset: string;
  fired_at: string;
  severity: "info" | "warn" | "error";
  kind: "anomaly" | "opportunity" | "milestone";
  rule_id: string;
  metric?: string | null;
  message?: string | null;
  rule_inputs?: Record<string, unknown> | null;
  disposition?: string | null;
  disposition_note?: string | null;
  ack_expiry?: string | null;
  /** For `disposition: "snooze"` — when the condition returns (`ro-c7qq`). */
  snooze_until?: string | null;
  resolved_at?: string | null;
}

function alertRow(f: FlagSpec): AlertRow {
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
    dispositionAt: f.disposition ? "2026-07-04T09:00:00.000Z" : null,
    dispositionNote: f.disposition_note ?? null,
    ackExpiry: f.ack_expiry ?? null,
    snoozeUntil: f.snooze_until ?? null,
    resolvedAt: f.resolved_at ?? null,
  };
}

/** One alert, on Postgres in the test's copy of its sites (bead
 * ro-ujb9.76.5.2): its number, which the page shows as its id. */
async function insertFlag(ctx: TestStore, f: FlagSpec): Promise<number> {
  return storeAlert(ctx.call, alertRow(f));
}

interface LedgerSpec {
  id: number;
  kind: "revenue" | "cost";
  asset: string;
  period: string;
  family: string;
  /** DOLLARS, for readable fixtures — the store never sees this number. It is
   * rounded to exact cents on the way in, which is all `/api/revenue` writes. */
  amount: number;
  booking_state: "estimated" | "reconciled";
  source?: string | null;
  ref?: string | null;
  supersedes_id?: number | null;
  recorded_at: string;
}

/** Writes `amount_minor` and nothing else, exactly as `/api/revenue` does since
 * db/0020 dropped the `amount REAL` mirror — a fixture still filling a column
 * the store no longer has would test a shape no writer produces. On Postgres
 * (bead ro-ujb9.76.6.1), in the test's own copy of its sites (test/money.ts):
 * `id` and `supersedes_id` are the fixture's names for its entries, and the
 * page shows each by the number the store handed it (`bookedNumber`). */
async function insertLedger(ctx: TestStore, r: LedgerSpec) {
  await bookLedger(ctx.call, [{
    id: r.id,
    kind: r.kind,
    asset: r.asset,
    period: r.period,
    family: r.family,
    amount_minor: Math.round(r.amount * 100),
    booking_state: r.booking_state,
    source: r.source ?? null,
    ref: r.ref ?? null,
    supersedes_id: r.supersedes_id ?? null,
    recorded_at: r.recorded_at,
  }]);
}

// --- the compact analysis snapshot, as the analyzer publishes it -------------
// Each family is a separate fixture so a test can corrupt exactly one branch
// (a provider, an insight, a ranking key) and assert what still survives.
const GOOGLE_TREND = {
  provider: "google",
  currentStart: "2026-07-03",
  currentEnd: "2026-07-04",
  previousStart: "2026-07-01",
  previousEnd: "2026-07-02",
  daysPerWindow: 2,
  movers: [
    {
      query: "weekly meal plan",
      currentImpressions: 140,
      previousImpressions: 100,
      impressionDelta: 40,
      impressionDeltaPercent: 40,
      currentPosition: 6,
      previousPosition: 7,
      positionImprovement: 1,
    },
  ],
  source: "gsc/query",
  caveat: "Only comparable top rows.",
};

const DATAFORSEO_SNAPSHOT = {
  observedAt: "2026-07-04",
  queries: [
    {
      query: "weekly meal plan",
      monthlySearches: 1900,
      organicPosition: 7,
      previousOrganicPosition: null,
      positionImprovement: null,
      keywordDifficulty: 24,
      estimatedVisits: 31,
      page: "/meal-plan",
      intent: "informational",
      aiOverview: "cited",
      aiCitationPosition: 2,
    },
  ],
  source: "dataforseo/ranked-keywords",
  caveat: "Search volume is estimated demand, not impressions.",
};

// Key names mirror scripts/signal-insights.mjs — the parser validates these
// exact names, so this fixture is also the contract between the two.
const SEARCH_INTELLIGENCE = {
  observedAt: "2026-07-04",
  costUsd: 1.42,
  rankings: {
    keywords: 184,
    top3: 4,
    top10: 19,
    top20: 41,
    estimatedVisits: 1203,
    estimatedPaidTrafficCost: 812.4,
    aiOverviewReferences: 6,
  },
  backlinks: {
    rank: 210,
    backlinks: 940,
    referringDomains: 128,
    newReferringDomains: 7,
    lostReferringDomains: 3,
  },
  ai: {
    googleMentions: 12,
    googleSearchVolume: 5400,
    chatgptMentions: 3,
    chatgptSearchVolume: 900,
  },
};

const PRODUCT_USE = {
  windowStart: "2026-06-07",
  windowEnd: "2026-07-04",
  days: 28,
  build: [
    {
      key: "item-openers",
      eventName: "builder_item_open",
      label: "Opened an item",
      users: 23,
      events: 41,
    },
  ],
  sharing: [],
  supporting: [],
  source: "ga4/events-28d",
  caveat: "Unique independently per action type.",
};

function executiveSnapshot() {
  return {
    schemaVersion: 1,
    asset: "meals.example",
    generatedAt: "2026-07-05T11:30:00.000Z",
    windowStart: "2026-07-01",
    windowEnd: "2026-07-04",
    sourceArchiveCount: 12,
    items: [
      {
        key: "opportunity",
        kind: "recommendation",
        title: "Review a near-ranking query",
        summary: "Existing demand sits below the top results.",
        whyItMatters: "This is observed demand.",
        primary: { value: "1,003", label: "captured impressions" },
        confidence: "high",
        windowStart: "2026-07-01",
        windowEnd: "2026-07-04",
        evidence: [{ label: "Average position", value: "5.9" }],
        sources: ["gsc/page-query"],
        caveat: "Top rows can omit low-volume demand.",
      },
    ],
    searchQueries: {
      google: GOOGLE_TREND,
      bing: null,
      dataforseo: DATAFORSEO_SNAPSHOT,
    },
    productUse: PRODUCT_USE,
    searchIntelligence: SEARCH_INTELLIGENCE,
    methodology: ["Missing rows remain unknown."],
  };
}

/** Publish one presentation snapshot, in the test's own Postgres copy of its
 * sites (bead ro-ujb9.76.5.4). `payload` is deliberately `unknown`: the point
 * of most of these cases is a payload the producer should never write. */
async function insertSnapshot(
  raw: TestStore,
  id: string,
  payload: unknown,
  /** The indexed window columns, when they cannot be read off the payload. The
   * table's CHECK constraint requires both or neither, so a payload missing one
   * date is stored against a row that carries neither. */
  windowColumns?: { start: string | null; end: string | null },
  /** When the store took it; the store's clock by default. */
  createdAt?: string,
): Promise<void> {
  const snapshot = payload as {
    generatedAt: string;
    windowStart: string | null;
    windowEnd: string | null;
    sourceArchiveCount: number;
  };
  await writeInsightSnapshots(raw.call, [{
    id,
    asset: "meals.example",
    generated_at: snapshot.generatedAt,
    window_start: windowColumns ? windowColumns.start : snapshot.windowStart,
    window_end: windowColumns ? windowColumns.end : snapshot.windowEnd,
    source_archive_count: snapshot.sourceArchiveCount,
    payload: JSON.stringify(payload),
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
  }]);
}

/** meals' ledger: id1 estimate superseded by id2 reconciled; + affiliate rev +
 * cost. Written by the tests that read it, so the rest of `seed` stays a copy
 * every test shares. */
async function seedLedger(ctx: TestStore) {
  await insertLedger(ctx, { id: 1, kind: "revenue", asset: "meals.example", period: "2026-06", family: "ads", amount: 560, booking_state: "estimated", source: "raptive-report", recorded_at: "2026-06-30T00:00:00.000Z" });
  await insertLedger(ctx, { id: 2, kind: "revenue", asset: "meals.example", period: "2026-06", family: "ads", amount: 498.1, booking_state: "reconciled", source: "raptive-report", supersedes_id: 1, recorded_at: "2026-07-03T00:00:00.000Z" });
  await insertLedger(ctx, { id: 3, kind: "revenue", asset: "meals.example", period: "2026-06", family: "affiliate", amount: 168.2, booking_state: "estimated", source: "cj-export", recorded_at: "2026-06-30T00:00:00.000Z" });
  await insertLedger(ctx, { id: 4, kind: "cost", asset: "meals.example", period: "2026-06", family: "inference", amount: 22.1, booking_state: "estimated", ref: "chg-0421", recorded_at: "2026-06-30T00:00:00.000Z" });
}

async function seed(raw: TestStore) {
  // The OS row with the owner's pre-rename stored name (bead ro-ujb9.77.10).
  await insertAsset(raw, "root-os", "ReindexOS", "live", 0, 1, null);
  await insertAsset(raw, "meals.example", "Meal Planner", "onboarding", 0, 0);
  await insertAsset(raw, "nosh.example", "Nosh", "onboarding", 0, 0);
  await insertAsset(raw, "fees.example", "Fee Codes", "pre-launch", 1, 0);

  // Nightly reports and alerts are on Postgres: `seedReportsAndAlerts`.

  // meals' ledger is on Postgres: `seedLedger`, written by the tests that read it.

  // meals' two changes are on Postgres: `seedChanges`.
}

/**
 * `seed`'s changes for meals, on Postgres (bead ro-ujb9.76.5.7), in the test's
 * copy of its sites: written by the tests that read them.
 */
async function seedChanges(ctx: TestStore): Promise<void> {
  await storeChanges(ctx.call, [
    { asset: "meals.example", at: "2026-07-04T18:30:00.000Z", kind: "deploy", ref: "a1b2c3d", note: "ship CJ product cards" },
    { asset: "meals.example", at: "2026-06-05T00:00:00.000Z", kind: "external", ref: "google-core-update", note: "core update" },
  ]);
}

/**
 * `seed`'s nightly reports and alerts, on Postgres (bead ro-ujb9.76.5.2), in
 * the test's copy of its sites: written by the tests that read them, so the
 * rest of `seed` stays a copy every test in a file shares.
 */
async function seedReportsAndAlerts(ctx: TestStore) {
  const store = ctx.call;
  await storeReports(store, [
    // meals: two days of pulses (pull mode), signups + plansSaved.
    report("meals.example", "2026-07-04", new Date(NOW_MS - 34 * HOUR).toISOString(), {
      signups: { last24h: 12, avg7d: 9.4, total: 4223 },
      plansSaved: { last24h: 9, avg7d: 6.6, total: 1907 },
    }),
    report("meals.example", "2026-07-05", new Date(NOW_MS - 10 * HOUR).toISOString(), {
      signups: { last24h: 10, avg7d: 10, total: 4233 },
      plansSaved: { last24h: 0, avg7d: 6, total: 1907 },
    }),

    // nom: one stale pulse (envelope pull) + an open ingest-freshness error.
    report("nosh.example", "2026-07-02", new Date(NOW_MS - 3 * DAY).toISOString(), {
      items: { last24h: 47, avg7d: 42, total: 12954 },
    }),
  ]);
  await storeAlerts(store, [
    // meals flags: open warn + open milestone(info) + open pull-failure(warn),
    // plus a dispositioned (ack) and a resolved one (history).
    alertRow({
      asset: "meals.example",
      fired_at: "2026-07-05T02:06:00.000Z",
      severity: "warn",
      kind: "anomaly",
      metric: "plansSaved",
      message: "0 in last24h (avg7d 6, P<0.01)",
      rule_id: "flow-poisson-low",
      rule_inputs: {
        metric: "plansSaved",
        observed: 0,
        baselinePerDay: 6,
        alpha: 0.01,
        pLowerTail: 0.0025,
      },
    }),
    alertRow({
      asset: "meals.example",
      fired_at: "2026-07-01T02:06:00.000Z",
      severity: "info",
      kind: "milestone",
      metric: "signups",
      message: "4,200 total signups crossed",
      rule_id: "asset-declared",
    }),
    alertRow({
      asset: "meals.example",
      fired_at: "2026-07-05T02:30:00.000Z",
      severity: "warn",
      kind: "anomaly",
      message: "pull failed: 503 upstream_unavailable",
      rule_id: "asset-pull-failed",
      rule_inputs: {
        rule: "asset-pull-failed",
        url: "https://meals.example/api/os/report",
        status: 503,
        error: "503 upstream_unavailable — try again later",
        providerError: "upstream_unavailable",
        failureCount: 3,
        lastFailedAt: "2026-07-05T02:30:00.000Z",
      },
    }),
    alertRow({
      asset: "meals.example",
      fired_at: "2026-06-28T02:06:00.000Z",
      severity: "warn",
      kind: "anomaly",
      metric: "leads",
      message: "weekend dip",
      rule_id: "flow-poisson-low",
      disposition: "ack",
      disposition_note: "known weekend dip",
      ack_expiry: "2026-07-12T00:00:00.000Z",
    }),
    alertRow({
      asset: "meals.example",
      fired_at: "2026-06-20T02:06:00.000Z",
      severity: "error",
      kind: "anomaly",
      metric: "foodLog",
      message: "resolved outage",
      rule_id: "flow-pct-drop",
      resolved_at: "2026-06-21T02:06:00.000Z",
    }),

    // nom: open ingest-freshness error (push asset went silent).
    alertRow({
      asset: "nosh.example",
      fired_at: "2026-07-05T04:00:00.000Z",
      severity: "error",
      kind: "anomaly",
      message: "0 pulses in 36h",
      rule_id: "ingest-freshness",
    }),
  ]);
}

interface WatchWindowSpec {
  id: string;
  asset: string;
  metric_integration: "ga4" | "gsc" | "bing-webmaster";
  metric: string;
  registered_at: string;
  check_offsets: number[];
  readings: { offset_days: number; check_date: string }[];
  status?: "open" | "closed";
  outcome?: string | null;
  outcome_note?: string | null;
  closed_at?: string | null;
  readback_bead?: string | null;
  note?: string | null;
  /** What the window is anchored to. Defaults to free text naming itself; an
   * `annotation` window carries the annotations.id it points at, as TEXT. */
  ref_kind?: "annotation" | "decision" | "manual";
  ref?: string;
  /** The one query or page the window is narrowed to, as the store holds it. */
  scope_json?: string | null;
}

/** A pre-registered outcome check, written the way the ingest worker's operator
 * API writes one, on Postgres (bead ro-ujb9.76.5.7). The baseline window ends
 * on the registration date, which the schema's own CHECK enforces. */
async function insertWatchWindow(ctx: TestStore, w: WatchWindowSpec): Promise<void> {
  const closed = (w.status ?? "open") === "closed";
  await storeWatchWindow(ctx.call, {
    id: w.id,
    asset: w.asset,
    refKind: w.ref_kind ?? "manual",
    ref: w.ref ?? w.id,
    integration: w.metric_integration,
    metric: w.metric,
    scope: w.scope_json ?? null,
    registeredAt: w.registered_at,
    baselineStart: "2026-04-01",
    baselineEnd: w.registered_at.slice(0, 10),
    offsets: w.check_offsets,
    read: w.readings.map((reading) => reading.offset_days),
    note: w.note ?? null,
    readbackBead: w.readback_bead ?? null,
    closed: closed ? { outcome: w.outcome!, at: w.closed_at!, note: w.outcome_note ?? null } : null,
  });
}

/** One change, on Postgres (bead ro-ujb9.76.5.7); returns the number the store
 * handed it, which is what a watch window anchors to (`ref_kind='annotation'`,
 * `ref` = that number as text). */
async function insertAnnotation(
  ctx: TestStore,
  asset: string,
  at: string,
  kind = "deploy",
  ref: string | null = null,
  note: string | null = null,
): Promise<number> {
  return storeChange(ctx.call, { asset, at, kind, ref, note });
}

/** `count` daily deploys starting at `oldestIso`, in one statement. Returns
 * their numbers OLDEST FIRST, so a test can name "the Nth-newest change" by
 * index. */
async function insertDailyDeploys(
  ctx: TestStore,
  asset: string,
  count: number,
  oldestIso: string,
): Promise<number[]> {
  const start = Date.parse(oldestIso);
  return storeChanges(
    ctx.call,
    Array.from({ length: count }, (_, i) => ({
      asset,
      at: new Date(start + i * DAY).toISOString(),
      kind: "deploy",
      ref: `sha-${i}`,
      note: `deploy ${i}`,
    })),
  );
}

/** One site-check reading as workers/ingest/src/hygiene.ts writes it, on
 * Postgres (bead ro-ujb9.76.5.8). */
async function insertHygieneReading(
  store: WorkspaceStore,
  { asset, check, day, status, value, detail = {}, at = `${day}T04:00:00.000Z` }: {
    asset: string; check: string; day: string; status: string; value: number | null;
    detail?: Record<string, unknown>; at?: string;
  },
): Promise<void> {
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.hygiene_checks (workspace_id, asset_id, check_id, observed_at, observed_on, status, value_num, detail)
       VALUES ($1, $2, $3, $4::timestamptz, $5::date, $6, $7, $8::json)`,
      [tx.workspaceId, asset, check, at, day, status, value, JSON.stringify(detail)],
    ),
  );
}

interface ReclamationSpec {
  asset: string;
  domain: string;
  /** '' means "no specific page" — never NULL, or the unique key stops working. */
  page: string;
  status: string;
  statusAt: string | null;
}

/** Link-outreach targets, on Postgres (bead ro-ujb9.76.5.8), in the order given. */
async function insertReclamationTargets(store: WorkspaceStore, targets: ReclamationSpec[]) {
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.reclamation_targets (workspace_id, asset_id, domain, referring_page, status, status_at)
       SELECT $1::uuid, t.asset_id, t.domain, t.page, t.status, t.status_at
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[])
           WITH ORDINALITY AS t(asset_id, domain, page, status, status_at, listed)
        ORDER BY t.listed`,
      [
        tx.workspaceId,
        targets.map((target) => target.asset),
        targets.map((target) => target.domain),
        targets.map((target) => target.page),
        targets.map((target) => target.status),
        targets.map((target) => target.statusAt),
      ],
    ),
  );
}

describe("buildAssetDetailPayload", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seed(ctx);
  });

  it("returns null for an unknown asset id (→ 404)", async () => {
    const p = await buildAssetDetailPayload(ctx.call, "does.not.exist", DEPS);
    expect(p).toBeNull();
  });

  it("resolves PULL mode from config/pull.json, with url + metric mapping", async () => {
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.wiring.mode).toBe("pull");
    expect(p.wiring.push).toBeNull();
    expect(p.wiring.pull?.url).toBe("https://meals.example/api/internal/metrics");
    expect(p.wiring.pull?.enabled).toBe(true);
    expect(p.wiring.pull?.metricMap).toContainEqual({ metric: "signups", counter: "profiles" });
    // A state in plain words, never the environment binding (bead ro-ujb9.166).
    expect(p.wiring.pull?.auth).toBe("Site token");
    expect(p.wiring.modeOwner).toBe("config/pull.json");
    // the pull entry's array index anchors the changeset edit pointers.
    expect(p.wiring.pull?.index).toBe(0);
    // The pull job's schedule as the runner reads it — its default while
    // nothing is saved (bead ro-ujb9.96.7.12).
    expect(p.wiring.schedule).toEqual({ job: "pull", enabled: true, cron: "30 2 * * *" });
  });

  it("reads the nightly report's schedule from the SAVED schedules the runner arms, never a typed time", async () => {
    // One derivation per fact (D30): once the operator moves the pull job in
    // Settings → Data collection, the asset page says the new time too.
    const saved = { pull: { enabled: true, cron: "15 9 * * *", timezone: "America/Los_Angeles" } };
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", { ...DEPS, schedules: saved }))!;
    expect(p.wiring.schedule).toEqual({ job: "pull", ...saved.pull });
    const paused = { pull: { enabled: false, cron: "30 2 * * *" } };
    const q = (await buildAssetDetailPayload(ctx.call, "meals.example", { ...DEPS, schedules: paused }))!;
    expect(q.wiring.schedule).toMatchObject({ job: "pull", enabled: false });
  });

  it("resolves PUSH mode for assets absent from pull.json, auth named as the site's token", async () => {
    const p = (await buildAssetDetailPayload(ctx.call, "fees.example", DEPS))!;
    expect(p.wiring.mode).toBe("push");
    expect(p.wiring.pull).toBeNull();
    expect(p.wiring.push?.endpoint).toBe("POST /api/pulse");
    expect(p.wiring.push?.auth).toBe("Site token");
    expect(JSON.stringify(p)).not.toContain("ASSET_TOKENS");
    expect(p.wiring.push?.authOwner).toBe("workers/ingest/.dev.vars");
    // A pushing asset sends on its own clock, so there is no OS-side time.
    expect(p.wiring.schedule).toBeNull();
  });

  it("ENVELOPE-format pull entry has no metric map (config carries no `metrics`)", async () => {
    const p = (await buildAssetDetailPayload(ctx.call, "nosh.example", DEPS))!;
    expect(p.wiring.mode).toBe("pull");
    expect(p.wiring.pull?.format).toBe("envelope");
    expect(p.wiring.pull?.url).toBe("https://nosh.example/api/admin/overview");
    // null, not [] — the page drops the mapping block rather than rendering an
    // empty one, and reading the absent `metrics` key must not throw (→ 500).
    expect(p.wiring.pull?.metricMap).toBeNull();
    expect(p.wiring.pull?.index).toBe(1);
  });

  // The site's card totals entry, verbatim: the Settings tab's Card totals
  // shows it and guards its removal on it (beads ro-trai.21, ro-ujb9.76.4.5).
  it("carries the site's card totals entry as config/counters.json holds it", async () => {
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.countersConfig).toEqual(COUNTERS.assets["meals.example"]);
  });

  it("says a site declares no totals rather than guessing an entry", async () => {
    const p = (await buildAssetDetailPayload(ctx.call, "root-os", DEPS))!;
    expect(p.countersConfig).toBeNull();
  });

  it("names the OS's own row NoticeOS whatever its stored name, and every site by its own (ro-ujb9.77.10)", async () => {
    const os = (await buildAssetDetailPayload(ctx.call, "root-os", DEPS))!;
    expect(os.asset).toMatchObject({ isOs: true, displayName: "NoticeOS" });
    expect(JSON.stringify(os)).not.toContain("ReindexOS");
    const site = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(site.asset.displayName).toBe("Meal Planner");
  });

  // The GA4 lane's two declarations reach the page that edits them (bead
  // `ro-x5gu.3`). What matters here is that three states stay three states: a
  // declared list, an entry that declares nothing, and no entry at all — the
  // last of which decides whether the Tower's first Add appends or files.
  it("carries the GA4 declarations this asset has made", async () => {
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.ga4Config.valueEvents).toEqual(["calculation_complete", "sign_up"]);
    // Declaring value events says nothing about registered dimensions.
    expect(p.ga4Config.eventParams).toBeNull();
  });

  it("keeps an empty declaration apart from no declaration at all", async () => {
    const nom = (await buildAssetDetailPayload(ctx.call, "nosh.example", DEPS))!;
    expect(nom.ga4Config.valueEvents).toEqual([]);
    expect(nom.ga4Config.eventParams).toEqual(["message", "source"]);

    const os = (await buildAssetDetailPayload(ctx.call, "root-os", DEPS))!;
    expect(os.ga4Config).toEqual({ valueEvents: null, eventParams: null, productUseStages: null, valueEventsEntryExists: false });
  });

  it("carries only the selected asset's validated Product use presentation", async () => {
    const stages = [{ eventName: "document_open", label: "Opened a document", group: "primary" }];
    const valueEvents = { assets: { "meals.example": { valueEvents: ["purchase"], productUseStages: stages }, "nosh.example": { productUseStages: [] } } };
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", { ...DEPS, valueEvents }))!;
    expect(p.ga4Config.productUseStages).toEqual(stages);
    expect(p.ga4Config.valueEventsEntryExists).toBe(true);
    expect(p.ga4Config.valueEvents).toEqual(["purchase"]);
    const other = (await buildAssetDetailPayload(ctx.call, "nosh.example", { ...DEPS, valueEvents }))!;
    expect(other.ga4Config.productUseStages).toEqual([]);
    expect(other.ga4Config.valueEventsEntryExists).toBe(true);
    const invalid = (await buildAssetDetailPayload(ctx.call, "meals.example", { ...DEPS, valueEvents: { assets: {"meals.example": {productUseStages:[{...stages[0],group:"conversion"}]}}} }))!;
    expect(invalid.ga4Config.productUseStages).toBeNull();
  });

  it("reads a malformed list as no declaration rather than repairing it", async () => {
    // These files are hand-maintained claims about GA4. A surface that quietly
    // normalized one would hide the drift the register test exists to catch.
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", {
      ...DEPS,
      valueEvents: { assets: { "meals.example": { valueEvents: "sign_up" } } },
    }))!;
    expect(p.ga4Config.valueEvents).toBeNull();
  });

  // What the Growth tab EDITS (bead ro-x5gu.4) — the tracked terms and the
  // refresh roster row, with the same three-state rule as the GA4 pair above
  // and one extra consequence: on `config/serp-panel.json` an entry holding
  // `[]` is a config error, so `null` is also what the last removal leaves.
  it("carries this asset's tracked terms and its refresh roster row", async () => {
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.panelConfig).toEqual({
      trackedQueries: ["meals"],
      roster: SIGNAL_PANELS.assets["meals.example"],
    });
  });

  it("keeps an asset that buys no panel apart from one whose panel lists nothing", async () => {
    // nosh.example is on the refresh roster and in no tracked panel. `null` is the
    // answer to the second and it is not `[]`: an asset absent from that file is
    // skipped silently and is the common, valid state, and it is also what
    // decides whether the Tower's first Add appends or files the entry.
    const nom = (await buildAssetDetailPayload(ctx.call, "nosh.example", DEPS))!;
    expect(nom.panelConfig.trackedQueries).toBeNull();
    expect(nom.panelConfig.roster).toEqual(SIGNAL_PANELS.assets["nosh.example"]);

    const empty = (await buildAssetDetailPayload(ctx.call, "nosh.example", {
      ...DEPS,
      serpPanel: { assets: { "nosh.example": { queries: [] } } },
    }))!;
    expect(empty.panelConfig.trackedQueries).toEqual([]);
  });

  it("says an asset is in neither panel register rather than inventing a row", async () => {
    const p = (await buildAssetDetailPayload(ctx.call, "root-os", DEPS))!;
    expect(p.panelConfig).toEqual({ trackedQueries: null, roster: null });
  });

  it("surfaces open ingest-freshness / pull-failure flags on the wiring panel", async () => {

    await seedReportsAndAlerts(ctx);
    const meals = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(meals.wiring.pullFailure?.ruleId).toBe("asset-pull-failed");
    expect(meals.wiring.ingestFreshness).toBeNull();

    const nom = (await buildAssetDetailPayload(ctx.call, "nosh.example", DEPS))!;
    expect(nom.wiring.ingestFreshness?.ruleId).toBe("ingest-freshness");
    expect(nom.wiring.pullFailure).toBeNull();
  });

  it("exposes flag_defaults as portfolio-default knobs owned by config/constants.json", async () => {
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.rules.scope).toBe("portfolio-default");
    expect(p.rules.hasOverride).toBe(false);
    expect(p.rules.knobs).toHaveLength(3);
    const alpha = p.rules.knobs.find((k) => k.key === "alpha")!;
    expect(alpha.value).toBe("0.01");
    expect(alpha.jargon).toBe("alpha");
    expect(alpha.owner).toBe("config/constants.json");
    expect(alpha.label).not.toBe("alpha"); // plain-language label present
    // editable knobs carry a JSON pointer + the raw value for staging.
    expect(alpha.pointer).toBe("/flag_defaults/alpha");
    expect(alpha.raw).toBe(0.01);
  });

  it("surfaces editable portfolio-wide spend caps + operator rate (config/constants.json)", async () => {
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.portfolio.owner).toBe("config/constants.json");
    const keys = p.portfolio.knobs.map((k) => k.key);
    expect(keys).toContain("monthly_caps.data_usd");
    expect(keys).toContain("operator_rate_usd_per_min");
    // The inference cap was withdrawn with D6 (bead `ro-uj7x`) — nothing in the
    // OS calls a model, so nothing could ever meter spend against it.
    expect(keys).not.toContain("monthly_caps.inference_usd");
    const dataCap = p.portfolio.knobs.find((k) => k.key === "monthly_caps.data_usd")!;
    expect(dataCap.pointer).toBe("/monthly_caps/data_usd");
    expect(dataCap.value).toBe(25);
    const rate = p.portfolio.knobs.find((k) => k.key === "operator_rate_usd_per_min")!;
    expect(rate.pointer).toBe("/operator_rate_usd_per_min");
    expect(rate.value).toBe(2);
  });

  it("builds latest pulse metrics + per-metric series (chronological)", async () => {

    await seedReportsAndAlerts(ctx);
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    const signups = p.metrics.find((m) => m.name === "signups")!;
    expect(signups.last24h).toBe(10); // from the latest (07-05) pulse
    expect(signups.avg7d).toBe(10);
    expect(signups.total).toBe(4233);
    expect(signups.series).toEqual([
      { t: "2026-07-04", v: 12 },
      { t: "2026-07-05", v: 10 },
    ]);
    expect(p.wiring.lastPulseDate).toBe("2026-07-05");
  });

  it("keeps every metric's all-time total in the payload — the cards' fallback reads it", async () => {

    await seedReportsAndAlerts(ctx);
    // The totals VIEW moved to the asset cards (the wall payload resolves
    // them); the data stays here, because that resolution falls back to exactly
    // this number when the fast lane has no reading.
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.metrics.find((m) => m.name === "plansSaved")!.total).toBe(1907);
  });

  it("keeps the newer analysis visible when an older generation arrives later, preserving both versions", async () => {
    const newer = { ...executiveSnapshot(), generatedAt: "2026-07-05T11:00:00.000Z" };
    const older = { ...executiveSnapshot(), generatedAt: "2026-07-04T11:00:00.000Z" };
    await insertSnapshot(ctx, "newer-generation", newer, undefined, "2026-07-05T11:01:00.000Z");
    await insertSnapshot(ctx, "late-older-generation", older, undefined, "2026-07-05T11:02:00.000Z");

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.executive?.generatedAt).toBe(newer.generatedAt);
    const history = await (ctx.call).read((tx) =>
      tx.query<{ payload: string }>(
        "SELECT payload FROM noticeos.asset_insight_snapshots WHERE asset_id = $1 ORDER BY generated_at",
        ["meals.example"],
      ),
    );
    expect(history.map((row) => JSON.parse(row.payload))).toEqual([older, newer]);
  });

  it("reuses the provider trends and reads the latest compact executive snapshot", async () => {
    // On Postgres, where the collectors write them (bead ro-ujb9.76.5.3).
    const store = ctx.call;
    await writeSignalRun(store, {
      id: "ga4-run", asset: "meals.example", integration: "ga4", credentialRef: "google-primary", propertyRef: "assets/1",
      startedAt: "2026-07-05T11:00:00.000Z", finishedAt: "2026-07-05T11:01:00.000Z",
      windowStart: "2026-06-28", windowEnd: "2026-07-05", provisionalFrom: "2026-07-05", providerRows: 8, observationCount: 2,
    }, valuesOf("active_users", { "2026-07-04": 80, "2026-07-05": 97 }));
    await writeSignalRun(store, {
      id: "gsc-run", asset: "meals.example", integration: "gsc", credentialRef: "google-primary", propertyRef: "sc-domain:meals.example",
      startedAt: "2026-07-05T11:02:00.000Z", finishedAt: "2026-07-05T11:03:00.000Z",
      windowStart: "2026-06-28", windowEnd: "2026-07-05", provisionalFrom: "2026-07-05", providerRows: 8, observationCount: 2,
    }, valuesOf("impressions", { "2026-07-04": 800, "2026-07-05": 920 }));

    await insertSnapshot(ctx, "snapshot-1", executiveSnapshot());

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.performance.activeUsers.series).toEqual([
      { t: "2026-07-04", v: 80 },
      { t: "2026-07-05", v: 97 },
    ]);
    expect(p.performance.activeUsers.provisionalFrom).toBe("2026-07-05");
    expect(p.performance.webSearchImpressions.google.series).toEqual([
      { t: "2026-07-04", v: 800 },
      { t: "2026-07-05", v: 920 },
    ]);
    expect(p.executive?.items[0]?.title).toBe("Review a near-ranking query");
    expect(p.executive?.searchQueries?.google?.movers[0]?.query).toBe(
      "weekly meal plan",
    );
    expect(
      p.executive?.searchQueries?.dataforseo?.queries[0]?.aiCitationPosition,
    ).toBe(2);
    expect(p.executive?.productUse?.build[0]?.users).toBe(23);
    expect(p.executive?.searchIntelligence?.backlinks?.referringDomains).toBe(128);
    expect(p.executive?.sourceArchiveCount).toBe(12);
  });

  it("loads the supporting GA4 volume and Search Console rate series for the page", async () => {
    // The asset page is the ONLY reader of these, so the widened metric
    // selection has to reach the payload — not just the loader.
    const store = ctx.call;
    const secondary = (id: string, integration: "ga4" | "gsc", propertyRef: string, startedAt: string, finishedAt: string) =>
      writeSignalRun(store, {
        id, asset: "meals.example", integration, credentialRef: "google-primary", propertyRef, startedAt, finishedAt,
        windowStart: "2026-07-04", windowEnd: "2026-07-05", provisionalFrom: "2026-07-05", providerRows: 4, observationCount: 4,
      });
    await secondary("ga4-secondary", "ga4", "assets/1", "2026-07-05T11:00:00.000Z", "2026-07-05T11:01:00.000Z");
    await secondary("gsc-secondary", "gsc", "sc-domain:meals.example", "2026-07-05T11:02:00.000Z", "2026-07-05T11:03:00.000Z");
    for (const [date, sessions, views, events] of [
      ["2026-07-04", 120, 380, 900],
      ["2026-07-05", 64, 205, 470],
    ] as const) {
      await writeSignalValues(store, "ga4-secondary", [
        { date, metric: "sessions", value: sessions },
        { date, metric: "page_views", value: views },
        { date, metric: "event_count", value: events },
      ]);
    }
    for (const [date, ctr, position] of [
      ["2026-07-04", 0.048, 11.6],
      ["2026-07-05", 0.052, 10.9],
    ] as const) {
      await writeSignalValues(store, "gsc-secondary", [
        { date, metric: "ctr", value: ctr },
        { date, metric: "position", value: position },
      ]);
    }

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.performance.sessions.series).toEqual([
      { t: "2026-07-04", v: 120 },
      { t: "2026-07-05", v: 64 },
    ]);
    expect(p.performance.pageViews.series.at(-1)).toEqual({
      t: "2026-07-05",
      v: 205,
    });
    expect(p.performance.events.series.at(-1)).toEqual({
      t: "2026-07-05",
      v: 470,
    });
    expect(p.performance.searchCtr.series.at(-1)).toEqual({
      t: "2026-07-05",
      v: 0.052,
    });
    expect(p.performance.searchPosition.series.at(-1)).toEqual({
      t: "2026-07-05",
      v: 10.9,
    });
    // Provisional boundaries ride along, so a partial today is dashed here too.
    expect(p.performance.searchPosition.provisionalFrom).toBe("2026-07-05");
  });

  it("degrades each search-query provider on its own — one bad block never erases the others", async () => {
    // google is malformed (movers is not an array), bing is absent entirely.
    // The DataForSEO snapshot survived collection and must still reach the page.
    await insertSnapshot(ctx, "snapshot-partial-providers", {
      ...executiveSnapshot(),
      searchQueries: {
        google: { ...GOOGLE_TREND, movers: "not-an-array" },
        dataforseo: DATAFORSEO_SNAPSHOT } });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.executive?.searchQueries?.google).toBeNull();
    expect(p.executive?.searchQueries?.bing).toBeNull();
    expect(p.executive?.searchQueries?.dataforseo?.queries[0]?.query).toBe(
      "weekly meal plan",
    );
  });

  it("carries page decisions through, dropping only the rows it cannot read (ro-427)", async () => {
    await insertSnapshot(ctx, "snapshot-pages", {
      ...executiveSnapshot(),
      searchPages: {
        provider: "google",
        currentStart: "2026-06-29",
        currentEnd: "2026-07-05",
        previousStart: "2026-06-22",
        previousEnd: "2026-06-28",
        daysPerWindow: 7,
        pages: [
          {
            page: "https://meals.example/calculator",
            path: "/calculator",
            currentClicks: 21,
            previousClicks: 84,
            clickDelta: -63,
            clickDeltaPercent: -75,
            currentImpressions: 2800,
            previousImpressions: 2800,
            impressionDelta: 0,
            impressionDeltaPercent: 0,
            currentPosition: 5,
            previousPosition: 5,
            positionImprovement: 0,
            currentCtr: 0.0075,
            previousCtr: 0.03,
            leadingQuery: {
              query: "dri calculator",
              impressions: 900,
              clicks: 3,
              position: 5.2,
              aioDevices: [
                { device: "mobile", aioPresent: true, aioCitesUs: false },
              ],
            },
          },
          // One garbled row costs exactly itself: a page decision is an
          // independent row, unlike the panel's all-or-nothing query list.
          {
            page: "https://meals.example/broken",
            path: "/broken",
            currentClicks: "twenty",
            previousClicks: 1,
            clickDelta: 1,
            clickDeltaPercent: null,
            currentImpressions: 1,
            previousImpressions: 1,
            impressionDelta: 0,
            impressionDeltaPercent: 0,
            currentPosition: null,
            previousPosition: null,
            positionImprovement: null,
            currentCtr: 1,
            previousCtr: 1,
            leadingQuery: null,
          },
        ],
        evidence: [
          {
            label: "Grounding queries excluded from the leading-query join",
            value: "0",
            detail: "No quoted-literal queries in this window.",
          },
        ],
        source: "gsc/page",
        caveat: "Search Console page exports are top rows.",
      },
    });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    const pages = p.executive?.searchPages;
    expect(pages?.pages.map((row) => row.path)).toEqual(["/calculator"]);
    expect(pages?.pages[0]?.clickDeltaPercent).toBe(-75);
    expect(pages?.pages[0]?.leadingQuery?.aioDevices).toEqual([
      { device: "mobile", aioPresent: true, aioCitesUs: false },
    ]);
    // The lane's own statement travels with it, including at zero.
    expect(pages?.evidence[0]?.value).toBe("0");
  });

  it("reads a snapshot with no page block, and a malformed one, as no page table (ro-427)", async () => {
    // Every snapshot published before ro-427 looks like this, and so does every
    // asset without two complete weeks. Both render nothing rather than an
    // empty comparison — and neither may take the page down.
    await insertSnapshot(ctx, "snapshot-no-pages", executiveSnapshot());
    const legacy = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(legacy.executive?.searchPages).toBeNull();

    await insertSnapshot(ctx, "snapshot-bad-pages", {
      ...executiveSnapshot(),
      searchPages: { provider: "google", pages: "not-an-array" },
    });
    const malformed = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(malformed.executive?.searchPages).toBeNull();
    // The rest of the snapshot is untouched by its neighbour's corruption.
    expect(malformed.executive?.items[0]?.key).toBe("opportunity");
  });

  it("accepts a snapshot written before the tracked panel and reads it as unknown", async () => {
    // DATAFORSEO_SNAPSHOT carries neither panel field, which is exactly what
    // every analysis published before S1b landed looks like. It must parse, and
    // it must arrive as an EMPTY device list — the shape the rules downstream
    // compare against for "not tracked". Never a desktop reading of nulls,
    // which would claim a surface was checked.
    await insertSnapshot(ctx, "snapshot-pre-panel", {
      ...executiveSnapshot(),
      searchQueries: { google: null, bing: null, dataforseo: DATAFORSEO_SNAPSHOT },
    });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    const row = p.executive?.searchQueries?.dataforseo?.queries[0];
    expect(row?.query).toBe("weekly meal plan");
    expect(row?.aioDevices).toEqual([]);
  });

  it("reads a pre-device snapshot's flat panel pair as the desktop row it was", async () => {
    // Bead ro-14d.1. Every snapshot between S1b and the device split carries a
    // flat aioPresent/aioCitesUs pair and no device — and the collector had one
    // device literal in it then, so that pair is a DESKTOP reading. Parsing it
    // as an unnamed surface would break every device comparison across the
    // cutover; dropping it would throw away evidence that was collected.
    await insertSnapshot(ctx, "snapshot-panel", {
      ...executiveSnapshot(),
      searchQueries: {
        google: null,
        bing: null,
        dataforseo: {
          ...DATAFORSEO_SNAPSHOT,
          queries: [
            {
              ...DATAFORSEO_SNAPSHOT.queries[0],
              aioPresent: true,
              aioCitesUs: false,
            },
          ],
        },
      },
    });
    const kept = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(kept.executive?.searchQueries?.dataforseo?.queries[0]?.aioDevices).toEqual([
      { device: "desktop", aioPresent: true, aioCitesUs: false },
    ]);
  });

  it("keeps both devices' readings through the parser, in phone-then-desktop order", async () => {
    await insertSnapshot(ctx, "snapshot-panel-devices", {
      ...executiveSnapshot(),
      searchQueries: {
        google: null,
        bing: null,
        dataforseo: {
          ...DATAFORSEO_SNAPSHOT,
          queries: [
            {
              ...DATAFORSEO_SNAPSHOT.queries[0],
              aioDevices: [
                { device: "mobile", aioPresent: true, aioCitesUs: false },
                { device: "desktop", aioPresent: false, aioCitesUs: false },
              ],
            },
          ],
        },
      },
    });
    const kept = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    // Walled on the phone, clear on the desktop — two states, not one folded
    // verdict, and neither reading is allowed to stand for the other.
    expect(kept.executive?.searchQueries?.dataforseo?.queries[0]?.aioDevices).toEqual([
      { device: "mobile", aioPresent: true, aioCitesUs: false },
      { device: "desktop", aioPresent: false, aioCitesUs: false },
    ]);
  });

  it("rejects a tracked-panel field that answers with anything but a boolean", async () => {
    await insertSnapshot(ctx, "snapshot-panel-bad", {
      ...executiveSnapshot(),
      searchQueries: {
        google: null,
        bing: null,
        dataforseo: {
          ...DATAFORSEO_SNAPSHOT,
          queries: [
            // "unknown" as a string is not a third boolean: a producer sending
            // it is malformed, and the snapshot must not launder it into a fact.
            { ...DATAFORSEO_SNAPSHOT.queries[0], aioPresent: "unknown" },
          ],
        },
      },
    });
    const dropped = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(dropped.executive?.searchQueries).toBeNull();
  });

  it("accepts a movers lane written before it stated its own exclusions", async () => {
    // GOOGLE_TREND carries no `evidence` key, which is every analysis published
    // before the lanes ran the grounding check. It must parse, and it must
    // arrive as an explicit empty list: a producer that predates the check ran
    // no check, and every consumer should read one value for that.
    await insertSnapshot(ctx, "snapshot-pre-lane-evidence", {
      ...executiveSnapshot(),
      searchQueries: { google: GOOGLE_TREND, bing: null, dataforseo: null },
    });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.executive?.searchQueries?.google?.evidence).toEqual([]);
  });

  it("carries a lane's proof rows through, zero value included", async () => {
    // The zero row is the reason the field exists: it proves the check ran.
    // Losing it here would leave the surface unable to tell "excluded nothing"
    // from "nobody looked".
    await insertSnapshot(ctx, "snapshot-lane-evidence", {
      ...executiveSnapshot(),
      searchQueries: {
        google: {
          ...GOOGLE_TREND,
          evidence: [
            {
              label: "Grounding queries excluded",
              value: "0",
              detail: "No quoted-literal queries in this window",
            },
          ],
        },
        bing: null,
        dataforseo: null,
      },
    });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.executive?.searchQueries?.google?.evidence).toEqual([
      {
        label: "Grounding queries excluded",
        value: "0",
        detail: "No quoted-literal queries in this window",
      },
    ]);
  });

  it("drops a lane whose proof rows are malformed rather than rendering it as unproven", async () => {
    // Unreadable evidence is NOT absent evidence. A lane that silently degraded
    // to "stated nothing" would look exactly like a lane that never ran the
    // check — the one confusion this field was added to prevent.
    await insertSnapshot(ctx, "snapshot-bad-lane-evidence", {
      ...executiveSnapshot(),
      searchQueries: {
        google: { ...GOOGLE_TREND, evidence: [{ label: "Grounding queries excluded" }] },
        bing: null,
        dataforseo: DATAFORSEO_SNAPSHOT } });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.executive?.searchQueries?.google).toBeNull();
    // ...and the other provider still reaches the page, as always.
    expect(p.executive?.searchQueries?.dataforseo?.queries[0]?.query).toBe(
      "weekly meal plan",
    );
  });

  it("nulls searchQueries only when NO provider survives", async () => {
    await insertSnapshot(ctx, "snapshot-no-providers", {
      ...executiveSnapshot(),
      searchQueries: { google: null, bing: null, dataforseo: { observedAt: 7 } },
    });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.executive).not.toBeNull();
    expect(p.executive?.searchQueries).toBeNull();
  });

  it("drops a malformed insight and keeps the rest of the analysis", async () => {
    const good = executiveSnapshot().items[0]!;
    await insertSnapshot(ctx, "snapshot-bad-item", {
      ...executiveSnapshot(),
      items: [
        { ...good, confidence: "certain" }, // not a confidence this schema admits
        good,
      ],
      methodology: ["Missing rows remain unknown.", 42],
    });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.executive?.items).toHaveLength(1);
    expect(p.executive?.items[0]?.title).toBe("Review a near-ranking query");
    // Same rule for the methodology lines: drop the row, keep the analysis.
    expect(p.executive?.methodology).toEqual(["Missing rows remain unknown."]);
  });

  // Bead ro-wwm: the cut's own record. The Tower renders it, so it degrades the
  // way every other late-arriving block does — never at the cost of the cards
  // that survived the cut.
  it("normalizes the suppressed list a pre-2026-07-31 snapshot never carried", async () => {
    await insertSnapshot(ctx, "snapshot-no-suppressed", executiveSnapshot());

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.executive?.items).toHaveLength(1);
    expect(p.executive?.suppressedItems).toEqual([]);
  });

  it("drops a suppressed row that cannot name itself and keeps the others", async () => {
    await insertSnapshot(ctx, "snapshot-bad-suppressed", {
      ...executiveSnapshot(),
      suppressedItems: [
        { key: "llm-grounding-traffic", kind: "discovery", title: "Machine grounding" },
        { key: "no-kind", kind: "notice", title: "A kind this schema does not admit" },
        { key: "untitled", kind: "insight", title: "" },
      ],
    });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.executive?.suppressedItems).toEqual([
      { key: "llm-grounding-traffic", kind: "discovery", title: "Machine grounding" },
    ]);
  });

  it("still rejects a snapshot whose top-level shape does not match this asset", async () => {
    await insertSnapshot(ctx, "snapshot-other-asset", {
      ...executiveSnapshot(),
      asset: "nosh.example",
    });
    expect(
      (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!.executive,
    ).toBeNull();
  });

  it("validates search-intelligence KEY NAMES, so producer drift is visible", async () => {
    await insertSnapshot(ctx, "snapshot-drifted-keys", {
      ...executiveSnapshot(),
      searchIntelligence: {
        ...SEARCH_INTELLIGENCE,
        // The producer renamed top3 → topThree: still seven finite numbers, and
        // still a section this payload must refuse to render.
        rankings: { ...SEARCH_INTELLIGENCE.rankings, top3: undefined, topThree: 4 },
      },
    });
    expect(
      (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!.executive
        ?.searchIntelligence,
    ).toBeNull();
  });

  it("treats an absent backlinks family as null, keeping the rest of the section", async () => {
    // An asset with no retained link report — the one family that legitimately
    // goes missing. `undefined` and explicit null must read the same.
    await insertSnapshot(ctx, "snapshot-no-backlinks", {
      ...executiveSnapshot(),
      searchIntelligence: { ...SEARCH_INTELLIGENCE, backlinks: undefined },
    });

    const intelligence = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!
      .executive?.searchIntelligence;
    expect(intelligence?.backlinks).toBeNull();
    expect(intelligence?.rankings.keywords).toBe(184);
    expect(intelligence?.ai.chatgptMentions).toBe(3);
  });

  it("keeps an unreported AI mention figure unknown, keeping the rest of the section (ro-8s5)", async () => {
    // The producer now writes null where DataForSEO's platform row stated
    // nothing. That is a reading, not drift: the section stays, the null stays
    // null, and an explicit zero stays zero. A missing key is still drift.
    await insertSnapshot(ctx, "snapshot-unreported-ai", {
      ...executiveSnapshot(),
      searchIntelligence: {
        ...SEARCH_INTELLIGENCE,
        ai: { googleMentions: null, googleSearchVolume: null, chatgptMentions: 0, chatgptSearchVolume: 0 },
      },
    });
    const intelligence = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!
      .executive?.searchIntelligence;
    expect(intelligence?.rankings.keywords).toBe(184);
    expect(intelligence?.ai).toEqual({
      googleMentions: null,
      googleSearchVolume: null,
      chatgptMentions: 0,
      chatgptSearchVolume: 0,
    });
  });

  it("still refuses an AI block with a key missing — null is a reading, absence is drift", async () => {
    await insertSnapshot(ctx, "snapshot-missing-ai-key", {
      ...executiveSnapshot(),
      searchIntelligence: {
        ...SEARCH_INTELLIGENCE,
        ai: { googleMentions: 1, googleSearchVolume: 2, chatgptMentions: 3 },
      },
    });
    expect(
      (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!.executive
        ?.searchIntelligence,
    ).toBeNull();
  });

  it("forwards only reviewed keys, so a producer's extra field never reaches the browser", async () => {
    // Bead ro-a8y: the parser used to validate key NAMES and then spread the
    // producer's own object, which proved nothing about what was forwarded.
    await insertSnapshot(ctx, "snapshot-extra-keys", {
      ...executiveSnapshot(),
      operatorEmail: "operator@example.com",
      searchIntelligence: {
        ...SEARCH_INTELLIGENCE,
        providerApiKey: "secret",
        rankings: { ...SEARCH_INTELLIGENCE.rankings, internalDebugScore: 7 },
      },
    });

    const executive = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!
      .executive;
    expect(executive).not.toBeNull();
    expect(executive).not.toHaveProperty("operatorEmail");
    expect(executive?.searchIntelligence).not.toHaveProperty("providerApiKey");
    expect(executive?.searchIntelligence?.rankings).not.toHaveProperty(
      "internalDebugScore",
    );
    // The reviewed numbers still arrive — dropping the unknown key is not
    // dropping the section.
    expect(executive?.searchIntelligence?.rankings.top20).toBe(41);
    expect(executive?.sourceArchiveCount).toBe(12);
  });

  it("keeps the whole snapshot when one window date is missing", async () => {
    // Bead ro-a8y: an absent windowStart used to fail the top-level gate, so
    // one optional date cost the operator every card in the analysis.
    await insertSnapshot(
      ctx,
      "snapshot-no-window-start",
      { ...executiveSnapshot(), windowStart: undefined },
      { start: null, end: null },
    );

    const executive = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!
      .executive;
    expect(executive).not.toBeNull();
    expect(executive?.windowStart).toBeNull();
    expect(executive?.windowEnd).toBe("2026-07-04");
    expect(executive?.items).toHaveLength(1);
  });

  it("excludes superseded ledger rows from the freshness lane's age", async () => {
    // A late estimate corrected by a backfilled reconciliation: the superseded
    // row is the newest recorded_at in the table but is no longer this
    // asset's ledger, so it cannot claim the lane is fresher than it is.
    await insertLedger(ctx, { id: 10, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 120, booking_state: "estimated", recorded_at: "2026-07-04T00:00:00.000Z" });
    await insertLedger(ctx, { id: 11, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 96, booking_state: "reconciled", supersedes_id: 10, recorded_at: "2026-07-03T12:00:00.000Z" });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.freshness.ledgerRecordedAt).toBe("2026-07-03T12:00:00.000Z");
  });

  it("returns 90 days on asset detail while the shared Wall loader defaults to 28", async () => {
    const start = Date.parse("2026-04-02T00:00:00.000Z");
    const store = ctx.call;
    await writeSignalRun(store, {
      id: "ga4-95-day-run", asset: "meals.example", integration: "ga4", credentialRef: "google-primary", propertyRef: "assets/1",
      startedAt: "2026-07-05T11:00:00.000Z", finishedAt: "2026-07-05T11:01:00.000Z",
      windowStart: "2026-04-02", windowEnd: "2026-07-05", provisionalFrom: "2026-07-05", providerRows: 95, observationCount: 95,
    }, Array.from({ length: 95 }, (_, index) => ({
      date: new Date(start + index * DAY).toISOString().slice(0, 10), metric: "active_users", value: index + 1,
    })));

    const detail = (await buildAssetDetailPayload(ctx.call,
      "meals.example",
      DEPS,
    ))!;
    expect(detail.performance.activeUsers.series).toHaveLength(90);
    expect(detail.performance.activeUsers.series[0]).toEqual({
      t: "2026-04-07",
      v: 6,
    });
    expect(detail.performance.activeUsers.series.at(-1)).toEqual({
      t: "2026-07-05",
      v: 95,
    });
    expect(detail.performance.activeUsers.contextSeries).toEqual([
      { t: "2026-04-02", v: 1 },
      { t: "2026-04-03", v: 2 },
      { t: "2026-04-04", v: 3 },
      { t: "2026-04-05", v: 4 },
      { t: "2026-04-06", v: 5 },
    ]);

    // THE WALL'S DRAWN WINDOW IS STILL FOUR WEEKS, and that is the half of this
    // contract the TV depends on: `series` is what the card charts, and it did
    // not move when the payload grew.
    const compact = (await loadSignalTrends(store)).get("meals.example")!;
    expect(compact.activeUsers.series).toHaveLength(28);
    expect(compact.activeUsers.series[0]).toEqual({
      t: "2026-06-08",
      v: 68,
    });
    // WHAT GREW IS THE HISTORY BEHIND IT (bead `ro-78qo.35`): sixty-two context
    // days, so context plus chart is the ninety doc 14's range selector needs
    // on /assets, which reads this same payload. Nothing draws these as chart
    // days, which is why the line above could stay exactly as it was.
    expect(compact.activeUsers.contextSeries).toHaveLength(62);
    expect(compact.activeUsers.contextSeries?.[0]).toEqual({ t: "2026-04-07", v: 6 });
    expect(compact.activeUsers.contextSeries?.at(-1)).toEqual({ t: "2026-06-07", v: 67 });
    // The two together are the ninety days, unbroken and in order.
    expect([
      ...(compact.activeUsers.contextSeries ?? []),
      ...compact.activeUsers.series,
    ]).toHaveLength(90);
  });

  it("splits open flags from dispositioned/resolved history; open ordered by severity", async () => {

    await seedReportsAndAlerts(ctx);
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    // Unresolved warnings remain visible without claiming a recent check: the
    // central firing has no linked valid report, and the pull failure has no
    // evaluatedAt. Neither fixture proves confirmation or recovery.
    expect(p.flags.open).toHaveLength(2);
    expect(p.flags.open.every((f) => f.liveness.state === "last-known")).toBe(true);
    for (const flag of p.flags.open) {
      expect(flag.verification).toMatchObject({
        state: "unverified", lastConfirmedAt: null, lastEvaluatedAt: null,
      });
    }
    expect(p.flags.openWarn).toBe(2);
    expect(p.flags.openError).toBe(0);
    expect(p.asset.worstOpenSeverity).toBe("warn");
    // First arrival is separate from recent observed coverage.
    expect(p.asset.firstReportAt).toBe(new Date(NOW_MS - 34 * HOUR).toISOString());
    expect(p.asset.reportDays).toBe(1);

    // Not dropped — moved. It is real evidence and stays reachable; what it
    // loses is a heading claiming it is live.
    expect(p.flags.notCurrent).toHaveLength(1);
    expect(p.flags.notCurrent[0]).toMatchObject({
      kind: "milestone",
      liveness: { state: "historical" },
    });
    // history = the ack + the resolved one.
    expect(p.flags.history).toHaveLength(2);
    const ack = p.flags.history.find((f) => f.disposition === "ack")!;
    expect(ack.dispositionNote).toBe("known weekend dip");
    expect(ack.ackExpiry).toBe("2026-07-12T00:00:00.000Z");
  });

  it("every flag carries its parsed rule_inputs — the translator's raw material", async () => {

    await seedReportsAndAlerts(ctx);
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;

    const plans = [...p.flags.open, ...p.flags.notCurrent].find(
      (f) => f.metric === "plansSaved",
    )!;
    expect(plans.ruleInputs).toMatchObject({ observed: 0, baselinePerDay: 6 });
    // The stored message is untouched — the store stays factual.
    expect(plans.message).toBe("0 in last24h (avg7d 6, P<0.01)");

    // The pull-failure inputs carry the running failure count the rewrite keeps.
    const pull = p.flags.open.find((f) => f.ruleId === "asset-pull-failed")!;
    expect(pull.ruleInputs).toMatchObject({ failureCount: 3, status: 503 });

    // A flag written without inputs degrades to null rather than failing the page.
    const milestone = p.flags.notCurrent.find((f) => f.kind === "milestone")!;
    expect(milestone.ruleInputs).toBeNull();
  });

  it("correlates each alert with the changes in its own 48h window, history included", async () => {

    await seedReportsAndAlerts(ctx);
    await seedChanges(ctx);
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;

    // The plansSaved alert fired 2026-07-05T02:06Z; the deploy landed 7h before.
    const plans = [...p.flags.open, ...p.flags.notCurrent].find(
      (f) => f.metric === "plansSaved",
    )!;
    expect(plans.correlatedChanges.map((c) => c.ref)).toEqual(["a1b2c3d"]);

    // The 2026-07-01 milestone predates that deploy — nothing correlates, and an
    // empty list is what renders no chip at all.
    const milestone = p.flags.notCurrent.find((f) => f.kind === "milestone")!;
    expect(milestone.correlatedChanges).toEqual([]);

    // History rows are translated the same way; the June external event is far
    // outside the window of the alert resolved on 2026-06-21.
    const resolved = p.flags.history.find((f) => f.resolvedAt !== null)!;
    expect(resolved.correlatedChanges).toEqual([]);
  });

  it("ledger slice excludes superseded rows and splits the period's rollup by booking state", async () => {
    await seedLedger(ctx);
    // MIXED, the case the split exists for: meals's June is one reconciled
    // row and two estimated ones. The page used to state net 644.20 — 666.30
    // revenue minus 22.10 cost, summed over both states — which is a booked-P&L
    // claim over $146.10 nobody has confirmed, and a number the card and the
    // headline above it (reconciled rows only) could never match (ro-jk7).
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.ledger.empty).toBe(false);
    // the 560 estimate is superseded → gone; 498.10 reconciled remains.
    expect(p.ledger.recentRows.some((r) => r.amount === 560)).toBe(false);
    expect(p.ledger.recentRows.some((r) => r.amount === 498.1)).toBe(true);
    const june = p.ledger.periods.find((x) => x.period === "2026-06")!;

    expect(june.booked.figure).toEqual({ currency: 'USD', revenue: 498.1, cost: 0, net: 498.1 });
    expect(june.booked.revenueByFamily).toEqual([{ currency: 'USD', family: "ads", amount: 498.1 }]);
    expect(june.booked.costByFamily).toEqual([]);
    // Exact equality, not toBeCloseTo: 168.20 − 22.10 is 146.10000000000002 in
    // dollars, so a net still subtracted from REAL figures fails here (ro-wtt).
    expect(june.forecast.figure).toEqual({ currency: 'USD', revenue: 168.2, cost: 22.1, net: 146.1 });
    expect(june.forecast.revenueByFamily).toEqual([{ currency: 'USD', family: "affiliate", amount: 168.2 }]);
    expect(june.forecast.costByFamily).toEqual([{ currency: 'USD', family: "inference", amount: 22.1 }]);

    // Nothing anywhere on the period is the blend the two sides replaced.
    expect(figureHasMoney(june.booked.figure)).toBe(true);
    expect(figureHasMoney(june.forecast.figure)).toBe(true);
    expect(june.booked.figure.net! + june.forecast.figure.net!).toBeCloseTo(644.2, 10);
    expect(Object.values(june.booked.figure)).not.toContain(644.2);
    expect(Object.values(june.forecast.figure)).not.toContain(644.2);

    // booking_state is preserved on the raw rows (honesty fact).
    const ads = p.ledger.recentRows.find((r) => r.family === "ads")!;
    expect(ads.bookingState).toBe("reconciled");
  });

  it("a period with nothing reconciled books nothing, and says so in its own field", async () => {
    // FORECAST ONLY. `booked` is three zeroes rather than a null or an absent
    // period, so the tile has a shape to render and never a number to mistake:
    // `figureHasMoney` is what turns the stated net into an em dash.
    await insertLedger(ctx, { id: 40, kind: "revenue", asset: "meals.example", period: "2026-05", family: "ads", amount: 210.4, booking_state: "estimated", recorded_at: "2026-05-31T00:00:00.000Z" });
    await insertLedger(ctx, { id: 41, kind: "cost", asset: "meals.example", period: "2026-05", family: "infra", amount: 10.4, booking_state: "estimated", recorded_at: "2026-05-31T00:00:00.000Z" });

    const may = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!.ledger.periods.find(
      (x) => x.period === "2026-05",
    )!;
    expect(may.booked.figure).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(may.booked.revenueByFamily).toEqual([]);
    expect(may.booked.costByFamily).toEqual([]);
    expect(figureHasMoney(may.booked.figure)).toBe(false);
    expect(may.forecast.figure).toEqual({ currency: 'USD', revenue: 210.4, cost: 10.4, net: 200 });
    expect(figureHasMoney(may.forecast.figure)).toBe(true);
  });

  it("a fully reconciled period carries no forecast at all", async () => {
    // BOOKED ONLY: the estimates side is empty, so the tile draws no second
    // block rather than a $0 one under the hollow notch.
    await insertLedger(ctx, { id: 42, kind: "revenue", asset: "meals.example", period: "2026-05", family: "ads", amount: 300, booking_state: "reconciled", recorded_at: "2026-05-31T00:00:00.000Z" });

    const may = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!.ledger.periods.find(
      (x) => x.period === "2026-05",
    )!;
    expect(figureHasMoney(may.booked.figure)).toBe(true);
    expect(may.forecast.figure).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(may.forecast.revenueByFamily).toEqual([]);
    expect(figureHasMoney(may.forecast.figure)).toBe(false);
  });

  it("a reconciled net of zero is money, and a period of literal zeroes is not", async () => {
    // The two ZERO cases the tile must tell apart. A month whose reconciled
    // revenue exactly cancels its reconciled cost is a confirmed $0 — a fact
    // somebody checked, and it renders. A month whose only rows are worth
    // nothing at all is three zeroes nobody asked about, and renders the dash.
    await insertLedger(ctx, { id: 43, kind: "revenue", asset: "meals.example", period: "2026-05", family: "ads", amount: 88.5, booking_state: "reconciled", recorded_at: "2026-05-31T00:00:00.000Z" });
    await insertLedger(ctx, { id: 44, kind: "cost", asset: "meals.example", period: "2026-05", family: "infra", amount: 88.5, booking_state: "reconciled", recorded_at: "2026-05-31T00:00:00.000Z" });
    await insertLedger(ctx, { id: 45, kind: "revenue", asset: "meals.example", period: "2026-04", family: "ads", amount: 0, booking_state: "reconciled", recorded_at: "2026-04-30T00:00:00.000Z" });

    const periods = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!.ledger.periods;
    const may = periods.find((x) => x.period === "2026-05")!;
    expect(may.booked.figure).toEqual({ currency: 'USD', revenue: 88.5, cost: 88.5, net: 0 });
    expect(figureHasMoney(may.booked.figure)).toBe(true);

    const april = periods.find((x) => x.period === "2026-04")!;
    expect(april.booked.figure).toEqual({ currency: 'USD', revenue: 0, cost: 0, net: 0 });
    expect(figureHasMoney(april.booked.figure)).toBe(false);
    expect(figureHasMoney(april.forecast.figure)).toBe(false);
  });

  it("adds the P&L in exact cents, down to each family's rollup", async () => {
    // Amounts chosen to break under float summation: in dollars the revenue
    // adds to 1809.6499999999999, ads to 845.3499999999999, the costs to
    // 866.4000000000001, and 1809.65 − 866.40 is 943.2500000000001. Every
    // figure below is therefore only reachable by adding `amount_minor`
    // (db/0018) and dividing once — which is what makes this P&L provable
    // against the portfolio total it rolls into (ro-wtt).
    const rows = [
      [30, "revenue", "ads", 574.15],
      [31, "revenue", "ads", 271.2],
      [32, "revenue", "affiliate", 417.1],
      [33, "revenue", "affiliate", 547.2],
      [34, "cost", "inference", 445.1],
      [35, "cost", "inference", 421.3],
    ] as const;
    for (const [id, kind, family, amount] of rows) {
      await insertLedger(ctx, { id, kind, asset: "meals.example", period: "2026-08", family, amount, booking_state: "reconciled", recorded_at: "2026-08-01T00:00:00.000Z" });
    }

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", {
      ...DEPS,
      now: new Date("2026-08-05T12:00:00.000Z"),
    }))!;
    const august = p.ledger.periods.find((x) => x.period === "2026-08")!;
    expect(august.booked.figure).toEqual({ currency: 'USD',
      revenue: 1809.65,
      cost: 866.4,
      net: 943.25,
    });
    expect(august.booked.revenueByFamily).toEqual([
      { currency: 'USD', family: "affiliate", amount: 964.3 },
      { currency: 'USD', family: "ads", amount: 845.35 },
    ]);
    expect(august.booked.costByFamily).toEqual([{ currency: 'USD', family: "inference", amount: 866.4 }]);
    // A single row still states its own dollars, unrounded and unscaled (the
    // row is shown by the number the store handed the entry named 30).
    const shown = bookedNumber(ctx.call, 30);
    expect(p.ledger.recentRows.find((r) => r.id === shown)!.amount).toBe(574.15);
  });

  it("returns the annotation timeline, most recent first", async () => {
    await seedChanges(ctx);
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.annotations.items.map((a) => a.kind)).toEqual(["deploy", "external"]);
    // Two rows in the store, two on the page: nothing was left out to count.
    expect(p.annotations.olderCount).toBe(0);
  });

  it("shows every change when an asset passes 20 annotations (ro-5e8.1)", async () => {
    // meals.example's real shape: 21 annotations, and the OLDEST is the
    // change-point two open watch windows point at. The 20-row read dropped
    // exactly that row, so the Watches strip named a cause the timeline could
    // not show.
    await seedChanges(ctx);
    const anchor = await insertAnnotation(
      ctx,
      "meals.example",
      "2026-06-01T03:02:58.000Z",
      "deploy",
      "23bceb0",
      "title surgery, first batch",
    );
    await insertDailyDeploys(ctx, "meals.example", 18, "2026-06-10T00:00:00.000Z");
    for (const metric of ["clicks", "impressions"]) {
      await insertWatchWindow(ctx, {
        id: `watch-titles-${metric}`,
        asset: "meals.example",
        metric_integration: "gsc",
        metric,
        registered_at: "2026-06-02T09:00:00.000Z",
        check_offsets: [7, 14, 28],
        readings: [],
        ref_kind: "annotation",
        ref: String(anchor),
      });
    }

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    // 2 seeded + the anchor + 18 = 21, all of them, nothing counted away.
    expect(p.annotations.items).toHaveLength(21);
    expect(p.annotations.olderCount).toBe(0);
    // The change both open windows point at is on the page, at the far end.
    const oldest = p.annotations.items.at(-1)!;
    expect(oldest.id).toBe(anchor);
    expect(oldest.ref).toBe("23bceb0");
    expect(p.watches.open.map((w) => w.ref)).toEqual([String(anchor), String(anchor)]);
  });

  it("caps a very long timeline but says how many older changes it left out", async () => {
    // 250 daily deploys is past what one page renders. The read stops — and
    // names the size of the stop instead of ending in silence.
    await seedChanges(ctx);
    await insertDailyDeploys(ctx, "meals.example", 250, "2025-06-01T00:00:00.000Z");

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.annotations.items).toHaveLength(200);
    expect(p.annotations.olderCount).toBe(52); // 250 + the 2 seeded rows
    // Contiguous newest-first, so one "N older" line accounts for all of it.
    const times = p.annotations.items.map((a) => a.at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(times[0]).toBe("2026-07-04T18:30:00.000Z");
  });

  it("reaches past the cap for a change a watch window is anchored to", async () => {
    await seedChanges(ctx);
    const ids = await insertDailyDeploys(ctx, "meals.example", 250, "2025-06-01T00:00:00.000Z");
    // The 210th-newest change: past the cap, so a plain read would drop the one
    // row this window exists to explain.
    const anchor = ids[250 - 210];
    await insertWatchWindow(ctx, {
      id: "watch-anchored",
      asset: "meals.example",
      metric_integration: "gsc",
      metric: "clicks",
      registered_at: "2026-06-20T09:00:00.000Z",
      check_offsets: [7],
      readings: [],
      ref_kind: "annotation",
      ref: String(anchor),
    });
    // A free-text window whose ref merely LOOKS like an id must not drag the
    // read down to the oldest row in the store.
    await insertWatchWindow(ctx, {
      id: "watch-manual",
      asset: "meals.example",
      metric_integration: "ga4",
      metric: "sessions",
      registered_at: "2026-06-20T09:00:00.000Z",
      check_offsets: [7],
      readings: [],
      ref: String(ids[0]),
    });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    // 2 seeded + 210 back to the anchor; the 40 older than it are counted.
    expect(p.annotations.items).toHaveLength(212);
    expect(p.annotations.olderCount).toBe(40);
    expect(p.annotations.items.at(-1)!.id).toBe(anchor);
  });

  it("reads open watch windows: what is measured, when it is next due, how much is read", async () => {
    await insertWatchWindow(ctx, {
      id: "watch-open",
      asset: "meals.example",
      metric_integration: "gsc",
      metric: "clicks",
      registered_at: "2026-06-20T09:00:00.000Z",
      check_offsets: [7, 14, 28],
      // The 7-day check has been read; the 14-day one is what is next due.
      readings: [{ offset_days: 7, check_date: "2026-06-27" }],
      note: "June title batch",
    });
    // Another asset's window must never appear on this page.
    await insertWatchWindow(ctx, {
      id: "watch-other",
      asset: "nosh.example",
      metric_integration: "ga4",
      metric: "sessions",
      registered_at: "2026-06-20T09:00:00.000Z",
      check_offsets: [7],
      readings: [],
    });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.watches.open).toHaveLength(1);
    expect(p.watches.open[0]).toMatchObject({
      id: "watch-open",
      metricIntegration: "gsc",
      metric: "clicks",
      nextCheckDate: "2026-07-04",
      readings: 1,
      checks: 3,
      status: "open",
      outcome: null,
      note: "June title batch",
    });
    expect(p.watches.closed).toEqual([]);
  });

  it("carries this asset's own series so a threshold can be calibrated from it", async () => {
    // Bead ro-5e8.2. The composer's "smallest move that counts" opened on the
    // README's example for every asset; the archives are local, so the
    // prefill can come from what THIS asset does when nothing ships.
    // On Postgres, where the collectors write them (bead ro-ujb9.76.5.3).
    const store = ctx.call;
    const run = (id: string, startedAt: string, finishedAt: string, count: number, values: Record<string, number>) =>
      writeSignalRun(store, {
        id, asset: "meals.example", integration: "gsc", credentialRef: "google-primary", propertyRef: "sc-domain:meals.example",
        startedAt, finishedAt, windowStart: "2026-06-01", windowEnd: "2026-07-04", providerRows: count, observationCount: count,
      }, valuesOf("clicks", values));
    await run("gsc-cal", "2026-07-05T11:00:00.000Z", "2026-07-05T11:01:00.000Z", 3, { "2026-07-02": 100, "2026-07-04": 120 });
    // A revision for the SAME day: the evaluator takes the latest run's value,
    // and a calibration that took the first would be calibrating a number the
    // verdict will never use.
    await run("gsc-cal-2", "2026-07-05T11:30:00.000Z", "2026-07-05T11:31:00.000Z", 1, { "2026-07-04": 140 });
    await insertAnnotation(ctx, "meals.example", "2026-07-03T18:00:00.000Z", "deploy", "calibration-fixture", "level-changing deploy");

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    const clicks = p.watches.history.find(
      (entry) => entry.integration === "gsc" && entry.metric === "clicks",
    );
    expect(clicks).toBeDefined();
    const dayOf = (day: string) =>
      Math.round(
        (Date.parse(`${day}T00:00:00.000Z`) -
          Date.parse(`${clicks!.firstDay}T00:00:00.000Z`)) /
          86_400_000,
      );
    expect(clicks!.values[dayOf("2026-07-02")]).toBe(100);
    expect(clicks!.values[dayOf("2026-07-04")]).toBe(140);
    // The gap is a gap. The evaluator's per-day figure divides by the days it
    // actually observed and its coverage rule counts the holes, so a history
    // that quietly closed them would calibrate a series the store does not hold.
    expect(clicks!.values[dayOf("2026-07-03")]).toBeNull();
    expect(clicks!.recordedChanges).toMatchObject({
      firstDay: clicks!.firstDay,
      lastDay: "2026-07-05",
      complete: true,
    });
    expect(clicks!.recordedChanges?.days).toContain("2026-07-03");
    // A series this asset has never reported is ABSENT, never present and
    // empty: "does not report Bing clicks" and "reports them and they are zero"
    // must not arrive as the same fact.
    expect(
      p.watches.history.some((entry) => entry.integration === "bing-webmaster"),
    ).toBe(false);
  });

  it("calibrates only from the property the asset is measured on now", async () => {
    // Bead ro-ujb9.70. The asset was repointed from a URL-prefix Search Console
    // site to its domain property. The evaluator refuses a verdict across that
    // switch, so the old site's days are not noise the new registration will be
    // judged against: they read as gaps, never as the new property's history.
    const store = ctx.call;
    const run = (id: string, propertyRef: string, startedAt: string, finishedAt: string, windowEnd: string, values: Record<string, number>) =>
      writeSignalRun(store, {
        id, asset: "meals.example", integration: "gsc", credentialRef: "google-primary", propertyRef, startedAt, finishedAt,
        windowStart: "2026-06-01", windowEnd, providerRows: 2, observationCount: 2,
      }, valuesOf("clicks", values));
    await run("old-site", "https://meals.example/", "2026-07-03T11:00:00.000Z", "2026-07-03T11:01:00.000Z", "2026-07-03",
      { "2026-07-01": 500, "2026-07-02": 510 });
    await run("new-site", "sc-domain:meals.example", "2026-07-05T11:00:00.000Z", "2026-07-05T11:01:00.000Z", "2026-07-04",
      { "2026-07-03": 100, "2026-07-04": 120 });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    const clicks = p.watches.history.find(
      (entry) => entry.integration === "gsc" && entry.metric === "clicks",
    );
    expect(clicks).toBeDefined();
    const dayOf = (day: string) =>
      Math.round(
        (Date.parse(`${day}T00:00:00.000Z`) -
          Date.parse(`${clicks!.firstDay}T00:00:00.000Z`)) /
          86_400_000,
      );
    expect(clicks!.values[dayOf("2026-07-01")]).toBeNull();
    expect(clicks!.values[dayOf("2026-07-02")]).toBeNull();
    expect(clicks!.values[dayOf("2026-07-03")]).toBe(100);
    expect(clicks!.values[dayOf("2026-07-04")]).toBe(120);
  });

  it.each([
    ["mp-abc.2", "mp-abc.2"],
    ["gt--a1", "gt--a1"],
    [null, undefined],
    ["../tasks", undefined],
    ["--help", undefined],
  ])("keeps a closed watch outcome and its valid recorded readback %s", async (readback, expected) => {
    await insertWatchWindow(ctx, {
      id: "watch-closed",
      asset: "meals.example",
      metric_integration: "ga4",
      metric: "active_users",
      registered_at: "2026-05-01T09:00:00.000Z",
      check_offsets: [14],
      readings: [{ offset_days: 14, check_date: "2026-05-15" }],
      status: "closed",
      outcome: "inconclusive",
      outcome_note: "Change was inside normal variation.",
      closed_at: "2026-05-15T04:00:00.000Z",
      readback_bead: readback,
    });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.watches.open).toEqual([]);
    expect(p.watches.closed[0]?.readbackTaskId).toBe(expected);
    expect(p.watches.closed[0]).toMatchObject({
      id: "watch-closed",
      status: "closed",
      outcome: "inconclusive",
      outcomeNote: "Change was inside normal variation.",
      readings: 1,
      checks: 1,
      // Every registered offset has been read, so there is nothing left to
      // promise — the strip says so rather than inventing a date.
      nextCheckDate: null,
    });
  });

  // Bead `ro-ujb9.96.6.30`. A note stored before the evaluator stopped writing
  // the series, scope and offset still carries them; the store is history and
  // is never rewritten, so the read drops them. The scope travels as its own
  // field for the row's title.
  it("reads a closed watch's stored note as the evaluator's figures, and its scope as a field", async () => {
    await insertWatchWindow(ctx, {
      id: "watch-query",
      asset: "meals.example",
      metric_integration: "gsc",
      metric: "clicks",
      registered_at: "2026-05-01T09:00:00.000Z",
      check_offsets: [28],
      readings: [{ offset_days: 28, check_date: "2026-05-29" }],
      status: "closed",
      outcome: "ship_confirmed",
      outcome_note: "gsc/clicks for query “high protein meal plan” at +28d: 13/day vs baseline 10/day (+30%)",
      closed_at: "2026-05-29T03:30:00.000Z",
      scope_json: JSON.stringify({ query: "high protein meal plan" }),
    });
    await insertWatchWindow(ctx, {
      id: "watch-split",
      asset: "meals.example",
      metric_integration: "gsc",
      metric: "clicks",
      registered_at: "2026-05-02T09:00:00.000Z",
      check_offsets: [28],
      readings: [{ offset_days: 28, check_date: "2026-05-30" }],
      status: "closed",
      outcome: "unmeasurable",
      outcome_note:
        'gsc/clicks at +28d: baseline on "https://example.com/", post window on "sc-domain:example.com"',
      closed_at: "2026-05-30T03:30:00.000Z",
    });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    const byId = new Map(p.watches.closed.map((watch) => [watch.id, watch]));
    expect(byId.get("watch-query")).toMatchObject({
      scope: { query: "high protein meal plan" },
      outcomeNote: "13/day vs baseline 10/day (+30%)",
    });
    expect(byId.get("watch-split")).toMatchObject({
      scope: null,
      outcomeNote: 'baseline on "https://example.com/", post window on "sc-domain:example.com"',
    });
  });

  it("has no link-outreach section for an asset that runs no campaign", async () => {
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    // null, not an empty slice: the Tower has no way to start a campaign here,
    // so an empty section would be a dead end (the Watches-strip rule).
    expect(p.reclamation).toBeNull();
  });

  it("counts the link-outreach funnel and lists the targets that moved most recently", async () => {
    await insertReclamationTargets(ctx.call, [
      // Two clicked, one of them longer ago — the newest movement leads.
      { asset: "meals.example", domain: "genesee.cce.cornell.edu", page: "https://genesee.cce.cornell.edu/food-nutrition/meals", status: "clicked", statusAt: "2026-07-14" },
      { asset: "meals.example", domain: "albany.cce.cornell.edu", page: "https://albany.cce.cornell.edu/snap-ed", status: "clicked", statusAt: "2026-07-02" },
      { asset: "meals.example", domain: "nyc.cce.cornell.edu", page: "https://nyc.cce.cornell.edu/tips", status: "replied", statusAt: "2026-07-16" },
      { asset: "meals.example", domain: "erie.cce.cornell.edu", page: "https://erie.cce.cornell.edu/snap-ed", status: "sent", statusAt: "2026-06-16" },
      { asset: "meals.example", domain: "wichealth.org", page: "https://wichealth.org/resource/5907", status: "won", statusAt: "2026-07-20" },
      // Never touched: no status_at at all.
      { asset: "meals.example", domain: "schoolnutrition.org", page: "https://schoolnutrition.org/resource/x", status: "queued", statusAt: null },
      // The do-not-pitch reference list: counted, never listed as work.
      { asset: "meals.example", domain: "cdc.gov", page: "", status: "skip", statusAt: null },
      { asset: "meals.example", domain: "nih.gov", page: "", status: "skip", statusAt: null },
      // Another asset's campaign must not leak into this one.
      { asset: "nosh.example", domain: "elsewhere.example", page: "https://elsewhere.example/a", status: "sent", statusAt: "2026-07-10" },
    ]);

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    const reclamation = p.reclamation!;
    expect(reclamation.total).toBe(8);
    // Funnel order, and a stage with no rows is absent rather than a zero:
    // 'opened' and 'dead' never happened, so they are not measurements.
    expect(reclamation.counts).toEqual([
      { status: "queued", count: 1 },
      { status: "sent", count: 1 },
      { status: "clicked", count: 2 },
      { status: "replied", count: 1 },
      { status: "won", count: 1 },
      { status: "skip", count: 2 },
    ]);
    // Most recently moved first; the untouched target sorts last rather than
    // pretending to be the oldest movement, and skip rows stay out entirely.
    expect(reclamation.recent.map((t) => t.domain)).toEqual([
      "wichealth.org",
      "nyc.cce.cornell.edu",
      "genesee.cce.cornell.edu",
      "albany.cce.cornell.edu",
      "erie.cce.cornell.edu",
      "schoolnutrition.org",
    ]);
    // A day is stored as its first instant, 00:00 UTC; the page shows the day.
    expect(reclamation.recent[0]).toMatchObject({
      domain: "wichealth.org",
      status: "won",
      statusAt: "2026-07-20T00:00:00.000Z",
    });
    expect(reclamation.recent.at(-1)!.statusAt).toBeNull();
    // Each target is known by its workspace number: the order they were stored.
    expect(reclamation.recent.map((t) => t.id)).toEqual([5, 3, 1, 2, 4, 6]);
  });

  it("caps the link-outreach list at ten targets without capping the counts", async () => {
    await insertReclamationTargets(
      ctx.call,
      Array.from({ length: 14 }, (_, index) => ({
        asset: "meals.example",
        domain: `target-${String(index).padStart(2, "0")}.example`,
        page: `https://target-${index}.example/page`,
        status: "sent",
        statusAt: `2026-07-${String(index + 1).padStart(2, "0")}`,
      })),
    );

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.reclamation!.recent).toHaveLength(10);
    // The funnel is the whole campaign, not the visible slice.
    expect(p.reclamation!.counts).toEqual([{ status: "sent", count: 14 }]);
    expect(p.reclamation!.total).toBe(14);
  });

  // --- nightly site health (db/0014) — bead ro-gct ---------------------------

  /** One hygiene reading, written exactly as workers/ingest/src/hygiene.ts
   * writes it: one row per (asset, check, day), `value_num` NULL whenever the
   * check produced no number. On Postgres (bead ro-ujb9.76.5.8), in this
   * test's own copy of its sites (test/sites.ts). */
  async function insertHygiene(
    asset: string,
    check: string,
    day: string,
    status: string,
    value: number | null,
    detail: Record<string, unknown> = {},
  ) {
    await insertHygieneReading(ctx.call, { asset, check, day, status, value, detail });
  }

  it("has no site-health section before the guard's first night", async () => {
    // null, not three empty series: the Tower cannot run a check, so an empty
    // section would be a dead end (the Watches-strip rule).
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.hygiene).toBeNull();
  });

  it("reads back the nightly site-health history the guard has been writing", async () => {
    // The defect bead ro-gct names: hygiene_checks has had one row per (asset,
    // check, day) since 2026-07-31 and NOTHING in apps/tower read it — the only
    // way any of it reached a human was a rule firing, which is exactly the
    // wrong instrument for a slow decline.
    await insertHygiene("meals.example", "html-depth", "2026-07-03", "ok", 880);
    await insertHygiene("meals.example", "html-depth", "2026-07-04", "ok", 640);
    await insertHygiene("meals.example", "html-depth", "2026-07-05", "warn", 88);
    await insertHygiene("meals.example", "sitemap", "2026-07-04", "ok", 4120);
    await insertHygiene("meals.example", "sitemap", "2026-07-05", "ok", 4118);
    await insertHygiene("meals.example", "robots-ai-access", "2026-07-05", "warn", null, {
      present: true,
      bots: { GPTBot: true, ClaudeBot: false, Bingbot: true },
    });
    // Another asset's nightly run must not leak into this one.
    await insertHygiene("nosh.example", "html-depth", "2026-07-05", "ok", 2000);

    const hygiene = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!
      .hygiene!;
    expect(hygiene.htmlDepth.readings).toEqual([
      {
        date: "2026-07-03",
        observedAt: "2026-07-03T04:00:00.000Z",
        status: "ok",
        value: 880,
      },
      {
        date: "2026-07-04",
        observedAt: "2026-07-04T04:00:00.000Z",
        status: "ok",
        value: 640,
      },
      {
        date: "2026-07-05",
        observedAt: "2026-07-05T04:00:00.000Z",
        status: "warn",
        value: 88,
      },
    ]);
    expect(hygiene.htmlDepth.latest).toEqual({
      date: "2026-07-05",
      observedAt: "2026-07-05T04:00:00.000Z",
      status: "warn",
      value: 88,
    });
    expect(hygiene.sitemap.latest?.value).toBe(4118);
    // robots rows carry no number at all, and null travels as null.
    expect(hygiene.robots.latest).toEqual({
      date: "2026-07-05",
      observedAt: "2026-07-05T04:00:00.000Z",
      status: "warn",
      value: null,
    });
    expect(hygiene.bots).toEqual([
      { bot: "GPTBot", allowed: true },
      { bot: "ClaudeBot", allowed: false },
      { bot: "Bingbot", allowed: true },
    ]);
    expect(hygiene.windowDays).toBe(90);
  });

  it("keeps the crawler map it still knows after a night it could not look", async () => {
    // An unreachable origin stores no bot map. Falling silent about crawler
    // access because of one bad night would be the section forgetting a fact it
    // still holds, so the newest reading that HAS a map is the answer.
    await insertHygiene("meals.example", "robots-ai-access", "2026-07-03", "ok", null, {
      present: true,
      bots: { GPTBot: true, ClaudeBot: true },
    });
    await insertHygiene("meals.example", "robots-ai-access", "2026-07-05", "unreachable", null, {
      present: false,
      bots: {},
    });

    const hygiene = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!
      .hygiene!;
    // The status is tonight's — we could not look, and the section says so …
    expect(hygiene.robots.latest?.status).toBe("unreachable");
    // … while the map is the last one actually resolved.
    expect(hygiene.bots).toEqual([
      { bot: "GPTBot", allowed: true },
      { bot: "ClaudeBot", allowed: true },
    ]);
  });

  it("drops readings older than the window and never plots a missing number as zero", async () => {
    const old = new Date(NOW_MS - 120 * DAY).toISOString().slice(0, 10);
    await insertHygiene("meals.example", "html-depth", old, "ok", 5000);
    await insertHygiene("meals.example", "html-depth", "2026-07-04", "unreachable", null);
    await insertHygiene("meals.example", "html-depth", "2026-07-05", "ok", 900);

    const depth = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!
      .hygiene!.htmlDepth;
    expect(depth.readings.map((r) => r.date)).toEqual(["2026-07-04", "2026-07-05"]);
    // A night the fetch failed measured nothing. null is the whole point: read
    // as zero it would be the collapse this section exists to detect honestly.
    expect(depth.readings[0]).toEqual({
      date: "2026-07-04",
      observedAt: "2026-07-04T04:00:00.000Z",
      status: "unreachable",
      value: null,
    });
  });

  /** One stored disposition, on Postgres (bead ro-ujb9.76.5.8), in this
   * test's own copy of its sites (test/sites.ts). */
  async function insertDisposition(asset: string, key: string, status: string, decidedAt: string, updatedAt: string) {
    await (ctx.call).write((tx) =>
      tx.execute(
        `INSERT INTO noticeos.item_dispositions (workspace_id, asset_id, kind, item_key, status, decided_at, updated_at)
         VALUES ($1, $2, 'finding', $3, $4, $5::timestamptz, $6::timestamptz)`,
        [tx.workspaceId, asset, key, status, decidedAt, updatedAt],
      ),
    );
  }

  it("carries this asset's decisions and no other asset's", async () => {
    await insertDisposition("meals.example", "search-opportunity", "marked", "2026-07-04T08:00:00.000Z", "2026-07-04T08:00:00.000Z");
    await insertDisposition("meals.example", "gsc-decline-1", "dismissed", "2026-07-01T08:00:00.000Z", "2026-07-05T08:00:00.000Z");
    await insertDisposition("nosh.example", "gsc-decline-1", "marked", "2026-07-04T08:00:00.000Z", "2026-07-04T08:00:00.000Z");

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.decisions).toEqual([
      {
        kind: "finding",
        key: "gsc-decline-1",
        status: "dismissed",
        decidedAt: "2026-07-01T08:00:00.000Z",
        updatedAt: "2026-07-05T08:00:00.000Z",
      },
      {
        kind: "finding",
        key: "search-opportunity",
        status: "marked",
        decidedAt: "2026-07-04T08:00:00.000Z",
        updatedAt: "2026-07-04T08:00:00.000Z",
      },
    ]);
    // An untouched query/finding has no row at all — absence IS the state.
    expect(p.decisions).toHaveLength(2);
  });

  it("cannot be handed a legacy handed_off row any more (beads ro-5e8.3, ro-5e8.4)", async () => {
    // db/0013 permitted the value and the payload filtered it out on read.
    // db/0021 deleted the surviving rows and narrowed the CHECK, so the shape
    // this test used to construct is now one the store refuses to hold.
    await expect(
      insertDisposition("meals.example", "weekly meal plan", "handed_off", "2026-07-04T08:00:00.000Z", "2026-07-04T08:00:00.000Z"),
    ).rejects.toThrow(/check constraint/);

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.decisions).toEqual([]);
  });

  // The register's half of the same keys (bead ro-248). The Tower cannot reach
  // the hub, so this all comes off the newest task photograph — and the
  // distinction that matters throughout is between "asked, nothing filed" and
  // "could not ask", because only the first one lets a card call a finding
  // untouched.
  describe("handoff beads", () => {
    function beadsProject(overrides: Record<string, unknown> = {}) {
      return {
        asset: "meals.example",
        prefix: "mp",
        ok: true,
        error: null,
        counts: { open: 1, ready: 1, inProgress: 0, blocked: 0, closedRecent: 0 },
        ready: [],
        inProgress: [],
        recentlyClosed: [],
        ...overrides,
      };
    }

    it("carries this asset's filed work, joined by the handoff key", async () => {
      await seedSnapshot(ctx, "2026-07-05T11:59:00.000Z", [
        beadsProject({
          handoffs: [
            { kind: "finding", key: "gsc-decline-1", beadId: "mp-1w2", status: "open", closedAt: null },
            {
              kind: "finding",
              key: "item-openers",
              beadId: "mp-4kq",
              status: "closed",
              closedAt: "2026-07-04T18:00:00.000Z",
            },
            { kind: "query", key: "weekly meal plan", beadId: "mp-88x", status: "open", closedAt: null },
            {
              kind: "page",
              key: "https://meals.example/recipes",
              beadId: "mp-page",
              status: "open",
              closedAt: null,
            },
            // The fourth kind (ro-05hb). Its key is the flag id, and it reaches
            // the payload on the same pass as the other three — the reader has
            // no per-kind allowlist beyond the union itself.
            { kind: "alert", key: "flag-8812", beadId: "mp-alrt", status: "open", closedAt: null },
          ],
        }),
        // Another asset's filed work, on the same snapshot row. A finding
        // key is a RULE id, so the same string exists on every asset — this
        // is the one that would attach a stranger's bead to this page.
        beadsProject({
          asset: "nosh.example",
          prefix: "nom",
          handoffs: [
            { kind: "finding", key: "gsc-decline-1", beadId: "nom-9zz", status: "open", closedAt: null },
          ],
        }),
      ]);

      const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
      expect(p.handoffBeads).toEqual([
        { kind: "finding", key: "gsc-decline-1", beadId: "mp-1w2", status: "open", closedAt: null },
        {
          kind: "finding",
          key: "item-openers",
          beadId: "mp-4kq",
          status: "closed",
          closedAt: "2026-07-04T18:00:00.000Z",
        },
        { kind: "query", key: "weekly meal plan", beadId: "mp-88x", status: "open", closedAt: null },
        {
          kind: "page",
          key: "https://meals.example/recipes",
          beadId: "mp-page",
          status: "open",
          closedAt: null,
        },
        { kind: "alert", key: "flag-8812", beadId: "mp-alrt", status: "open", closedAt: null },
      ]);
    });

    it("reports an empty list when the poller asked and nothing is filed", async () => {
      await seedSnapshot(ctx, "2026-07-05T11:59:00.000Z", [beadsProject({ handoffs: [] })]);

      const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
      // NOT null: this is a measurement, and it is the only thing that lets a
      // finding card present itself as untouched work.
      expect(p.handoffBeads).toEqual([]);
    });

    it("degrades a snapshot written before the field existed to null, never to empty", async () => {
      await seedSnapshot(ctx, "2026-07-05T11:59:00.000Z", [beadsProject()]);

      const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
      expect(p.handoffBeads).toBeNull();
    });

    it("is null when the register cannot be asked at all", async () => {
      // No snapshot has ever been filed.
      let p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
      expect(p.handoffBeads).toBeNull();

      // A snapshot that names other projects but not this one — the asset is
      // not a spoke in config/beads.json.
      await seedSnapshot(ctx, "2026-07-05T11:58:00.000Z", [
        beadsProject({ asset: "nosh.example", prefix: "nom", handoffs: [],
        }),
      ]);
      p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
      expect(p.handoffBeads).toBeNull();

      // A project the poller could not read. `bd` told it nothing about filed
      // work either, which is "did not ask" and never "none filed".
      await seedSnapshot(ctx, "2026-07-05T11:59:00.000Z", [
        {
          asset: "meals.example",
          prefix: "mp",
          ok: false,
          error: "bd active exited 1: no such directory",
          counts: { open: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0 },
          ready: [],
          inProgress: [],
          recentlyClosed: [],
        },
      ]);
      p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
      expect(p.handoffBeads).toBeNull();
    });

    it("drops one unreadable entry rather than un-filing every other finding", async () => {
      await seedSnapshot(ctx, "2026-07-05T11:59:00.000Z", [
        beadsProject({
          handoffs: [
            { kind: "finding", key: "gsc-decline-1", beadId: "mp-1w2", status: "open", closedAt: null },
            { kind: "finding", key: "", beadId: "mp-nokey", status: "open", closedAt: null },
            { kind: "epic", key: "item-openers", beadId: "mp-badkind", status: "open", closedAt: null },
            { kind: "finding", key: "item-openers", beadId: "mp-badstatus", status: "in_progress", closedAt: null },
          ],
        }),
      ]);

      const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
      expect(p.handoffBeads!.map((b) => b.beadId)).toEqual(["mp-1w2"]);
    });

    it("reads only the newest snapshot", async () => {
      await seedSnapshot(ctx, "2026-07-04T11:00:00.000Z", [
        beadsProject({
          handoffs: [
            { kind: "finding", key: "stale", beadId: "mp-old", status: "open", closedAt: null },
          ],
        }),
      ]);
      await seedSnapshot(ctx, "2026-07-05T11:59:00.000Z", [beadsProject({ handoffs: [] })]);

      const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
      expect(p.handoffBeads).toEqual([]);
    });

    it("carries the corrected exact operator inbox from that same snapshot", async () => {
      const waiting = [
        {
          id: "mp-gate",
          title: "Approve the nutrition-source change",
          status: "open",
          priority: 2,
          issueType: "gate",
          assignee: null,
          updatedAt: "2026-07-05T09:00:00.000Z",
          closedAt: null,
          parent: null,
          deferUntil: null,
        },
        {
          id: "mp-p1",
          title: "Choose the homepage experiment",
          status: "open",
          priority: 1,
          issueType: "decision",
          assignee: null,
          updatedAt: "2026-07-05T10:00:00.000Z",
          closedAt: null,
          parent: null,
          deferUntil: null,
        },
      ];
      await seedSnapshot(ctx, "2026-07-05T11:59:00.000Z", [
        beadsProject({
          counts: {
            open: 8,
            ready: 5,
            inProgress: 1,
            blocked: 2,
            closedRecent: 3,
            waiting: 6,
          },
          waitingUrgent: 2,
          waiting,
          handoffs: [],
        }),
      ]);

      const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
      expect(p.operator).toEqual({
        capturedAt: "2026-07-05T11:59:00.000Z",
        waiting: 6,
        urgent: 2,
        items: waiting,
      });
    });

    it("preserves known items but not exact totals when an operator read is partial", async () => {
      await seedSnapshot(ctx, "2026-07-05T11:59:00.000Z", [
        beadsProject({
          counts: { open: 8, ready: 5, inProgress: 1, blocked: 2, closedRecent: 3 },
          waiting: [{ id: "mp-gate", title: "Approve the next release", status: "open", priority: 2, issueType: "gate" }],
          handoffs: [],
        }),
      ]);
      const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
      expect(p.operator).toMatchObject({ capturedAt: "2026-07-05T11:59:00.000Z", waiting: null, urgent: null });
      expect(p.operator.items.map((item) => item.id)).toEqual(["mp-gate"]);
    });

    it("suppresses a legacy human list when corrected urgency was not measured", async () => {
      await seedSnapshot(ctx, "2026-07-05T11:59:00.000Z", [
        beadsProject({
          counts: {
            open: 8,
            ready: 5,
            inProgress: 1,
            blocked: 2,
            closedRecent: 3,
            waiting: 4,
          },
          waiting: [
            {
              id: "mp-stale",
              title: "This legacy row must not become an instruction",
              status: "blocked",
              priority: 2,
              issueType: "task",
            },
          ],
          handoffs: [],
        }),
      ]);

      const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
      expect(p.operator).toEqual({
        capturedAt: "2026-07-05T11:59:00.000Z",
        waiting: null,
        urgent: null,
        items: [],
      });
    });
  });

  it("carries the integrations section, merging store evidence over declared state", async () => {
    await seedLedger(ctx);
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    // No seed-file path rides the payload: nothing on the site page names it
    // (bead `ro-ujb9.96.6.23`).
    expect(p.integrations).not.toHaveProperty("owner");
    expect(p.integrations.lanes).toHaveLength(3);
    // meals has recent CJ + ads revenue in the fixture → the needs-setup
    // revenue lanes carry supporting "manual lane" evidence, still needs-setup.
    const cj = p.integrations.lanes.find((l) => l.cell.laneId === "affiliate-cj")!;
    expect(cj.cell.effective).toBe("needs-setup");
    expect(cj.cell.evidence[0]?.polarity).toBe("supporting");
    // credential scope flows through the asset-detail path too.
    expect(cj.catalog.credential).toBe("shared");
    // The register's prose never rides the rendered row (bead `ro-ujb9.96.6.1`).
    expect(cj.catalog).not.toHaveProperty("perProperty");
    // gsc is still needs-setup, with explicit evidence that no collector ran.
    const gsc = p.integrations.lanes.find((l) => l.cell.laneId === "gsc")!;
    expect(gsc.cell.evidence[0]).toMatchObject({
      polarity: "against",
      source: "Search Console collector has no recent run",
      at: null,
    });
  });

  it("pre-launch asset renders designed empties (no pulse/ledger/flags)", async () => {

    await seedReportsAndAlerts(ctx);
    const p = (await buildAssetDetailPayload(ctx.call, "fees.example", DEPS))!;
    expect(p.asset.status).toBe("pre-launch");
    expect(p.metrics).toEqual([]);
    expect(p.wiring.mode).toBe("push"); // absent from pull.json
    expect(p.wiring.lastPulseReceivedAt).toBeNull();
    // Never reported: arrival is unknown and observed coverage is zero.
    expect(p.asset.firstReportAt).toBeNull();
    expect(p.asset.reportDays).toBe(0);
    expect(p.flags.open).toEqual([]);
    expect(p.flags.history).toEqual([]);
    expect(p.ledger.empty).toBe(true);
    expect(p.ledger.periods).toEqual([]);
    expect(p.decisions).toEqual([]);
    expect(p.annotations).toEqual({ items: [], olderCount: 0 });
    expect(p.performance.activeUsers.series).toEqual([]);
    expect(p.executive).toBeNull();
    expect(p).not.toHaveProperty("laterPhase");
  });

  it("asset #0 gets a sensible push/self-report wiring description", async () => {
    const p = (await buildAssetDetailPayload(ctx.call, "root-os", DEPS))!;
    expect(p.asset.isOs).toBe(true);
    expect(p.wiring.mode).toBe("push");
    // The System writes its own report at 03:00 UTC; a pushing asset has no
    // OS-side clock time at all.
    expect(p.wiring.schedule).toEqual({ job: "asset-zero", enabled: true, cron: "0 3 * * *" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The tracked-query SERP panel readout (beads `ro-282.3`, `ro-6ok`).
//
// The producer is `scripts/signal-insights.mjs`, publishing a `serpPanel` block
// onto the asset's insight snapshot from the `dataforseo/serp-panel`
// archive. Everything below is about what the Tower does with a block it did
// not write: it is JSON out of a store row filled by a separate Node process,
// so absence, staleness and corruption are ordinary inputs, not incidents.
// ─────────────────────────────────────────────────────────────────────────────
describe("buildAssetDetailPayload — the tracked SERP panel", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seed(ctx);
  });

  const panelBlock = () => ({
    reportDate: "2026-08-03",
    trackedDepth: 20,
    queries: [
      {
        query: "calorie calculator",
        bestRank: 2,
        bestUrl: "https://meals.example/calories",
        aioPresent: true,
        aioCitesUs: true,
        composition: {
          top3Domains: ["usda.gov", "meals.example", "healthline.com"],
          organicResults: 18,
          secondRank: 8,
          secondUrl: "https://meals.example/second",
          serpFeatures: ["images", "people_also_ask"],
        },
      },
      {
        query: "chipotle calorie calculator",
        bestRank: null,
        bestUrl: null,
        aioPresent: false,
        aioCitesUs: false,
      },
      {
        query: "restaurant nutrition lookup",
        bestRank: null,
        bestUrl: null,
        aioPresent: null,
        aioCitesUs: null,
      },
    ],
  });

  const panelOf = async (payload: unknown) => {
    await insertSnapshot(ctx, "panel", payload);
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    return p.executive?.serpPanel ?? null;
  };

  it("carries the panel through with its depth and its three-valued fields intact", async () => {
    const panel = await panelOf({ ...executiveSnapshot(), serpPanel: panelBlock() });
    // A pre-`ro-14d.1` block names no device; the parser reads that absence as
    // the desktop row it was, because the collector had exactly one device
    // literal in it until 2026-08-04. A missing cluster label goes the OPPOSITE
    // way and becomes null: a label was never sent, so inventing one would
    // invent a bet nobody placed (`ro-282.5`).
    expect(panel).toEqual({
      ...panelBlock(),
      // A block written before it carried the site's market names none.
      market: null,
      queries: panelBlock().queries.map((row) => ({
        ...row,
        device: "desktop",
        label: null,
        composition: row.composition ?? null,
      })),
    });
    // The two absences that must not collapse into each other on the way in.
    expect(panel!.queries[1]!.aioPresent).toBe(false);
    expect(panel!.queries[2]!.aioPresent).toBeNull();
    expect(panel!.queries[1]!.composition).toBeNull();
  });

  it("keeps a term's two devices as two rows, and the scoreboard still counts one term", async () => {
    // Bead ro-14d.1. The whole risk of the split is arithmetic: twenty tracked
    // terms read on two devices are still twenty, and a term nobody could
    // answer the AI question for is ONE unknown rather than two.
    const panel = await panelOf({
      ...executiveSnapshot(),
      serpPanel: {
        reportDate: "2026-08-03",
        trackedDepth: 20,
        queries: [
          { query: "macro calculator", device: "mobile", bestRank: null, bestUrl: null, aioPresent: true, aioCitesUs: false },
          { query: "macro calculator", device: "desktop", bestRank: 3, bestUrl: "https://meals.example/macros", aioPresent: false, aioCitesUs: false },
          { query: "restaurant nutrition lookup", device: "mobile", bestRank: null, bestUrl: null, aioPresent: null, aioCitesUs: null },
          { query: "restaurant nutrition lookup", device: "desktop", bestRank: null, bestUrl: null, aioPresent: null, aioCitesUs: null },
        ],
      },
    });
    expect(panel!.queries).toHaveLength(4);
    expect(serpPanelScoreboard(panel!)).toEqual({
      tracked: 2,
      // Ranked on the desktop only — a term that ranks anywhere the panel
      // looked is a term that ranks.
      ranking: 1,
      top10: 1,
      top3: 1,
      // One term answered on at least one surface; one unknown on both, and it
      // stays ONE unknown.
      aioKnown: 1,
      // Walled on the phone: an overview a real person hit, and a clear desktop
      // page does not give that click back.
      aioPresent: 1,
      aioCitesUs: 0,
    });
  });

  it("reads a snapshot with no panel block as no panel, exactly like every older one", async () => {
    // An asset with no config/serp-panel.json entry has no panel family in
    // the archive, so the producer writes no block — the same shape every
    // snapshot published before the block existed already has.
    expect(await panelOf(executiveSnapshot())).toBeNull();
  });

  it("leaves an unrecorded depth unstated rather than assuming twenty", async () => {
    // A legacy archive row without `tracked_depth`. Defaulting it here would
    // turn "no rank recorded" into "outside the top 20" — a claim about a page
    // nobody read that far down.
    const panel = await panelOf({
      ...executiveSnapshot(),
      serpPanel: { ...panelBlock(), trackedDepth: null },
    });
    expect(panel!.trackedDepth).toBeNull();
    expect(panel!.queries).toHaveLength(3);
  });

  it("carries the market the site saved, and none for an absent or unreadable one (ro-ujb9.230)", async () => {
    const uk = { locationCode: 2826, languageCode: "en" };
    const carried = await panelOf({ ...executiveSnapshot(), serpPanel: { ...panelBlock(), market: uk } });
    expect(carried!.market).toEqual(uk);
    for (const market of [null, "United Kingdom", { locationCode: "2826" }, []]) {
      ctx = await createTestStore();
      await seed(ctx);
      const panel = await panelOf({ ...executiveSnapshot(), serpPanel: { ...panelBlock(), market } });
      expect(panel!.market, JSON.stringify(market)).toBeNull();
      expect(panel!.queries).toHaveLength(3);
    }
  });

  it("drops a malformed block rather than the page", async () => {
    // Every one of these is a producer bug, and none of them may take down a
    // asset page whose other twelve sections are fine.
    for (const [name, block] of [
      ["not an object", 42],
      ["no report date", { trackedDepth: 20, queries: panelBlock().queries }],
      ["queries not an array", { reportDate: "2026-08-03", trackedDepth: 20, queries: {} }],
      ["no readable row", { reportDate: "2026-08-03", trackedDepth: 20, queries: [{ bestRank: 2 }] }],
    ] as const) {
      ctx = await createTestStore();
      await seed(ctx);
      const panel = await panelOf({ ...executiveSnapshot(), serpPanel: block });
      expect(panel, name).toBeNull();
    }
  });

  it("normalizes a row's unusable numbers to unknown without losing the query", async () => {
    const panel = await panelOf({
      ...executiveSnapshot(),
      serpPanel: {
        ...panelBlock(),
        queries: [
          { query: "macro calculator", bestRank: "3", bestUrl: 7, aioPresent: "true", aioCitesUs: 1 },
        ],
      },
    });
    // A rank nobody could read is a rank nobody measured — which is the fact
    // `bestRank: null` already carries. The string "true" is NOT an AI
    // Overview; anything but a literal boolean is unknown, never false.
    expect(panel!.queries).toEqual([
      {
        query: "macro calculator",
        device: "desktop",
        label: null,
        bestRank: null,
        bestUrl: null,
        aioPresent: null,
        aioCitesUs: null,
        composition: null,
      },
    ]);
  });

  it("shows only current composition when the top three changed between snapshots", async () => {
    const previous = panelBlock();
    previous.queries[0]!.composition!.top3Domains = [
      "old-one.example",
      "old-two.example",
      "old-three.example",
    ];
    await insertSnapshot(ctx, "panel-old", {
      ...executiveSnapshot(),
      generatedAt: "2026-08-03T10:00:00.000Z",
      serpPanel: previous,
    });
    await insertSnapshot(ctx, "panel-new", {
      ...executiveSnapshot(),
      generatedAt: "2026-08-04T10:00:00.000Z",
      serpPanel: panelBlock(),
    });

    const payload = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    const current = payload.executive!.serpPanel!.queries[0]!;
    expect(current.composition!.top3Domains).toEqual([
      "usda.gov",
      "meals.example",
      "healthline.com",
    ]);
    // One retained collection can say who is there now and nothing about how
    // they got there. Movement remains the designed absence until ro-770 keeps
    // a second panel collection in the read model.
    expect(current).not.toHaveProperty("previousComposition");
    expect(current).not.toHaveProperty("movement");
  });

  it("keeps current panel evidence and its review obligation without a future-feature list", async () => {
    await insertDataForSeoCollection(ctx, "meals.example", "2026-08-03", "2026-08-03T06:00:00.000Z", { panel: true });
    await seedSnapshot(ctx, "2026-08-03T11:59:30.000Z", [
      workProject({ panelReview: panelReviewBead({ panelDate: "2026-08-03" }) }),
    ]);
    await insertSnapshot(ctx, "panel", { ...executiveSnapshot(), serpPanel: panelBlock(),
    });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(p.panelReview).not.toBeNull();
    expect(p.executive?.serpPanel).not.toBeNull();
    expect(p).not.toHaveProperty("laterPhase");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The asset page's serp-panel review obligation (bead `ro-elf`).
//
// The card is a drill-down TARGET: an overdue badge on the Wall means "open the
// asset page and act", and the page said nothing at all about the review. So
// the assertions below are less about the two fields than about the AGREEMENT —
// the page reads the same snapshot and the same landings through the same two
// functions the card does, and the shared `panelReviewState` then says the same
// word over both.
// ─────────────────────────────────────────────────────────────────────────────
describe("buildAssetDetailPayload — the page's panel-review slice", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seed(ctx);
  });

  const pageFor = async (asset: string) =>
    (await buildAssetDetailPayload(ctx.call, asset, DEPS))!;

  it("carries the review bead and the panel day it has to be about", async () => {
    await insertDataForSeoCollection(ctx, "meals.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: true });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ panelReview: panelReviewBead() }),
    ]);

    const page = await pageFor("meals.example");
    expect(page.panelReview).toEqual({
      beadId: "mp-4a2",
      panelDate: "2026-07-01",
      dueAt: "2026-07-08T06:00:00.000Z",
      status: "open",
      closedAt: null,
      panel: true,
    });
    expect(page.latestPanelDate).toBe("2026-07-01");
    expect(panelReviewState(page.panelReview, page.latestPanelDate, NOW_MS)).toBe("pending");
  });

  it("marks an asset with no config/serp-panel.json entry as panel-less, not as review-less", async () => {
    // Bead ro-z0g, and the same answer the card gives (wall-payload's twin
    // test): the page and the card read one key set, so the row and the badge
    // that sent the operator to it cannot use two different nouns.
    await insertDataForSeoCollection(ctx, "nosh.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: false });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ asset: "nosh.example", prefix: "nom", panelReview: panelReviewBead({ beadId: "nom-f1c" }) }),
    ]);

    const page = await pageFor("nosh.example");
    expect(page.panelReview?.panel).toBe(false);
    expect(page.panelReview?.beadId).toBe("nom-f1c");
    expect(panelReviewState(page.panelReview, page.latestPanelDate, NOW_MS)).toBe("pending");
  });

  it("is overdue on the page exactly when it is overdue on the card", async () => {
    // Past the deadline with the panel still untriaged — the error-toned state,
    // and the only one that sends anybody anywhere.
    await insertDataForSeoCollection(ctx, "meals.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: true });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ panelReview: panelReviewBead({ dueAt: "2026-07-04T06:00:00.000Z" }) }),
    ]);

    const page = await pageFor("meals.example");
    expect(panelReviewState(page.panelReview, page.latestPanelDate, NOW_MS)).toBe("overdue");
    // The page has room the card does not, and this is what it spends it on:
    // the bead to close, and the deadline it is past.
    expect(page.panelReview!.beadId).toBe("mp-4a2");
    expect(page.panelReview!.dueAt).toBe("2026-07-04T06:00:00.000Z");
  });

  it("is reviewed once the bead for the newest panel day is closed", async () => {
    await insertDataForSeoCollection(ctx, "meals.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: true });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({
        panelReview: panelReviewBead({
          status: "closed",
          closedAt: "2026-07-03T09:00:00.000Z" }) }),
    ]);

    const page = await pageFor("meals.example");
    expect(panelReviewState(page.panelReview, page.latestPanelDate, NOW_MS)).toBe("reviewed");
  });

  it("falls back to pending when a NEWER panel day has landed", async () => {
    // A fresh result page nobody has opened, behind a finished review about last
    // week's. The page must not reassure any more readily than the card does.
    await insertDataForSeoCollection(ctx, "meals.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: true });
    await insertDataForSeoCollection(ctx, "meals.example", "2026-07-04", "2026-07-04T06:00:00.000Z", { panel: true });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({
        panelReview: panelReviewBead({
          status: "closed",
          closedAt: "2026-07-03T09:00:00.000Z" }) }),
    ]);

    const page = await pageFor("meals.example");
    expect(page.latestPanelDate).toBe("2026-07-04");
    expect(panelReviewState(page.panelReview, page.latestPanelDate, NOW_MS)).toBe("pending");
  });

  it("shows the review of an asset that buys a collection but no panel", async () => {
    // Bead ro-1tu, the page's half. The Wall card is a drill-down TARGET, so a
    // marker there and silence here would send the operator to a page with
    // nothing on it. nom is absent from the panel config this test was given and
    // still owes the read, because since ro-478 the review is about the weekly
    // collection rather than the panel family inside it.
    await insertDataForSeoCollection(ctx, "nosh.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: false });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({ asset: "nosh.example", prefix: "nom", panelReview: panelReviewBead({ beadId: "nom-f1c" }) }),
    ]);

    const page = await pageFor("nosh.example");
    expect(page.panelReview!.beadId).toBe("nom-f1c");
    expect(page.latestPanelDate).toBe("2026-07-01");
    expect(panelReviewState(page.panelReview, page.latestPanelDate, NOW_MS)).toBe("pending");
  });

  it("sheds the marker once the collection behind the review stops", async () => {
    // The other half of ro-1tu: a review with no live collection behind it is an
    // obligation nobody can discharge, so it leaves the page rather than sitting
    // there as a finished-looking marker forever. This landing is one day past
    // the window the runner's filer itself works in.
    const stopped = new Date(NOW_MS - 22 * DAY).toISOString();
    await insertDataForSeoCollection(ctx, "nosh.example", stopped.slice(0, 10), stopped, { panel: false });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [
      workProject({
        asset: "nosh.example",
        prefix: "nom",
        panelReview: panelReviewBead({
          beadId: "nom-f1c",
          status: "closed",
          closedAt: "2026-06-20T09:00:00.000Z",
        }),
      }),
    ]);

    const page = await pageFor("nosh.example");
    expect(page.panelReview).toBeNull();
    expect(page.latestPanelDate).toBeNull();
    expect(panelReviewState(page.panelReview, page.latestPanelDate, NOW_MS)).toBe("none");
  });

  it("degrades a snapshot written before the field existed to absence", async () => {
    // The ordinary state of the store until the operator restarts os:up. An
    // older writer's payload is not damage: it renders nothing rather than an
    // unmet obligation nobody has.
    await insertDataForSeoCollection(ctx, "meals.example", "2026-07-01", "2026-07-01T06:00:00.000Z", { panel: true });
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [workProject()]);

    const page = await pageFor("meals.example");
    expect(page.panelReview).toBeNull();
    // The landing is still readable — it is the REVIEW that is unknown.
    expect(page.latestPanelDate).toBe("2026-07-01");
    expect(panelReviewState(page.panelReview, page.latestPanelDate, NOW_MS)).toBe("none");
  });

  it("says nothing when the panel is configured but has never landed", async () => {
    await seedSnapshot(ctx, "2026-07-05T11:59:30.000Z", [workProject()]);

    const page = await pageFor("meals.example");
    expect(page.panelReview).toBeNull();
    expect(page.latestPanelDate).toBeNull();
    expect(panelReviewState(page.panelReview, page.latestPanelDate, NOW_MS)).toBe("none");
  });
});

/**
 * ro-wlq5.1 — self-declared flags re-derived against the asset's own newest
 * envelope.
 *
 * These arrive inside the asset's pulse: the OS never derived them, so it
 * never un-derived them, and nosh.example accumulated sixteen open ones over four
 * weeks. Their source of truth is the latest envelope.
 */
describe("buildAssetDetailPayload — self-declared liveness", () => {
  const deps = { ...DEPS, now: new Date("2026-07-06T12:00:00.000Z") };
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seed(ctx);
  });

  async function pulse(
    ctx: TestStore,
    asset: string,
    date: string,
    flaggedMetrics: string[],
  ): Promise<void> {
    // A source-ended verdict requires the newer report to cover the metric,
    // not merely leave it out of its flags. Validate the full wire contract here.
    const envelope = PulseEnvelope.parse({
      asset,
      generatedAt: `${date}T02:00:00.000Z`,
      capabilities: ["apiRequests", "signups"],
      metrics: {
        apiRequests: { last24h: 0, avg7d: 11, total: 100 },
        signups: { last24h: 0, avg7d: 5, total: 50 },
      },
      flags: flaggedMetrics.map((metric) => ({
        severity: "warn", kind: "anomaly", metric, msg: "below baseline",
      })),
    });
    await storeReport(ctx.call, {
      asset,
      date,
      generatedAt: `${date}T02:00:00.000Z`,
      receivedAt: `${date}T02:05:00.000Z`,
      capabilities: envelope.capabilities,
      envelope,
    });
  }

  async function declaredFlag(ctx: TestStore, asset: string, metric: string): Promise<void> {
    await storeAlert(ctx.call, {
      asset,
      firedAt: "2026-07-05T02:00:00.000Z",
      severity: "warn",
      kind: "anomaly",
      metric,
      message: "below baseline",
      ruleId: "asset-declared",
      ruleInputs: '{"source":"envelope"}',
    });
  }

  it("keeps a flag the newest pulse still declares", async () => {

    await seedReportsAndAlerts(ctx);
    await declaredFlag(ctx, "meals.example", "apiRequests");
    await pulse(ctx, "meals.example", "2026-07-06", ["apiRequests"]);

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", deps))!;
    const row = p.flags.open.find((f) => f.ruleId === "asset-declared")!;
    expect(row.liveness.state).toBe("live");
    expect(row.verification).toMatchObject({
      state: "confirmed",
      lastConfirmedAt: "2026-07-06T02:05:00.000Z",
      lastEvaluatedAt: "2026-07-06T02:05:00.000Z",
      source: "Nightly report",
    });
    expect(row.firstFiredAt).toBe("2026-07-05T02:00:00.000Z");
  });

  it("marks it stale when the newest pulse no longer declares it", async () => {

    await seedReportsAndAlerts(ctx);
    await declaredFlag(ctx, "meals.example", "apiRequests");
    await pulse(ctx, "meals.example", "2026-07-06", ["signups"]);

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", deps))!;
    expect(p.flags.open.some((f) => f.ruleId === "asset-declared")).toBe(false);
    const row = p.flags.notCurrent.find((f) => f.ruleId === "asset-declared")!;
    expect(row.liveness).toMatchObject({ state: "stale" });
    expect(row.verification).toMatchObject({
      state: "source-ended",
      lastConfirmedAt: null,
      lastEvaluatedAt: "2026-07-06T02:05:00.000Z",
    });
    expect(row.resolvedAt).toBeNull();
    // The reason is a code the desk renders as a label, and the evidence it
    // names travels as data — the report's date in `lastEvaluatedAt` above and
    // the metric on the row — so the row reads back rather than merely
    // vanishing from a list (bead `ro-ujb9.96.6.7`).
    if (row.liveness.state === "stale") {
      expect(row.liveness.reason).toBe("report-no-longer-flags");
    }
    expect(row.verification?.reason).toBe("report-no-longer-flags");
    expect(row.metric).toBe("apiRequests");
  });

  /**
   * THE EDGE CASE THAT DECIDES CORRECTNESS. An asset that has stopped
   * reporting has no envelope to check against, and absence of a pulse is not
   * evidence a condition ended — it is evidence nothing was measured. Clearing
   * alerts because the reporter went quiet is the one failure mode that would
   * silently delete real ones.
   */
  it("keeps flags open but unverified when the asset has no pulse at all", async () => {
    await seedReportsAndAlerts(ctx);
    // An asset that has never reported: no envelope exists to check against.
    await addSites(ctx, [{ id: "silent.example", domain: null, displayName: "Silent", status: "live", senseOnly: 0, createdAt: "2026-01-01T00:00:00.000Z" }]);
    await declaredFlag(ctx, "silent.example", "apiRequests");

    const p = (await buildAssetDetailPayload(ctx.call, "silent.example", deps))!;
    const row = p.flags.open.find((f) => f.ruleId === "asset-declared")!;
    expect(row.liveness.state).toBe("last-known");
    expect(row.verification).toMatchObject({
      state: "unverified", lastConfirmedAt: null, lastEvaluatedAt: null,
    });
    expect(p.flags.openWarn).toBe(1);
    expect(row.resolvedAt).toBeNull();
  });

  it("keeps flags open but unverified when the newest envelope cannot be read", async () => {

    await seedReportsAndAlerts(ctx);
    await declaredFlag(ctx, "meals.example", "apiRequests");
    // The store takes only a JSON object for a report (bead ro-ujb9.76.5.2),
    // so the unreadable part is its flags.
    await storeReport(ctx.call, {
      asset: "meals.example",
      date: "2026-07-06",
      generatedAt: "2026-07-06T02:00:00.000Z",
      receivedAt: "2026-07-06T02:05:00.000Z",
      capabilities: [],
      envelope: { flags: "not a list at all" },
    });

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", deps))!;
    const row = p.flags.open.find((f) => f.ruleId === "asset-declared")!;
    expect(row.liveness.state).toBe("last-known");
    expect(row.verification).toMatchObject({
      state: "unverified", lastConfirmedAt: null, lastEvaluatedAt: null,
    });
    expect(row.resolvedAt).toBeNull();
  });

  it("does not re-evaluate or clear an unlinked central-rule flag from a newer report", async () => {

    await seedReportsAndAlerts(ctx);
    await storeAlert(ctx.call, {
      asset: "meals.example",
      firedAt: "2026-07-05T02:00:00.000Z",
      severity: "warn",
      kind: "anomaly",
      metric: "apiRequests",
      message: "below baseline",
      ruleId: "flow-poisson-low",
      ruleInputs: "{}",
    });
    await pulse(ctx, "meals.example", "2026-07-06", []);

    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", deps))!;
    // The central evaluator owns recovery. A later report is neither a linked
    // confirmation nor permission for the read model to run that rule again.
    const row = p.flags.open.find((f) => f.ruleId === "flow-poisson-low" && f.metric === "apiRequests")!;
    expect(row.liveness.state).toBe("last-known");
    expect(row.verification).toMatchObject({
      state: "unverified", lastConfirmedAt: null, lastEvaluatedAt: null,
      source: "Central metric rule",
    });
    expect(row.resolvedAt).toBeNull();
  });
});

/**
 * A snoozed condition on the asset page (`ro-c7qq`). It has to be in exactly
 * ONE list at any instant: parked under Snoozed while the clock runs — never in
 * History, which is what is settled (bead `ro-ujb9.194`) — and back in the Open
 * list the moment it does not.
 */
describe("a snoozed alert leaves the hero and returns on its date", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "live", 0, 0);
  });

  async function snoozedFlag(until: string): Promise<void> {
    await insertFlag(ctx, {
      asset: "meals.example",
      fired_at: "2026-07-04T02:00:00.000Z",
      severity: "warn",
      kind: "anomaly",
      metric: "signups",
      message: "18 in last24h (avg7d 40.0)",
      rule_id: "flow-poisson-low",
      disposition: "snooze",
      disposition_note: "Snoozed by operator",
      snooze_until: until,
    });
  }

  it("is absent from open and counted nowhere while it is quiet", async () => {
    await snoozedFlag("2026-07-09T12:00:00.000Z"); // four days after NOW
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;

    expect(p.flags.open).toEqual([]);
    expect(p.flags.notCurrent).toEqual([]);
    // The hero's headline number agrees with the rows under it: a snoozed
    // condition that still counted as an open warning would colour the asset
    // Degraded over a row nobody is being shown.
    expect(p.flags.openWarn).toBe(0);
    expect(p.asset.worstOpenSeverity).toBeNull();

    // Visible where it is honest — parked, with the date it comes back — and
    // NOT in History: a snooze is put off, not settled (bead `ro-ujb9.194`).
    expect(p.flags.snoozed).toHaveLength(1);
    expect(p.flags.snoozed[0]).toMatchObject({
      disposition: "snooze",
      snoozeUntil: "2026-07-09T12:00:00.000Z",
    });
    expect(p.flags.history).toEqual([]);
  });

  it("is parked as ONE row per condition, like the Open list and /alerts", async () => {
    // A recurring condition's firings are snoozed together; the site's Snoozed
    // panel names the condition once, as the Wall's Snoozed ledger does.
    for (const firedAt of ["2026-07-02T02:00:00.000Z", "2026-07-03T02:00:00.000Z"]) {
      await insertFlag(ctx, {
        asset: "meals.example",
        fired_at: firedAt,
        severity: "warn",
        kind: "anomaly",
        metric: "signups",
        message: "18 in last24h (avg7d 40.0)",
        rule_id: "asset-declared",
        disposition: "snooze",
        disposition_note: "Snoozed by operator",
        snooze_until: "2026-07-09T12:00:00.000Z",
      });
    }
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;

    expect(p.flags.snoozed).toHaveLength(1);
    expect(p.flags.snoozed[0]).toMatchObject({ ruleId: "asset-declared", occurrences: 2 });
    expect(p.flags.history).toEqual([]);
  });

  it("is back in Current signals once the date has passed, as the same row", async () => {
    await snoozedFlag("2026-07-04T12:00:00.000Z"); // a day BEFORE NOW
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;

    expect(p.flags.open).toHaveLength(1);
    // Same condition, same evidence, and the snooze still on the record — the
    // row explains its own reappearance rather than arriving as a new alert.
    expect(p.flags.open[0]).toMatchObject({
      ruleId: "flow-poisson-low",
      message: "18 in last24h (avg7d 40.0)",
      disposition: "snooze",
      snoozeUntil: "2026-07-04T12:00:00.000Z",
    });
    expect(p.flags.openWarn).toBe(1);
    // And it is not ALSO parked or in history: one row, one list.
    expect(p.flags.snoozed).toEqual([]);
    expect(p.flags.history).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The PostHog product block (beads `ro-ghis.2` / `ro-ghis.3`).
//
// The fixture is the block `scripts/signal-insights.mjs` really emits for the
// contract's acceptance read — `scripts/posthog-panel.test.mjs` fails when the
// two drift — so this proves the Tower reads the producer's own output.
// ─────────────────────────────────────────────────────────────────────────────
describe("buildAssetDetailPayload — latest Clarity observation", () => {
  let ctx: TestStore;
  beforeEach(async () => { ctx = await createTestStore(); await seed(ctx); });
  const clarity = { source: "clarity", reportDate: "2026-07-04", collectedAt: "2026-07-04T11:00:00.000Z",
    windowHours: 72, truncated: true, page: { url: "https://meals.example/planner", sessions: null, scriptErrors: 0 },
    unattributedSessions: 7 };
  const read = async (block: unknown) => {
    await insertSnapshot(ctx, "clarity", { ...executiveSnapshot(), clarity: block });
    return (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!.executive;
  };
  it("copies actual page-scoped facts, explicit zero, unknown and provenance without arbitrary keys", async () => {
    const result = await read({ ...clarity, injected: "not forwarded", page: { ...clarity.page, sitewide: true } });
    expect(result?.clarity).toEqual(clarity);
    expect(result?.clarity?.page).not.toHaveProperty("sitewide");
    expect(result?.items).toHaveLength(1);
  });
  it("rejects a fractional count without losing other insights", async () => {
    const result = await read({ ...clarity, page: { ...clarity.page, sessions: 1.5 } });
    expect(result?.clarity).toBeNull();
    expect(result?.items).toHaveLength(1);
  });
  it("refuses unsafe page URLs", async () => {
    expect((await read({ ...clarity, page: { ...clarity.page, url: "javascript:alert(1)" } }))?.clarity).toBeNull();
  });
  it("refuses unreviewed windows", async () => {
    expect((await read({ ...clarity, windowHours: 24 }))?.clarity).toBeNull();
  });
  it("reads old snapshots as no Clarity block", async () => {
    await insertSnapshot(ctx, "old", executiveSnapshot());
    expect((await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!.executive?.clarity).toBeNull();
  });
});

describe("buildAssetDetailPayload — the PostHog product block", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seed(ctx);
  });

  const productOf = async (payload: unknown) => {
    await insertSnapshot(ctx, "product", payload);
    const p = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    return p.executive?.product;
  };

  it("carries the producer's acceptance block through, field for field", async () => {
    const product = await productOf({ ...executiveSnapshot(), product: posthogProduct });
    expect(product).toEqual(posthogProduct);
    expect(product?.funnels[0]?.steps.map((step) => step.people)).toEqual([18_826, 15_864, 15_394, 1_232]);
    expect(product?.vitals?.segments[0]).toMatchObject({ os: "Chrome OS", lcpP75: 3_844, inpP75: 744, inpRating: "poor" });
    expect(product?.exceptions?.noise?.message).toBe("Load failed");
    expect(product?.checks.every((check) => check.state === "fired")).toBe(true);
  });

  it("is null when the snapshot predates the block", async () => {
    expect(await productOf(executiveSnapshot())).toBeNull();
  });

  it("is null for a block from another source", async () => {
    expect(await productOf({ ...executiveSnapshot(), product: { ...posthogProduct, source: "hotjar" } })).toBeNull();
  });

  it("drops a malformed row without losing its neighbours, and never forwards an unreviewed key", async () => {
    const product = await productOf({
      ...executiveSnapshot(),
      product: {
        ...posthogProduct,
        injected: "<script>",
        vitals: {
          ...posthogProduct.vitals,
          segments: [
            { ...posthogProduct.vitals.segments[0], lcpP75: "fast" },
            // A rating with no measurement behind it is a verdict about nothing.
            { ...posthogProduct.vitals.segments[1], inpP75: null, inpRating: "poor" },
          ],
        },
        funnels: [{ ...posthogProduct.funnels[0], steps: [] }],
        checks: [...posthogProduct.checks, { key: "x", label: "X", state: "sort-of", detail: "" }],
      },
    });
    expect(product).not.toHaveProperty("injected");
    expect(product?.vitals?.segments).toHaveLength(1);
    expect(product?.vitals?.segments[0]?.inpRating).toBeNull();
    expect(product?.funnels).toEqual([]);
    expect(product?.checks).toHaveLength(5);
    // The parts that were fine are untouched.
    expect(product?.rageClicks).toEqual(posthogProduct.rageClicks);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One read per tab (bead `ro-ujb9.64`).
//
// Each tab polls a VIEW: the page's core plus that tab's own sections
// (`shared/asset-detail-views`). What these cases hold it to:
//  - every field a view carries is the whole page's field, read at the same
//    clock — a view is a projection, never a second derivation;
//  - a section a view does not draw is ABSENT, never an empty stand-in;
//  - a view does not read the tables only other tabs draw;
//  - the ledger is one statement whose totals still cover every row while it
//    lists only the newest 20 — held to the row-by-row build it replaced.
// ─────────────────────────────────────────────────────────────────────────────

/** The payload fields each section owns — the spec `ASSET_VIEW_SECTIONS` is
 * checked against. `watchHistory` owns `watches.history`, not a key. */
const SECTION_FIELD_SPEC: Record<string, string[]> = {
  performance: ["performance"],
  executive: ["executive", "recommendationEvidence"],
  metrics: ["metrics"],
  counters: ["counters"],
  ledger: ["ledger"],
  dailyRevenue: ["dailyRevenue"],
  decisions: ["decisions"],
  tasks: ["handoffBeads", "operator", "panelReview", "latestPanelDate"],
  annotations: ["annotations"],
  watchHistory: [],
  reclamation: ["reclamation"],
  hygiene: ["hygiene"],
  fetchFailures: ["fetchFailures"],
};

/** Something on every section, so "present" and "absent" both mean something. */
async function seedEverySection(ctx: TestStore) {
  const raw = ctx;
  await seed(raw);
  await seedReportsAndAlerts(ctx);
  await seedChanges(ctx);
  await insertWatchWindow(ctx, {
    id: "w-views",
    asset: "meals.example",
    metric_integration: "gsc",
    metric: "clicks",
    registered_at: "2026-07-01T00:00:00.000Z",
    check_offsets: [7, 14],
    readings: [],
  });
  // The Search Console run, the money sections, the site-page sections, the
  // task photograph, the insight snapshot and the weekly collection are on
  // Postgres: `writeViewSignals`, `seedEveryMoneySection` and
  // `seedEverySectionOnPostgres`.
  await insertPullFailure(ctx, "meals.example", null, [
    { at: "2026-07-05T02:30:00.000Z", status: 503, providerError: "unconfigured", error: "503 unconfigured — set CF_ACCOUNT_ID" },
  ]);
}

/** The money sections of `seedEverySection` (the ledger and the daily revenue,
 * on Postgres), written by the tests that compare what the views carry. */
async function seedEveryMoneySection(ctx: TestStore) {
  await seedLedger(ctx);
  await writeMediavine(ctx.call, [{ id: "mv-1", asset: "meals.example", siteId: "site-mp", start: "2026-07-03", end: "2026-07-03",
    attemptedAt: "2026-07-04T08:00:00.000Z", days: [["2026-07-03", 1234]] }]);
}

/** The site-page sections of `seedEverySection` on Postgres (bead
 * ro-ujb9.76.5.8), in the test's own copy of its sites: written only by the
 * test that reads them (test/sites.ts). */
async function seedEverySectionOnPostgres(ctx: TestStore): Promise<void> {
  await seedSnapshot(ctx, "2026-07-05T11:55:00.000Z", [workProject({ handoffs: [] })]);
  await insertSnapshot(ctx, "snap-views", executiveSnapshot());
  await insertDataForSeoCollection(ctx, "meals.example", "2026-07-01", "2026-07-02T05:00:00.000Z", { panel: true });
  const store = ctx.call;
  await insertReclamationTargets(store, [
    { asset: "meals.example", domain: "extension.example", page: "/links", status: "sent", statusAt: "2026-07-02T00:00:00.000Z" },
  ]);
  await insertHygieneReading(store, {
    asset: "meals.example", check: "html-depth", day: "2026-07-04", status: "ok", value: 1800, at: "2026-07-04T06:00:00.000Z",
  });
}

/** A Search Console run with two days, on Postgres where the collectors write
 * them (bead ro-ujb9.76.5.3): written by the tests that read it, so the rest
 * of `seedEverySection` stays a copy every test shares. */
async function writeViewSignals(ctx: TestStore): Promise<void> {
  await writeSignalRun(ctx.call, {
    id: "gsc-views", asset: "meals.example", integration: "gsc", credentialRef: "google-primary",
    propertyRef: "sc-domain:meals.example", startedAt: "2026-07-05T11:00:00.000Z", finishedAt: "2026-07-05T11:01:00.000Z",
    windowStart: "2026-07-01", windowEnd: "2026-07-04", providerRows: 2, observationCount: 2,
  }, valuesOf("clicks", { "2026-07-03": 40, "2026-07-04": 44 }));
}

/**
 * An `asset-pull-failed` alert the way the pull lane leaves it (bead
 * `ro-ujb9.220`): the flag carries the latest night's summary, and each failed
 * night is its own `flag_evidence` reading, on Postgres (bead
 * ro-ujb9.76.5.2). Returns the flag's number.
 */
async function insertPullFailure(
  ctx: TestStore,
  asset: string,
  resolvedAt: string | null,
  nights: { at: string; status: number; error: string; providerError?: string }[],
): Promise<number> {
  const latest = nights.at(-1)!;
  const inputs = (night: (typeof nights)[number], count: number) => JSON.stringify({
    rule: "asset-pull-failed", url: `https://${asset}/api/internal/metrics`, status: night.status, error: night.error,
    ...(night.providerError ? { providerError: night.providerError } : {}),
    failureCount: count, lastFailedAt: night.at, evaluatedAt: night.at,
  });
  const store = ctx.call;
  const flagId = await storeAlert(store, {
    asset, firedAt: nights[0]!.at, severity: "warn", kind: "anomaly", metric: null,
    message: `pull failed: ${latest.error}`, ruleId: "asset-pull-failed", ruleInputs: inputs(latest, nights.length), resolvedAt,
  });
  for (const [i, night] of nights.entries()) {
    await storeReading(store, flagId, { observedAt: night.at, severity: "warn", message: `pull failed: ${night.error}`, ruleInputs: inputs(night, i + 1) });
  }
  return flagId;
}

describe("failed nightly fetches keep their own records (ro-ujb9.220)", () => {
  const NIGHTS = [
    { at: "2026-07-03T02:30:00.000Z", status: 503, providerError: "unconfigured", error: "503 unconfigured — set CF_ACCOUNT_ID" },
    { at: "2026-07-04T02:30:00.000Z", status: 401, providerError: "unauthorized", error: "401 unauthorized" },
    { at: "2026-07-05T02:30:00.000Z", status: 502, error: "non-200 response (502): gateway" },
  ];

  it("the Data sources read lists each night newest first, and the open alert carries them", async () => {
    const ctx = await createTestStore();
    await seed(ctx);
    await seedReportsAndAlerts(ctx);
    const past = await insertPullFailure(ctx, "meals.example", "2026-07-01T02:30:00.000Z", [
      { at: "2026-06-30T02:30:00.000Z", status: 404, error: "non-200 response (404)" },
    ]);
    const open = await insertPullFailure(ctx, "meals.example", null, NIGHTS);
    // Another site's failure and another rule's reading never reach this list.
    await insertPullFailure(ctx, "nosh.example", null, [NIGHTS[0]!]);

    const sources = (await buildAssetDetailView(ctx.call, "meals.example", DEPS, "sources"))! as AssetDetailFor<"sources">;
    expect(sources.fetchFailures?.map(({ at, ongoing }) => ({ at, ongoing }))).toEqual([
      { at: NIGHTS[2]!.at, ongoing: true },
      { at: NIGHTS[1]!.at, ongoing: true },
      { at: NIGHTS[0]!.at, ongoing: true },
      { at: "2026-06-30T02:30:00.000Z", ongoing: false },
    ]);
    expect(sources.fetchFailures?.[1]?.ruleInputs).toMatchObject({ status: 401, providerError: "unauthorized" });

    const alerts = (await buildAssetDetailView(ctx.call, "meals.example", DEPS, "alerts"))!;
    const openAlert = [...alerts.flags.open, ...alerts.flags.notCurrent].find((flag) => flag.id === open)!;
    expect(openAlert.readings?.map((reading) => reading.at)).toEqual([NIGHTS[2]!.at, NIGHTS[1]!.at, NIGHTS[0]!.at]);
    const settled = alerts.flags.history.find((flag) => flag.id === past)!;
    expect(settled.readings?.map((reading) => reading.at)).toEqual(["2026-06-30T02:30:00.000Z"]);
  });

  it("nothing failed: an empty list, and alerts without readings stay as they were", async () => {
    const ctx = await createTestStore();
    await seed(ctx);
    await seedReportsAndAlerts(ctx);
    const sources = (await buildAssetDetailView(ctx.call, "meals.example", DEPS, "sources"))! as AssetDetailFor<"sources">;
    expect(sources.fetchFailures).toEqual([]);
    const alerts = (await buildAssetDetailView(ctx.call, "meals.example", DEPS, "alerts"))!;
    for (const flag of [...alerts.flags.open, ...alerts.flags.notCurrent, ...alerts.flags.history]) {
      expect(flag).not.toHaveProperty("readings");
    }
  });
});


describe("buildAssetDetailView — one read per tab (ro-ujb9.64)", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seedEverySection(ctx);
  });

  it("names exactly the tabs the page has, and maps every section to its fields", () => {
    expect([...ASSET_DETAIL_VIEWS]).toEqual([...ASSET_TABS]);
    const used = new Set(Object.values(ASSET_VIEW_SECTIONS).flat());
    expect([...used].sort()).toEqual(Object.keys(SECTION_FIELD_SPEC).sort());
  });

  it("every view is the whole page's own fields at the same clock, and only its own", async () => {
    await seedEveryMoneySection(ctx);
    await seedEverySectionOnPostgres(ctx);
    await writeViewSignals(ctx);
    const full = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS)) as unknown as Record<string, unknown>;
    expect(full.hygiene).not.toBeNull();
    expect(full.reclamation).not.toBeNull();
    expect(full).not.toHaveProperty("view");
    expect(full).not.toHaveProperty("laterPhase");
    const sectionFields = new Set(Object.values(SECTION_FIELD_SPEC).flat());
    const coreFields = Object.keys(full).filter((key) => !sectionFields.has(key));

    for (const view of ASSET_DETAIL_VIEWS) {
      const part = (await buildAssetDetailView(ctx.call, "meals.example", DEPS, view)) as unknown as Record<string, unknown>;
      const own = ASSET_VIEW_SECTIONS[view].flatMap((section) => SECTION_FIELD_SPEC[section]!);
      expect(part.view, view).toBe(view);
      expect(part, view).not.toHaveProperty("laterPhase");
      expect(Object.keys(part).filter((key) => key !== "view").sort(), view).toEqual([...coreFields, ...own].sort());
      for (const key of [...coreFields, ...own]) {
        if (key === "watches") continue;
        expect(part[key], `${view}.${key}`).toEqual(full[key]);
      }
      const watches = part.watches as Record<string, unknown>;
      const fullWatches = full.watches as Record<string, unknown>;
      expect(watches.open).toEqual(fullWatches.open);
      expect(watches.closed).toEqual(fullWatches.closed);
      if ((ASSET_VIEW_SECTIONS[view] as readonly string[]).includes("watchHistory")) {
        expect(watches.history).toEqual(fullWatches.history);
      } else {
        expect(watches).not.toHaveProperty("history");
      }
      expect(viewCovers(part as unknown as AssetDetailResponse, view)).toBe(true);
    }
  });

  it("leaves a section it does not draw ABSENT, so no tab can mistake it for empty", async () => {
    await seedEveryMoneySection(ctx);
    const alerts =(await buildAssetDetailView(ctx.call, "meals.example", DEPS, "alerts"))!;
    for (const key of ["performance", "executive", "metrics", "ledger", "annotations", "handoffBeads", "hygiene"]) {
      expect(alerts).not.toHaveProperty(key);
    }
    const response = alerts as AssetDetailResponse;
    // The Alerts read can draw Tasks (neither has a section of its own)…
    expect(viewCovers(response, "tasks")).toBe(true);
    // …but never a tab whose sections it does not carry.
    for (const other of ["overview", "growth", "financials", "search", "activity", "sources", "settings"] as const) {
      expect(viewCovers(response, other), other).toBe(false);
    }
    // A read cut for Overview carries everything Search and Growth draw.
    const overview = (await buildAssetDetailView(ctx.call, "meals.example", DEPS, "overview"))! as AssetDetailResponse;
    expect(viewCovers(overview, "search")).toBe(true);
    expect(viewCovers(overview, "growth")).toBe(true);
    // …and, since a revenue-first site leads with its daily revenue (bead
    // ro-ujb9.146), everything Financials draws too.
    expect(viewCovers(overview, "financials")).toBe(true);
    expect(viewCovers(overview, "activity")).toBe(false);
  });

  it("does not read the tables only other tabs draw", async () => {
    await writeViewSignals(ctx);
    // The store's statements too: the charts and the watch history read it.
    const fullSql: string[] = [];
    await buildAssetDetailPayload(recordingStore(ctx.call, fullSql), "meals.example", DEPS);
    const tasksSql: string[] = [];
    await buildAssetDetailView(recordingStore(ctx.call, tasksSql), "meals.example", DEPS, "tasks");
    // The Site health history (Sources only). Every tab's header reads each
    // site's newest home-page check for its uptime mark (bead ro-ujb9.165),
    // a read of the same readings aliased `x`, not this one.
    const other = [
      /noticeos\.asset_insight_snapshots/, /FROM noticeos\.hygiene_checks\s+WHERE asset_id = \$1/, /noticeos\.reclamation_targets/, /noticeos\.task_snapshots/,
      /FROM noticeos\.item_dispositions/, /latest_success AS/, /reporting-time-zone-changed/, /current_property AS MATERIALIZED/,
      /WITH anchors AS MATERIALIZED/,
    ];
    for (const pattern of other) {
      expect(fullSql.some((sql) => pattern.test(sql)), `full reads ${pattern}`).toBe(true);
      expect(tasksSql.some((sql) => pattern.test(sql)), `tasks reads ${pattern}`).toBe(false);
    }
    expect(tasksSql.length).toBeLessThan(fullSql.length);
  });
});

// The totals the old Wall card drew, on the site's own page (bead ro-trai.21):
// the card's rule, freshest lane wins, over this site's rows only.
describe("buildAssetDetailView — the site's all-time totals", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seed(ctx);
  });

  /** One counters-lane reading, on Postgres where the totals are read (bead
   * ro-ujb9.76.5.1), in this test's own copy of its sites (test/sites.ts). */
  async function insertReading(asset: string, metric: string, value: number, observedAt: string) {
    await (ctx.call).write((tx) =>
      tx.execute(
        `INSERT INTO noticeos.counter_readings (workspace_id, asset_id, metric, value, observed_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz)`,
        [tx.workspaceId, asset, metric, value, observedAt],
      ),
    );
  }

  it("resolves each configured total for the Overview, with the lane's cadence", async () => {

    await seedReportsAndAlerts(ctx);
    await insertReading("meals.example", "signups", 1284, "2026-07-06T11:50:00.000Z");
    const overview = (await buildAssetDetailView(ctx.call, "meals.example", DEPS, "overview"))!;
    expect(overview.counters).toEqual({
      heading: "All-time totals",
      cadenceHours: 0.25,
      cards: [{ metric: "signups", label: "Accounts", value: 1284, observedAt: "2026-07-06T11:50:00.000Z", source: "counters" }],
    });
    // Only the Overview reads them.
    expect(await buildAssetDetailView(ctx.call, "meals.example", DEPS, "alerts")).not.toHaveProperty("counters");
  });

  it("ages the totals against the counters job's saved schedule, the one place it is written (ro-ujb9.222)", async () => {

    await seedReportsAndAlerts(ctx);
    await insertReading("meals.example", "signups", 1284, "2026-07-06T11:50:00.000Z");
    const hourly = { ...DEPS, schedules: { counters: { enabled: true, cron: "5 * * * *" } } };
    const overview = (await buildAssetDetailView(ctx.call, "meals.example", hourly, "overview"))!;
    expect(overview.counters?.cadenceHours).toBe(1);
  });

  it("is null for a site the register configures no totals for, and reads nothing for it", async () => {
    const sql: string[] = [];
    const overview = (await buildAssetDetailView(recordingStore(ctx.call, sql), "nosh.example", DEPS, "overview"))!;
    expect(overview.counters).toBeNull();
    // The store did answer this page (its site, at least), and never for totals.
    expect(sql.some((statement) => /noticeos\.assets/.test(statement))).toBe(true);
    expect(sql.some((statement) => /counter_readings/.test(statement))).toBe(false);
  });
});

describe("the asset ledger in one statement (ro-ujb9.64)", () => {
  // The read this replaced, from d6de54cd, is the specification: every current
  // row for the asset, totalled in JavaScript, the first 20 listed. Here in its
  // Postgres form (bead ro-ujb9.76.6.1): the same guard over the money view,
  // each entry by its workspace number.
  const ROWS_SPEC = `SELECT entry_number AS id, kind, to_char(period_month, 'YYYY-MM') AS period, family, amount_minor AS "amountMinor",
                booking_state AS "bookingState", source, ref, note,
                recorded_at AS "recordedAt"
           FROM noticeos.financial_ledger l
          WHERE l.asset_id = $1
            AND NOT EXISTS (SELECT 1 FROM noticeos.financial_ledger s WHERE s.supersedes_id = l.entry_id)
          ORDER BY period_month DESC, recorded_at DESC`;
  const AGE_SPEC = `SELECT MAX(recorded_at) AS ts
         FROM noticeos.financial_ledger l
        WHERE l.asset_id = $1
          AND NOT EXISTS (SELECT 1 FROM noticeos.financial_ledger s WHERE s.supersedes_id = l.entry_id)`;

  /** The specification's rows, read as the page reads a row: numbers and cents exact, instants as JavaScript writes them. */
  async function specRows(ctx: TestStore): Promise<SpecRow[]> {
    const rows = await (ctx.call).read((tx) =>
      tx.query<Omit<SpecRow, "id" | "amountMinor"> & { id: bigint; amountMinor: bigint }>(ROWS_SPEC, ["meals.example"]));
    return rows.map((row) => ({ ...row, id: Number(row.id), amountMinor: Number(row.amountMinor), recordedAt: javascriptInstant(row.recordedAt) }));
  }

  type SpecRow = {
    id: number; kind: string; period: string; family: string; amountMinor: number;
    bookingState: string; source: string | null; ref: string | null; note: string | null; recordedAt: string;
  };

  /** The row-by-row build as it stood at d6de54cd. */
  function specLedger(rows: SpecRow[]) {
    type Side = { revenueMinor: number; costMinor: number; rev: Map<string, number>; cost: Map<string, number> };
    const side = (): Side => ({ revenueMinor: 0, costMinor: 0, rev: new Map(), cost: new Map() });
    const byPeriod = new Map<string, { period: string; booked: Side; forecast: Side }>();
    for (const r of rows) {
      let acc = byPeriod.get(r.period);
      if (!acc) {
        acc = { period: r.period, booked: side(), forecast: side() };
        byPeriod.set(r.period, acc);
      }
      const s = r.bookingState === "reconciled" ? acc.booked : r.bookingState === "estimated" ? acc.forecast : null;
      if (!s) continue;
      if (r.kind === "revenue") {
        s.revenueMinor += r.amountMinor;
        s.rev.set(r.family, (s.rev.get(r.family) ?? 0) + r.amountMinor);
      } else {
        s.costMinor += r.amountMinor;
        s.cost.set(r.family, (s.cost.get(r.family) ?? 0) + r.amountMinor);
      }
    }
    const families = (m: Map<string, number>) =>
      [...m.entries()].map(([family, minor]) => ({ currency: 'USD', family, amount: minor / 100 })).sort((a, b) => b.amount - a.amount);
    const rollup = (s: Side) => ({
      figure: { currency: 'USD', revenue: s.revenueMinor / 100, cost: s.costMinor / 100, net: (s.revenueMinor - s.costMinor) / 100 },
      revenueByFamily: families(s.rev),
      costByFamily: families(s.cost),
    });
    return {
      periods: [...byPeriod.values()].map((a) => ({ period: a.period, booked: rollup(a.booked), forecast: rollup(a.forecast) })),
      recentRows: rows.slice(0, 20).map((r) => ({ currency: 'USD',
        id: r.id, kind: r.kind, period: r.period, family: r.family, amount: r.amountMinor / 100,
        bookingState: r.bookingState, source: r.source, ref: r.ref, note: r.note, recordedAt: r.recordedAt,
      })),
      empty: rows.length === 0,
      currency: "USD",
    };
  }

  /** Fourteen months of a busy asset: three revenue families and two costs a
   * month, estimates corrected by reconciliations, every row recorded at its
   * own instant so the listing order has one right answer. */
  async function seedBusyLedger(ctx: TestStore) {
    await insertAsset(ctx, "meals.example", "Meal Planner", "live", 0, 0);
    let id = 100;
    let minute = 0;
    const at = () => new Date(Date.UTC(2025, 5, 1) + (minute += 37) * 60_000).toISOString();
    for (let month = 0; month < 14; month += 1) {
      const period = new Date(Date.UTC(2025, 5 + month, 1)).toISOString().slice(0, 7);
      const estimate = id++;
      await insertLedger(ctx, { id: estimate, kind: "revenue", asset: "meals.example", period, family: "ads", amount: 100 + month, booking_state: "estimated", source: "raptive-report", recorded_at: at() });
      if (month < 12) {
        await insertLedger(ctx, { id: id++, kind: "revenue", asset: "meals.example", period, family: "ads", amount: 97.35 + month, booking_state: "reconciled", source: "raptive-report", supersedes_id: estimate, recorded_at: at() });
      }
      await insertLedger(ctx, { id: id++, kind: "revenue", asset: "meals.example", period, family: "affiliate", amount: 12.5, booking_state: "estimated", source: "cj-export", recorded_at: at() });
      await insertLedger(ctx, { id: id++, kind: "revenue", asset: "meals.example", period, family: "subs", amount: 12.5, booking_state: "reconciled", recorded_at: at() });
      // The same amount as `subs` on the same side, booked later: two families
      // tied on amount keep the order their newest rows were booked in.
      await insertLedger(ctx, { id: id++, kind: "revenue", asset: "meals.example", period, family: "licensing", amount: 12.5, booking_state: "reconciled", recorded_at: at() });
      await insertLedger(ctx, { id: id++, kind: "cost", asset: "meals.example", period, family: "infra", amount: 20.01, booking_state: "reconciled", recorded_at: at() });
      await insertLedger(ctx, { id: id++, kind: "cost", asset: "meals.example", period, family: "inference", amount: 3.3 + month / 10, booking_state: "estimated", ref: `chg-${month}`, recorded_at: at() });
    }
  }

  it("totals every current row and lists the newest 20, exactly as the row-by-row build did", async () => {
    const ctx = await createTestStore();
    await seedBusyLedger(ctx);
    const rows = await specRows(ctx);
    expect(rows.length).toBeGreaterThan(40);

    const page = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(page.ledger).toEqual(specLedger(rows));
    expect(page.ledger.recentRows).toHaveLength(20);
    // The totals are over all rows, not over the 20 listed.
    expect(page.ledger.periods).toHaveLength(14);
    const [age] = await (ctx.call).read((tx) => tx.query<{ ts: string }>(AGE_SPEC, ["meals.example"]));
    expect(page.freshness.ledgerRecordedAt).toBe(javascriptInstant(age!.ts));
  });

  it("reads the ledger view once per request, whichever tab asked", async () => {
    const ctx = await createTestStore();
    await seedBusyLedger(ctx);
    for (const read of [
      async (store: WorkspaceStore) => buildAssetDetailPayload(store, "meals.example", DEPS),
      async (store: WorkspaceStore) => buildAssetDetailView(store, "meals.example", DEPS, "financials"),
      async (store: WorkspaceStore) => buildAssetDetailView(store, "meals.example", DEPS, "settings"),
    ]) {
      const sql: string[] = [];
      await read(recordingStore(ctx.call, sql));
      // Before: one read for the rows and a second for the lane's age.
      expect(sql.filter((text) => /FROM noticeos\.financial_ledger/.test(text))).toHaveLength(1);
    }
  });

  it("states an empty ledger as empty, with no age", async () => {
    const ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "live", 0, 0);
    const page = (await buildAssetDetailPayload(ctx.call, "meals.example", DEPS))!;
    expect(page.ledger).toEqual({ periods: [], recentRows: [], empty: true, currency: "USD" });
    expect(page.freshness.ledgerRecordedAt).toBeNull();
  });

  it("breaks a tie on both listing dates newest id first", async () => {
    // The id a row shows is the number the store handed its entry, in the
    // order entries were booked (D1 let a fixture pick its ids out of that
    // order; the importer keeps D1's ids as the numbers). Booked 7, 9, 8.
    const ctx = await createTestStore();
    await insertAsset(ctx, "meals.example", "Meal Planner", "live", 0, 0);
    for (const id of [7, 9, 8]) {
      await insertLedger(ctx, { id, kind: "revenue", asset: "meals.example", period: "2026-06", family: "ads", amount: id, booking_state: "estimated", recorded_at: "2026-06-30T00:00:00.000Z",
      });
    }
    const store = ctx.call;
    const page = (await buildAssetDetailPayload(store, "meals.example", DEPS))!;
    expect(page.ledger.recentRows.map((row) => row.id)).toEqual([8, 9, 7].map((name) => bookedNumber(store, name)));
    expect(page.ledger.recentRows.map((row) => row.id)).toEqual([...page.ledger.recentRows.map((row) => row.id)].sort((a, b) => b - a));
  });
});

// The tab types are the proof that no tab reads outside its view: these lines
// are compiled by `pnpm --filter @noticeos/tower typecheck`.
// @ts-expect-error the Alerts tab's read carries no provider trends
export type AlertsHasNoTrends = AssetDetailFor<"alerts">["performance"];
// @ts-expect-error the Settings tab's read carries no ledger
export type SettingsHasNoLedger = AssetDetailFor<"settings">["ledger"];
// @ts-expect-error only the Activity tab's read carries the calibration series
export type SourcesHasNoWatchHistory = AssetDetailFor<"sources">["watches"]["history"];
export type ActivityHasWatchHistory = AssetDetailFor<"activity">["watches"]["history"];
export type FinancialsHasLedger = AssetDetailFor<"financials">["ledger"];
