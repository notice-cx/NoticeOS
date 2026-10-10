// @vitest-environment node
import { type HomeCheck, homeChecksSql, loadHomeChecks, loadIntegrationEvidence, uptimeState } from '../worker/integration-evidence';
import { beforeEach, describe, expect, it } from "vitest";
import {
  EGRESS_LANE_ID,
  INTEGRATION_LAYERS,
  connectionHealthState,
  NIGHTLY_REPORT_LANE_ID,
  type IntegrationsConfig,
  matrixUnblockers,
  sharedCredentialInsight,
  unblockers,
  withoutConnectPath,
  unusedWithoutConnectPath,
  undeclaredLanes,
} from "@shared/integrations";
import type { PullConfigEntry } from "../worker/asset-config";
import {
  LATEST_EGRESS_CHECK_SQL,
  SIGNAL_EVIDENCE_FLOOR_DAYS,
  buildAssetIntegrations,
  buildCardDataSources,
  buildIntegrationsMatrix,
  egressState,
  integrationsDeps,
  laneForRevenueRow,
  loadLatestSignalRuns,
  mergeLane,
  nightlyReportState,
  recentSincePeriod,
  recordTodaysSourceHistory,
  type LatestSignalRun,
  type LaneEvidence,
} from "../worker/integrations-payload";
import {
  loadDataForSeoSpend,
  loadMeteredCallsToday,
  loadProviderMeter,
} from "../worker/metered-spend";
import { storeAlert, storeReports } from "./alert-rows";
import { writeSignalRun } from "./collected-metrics";
import { type TestStore, createTestStore, recordingStore } from "./postgres-store";
import { bookLedger } from "./money";

import { writeArchiveRun, writeArchiveRuns, writeResearch } from "./provider-reports";
import { addSites } from "./sites";
import { seedAssets } from "./invented-sites";
import frozenRegister from "./fixture-config/integrations.json";

const NOW = new Date("2026-07-05T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const HOUR = 3_600_000;

// config/pull.json shape: meals and nosh are fetched nightly, areas is
// configured but switched off. Everything else pushes (or nothing).
const PULL_CONFIG: PullConfigEntry[] = [
  { asset: "meals.example", url: "https://meals.example/api/internal/metrics", enabled: true, format: "prometheus" },
  { asset: "nosh.example", url: "https://nosh.example/api/admin/overview", enabled: true, format: "envelope" },
  { asset: "areas.example", url: "https://areas.example/api/metrics", enabled: false, format: "envelope" },
];

// config/serp-panel.json's key set: meals.example is the one asset with a
// tracked panel, so the one asset due six weekly DataForSEO families.
const SERP_PANEL = { assets: { "meals.example": {} } };

const deps = (
  integrations: IntegrationsConfig,
  serpPanel: { assets?: Record<string, unknown> } = SERP_PANEL,
) => ({
  now: NOW,
  integrations,
  pullConfig: PULL_CONFIG,
  monthlyCaps: { dataUsd: 25 },
  serpPanel,
});

// Five lanes that exercise every merge branch: uptime from its own check, the
// two revenue-mapped families, a split affiliate pair, and a collected lane.
// Declared states are synthetic so the merge has a declared-live lane to downgrade.
const CATALOG = [
  { id: "gsc", label: "Google Search Console", docRef: "docs/11-integrations.md#the-catalog", credential: "shared" as const },
  { id: "uptime", label: "Uptime / monitoring", docRef: "docs/11-integrations.md#the-catalog", scope: "both" as const, credential: "shared" as const },
  // ad-network is per-property here to prove the insight excludes per-property lanes.
  { id: "ad-network", label: "Ad network reporting", docRef: "docs/11-integrations.md#the-catalog", credential: "per-property" as const },
  { id: "affiliate-cj", label: "Affiliate — CJ", docRef: "docs/11-integrations.md#the-catalog", credential: "shared" as const },
  { id: "affiliate-amazon", label: "Affiliate — Amazon", docRef: "docs/11-integrations.md#the-catalog", credential: "shared" as const },
];

function cell(status: string, extra: Record<string, string> = {}) {
  return { status: status as never, note: extra.note ?? `${status} note`, since: "2026-07-06", ...extra };
}

const INTEGRATIONS: IntegrationsConfig = {
  catalog: CATALOG,
  assets: {
    "root-os": {
      gsc: cell("not-applicable"),
      uptime: cell("needs-setup"),
      "ad-network": cell("not-applicable"),
      "affiliate-cj": cell("not-applicable"),
      "affiliate-amazon": cell("not-applicable"),
    },
    "meals.example": {
      gsc: cell("needs-setup"),
      uptime: cell("needs-setup"),
      "ad-network": cell("needs-setup"),
      "affiliate-cj": cell("needs-setup"),
      "affiliate-amazon": cell("skipped", { note: "REASON: Amazon program off" }),
    },
    "nosh.example": {
      gsc: cell("needs-setup"),
      uptime: cell("live"), // synthetic: its failing home-page check exercises declared-live → degraded
      "ad-network": cell("needs-setup"),
      "affiliate-cj": cell("needs-setup"),
      "affiliate-amazon": cell("not-applicable"),
    },
    "areas.example": {
      gsc: cell("needs-setup"),
      uptime: cell("needs-setup"),
      "ad-network": cell("needs-setup"),
      "affiliate-cj": cell("needs-setup"),
      "affiliate-amazon": cell("not-applicable"),
    },
    "fees.example": {
      gsc: cell("not-applicable"),
      uptime: cell("not-applicable"),
      "ad-network": cell("not-applicable"),
      "affiliate-cj": cell("not-applicable"),
      "affiliate-amazon": cell("not-applicable"),
    },
  },
};

/** A site in both of the test's stores (test/sites.ts). */
async function insertAsset(raw: TestStore, id: string, name: string, isOs: number) {
  await addSites(raw, [{ id, displayName: name, status: "onboarding", senseOnly: 1, isOs, createdAt: "2026-07-01T00:00:00.000Z" }]);
}

/** One failed collector attempt at a chosen instant, the fixture the evidence
 * floor is measured against: the fact the floor must not erase is a lane's
 * last bad news. A success when asked (the store never rewrites a run). */
async function insertSignalRun(
  ctx: TestStore,
  id: string,
  asset: string,
  integration: "ga4" | "gsc" | "bing-webmaster",
  finishedAt: string,
  status: "success" | "error" = "error",
) {
  const failed = status === "error";
  await writeSignalRun(ctx.call, {
    id, asset, integration, credentialRef: "example-signals", propertyRef: asset, finishedAt, status,
    providerRows: 0, observationCount: 0,
    errorCode: failed ? "provider_403" : null,
    errorMessage: failed ? "The service account lost access to the asset." : null,
  });
}

/** The one self-flag the egress gate files, as workers/ingest/src/egress.ts
 * writes it: on asset #0's row, `fired_at` dating the first down verdict, and
 * the beacons that failed carried verbatim in `rule_inputs`. */
async function insertEgressFlag(
  ctx: TestStore,
  asset: string,
  firedAt: string,
  inputs: Record<string, unknown>,
  resolvedAt: string | null = null,
) {
  await storeAlert(ctx.call, {
    asset,
    firedAt,
    severity: "warn",
    kind: "anomaly",
    message: "OS egress down — 2 assets unmeasured",
    ruleId: "os-egress-down",
    ruleInputs: inputs,
    resolvedAt,
  });
}

/** One recorded probe round. Rows exist only for runs where something already
 * failed, which is why a table with none of them is the healthy shape. */
async function insertEgressCheck(
  ctx: TestStore,
  observedAt: string,
  up: 0 | 1,
  beacons: Record<string, unknown>[],
) {
  await (ctx.call).write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.egress_checks (workspace_id, observed_at, up, detail) VALUES ($1, $2::timestamptz, $3, $4::jsonb)`,
      [tx.workspaceId, observedAt, up === 1, JSON.stringify({ beacons })],
    ),
  );
}

/** One home-page reading, as workers/ingest/src/hygiene.ts writes it: the
 * OS's own uptime check. */
async function insertHomeCheck(
  ctx: TestStore,
  asset: string,
  observedAt: string,
  status: "ok" | "error" | "unreachable",
  detail: Record<string, unknown>,
) {
  await (ctx.call).write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.hygiene_checks (workspace_id, asset_id, check_id, observed_at, observed_on, status, value_num, detail)
       VALUES ($1, $2, 'html-depth', $3::timestamptz, $4::date, $5, $6, $7::json)`,
      [tx.workspaceId, asset, observedAt, observedAt.slice(0, 10), status, status === "ok" ? 800 : null, JSON.stringify(detail)],
    ),
  );
}

/** nosh's home page answering 503 to the OS's own check twenty minutes ago:
 * its uptime's own evidence, never the report's alert. */
async function insertNomDown(ctx: TestStore) {
  await insertHomeCheck(ctx, "nosh.example", new Date(NOW_MS - 20 * 60_000).toISOString(), "error", {
    url: "https://nosh.example/", http_status: 503, error: "non-200 response (503)",
  });
}


/** Revenue in the ledger, booked only by the tests that read revenue evidence
 * (test/money.ts). */
async function insertRevenue(
  ctx: TestStore,
  id: number,
  asset: string,
  period: string,
  family: string,
  /** Dollars, for a readable fixture — rounded to exact cents on the way in. */
  amount: number,
  source: string | null,
) {
  // `amount_minor` alone, exactly as `/api/revenue` writes it.
  await bookLedger(ctx.call, [
    {
      id,
      kind: "revenue",
      asset,
      period,
      family,
      amount_minor: Math.round(amount * 100),
      booking_state: "reconciled",
      source,
      recorded_at: `${period}-28T00:00:00.000Z`,
    },
  ]);
}

async function seed(raw: TestStore) {
  // The OS row's stored name is one the Health page never shows.
  await insertAsset(raw, "root-os", "ReindexOS", 1);
  await insertAsset(raw, "meals.example", "Meal Planner", 0);
  await insertAsset(raw, "nosh.example", "Nosh", 0);
  await insertAsset(raw, "areas.example", "Area Lookup", 0);
  await insertAsset(raw, "fees.example", "Fee Codes", 0);
}

/** The seed's revenue, booked by the tests that read revenue evidence. */
async function seedRevenue(ctx: TestStore) {
  // meals: recent ads + affiliate(CJ) revenue, supporting evidence for both lanes.
  await insertRevenue(ctx, 1, "meals.example", "2026-06", "ads", 498.1, "raptive-report");
  await insertRevenue(ctx, 2, "meals.example", "2026-06", "affiliate", 168.2, "cj-export");
  // areas: only old revenue (before the 3-month window), so it must not support.
  await insertRevenue(ctx, 3, "areas.example", "2026-01", "ads", 50, "adsense-report");
}

/** `seed`'s nightly reports and nosh's open ingest-freshness alert, written by
 * the tests that read them. */
async function seedReports(ctx: TestStore) {
  const store = ctx.call;
  await storeAlert(store, {
    asset: "nosh.example",
    firedAt: "2026-07-05T04:00:00.000Z",
    severity: "error",
    kind: "anomaly",
    message: "0 pulses in 36h",
    ruleId: "ingest-freshness",
  });
  // Nightly reports: root-os and meals reported inside the cadence (live);
  // nosh's last one is 3 days old (degraded); areas + fees.example have never
  // reported (needs-setup).
  const report = (asset: string, date: string, receivedAt: string) => ({ asset, date, receivedAt, envelope: '{"metrics":{}}' });
  await storeReports(store, [
    report("root-os", "2026-07-05", new Date(NOW_MS - 2 * HOUR).toISOString()),
    report("meals.example", "2026-07-05", new Date(NOW_MS - 4 * HOUR).toISOString()),
    report("nosh.example", "2026-07-01", new Date(NOW_MS - 72 * HOUR).toISOString()),
    report("nosh.example", "2026-07-02", new Date(NOW_MS - 71 * HOUR).toISOString()),
  ]);
}

const NO_EVIDENCE: LaneEvidence = { revenueRows: [] };

const GSC_SUCCESS: LatestSignalRun = {
  asset: "meals.example",
  integration: "gsc",
  status: "success",
  finishedAt: new Date(NOW_MS - 15 * 60_000).toISOString(),
  windowStart: "2026-06-08",
  windowEnd: "2026-07-05",
  dataState: "includes-provisional",
  provisionalFrom: "2026-07-04",
  providerRows: 28,
  observationCount: 4,
  errorCode: null,
  errorMessage: null,
};

const BWT_SUCCESS: LatestSignalRun = {
  ...GSC_SUCCESS,
  integration: "bing-webmaster",
  windowEnd: "2026-07-03",
  dataState: "final",
  provisionalFrom: null,
  providerRows: 129,
  observationCount: 52,
};

const DATAFORSEO_SUCCESS: LatestSignalRun = {
  ...GSC_SUCCESS,
  integration: "dataforseo",
  windowStart: "2026-07-28",
  windowEnd: "2026-07-28",
  dataState: "final",
  provisionalFrom: null,
  providerRows: 240,
  observationCount: 5,
};

describe("mergeLane — observed health with file-backed setup/applicability", () => {
  it("derives a live Google lane from a fresh success and exposes the run evidence", () => {
    const r = mergeLane("live", "gsc", {
      revenueRows: [],
      signalRuns: [GSC_SUCCESS],
      nowMs: NOW_MS });
    expect(r.effective).toBe("live");
    expect(r.evidence[0]).toMatchObject({
      polarity: "supporting",
      source: "Search Console collector succeeded",
      at: GSC_SUCCESS.finishedAt,
    });
    expect(r.evidence[0]!.detail).toBe("28 daily rows · 2026-06-08 → 2026-07-05 · provisional from 2026-07-04");
  });

  it("derives working from a fresh collector success even when config still says setup", () => {
    const r = mergeLane("needs-setup", "gsc", {
      revenueRows: [],
      signalRuns: [GSC_SUCCESS],
      nowMs: NOW_MS });
    expect(r.effective).toBe("live");
    expect(r.evidence[0]!.source).toBe("Search Console collector succeeded");
  });

  it("derives DataForSEO health from all five stored report families", () => {
    const r = mergeLane("needs-setup", "dataforseo", {
      revenueRows: [],
      signalRuns: [DATAFORSEO_SUCCESS],
      nowMs: NOW_MS,
    });
    expect(r.effective).toBe("live");
    expect(r.evidence[0]).toMatchObject({
      source: "DataForSEO collector succeeded",
      detail: "5 report families · 240 rows · 2026-07-28 snapshot",
    });
  });

  it("names the monthly cap when the metered lane stopped before spending", () => {
    // A guardrail that worked reads nothing like a provider outage.
    const r = mergeLane("live", "dataforseo", {
      revenueRows: [],
      signalRuns: [
        {
          ...DATAFORSEO_SUCCESS,
          status: "error",
          errorCode: "budget_exhausted",
          errorMessage: "monthly data cap reached",
        },
      ],
      nowMs: NOW_MS,
    });
    expect(r.effective).toBe("degraded");
    expect(r.evidence[0]).toMatchObject({
      polarity: "against",
      source: "DataForSEO collector stopped at the monthly data cap",
    });
    expect(r.evidence[0]!.detail).toBe("Resumes 2026-08-01");
    expect(r.evidence[0]!.detail).not.toContain("config/");
  });

  it("refuses a stored success phrase as the reason a lane is red", () => {
    // A provider can store an HTTP-500 row whose message is its own success
    // text ("Ok."); such rows are permanent, so the read side names the code.
    const r = mergeLane("live", "dataforseo", {
      revenueRows: [],
      signalRuns: [
        {
          ...DATAFORSEO_SUCCESS,
          status: "error",
          errorCode: "dataforseo_http_500",
          errorMessage: "Ok.",
        },
      ],
      nowMs: NOW_MS,
    });
    expect(r.effective).toBe("degraded");
    expect(r.evidence[0]).toMatchObject({
      polarity: "against",
      source: "DataForSEO collector failed",
      detail: "DataForSEO returned dataforseo_http_500.",
    });
  });

  it("keeps a stored message that does name the failure", () => {
    const r = mergeLane("live", "dataforseo", {
      revenueRows: [],
      signalRuns: [
        {
          ...DATAFORSEO_SUCCESS,
          status: "error",
          errorCode: "dataforseo_http_500",
          errorMessage: "Internal Error.",
        },
      ],
      nowMs: NOW_MS,
    });
    expect(r.evidence[0]!.detail).toBe("Internal Error.");
  });

  it("names the code when the nightly archive stored a success phrase too", () => {
    const r = mergeLane("live", "gsc", {
      revenueRows: [],
      signalRuns: [GSC_SUCCESS],
      archiveRuns: [
        {
          asset: "meals.example",
          integration: "gsc",
          reportDate: "2026-07-01",
          finishedAt: new Date(NOW_MS - 3 * HOUR).toISOString(),
          status: "error",
          reports: 10,
          failedReports: 2,
          lagging: [],
          errorCode: "gsc_http_500",
          errorMessage: "OK",
        },
      ],
      nowMs: NOW_MS,
    });
    expect(r.evidence[1]!.detail).toBe("2 of 10 report families failed · Search Console returned gsc_http_500");
  });

  it("adds the nightly archive as a second evidence line without moving the lane's state", () => {
    const archived = mergeLane("live", "gsc", {
      revenueRows: [],
      signalRuns: [GSC_SUCCESS],
      archiveRuns: [
        {
          asset: "meals.example",
          integration: "gsc",
          reportDate: "2026-07-04",
          finishedAt: new Date(NOW_MS - 3 * HOUR).toISOString(),
          status: "success",
          reports: 10,
          failedReports: 0,
          lagging: [],
          errorCode: null,
          errorMessage: null,
        },
      ],
      nowMs: NOW_MS,
    });
    expect(archived.evidence).toHaveLength(2);
    expect(archived.evidence[1]).toMatchObject({
      polarity: "supporting",
      source: "Nightly archive succeeded",
      detail: "10 report families · 2026-07-04",
    });

    // The fresh 15-minute collector is the more direct observation of the
    // feed, so the lane stays working and the archive line says what broke.
    const failing = mergeLane("live", "gsc", {
      revenueRows: [],
      signalRuns: [GSC_SUCCESS],
      archiveRuns: [
        {
          asset: "meals.example",
          integration: "gsc",
          reportDate: "2026-07-01",
          finishedAt: new Date(NOW_MS - 3 * HOUR).toISOString(),
          status: "error",
          reports: 10,
          failedReports: 2,
          lagging: [],
          errorCode: "gsc_http_429",
          errorMessage: "Search Console rate-limited the archive request.",
        },
      ],
      nowMs: NOW_MS,
    });
    expect(failing.effective).toBe("live");
    expect(failing.evidence[1]).toMatchObject({
      polarity: "against",
      source: "Nightly archive failed",
    });
    expect(failing.evidence[1]!.detail).toContain("2 of 10");
  });

  it("stays quiet about the archive on a lane the operator scoped out, or one with no collector", () => {
    // A second "no archive either" line over a lane that is not collecting
    // would be noise.
    expect(
      mergeLane("needs-setup", "ga4", {
        revenueRows: [],
        signalRuns: [],
        archiveRuns: [],
        nowMs: NOW_MS,
      }).evidence,
    ).toHaveLength(1);
    expect(
      mergeLane("not-applicable", "ga4", {
        revenueRows: [],
        signalRuns: [],
        archiveRuns: [],
        nowMs: NOW_MS,
      }).evidence,
    ).toHaveLength(1);
    const gap = mergeLane("live", "gsc", {
      revenueRows: [],
      signalRuns: [GSC_SUCCESS],
      archiveRuns: [],
      nowMs: NOW_MS,
    });
    expect(gap.evidence[1]).toMatchObject({
      polarity: "against",
      source: "Nightly archive has no recent run",
      at: null,
    });
  });

  it("turns Bing green from a fresh daily run and degrades only after two daily cadences", () => {
    expect(
      mergeLane("needs-setup", "bing-webmaster", {
        revenueRows: [],
        signalRuns: [BWT_SUCCESS],
        nowMs: NOW_MS,
      }).effective,
    ).toBe("live");
    expect(
      mergeLane("live", "bing-webmaster", {
        revenueRows: [],
        signalRuns: [
          {
            ...BWT_SUCCESS,
            finishedAt: new Date(NOW_MS - 47 * HOUR).toISOString() },
        ],
        nowMs: NOW_MS }).effective,
    ).toBe("live");
    expect(
      mergeLane("live", "bing-webmaster", {
        revenueRows: [],
        signalRuns: [
          {
            ...BWT_SUCCESS,
            finishedAt: new Date(NOW_MS - 49 * HOUR).toISOString() },
        ],
        nowMs: NOW_MS }).effective,
    ).toBe("degraded");
  });

  it("renders a Google lane degraded when its latest pull errors", () => {
    const r = mergeLane("live", "gsc", {
      revenueRows: [],
      signalRuns: [
        {
          ...GSC_SUCCESS,
          status: "error",
          errorCode: "gsc_http_403",
          errorMessage: "Search Console site access denied",
        },
      ],
      nowMs: NOW_MS,
    });
    expect(r.effective).toBe("degraded");
    expect(r.evidence[0]).toMatchObject({
      polarity: "against",
      source: "Search Console collector failed",
      detail: "Search Console site access denied",
    });
  });

  it("renders a Google lane degraded after two missed 15-minute runs", () => {
    const r = mergeLane("live", "gsc", {
      revenueRows: [],
      signalRuns: [
        {
          ...GSC_SUCCESS,
          finishedAt: new Date(NOW_MS - 31 * 60_000).toISOString(),
        },
      ],
      nowMs: NOW_MS,
    });
    expect(r.effective).toBe("degraded");
    expect(r.evidence[0]).toMatchObject({
      polarity: "against",
      source: "Search Console collector is stale",
      detail: "Due every 15 min",
    });
  });

  it("renders a Google lane unconfigured when no collector run exists", () => {
    const r = mergeLane("live", "gsc", {
      revenueRows: [],
      signalRuns: [],
      nowMs: NOW_MS,
    });
    expect(r.effective).toBe("needs-setup");
    expect(r.evidence[0]!.source).toBe("Search Console collector has no recent run");
  });

  it("keeps a needs-setup revenue lane needs-setup but surfaces the manual lane", () => {
    const ev: LaneEvidence = {
      revenueRows: [{ currency: 'USD', family: "ads", source: "raptive-report", note: null, amountMinor: 49810, period: "2026-06" }],
    };
    const r = mergeLane("needs-setup", "ad-network", ev);
    expect(r.effective).toBe("needs-setup");
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0]!.polarity).toBe("supporting");
    expect(r.evidence[0]!.source).toBe("Ads revenue added by hand");
    expect(r.evidence[0]!.detail).toBe("$498.10 · latest 2026-06");
  });

  it("routes affiliate revenue to CJ by default and to Amazon when named", () => {
    expect(laneForRevenueRow("affiliate", "cj-export", null)).toBe("affiliate-cj");
    expect(laneForRevenueRow("affiliate", null, "amazon associates tag")).toBe("affiliate-amazon");
    expect(laneForRevenueRow("ads", null, null)).toBe("ad-network");
    expect(laneForRevenueRow("subs", null, null)).toBeNull();
  });

  it("never adjusts skipped / not-applicable / evidence-free needs-setup", () => {
    const withRev: LaneEvidence = {
      revenueRows: [{ currency: 'USD', family: "affiliate", source: "cj-export", note: null, amountMinor: 1000, period: "2026-06" }],
    };
    expect(mergeLane("skipped", "affiliate-cj", withRev)).toEqual({ effective: "skipped", evidence: [] });
    expect(mergeLane("not-applicable", "affiliate-cj", withRev)).toEqual({ effective: "not-applicable", evidence: [] });
    expect(mergeLane("needs-setup", "ad-network", NO_EVIDENCE)).toEqual({ effective: "needs-setup", evidence: [] });
    expect(mergeLane("live", "uptime", NO_EVIDENCE)).toEqual({ effective: "live", evidence: [] });
  });
});

describe("nightlyReportState — the derived lane, pure over store evidence", () => {
  const pull = PULL_CONFIG[0]!;

  it("live when the last accepted report is inside the nightly cadence", () => {
    const at = new Date(NOW_MS - 4 * HOUR).toISOString();
    const r = nightlyReportState(NOW_MS, at, pull);
    expect(r.effective).toBe("live");
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0]).toMatchObject({ polarity: "supporting", source: "Last nightly report accepted", at });
    expect(r.evidence[0]!.detail).toBe("");
  });

  it("degraded past 2x the cadence, with the last-accepted timestamp as the why", () => {
    const at = new Date(NOW_MS - 49 * HOUR).toISOString();
    const r = nightlyReportState(NOW_MS, at, pull);
    expect(r.effective).toBe("degraded");
    expect(r.evidence[0]).toMatchObject({ polarity: "against", at, detail: "Due daily" });
    // 48h is the boundary (2 x 24h); one hour inside it is still live.
    expect(nightlyReportState(NOW_MS, new Date(NOW_MS - 47 * HOUR).toISOString(), pull).effective).toBe("live");
  });

  // A site that has never sent a report expects none, so its lane is no to-do.
  it("not applicable when nothing ever arrived, still naming the fetch it has", () => {
    const never = nightlyReportState(NOW_MS, null, null);
    expect(never.effective).toBe("not-applicable");
    expect(never.evidence[0]!.at).toBeNull();
    expect(never.evidence[0]!.detail).toBe("No nightly fetch set up");

    const disabled = nightlyReportState(NOW_MS, null, PULL_CONFIG[2]!);
    expect(disabled.effective).toBe("not-applicable");
    expect(disabled.evidence[0]!.detail).toBe(`Nightly fetch off · ${PULL_CONFIG[2]!.url}`);

    const configured = nightlyReportState(NOW_MS, null, pull);
    expect(configured.effective).toBe("not-applicable");
    expect(configured.evidence[0]!.detail).toBe(`Fetched nightly · ${pull.url}`);
    for (const r of [never, disabled, configured]) expect(r.evidence[0]!.detail).not.toContain("config/");
  });

  it("switches to live with the first report, and to degraded when that sender stops", () => {
    expect(nightlyReportState(NOW_MS, new Date(NOW_MS - HOUR).toISOString(), null).effective).toBe("live");
    expect(nightlyReportState(NOW_MS, new Date(NOW_MS - 30 * 24 * HOUR).toISOString(), null).effective).toBe("degraded");
  });

  it("keeps a declared site Not using, whatever it has sent", () => {
    expect(nightlyReportState(NOW_MS, null, null, true).effective).toBe("skipped");
    expect(nightlyReportState(NOW_MS, new Date(NOW_MS - 72 * HOUR).toISOString(), null, true).effective).toBe("skipped");
  });
});

describe("buildCardDataSources — compact working/degraded/unconfigured inputs", () => {
  it("leads with nightly, keeps relevant setup, and omits skipped/N/A lanes", () => {
    const sources = buildCardDataSources({
      assetId: "meals.example",
      integrations: INTEGRATIONS,
      latestReportAt: new Date(NOW_MS - 4 * HOUR).toISOString(),
      pull: PULL_CONFIG[0]!,
      now: NOW,
    });
    expect(sources.map(({ id, label, state }) => ({ id, label, state }))).toEqual([
      { id: NIGHTLY_REPORT_LANE_ID, label: "Nightly report", state: "live" },
      { id: "gsc", label: "Google Search Console", state: "needs-setup" },
      // Uptime is Not set up and nothing on Integrations connects it: no slot.
    ]);
  });

  it("turns a setup-colored collector icon green from fresh success evidence", () => {
    const sources = buildCardDataSources({
      assetId: "meals.example",
      integrations: INTEGRATIONS,
      latestReportAt: null,
      pull: null,
      now: NOW,
      signalRuns: [GSC_SUCCESS],
    });
    expect(sources.find((source) => source.id === "gsc")).toMatchObject({
      state: "live",
      observedAt: GSC_SUCCESS.finishedAt,
    });
  });

  it("turns the Bing card icon green from the latest successful daily pull", () => {
    const withBing: IntegrationsConfig = {
      ...INTEGRATIONS,
      catalog: [
        ...INTEGRATIONS.catalog,
        {
          id: "bing-webmaster",
          label: "Bing Webmaster Tools API",
          docRef: "docs/11-integrations.md#the-catalog",
          credential: "shared",
        },
      ],
      assets: {
        ...INTEGRATIONS.assets,
        "meals.example": {
          ...INTEGRATIONS.assets["meals.example"],
          "bing-webmaster": cell("needs-setup"),
        },
      },
    };
    const sources = buildCardDataSources({
      assetId: "meals.example",
      integrations: withBing,
      latestReportAt: null,
      pull: null,
      now: NOW,
      signalRuns: [BWT_SUCCESS],
    });
    expect(sources.find((source) => source.id === "bing-webmaster")).toMatchObject({
      state: "live",
      observedAt: BWT_SUCCESS.finishedAt,
    });
  });

  it("uses the same effective-state adjustment as the full register", () => {
    const sources = buildCardDataSources({
      assetId: "nosh.example",
      integrations: INTEGRATIONS,
      latestReportAt: new Date(NOW_MS - 72 * HOUR).toISOString(),
      pull: PULL_CONFIG[1]!,
      now: NOW,
      homeCheck: { observedAt: new Date(NOW_MS - 20 * 60_000).toISOString(), status: "error", httpStatus: 503, egressDown: false },
    });
    expect(sources.map(({ id, label, state }) => ({ id, label, state }))).toEqual([
      { id: NIGHTLY_REPORT_LANE_ID, label: "Nightly report", state: "degraded" },
      { id: "gsc", label: "Google Search Console", state: "needs-setup" },
      { id: "uptime", label: "Uptime / monitoring", state: "degraded" },
    ]);
  });
});

describe("recentSincePeriod", () => {
  it("returns now − 2 months as a YYYY-MM cutoff (3-month inclusive window)", () => {
    expect(recentSincePeriod(new Date("2026-07-05T12:00:00Z"))).toBe("2026-05");
    expect(recentSincePeriod(new Date("2026-01-15T12:00:00Z"))).toBe("2025-11");
  });
});

describe("buildIntegrationsMatrix", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seed(ctx);
  });

  it("returns assets in register (seed) order as columns, with is-os + display names", async () => {
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    expect(m.assets.map((a) => a.id)).toEqual([
      "root-os",
      "meals.example",
      "nosh.example",
      "areas.example",
      "fees.example",
    ]);
    expect(m.assets[0]!.isOs).toBe(true);
    expect(m.assets[0]!.displayName).toBe("NoticeOS");
    expect(m.assets[1]!.displayName).toBe("Meal Planner");
    expect(JSON.stringify(m)).not.toContain("ReindexOS");
  });

  it("aligns each asset's cells with the catalog order (cells[a][i] ↔ catalog[i])", async () => {
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    expect(m.catalog.map((c) => c.id)).toEqual(["gsc", "uptime", "ad-network", "affiliate-cj", "affiliate-amazon"]);
    const meals = m.cells["meals.example"]!;
    expect(meals).toHaveLength(5);
    expect(meals.map((c) => c.laneId)).toEqual(m.catalog.map((c) => c.id));
  });

  it("merges store evidence: nom uptime degrades, meals revenue lanes gain supporting notes", async () => {
    await seedRevenue(ctx);
    await insertNomDown(ctx);
    await seedReports(ctx);
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));

    const nomUptime = m.cells["nosh.example"]![1]!;
    expect(nomUptime.declared).toBe("live");
    expect(nomUptime.effective).toBe("degraded");
    // Its own check, not the overdue report.
    expect(nomUptime.evidence).toEqual([{
      polarity: "against", source: "Home page did not answer", detail: "HTTP 503",
      at: new Date(NOW_MS - 20 * 60_000).toISOString(),
    }]);

    const nomGsc = m.cells["nosh.example"]![0]!;
    expect(nomGsc.effective).toBe("needs-setup");
    expect(nomGsc.evidence[0]).toMatchObject({
      polarity: "against",
      source: "Search Console collector has no recent run",
      at: null,
    });

    const myAd = m.cells["meals.example"]![2]!;
    expect(myAd.effective).toBe("needs-setup");
    expect(myAd.evidence[0]!.polarity).toBe("supporting");

    const myCj = m.cells["meals.example"]![3]!;
    expect(myCj.evidence[0]!.polarity).toBe("supporting");

    const myAmazon = m.cells["meals.example"]![4]!;
    expect(myAmazon.declared).toBe("skipped");
    expect(myAmazon.evidence).toEqual([]);
  });

  // The latest-attempt reads stop at SIGNAL_EVIDENCE_FLOOR_DAYS so their cost
  // stops tracking an append-only log. A lane the floor drops must stay
  // visible and say why; one that quietly left the matrix would read as an
  // asset that never wired the lane.
  const daysBeforeNow = (days: number) =>
    new Date(NOW_MS - days * 24 * HOUR).toISOString();

  it("keeps a lane dormant for over a year in the matrix, its old failure intact", async () => {
    // Integration health uses the latest attempt, so an old failure has to
    // stay visible. A year of silence is inside the floor.
    await insertSignalRun(ctx, "gsc-dormant", "meals.example", "gsc", daysBeforeNow(399));
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));

    const gsc = m.cells["meals.example"]![0]!;
    expect(gsc.laneId).toBe("gsc");
    expect(gsc.effective).toBe("degraded");
    expect(gsc.evidence[0]).toMatchObject({
      polarity: "against",
      source: "Search Console collector failed",
      detail: "The service account lost access to the asset.",
      at: daysBeforeNow(399),
    });
  });

  it("names the floor when a lane's last attempt predates it, rather than dropping the lane", async () => {
    await insertSignalRun(ctx, "gsc-ancient", "meals.example", "gsc", daysBeforeNow(401));
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));

    expect(m.cells["meals.example"]).toHaveLength(m.catalog.length);
    const gsc = m.cells["meals.example"]![0]!;
    expect(gsc.laneId).toBe("gsc");
    expect(gsc.evidence[0]).toMatchObject({
      polarity: "against",
      source: "Search Console collector has no recent run",
      detail: `0 runs in ${SIGNAL_EVIDENCE_FLOOR_DAYS} days`,
      at: null,
    });
  });

  it("states the manual lane's total in exact cents", async () => {
    // The evidence line is added in `amount_minor`: 498.10 + 574.15 + 271.20
    // = $1,343.45.
    await seedRevenue(ctx);
    await insertRevenue(ctx, 20, "meals.example", "2026-06", "ads", 574.15, "raptive-report");
    await insertRevenue(ctx, 21, "meals.example", "2026-06", "ads", 271.2, "raptive-report");

    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    const myAd = m.cells["meals.example"]![2]!;
    expect(myAd.evidence[0]!.detail).toContain("$1,343.45");
  });

  it("excludes out-of-window revenue from supporting evidence", async () => {
    await seedRevenue(ctx);
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    const areasAd = m.cells["areas.example"]![2]!;
    expect(areasAd.effective).toBe("needs-setup");
    expect(areasAd.evidence).toEqual([]); // the 2026-01 row is older than the cutoff
  });

  it("summarizes by EFFECTIVE status with a needs-attention roll-up", async () => {
    await seedRevenue(ctx);
    await insertNomDown(ctx);
    await seedReports(ctx);
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    // 35 cells: 5 assets × (5 catalog lanes + the two derived rows, the
    // nightly report and the OS's own egress).
    expect(m.summary.total).toBe(35);
    const sum =
      m.summary.counts.live +
      m.summary.counts.degraded +
      m.summary.counts["needs-setup"] +
      m.summary.counts.skipped +
      m.summary.counts["not-applicable"];
    expect(sum).toBe(35);
    // No declared lane is live (nosh's uptime degraded); the three live cells
    // are derived: root-os and meals reported inside the cadence, and no lane
    // run has ever had to check whether the OS could get out.
    expect(m.summary.counts.live).toBe(3);
    // nosh uptime (declared) + nosh's stale nightly report (derived).
    expect(m.summary.counts.degraded).toBe(2);
    expect(m.summary.needsAttention).toBe(m.summary.counts["needs-setup"] + m.summary.counts.degraded);
  });

  it("leads with the DERIVED nightly-report row: live / degraded / not applicable from the store", async () => {
    await seedReports(ctx);
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));

    expect(m.derivedLanes.map((l) => l.catalog.id)).toEqual([
      EGRESS_LANE_ID,
      NIGHTLY_REPORT_LANE_ID,
    ]);
    const lane = m.derivedLanes.find((l) => l.catalog.id === NIGHTLY_REPORT_LANE_ID)!;
    expect(lane.catalog.id).toBe(NIGHTLY_REPORT_LANE_ID);
    expect(lane.catalog.derived).toBe(true);
    // Not a catalog row, so its state can never come from the register file.
    expect(lane.catalog).toMatchObject({ usage: { cost: "free" as const }, onFailure: "raises-alert" });
    expect(lane.catalog).not.toHaveProperty("whatLiveMeans");
    expect(m.catalog.map((c) => c.id)).not.toContain(NIGHTLY_REPORT_LANE_ID);
    expect(Object.keys(lane.cells)).toEqual(m.assets.map((a) => a.id));

    expect(lane.cells["root-os"]!.effective).toBe("live");
    expect(lane.cells["meals.example"]!.effective).toBe("live");
    expect(lane.cells["nosh.example"]!.effective).toBe("degraded");
    // Never sent a report, so none is expected.
    expect(lane.cells["areas.example"]!.effective).toBe("not-applicable");
    expect(lane.cells["fees.example"]!.effective).toBe("not-applicable");

    // The evidence is the last accepted report: nosh's newest, not its oldest.
    expect(lane.cells["nosh.example"]!.evidence[0]!.at).toBe(new Date(NOW_MS - 71 * HOUR).toISOString());
    // areas is in config/pull.json but switched off; fees.example is not in it at all.
    expect(lane.cells["areas.example"]!.evidence[0]!.detail).toMatch(/^Nightly fetch off · /);
    expect(lane.cells["fees.example"]!.evidence[0]!.detail).toBe("No nightly fetch set up");
  });

  it("counts a live derived cell as live, never as a lane wanting attention", async () => {
    await seedReports(ctx);
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    const nightly = m.derivedLanes.find((l) => l.catalog.id === NIGHTLY_REPORT_LANE_ID)!;
    const derivedCells = Object.values(nightly.cells);
    const egressCells = Object.values(
      m.derivedLanes.find((l) => l.catalog.id === EGRESS_LANE_ID)!.cells,
    );
    const declaredCells = Object.values(m.cells).flat();

    expect(m.summary.total).toBe(
      declaredCells.length + derivedCells.length + egressCells.length,
    );
    // needsAttention counts the 1 unhealthy derived cell (nosh degraded) and
    // not the 2 live ones, nor the sites that never sent a report (areas,
    // fees.example).
    const derivedAttention = derivedCells.filter(
      (c) => c.effective === "needs-setup" || c.effective === "degraded",
    ).length;
    const declaredAttention = declaredCells.filter(
      (c) => c.effective === "needs-setup" || c.effective === "degraded",
    ).length;
    expect(derivedAttention).toBe(1);
    // The L0 row adds nothing to attention: with no open flag and no probe on
    // record it is live, and its cells on the content assets are N/A.
    expect(
      egressCells.filter(
        (c) => c.effective === "needs-setup" || c.effective === "degraded",
      ),
    ).toHaveLength(0);
    expect(m.summary.needsAttention).toBe(declaredAttention + derivedAttention);
    expect(m.sharedCredential).toEqual({ lanes: 3, cells: 9 });
  });

  it("attaches each lane's usage and failure facts to catalog rows", async () => {
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    const clarityless = m.catalog.find((c) => c.id === "uptime")!;
    expect(clarityless.usage).toEqual({ cost: "free" });
    expect(clarityless.onFailure).toBe("raises-alert");
    expect(clarityless).not.toHaveProperty("whatLiveMeans");
  });

  it("declares a layer on every lane it renders, catalog and derived alike", async () => {
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    for (const row of [...m.catalog, ...m.derivedLanes.map((l) => l.catalog)]) {
      expect(INTEGRATION_LAYERS, `layer for ${row.id}`).toContain(row.layer);
    }
    // The three tiers the surface groups by: the OS's own connection, the
    // provider accounts, and the asset's own plumbing.
    expect(m.derivedLanes.find((l) => l.catalog.id === EGRESS_LANE_ID)!.catalog.layer).toBe("os");
    expect(
      m.derivedLanes.find((l) => l.catalog.id === NIGHTLY_REPORT_LANE_ID)!.catalog.layer,
    ).toBe("property");
    // The test register carries no `layer` key, so these fall through to the
    // conservative default.
    expect(m.catalog.find((c) => c.id === "gsc")!.layer).toBe("property");
  });
});

// Each data source's day is recorded by the hourly tick's Tower step, never
// by a page load.
describe("the Source history, recorded by the hourly tick", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seed(ctx);
  });
  const stored = async () => (ctx.call).read((tx) =>
    tx.query<{ source: string; day: string }>('SELECT source, day FROM noticeos.connection_daily_counts ORDER BY source COLLATE "C"'));

  it("building the matrix for a page writes nothing", async () => {
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    expect(await stored()).toEqual([]);
    expect(m.history).toMatchObject({ days: 0, sources: [] });
  });

  it("the step builds the page's matrix and writes one row per data source, which the page then reads", async () => {
    await seedReports(ctx);
    const page = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    const lanes = page.catalog.length + page.derivedLanes.length;
    expect(await recordTodaysSourceHistory(ctx.call, deps(INTEGRATIONS))).toEqual({ outcome: "ran", written: lanes });
    expect(await stored()).toHaveLength(lanes);
    expect(new Set((await stored()).map((row) => row.day))).toEqual(new Set(["2026-07-05"]));

    const after = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    expect(after.history.days).toBe(1);
    for (const state of ["live", "degraded", "needs-setup", "skipped", "not-applicable"] as const) {
      expect(after.history.states[state].at(-1)!.v, state).toBe(page.summary.counts[state]);
    }
    const { history: _history, ...rest } = after;
    const { history: _before, ...pageRest } = page;
    expect(rest).toEqual(pageRest);
  });

  it("takes the matrix's inputs from the resolved settings, and nothing else", () => {
    const settings = { ...deps(INTEGRATIONS), noNightlyReport: ["areas.example"], osTimeZone: "UTC", entities: [] };
    expect(integrationsDeps(settings, NOW)).toEqual({ ...deps(INTEGRATIONS), noNightlyReport: ["areas.example"], now: NOW });
  });
});

// L0, the OS's own egress: every one of these is a read over what
// workers/ingest/src/egress.ts actually stores. The copy is asserted where the
// sentence is the deliverable.
describe("the L0 egress lane", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seed(ctx);
  });

  const lane = async () =>
    (await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS))).derivedLanes.find(
      (l) => l.catalog.id === EGRESS_LANE_ID,
    )!;

  const OUTAGE_INPUTS = {
    rule: "os-egress-down",
    beacons: [
      { url: "https://www.cloudflare.com/cdn-cgi/trace", error: "internal error; reference = 9f2a" },
      { url: "https://www.google.com/generate_204", error: "internal error; reference = 3b71" },
    ],
    unmeasuredAssets: ["meals.example", "nosh.example"],
    failureCount: 3,
    lastFailedAt: "2026-07-05T04:00:00.000Z",
    evaluatedAt: "2026-07-05T04:00:00.000Z",
  };

  it("goes degraded on an OPEN os-egress-down flag, with the beacons verbatim", async () => {
    await insertEgressFlag(ctx, "root-os", "2026-07-04T02:30:00.000Z", OUTAGE_INPUTS);
    const l = await lane();
    const cell = l.cells["root-os"]!;

    expect(cell.effective).toBe("degraded");
    expect(cell.evidence[0]).toMatchObject({
      polarity: "against",
      source: "Reference sites that did not answer",
      // Dated from the first down verdict, so the row ages from when the
      // connection went rather than from the last time the gate re-asked.
      at: "2026-07-04T02:30:00.000Z",
    });
    // Verbatim: two unrelated sites failed exactly the way the assets did.
    expect(cell.evidence[0]!.detail).toContain("www.cloudflare.com/cdn-cgi/trace: internal error; reference = 9f2a");
    expect(cell.evidence[0]!.detail).toContain("www.google.com/generate_204: internal error; reference = 3b71");
    expect(cell.evidence[1]).toMatchObject({
      polarity: "against",
      source: "Sites not measured",
      detail: "meals.example · nosh.example",
    });
  });

  it("goes back to LIVE once the connection answers, while the alert waits on re-collection", async () => {
    // The flag outlives the outage until every collector that missed an asset
    // has re-run; the uplink is this row's subject, and the uplink is fine.
    await insertEgressFlag(ctx, "root-os", "2026-07-04T02:30:00.000Z", {
      ...OUTAGE_INPUTS,
      unmeasuredAssets: ["nosh.example"],
      connectionBackAt: "2026-07-05T12:15:00.000Z",
    });
    const cell = (await lane()).cells["root-os"]!;

    expect(cell.effective).toBe("live");
    expect(cell.evidence).toHaveLength(1);
    expect(cell.evidence[0]).toMatchObject({
      polarity: "supporting",
      source: "Connection answered again",
      at: "2026-07-05T12:15:00.000Z",
    });
    expect(cell.evidence[0]!.detail).toBe("Waiting on nosh.example");
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    expect(matrixUnblockers(m).some((u) => u.key === EGRESS_LANE_ID)).toBe(false);
  });

  it("names this machine's internet connection as the thing to go and check, not a credential", async () => {
    await insertEgressFlag(ctx, "root-os", "2026-07-04T02:30:00.000Z", OUTAGE_INPUTS);
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    const top = matrixUnblockers(m)[0]!;

    expect(top.kind).toBe("degraded");
    expect(top.key).toBe(EGRESS_LANE_ID);
    expect(top.action).toBe("Check this machine's internet connection");
    expect(top.action).not.toContain("credential");
    expect(top).not.toHaveProperty("detail");
  });

  it("retains the raw LIVE state without claiming absent probes verify connectivity", async () => {
    const cell = (await lane()).cells["root-os"]!;
    expect(cell.effective).toBe("live");
    expect(cell.evidence).toHaveLength(1);
    expect(cell.evidence[0]).toMatchObject({
      polarity: "supporting",
      source: "No internet check recorded",
      // No probe means no timestamp to age: there is no reading.
      detail: "",
      at: null,
    });
    expect(cell.evidence[0]!.verification).toBeUndefined();
  });

  it("stays LIVE on an old probe round and reports what it found", async () => {
    // Ten days is far past every cadence, but it is not staleness here: the
    // gate probes only after a fetch already failed, so an old row means
    // nothing has needed to ask since.
    await insertEgressCheck(ctx, new Date(NOW_MS - 10 * 24 * HOUR).toISOString(), 1, [
      { url: "https://www.cloudflare.com/cdn-cgi/trace", status: 200 },
    ]);
    const cell = (await lane()).cells["root-os"]!;

    expect(cell.effective).toBe("live");
    expect(cell.evidence[0]).toMatchObject({
      polarity: "supporting",
      source: "Internet check passed",
      at: new Date(NOW_MS - 10 * 24 * HOUR).toISOString(),
    });
    expect(cell.evidence[0]!.detail).toContain("www.cloudflare.com/cdn-cgi/trace: HTTP 200");
  });

  it("reads the NEWEST round, and says so plainly when that round was down", async () => {
    // A down round with no open flag: the gate recorded the verdict and the
    // flag was closed afterwards. The lane is not red, but it does not
    // pretend the round went well.
    await insertEgressCheck(ctx, "2026-07-01T02:30:00.000Z", 1, [
      { url: "https://www.cloudflare.com/cdn-cgi/trace", status: 200 },
    ]);
    await insertEgressCheck(ctx, "2026-07-04T02:30:00.000Z", 0, [
      { url: "https://www.cloudflare.com/cdn-cgi/trace", status: null, error: "internal error" },
      { url: "https://www.google.com/generate_204", status: null, error: "internal error" },
    ]);
    const cell = (await lane()).cells["root-os"]!;

    expect(cell.effective).toBe("live");
    expect(cell.evidence[0]!.source).toBe("Internet check failed");
    expect(cell.evidence[0]!.at).toBe("2026-07-04T02:30:00.000Z");
    expect(cell.evidence[0]!.detail).toContain("www.google.com/generate_204: internal error");
  });

  it("reads the newest round down the (workspace, observed_at) index", async () => {
    const plan = await (ctx.call).read(async (tx) => {
      // An empty table is cheapest to scan; forbidding that shows the plan the
      // index offers once rounds pile up.
      await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
      return tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${LATEST_EGRESS_CHECK_SQL}`);
    });
    expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toMatch(/Index Scan Backward using egress_checks_observed/);
  });

  it("goes back to live once the gate retracts the flag", async () => {
    await insertEgressFlag(
      ctx,
      "root-os",
      "2026-07-04T02:30:00.000Z",
      OUTAGE_INPUTS,
      "2026-07-04T04:00:00.000Z",
    );
    await insertEgressCheck(ctx, "2026-07-04T04:00:00.000Z", 1, [
      { url: "https://www.cloudflare.com/cdn-cgi/trace", status: 200 },
    ]);
    const cell = (await lane()).cells["root-os"]!;

    expect(cell.effective).toBe("live");
    expect(cell.evidence[0]!.source).toBe("Internet check passed");
  });

  it("is the SYSTEM's lane: a content asset carries the scope rule, not a state", async () => {
    await insertEgressFlag(ctx, "root-os", "2026-07-04T02:30:00.000Z", OUTAGE_INPUTS);
    const l = await lane();

    expect(Object.keys(l.cells)).toEqual([
      "root-os",
      "meals.example",
      "nosh.example",
      "areas.example",
      "fees.example",
    ]);
    // Only asset #0 has an uplink of the OS's to report on.
    for (const assetId of ["meals.example", "nosh.example", "areas.example", "fees.example"]) {
      expect(l.cells[assetId]!.effective).toBe("not-applicable");
      expect(l.cells[assetId]!.evidence).toEqual([]);
    }
    expect(l.catalog.scope).toBe("portfolio");
    // The lane states its lazy gate as facts, so nobody reads an empty
    // egress_checks table as a lane that stopped reporting.
    expect(l.catalog.usage).toEqual({ cost: "free", trigger: "failed-fetch", limit: "1 check per 5 min" });
    expect(l.catalog.onFailure).toBe("pauses-asset-checks");
  });

  it("degrades to a lane that says less when the stored evidence is unreadable", async () => {
    // rule_inputs is written by another Worker. A truncated or re-shaped
    // payload must cost the operator a sentence, never a page.
    expect(
      egressState({ firedAt: "2026-07-04T02:30:00.000Z", ruleInputs: "{not json" }, null),
    ).toEqual({
      effective: "degraded",
      evidence: [
        {
          polarity: "against",
          source: "Reference sites that did not answer",
          detail: "",
          at: "2026-07-04T02:30:00.000Z",
        },
      ],
    });
  });
});

describe("what to unblock next", () => {
  // The matrix answers "what state is everything in"; this answers "what
  // should I fix first" in actions, because one credential can unlock nine cells.
  const catalog = [
    { id: "gsc", label: "Google Search Console", docRef: "docs/11", scope: "property" as const, layer: "provider" as const, usage: { cost: "free" as const }, onFailure: "keeps-last-data" as const, credential: "shared" as const, derived: false },
    { id: "clarity", label: "Microsoft Clarity", docRef: "docs/11", scope: "property" as const, layer: "provider" as const, usage: { cost: "free" as const }, onFailure: "keeps-last-data" as const, credential: "per-property" as const, derived: false },
    { id: "uptime", label: "Uptime", docRef: "docs/11", scope: "both" as const, layer: "provider" as const, usage: { cost: "free" as const }, onFailure: "keeps-last-data" as const, credential: "shared" as const, derived: false },
    { id: "dataforseo", label: "DataForSEO", docRef: "docs/11", scope: "property" as const, layer: "provider" as const, usage: { cost: "free" as const }, onFailure: "keeps-last-data" as const, credential: "shared" as const, derived: false },
  ];
  const assets = [
    { id: "meals.example", displayName: "Meal Planner", isOs: false },
    { id: "nosh.example", displayName: "Nosh", isOs: false },
  ];
  const at = (assetId: string, laneId: string, effective: string) => ({
    assetId, laneId, effective: effective as never, evidence: [],
  });

  it("groups a shared credential into ONE action naming every asset it unlocks", () => {
    const list = unblockers({
      catalog,
      assets,
      cells: {
        "meals.example": [at("meals.example", "gsc", "needs-setup")],
        "nosh.example": [at("nosh.example", "gsc", "needs-setup")],
      },
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: "shared-credential",
      key: "gsc",
      action: "Connect Google Search Console once",
      cells: 2,
    });
    expect(list[0]!.unlocks).toEqual(["Meal Planner", "Nosh"]);
  });

  it("puts a regression first, then leverage, then the tail", () => {
    const list = unblockers({
      catalog,
      assets,
      cells: {
        "meals.example": [
          at("meals.example", "gsc", "needs-setup"),
          at("meals.example", "clarity", "needs-setup"),
          at("meals.example", "uptime", "live"),
        ],
        "nosh.example": [
          at("nosh.example", "gsc", "needs-setup"),
          at("nosh.example", "clarity", "needs-setup"),
          at("nosh.example", "uptime", "degraded"),
        ],
      },
    });
    expect(list.map((u) => u.kind)).toEqual([
      "degraded",
      "shared-credential",
      "property-setup",
      "property-setup",
    ]);
    expect(list[0]).toMatchObject({ key: "uptime", action: "Site down", cells: 1 });
    // A per-property install is grouped by the asset, the unit of the visit,
    // and names the lanes.
    expect(list[2]).toMatchObject({ kind: "property-setup", key: "meals.example", cells: 1 });
    expect(list[2]!.unlocks).toEqual(["Microsoft Clarity"]);
  });

  /** A source no provider card on Integrations connects is no to-do while it
   * is only Not set up; one in use is still listed. */
  it("offers a source only when something on Integrations connects it, or it is in use", () => {
    expect(withoutConnectPath(at("meals.example", "uptime", "needs-setup"))).toBe(true);
    expect(withoutConnectPath(at("meals.example", "uptime", "degraded"))).toBe(false);
    expect(withoutConnectPath(at("meals.example", "uptime", "skipped"))).toBe(false);
    expect(withoutConnectPath(at("meals.example", "gsc", "needs-setup"))).toBe(false);
    expect(withoutConnectPath(at("meals.example", "clarity", "needs-setup"))).toBe(false);
    expect(unusedWithoutConnectPath(at("meals.example", "uptime", "needs-setup"))).toBe(true);
    expect(unusedWithoutConnectPath({
      ...at("meals.example", "uptime", "needs-setup"),
      evidence: [{ polarity: "supporting", source: "Affiliate revenue added by hand", detail: "$12.00", at: null }],
    })).toBe(false);

    const list = unblockers({
      catalog,
      assets,
      cells: {
        "meals.example": [at("meals.example", "gsc", "needs-setup"), at("meals.example", "uptime", "needs-setup")],
        "nosh.example": [at("nosh.example", "gsc", "needs-setup"), at("nosh.example", "uptime", "needs-setup")],
      },
    });
    expect(list.map((u) => u.key)).toEqual(["gsc"]);
  });

  it("says nothing at all when nothing is blocked", () => {
    expect(
      unblockers({
        catalog,
        assets,
        cells: {
          "meals.example": [at("meals.example", "gsc", "live")],
          "nosh.example": [at("nosh.example", "clarity", "not-applicable"), at("nosh.example", "gsc", "skipped")],
        },
      }),
    ).toEqual([]);
  });

  it("ranks the bigger lever first inside a kind", () => {
    const list = unblockers({
      catalog,
      assets,
      cells: {
        "meals.example": [at("meals.example", "gsc", "needs-setup"), at("meals.example", "dataforseo", "needs-setup")],
        "nosh.example": [at("nosh.example", "gsc", "needs-setup")],
      },
    });
    expect(list.map((u) => [u.key, u.cells])).toEqual([["gsc", 2], ["dataforseo", 1]]);
  });
  // What the committed register reads into is a seed check, in
  // integrations-seed.test.ts.
});

describe("credential scope (shared vs per-property)", () => {
  let ctx: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seed(ctx);
  });

  it("passes the credential scope through to catalog rows, and none of the register's prose", async () => {
    // A stored catalog may still carry the retired prose until its changeset is
    // applied; no row renders it.
    const legacy = INTEGRATIONS.catalog.map((row) => ({
      ...row, liveMeans: "legacy", credentialNote: "legacy", perProperty: "legacy",
    }));
    const m = await buildIntegrationsMatrix(ctx.call, deps({ ...INTEGRATIONS, catalog: legacy }));
    const gsc = m.catalog.find((c) => c.id === "gsc")!;
    expect(gsc.credential).toBe("shared");
    expect(gsc).not.toHaveProperty("liveMeans");
    expect(gsc).not.toHaveProperty("credentialNote");
    expect(gsc).not.toHaveProperty("perProperty");
    const ad = m.catalog.find((c) => c.id === "ad-network")!;
    expect(ad.credential).toBe("per-property");
  });

  it("computes the shared-credential insight: M lanes unlock K needs-setup cells", async () => {
    const m = await buildIntegrationsMatrix(ctx.call, deps(INTEGRATIONS));
    // shared lanes with ≥1 needs-setup: gsc(3), uptime(3), affiliate-cj(3);
    // amazon has 0. ad-network is per-property, so excluded from the insight.
    expect(m.sharedCredential).toEqual({ lanes: 3, cells: 9 });
  });

  it("sharedCredentialInsight is pure: excludes per-property lanes and only counts effective needs-setup", () => {
    const catalog = [
      { id: "a", label: "A", docRef: "", scope: "property" as const, layer: "provider" as const, usage: { cost: "free" as const }, onFailure: "keeps-last-data" as const, credential: "shared" as const, derived: false },
      { id: "b", label: "B", docRef: "", scope: "property" as const, layer: "property" as const, usage: { cost: "free" as const }, onFailure: "keeps-last-data" as const, credential: "per-property" as const, derived: false },
    ];
    const cell = (laneId: string, effective: string) => ({
      assetId: "x", laneId, declared: "needs-setup" as never, effective: effective as never, evidence: [], note: "", ref: null, since: "",
    });
    const cells = {
      x: [cell("a", "needs-setup"), cell("b", "needs-setup")],
      y: [cell("a", "needs-setup"), cell("b", "needs-setup")],
      z: [cell("a", "degraded"), cell("b", "needs-setup")], // a on z is degraded, not counted
    };
    // lane a (shared): x + y needs-setup = 2 cells, 1 lane. lane b (per-property) excluded.
    expect(sharedCredentialInsight(catalog, cells)).toEqual({ lanes: 1, cells: 2 });
  });
});

// A full register, frozen: test/fixture-config/integrations.json, never the
// checkout's config/. The checks of the committed file live in
// integrations-seed.test.ts.
describe("a full register renders completely", () => {
  const fullRegister = structuredClone(frozenRegister) as IntegrationsConfig;

  it("puts the L0 egress row on the seeded OS asset and nowhere else", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    const m = await buildIntegrationsMatrix(ctx.call, deps(fullRegister));
    const egress = m.derivedLanes.find((l) => l.catalog.id === EGRESS_LANE_ID)!;

    // The OS row is read out of the store (`assets.is_os`), never written down.
    expect(egress.cells["root-os"]!.effective).toBe("live");
    for (const asset of m.assets.filter((a) => !a.isOs)) {
      expect(egress.cells[asset.id]!.effective).toBe("not-applicable");
    }
  });

  // The committed register's own checks are in integrations-seed.test.ts.
  it("names the assets owing an entry the moment a data source is added", async () => {
    // One more catalog row, added the way /settings adds one: declared, and
    // given to nobody.
    const withNewSource: IntegrationsConfig = {
      ...fullRegister,
      catalog: [
        ...fullRegister.catalog,
        {
          id: "affiliate-impact",
          label: "Impact",
          scope: "property",
          layer: "provider",
          credential: "shared",
          docRef: "docs/11-integrations.md",
        },
      ],
    };
    const ctx = await createTestStore();
    await seedAssets(ctx);
    const m = await buildIntegrationsMatrix(ctx.call, deps(withNewSource));

    expect(m.undeclared).toHaveLength(1);
    const gap = m.undeclared[0]!;
    expect(gap.laneId).toBe("affiliate-impact");
    expect(gap.label).toBe("Impact");
    // Every site but the OS, which the scope rule already answers for a
    // property source: a derived cell is never a gap.
    expect(gap.assets).toEqual(m.assets.filter((a) => !a.isOs).map((a) => a.id));
    expect(gap.assets).not.toContain("root-os");
  });

  it("counts a portfolio source against the OS and an asset with no entry at all", () => {
    // The two shapes the file can be short in: a source only the OS can
    // carry, and an asset the wizard filed into the store but not into this file.
    const catalog = [
      { id: "discord-webhooks", label: "Discord", scope: "portfolio" as const },
      { id: "ga4", label: "GA4", scope: "property" as const },
    ];
    const assets = [
      { id: "root-os", isOs: true },
      { id: "meals.example", isOs: false },
      { id: "brandnew.test", isOs: false },
    ];
    expect(
      undeclaredLanes(catalog, assets, { "meals.example": { ga4: { status: "live" } } }),
    ).toEqual([
      { laneId: "discord-webhooks", label: "Discord", assets: ["root-os"] },
      { laneId: "ga4", label: "GA4", assets: ["brandnew.test"] },
    ]);
  });

  it("computes shared-credential setup from effective evidence, not configured health claims", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    const m = await buildIntegrationsMatrix(ctx.call, deps(fullRegister));
    // The fixture has no signal_runs, so collector-backed lanes render
    // unconfigured even when the file records prior proof.
    expect(m.sharedCredential).toEqual({ lanes: 9, cells: 42 });
    // 58 before PostHog, plus its collector-backed cell on each of the five
    // seeded content assets, less the nightly-report cell of the six sites
    // with no report in it.
    expect(m.summary.counts["needs-setup"]).toBe(57);
    expect(m.summary.counts.degraded).toBe(0);
    // The one live cell is L0: no lane run in this fixture ever had to check
    // whether the OS could reach the internet.
    expect(m.summary.counts.live).toBe(1);
  });

  /** One successful archive manifest, parameterized on the fields these tests
   * vary: who, which provider/report, when it was requested, what it cost. */
  async function insertDump(
    ctx: TestStore,
    id: string,
    asset: string,
    integration: string,
    report: string,
    reportDate: string,
    requestedAt: string,
    costUsd: number,
  ) {
    await writeArchiveRun(ctx.call, {
      id, asset, integration, report, credential_ref: "cred", report_date: reportDate,
      requested_at: requestedAt, finished_at: requestedAt, provider_rows: 10, request_count: 1,
      object_key: `signals/${id}`, object_bytes: 100, provider_cost_usd: costUsd,
    });
  }

  it("sums this UTC month's metered spend against the portfolio cap", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    // Two calls this month, one last month, and one GA4 archive that costs
    // nothing: only the first two may reach the meter.
    await insertDump(ctx, "dfs-jul-1", "meals.example", "dataforseo", "ranked-keywords", "2026-07-05", "2026-07-05T10:00:00.000Z", 1.25);
    await insertDump(ctx, "dfs-jul-2", "nosh.example", "dataforseo", "backlinks-summary", "2026-07-05", "2026-07-05T10:05:00.000Z", 0.75);
    await insertDump(ctx, "dfs-jun", "meals.example", "dataforseo", "ranked-keywords", "2026-06-28", "2026-06-28T10:00:00.000Z", 4);
    await insertDump(ctx, "ga4-jul", "meals.example", "ga4", "daily-traffic", "2026-07-05", "2026-07-05T12:15:00.000Z", 0);

    const m = await buildIntegrationsMatrix(ctx.call, deps(fullRegister));
    expect(m.dataSpend).toEqual({
      period: "2026-07",
      spentUsd: 2, unknownPrices: 0,
      capUsd: 25,
      unattributedUsd: 0, unattributedUnknownPrices: 0,
      byAsset: [
        { asset: "meals.example", spentUsd: 1.25, unknownPrices: 0 },
        { asset: "nosh.example", spentUsd: 0.75, unknownPrices: 0 },
      ],
    });
  });

  it("says WHICH asset the month's data budget went on", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    await insertDump(ctx, "dfs-a", "nosh.example", "dataforseo", "ranked-keywords", "2026-07-05", "2026-07-05T10:00:00.000Z", 0.4);
    await insertDump(ctx, "dfs-b", "meals.example", "dataforseo", "ranked-keywords", "2026-07-05", "2026-07-05T10:01:00.000Z", 1.1);
    await insertDump(ctx, "dfs-c", "meals.example", "dataforseo", "serp-panel", "2026-07-05", "2026-07-05T10:02:00.000Z", 2.35);
    await insertDump(ctx, "dfs-jun", "nosh.example", "dataforseo", "ranked-keywords", "2026-06-28", "2026-06-28T10:00:00.000Z", 9);
    await insertDump(ctx, "ga4-jul", "areas.example", "ga4", "daily-traffic", "2026-07-05", "2026-07-05T12:15:00.000Z", 0);

    const spend = (await buildIntegrationsMatrix(ctx.call, deps(fullRegister))).dataSpend;
    expect(spend.byAsset).toEqual([
      { asset: "meals.example", spentUsd: 3.45, unknownPrices: 0 },
      { asset: "nosh.example", spentUsd: 0.4, unknownPrices: 0 },
    ]);
    expect(spend.byAsset.reduce((total, row) => total + row.spentUsd, 0)).toBe(
      spend.spentUsd,
    );
    expect(spend.spentUsd).toBeCloseTo(3.85, 10);
    expect(spend.byAsset.map((row) => row.asset)).not.toContain("areas.example");
  });

  it("reports zero spend rather than nothing when the metered lane has not run", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    const m = await buildIntegrationsMatrix(ctx.call, deps(fullRegister));
    // An untouched budget is a fact; an absent field would make the meter guess.
    expect(m.dataSpend).toEqual({
      period: "2026-07",
      spentUsd: 0, unknownPrices: 0,
      capUsd: 25,
      byAsset: [],
      unattributedUsd: 0, unattributedUnknownPrices: 0,
    });
  });

  it("folds nightly archive health into the GA4/GSC/Bing lanes it belongs to", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    await insertDump(ctx, "ga4-arch-1", "meals.example", "ga4", "daily-traffic", "2026-07-04", "2026-07-04T12:15:00.000Z", 0);
    await insertDump(ctx, "ga4-arch-2", "meals.example", "ga4", "daily-events", "2026-07-04", "2026-07-04T12:16:00.000Z", 0);
    await insertDump(ctx, "bwt-arch", "meals.example", "bing-webmaster", "rank-and-traffic", "2026-07-04", "2026-07-04T12:20:00.000Z", 0);

    const m = await buildIntegrationsMatrix(ctx.call, deps(fullRegister));
    const laneEvidence = (laneId: string) => {
      const index = m.catalog.findIndex((lane) => lane.id === laneId);
      return m.cells["meals.example"]![index]!.evidence;
    };
    // No collector run in the fixture, but the archive itself is evidence.
    expect(laneEvidence("ga4")[1]).toMatchObject({
      polarity: "supporting",
      source: "Nightly archive succeeded",
      detail: "2 report families · 2026-07-04",
    });
    expect(laneEvidence("bing-webmaster")[1]!.detail).toBe("1 report families · 2026-07-04");
    // Search Console archived nothing and is not collecting, so it says
    // nothing extra: a lane may only speak from its own observations.
    expect(laneEvidence("gsc")).toHaveLength(1);
  });

  // PostHog is collector-backed: its cell is derived from the daily archive's
  // own manifests, not from the posture the file declares.
  it("derives PostHog health from the newest attempt of each report family", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    const families = ["web-daily", "events", "exceptions", "rageclicks", "web-vitals", "funnels"];
    for (const [index, report] of families.entries()) {
      await insertDump(ctx, `ph-${report}`, "meals.example", "posthog", report, "2026-07-04", `2026-07-05T11:3${index}:00.000Z`, 0);
    }
    const index = (m: Awaited<ReturnType<typeof buildIntegrationsMatrix>>) => m.catalog.findIndex((lane) => lane.id === "posthog");

    let m = await buildIntegrationsMatrix(ctx.call, deps(fullRegister));
    let cell = m.cells["meals.example"]![index(m)]!;
    expect(cell.declared).toBe("needs-setup");
    expect(cell.effective).toBe("live");
    expect(cell.evidence[0]).toMatchObject({
      polarity: "supporting",
      source: "PostHog collector succeeded",
      detail: "6 report families · 60 rows · to 2026-07-04",
    });
    expect(m.cells["nosh.example"]![index(m)]!.effective).toBe("needs-setup");

    await writeArchiveRun(ctx.call, {
      id: "ph-exceptions-429", asset: "meals.example", integration: "posthog", report: "exceptions",
      credential_ref: "POSTHOG_KEYS", property_ref: "us:596607", report_date: "2026-07-05",
      requested_at: "2026-07-05T11:50:00.000Z", finished_at: "2026-07-05T11:50:01.000Z", status: "error",
      error_code: "posthog_query_budget_exceeded",
      error_message: "PostHog refused the query (HTTP 429, hourly query budget used up).",
    });
    m = await buildIntegrationsMatrix(ctx.call, deps(fullRegister));
    cell = m.cells["meals.example"]![index(m)]!;
    expect(cell.effective).toBe("degraded");
    expect(cell.evidence[0]).toMatchObject({ polarity: "against", source: "PostHog collector failed",
    });
    expect(cell.evidence[0]!.detail).toContain("exceptions: PostHog refused the query");
  });

  // Clarity is collector-backed the same way: its export writes one manifest
  // per asset per day.
  it("derives Clarity health from its daily export's own manifests", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    await insertDump(ctx, "clarity-ok", "meals.example", "clarity", "url-3d", "2026-07-04", "2026-07-04T04:30:00.000Z", 0);
    const index = (m: Awaited<ReturnType<typeof buildIntegrationsMatrix>>) => m.catalog.findIndex((lane) => lane.id === "clarity");

    let m = await buildIntegrationsMatrix(ctx.call, deps(fullRegister));
    let cell = m.cells["meals.example"]![index(m)]!;
    expect(cell.declared).toBe("needs-setup");
    expect(cell.effective).toBe("live");
    expect(cell.evidence).toHaveLength(1);
    expect(cell.evidence[0]).toMatchObject({
      polarity: "supporting",
      source: "Clarity collector succeeded",
      detail: "10 behavior rows · 3 days to 2026-07-04",
      verification: { kind: "collection-success", laneId: "clarity" },
    });
    expect(m.cells["nosh.example"]![index(m)]!.effective).toBe("needs-setup");

    await writeArchiveRun(ctx.call, {
      id: "clarity-401", asset: "meals.example", integration: "clarity", report: "url-3d",
      credential_ref: "store:CLARITY_TOKENS", report_date: "2026-07-05",
      requested_at: "2026-07-05T04:30:00.000Z", finished_at: "2026-07-05T04:30:01.000Z", status: "error",
      request_count: 1, error_code: "clarity_token_rejected",
      error_message: "Clarity rejected the project token (HTTP 401).",
    });
    m = await buildIntegrationsMatrix(ctx.call, deps(fullRegister));
    cell = m.cells["meals.example"]![index(m)]!;
    expect(cell.effective).toBe("degraded");
    expect(cell.evidence).toEqual([
      {
        polarity: "against",
        source: "Clarity collector failed",
        detail: "Clarity rejected the project token (HTTP 401).",
        at: "2026-07-05T04:30:01.000Z",
      },
    ]);

    const runs = await loadLatestSignalRuns(ctx.call, { panelAssets: new Set(), nowMs: NOW.getTime() }, "meals.example");
    const strip = buildCardDataSources({
      assetId: "meals.example",
      integrations: fullRegister,
      latestReportAt: null,
      pull: null,
      now: NOW,
      signalRuns: runs.get("meals.example") ?? [],
    });
    expect(strip.find((source) => source.id === "clarity")).toMatchObject({
      state: "degraded",
      detail: "Clarity rejected the project token (HTTP 401).",
      observedAt: "2026-07-05T04:30:01.000Z",
    });

    // A lane the operator switched off keeps that decision; the last attempt
    // stays readable as evidence.
    const retired = structuredClone(fullRegister);
    retired.assets["meals.example"]!.clarity = { status: "skipped", note: "Replaced by PostHog.", since: "2026-09-07" };
    m = await buildIntegrationsMatrix(ctx.call, deps(retired));
    cell = m.cells["meals.example"]![index(m)]!;
    expect(cell.effective).toBe("skipped");
  });

  // Bing's six families do not share one cadence: `queries` and `pages` are
  // weekly snapshots, the other four daily series. On six days out of seven
  // the lane's newest date covers only four families, and the sentence has to
  // say four without treating the weekly pair as a fault.
  it("counts only the Bing families the date it names covers, and stays green over the weekly two", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    const daily = ["rank-traffic", "crawl-stats", "crawl-issues", "feeds"];
    for (const [index, report] of daily.entries()) {
      await insertDump(ctx, `bwt-${report}`, "meals.example", "bing-webmaster", report, "2026-07-05", `2026-07-05T11:0${index}:00.000Z`, 0);
    }
    for (const report of ["queries", "pages"]) {
      await insertDump(ctx, `bwt-${report}`, "meals.example", "bing-webmaster", report, "2026-06-29", "2026-06-29T11:10:00.000Z", 0);
    }

    const m = await buildIntegrationsMatrix(ctx.call, deps(fullRegister));
    const index = m.catalog.findIndex((lane) => lane.id === "bing-webmaster");
    const archive = m.cells["meals.example"]![index]!.evidence[1]!;

    // A weekly family trailing by six days is the cadence working, so the line
    // is still supporting.
    expect(archive).toMatchObject({
      polarity: "supporting",
      source: "Nightly archive succeeded",
    });
    expect(archive.detail).toBe("4 of 6 report families · 2026-07-05 · pages and queries 2026-06-29");
    expect(archive.detail).not.toMatch(/^6 report families/);
  });

  it("keeps the plain count when every family carries the date the line names", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    for (const report of ["rank-traffic", "crawl-stats", "crawl-issues", "feeds", "queries", "pages"]) {
      await insertDump(ctx, `bwt-${report}`, "meals.example", "bing-webmaster", report, "2026-07-05", "2026-07-05T11:00:00.000Z", 0);
    }

    const m = await buildIntegrationsMatrix(ctx.call, deps(fullRegister));
    const index = m.catalog.findIndex((lane) => lane.id === "bing-webmaster");
    expect(m.cells["meals.example"]![index]!.evidence[1]!.detail).toBe(
      "6 report families · 2026-07-05",
    );
  });

  // The collector writes six families for an asset config/serp-panel.json
  // covers and five for every other. The five domain families land in seconds
  // and the ~40-call tracked panel minutes later, so a snapshot is
  // legitimately split for the length of one sweep.
  const DOMAIN_REPORTS = [
    "ranked-keywords",
    "backlinks-summary",
    "backlinks-new-lost",
    "llm-mentions-google",
    "llm-mentions-chatgpt",
  ];

  async function insertDataForSeo(
    ctx: TestStore,
    asset: string,
    rows: {
      report: string;
      reportDate: string;
      finishedAt: string;
      status?: "success" | "unchanged" | "error";
      errorCode?: string | null;
      errorMessage?: string | null;
    }[],
  ) {
    await writeArchiveRuns(ctx.call, rows.map((row, index) => ({
      id: `dfs-${asset}-${row.report}-${row.reportDate}-${index}`,
      asset, integration: "dataforseo", report: row.report, credential_ref: "DATAFORSEO_LOGIN",
      report_date: row.reportDate, finished_at: row.finishedAt, status: row.status ?? "success",
      provider_rows: 10, request_count: 1,
      object_key: `signals/dataforseo/${asset}/${row.reportDate}/${row.report}.json.gz`, object_bytes: 100,
      ...(row.errorCode ? { error_code: row.errorCode } : {}),
      ...(row.errorMessage ? { error_message: row.errorMessage } : {}),
      provider_cost_usd: 0.01,
    })));
  }

  function dataForSeoCell(matrix: Awaited<ReturnType<typeof buildIntegrationsMatrix>>, asset: string) {
    const index = matrix.catalog.findIndex((lane) => lane.id === "dataforseo");
    return matrix.cells[asset]![index]!;
  }

  const whole = (reports: string[], reportDate: string, finishedAt: string) =>
    reports.map((report) => ({ report, reportDate, finishedAt }));

  it("counts six report families for an asset with a tracked SERP panel", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    // Five families, one snapshot date, nothing stale. The panel is absent,
    // which for meals.example is a family never collected, not a full week.
    await insertDataForSeo(ctx,
      "meals.example",
      whole(DOMAIN_REPORTS, "2026-07-05", "2026-07-05T10:01:00.000Z"),
    );

    const cell = dataForSeoCell(
      await buildIntegrationsMatrix(ctx.call, deps(fullRegister)),
      "meals.example",
    );
    expect(cell.effective).toBe("degraded");
    expect(cell.evidence[0]).toMatchObject({
      polarity: "against",
      source: "DataForSEO collector failed",
    });
    expect(cell.evidence[0]!.detail).toBe(
      "5 of 6 report families ever collected",
    );
  });

  it("counts five for an asset with no panel, and is not fooled by a stale panel row", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    await insertDataForSeo(ctx,
      "nosh.example",
      whole(DOMAIN_REPORTS, "2026-07-05", "2026-07-05T10:01:00.000Z"),
    );
    // A panel row from before the operator removed nosh.example from
    // config/serp-panel.json: not a family this asset is due any more.
    await insertDataForSeo(ctx, "nosh.example", [
      {
        report: "serp-panel",
        reportDate: "2026-06-01",
        finishedAt: "2026-06-01T10:03:00.000Z",
      },
    ]);

    const cell = dataForSeoCell(
      await buildIntegrationsMatrix(ctx.call, deps(fullRegister)),
      "nosh.example",
    );
    expect(cell.effective).toBe("live");
    expect(cell.evidence[0]).toMatchObject({
      polarity: "supporting",
      source: "DataForSEO collector succeeded",
      detail: "5 report families · 50 rows · 2026-07-05 snapshot",
    });
  });

  it("reads the panel's in-flight tail as a sweep in progress, not a torn week", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    // Monday, two minutes ago: the five domain families carry this week's
    // date and the panel is still running, so its newest attempt is last week's.
    await insertDataForSeo(ctx, "meals.example", [
      ...whole(DOMAIN_REPORTS, "2026-07-05", "2026-07-05T11:58:00.000Z"),
      {
        report: "serp-panel",
        reportDate: "2026-06-28",
        finishedAt: "2026-06-28T12:47:00.000Z" },
    ]);

    const cell = dataForSeoCell(
      await buildIntegrationsMatrix(ctx.call, deps(fullRegister)),
      "meals.example",
    );
    expect(cell.effective).toBe("live");
    // The success line counts only what belongs to its date: the five that
    // have landed, never the sixth still on 2026-06-28.
    expect(cell.evidence[0]).toMatchObject({
      polarity: "supporting",
      source: "DataForSEO collector succeeded",
      detail: "5 report families · 50 rows · 2026-07-05 snapshot",
    });
  });

  it("still names a family genuinely missing from the week once the sweep is over", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    // Two hours later: the sweep is long finished, so the panel is missing, not late.
    await insertDataForSeo(ctx, "meals.example", [
      ...whole(DOMAIN_REPORTS, "2026-07-05", "2026-07-05T09:58:00.000Z"),
      {
        report: "serp-panel",
        reportDate: "2026-06-28",
        finishedAt: "2026-06-28T12:47:00.000Z" },
    ]);

    const cell = dataForSeoCell(
      await buildIntegrationsMatrix(ctx.call, deps(fullRegister)),
      "meals.example",
    );
    expect(cell.effective).toBe("degraded");
    expect(cell.evidence[0]).toMatchObject({
      polarity: "against",
      source: "DataForSEO collector failed",
      detail: "serp-panel missing from 2026-07-05",
    });
  });

  it("names the exact failed family before the provider message", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    await insertDataForSeo(ctx, "meals.example", [
      ...whole(DOMAIN_REPORTS, "2026-07-05", "2026-07-05T09:58:00.000Z"),
      {
        report: "serp-panel",
        reportDate: "2026-07-05",
        finishedAt: "2026-07-05T10:03:00.000Z",
        status: "error",
        errorCode: "40502",
        errorMessage: "POST Data Is Empty." },
    ]);

    const cell = dataForSeoCell(
      await buildIntegrationsMatrix(ctx.call, deps(fullRegister)),
      "meals.example",
    );
    expect(cell.effective).toBe("degraded");
    expect(cell.evidence[0]).toMatchObject({
      polarity: "against",
      source: "DataForSEO collector failed",
      detail: "serp-panel: POST Data Is Empty.",
      at: "2026-07-05T10:03:00.000Z",
    });
  });

  it("names every failed family deterministically and dates the newest failure", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    await insertDataForSeo(ctx, "meals.example", [
      ...whole(DOMAIN_REPORTS, "2026-07-05", "2026-07-05T09:58:00.000Z"),
      {
        report: "backlinks-summary",
        reportDate: "2026-07-05",
        finishedAt: "2026-07-05T10:01:00.000Z",
        status: "error",
        errorCode: "50000",
        errorMessage: "Provider unavailable.",
      },
      {
        report: "serp-panel",
        reportDate: "2026-07-05",
        finishedAt: "2026-07-05T10:03:00.000Z",
        status: "error",
        errorCode: "40502",
        errorMessage: "POST Data Is Empty." },
    ]);

    const cell = dataForSeoCell(
      await buildIntegrationsMatrix(ctx.call, deps(fullRegister)),
      "meals.example",
    );
    expect(cell.evidence[0]).toMatchObject({
      detail:
        "backlinks-summary: Provider unavailable.; serp-panel: POST Data Is Empty.",
      at: "2026-07-05T10:03:00.000Z",
    });
  });

  it("renders every data source a provider connects as an obligation after fees.example goes live, and no nightly slot before its first report", () => {
    const sources = buildCardDataSources({
      assetId: "fees.example",
      integrations: fullRegister,
      latestReportAt: null,
      pull: null,
      now: NOW,
      signalRuns: [],
    });
    expect(sources.map(({ id }) => id)).toEqual([
      "gsc",
      "bing-webmaster",
      "ga4",
      "clarity",
      "posthog",
      "dataforseo",
    ]);
    // Uptime is Not set up and nothing on Integrations connects it: no slot.
    expect(sources.filter(({ state }) => state === "needs-setup")).toHaveLength(6);
  });
});

describe("buildAssetIntegrations", () => {
  it("builds one asset's lanes with catalog metadata + a per-asset summary", () => {
    const ev: LaneEvidence = {
      revenueRows: [{ currency: 'USD', family: "ads", source: "raptive-report", note: null, amountMinor: 49810, period: "2026-06" }],
    };
    const section = buildAssetIntegrations("meals.example", INTEGRATIONS, ev);
    expect(section).not.toHaveProperty("owner");
    // Uptime and CJ are Not set up and nothing on Integrations connects them:
    // no row to answer. The declined Amazon row stays.
    expect(section.lanes.map((l) => l.cell.laneId)).toEqual(["gsc", "ad-network", "affiliate-amazon"]);
    const ad = section.lanes.find((l) => l.cell.laneId === "ad-network")!;
    expect(ad.catalog.usage.cost).toBe("free");
    expect(ad.cell.effective).toBe("needs-setup");
    expect(ad.cell.evidence[0]!.polarity).toBe("supporting");
    expect(section.summary.total).toBe(3);
  });

  // `LANE_MAPPING` decides which lanes have a mapping; every other lane gets
  // an empty list and no card section.
  it("carries the mapping only for the lanes that declare one", () => {
    const ev: LaneEvidence = { revenueRows: [] };
    const withMapping: IntegrationsConfig = {
      catalog: CATALOG,
      assets: {
        ...INTEGRATIONS.assets,
        "meals.example": {
          ...INTEGRATIONS.assets["meals.example"]!,
          gsc: cell("needs-setup", { siteUrl: "sc-domain:meals.example" }),
        },
      },
    };
    const section = buildAssetIntegrations("meals.example", withMapping, ev);
    const gsc = section.lanes.find((l) => l.cell.laneId === "gsc")!;
    expect(gsc.mapping).toEqual([{ name: "siteUrl", value: "sc-domain:meals.example" }]);
    expect(gsc.mappingSource).toBe("register");
    expect(section.lanes.find((l) => l.cell.laneId === "affiliate-amazon")!.mapping).toEqual([]);
    expect(gsc).not.toHaveProperty("mappingReads");
  });

  /** The collectors read the register where it holds a value and their old
   * source where it does not, so the payload says which answers, same rule as
   * `workers/ingest/src/lane-mapping.ts`. */
  it("says whether the register or the lane's old source answers, per asset", () => {
    const ev: LaneEvidence = { revenueRows: [] };
    const mapped: IntegrationsConfig = {
      catalog: CATALOG,
      assets: {
        ...INTEGRATIONS.assets,
        "meals.example": {
          ...INTEGRATIONS.assets["meals.example"]!,
          gsc: cell("needs-setup", { siteUrl: "sc-domain:meals.example" }),
        },
      },
    };
    const withValue = buildAssetIntegrations("meals.example", mapped, ev).lanes.find(
      (l) => l.cell.laneId === "gsc",
    )!;
    expect(withValue.mappingSource).toBe("register");

    const without = buildAssetIntegrations("meals.example", INTEGRATIONS, ev).lanes.find(
      (l) => l.cell.laneId === "gsc",
    )!;
    expect(without.mappingSource).toBe("fallback");

    const amazon = buildAssetIntegrations("meals.example", INTEGRATIONS, ev).lanes.find(
      (l) => l.cell.laneId === "affiliate-amazon",
    )!;
    expect(amazon.mappingSource).toBe("fallback");
    expect(amazon.mapping).toEqual([]);
  });

  // An unmapped lane reads as unmapped rather than as an empty string.
  it("reads an unmapped field as unmapped, with no setup checklist beside it", () => {
    const ev: LaneEvidence = { revenueRows: [] };
    const section = buildAssetIntegrations("meals.example", INTEGRATIONS, ev);
    const gsc = section.lanes.find((l) => l.cell.laneId === "gsc")!;
    expect(gsc.mapping).toEqual([{ name: "siteUrl", value: null }]);
    expect(gsc).not.toHaveProperty("setup");
  });
});

describe("loadMeteredCallsToday", () => {
  const NOW = new Date("2026-09-05T09:00:00.000Z");

  async function insertClarity(
    ctx: TestStore,
    rows: { asset: string; requestedAt: string; status?: "success" | "error" }[],
  ) {
    await writeArchiveRuns(ctx.call, rows.map((row, index) => {
      const failed = row.status === "error";
      const id = `clarity-${row.asset}-${index}`;
      return {
        id, asset: row.asset, integration: "clarity", report: "url-3d", credential_ref: "CLARITY_TOKENS",
        report_date: row.requestedAt.slice(0, 10), finished_at: row.requestedAt,
        status: failed ? "error" : "success", provider_rows: 5,
        // A failed call archives no pages, so `request_count` is 0 on it,
        // which is why this counts rows.
        request_count: failed ? 0 : 1,
        object_key: `raw/microsoft/clarity/${id}.json.gz`, object_bytes: 100,
        error_code: "clarity_token_rejected", error_message: "Clarity rejected the project token (HTTP 401).",
      } as const;
    }));
  }

  it("counts today's calls per asset, from the rows this OS wrote", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    await insertClarity(ctx, [
      { asset: "meals.example", requestedAt: "2026-09-05T04:30:00.000Z" },
      { asset: "meals.example", requestedAt: "2026-09-05T06:00:00.000Z" },
      { asset: "nosh.example", requestedAt: "2026-09-05T04:30:00.000Z" },
      { asset: "nosh.example", requestedAt: "2026-09-04T04:30:00.000Z" },
    ]);

    const reading = await loadMeteredCallsToday(ctx.call, "clarity", NOW);
    expect(reading.day).toBe("2026-09-05");
    expect(reading.assets).toEqual([
      { asset: "meals.example", spent: 2 },
      { asset: "nosh.example", spent: 1 },
    ]);
  });

  it("counts a FAILED call, because the budget was spent either way", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    await insertClarity(ctx, [
      { asset: "meals.example", requestedAt: "2026-09-05T04:30:00.000Z", status: "error" },
    ]);
    // Summing `request_count` would report this as budget still available.
    expect((await loadMeteredCallsToday(ctx.call, "clarity", NOW)).assets).toEqual([
      { asset: "meals.example", spent: 1 },
    ]);
  });

  it("does not count another provider's rows", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    expect((await loadMeteredCallsToday(ctx.call, "clarity", NOW)).assets).toEqual([]);
  });

  /** One DataForSEO report and what it cost, on the same manifest rows. */
  async function insertReport(
    ctx: TestStore,
    id: string,
    asset: string,
    requestedAt: string,
    costUsd: number,
  ) {
    await writeArchiveRun(ctx.call, {
      id, asset, integration: "dataforseo", report: "ranked-keywords", credential_ref: "cred",
      report_date: requestedAt.slice(0, 10), finished_at: requestedAt, provider_rows: 10, request_count: 1,
      object_key: `signals/${id}`, object_bytes: 100, provider_cost_usd: costUsd,
    });
  }

  const SPEND_METER = {
    window: "portfolio-month",
    countedFrom: "dataforseo",
    note: "not the account credit",
  } as const;

  it("reads the month's dollars through the SAME sum the budget meter reads", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    await insertReport(ctx, "dfs-1", "meals.example", "2026-09-01T12:45:00.000Z", 1.122_772);
    await insertReport(ctx, "dfs-2", "nosh.example", "2026-09-03T12:45:00.000Z", 0.41);
    await insertReport(ctx, "dfs-old", "meals.example", "2026-08-30T12:45:00.000Z", 9);

    const reading = await loadProviderMeter(ctx.call, SPEND_METER, NOW, 25);
    const spend = await loadDataForSeoSpend(ctx.call, NOW);
    expect(reading).toEqual({
      window: "portfolio-month",
      period: "2026-09",
      spentUsd: spend.spentUsd, unknownPrices: spend.unknownPrices,
      capUsd: 25,
    });
    expect(spend.spentUsd).toBeCloseTo(1.532_772, 10);
  });

  // The Wall's SYSTEM band states a day's pace and this page a month's; both
  // come out of this one function.
  it("windows the same sum to a day for the Wall's pace", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    await insertReport(ctx, "dfs-today", "meals.example", "2026-09-05T01:00:00.000Z", 0.4);
    await insertReport(ctx, "dfs-today-2", "nosh.example", "2026-09-05T08:59:00.000Z", 0.15);
    await insertReport(ctx, "dfs-yesterday", "meals.example", "2026-09-04T23:59:59.000Z", 7);

    const day = await loadDataForSeoSpend(ctx.call, NOW, "day");
    expect(day.spentUsd).toBeCloseTo(0.55, 10);
    expect(day.byAsset).toEqual([
      { asset: "meals.example", spentUsd: 0.4, unknownPrices: 0 },
      { asset: "nosh.example", spentUsd: 0.15, unknownPrices: 0 },
    ]);
    const month = await loadDataForSeoSpend(ctx.call, NOW);
    expect(month.spentUsd).toBeCloseTo(7.55, 10);
  });

  /** Ad-hoc research: the same DataForSEO account, a different table. `actor`
   * keeps the two halves disjoint: a row the collector wrote for itself is
   * already counted from its manifest row. */
  async function insertResearch(
    ctx: TestStore,
    id: string,
    asset: string | null,
    boughtAt: string,
    costUsd: number,
    actor = "claude-opus-5",
  ): Promise<void> {
    await writeResearch(ctx.call, [{
      asset, endpoint: "dataforseo_labs/google/keyword_overview/live",
      params_sha256: Buffer.from(id).toString("hex").padEnd(64, "0"),
      question: "keyword overview, 1 term, US/en", cost_usd: costUsd, actor, bought_at: boughtAt,
    }]);
  }

  // The cap gate sums `signal_dump_runs` plus `research_log`; a meter that
  // summed the first alone would under-report.
  it("counts the ad-hoc research the cap gate counts, not just the collected reports", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    await insertReport(ctx, "dfs-1", "meals.example", "2026-09-01T12:45:00.000Z", 1.1);
    await insertResearch(ctx, "r1", "meals.example", "2026-09-02T09:00:00.000Z", 0.24);
    await insertResearch(ctx, "r2", "nosh.example", "2026-09-02T09:30:00.000Z", 0.4);
    // Portfolio-level research names no property.
    await insertResearch(ctx, "r3", null, "2026-09-03T09:00:00.000Z", 0.06);
    await insertResearch(ctx, "r4", "meals.example", "2026-09-03T10:00:00.000Z", 5, "collector");
    await insertResearch(ctx, "r5", "meals.example", "2026-08-31T23:59:59.000Z", 9);

    const spend = await loadDataForSeoSpend(ctx.call, NOW);
    expect(spend.spentUsd).toBeCloseTo(1.8, 10);
    expect(spend.byAsset).toEqual([
      { asset: "meals.example", spentUsd: 1.34, unknownPrices: 0 },
      { asset: "nosh.example", spentUsd: 0.4, unknownPrices: 0 },
    ]);
    expect(spend.unattributedUsd).toBeCloseTo(0.06, 10);
    expect(
      spend.byAsset.reduce((total, row) => total + row.spentUsd, 0) +
        spend.unattributedUsd,
    ).toBeCloseTo(spend.spentUsd, 10);
  });

  // `/health`'s spend summary and `/settings`' budget meter read the matrix's
  // `dataSpend`, the provider card reads `loadProviderMeter`, and the Wall
  // reads the same sum one window over.
  it("gives /health, /settings, the provider card and the Wall one figure", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    await insertReport(ctx, "dfs-1", "meals.example", "2026-09-05T02:00:00.000Z", 1.1);
    await insertResearch(ctx, "r1", "nosh.example", "2026-09-05T09:00:00.000Z", 0.24);

    const matrix = await buildIntegrationsMatrix(ctx.call, {
      ...deps(INTEGRATIONS),
      now: NOW,
    });
    const card = await loadProviderMeter(ctx.call, SPEND_METER, NOW, 25);
    const day = await loadDataForSeoSpend(ctx.call, NOW, "day");
    const month = await loadDataForSeoSpend(ctx.call, NOW);

    expect(month.spentUsd).toBeCloseTo(1.34, 10);
    expect(card).toEqual({
      window: "portfolio-month",
      period: "2026-09",
      spentUsd: month.spentUsd, unknownPrices: month.unknownPrices,
      capUsd: 25,
    });
    expect(day.spentUsd).toBeCloseTo(month.spentUsd, 10);
    expect(matrix.dataSpend).toMatchObject({
      period: "2026-09",
      spentUsd: month.spentUsd, unknownPrices: month.unknownPrices,
    });
  });

  it("takes the cap from the caller, because the operator owns that number", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    const reading = await loadProviderMeter(ctx.call, SPEND_METER, NOW, 40);
    // The cap is whatever `monthly_caps.data_usd` says today, never a copy in
    // the catalog.
    expect(reading).toEqual({
      window: "portfolio-month",
      period: "2026-09",
      spentUsd: 0, unknownPrices: 0,
      capUsd: 40,
    });
  });

  it("counts unknown prices by window and site without counting collector research twice", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    await insertReport(ctx, "known", "meals.example", "2026-09-05T02:00:00.000Z", 1.25);
    await insertReport(ctx, "unknown", "nosh.example", "2026-09-05T03:00:00.000Z", 0);
    await insertResearch(ctx, "unpriced", "nosh.example", "2026-09-05T04:00:00.000Z", 0);
    await insertResearch(ctx, "unattributed", null, "2026-09-05T05:00:00.000Z", 0);
    await insertResearch(ctx, "collector", "nosh.example", "2026-09-05T06:00:00.000Z", 0, "collector");
    await insertReport(ctx, "yesterday", "meals.example", "2026-09-04T03:00:00.000Z", 0);
    await insertReport(ctx, "last-month", "meals.example", "2026-08-31T03:00:00.000Z", 0);
    const store = ctx.call;
    const day = await loadDataForSeoSpend(store, NOW, "day");
    expect(day).toEqual({
      spentUsd: 1.25, unknownPrices: 3,
      byAsset: [
        { asset: "meals.example", spentUsd: 1.25, unknownPrices: 0 },
        { asset: "nosh.example", spentUsd: 0, unknownPrices: 2 },
      ],
      unattributedUsd: 0, unattributedUnknownPrices: 1,
    });
    expect(await loadProviderMeter(store, SPEND_METER, NOW, 25)).toMatchObject({ spentUsd: 1.25, unknownPrices: 4 });
  });

  it("still counts calls for the provider that meters a day", async () => {
    const ctx = await createTestStore();
    await seedAssets(ctx);
    await insertClarity(ctx, [
      { asset: "meals.example", requestedAt: "2026-09-05T04:30:00.000Z" },
    ]);
    // The declaration decides which reading comes back, so a second metered
    // provider is not a second `if` in the route.
    expect(
      await loadProviderMeter(ctx.call,
        { window: "asset-day", perAssetPerDay: 10, unit: "call", countedFrom: "clarity" },
        NOW,
        25,
      ),
    ).toEqual({
      window: "asset-day",
      day: "2026-09-05",
      assets: [{ asset: "meals.example", spent: 1 }],
    });
  });
});

describe("one integration evidence read for compact and detailed views", () => {
  let ctx: TestStore;
  beforeEach(async () => { ctx = await createTestStore(); await seed(ctx); });
  const context = { latestReportAt: NOW.toISOString(), pull: PULL_CONFIG[0]!, isOs: false };

  it("distinguishes an unrequested observation from a completed read with no run", async () => {
    expect(mergeLane("live", "gsc", { revenueRows: [] }).effective).toBe("live");
    const full = await loadIntegrationEvidence(ctx.call, { ...deps(INTEGRATIONS), presentation: "full" });
    const compact = await loadIntegrationEvidence(ctx.call, { ...deps(INTEGRATIONS), presentation: "compact" });
    expect(full.cells("meals.example", false).find(c => c.laneId === "gsc")?.effective).toBe("needs-setup");
    expect(full.asset("meals.example", context).lanes.find(l => l.catalog.id === "gsc")?.cell.effective).toBe("needs-setup");
    expect(compact.cards("meals.example", context).find(c => c.id === "gsc")?.state).toBe("needs-setup");
  });

  it.each(["success", "error"] as const)("uses one %s observation in each presentation, including successful zero rows", async (status) => {
    await insertSignalRun(ctx, "same-run", "meals.example", "gsc", NOW.toISOString(), status);
    const full = await loadIntegrationEvidence(ctx.call, { ...deps(INTEGRATIONS), presentation: "full" });
    const compact = await loadIntegrationEvidence(ctx.call, { ...deps(INTEGRATIONS), presentation: "compact" });
    const expected = status === "success" ? "live" : "degraded";
    expect(full.cells("meals.example", false).find(c => c.laneId === "gsc")?.effective).toBe(expected);
    expect(full.asset("meals.example", context).lanes.find(l => l.catalog.id === "gsc")?.cell.effective).toBe(expected);
    expect(compact.cards("meals.example", context).find(c => c.id === "gsc")?.state).toBe(expected);
    expect(full.cells("root-os", true).find(c => c.laneId === "gsc")?.effective).toBe("not-applicable");
  });

  it("loads only compact evidence for cards and reuses existing ledger and flag reads for detail", async () => {
    // Every statement is read on Postgres.
    const queries: string[] = [];
    const compact = await loadIntegrationEvidence(recordingStore(ctx.call, queries), { ...deps(INTEGRATIONS), presentation: "compact" });
    compact.cards("meals.example", context);
    compact.cards("nosh.example", context);
    // The signal runs, the report runs, and each site's newest home-page check.
    expect(queries).toHaveLength(3);
    // No statement names the alerts either.
    expect(queries.join("\n")).not.toMatch(/financial_ledger|mediavine|flags/);
    queries.length = 0;
    const full = await loadIntegrationEvidence(recordingStore(ctx.call, queries), { ...deps(INTEGRATIONS), presentation: "full", assetId: "meals.example", reuse: { revenueRows: new Map() } });
    const count = queries.length;
    full.asset("meals.example", context);
    full.cells("meals.example", false);
    full.cards("meals.example", context);
    expect(queries).toHaveLength(count);
    expect(queries.join("\n")).not.toMatch(/financial_ledger|flags/);
    expect(() => full.asset("nosh.example", context)).toThrow("loaded for meals.example");
    expect(() => full.cells("nosh.example", false)).toThrow("loaded for meals.example");
    expect(() => full.cards("nosh.example", context)).toThrow("loaded for meals.example");
    const scopedCompact = await loadIntegrationEvidence(recordingStore(ctx.call, queries), { ...deps(INTEGRATIONS), presentation: "compact", assetId: "meals.example" });
    expect(() => scopedCompact.cards("nosh.example", context)).toThrow("loaded for meals.example");
  });
});

// Uptime is the OS's own hourly home-page check.
describe("uptime — the site's own home-page check", () => {
  const AT = "2026-07-05T11:40:00.000Z";
  const up: HomeCheck = { observedAt: AT, status: "ok", httpStatus: 200, egressDown: false };

  it("reads Up with dated proof when the home page answered", () => {
    expect(uptimeState("needs-setup", up)).toEqual({
      effective: "live",
      evidence: [{ polarity: "supporting", source: "Home page answered", detail: "", at: AT,
        verification: { kind: "collection-success", laneId: "uptime" } }],
    });
    expect(uptimeState("needs-setup", { ...up, status: "error" }).effective).toBe("live");
  });

  it("reads Up with the failed try when the page answered only the retry", () => {
    expect(uptimeState("needs-setup", { ...up, failedTries: 1 })).toMatchObject({
      effective: "live",
      evidence: [{ polarity: "supporting", detail: "1 failed try", verification: { kind: "collection-success" } }],
    });
    expect(uptimeState("live", { ...up, status: "error", httpStatus: 503, failedTries: 2 }).evidence[0]).toMatchObject({
      polarity: "against", detail: "HTTP 503" });
  });

  it("reads the failed try off the reading the ingest stored", async () => {
    const db = await createTestStore();
    await insertAsset(db, "meals.example", "Meal Planner", 0);
    await insertHomeCheck(db, "meals.example", AT, "ok", { url: "https://meals.example/", http_status: 200, failed_tries: 1, first_try_http_status: 502 });
    expect((await loadHomeChecks(db.call, "meals.example")).get("meals.example"))
      .toMatchObject({ observedAt: AT, status: "ok", httpStatus: 200, failedTries: 1 });
  });

  it("reads Down with what the page answered, or that it did not", () => {
    expect(uptimeState("live", { ...up, status: "error", httpStatus: 503 }).evidence[0]).toMatchObject({
      polarity: "against", detail: "HTTP 503" });
    expect(uptimeState("live", { ...up, status: "unreachable", httpStatus: null })).toMatchObject({
      effective: "degraded", evidence: [{ detail: "No response" }] });
  });

  it("never accuses a site the OS could not reach the network to check", () => {
    const offline = uptimeState("live", { ...up, status: "unreachable", httpStatus: null, egressDown: true });
    expect(offline.effective).toBe("live");
    expect(offline.evidence[0]!.verification).toBeUndefined();
    const cell = { assetId: "nosh.example", laneId: "uptime", ...offline };
    expect(connectionHealthState(cell, Date.parse("2026-07-05T12:00:00.000Z"))).toBe("unverified");
  });

  it("keeps the declared state until the first check, and the operator's Not using always", () => {
    expect(uptimeState("needs-setup", null)).toEqual({ effective: "needs-setup", evidence: [] });
    expect(uptimeState("skipped", { ...up, status: "error", httpStatus: 503 })).toEqual({ effective: "skipped", evidence: [] });
  });

  it("reads its own check, never another lane's alert", () => {
    expect(mergeLane("live", "uptime", { ...NO_EVIDENCE, homeCheck: up }).effective).toBe("live");
  });

  it("finds each site's newest check with one index seek per site", async () => {
    const plan = await ((await createTestStore()).call).read(async (tx) => {
      // An empty table is cheapest to scan; forbidding that shows the plan the
      // index offers once the readings pile up.
      await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
      return tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${homeChecksSql(false)}`);
    });
    const details = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(details).toMatch(/Index Scan Backward using hygiene_checks_workspace_id_asset_id_check_id_observed_on_key on hygiene_checks x/);
    expect(details).not.toMatch(/Seq Scan on hygiene_checks/);
  });
});
