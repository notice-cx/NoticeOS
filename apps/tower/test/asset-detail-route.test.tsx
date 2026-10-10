import { settingsResponse } from "./critical-response-fixtures";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssetDetailPayload,
  ProductUseSnapshot,
  SearchIntelligenceSnapshot,
} from "@shared/asset-detail";
import { GOOGLE_PROPERTIES_PATH, type WatchQueryHistory } from "@noticeos/contract";
import { integrationProvider } from "@noticeos/contract/integrations";
import { watchCalibration } from "@shared/watch-windows";
import { formatCalendarDate, formatSeriesDate } from "@/lib/format";
import { toLocalDateTimeInput } from "@/lib/countdown";
import { parseProductSnapshot } from "@shared/product-snapshot";
import posthogProductJson from "@/routes/kitchen-sink/posthog-product.json";
// The real write pipeline, so a case about a save runs the ops the browser
// built. Plain ESM with no `node:` imports, so it is safe to reach from jsdom.
import {
  applyDocumentOps,
  resolveOps,
  validateSchemaAndSafety,
  type ChangesetOp,
} from "../../../scripts/config-documents.mjs";
import { ASSET_TABS, AssetDetailRoute, type AssetTab } from "@/routes/AssetDetailRoute";
import { HASH_TAB } from "@/routes/asset-detail/AssetTabs";
import { RESTORE_HASH } from "@shared/asset-detail-views";
import { MATERIALITY, type MaterialCondition } from "@shared/materiality";
import { loadAssetTabs } from "./lazy-code";

vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

beforeAll(loadAssetTabs);

// Sonner is mocked: the Settings tab's Undo is a callback on the toast, and
// asserting it through a rendered toast would be asserting Sonner's DOM.
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

// Both connection reads are missing by default, which the model reads as
// Unknown; a case about a source's status says what the reads answered.
const connections = vi.hoisted(() => ({
  credentials: undefined as ReadonlyMap<string, unknown> | undefined,
  items: null as unknown[] | null,
}));
vi.mock("@/hooks/useConnections", () => ({
  useConnections: () => ({ credentials: connections.credentials, items: connections.items }),
}));
/** The reads answered: `google` connected and these monitoring items. */
function googleAnswers(items: { capability: string; state: string }[]) {
  const at = new Date(Date.now() - 60_000).toISOString();
  connections.credentials = new Map([["google", {
    provider: "google", source: "store", fields: ["GOOGLE_OAUTH_REFRESH_TOKEN"], assetsHeld: [], missingFields: [], auth: "oauth",
    metadata: null, keyVersion: 1, createdAt: at, updatedAt: at, lastUsedAt: at, lastOkAt: at, lastError: null,
  }]]);
  connections.items = items.map(({ capability, state }, index) => ({
    id: `item-${index}`, provider: "google", capability, label: capability, asset: "meadow.example", detail: null, state,
    lastAttemptAt: at, lastSuccessAt: state === "healthy" ? at : null, nextAttemptAt: null,
    failure: state === "failing" ? "access" : null, code: null, action: "Review the property connection.", coverage: "monitored",
  }));
}
afterEach(() => {
  connections.credentials = undefined;
  connections.items = null;
});
/** The header's source marks, "label: status" in slot order. */
const headerStatuses = (heading: HTMLElement) =>
  [...heading.closest("header")!.querySelectorAll("[data-source]")].map((mark) => mark.getAttribute("aria-label"));

/** The card this text sits in, as a selector (`[` and `]` are CSS syntax). */
const CARD = ".rounded-\\[10px\\]";

/** Open one of the Activity tab's composers. Idempotent. */
async function openComposer(
  findByRole: (role: string, options: { name: RegExp | string }) => Promise<HTMLElement>,
  which: "event" | "watch",
): Promise<void> {
  fireEvent.click(await findByRole("button", { name: /^log a change →$/i }));
  if (which === "watch") {
    fireEvent.click(await findByRole("button", { name: /watch an outcome/i }));
  }
}

/** Open the `ListPanel` row whose title contains this text. Idempotent. */
function openRow(titleFragment: string): void {
  const row = [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find(
    (button) => button.textContent?.includes(titleFragment),
  );
  if (row && row.getAttribute("aria-expanded") === "false") fireEvent.click(row);
}

const openAlert = openRow;

/** Open the real disclosure path before interacting with a source's editor. */
function openLane(titleFragment: string): void {
  const row = [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")]
    .find((button) => button.textContent?.includes(titleFragment));
  if (!row) throw new Error(`No source row: ${titleFragment}`);
  const group = row.closest("details");
  if (group && !group.open) {
    const summary = group.querySelector("summary");
    if (!summary) throw new Error("Source group has no disclosure control");
    fireEvent.click(summary);
  }
  openRow(titleFragment);
}

/** One `PUT /api/config` body, exactly as the browser sent it, slug included. */
interface ConfigPut {
  ops: Record<string, unknown>[];
  slug?: string;
}

/** A fresh cache per case. Only the backoff is overridden, so the failure
 * state is reached without waiting out a real 1s delay. */
function testClient() {
  return new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
}

/** `tab` omitted means Overview. Only the active tab's sections mount. */
function renderRoute(id: string, hash = "", tab: AssetTab | "" = "") {
  return renderPath(`/assets/${id}${tab ? `/${tab}` : ""}${hash}`);
}

/** Render at a literal URL, for a segment nobody built. The probe lets a
 * redirect be asserted as the address bar, not only as the tab bar. */
function renderPath(path: string) {
  return render(
    <QueryClientProvider client={testClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/assets/:id/:tab?"
            element={
              <>
                <AssetDetailRoute />
                <LocationProbe />
              </>
            }
          />
          {/* Where a completed Delete goes. Nothing else in this file visits
              it, so it is inert until a case asserts the departure. */}
          <Route path="/assets" element={<div data-assets-index>Assets</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Where the router thinks it is, rendered so a test can read it. */
function LocationProbe() {
  const { pathname, search, hash } = useLocation();
  return <span data-testid="path">{`${pathname}${search}${hash}`}</span>;
}

/** jsdom has no scrollIntoView; the deep-link tests assert which element id
 * it was called on. */
function captureScrollTargets(): string[] {
  const scrolled: string[] = [];
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value(this: Element) {
      scrolled.push(this.id);
    },
  });
  return scrolled;
}

const emptyTrend = () => ({
  series: [],
  provisionalFrom: null,
  collectedAt: null,
  timeZoneChanges: [],
});

/** The supporting GA4/GSC series, which most cases do not exercise. Kept as a
 * spread so a fixture states only the trends its assertions are about. */
const noSecondarySeries = () => ({
  sessions: emptyTrend(),
  pageViews: emptyTrend(),
  events: emptyTrend(),
  searchCtr: emptyTrend(),
  searchPosition: emptyTrend(),
});

/** Stub GET /api/assets/:id with one canned response. */
function stubFetch(status: number, body: unknown = {}) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

/** A complete payload: the page renders every section. The ledger is empty so
 * the Daily metrics table is the only table on the page. */
function payload(over: Partial<AssetDetailPayload> = {}): AssetDetailPayload {
  return {
    generatedAt: "2026-07-05T12:00:00.000Z",
    osTimeZone: "America/Los_Angeles",
    asset: {
      id: "meadow.example",
      displayName: "Meadow Board",
      domain: "meadow.example",
      status: "live",
      senseOnly: false,
      isOs: false,
      firstReportAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      worstOpenSeverity: null,
      openError: 0,
      openWarn: 0,
    },
    scheduledLanes: null,
    countersConfig: null,
    panelConfig: {
      trackedQueries: null,
      roster: { enabled: true, reason: "live-lanes", note: "GSC + GA4 live.", since: "2026-08-03" },
    },
    wiring: {
      mode: "push",
      modeOwner: "config/pull.json",
      cadence: "nightly",
      schedule: null,
      cadenceOwner: "workers/ingest",
      pull: null,
      push: {
        endpoint: "POST /api/pulse",
        endpointOwner: "workers/ingest",
        auth: "Site token",
        authOwner: "workers/ingest/.dev.vars",
      },
      lastPulseReceivedAt: "2026-07-05T02:00:00.000Z",
      lastPulseDate: "2026-07-05",
      pullFailure: null,
      ingestFreshness: null,
    },
    rules: { scope: "portfolio-default", hasOverride: false, knobs: [] },
    portfolio: { owner: "config/constants.json", note: "portfolio-wide", knobs: [] },
    performance: {
      ...noSecondarySeries(),
      activeUsers: {
        series: [
          { t: "2026-06-28", v: 90 },
          { t: "2026-06-29", v: 100 },
          { t: "2026-06-30", v: 104 },
          { t: "2026-07-01", v: 110 },
          { t: "2026-07-02", v: 106 },
          { t: "2026-07-03", v: 94 },
          { t: "2026-07-04", v: 70 },
          { t: "2026-07-05", v: 99 },
        ],
        provisionalFrom: "2026-07-05",
        collectedAt: "2026-07-05T11:45:00.000Z",
        timeZoneChanges: [],
      },
      webSearchClicks: {
        google: {
          series: [
            { t: "2026-06-28", v: 45 },
            { t: "2026-06-29", v: 52 },
            { t: "2026-06-30", v: 55 },
            { t: "2026-07-01", v: 57 },
            { t: "2026-07-02", v: 50 },
            { t: "2026-07-03", v: 43 },
            { t: "2026-07-04", v: 31 },
            { t: "2026-07-05", v: 60 },
          ],
          provisionalFrom: "2026-07-05",
          collectedAt: "2026-07-05T11:45:00.000Z",
          timeZoneChanges: [],
        },
        bing: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
      },
      webSearchImpressions: {
        google: {
          series: [
            { t: "2026-06-28", v: 900 },
            { t: "2026-06-29", v: 1000 },
            { t: "2026-06-30", v: 1040 },
            { t: "2026-07-01", v: 1100 },
            { t: "2026-07-02", v: 1060 },
            { t: "2026-07-03", v: 940 },
            { t: "2026-07-04", v: 700 },
            { t: "2026-07-05", v: 990 },
          ],
          provisionalFrom: "2026-07-05",
          collectedAt: "2026-07-05T11:45:00.000Z",
          timeZoneChanges: [],
        },
        bing: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
      },
    },
    executive: {
      schemaVersion: 1,
      asset: "meadow.example",
      generatedAt: "2026-07-05T11:30:00.000Z",
      windowStart: "2026-07-01",
      windowEnd: "2026-07-04",
      sourceArchiveCount: 12,
      items: [
        {
          key: "search-striking-distance",
          kind: "recommendation",
          title: "Move “weekly meal plan” into the top results",
          summary: "/meal-plan is visible at position 6.1 with existing demand.",
          whyItMatters: "The page already earns impressions below the highest-click positions.",
          primary: { value: "1,003", label: "captured impressions" },
          confidence: "high",
          windowStart: "2026-07-01",
          windowEnd: "2026-07-04",
          evidence: [{ label: "Average position", value: "6.1" }],
          sources: ["gsc/page-query", "bing-webmaster/queries"],
          caveat: "GSC returns top rows.",
        },
      ],
      suppressedItems: [],
      searchQueries: {
        google: {
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
              currentPosition: 6.1,
              previousPosition: 7.4,
              positionImprovement: 1.3,
            },
          ],
          // The lane's own pre-ranking check, reporting clean: a zero is a
          // statement, not an absence.
          evidence: [
            {
              label: "Grounding queries excluded",
              value: "0",
              detail: "No quoted-literal queries in this window",
            },
          ],
          source: "gsc/query",
          caveat: "Only queries present in both top-row windows are ranked.",
        },
        bing: null,
        dataforseo: {
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
              aioDevices: [],
            },
          ],
          source: "dataforseo/ranked-keywords",
          caveat: "Search volume is estimated demand, not impressions.",
        },
      },
      searchPages: null,
      productUse: null,
      searchIntelligence: null,
      serpPanel: null,
      methodology: ["Missing rows remain unknown."],
    },
    counters: null,
    metrics: [
      {
        name: "signups",
        last24h: 10,
        avg7d: 9.4,
        total: 4233,
        series: [{ t: "2026-07-05", v: 10 }],
      },
    ],
    flags: { open: [], notCurrent: [], snoozed: [], history: [], openError: 0, openWarn: 0 },
    ledger: { periods: [], recentRows: [], empty: true, currency: "USD" },
    decisions: [],
    handoffBeads: [],
    operator: {
      capturedAt: "2026-07-05T11:59:00.000Z",
      waiting: 0,
      urgent: 0,
      items: [],
    },
    annotations: { items: [], olderCount: 0 },
    watches: { open: [], closed: [], history: [] },
    reclamation: null,
    hygiene: null,
    fetchFailures: [],
    integrations: {
      sources: [],
      lanes: [],
      summary: {
        counts: { live: 0, degraded: 0, "needs-setup": 0, skipped: 0, "not-applicable": 0 },
        total: 0,
        needsAttention: 0,
      },
    },
    ga4Config: { valueEvents: null, eventParams: null },
    freshness: {
      pulseReceivedAt: "2026-07-05T02:00:00.000Z",
      ledgerRecordedAt: null,
      flagFiredAt: null,
      annotationAt: null,
    },
    panelReview: null,
    latestPanelDate: null,
    ...over,
  };
}

/** One mixed accounting month: $498.10 reconciled ad revenue beside $168.20 of
 * estimated affiliate revenue against a $22.10 estimated cost. */
const MIXED_LEDGER: AssetDetailPayload["ledger"] = {
  periods: [
    {
      period: "2026-06",
      booked: {
        figure: { currency: 'USD', revenue: 498.1, cost: 0, net: 498.1 },
        revenueByFamily: [{ currency: 'USD', family: "ads", amount: 498.1 }],
        costByFamily: [],
      },
      forecast: {
        figure: { currency: 'USD', revenue: 168.2, cost: 22.1, net: 146.1 },
        revenueByFamily: [{ currency: 'USD', family: "affiliate", amount: 168.2 }],
        costByFamily: [{ currency: 'USD', family: "inference", amount: 22.1 }],
      },
    },
  ],
  recentRows: [
    { currency: 'USD',
      id: 2,
      kind: "revenue",
      period: "2026-06",
      family: "ads",
      amount: 498.1,
      bookingState: "reconciled",
      source: "raptive-report",
      ref: null,
      note: null,
      recordedAt: "2026-07-03T00:00:00.000Z",
    },
    { currency: 'USD',
      id: 3,
      kind: "revenue",
      period: "2026-06",
      family: "affiliate",
      amount: 168.2,
      bookingState: "estimated",
      source: "cj-export",
      ref: null,
      note: null,
      recordedAt: "2026-06-30T00:00:00.000Z",
    },
  ],
  empty: false,
  currency: "USD",
};

/** An exact-window product-use snapshot, shared by the funnel test and the
 * deep-link test because `#product-use` only exists when an asset declares one. */
const productUseSnapshot: ProductUseSnapshot = {
  windowStart: "2026-07-02",
  windowEnd: "2026-07-29",
  days: 28,
  build: [
    {
      key: "item-openers",
      eventName: "builder_item_open",
      label: "Opened an item",
      users: 233,
      events: 649,
    },
    {
      key: "builder-users",
      eventName: "builder_add_to_order",
      label: "Added to an order",
      users: 85,
      events: 179,
    },
  ],
  sharing: [
    {
      key: "share-openers",
      eventName: "order_share_open",
      label: "Opened sharing",
      users: 1,
      events: 1,
    },
    {
      key: "share-completers",
      eventName: "order_share_complete",
      label: "Completed a share",
      users: null,
      events: null,
    },
    {
      key: "order-link-arrivals",
      eventName: "builder_deeplink_arrival",
      label: "Opened an order link",
      users: 9,
      events: 10,
    },
  ],
  supporting: [
    {
      key: "guide-follow-through",
      eventName: "guide_next_click",
      label: "Followed a guide",
      users: 365,
      events: 498,
    },
  ],
  source: "ga4/events-28d",
  caveat: "Users are unique within each event.",
};

function nomPayload(): AssetDetailPayload {
  const data = payload();
  data.asset = { ...data.asset, id: "northwind.example", displayName: "Northwind", domain: "northwind.example" };
  data.executive = {
    ...data.executive!,
    asset: "northwind.example",
    productUse: productUseSnapshot,
  };
  return data;
}

describe("AssetDetailRoute — Alerts speak the same language as the portfolio band", () => {
  const pullFailure = {
    id: 7,
    firedAt: "2026-07-01T02:30:00.000Z",
    severity: "warn" as const,
    kind: "anomaly" as const,
    metric: null,
    message: "pull failed: 401 unauthorized — token expired",
    ruleId: "asset-pull-failed",
    ruleInputs: {
      rule: "asset-pull-failed",
      url: "https://meadow.example/api/os/report",
      status: 401,
      error: "401 unauthorized — token expired",
      providerError: "unauthorized",
      failureCount: 5,
      lastFailedAt: "2026-07-05T02:30:00.000Z",
    },
    correlatedChanges: [
      {
        id: 3,
        at: "2026-06-30T12:30:00.000Z",
        kind: "config" as const,
        ref: "config@9f2c",
        note: "rotated the report token",
      },
    ],
    disposition: null,
    dispositionAt: null,
    dispositionNote: null,
    snoozeUntil: null,
    ackExpiry: null,
    resolvedAt: null,
    liveness: { state: "live" as const },
    occurrences: 1,
    firstFiredAt: "2026-07-01T02:30:00.000Z",
  };

  it("names the page heading by the asset, not by its favicon", async () => {
    stubFetch(200, payload());
    const { findByText } = renderRoute("meadow.example");
    await findByText("What matters");

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveAccessibleName(/^Meadow Board/);
    expect(heading).not.toHaveAccessibleName(/favicon/i);
    expect(screen.queryByTitle(/favicon/i)).toBeNull();
  });

  it("leads each alert with what happened and what to do, not the rule's evidence", async () => {
    stubFetch(200, payload({ flags: { open: [pullFailure], notCurrent: [], snoozed: [], history: [], openError: 0, openWarn: 1 } }));
    const { container, findByText } = renderRoute("meadow.example", "", "alerts");

    await findByText("Nightly report fetch failing 5 nights — latest: 401 unauthorized");
    expect(container.textContent).toContain("the fetch credentials may have expired");
    expect(container.textContent).not.toContain("https://meadow.example/api/os/report");
    openAlert("Nightly report fetch failing");
    expect(container.textContent).toContain("config change 14h before");
    expect(container.textContent).not.toContain("https://meadow.example/api/os/report");
    fireEvent.click(screen.getByRole("button", { name: /^Why this fired/ }));
    expect(screen.getByRole("dialog")).toHaveTextContent("https://meadow.example/api/os/report");
  });

  it("keeps the rule id in evidence instead of spending first-screen weight on it", async () => {
    stubFetch(200, payload({ flags: { open: [pullFailure], notCurrent: [], snoozed: [], history: [], openError: 0, openWarn: 1 } }));
    const { container, findByText } = renderRoute("meadow.example", "", "alerts");

    await findByText("Nightly report fetch failing 5 nights — latest: 401 unauthorized");
    expect(container.textContent).not.toContain("asset-pull-failed");
    openAlert("Nightly report fetch failing");
    expect(container.textContent).not.toContain("asset-pull-failed");
    fireEvent.click(screen.getByRole("button", { name: /^Why this fired/ }));
    expect(screen.getByRole("dialog")).toHaveTextContent("asset-pull-failed");
  });

  it("does not turn a stored live flag without verification evidence into a confirmed current condition", async () => {
    stubFetch(200, payload({ flags: { open: [pullFailure], notCurrent: [], snoozed: [], history: [], openError: 0, openWarn: 1 } }));
    const { findByText } = renderRoute("meadow.example", "", "alerts");
    const title = await findByText("Nightly report fetch failing 5 nights — latest: 401 unauthorized");
    const row = title.closest("li")!;
    expect(row).toHaveTextContent("Last known");
    expect(row).toHaveTextContent("first seen");
    expect(row).not.toHaveTextContent("Confirmed");
    expect(row.querySelector("button button")).toBeNull();
  });

  it("turns an asset-declared poisson signature into a decision headline", async () => {
    const declaredDrop = {
      ...pullFailure,
      id: 8,
      metric: "apiRequests",
      message: "last24h 51 vs avg7d 86.4 (rule poisson-24h, P<=0.000026)",
      ruleId: "asset-declared",
      ruleInputs: {
        source: "envelope",
        severity: "warn",
        kind: "anomaly",
        metric: "apiRequests",
        msg: "last24h 51 vs avg7d 86.4 (rule poisson-24h, P<=0.000026)",
      },
      correlatedChanges: [],
    };
    stubFetch(200, payload({ asset: { ...payload().asset, id: "northwind.example" }, flags: { open: [declaredDrop], notCurrent: [], snoozed: [], history: [], openError: 0, openWarn: 1 } }));
    const { container, findByText } = renderRoute("northwind.example", "", "alerts");

    await findByText("Api requests well below normal — 51 vs ~86/day");
    expect(container.textContent).not.toMatch(
      /last24h|avg7d|P<=|poisson-24h|asset-declared/,
    );
  });

  // One row per condition, aged from the onset: a condition is as old as it
  // has been true, not as old as tonight's re-reading.
  it("says how long a recurring condition has been running, in the Wall's chip", async () => {
    const onset = new Date(Date.now() - 26 * 86_400_000).toISOString();
    const recurring = {
      ...pullFailure,
      id: 9,
      metric: "apiRequests",
      message: "0 in last24h (avg7d 11.0)",
      ruleId: "asset-declared",
      ruleInputs: {
        source: "envelope",
        severity: "warn",
        kind: "anomaly",
        metric: "apiRequests",
        msg: "0 in last24h (avg7d 11.0)",
      },
      correlatedChanges: [],
      firedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
      occurrences: 16,
      firstFiredAt: onset,
    };
    stubFetch(
      200,
      payload({ asset: { ...payload().asset, id: "northwind.example" }, flags: { open: [recurring], notCurrent: [], snoozed: [], history: [], openError: 0, openWarn: 16 } }),
    );
    const { container, findByText, getByRole } = renderRoute("northwind.example", "", "alerts");

    await findByText(/16× in 26d/u);
    expect(container.textContent).toContain("16× in 26d");

    openRow("16× in 26d");
    expect(getByRole("button", { name: "Resolve alert" })).toBeTruthy();
    expect(container.textContent).toContain("26d");
    fireEvent.click(screen.getByRole("button", { name: /^Why this fired/ }));
    expect(screen.getByRole("dialog").textContent).toMatch(/First seen\s*·\s*26d ago/);
    expect(screen.getByRole("dialog").textContent).not.toMatch(/First seen\s*·\s*6h ago/);
  });

  it("parks a snoozed alert under Snoozed with Unsnooze, and History counts only what is settled", async () => {
    const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const parked = {
      ...pullFailure,
      id: 21,
      disposition: "snooze" as const,
      dispositionAt: new Date(Date.now() - 3_600_000).toISOString(),
      dispositionNote: "Snoozed by operator",
      snoozeUntil: until,
    };
    const resolved = {
      ...pullFailure,
      id: 22,
      message: "pull failed: 500 — upstream down",
      ruleInputs: null,
      correlatedChanges: [],
      resolvedAt: new Date(Date.now() - 7_200_000).toISOString(),
      liveness: { state: "historical" as const },
    };
    stubFetch(200, payload({
      flags: { open: [], notCurrent: [], snoozed: [parked], history: [resolved], openError: 0, openWarn: 0 },
    }));
    const { findByRole } = renderRoute("meadow.example", "", "alerts");

    const snoozed = await findByRole("region", { name: "Snoozed" });
    expect(snoozed).toHaveTextContent("1 parked");
    const row = within(snoozed).getByRole("listitem");
    expect(row).toHaveAttribute("data-visual-state", "snoozed");
    expect(row).not.toHaveTextContent("✓");
    openAlert("Nightly report fetch failing");
    expect(within(row).getByRole("button", { name: "Unsnooze alert" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Resolve alert" })).toBeNull();

    expect(screen.getByRole("region", { name: "History" })).toHaveTextContent("1 settled");
  });
});

/** A registry destination must exist on the actual route, outside closed
 * disclosure. Individual cases also assert the fact and its visual treatment. */
function materialAsset(container: HTMLElement, condition: MaterialCondition): HTMLElement {
  const destination = MATERIALITY[condition].asset;
  if (destination.placement === "not-applicable") throw new Error(`${condition} has no asset destination`);
  const element = container.querySelector<HTMLElement>(destination.selector);
  expect(element, `${condition}: ${destination.component}`).not.toBeNull();
  expect(element!.closest("details:not([open])")).toBeNull();
  expect(element).toBeVisible();
  return element!;
}

describe("AssetDetailRoute — material state on the current screens", () => {
  it("lists every scheduled job on Sources, with the failed one marked", async () => {
    const data = payload();
    data.asset = { ...data.asset, id: "root-os", displayName: "NoticeOS", domain: null, isOs: true };
    data.scheduledLanes = [
      { job: "backup", outcome: "failed", startedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() },
      { job: "beads-snapshot", outcome: "ran", startedAt: new Date(Date.now() - 3_600_000).toISOString() },
    ];
    stubFetch(200, data);
    const { container, findByText } = renderRoute("root-os", "", "sources");
    await findByText("Scheduled automation");
    const panel = materialAsset(container, "scheduled-lane-health");
    expect(panel.querySelectorAll("[data-scheduled-lane]")).toHaveLength(2);
    const failed = panel.querySelector('[data-scheduled-lane="backup"]');
    expect(failed).toHaveAttribute("data-outcome", "failed");
    expect(failed).toHaveTextContent("Backups");
    expect(failed).toHaveTextContent("2h ago");
    expect(failed?.querySelector("svg")).not.toBeNull();
    expect(panel.querySelector('[data-scheduled-lane="beads-snapshot"]')).toHaveAttribute("data-outcome", "ran");
  });

  it("keeps an unrecorded scheduler unknown on Sources", async () => {
    const data = payload({ scheduledLanes: [] });
    data.asset.isOs = true;
    stubFetch(200, data);
    const { container, findByText } = renderRoute("meadow.example", "", "sources");
    await findByText("Scheduled automation");
    const panel = materialAsset(container, "scheduled-lane-health");
    expect(panel.querySelector("[data-scheduled-empty]")).toHaveAttribute("data-lane-posture", "unknown");
    expect(panel.querySelector("[data-scheduled-empty] svg")).toHaveClass("text-warn");
    expect(panel).not.toHaveTextContent("All jobs reporting");
  });

  it("shows completed like-for-like growth on Overview with its actual chart", async () => {
    const data = payload();
    data.performance.activeUsers = {
      series: Array.from({ length: 14 }, (_, index) => ({
        t: new Date(Date.UTC(2026, 6, index + 1)).toISOString().slice(0, 10),
        v: index < 7 ? 100 : 120,
      })),
      provisionalFrom: null,
      collectedAt: new Date().toISOString(),
      timeZoneChanges: [],
    };
    stubFetch(200, data);
    const { container, findByText } = renderPath("/assets/meadow.example?range=7");
    await findByText("Avg. daily users");
    const users = container.querySelector('[data-kpi="Avg. daily users"]');
    expect(users).toHaveTextContent("120");
    expect(users).toHaveTextContent("20%");
    expect(container.querySelector("[data-hero-chart]")).not.toBeNull();
  });

  it("names unavailable comparisons and keeps a first report neutral in the real header", async () => {
    const data = payload();
    data.freshness.pulseReceivedAt = null;
    data.performance.activeUsers = { ...emptyTrend(), series: [{ t: "2026-07-14", v: 12 }] };
    stubFetch(200, data);
    const { container, findByText } = renderPath("/assets/meadow.example?range=7");
    await findByText("Avg. daily users");
    const report = materialAsset(container, "signal-freshness");
    expect(report).toHaveTextContent("No report");
    expect(report.querySelector("svg")).not.toBeNull();
    expect(report.querySelector(".lucide-check")).toBeNull();
    expect(container.querySelector('[data-kpi="Avg. daily users"]')).toHaveTextContent("No previous period");
    expect(report).not.toHaveTextContent("Healthy");
  });

  it("marks stale System reports in the header with words and a glyph", async () => {
    const data = payload();
    data.asset.isOs = true;
    data.freshness.pulseReceivedAt = new Date(Date.now() - 60 * 3_600_000).toISOString();
    stubFetch(200, data);
    const { container, findByRole } = renderRoute("meadow.example");
    await findByRole("heading", { name: /Meadow Board/ });
    for (const condition of ["signal-freshness", "os-runner-health"] as const) {
      const report = materialAsset(container, condition);
      expect(report).toHaveTextContent("stale");
      expect(report.querySelector('[data-age-glyph="stale"]')).not.toBeNull();
      expect(report.querySelector("[data-age-state]")).toHaveClass("text-warn");
    }
  });

  it("puts the human action and honest preview counts on Overview with links to the task and Tasks", async () => {
    const data = payload({ operator: {
      capturedAt: new Date().toISOString(), waiting: 6, urgent: 2,
      items: [{ id: "md-gate", title: "Approve the nutrition-source change", status: "open", priority: 2,
        issueType: "gate", assignee: null, updatedAt: new Date().toISOString(), closedAt: null, parent: null, deferUntil: null }],
    } });
    stubFetch(200, data);
    const { container, findByText } = renderRoute("meadow.example");
    await findByText("Needs you");
    const preview = materialAsset(container, "human-gates");
    expect(preview).toHaveTextContent("2 urgent · 6 waiting · 1 shown");
    expect(preview).toHaveTextContent("Approve the nutrition-source change");
    expect(preview).toHaveTextContent("△");
    expect(within(preview).getByRole("link", { name: /Approve the nutrition-source change/ })).toHaveAttribute("href", "/tasks/md-gate");
    expect(within(preview).getByRole("link", { name: /All tasks/ })).toHaveAttribute("href", "/assets/meadow.example/tasks");
  });

  it("keeps an unread task count unknown instead of certifying an empty inbox", async () => {
    stubFetch(200, payload({ operator: { capturedAt: null, waiting: null, urgent: null, items: [] } }));
    const { container, findByText } = renderRoute("meadow.example");
    await findByText("Needs you");
    const preview = materialAsset(container, "human-gates");
    expect(preview).toHaveTextContent("Count unavailable");
    expect(preview).toHaveTextContent("Tasks not read yet");
    expect(preview).not.toHaveTextContent("Nothing waiting");
    expect(preview).not.toHaveTextContent("0 urgent");
  });

  it("shows the latest change and the next outcome check directly on Activity", async () => {
    const data = payload();
    data.annotations.items = [{ id: 42, at: "2026-08-01T12:00:00.000Z", kind: "deploy", ref: "abc123", note: "Homepage answer-card experiment" }];
    data.freshness.annotationAt = data.annotations.items[0]!.at;
    data.watches.open = [{
      id: "watch-1", metricIntegration: "ga4", metric: "active_users", scope: null,
      refKind: "annotation", ref: "42", registeredAt: "2026-08-01T12:00:00.000Z",
      nextCheckDate: "2026-08-06", readings: 1, checks: 3, status: "open", outcome: null,
      outcomeNote: null, closedAt: null, note: "Homepage answer-card experiment",
    }];
    stubFetch(200, data);
    const { container, findByText } = renderRoute("meadow.example", "", "activity");
    await findByText("Timeline");
    const timeline = materialAsset(container, "active-changes");
    expect(timeline).toHaveTextContent("1 logged");
    expect(timeline).toHaveTextContent("Homepage answer-card experiment");
    const watches = materialAsset(container, "outcome-watches");
    expect(watches).toHaveTextContent("1 being watched");
    expect(watches).toHaveTextContent("Aug 6, 2026");
    expect(watches).toHaveTextContent("next check");
    expect(watches.querySelector('[data-watch-progress] [title="1 of 3 checks read"]')).not.toBeNull();
  });

  it("keeps error severity, anomaly kind, and an unanswered decline on the actual Alerts tab", async () => {
    const data = payload();
    data.flags.openError = 1;
    data.flags.open = [{
      id: 7, firedAt: "2026-08-04T23:58:00.000Z", severity: "error", kind: "anomaly",
      metric: "clicks", message: "watch window closed with a decline", ruleId: "watch-window-closed",
      ruleInputs: { outcome: "kill_confirmed", deltaPercent: -31 }, correlatedChanges: [],
      disposition: null, dispositionAt: null, dispositionNote: null, snoozeUntil: null, ackExpiry: null,
      resolvedAt: null, liveness: { state: "live" }, occurrences: 1, firstFiredAt: "2026-08-04T23:58:00.000Z",
    }];
    stubFetch(200, data);
    const { container, findByRole } = renderRoute("meadow.example", "", "alerts");
    await findByRole("region", { name: "Open" });
    const queue = materialAsset(container, "open-flags");
    const row = materialAsset(container, "rollback-failure");
    expect(queue).toContainElement(row);
    expect(row).toHaveAttribute("data-flag-kind", "anomaly");
    expect(row).toHaveAttribute("data-flag-severity", "error");
    expect(row).toHaveAttribute("data-visual-state", "error");
    expect(row).toHaveTextContent("△");
    expect(row).not.toHaveTextContent("Rollback complete");
  });
});

describe("AssetDetailRoute — executive page identity", () => {
  it("Daily metrics carries only flow columns — totals live on the asset card", async () => {
    // A total is stated once, on the asset card; a `Total` column here fails.
    stubFetch(200, payload());
    const { findByText } = renderRoute("meadow.example", "", "sources");

    const title = await findByText("Daily metrics");
    const section = title.closest(CARD);
    const headers = [...(section?.querySelectorAll("th") ?? [])].map(
      (th) => th.textContent,
    );
    expect(headers).toEqual(["Metric", "Latest report · 24h Jul 5", "Prior reports · avg / day", "History · daily counts"]);
    expect(headers).not.toContain("Total");
  });

  it("Sources names actual report dates and prior observations without smoothing daily counts", async () => {
    const data = payload();
    data.wiring.lastPulseDate = "2026-09-05";
    data.metrics = [{
      name: "signups", last24h: 59, avg7d: 999, total: null,
      series: [
        { t: "2026-09-01", v: 100 },
        { t: "2026-09-03", v: 140 },
        { t: "2026-09-05", v: 59 },
      ],
    }];
    stubFetch(200, data);
    const { findByText } = renderRoute("meadow.example", "", "sources");
    const section = (await findByText("Daily metrics")).closest(CARD)!;
    expect(section).toHaveTextContent("Latest report · 24h Sep 5");
    expect(section).toHaveTextContent("120.0 · 2 reports");
    fireEvent.click(screen.getByRole("button", { name: "Signups report details" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Sep 1–Sep 3");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Sep 1–Sep 5");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(section).toHaveTextContent("2 missing days");
    expect(section).not.toHaveTextContent("999");
    expect(section).not.toHaveTextContent("30-day");
    const chart = within(section as HTMLElement).getByRole("img", { name: "Signups daily report counts" });
    fireEvent.focus(chart);
    expect(screen.getByRole("status")).toHaveTextContent("Daily value: 59");
    expect(screen.getByRole("status")).not.toHaveTextContent("average");
    fireEvent.keyDown(chart, { key: "Home" });
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("Sep 2");
    expect(screen.getByRole("status")).toHaveTextContent("No report");
  });

  it("leads with the numbers and what matters, and leaves the analysis to Growth", async () => {
    stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example");

    const findings = await findByText("What matters");
    const strip = container.querySelector("[data-kpi-strip]")!;

    expect(
      strip.compareDocumentPosition(findings) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector("[data-hero-chart]")).not.toBeNull();
    expect(container.querySelector('section[aria-label="Needs you"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Where is growth moving?");
    expect(container.textContent).not.toContain("Can I trust the inputs?");
    expect(container.textContent).not.toContain("Jump to");
    expect(container.querySelector("details[id]")).toBeNull();
    expect(container.textContent).not.toContain("Performance");
    expect(container.textContent).not.toContain("Query decisions");
    expect(container.querySelector("#configuration")).toBeNull();
    expect(container.textContent).toContain("Move “weekly meal plan” into the top results");
    expect(container.textContent).not.toContain("GSC · Page Query");
    expect(
      container.querySelectorAll('button[title^="Copy this finding"]'),
    ).toHaveLength(0);
    expect(container.textContent).not.toContain("Totals");
  });

  it("keeps the Growth tab's four charts on Growth and its decisions on Search", async () => {
    stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example", "", "growth");

    await findByText("Audience");
    expect(container.textContent).toContain("Active users");
    expect(container.textContent).toContain("Sessions");
    expect(container.textContent).toContain("Clicks");
    expect(container.textContent).toContain("Impressions");
    expect(container.textContent).not.toContain("Query decisions");
    expect(container.textContent).not.toContain("Page decisions");
    expect(container.textContent).not.toContain("What matters now");
    expect(container.querySelector("table")).toBeNull();
  });

  it("stands the state block down on every tab", async () => {
    stubFetch(200, payload());
    for (const tab of ASSET_TABS) {
      const view = renderRoute("meadow.example", "", tab === "overview" ? "" : tab);
      await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
      expect(view.container.querySelector("#alerts-title")).toBeNull();
      view.unmount();
    }
  });

  it("puts the query decisions on Search, collapsed to their movers", async () => {
    stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example", "", "search");

    await findByText("Query decisions");
    expect(container.textContent).toContain("Current review set · 1");
    expect(container.textContent).toContain("Latest 2 days vs prior 2");
    expect(container.textContent).not.toContain("reported dates");
    expect(container.textContent).toContain("140");
    expect(container.textContent).toContain("Near win");
    const row = container.querySelector<HTMLDetailsElement>(
      "[data-decision-collapsed]",
    )!;
    expect(row.open).toBe(false);
    expect(row.textContent).toContain("weekly meal plan");
    expect(row.textContent).toContain("impressions");
    expect(row.textContent).toContain("searches/month");
    expect(row.textContent).toContain("Cited source #2");
    expect(row.textContent).toContain("Copy Markdown");
  });

  it("explains recorded changes at their own markers instead of listing them above the charts", async () => {
    const few = payload();
    few.annotations = {
      items: [
        {
          id: 41,
          at: "2026-07-04T09:00:00.000Z",
          kind: "deploy",
          ref: null,
          note: "July title batch. The rest of this note is on Activity.",
        },
      ],
      olderCount: 0,
    };
    stubFetch(200, few);
    const one = renderRoute("meadow.example", "", "growth");
    await one.findByText("Audience");
    const activeUsers = one.container.querySelector<HTMLElement>('[data-growth-chart="Active users"]')!;
    const marker = within(activeUsers).getByRole("button", { name: "Event on Jul 4, 2026: July title batch" });
    expect(one.container.textContent).not.toContain("July title batch");
    fireEvent.focus(marker);
    expect(screen.getByRole("tooltip")).toHaveTextContent("July title batch. The rest of this note is on Activity.");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Jul 4, 2026");
    expect(one.container.querySelector("#performance [data-section-events]")).toBeNull();
    one.unmount();

    const many = payload();
    many.annotations = {
      items: Array.from({ length: 5 }, (_, index) => ({
        id: 100 + index,
        at: `2026-07-0${index + 1}T09:00:00.000Z`,
        kind: "deploy" as const,
        ref: null,
        note: `Batch ${index + 1}`,
      })),
      olderCount: 0,
    };
    stubFetch(200, many);
    const lots = renderRoute("meadow.example", "", "growth");
    await lots.findByText("Audience");
    const marked = lots.container.querySelector<HTMLElement>('[data-growth-chart="Active users"]')!;
    expect(within(marked).getAllByRole("button", { name: /Event on .*: Batch/ })).toHaveLength(5);
    expect(lots.container.querySelector("#performance [data-section-events]")).toBeNull();
    expect(lots.container.querySelector("#performance [data-section-mark]")).toBeNull();
  });

  it("gives a collapsed decision row one tone encoding, not two", async () => {
    stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example", "", "search");

    await findByText("Query decisions");
    const row = container.querySelector<HTMLDetailsElement>(
      "[data-decision-collapsed]",
    )!;
    expect(row.className).not.toContain("border-l");
    expect(row.getAttribute("data-decision-tone")).toBeTruthy();
    expect(row.querySelector("svg")).not.toBeNull();
  });

  it("shows Northwind product use as one strip without inventing missing shares", async () => {
    stubFetch(200, nomPayload());
    const { container, findByText } = renderRoute("northwind.example", "", "growth");

    await findByText("Audience");
    const strip = container.querySelector("#product-use")!;
    expect(container.querySelectorAll("#product-use")).toHaveLength(1);
    expect(strip.textContent).toContain("last 28 days");
    expect(strip.querySelector("[data-info-tooltip-trigger]")).toBeNull();
    expect(strip.textContent).toContain("233");
    expect(strip.textContent).toContain("85");
    const rate = container.querySelector('[data-small-multiple="Added of opened"]')!;
    expect(rate.textContent).toContain("36%");
    expect(rate.parentElement!.textContent).toContain("85 of 233");
    expect(rate.hasAttribute("title")).toBe(false);
    expect(strip.textContent).not.toMatch(/conversion/i);
    const share = container.querySelector('[data-small-multiple="Completed a share"]')!;
    expect(share.textContent).toContain("—");
    expect(share.parentElement!.textContent).toContain("none recorded");
  });

  it("keeps the product-use snapshot's fixed window when the traffic range changes", async () => {
    stubFetch(200, nomPayload());
    const view = renderRoute("northwind.example", "", "growth");
    await view.findByText("Audience");
    const productUse = view.container.querySelector<HTMLElement>("#product-use")!;
    expect(within(productUse).getByRole("heading", { name: "Product use · last 28 days" })).toBeInTheDocument();
    expect(productUse).toHaveTextContent("Jul 2–29, 2026");
    const snapshot = productUse.textContent;

    fireEvent.click(view.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(view.getByTestId("path")).toHaveTextContent("/assets/northwind.example/growth?range=7"));
    expect(productUse.textContent).toBe(snapshot);
    expect(productUse).toHaveTextContent("233");
    expect(productUse).toHaveTextContent("85");
  });

  it("renders the PostHog product section from the snapshot, with its own windows that the range never moves", async () => {
    const data = payload();
    data.executive = { ...data.executive!, product: parseProductSnapshot(posthogProductJson) };
    stubFetch(200, data);
    const view = renderRoute("meadow.example", "", "growth");
    await view.findByText("Audience");
    const product = view.container.querySelector<HTMLElement>("[data-product-journey]")!;
    expect(within(product).getByRole("heading", { name: "Product" })).toBeInTheDocument();
    const breaks = within(product).getByRole("region", { name: "Where it breaks" });
    expect(within(breaks).getByRole("heading", { name: "/calculator 6 found" })).toBeInTheDocument();
    expect(breaks).toHaveTextContent("Chrome OS Desktop");
    expect(product).toHaveTextContent("6.5% finish · 8.2% the week before");
    expect(product).toHaveTextContent("Aug 26–Sep 22, 2026");
    const before = product.textContent;

    fireEvent.click(view.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(view.getByTestId("path")).toHaveTextContent("/assets/meadow.example/growth?range=7"));
    expect(product.textContent).toBe(before);
  });

  it("puts each tab in the URL and mounts only the active tab's sections", async () => {
    stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example");

    await findByText("What matters");
    const bar = container.querySelector('[role="tablist"]')!;
    expect(bar.getAttribute("aria-label")).toBe("Site sections");
    const tabs = [...bar.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual([
      "Overview",
      "Growth",
      "Money",
      "Search",
      "Alerts",
      "Tasks",
      "Activity",
      "Data sources",
      "Settings",
    ]);
    expect(tabs.map((t) => t.getAttribute("href"))).toEqual([
      "/assets/meadow.example",
      "/assets/meadow.example/growth",
      "/assets/meadow.example/financials",
      "/assets/meadow.example/search",
      "/assets/meadow.example/alerts",
      "/assets/meadow.example/tasks",
      "/assets/meadow.example/activity",
      "/assets/meadow.example/sources",
      "/assets/meadow.example/settings",
    ]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
      "-1",
      "-1",
      "-1",
      "-1",
      "-1",
      "-1",
    ]);
    const panel = container.querySelector('[role="tabpanel"]')!;
    expect(panel.getAttribute("aria-labelledby")).toBe("asset-tab-overview");
    expect(panel.querySelector("#insights")).not.toBeNull();
    for (const id of [
      "#performance",
      "#search-evidence",
      "#timeline",
      "#integrations",
      "#configuration",
    ]) {
      expect(container.querySelector(id)).toBeNull();
    }
  });

  it("keeps the chosen range between tabs and only shows it where it changes the data", async () => {
    stubFetch(200, payload());
    const view = renderPath("/assets/meadow.example?range=7");
    await view.findByRole("tab", { name: "Overview" });
    expect(view.getByText("Traffic period")).toBeVisible();
    expect(within(view.getByRole("group", { name: "Traffic period" })).getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(view.getByRole("tab", { name: "Growth" }));
    await waitFor(() => expect(view.getByTestId("path")).toHaveTextContent("/assets/meadow.example/growth?range=7"));
    const growthRange = view.getByRole("group", { name: "Traffic period" });
    expect(within(growthRange).getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(growthRange).getByRole("button", { name: "90d" }));
    await waitFor(() => expect(view.getByTestId("path")).toHaveTextContent("/assets/meadow.example/growth?range=90"));

    for (const [name, path] of [
      ["Search", "search"],
      ["Alerts", "alerts"],
      ["Tasks", "tasks"],
      ["Activity", "activity"],
      ["Data sources", "sources"],
      ["Settings", "settings"],
    ]) {
      fireEvent.click(view.getByRole("tab", { name }));
      await waitFor(() => expect(view.getByTestId("path")).toHaveTextContent(`/assets/meadow.example/${path}?range=90`));
      expect(view.queryByRole("group", { name: "Traffic period" })).toBeNull();
      expect(view.queryByText("Traffic period")).toBeNull();
    }

    fireEvent.click(view.getByRole("tab", { name: "Overview" }));
    await waitFor(() => expect(view.getByTestId("path")).toHaveTextContent("/assets/meadow.example?range=90"));
    expect(within(view.getByRole("group", { name: "Traffic period" })).getByRole("button", { name: "90d" })).toHaveAttribute("aria-pressed", "true");
  });

  it("moves focus along the tab bar with the arrow keys, Home and End", async () => {
    stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example");

    await findByText("What matters");
    const bar = container.querySelector<HTMLElement>('[role="tablist"]')!;
    const tabs = [...bar.querySelectorAll<HTMLElement>('[role="tab"]')];
    tabs[0]!.focus();

    const last = tabs.length - 1;
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(bar, { key: "End" });
    expect(document.activeElement).toBe(tabs[last]);
    fireEvent.keyDown(bar, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(bar, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tabs[last]);
    fireEvent.keyDown(bar, { key: "Home" });
    expect(document.activeElement).toBe(tabs[0]);
  });

  it("carries each tab's own state — open alerts, running checks, source health", async () => {
    const data = payload({
      flags: {
        open: [
          {
            id: 91,
            firedAt: "2026-07-05T02:30:00.000Z",
            severity: "error",
            kind: "anomaly",
            metric: "signups",
            message: "22 in last24h (avg7d 39.3)",
            ruleId: "poisson-low",
            ruleInputs: null,
            correlatedChanges: [],
            disposition: null,
            dispositionAt: null,
            dispositionNote: null,
            snoozeUntil: null,
            ackExpiry: null,
            resolvedAt: null,
            liveness: { state: "live" },
            occurrences: 1,
            firstFiredAt: "2026-07-05T02:30:00.000Z",
          },
        ],
        notCurrent: [],
        snoozed: [],
        history: [],
        openError: 1,
        openWarn: 0,
      },
    });
    data.asset = { ...data.asset, worstOpenSeverity: "error", openError: 1 };
    data.integrations = {
      ...data.integrations,
      sources: [
        { id: "gsc", label: "Google Search Console", state: "live", observedAt: new Date(Date.now() - 60_000).toISOString(), verification: { kind: "collection-success", laneId: "gsc" } },
        { id: "ga4", label: "Google Analytics", state: "degraded", observedAt: "2026-07-05T10:00:00.000Z" },
      ],
      summary: {
        counts: { live: 5, degraded: 1, "needs-setup": 2, skipped: 0, "not-applicable": 1 },
        total: 8,
        needsAttention: 3,
      },
    };
    googleAnswers([{ capability: "gsc-daily", state: "healthy" }, { capability: "ga4-daily", state: "failing" }]);
    stubFetch(200, data);
    const { container, findByText } = renderRoute("meadow.example");

    await findByText("What matters");
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    const alerts = tabs.find((t) => t.textContent?.startsWith("Alerts"))!;
    expect(alerts.textContent).toBe("Alerts1");
    expect(alerts.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Error",
    );
    const sources = tabs.find((t) => t.textContent?.startsWith("Data sources"))!;
    expect(sources.querySelector("[data-sources-ratio]")).toBeNull();
    expect(sources.textContent).toBe("Data sources");
    expect(sources.querySelector('[role="img"]')).toHaveAttribute("aria-label", "Error");
    expect(sources).toHaveAttribute("title", "1 working · 1 failing");
    expect(tabs[0]!.textContent).toBe("Overview");
    expect(tabs[1]!.textContent).toBe("Growth");
    expect(tabs[2]!.textContent).toBe("Money");
    expect(tabs[3]!.textContent).toBe("Search");
    expect(tabs[5]!.textContent).toBe("Tasks");
    expect(tabs[6]!.textContent).toBe("Activity");
  });

  it.each([undefined, null, "not-a-date"])("never shows a provider's source Working in the header before its reads answer (observation: %s)", async (observedAt) => {
    const data = payload();
    data.integrations = {
      ...data.integrations,
      sources: [{ id: "ga4", label: "Google Analytics", state: "live", observedAt }],
      summary: {
        counts: { live: 5, degraded: 0, "needs-setup": 0, skipped: 0, "not-applicable": 0 },
        total: 5,
        needsAttention: 0,
      },
    };
    stubFetch(200, data);
    const view = renderRoute("meadow.example", "", "sources");
    const heading = await view.findByRole("heading", { name: /Meadow Board/u, level: 1 });
    expect(headerStatuses(heading)).toEqual(["Google Analytics: Unknown"]);
    const unknown = heading.closest("header")!.querySelector('[data-connection="unknown"]');
    expect(unknown?.querySelector('[data-state-mark="unknown"]')).not.toBeNull();
    expect(unknown?.querySelector('[data-state-mark="check"]')).toBeNull();
    expect(heading).not.toHaveTextContent("Unknown");
    expect(view.container.querySelector("#integrations")).not.toHaveTextContent("working");
    expect(view.getByRole("tab", { name: "Data sources" }).querySelector("[data-sources-ratio]")).toBeNull();
  });

  it("shows a working source in the header from its reads, even during manual onboarding", async () => {
    googleAnswers([{ capability: "ga4-daily", state: "healthy" }]);
    const data = payload();
    data.asset = { ...data.asset, status: "onboarding" };
    data.integrations = {
      ...data.integrations,
      sources: [{ id: "ga4", label: "Google Analytics", state: "live", observedAt: new Date(Date.now() - 60_000).toISOString(), verification: { kind: "collection-success", laneId: "ga4" } }],
    };
    stubFetch(200, data);
    const view = renderRoute("meadow.example", "", "sources");
    const heading = await view.findByRole("heading", { name: /Meadow Board/u, level: 1 });
    expect(headerStatuses(heading)).toEqual(["Google Analytics: Working"]);
    expect(within(heading).queryByText("Onboarding")).toBeNull();
  });

  it("names an older nightly report separately from a current Bing collection", async () => {
    const data = payload();
    data.freshness.pulseReceivedAt = new Date(Date.now() - 72 * 60 * 60_000).toISOString();
    data.integrations = { ...data.integrations, sources: [{
      id: "bing-webmaster", label: "Bing Webmaster Tools", state: "live",
      observedAt: new Date(Date.now() - 60_000).toISOString(),
      verification: { kind: "collection-success", laneId: "bing-webmaster" },
    }] };
    stubFetch(200, data);
    const view = renderRoute("meadow.example", "", "growth");
    const heading = await view.findByRole("heading", { name: /Meadow Board/u, level: 1 });
    const header = heading.closest("header")!;
    expect(headerStatuses(heading)).toEqual(["Bing Webmaster Tools: Unknown"]);
    expect(within(header).queryByText("Reported", { exact: true })).toBeNull();
    const report = header.querySelector<HTMLElement>("[data-nightly-report-age]")!;
    expect(report).toHaveTextContent("Nightly report3d");
    expect(report.querySelector("[data-age-state]")).toHaveAttribute("data-age-state", "aged");
    expect(report.querySelector("[data-age-state]")).toHaveClass("text-warn");
    expect(report).toHaveClass("inline-flex", "whitespace-nowrap");
    expect(report.parentElement).toHaveClass("flex-wrap");
  });

  it("names an absent nightly report as the neutral No report, never an amber never", async () => {
    const data = payload();
    data.freshness.pulseReceivedAt = null;
    stubFetch(200, data);
    const view = renderRoute("meadow.example", "", "growth");
    const heading = await view.findByRole("heading", { name: /Meadow Board/u, level: 1 });
    const header = heading.closest("header")!;
    expect(header.querySelector("[data-nightly-report-age]")).toBeNull();
    expect(header.querySelector("[data-age-state]")).toBeNull();
    const none = header.querySelector<HTMLElement>('[data-nightly-report="none"]')!;
    expect(none).toHaveTextContent("No report");
    expect(none).toHaveClass("text-muted-foreground");
    expect(header.querySelector(".text-warn")).toBeNull();
  });

  it.each(["legacy-date", "stale", "future", "wrong-source"])("does not let %s nightly-report evidence verify the header or the tab's count", async (kind) => {
    const data = payload();
    data.integrations = { ...data.integrations, sources: [{
      id: "nightly-report", label: "Nightly report", state: "live",
      observedAt: new Date(Date.now() + (kind === "future" ? 86_400_000 : kind === "stale" ? -3 * 86_400_000 : -60_000)).toISOString(),
      verification: kind === "legacy-date" ? undefined : { kind: "collection-success", laneId: kind === "wrong-source" ? "gsc" : "nightly-report" },
    }] };
    stubFetch(200, data);
    const view = renderRoute("meadow.example", "", "sources");
    const heading = await view.findByRole("heading", { name: /Meadow Board/u, level: 1 });
    expect(headerStatuses(heading)).toEqual(["Nightly report: Not checked"]);
    expect(view.getByRole("tab", { name: "Data sources" }).getAttribute("title") ?? "").not.toContain("working");
  });

  it("drops the query-decision entry when the asset has no search evidence", async () => {
    const data = payload();
    data.performance = {
      ...noSecondarySeries(),
      activeUsers: emptyTrend(),
      webSearchClicks: { google: emptyTrend(), bing: emptyTrend() },
      webSearchImpressions: { google: emptyTrend(), bing: emptyTrend() },
    };
    data.executive = { ...data.executive!, searchQueries: null };
    stubFetch(200, data);
    const { container } = renderRoute("meadow.example", "", "search");

    await waitFor(() => expect(container.querySelector("#search-evidence")).not.toBeNull());
    expect(container.querySelector("#query-visibility")).toBeNull();
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toBe("Search");
    expect(container.textContent).not.toContain("Query decisions");
  });

  it("shows the movers lane proving its grounding check ran, even at zero", async () => {
    stubFetch(200, payload());
    const { container, findAllByText } = renderRoute("meadow.example", "", "search");

    await findAllByText("Query decisions");
    const lane = container.querySelector('[data-lane-evidence="google"]');
    expect(lane?.textContent).toContain("Grounding queries excluded");
    expect(lane?.textContent).toContain("No quoted-literal queries in this window");
    expect(container.textContent).toContain("Sources and limits · 1 check run");
  });

  it("marks findings to the top and records the decision in the OS", async () => {
    const fetchMock = stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example");

    await findByText("What matters");
    const disclosure = container.querySelector<HTMLElement>("[data-all-findings]")!;
    fireEvent.click(within(disclosure).getByText(/All findings/));
    const list = within(disclosure);
    fireEvent.click(await list.findByRole("button", { name: "Mark" }));

    const write = await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/decisions"),
      );
      expect(call).toBeDefined();
      return call!;
    });
    expect(String(write[0])).toBe("/api/assets/meadow.example/decisions");
    expect(write[1]?.method).toBe("POST");
    expect(JSON.parse(String(write[1]?.body))).toEqual({
      kind: "finding",
      key: "search-striking-distance",
      status: "marked",
    });
    expect(
      window.localStorage.getItem("noticeos:property-findings:meadow.example"),
    ).toBeNull();

    fireEvent.click(list.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(
        list.queryByText("Move “weekly meal plan” into the top results"),
      ).toBeNull(),
    );

    fireEvent.click(list.getByRole("button", { name: "Review 1 dismissed" }));
    expect(
      await list.findByText("Move “weekly meal plan” into the top results"),
    ).toBeTruthy();
    fireEvent.click(list.getByRole("button", { name: "Restore" }));
    expect(list.getByRole("button", { name: "Mark" })).toBeTruthy();
  });
});

describe("AssetDetailRoute — recommendation applicability", () => {
  function reviewedPayload() {
    const data = payload();
    data.executive = { ...data.executive!, generatedAt: "2026-08-05T12:00:00Z" };
    data.operator = { ...data.operator, capturedAt: new Date(Date.now() - 30_000).toISOString() };
    data.recommendationEvidence = { available: true, truncated: false, reports: [
      { source: "gsc/page-query", reportDate: "2026-09-04", collectedAt: "2026-09-05T10:00:00Z", status: "success" },
      { source: "gsc/query", reportDate: "2026-09-04", collectedAt: "2026-09-05T10:00:00Z", status: "success" },
      { source: "gsc/page", reportDate: "2026-09-04", collectedAt: "2026-09-05T10:00:00Z", status: "success" },
    ] };
    return data;
  }

  it("shows newer family reports beside the saved Overview finding and retains original confidence", async () => {
    const data = reviewedPayload();
    data.executive!.items[0]!.evidence = [{ label: "Current organic rank", value: "#16" }, ...data.executive!.items[0]!.evidence];
    stubFetch(200, data);
    const view = renderRoute("meadow.example");
    const panel = await view.findByRole("region", { name: "What matters" });
    const row = within(panel).getByText("Move “weekly meal plan” into the top results").closest("li")!;
    expect(row).toHaveTextContent("Original analysis: high confidence");
    expect(row).not.toHaveTextContent("Analysis Aug 5, 2026");
    expect(row).toHaveTextContent("Newer source reports");
    expect(row).toHaveTextContent("Rank at analysis");
    expect(row).not.toHaveTextContent("Current organic rank");
    const summary = row.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    fireEvent.click(summary);
    const validity = summary.querySelector<HTMLElement>("[data-recommendation-validity]")!;
    expect(validity).toHaveClass("whitespace-normal");
    expect(validity.parentElement).toHaveClass("whitespace-normal");
    expect(validity.parentElement).not.toHaveClass("truncate");
    expect(validity).toHaveTextContent("Newer source reports");
    fireEvent.click(summary);
    fireEvent.click(within(row).getByRole("button", { name: "About this recommendation's applicability" }));
    const tooltip = view.getByRole("tooltip");
    const source = tooltip.querySelector<HTMLElement>("[data-source='gsc/page-query']")!;
    expect(source).toHaveTextContent("Search Console");
    expect(source).toHaveTextContent("Page query");
    expect(source).toHaveTextContent("Sep 4");
    expect(tooltip).toHaveTextContent("Newer source reports");
  });

  it("puts File task on every What matters row, and only once", async () => {
    stubFetch(200, reviewedPayload());
    const view = renderRoute("meadow.example");
    const panel = await view.findByRole("region", { name: "What matters" });
    const rows = [...panel.querySelectorAll<HTMLElement>("li[data-finding-row]")];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(within(row).getAllByRole("button", { name: /^File task for / })).toHaveLength(1);
      expect(row.querySelector("[data-list-row-actions]")).toContainElement(
        within(row).getByRole("button", { name: /^File task for / }),
      );
    }
  });

  it("keeps a finding after linked closure and names the review, not a resolved outcome", async () => {
    const data = reviewedPayload();
    data.handoffBeads = [{ kind: "finding", key: data.executive!.items[0]!.key, beadId: "md-fixture", status: "closed", closedAt: "2026-08-06T12:00:00Z" }];
    stubFetch(200, data);
    const view = renderRoute("meadow.example");
    const panel = await view.findByRole("region", { name: "What matters" });
    expect(panel).toHaveTextContent("Review after linked work");
    const disclosure = view.container.querySelector<HTMLElement>("[data-all-findings]")!;
    fireEvent.click(within(disclosure).getByText(/All findings/u));
    await waitFor(() => expect(disclosure.querySelector("[data-insight-kind]")).not.toBeNull());
    const insight = disclosure.querySelector<HTMLElement>("[data-insight-kind]")!;
    expect(insight).toHaveTextContent("Review after linked work");
    fireEvent.click(within(insight).getByRole("button", { name: "About this recommendation's applicability" }));
    const task = view.getByRole("tooltip").querySelector<HTMLElement>("[data-fact='task']")!;
    expect(task).toHaveAttribute("data-task-status", "closed");
    expect(task).toHaveTextContent("md-fixture");
    expect(task).toHaveTextContent("since analysis");
  });

  it("query and page actions keep their own source windows and carry review caveats into copied briefs", async () => {
    const data = reviewedPayload();
    data.executive!.searchPages = {
      provider: "google", currentStart: "2026-06-29", currentEnd: "2026-07-05", previousStart: "2026-06-22", previousEnd: "2026-06-28", daysPerWindow: 7,
      source: "gsc/page", evidence: [], caveat: "Only reported pages are represented.",
      pages: [{ page: "https://meadow.example/meal-plan", path: "/meal-plan", currentClicks: 5, previousClicks: 40, clickDelta: -35, clickDeltaPercent: -87.5,
        currentImpressions: 1000, previousImpressions: 1000, impressionDelta: 0, impressionDeltaPercent: 0, currentCtr: 0.005, previousCtr: 0.04,
        currentPosition: 7, previousPosition: 7, positionImprovement: 0, leadingQuery: null }],
    };
    stubFetch(200, data);
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      const view = renderRoute("meadow.example", "", "search");
      await view.findByRole("heading", { name: "Query decisions" });
      const query = view.container.querySelector<HTMLElement>("[data-decision-collapsed]")!;
      const page = view.container.querySelector<HTMLElement>("[data-page-decision-collapsed]")!;
      expect(view.container.querySelector("[data-analysis-evidence]")).toHaveTextContent("Newer source reports");
      expect(view.container.querySelector("[data-query-decisions-validity]")).toBeNull();
      expect(view.container.querySelector("[data-page-decisions-validity]")).toBeNull();
      expect(query).not.toHaveTextContent("Newer source reports");
      expect(page).not.toHaveTextContent("Newer source reports");
      for (const [row, copyName] of [[query, "Copy Markdown for weekly meal plan"], [page, "Copy Markdown for /meal-plan"]] as const) {
        fireEvent.click(row.querySelector("summary")!);
        fireEvent.click(within(row).getByRole("button", { name: copyName }));
        await waitFor(() => expect(writeText).toHaveBeenCalled());
        const copied = String(writeText.mock.calls.at(-1)?.[0]);
        expect(copied).toContain("Analysis saved 2026-08-05T12:00:00.000Z");
        expect(copied).toContain("Recheck the latest reports, linked work and the site before acting.");
        expect(copied).toContain("latest report 2026-09-04 success");
        writeText.mockClear();
      }
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
    }
  });

  it("a decision list states its own applicability only where it differs from the tab's line", async () => {
    const data = reviewedPayload();
    data.recommendationEvidence!.reports = data.recommendationEvidence!.reports.filter(
      (report) => report.source !== "gsc/page-query",
    );
    data.executive!.searchPages = {
      provider: "google", currentStart: "2026-06-29", currentEnd: "2026-07-05", previousStart: "2026-06-22", previousEnd: "2026-06-28", daysPerWindow: 7,
      source: "gsc/page", evidence: [], caveat: "Only reported pages are represented.",
      pages: [{ page: "https://meadow.example/meal-plan", path: "/meal-plan", currentClicks: 5, previousClicks: 40, clickDelta: -35, clickDeltaPercent: -87.5,
        currentImpressions: 1000, previousImpressions: 1000, impressionDelta: 0, impressionDeltaPercent: 0, currentCtr: 0.005, previousCtr: 0.04,
        currentPosition: 7, previousPosition: 7, positionImprovement: 0, leadingQuery: null }],
    };
    stubFetch(200, data);
    const view = renderRoute("meadow.example", "", "search");
    await view.findByRole("heading", { name: "Query decisions" });
    expect(view.container.querySelector("[data-analysis-evidence]")).toHaveTextContent(/^Analysis .+ ago$/);
    expect(view.container.querySelector("[data-query-decisions-validity]")).toHaveTextContent("Newer source reports");
    expect(view.container.querySelector("[data-page-decisions-validity]")).toHaveTextContent("Newer source reports");
    expect(view.container.querySelector("[data-decision-collapsed]")).not.toHaveTextContent("Newer source reports");
  });
});

describe("AssetDetailRoute — the setup checklist", () => {
  /** An asset mid-onboarding: named, one lane still unconfigured, a first report
   * nine days old. Two of four items resolved. */
  function settingUp(): AssetDetailPayload {
    const base = payload();
    return {
      ...base,
      asset: {
        ...base.asset,
        status: "onboarding",
        firstReportAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
        reportDays: 9,
      },
      integrations: {
        ...base.integrations,
        sources: [
          { id: "nightly-report", label: "Nightly report", state: "live", observedAt: "2026-07-05T11:00:00.000Z" },
          { id: "gsc", label: "Google Search Console", state: "live", observedAt: "2026-07-05T10:00:00.000Z" },
          { id: "ga4", label: "Google Analytics 4", state: "needs-setup" },
          {
            id: "bing-webmaster",
            label: "Bing Webmaster Tools",
            state: "skipped",
            detail: "Declined for now — almost no Bing traffic.",
          },
        ],
      },
    };
  }

  it("does not render at all for a live asset", async () => {
    stubFetch(200, payload());
    const { container, findAllByText } = renderRoute("meadow.example", "", "sources");

    await findAllByText("Data sources");
    expect(container.querySelector("[data-setup-checklist]")).toBeNull();
    expect(container.querySelector("[data-progress-ring]")).toBeNull();
    expect(container.textContent).not.toContain("Data setup");
  });

  it("leads Sources with four counted items and an unavailable nonactionable pause check", async () => {
    stubFetch(200, settingUp());
    const { container, findByText } = renderRoute("meadow.example", "", "sources");

    await findByText(/^Data setup ·/);
    const items = [...container.querySelectorAll("[data-setup-item]")].map(
      (el) => [
        el.getAttribute("data-setup-item"),
        el.getAttribute("data-setup-state"),
      ],
    );
    expect(items).toEqual([
      ["identity", "done"],
      ["sources", "pending"],
      ["first-report", "done"],
      ["baseline", "pending"],
      ["pause-check", "unavailable"],
    ]);
    expect(container.querySelector("[data-progress-ring]")).toBeNull();
    expect(
      container.querySelector("[data-setup-checklist]")!.closest("details")!.textContent,
    ).toContain("2 of 4 done");
    expect(container.querySelector("[data-setup] summary")!.textContent).toBe("Data setup · 2 of 4 done");
    expect(container.querySelector('[role="tabpanel"]')!.textContent).not.toMatch(/checks complete|Setting up/u);
    const pause = container.querySelector('[data-setup-item="pause-check"]')!;
    expect(pause).toHaveTextContent("Pause check");
    expect(pause).toHaveTextContent("Unavailable · Agent execution is manual.");
    expect(pause).not.toHaveTextContent(/still to do|done/u);
    expect(pause.querySelector("a,button,input")).toBeNull();
  });

  it("sends each item to where it is actually done", async () => {
    stubFetch(200, settingUp());
    const { container, findByText } = renderRoute("meadow.example", "", "sources");

    await findByText(/^Data setup ·/);
    const href = (id: string) =>
      container
        .querySelector(`[data-setup-item="${id}"] a`)
        ?.getAttribute("href");

    expect(href("identity")).toBe("/assets/meadow.example/settings");
    expect(href("sources")).toBe("/assets/meadow.example/sources");
    expect(href("first-report")).toBe("/health");
    expect(href("baseline")).toBe("/health");
  });

  it("counts the sources without repeating each one's status, which its Data sources row carries", async () => {
    googleAnswers([{ capability: "gsc-daily", state: "healthy" }]);
    stubFetch(200, settingUp());
    const { container, findByText } = renderRoute("meadow.example", "", "sources");

    await findByText(/^Data setup ·/);
    expect(container.querySelector("[data-setup-source]")).toBeNull();
    const step = container.querySelector('[data-setup-item="sources"]')!;
    expect(step).toHaveTextContent("2 of 3 connected, off or not applicable");
    expect(step).toHaveAttribute("data-setup-state", "pending");
    expect(step).not.toHaveTextContent(/Configured|Working|Declined for now/u);
  });

  it.each([["healthy", "live"], ["failing", "degraded"]] as const)("counts a %s connection as set up while every screen shows its one status", async (attempt, state) => {
    googleAnswers([{ capability: "gsc-daily", state: attempt }]);
    const data = settingUp();
    data.integrations = {
      ...data.integrations,
      sources: [{ id: "gsc", label: "Google Search Console", state }],
      lanes: [{
        catalog: {
          id: "gsc", label: "Google Search Console", scope: "property", layer: "provider",
          docRef: "docs/11-integrations.md#the-catalog",
          usage: { cost: "free" as const }, onFailure: "keeps-last-data" as const, credential: "shared",
          derived: false,
        },
        cell: {
          assetId: data.asset.id, laneId: "gsc", declared: "live", effective: state,
          evidence: [], note: state === "degraded" ? "The latest collection failed." : "Site mapping is configured.",
          ref: "sc-domain:meadow.example", since: "2026-07-06",
        },
        mapping: [{ name: "siteUrl", value: "sc-domain:meadow.example" }],
        mappingSource: "register",
      }],
    };
    stubFetch(200, data);
    const view = renderRoute("meadow.example", "", "sources");
    const heading = await view.findByRole("heading", { name: /Meadow Board/u, level: 1 });
    const word = attempt === "healthy" ? "Working" : "Failing";
    expect(headerStatuses(heading)).toEqual([`Google Search Console: ${word}`]);
    const sources = view.container.querySelector<HTMLElement>("#integrations")!;
    const currentRow = within(sources).getByRole("button", { name: /Google Search Console/u });
    expect(currentRow.querySelector("[data-connection]")).toHaveAttribute("data-connection", attempt === "healthy" ? "working" : "failing");

    const setupToggle = view.getByText(/^Data setup ·/);
    if (!setupToggle.closest("details")!.open) fireEvent.click(setupToggle);
    const setup = view.container.querySelector<HTMLElement>("[data-setup-checklist]")!;
    const sourceStep = setup.querySelector('[data-setup-item="sources"]')!;
    expect(sourceStep).toHaveAttribute("data-setup-state", "done");
    expect(sourceStep).toHaveTextContent("1 of 1 connected, off or not applicable");
    expect(sourceStep).not.toHaveTextContent(/working|failing|healthy/iu);
    expect(setup.querySelector('[data-setup-item="first-report"]')).toHaveAttribute("data-setup-state", "done");
    expect(setup.querySelector('[data-setup-item="baseline"]')).toHaveAttribute("data-setup-state", "pending");
  });

  it("is reachable by its own anchor, which lands on the Overview's banner", async () => {
    const scrolled = captureScrollTargets();
    stubFetch(200, settingUp());
    const { container, findByText } = renderRoute("meadow.example", "#setup");

    await findByText(/to do:/);
    expect(container.querySelector('#setup [role="status"]')).not.toBeNull();
    expect(
      container.querySelector('a[href="/assets/meadow.example/sources"]'),
    ).not.toBeNull();
    await waitFor(() => expect(scrolled).toEqual(["setup"]));
  });
});

describe("AssetDetailRoute — inbound deep links", () => {
  it.each(Object.entries(HASH_TAB))("scrolls every declared anchor %s to a section on %s", async (hash, tab) => {
    const scrolled = captureScrollTargets();
    const data = nomPayload();
    data.executive = {
      ...data.executive!,
      serpPanel: { reportDate: "2026-07-29", trackedDepth: 20, market: null, queries: [] },
      searchIntelligence: {
        observedAt: "2026-07-29", costUsd: 0,
        rankings: { keywords: 0, top3: 0, top10: 0, top20: 0, estimatedVisits: 0, estimatedPaidTrafficCost: 0, aiOverviewReferences: 0 },
        backlinks: { rank: 0, backlinks: 0, referringDomains: 0, newReferringDomains: 0, lostReferringDomains: 0 },
        ai: { googleMentions: 0, googleSearchVolume: 0, chatgptMentions: 0, chatgptSearchVolume: 0 },
        referringDomains: [], anchors: null, keywordIdeas: [], competitors: [],
      },
    };
    if (hash === RESTORE_HASH) data.asset.status = "retired";
    if (hash === "#setup") data.asset.status = "onboarding";
    stubFetch(200, data);
    const { container } = renderRoute("northwind.example", hash);
    const target = hash === "#details" ? "integrations" : hash.slice(1);
    await waitFor(() => expect(scrolled).toEqual([target]));
    const section = container.querySelector(`[id="${target}"]`);
    expect(section).not.toBeNull();
    expect(section!.closest('[role="tabpanel"]')).toHaveAttribute("aria-labelledby", `asset-tab-${tab}`);
    expect(container.querySelectorAll(`[id="${target}"]`)).toHaveLength(1);
  });

  /** Which tab a hash landed the page on, read the way the operator reads it. */
  function selectedTab(container: HTMLElement): string | undefined {
    return container
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.textContent?.replace(/\d+$/, "");
  }

  it("brings the query-decision section into view, on the Search tab", async () => {
    const scrolled = captureScrollTargets();
    stubFetch(200, payload());
    const { container, findAllByText } = renderRoute("meadow.example", "#query-visibility");

    await findAllByText("Query decisions");
    await waitFor(() => expect(scrolled).toEqual(["query-visibility"]));
    expect(selectedTab(container)).toBe("Search");
  });

  it("brings the page-decision section into view, on the Search tab", async () => {
    const scrolled = captureScrollTargets();
    stubFetch(200, payload());
    const { container, findAllByText } = renderRoute("meadow.example", "#page-decisions");

    await findAllByText("Page decisions");
    await waitFor(() => expect(scrolled).toEqual(["page-decisions"]));
    expect(selectedTab(container)).toBe("Search");
  });

  it("brings the tracked panel's own settings into view, on Settings", async () => {
    const scrolled = captureScrollTargets();
    stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example", "#tracked-panels");

    await findByText("Tracked search terms");
    await waitFor(() => expect(scrolled).toEqual(["tracked-panels"]));
    expect(selectedTab(container)).toBe("Settings");
  });

  it("brings the product-use section into view, on the Growth tab", async () => {
    const scrolled = captureScrollTargets();
    stubFetch(200, nomPayload());
    const { container, findAllByText } = renderRoute("northwind.example", "#product-use");

    await findAllByText(/Product use/);
    await waitFor(() => expect(scrolled).toEqual(["product-use"]));
    expect(selectedTab(container)).toBe("Growth");
  });

  it("selects Sources for the data-source anchors the matrix links at", async () => {
    const scrolled = captureScrollTargets();
    stubFetch(200, payload());
    const { container, findByRole } = renderRoute("meadow.example", "#integrations");

    await findByRole("tab", { name: "Data sources" });
    await waitFor(() => expect(scrolled).toEqual(["integrations"]));
    expect(selectedTab(container)).toBe("Data sources");
  });

  it("selects Activity for the timeline anchor an alert's change chip links at", async () => {
    const scrolled = captureScrollTargets();
    stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example", "#timeline");

    await findByText("Timeline");
    await waitFor(() => expect(scrolled).toEqual(["timeline"]));
    expect(selectedTab(container)).toBe("Activity");
  });

  it.each(["#pnl", "#ledger"])("opens asset Money for %s", async (hash) => {
    const scrolled = captureScrollTargets();
    stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example", hash);
    await findByText("Monthly accounting");
    await waitFor(() => expect(scrolled).toEqual([hash.slice(1)]));
    expect(selectedTab(container)).toBe("Money");
  });

  it("selects Settings for the configuration anchor", async () => {
    const scrolled = captureScrollTargets();
    stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example", "#configuration");

    await findByText("Alert rules in force");
    await waitFor(() => expect(scrolled).toEqual(["configuration"]));
    expect(selectedTab(container)).toBe("Settings");
  });

  it("leaves a hash this page does not own alone", async () => {
    const scrolled = captureScrollTargets();
    stubFetch(200, payload());
    const { container, findAllByText } = renderRoute("meadow.example", "#not-this-page");

    await findAllByText("What matters");
    expect(scrolled).toEqual([]);
    expect(selectedTab(container)).toBe("Overview");
  });
});

describe("AssetDetailRoute — a tab segment nobody built", () => {
  it("lands on Overview AND corrects the URL to say so", async () => {
    stubFetch(200, payload());
    const { container, findAllByText, getByTestId } = renderPath(
      "/assets/meadow.example/nonsense",
    );

    await findAllByText("What matters");
    expect(getByTestId("path").textContent).toBe("/assets/meadow.example");
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toBe("Overview");
  });

  it("keeps the query string while it corrects the segment", async () => {
    stubFetch(200, payload());
    const { findAllByText, getByTestId } = renderPath(
      "/assets/meadow.example/nonsense?from=wall",
    );

    await findAllByText("What matters");
    expect(getByTestId("path").textContent).toBe("/assets/meadow.example?from=wall");
  });

  it("lets a hash that names a real tab outrank the correction", async () => {
    stubFetch(200, payload());
    const { container, findByRole, getByTestId } = renderPath(
      "/assets/meadow.example/nonsense#integrations",
    );

    await findByRole("tab", { name: "Data sources" });
    expect(getByTestId("path").textContent).toBe(
      "/assets/meadow.example/sources#integrations",
    );
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toBe("Data sources");
  });
});

describe("AssetDetailRoute — data sources are not a dead end", () => {
  const gscLane = {
    catalog: {
      id: "gsc",
      label: "Google Search Console",
      docRef: "docs/11-integrations.md#the-catalog",
      scope: "property" as const,
      layer: "provider" as const,
      usage: { cost: "free" as const },
      onFailure: "keeps-last-data" as const,
      credential: "shared" as const,
      derived: false,
    },
    cell: {
      assetId: "meadow.example",
      laneId: "gsc",
      declared: "needs-setup" as const,
      effective: "needs-setup" as const,
      evidence: [],
      note: "No successful collector run yet.",
      ref: null,
      since: "2026-07-06",
    },
    mapping: [],
    mappingSource: "fallback" as const,
  };

  function withLane() {
    const data = payload();
    data.integrations = { ...data.integrations, lanes: [gscLane] };
    return data;
  }

  /** Both reads answered, and nothing is connected. */
  function nothingConnected() {
    connections.credentials = new Map();
    connections.items = [];
  }

  it("gives a not-set-up source one action, Connect, and no setup pointer or checklist", async () => {
    stubFetch(200, withLane());
    nothingConnected();
    const { findByText, getByRole, container } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Search Console");
    expect(getByRole("link", { name: /Connect Google/u })).toHaveAttribute("href", "/integrations?connect=google&asset=meadow.example");
    openLane("Google Search Console");
    expect(container.querySelector("[data-lane-doc-ref]")).toBeNull();
    expect(container.querySelector("[data-lane-step]")).toBeNull();
    expect(container.textContent).not.toContain("Setup steps:");
  });

  it("shows a source nothing connects with its evidence, and no Connect or dead link", async () => {
    const cj = {
      ...gscLane,
      catalog: { ...gscLane.catalog, id: "affiliate-cj", label: "Affiliate — CJ" },
      cell: {
        ...gscLane.cell, laneId: "affiliate-cj",
        evidence: [{ polarity: "supporting" as const, source: "Affiliate revenue added by hand", detail: "$12.00 · latest 2026-06", at: null }],
      },
    };
    const data = payload();
    data.integrations = { ...data.integrations, lanes: [cj] };
    stubFetch(200, data);
    nothingConnected();
    const view = renderRoute("meadow.example", "", "sources");
    await view.findByText("CJ affiliate revenue");
    const row = [...view.container.querySelectorAll("#integrations li")].find((li) => li.textContent?.includes("CJ affiliate revenue"))!;
    expect(row.querySelector("[data-source-connect]")).toBeNull();
    openLane("CJ affiliate revenue");
    expect(row.querySelector('a[href="/integrations"]')).toBeNull();
    expect(row.textContent).not.toContain("Manage integrations");
  });

  it.each([
    ["live", { polarity: "supporting" as const, source: "Home page answered", detail: "",
      verification: { kind: "collection-success" as const, laneId: "uptime" } }, "working", "Up", "checked 12m ago"],
    ["live", { polarity: "supporting" as const, source: "Home page answered", detail: "1 failed try",
      verification: { kind: "collection-success" as const, laneId: "uptime" } }, "working", "Up", "checked 12m ago · 1 failed try"],
    ["degraded",{ polarity: "against" as const, source: "Home page did not answer", detail: "HTTP 503" },
      "failing", "Down", "HTTP 503 · checked 12m ago"],
  ] as const)("reads a %s uptime check as Up or Down with its age", async (effective, evidence, kind, word, caption) => {
    const uptime = {
      ...gscLane,
      catalog: { ...gscLane.catalog, id: "uptime", label: "Uptime monitoring", scope: "both" as const },
      cell: {
        ...gscLane.cell, laneId: "uptime", declared: "needs-setup" as const, effective,
        evidence: [{ ...evidence, at: new Date(Date.now() - 12 * 60_000 - 5_000).toISOString() }],
      },
    };
    const data = payload();
    data.integrations = { ...data.integrations, lanes: [uptime] };
    stubFetch(200, data);
    nothingConnected();
    const view = renderRoute("meadow.example", "", "sources");
    await view.findByText("Uptime monitoring");
    const row = [...view.container.querySelectorAll<HTMLElement>("#integrations li")].find((li) => li.textContent?.includes("Uptime monitoring"))!;
    expect(row.querySelector("[data-connection]")).toHaveAttribute("data-connection", kind);
    expect(row.querySelector("[data-connection]")).toHaveTextContent(word);
    expect(row.querySelector("[data-uptime-check]")).toHaveTextContent(caption);
    expect(row.querySelector("[data-source-connect]")).toBeNull();
    expect(row.textContent).not.toMatch(/Working|Failing|Not connected/u);
  });

  it("says More sources, names no config file, and names the nightly report", async () => {
    const cj = {
      ...gscLane,
      catalog: { ...gscLane.catalog, id: "affiliate-cj", label: "Affiliate — CJ" },
      cell: {
        ...gscLane.cell, laneId: "affiliate-cj",
        evidence: [{ polarity: "supporting" as const, source: "Affiliate revenue added by hand", detail: "$12.00 · latest 2026-06", at: null }],
      },
    };
    const nightly = {
      ...gscLane,
      catalog: { ...gscLane.catalog, id: "nightly-report", label: "Nightly report", derived: true },
      cell: { ...gscLane.cell, laneId: "nightly-report", since: "" },
    };
    const data = payload();
    data.integrations = { ...data.integrations, lanes: [nightly, cj] };
    stubFetch(200, data);
    nothingConnected();
    const view = renderRoute("meadow.example", "", "sources");
    const more = await view.findByRole("region", { name: "More sources" });
    expect(more.closest("details")).toBeNull();
    expect(within(more).getByText("CJ affiliate revenue")).toBeVisible();
    expect(within(more).getByText("1")).toBeInTheDocument();
    expect(view.container.querySelector("[data-owner-chip]")).toBeNull();
    expect(view.container.textContent).not.toMatch(/config\/|\.json\b/u);
    openLane("Nightly report");
    expect(view.getByRole("link", { name: /^Nightly report in System health/u })).toHaveAttribute("href", "/health");
    expect(view.container.textContent).not.toMatch(/Additional connections|Technical details|checks complete|daily report status|config\//iu);
  });

  it("opens a panel provider's connect panel over the site's page from its row", async () => {
    const bing = {
      ...gscLane,
      catalog: { ...gscLane.catalog, id: "bing-webmaster", label: "Bing Webmaster Tools" },
      cell: { ...gscLane.cell, laneId: "bing-webmaster" },
    };
    const data = payload();
    data.integrations = { ...data.integrations, lanes: [bing] };
    const providers = {
      generatedAt: "2026-07-05T12:00:00.000Z", keyPresent: true, keyReason: null,
      blockers: [],
      providers: [{
        provider: integrationProvider("bing-webmaster"),
        credential: { provider: "bing-webmaster", source: "none", fields: [], assetsHeld: [], missingFields: [], auth: null, metadata: null,
          keyVersion: null, createdAt: null, updatedAt: null, lastUsedAt: null, lastOkAt: null, lastError: null },
        assets: [],
      }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      new Response(JSON.stringify(String(input).includes("/api/integrations/providers") ? providers : data), {
        status: 200, headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    nothingConnected();
    const view = renderRoute("meadow.example", "", "sources");

    const connect = await view.findByRole("button", { name: "Connect Bing Webmaster Tools" });
    fireEvent.click(connect);
    const panel = await view.findByRole("dialog", { name: "Bing Webmaster Tools" });
    expect(within(panel).getByLabelText("API key")).toBeInTheDocument();
    expect(view.getByTestId("path").textContent).toBe("/assets/meadow.example/sources");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/connect"))).toBe(false);
  });

  it.each([
    ["key-missing", "No encryption key", "openssl rand -base64 32", "CREDENTIALS_KEY"],
    ["key-invalid", "Encryption key unusable", "openssl rand -base64 32", "CREDENTIALS_KEY"],
  ] as const)("says why Connect is off in the panel a site's row opens, once, with its command: %s", async (blocker, lead, command, binding) => {
    const bing = {
      ...gscLane,
      catalog: { ...gscLane.catalog, id: "bing-webmaster", label: "Bing Webmaster Tools" },
      cell: { ...gscLane.cell, laneId: "bing-webmaster" },
    };
    const data = payload();
    data.integrations = { ...data.integrations, lanes: [bing] };
    const providers = {
      generatedAt: "2026-07-05T12:00:00.000Z",
      keyPresent: false, keyReason: null,
      blockers: [blocker],
      providers: [{
        provider: integrationProvider("bing-webmaster"),
        credential: { provider: "bing-webmaster", source: "none", fields: [], assetsHeld: [], missingFields: [], auth: null, metadata: null,
          keyVersion: null, createdAt: null, updatedAt: null, lastUsedAt: null, lastOkAt: null, lastError: null },
        assets: [],
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      new Response(JSON.stringify(String(input).includes("/api/integrations/providers") ? providers : data), {
        status: 200, headers: { "content-type": "application/json" },
      })));
    nothingConnected();
    const view = renderRoute("meadow.example", "", "sources");

    const connect = await view.findByRole("button", { name: "Connect Bing Webmaster Tools" });
    expect(view.container.querySelector("[data-connect-blocked]")).toBeNull();
    fireEvent.click(connect);
    const panel = await view.findByRole("dialog", { name: "Bing Webmaster Tools" });

    expect(document.querySelectorAll("[data-connect-blocked]")).toHaveLength(1);
    expect(document.querySelectorAll(`[data-status-for="setup:${blocker}"]`)).toHaveLength(1);
    const banner = panel.querySelector(`[data-blocker="${blocker}"]`);
    expect(banner).not.toBeNull();
    expect(banner).toHaveTextContent(lead);
    expect(banner!.querySelector(`[data-blocker-command="${blocker}"]`)).toHaveTextContent(command);
    expect(within(banner as HTMLElement).getByRole("button", { name: `Copy ${command}` })).toBeInTheDocument();
    if (binding) expect(banner!.querySelector("[data-blocker-binding]")).toHaveTextContent(binding);
    else expect(banner!.querySelector("[data-blocker-binding]")).toBeNull();

    fireEvent.change(within(panel).getByLabelText("API key"), { target: { value: "k" } });
    expect(within(panel).getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("reads the source Working with its missing reports when only old outage dates failed, and Failing with why when the latest pull fails", async () => {
    const live = { ...gscLane, cell: { ...gscLane.cell, declared: "live" as const, effective: "live" as const } };
    const data = payload();
    data.integrations = { ...data.integrations, lanes: [live] };
    stubFetch(200, data);
    googleAnswers([{ capability: "gsc-daily", state: "healthy" }]);
    const outage = { ...(connections.items![0] as Record<string, unknown>), id: "gap", capability: "gsc-archive", detail: "query · 2026-09-13", report: "query", reportDate: "2026-09-13",
      state: "failing", failure: "network", lastAttemptAt: "2026-09-14T12:15:00.000Z", lastSuccessAt: null };
    const today = { ...(connections.items![0] as Record<string, unknown>), id: "today", capability: "gsc-archive", detail: "query · 2026-09-21", report: "query", reportDate: "2026-09-21" };
    connections.items = [...connections.items!, outage, today];
    const view = renderRoute("meadow.example", "", "sources");
    await view.findByText("Google Search Console");
    const row = view.container.querySelector("#integrations li")!;
    expect(row.querySelector("[data-connection]")).toHaveAttribute("data-connection", "working");
    expect(row).toHaveTextContent("1 report missing");
    expect(view.container.querySelector("[data-sources-answer]")).toHaveTextContent("Google Search Console working");
  });

  it("reads the source Failing, with why, when its latest pull fails", async () => {
    const live = { ...gscLane, cell: { ...gscLane.cell, declared: "live" as const, effective: "live" as const } };
    const data = payload();
    data.integrations = { ...data.integrations, lanes: [live] };
    stubFetch(200, data);
    googleAnswers([{ capability: "gsc-daily", state: "failing" }]);
    const view = renderRoute("meadow.example", "", "sources");
    await view.findByText("Google Search Console");
    const row = view.container.querySelector("#integrations li")!;
    expect(row.querySelector("[data-connection]")).toHaveAttribute("data-connection", "failing");
    expect(row).toHaveTextContent("Access was refused.");
    expect(view.container.querySelector("[data-sources-answer]")).toHaveTextContent("Google Search Console needs you");
    expect(view.container.querySelector("[data-page-answer-detail]")).toHaveTextContent("Google Search Console failing");
    expect(within(row as HTMLElement).getByRole("link", { name: "Fix Google" })).toHaveAttribute("href", "/integrations?provider=google");
  });


  it("leaves a working source without setup chrome", async () => {
    const data = withLane();
    data.integrations = {
      ...data.integrations,
      lanes: [
        {
          ...gscLane,
          cell: { ...gscLane.cell, declared: "live", effective: "live" },
        },
      ],
    };
    stubFetch(200, data);
    const { container, findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Search Console");
    expect(container.textContent).not.toContain("Setup steps:");
  });

  it("links to the connected-account page for adding a data source", async () => {
    stubFetch(200, payload());
    const { findByRole } = renderRoute("meadow.example", "", "sources");

    expect(
      await findByRole("link", { name: /^All integrations/u }),
    ).toHaveAttribute("href", "/integrations");
  });
});

describe("AssetDetailRoute — the GA4 lane's declarations", () => {
  const ga4Lane = {
    catalog: {
      id: "ga4",
      label: "Google Analytics 4",
      docRef: "docs/11-integrations.md#the-catalog",
      scope: "property" as const,
      layer: "provider" as const,
      usage: { cost: "free" as const },
      onFailure: "keeps-last-data" as const,
      credential: "shared" as const,
      derived: false,
    },
    cell: {
      assetId: "meadow.example",
      laneId: "ga4",
      declared: "live" as const,
      effective: "live" as const,
      evidence: [],
      note: "",
      ref: null,
      since: "2026-07-06",
    },
    mapping: [],
    mappingSource: "fallback" as const,
  };

  /** The same lane wearing GSC's identity — the control that proves the two
   * editors belong to the GA4 card rather than to every card on the tab. */
  const gscLane = {
    ...ga4Lane,
    catalog: { ...ga4Lane.catalog, id: "gsc", label: "Google Search Console" },
    cell: { ...ga4Lane.cell, laneId: "gsc" },
  };

  function withGa4(ga4Config: AssetDetailPayload["ga4Config"], lanes = [ga4Lane]) {
    const data = payload();
    data.integrations = { ...data.integrations, lanes };
    data.ga4Config = ga4Config;
    return data;
  }

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  /** Three answers from one stub: the asset, the write lane's writability,
   * and what a PUT did. */
  function stubEditing(
    data: AssetDetailPayload,
    writable: { writable: boolean; reason: string | null } = {
      writable: true,
      reason: null,
    },
  ) {
    const puts: ConfigPut[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method !== "GET") {
          puts.push(JSON.parse(String(init?.body)) as { ops: Record<string, unknown>[] });
          return json({ applied: 1, archive: "config/changesets/x.json", commit: "abc1234" });
        }
        return String(input).startsWith("/api/config") ? json(writable) : json(data);
      }),
    );
    return puts;
  }

  /** The one op a save made. Every action here is a single-op changeset. */
  function onlyOp(puts: { ops: Record<string, unknown>[] }[], index = 0) {
    expect(puts[index]?.ops).toHaveLength(1);
    return puts[index]?.ops[0];
  }

  function collection(key: string): HTMLElement {
    const found = document.querySelector(`[data-collection-editor="${key}"]`);
    if (!(found instanceof HTMLElement)) throw new Error(`no editor for ${key}`);
    return found;
  }

  beforeEach(() => {
    toasts.success.mockReset();
    toasts.error.mockReset();
  });

  it("edits both lists on the GA4 card, and puts them on no other lane", async () => {
    stubEditing(
      withGa4(
        { valueEvents: ["calculation_complete"], eventParams: ["message"] },
        [ga4Lane, gscLane],
      ),
    );
    const { findByText, container } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    expect(collection("value-events").textContent).toContain(
      "Checked nightly against key events",
    );
    expect(collection("ga4-event-params").textContent).toContain(
      "Read by the error report",
    );
    expect(
      container.querySelectorAll("[data-ga4-config]"),
    ).toHaveLength(1);
    expect(within(collection("value-events")).getByDisplayValue("calculation_complete")).toBeTruthy();
    expect(within(collection("ga4-event-params")).getByDisplayValue("message")).toBeTruthy();
  });

  it("declares the first value event by filing the asset's entry, and undoes it whole", async () => {
    const puts = stubEditing(withGa4({ valueEvents: null, eventParams: null }));
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    await waitFor(() => expect(within(collection("value-events")).getByText("None yet")).toBeInTheDocument());
    expect(within(collection("value-events")).getByText("Conversion counts unchecked")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Nothing in .* yet/);

    const editor = collection("value-events");
    fireEvent.click(within(editor).getByRole("button", { name: "Add" }));
    const form = editor.querySelector("[data-collection-add]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("GA4 event"), {
      target: { value: "calculation_complete" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(onlyOp(puts)).toEqual({
      kind: "file-json-insert",
      file: "config/value-events.json",
      pointer: "/assets/meadow.example",
      value: { valueEvents: ["calculation_complete"] },
    });

    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const undo = toasts.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    undo.action.onClick();
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(onlyOp(puts, 1)).toEqual({
      kind: "file-json-delete",
      file: "config/value-events.json",
      pointer: "/assets/meadow.example",
      expect: { valueEvents: ["calculation_complete"] },
    });
  });

  it("appends into an entry that exists and declares nothing", async () => {
    const puts = stubEditing(withGa4({ valueEvents: [], eventParams: null }));
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    await waitFor(() => expect(within(collection("value-events")).getByText("None yet")).toBeInTheDocument());
    const editor = collection("value-events");
    fireEvent.click(within(editor).getByRole("button", { name: "Add" }));
    const form = editor.querySelector("[data-collection-add]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("GA4 event"), {
      target: { value: "sign_up" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(onlyOp(puts)).toEqual({
      kind: "file-json-insert",
      file: "config/value-events.json",
      pointer: "/assets/meadow.example/valueEvents/-",
      value: "sign_up",
    });
  });

  it("renames a registered parameter in place, guarded by what the cell showed", async () => {
    const puts = stubEditing(
      withGa4({ valueEvents: null, eventParams: ["message", "source"] }),
    );
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    const editor = collection("ga4-event-params");
    const input = within(editor).getByDisplayValue("message");
    fireEvent.change(input, { target: { value: "error_message" } });
    fireEvent.click(
      within(input.parentElement as HTMLElement).getByRole("button", { name: "Save" }),
    );

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(onlyOp(puts)).toEqual({
      kind: "file-json-set",
      file: "config/ga4-custom-dimensions.json",
      pointer: "/assets/meadow.example/eventParams/0",
      expect: "message",
      value: "error_message",
    });
  });

  it("removes a value event behind its own confirm, and the Undo puts it back", async () => {
    const puts = stubEditing(
      withGa4({ valueEvents: ["calculation_complete", "sign_up"], eventParams: null }),
    );
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    const editor = collection("value-events");
    fireEvent.click(within(editor).getByRole("button", { name: "Remove sign_up…" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Remove sign_up" }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(onlyOp(puts)).toEqual({
      kind: "file-json-delete",
      file: "config/value-events.json",
      pointer: "/assets/meadow.example/valueEvents/1",
      expect: "sign_up",
    });

    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const undo = toasts.success.mock.calls[0]?.[1] as { action: { onClick: () => void } };
    undo.action.onClick();
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(onlyOp(puts, 1)).toEqual({
      kind: "file-json-insert",
      file: "config/value-events.json",
      pointer: "/assets/meadow.example/valueEvents/1",
      value: "sign_up",
    });
  });

  it("refuses a name GA4 could never emit, and says which field broke which rule", async () => {
    const puts = stubEditing(withGa4({ valueEvents: ["sign_up"], eventParams: null }));
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    const editor = collection("value-events");
    const input = within(editor).getByDisplayValue("sign_up");
    fireEvent.change(input, { target: { value: "Calculation complete" } });
    fireEvent.click(
      within(input.parentElement as HTMLElement).getByRole("button", { name: "Save" }),
    );

    expect(
      await within(editor).findByText('GA4 event: verbatim as the site emits it (calculation_complete, never "Calculation complete")'),
    ).toBeInTheDocument();
    expect(puts).toHaveLength(0);
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("says the deployment's own sentence once for the pair, not once per list", async () => {
    stubEditing(withGa4({ valueEvents: ["sign_up"], eventParams: ["message"] }), {
      writable: false,
      reason: "Config is files; this build has none.",
    });
    const { findByText, container } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    await findByText("Config is files; this build has none.");
    expect(
      container.querySelectorAll("[data-ga4-config-read-only]"),
    ).toHaveLength(1);
    expect(container.querySelectorAll("[data-collection-read-only]")).toHaveLength(0);
    expect(container.textContent).toContain("sign_up");
    expect(within(collection("value-events")).queryByRole("button", { name: "Add" })).toBeNull();
  });
});

describe("AssetDetailRoute — the per-asset provider mapping", () => {
  const catalog = {
    id: "ga4",
    label: "Google Analytics 4",
    docRef: "docs/11-integrations.md#the-catalog",
    scope: "property" as const,
    layer: "provider" as const,
    usage: { cost: "free" as const },
    onFailure: "keeps-last-data" as const,
    credential: "shared" as const,
    derived: false,
  };

  /** A GA4 lane as `buildAssetIntegrations` hands one over: the setup steps
   * derived from the same catalog, cell and mapping the card renders. */
  function ga4Lane(
    over: { propertyId?: string | null; declared?: string; effective?: string; note?: string | null } = {},
  ) {
    const mapping = [{ name: "propertyId", value: over.propertyId ?? null }];
    const cell = {
      assetId: "meadow.example",
      laneId: "ga4",
      declared: (over.declared ?? "needs-setup") as "needs-setup",
      effective: (over.effective ?? "needs-setup") as "needs-setup",
      evidence: [],
      // `null` is a cell with no note key: a new site's source.
      note: over.note === undefined ? "No successful collector run yet." : over.note,
      ref: null,
      since: "2026-07-06",
    };
    return {
      catalog,
      cell,
      mapping,
      mappingSource: (over.propertyId === undefined ? "fallback" : "register") as
        | "fallback"
        | "register",
    };
  }

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  /** What the connected Google account answers. The default is a 200 saying
   * not connected, which is an answer, not an error. */
  const NOT_CONNECTED = {
    ok: false,
    message: "Google is not connected — sign in on /integrations first.",
    checkedAt: "2026-09-05T00:00:00.000Z",
    account: null,
    auth: null,
    properties: [],
  };

  const TWO_PROPERTIES = {
    ok: true,
    message: "The connected account can see 2 GA4 properties and 1 Search Console site.",
    checkedAt: "2026-09-05T00:00:00.000Z",
    account: "ops@example.test",
    auth: "oauth",
    properties: [
      { lane: "ga4", ref: "123456789", label: "Meadow Board", detail: "Example Ventures" },
      { lane: "ga4", ref: "444555666", label: "Northwind", detail: null },
      { lane: "gsc", ref: "sc-domain:meadow.example", label: "meadow.example", detail: "owner" },
    ],
  };

  /** The asset, the write lane's writability, the connected account's list, and
   * what a PUT carried. */
  function stubEditing(
    lane: ReturnType<typeof ga4Lane>,
    discovery: unknown = NOT_CONNECTED,
    /** Where this deployment read `config/integrations.json`, which the
     * timing sentence is derived from. */
    sources: Record<string, "store" | "file"> = {},
    /** What the write lane answers. The default is a canned 200 — cases about
     * the SAVE rather than the request hand in the real pipeline instead. */
    lane_: ((request: ConfigPut) => Promise<Response>) | null = null,
    /** Only a fixture explicitly exercising successful collection supplies this. */
    observedAt: string | null = null,
    verified = false,
    /** What `GET /api/integrations/posthog/sites` answers; `null` is the read
     * failing outright. */
    accountSites: unknown = null,
  ) {
    const data = payload();
    data.integrations = {
      ...data.integrations,
      lanes: [lane],
      sources: [{ id: lane.catalog.id, label: lane.catalog.label, state: lane.cell.effective, observedAt,
        verification: verified ? { kind: "collection-success", laneId: lane.catalog.id } : undefined }],
    };
    const puts: ConfigPut[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method !== "GET") {
          const body = JSON.parse(String(init?.body)) as ConfigPut;
          puts.push(body);
          return lane_ === null
            ? json({ applied: body.ops.length, archive: "config/changesets/x.json", commit: "abc1234" })
            : await lane_(body);
        }
        if (String(input).startsWith("/api/integrations/posthog/sites")) {
          return accountSites === null ? json({ error: "sites_unavailable" }, 503) : json(accountSites);
        }
        if (String(input).startsWith(GOOGLE_PROPERTIES_PATH)) {
          return discovery === null ? json({ error: "google_properties_failed" }, 500) : json(discovery);
        }
        return String(input).startsWith("/api/config")
          ? json({ writable: true, reason: null, sources })
          : json(data);
      }),
    );
    return puts;
  }

  it("picks a DataForSEO market by name and saves both codes in one press", async () => {
    const mapping = [{ name: "locationCode", value: null }, { name: "languageCode", value: null }];
    const cell = { assetId: "meadow.example", laneId: "dataforseo", declared: "needs-setup" as const, effective: "needs-setup" as const,
      evidence: [], note: "", ref: null, since: "2026-07-06" };
    const dfsCatalog = { ...catalog, id: "dataforseo", label: "DataForSEO", provider: "dataforseo" };
    const puts = stubEditing({ catalog: dfsCatalog, cell, mapping, mappingSource: "fallback" as const } as unknown as ReturnType<typeof ga4Lane>);
    const { findByText, container } = renderRoute("meadow.example", "", "sources");
    await findByText("DataForSEO");
    openLane("DataForSEO");
    const block = container.querySelector('[data-lane-mapping="dataforseo"]') as HTMLElement;
    const market = within(block).getByLabelText("Market") as HTMLSelectElement;
    expect(market.selectedOptions[0]!.textContent).toBe("United States · English");
    expect(block.querySelectorAll("input")).toHaveLength(0);
    expect(block.textContent).not.toMatch(/location code/i);
    fireEvent.change(market, { target: { value: "2826:en" } });
    await waitFor(() => expect(puts).toHaveLength(1));
    const ops = (puts[0] as unknown as { ops: { pointer: string; value: unknown }[] }).ops;
    expect(ops.map((op) => [op.pointer, op.value])).toEqual([
      ["/assets/meadow.example/dataforseo/locationCode", 2826],
      ["/assets/meadow.example/dataforseo/languageCode", "en"],
    ]);
  });

  const SIGNUP = { id: "signup", name: "Signup", steps: [{ event: "$pageview" }, { event: "signed_up" }] };
  const CHECKOUT = { id: "checkout", name: "Checkout", steps: [{ event: "$pageview", path: "/pricing" }, { event: "purchase" }] };
  function posthogLane() {
    const cell = { assetId: "meadow.example", laneId: "posthog", declared: "needs-setup" as const, effective: "live" as const,
      evidence: [], note: "", ref: null, since: "2026-07-06" };
    return {
      catalog: { ...catalog, id: "posthog", label: "PostHog", provider: "posthog" },
      cell,
      mapping: [{ name: "host", value: "us" }, { name: "projectId", value: "424242" }],
      mappingLists: [{ name: "funnels", value: [SIGNUP] }],
      mappingSource: "register" as const,
    } as unknown as ReturnType<typeof ga4Lane>;
  }
  const project = (id: number, name: string, funnels: unknown[], host = "us") => ({
    lane: "posthog", ref: `${host}:${id}`, label: name, host: null, mapping: { host, projectId: String(id) }, funnels, ready: true,
  });
  const ACCOUNT = {
    discovery: { ok: true, provider: "posthog", kind: "account", checkedAt: "2026-09-23T00:00:00.000Z",
      sites: [project(424242, "Meadow Board", [SIGNUP, CHECKOUT]), project(12, "Staging", [], "eu")] },
    assets: [], spend: null,
  };

  it("picks a PostHog site's project by name and number, and adds a funnel by picking one of the project's saved funnels", async () => {
    const puts = stubEditing(posthogLane(), NOT_CONNECTED, {}, null, null, false, ACCOUNT);
    const { findByText, container } = renderRoute("meadow.example", "", "sources");
    await findByText("PostHog");
    openLane("PostHog");
    const block = container.querySelector('[data-lane-mapping="posthog"]') as HTMLElement;
    fireEvent.click(block.closest("details")!.querySelector("summary")!);
    const select = await within(block).findByLabelText("PostHog project") as HTMLSelectElement;
    await waitFor(() => expect(select.selectedOptions[0]!.textContent).toBe("Meadow Board · 424242 · US"));
    expect(block.querySelectorAll("input")).toHaveLength(0);
    expect(within(block).queryByLabelText("PostHog project id")).toBeNull();
    const pick = within(block).getByLabelText("Add funnel") as HTMLSelectElement;
    expect([...pick.options].map((option) => option.textContent)).toEqual(["Add funnel", "Checkout"]);
    fireEvent.change(pick, { target: { value: "checkout" } });
    await waitFor(() => expect(puts).toHaveLength(1));
    const funnelsOp = (puts[0] as unknown as { ops: { pointer: string; expect?: unknown; value: unknown }[] }).ops;
    expect(funnelsOp).toEqual([expect.objectContaining({ pointer: "/assets/meadow.example/posthog/funnels", expect: [SIGNUP], value: [SIGNUP, CHECKOUT] })]);
    expect(await within(block).findByRole("button", { name: "Undo" })).toBeTruthy();
    fireEvent.change(select, { target: { value: "eu:12" } });
    await waitFor(() => expect(puts).toHaveLength(2));
    const projectOps = (puts[1] as unknown as { ops: { pointer: string; value: unknown }[] }).ops;
    expect(projectOps.map((op) => [op.pointer, op.value])).toEqual([
      ["/assets/meadow.example/posthog/host", "eu"],
      ["/assets/meadow.example/posthog/projectId", "12"],
    ]);
  });

  it("removes a PostHog funnel with its own press, saved at once", async () => {
    const puts = stubEditing(posthogLane(), NOT_CONNECTED, {}, null, null, false, ACCOUNT);
    const { findByText, container } = renderRoute("meadow.example", "", "sources");
    await findByText("PostHog");
    openLane("PostHog");
    const block = container.querySelector('[data-lane-mapping="posthog"]') as HTMLElement;
    fireEvent.click(block.closest("details")!.querySelector("summary")!);
    fireEvent.click(await within(block).findByRole("button", { name: "Remove funnel Signup" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    const ops = (puts[0] as unknown as { ops: { pointer: string; value: unknown }[] }).ops;
    expect(ops.map((op) => [op.pointer, op.value])).toEqual([["/assets/meadow.example/posthog/funnels", []]]);
  });

  it("types the PostHog project and funnels only when the account cannot be read", async () => {
    stubEditing(posthogLane(), NOT_CONNECTED, {}, null, null, false, null);
    const { findByText, container } = renderRoute("meadow.example", "", "sources");
    await findByText("PostHog");
    openLane("PostHog");
    const block = container.querySelector('[data-lane-mapping="posthog"]') as HTMLElement;
    fireEvent.click(block.closest("details")!.querySelector("summary")!);
    expect(await within(block).findByLabelText("PostHog project id")).toBeTruthy();
    await waitFor(() => expect(block.querySelector("[data-funnel-step-event]")).not.toBeNull());
    expect(within(block).queryByLabelText("PostHog project")).toBeNull();
    expect(within(block).queryByLabelText("Add funnel")).toBeNull();
  });

  function mappingBlock(): HTMLElement {
    openLane("Google Analytics");
    const found = document.querySelector('[data-lane-mapping="ga4"]');
    if (!(found instanceof HTMLElement)) throw new Error("no mapping block");
    return found;
  }

  beforeEach(() => {
    toasts.success.mockReset();
    toasts.error.mockReset();
  });

  /** `config/integrations.json` as every asset starts: the lane row with its
   * posture and no mapping field. */
  function noMappingYet() {
    return {
      catalog: [{ id: "ga4", label: "Google Analytics 4" }],
      assets: {
        "meadow.example": {
          ga4: { status: "live", note: "Collector proved it.", since: "2026-07-29" },
        },
      },
    };
  }

  /** Runs the request through `scripts/config-documents.mjs`, the pipeline
   * both write doors execute, and answers what the real lane answers: 200
   * with the applied document, or 409 with the mismatch list. */
  async function applyThroughPipeline(
    doc: Record<string, unknown>,
    request: ConfigPut,
  ): Promise<Response> {
    const changeset = {
      version: 1 as const,
      // The slug the browser actually sent: the pipeline wants kebab-case and
      // refuses an asset id's dot or a declared field's capital.
      slug: request.slug ?? "sources",
      createdAt: "2026-09-05T09:00:00.000Z",
      ops: request.ops as unknown as ChangesetOp[],
    };
    try {
      validateSchemaAndSafety(changeset);
      const { resolved, mismatches, documents } = await resolveOps(changeset, null, {
        readDocument: async () => doc,
      });
      if (mismatches.length > 0) return json({ error: "expect_mismatch" }, 409);
      applyDocumentOps(resolved, documents, { at: changeset.createdAt });
    } catch (err) {
      return json({ error: "invalid_changeset", detail: String(err) }, 422);
    }
    return json({
      applied: request.ops.length,
      archive: "config/changesets/x.json",
      commit: "abc1234",
    });
  }

  it("saves the first GA4 property id an asset has ever had", async () => {
    const file = noMappingYet();
    const puts = stubEditing(ga4Lane(), NOT_CONNECTED, {}, (body) =>
      applyThroughPipeline(file, body),
    );
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    const block = mappingBlock();
    fireEvent.change(within(block).getByLabelText(/GA4 property id/u), {
      target: { value: "123456789" },
    });
    fireEvent.click(within(block).getByRole("button", { name: "Save" }));

    // An absent key and an empty string are different facts to the guard.
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/propertyId",
        expectAbsent: true,
        value: "123456789",
      },
    ]);

    const undo = await within(block).findByRole("button", { name: "Undo" });
    expect(toasts.error).not.toHaveBeenCalled();
    expect(file.assets["meadow.example"].ga4).toEqual({
      status: "live",
      note: "Collector proved it.",
      since: "2026-07-29",
      propertyId: "123456789",
    });
    fireEvent.click(undo);
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]?.ops).toEqual([
      {
        kind: "file-json-delete",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/propertyId",
        expect: "123456789",
      },
    ]);
    // The key is gone rather than blank, which the collector reads as "fall
    // back to the Google credential".
    expect(file.assets["meadow.example"].ga4).toEqual({
      status: "live",
      note: "Collector proved it.",
      since: "2026-07-29",
    });
  });

  it("removes a mapping that is already there, and the Undo writes it back", async () => {
    const file = {
      catalog: [{ id: "ga4", label: "Google Analytics 4" }],
      assets: {
        "meadow.example": {
          ga4: {
            status: "live",
            note: "Collector proved it.",
            since: "2026-07-29",
            propertyId: "123456789",
          } as Record<string, unknown>,
        },
      },
    };
    const puts = stubEditing(ga4Lane({ propertyId: "123456789" }), NOT_CONNECTED, {}, (body) =>
      applyThroughPipeline(file, body),
    );
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    const block = mappingBlock();
    fireEvent.click(within(block).getByRole("button", { name: "Remove mapping" }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.ops).toEqual([
      {
        kind: "file-json-delete",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/propertyId",
        expect: "123456789",
      },
    ]);
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(toasts.error).not.toHaveBeenCalled();
    expect(file.assets["meadow.example"].ga4).toEqual({
      status: "live",
      note: "Collector proved it.",
      since: "2026-07-29",
    });

    const action = toasts.success.mock.calls[0]?.[1]?.action as { onClick: () => void };
    action.onClick();
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]?.ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/propertyId",
        expectAbsent: true,
        value: "123456789",
      },
    ]);
    expect(file.assets["meadow.example"].ga4.propertyId).toBe("123456789");
  });

  it("offers nothing to remove on a field nothing has written", async () => {
    stubEditing(ga4Lane());
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    expect(
      within(mappingBlock()).queryByRole("button", { name: "Remove mapping" }),
    ).toBeNull();
  });

  it("saves a property id over one that is already there, and offers the way back", async () => {
    const puts = stubEditing(ga4Lane({ propertyId: "111222333" }));
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    const block = mappingBlock();
    fireEvent.change(within(block).getByLabelText(/GA4 property id/u), {
      target: { value: "123456789" },
    });
    fireEvent.click(within(block).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/propertyId",
        expect: "111222333",
        value: "123456789",
      },
    ]);

    fireEvent.click(await within(block).findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]?.ops[0]).toMatchObject({ expect: "123456789", value: "111222333" });
  });

  function picker(): HTMLElement {
    const found = document.querySelector('[data-lane-picker="ga4"]');
    if (!(found instanceof HTMLElement)) throw new Error("no picker");
    return found;
  }

  it("picks a GA4 property from the connected account, writing the box's own op", async () => {
    const puts = stubEditing(ga4Lane(), TWO_PROPERTIES);
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    await waitFor(() => expect(picker().dataset.lanePickerState).toBe("ready"));
    const block = picker();
    expect(block.textContent).toContain("Meadow Board — Example Ventures (123456789)");
    expect(block.textContent).not.toContain("sc-domain:meadow.example");

    fireEvent.change(within(block).getByRole("combobox"), {
      target: { value: "123456789" },
    });
    fireEvent.click(within(block).getAllByRole("button", { name: "Save" })[0]!);

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/propertyId",
        expectAbsent: true,
        value: "123456789",
      },
    ]);
    await waitFor(() =>
      expect(block.querySelector('[data-save-state="saved"]')).not.toBeNull(),
    );
  });

  it("keeps a property the account cannot see, and a box to type another", async () => {
    stubEditing(ga4Lane({ propertyId: "111222333" }), TWO_PROPERTIES);
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    await waitFor(() => expect(picker().dataset.lanePickerState).toBe("ready"));
    expect(picker().textContent).toContain("111222333 — not in the connected account");
    expect(document.querySelector('[data-lane-picker-typed="ga4"]')).not.toBeNull();
  });

  it("degrades to the text box when the account cannot be read", async () => {
    stubEditing(ga4Lane(), null);
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    await waitFor(() => expect(picker().dataset.lanePickerState).toBe("unavailable"));
    expect(picker().textContent).toContain("Google did not answer");
    expect(within(picker()).getByRole("textbox")).toBeInTheDocument();
    expect(within(picker()).queryByRole("combobox")).toBeNull();
  });

  it("says the account is not connected rather than showing an empty list", async () => {
    stubEditing(ga4Lane());
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    await waitFor(() => expect(picker().dataset.lanePickerState).toBe("unavailable"));
    expect(picker().textContent).toContain("Google not connected");
  });

  it("refuses a property id the declaration would not accept, and names the field", async () => {
    const puts = stubEditing(ga4Lane());
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    const block = mappingBlock();
    fireEvent.change(within(block).getByLabelText(/GA4 property id/u), {
      target: { value: "properties/123456789" },
    });
    fireEvent.click(within(block).getByRole("button", { name: "Save" }));

    expect(
      await within(block).findByText("GA4 property id: digits only, e.g. 123456789"),
    ).toBeInTheDocument();
    expect(puts).toHaveLength(0);
  });

  it("shows what reads the mapping, which differs per asset, and when a save gets there", async () => {
    stubEditing(ga4Lane());
    const first = renderRoute("meadow.example", "", "sources");

    await first.findByText("Google Analytics");
    openLane("Google Analytics");
    const unmapped = first.container.querySelector<HTMLElement>("[data-lane-mapping-state]")!;
    expect(unmapped).toHaveAttribute("data-lane-mapping-state", "fallback");
    expect(unmapped.textContent).toContain("Using the Google account map");
    expect(unmapped.textContent).toContain("Applies after a restart");
    expect(first.container.textContent).not.toContain("falls back to");
    first.unmount();

    stubEditing(ga4Lane({ propertyId: "123456789" }), NOT_CONNECTED, {
      "config/integrations.json": "store",
    });
    const second = renderRoute("meadow.example", "", "sources");

    await second.findByText("Google Analytics");
    openLane("Google Analytics");
    const mapped = second.container.querySelector<HTMLElement>("[data-lane-mapping-state]")!;
    expect(mapped).toHaveAttribute("data-lane-mapping-state", "register");
    expect(mapped.textContent).toContain("Mapped here");
    // Awaited: the cautious chip renders until `/api/config` answers (see
    // `useConfigWritable`).
    await waitFor(() => expect(mapped.textContent).toContain("Applies on the next run"));
    expect(mapped.textContent).not.toContain("after a restart");
  });

  function declineChips(): HTMLElement {
    const group = document.querySelector("[data-decline-reasons]");
    if (!(group instanceof HTMLElement)) throw new Error("no reason chips");
    return group;
  }

  /** The Undo the save's toast carries, pressed. */
  async function pressUndo(): Promise<void> {
    const options = toasts.success.mock.calls.at(-1)?.[1] as { action?: { onClick: () => void } } | undefined;
    if (!options?.action) throw new Error("the toast carried no Undo");
    options.action.onClick();
  }

  it("declines a source in two presses: Not using, then a reason chip, in one changeset", async () => {
    const puts = stubEditing(ga4Lane({ note: "No GA4 property for this site" }));
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    fireEvent.click(screen.getByRole("button", { name: "Not using" }));
    const chips = declineChips();
    expect(within(chips).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Don't use this product",
      "Replaced by another tool",
      "Not relevant for this site",
      "Other…",
      "",
    ]);
    expect(within(chips).queryAllByRole("button", { pressed: true })).toHaveLength(0);
    expect(puts).toHaveLength(0);

    fireEvent.click(within(chips).getByRole("button", { name: "Not relevant for this site" }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/note",
        expect: "No GA4 property for this site",
        value: "REASON: Not relevant for this site",
      },
      {
        kind: "file-json-set",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/status",
        expect: "needs-setup",
        value: "skipped",
      },
    ]);
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(String(toasts.success.mock.calls[0]?.[0])).toBe("Saved — Google Analytics: not using");

    await pressUndo();
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]?.ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/note",
        expect: "REASON: Not relevant for this site",
        value: "No GA4 property for this site",
      },
      {
        kind: "file-json-set",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/status",
        expect: "skipped",
        value: "needs-setup",
      },
    ]);
  });

  it("declines a new site's source as a first write, and undoes it back to no note at all", async () => {
    const puts = stubEditing(ga4Lane({ note: null }));
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    fireEvent.click(screen.getByRole("button", { name: "Not using" }));
    fireEvent.click(within(declineChips()).getByRole("button", { name: "Replaced by another tool" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/note",
        expectAbsent: true,
        value: "REASON: Replaced by another tool",
      },
      {
        kind: "file-json-set",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/status",
        expect: "needs-setup",
        value: "skipped",
      },
    ]);

    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    await pressUndo();
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]?.ops).toEqual([
      {
        kind: "file-json-delete",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/note",
        expect: "REASON: Replaced by another tool",
      },
      {
        kind: "file-json-set",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/status",
        expect: "skipped",
        value: "needs-setup",
      },
    ]);
  });

  it("undoes a first decline by putting the posture back and keeping the reason as history", async () => {
    // A blank note cannot be written back, so that half of the Undo is not
    // offered.
    const puts = stubEditing(ga4Lane({ note: "" }));
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    fireEvent.click(screen.getByRole("button", { name: "Not using" }));
    fireEvent.click(within(declineChips()).getByRole("button", { name: "Replaced by another tool" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.ops[0]).toMatchObject({ pointer: "/assets/meadow.example/ga4/note", expect: "", value: "REASON: Replaced by another tool" });

    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    await pressUndo();
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1]?.ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/status",
        expect: "skipped",
        value: "needs-setup",
      },
    ]);
  });

  it("takes the operator's own words and writes the prefix for them", async () => {
    const puts = stubEditing(ga4Lane({ note: "REASON: an older decision" }));
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    fireEvent.click(screen.getByRole("button", { name: "Not using" }));
    fireEvent.click(within(declineChips()).getByRole("button", { name: "Other…" }));
    const own = within(declineChips()).getByLabelText("Your reason") as HTMLInputElement;
    expect(own.maxLength).toBe(82);
    fireEvent.change(own, { target: { value: "  Moved to Plausible  " } });
    fireEvent.click(within(declineChips()).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.ops.map((op) => [op.pointer, (op as { value: unknown }).value])).toEqual([
      ["/assets/meadow.example/ga4/note", "REASON: Moved to Plausible"],
      ["/assets/meadow.example/ga4/status", "skipped"],
    ]);
  });

  it("closes the chips without writing anything", async () => {
    const puts = stubEditing(ga4Lane());
    const { findByText } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    fireEvent.click(screen.getByRole("button", { name: "Not using" }));
    fireEvent.click(within(declineChips()).getByRole("button", { name: "Cancel" }));
    expect(document.querySelector("[data-decline-reasons]")).toBeNull();
    expect(screen.getByRole("button", { name: "Not using" })).toBeInTheDocument();
    expect(puts).toHaveLength(0);
  });

  it("shows a declined source's reason in the operator's words, and Use again is one press", async () => {
    const puts = stubEditing(
      ga4Lane({ declared: "skipped", effective: "skipped", note: "REASON: Replaced by another tool" }),
    );
    const { findByText, container } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    expect(container.querySelector("[data-lane-reason]")?.textContent).toBe("Replaced by another tool");
    openLane("Google Analytics");
    expect(container.textContent).not.toMatch(/REASON:/u);
    expect(screen.queryByRole("button", { name: "Not using" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Use again" }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.ops).toEqual([
      {
        kind: "file-json-set",
        file: "config/integrations.json",
        pointer: "/assets/meadow.example/ga4/status",
        expect: "skipped",
        value: "needs-setup",
      },
    ]);
  });

  it("does not read an old decline reason as what blocks a source in use again", async () => {
    stubEditing(ga4Lane({ note: "REASON: Replaced by another tool" }));
    const first = renderRoute("meadow.example", "", "sources");
    await first.findByText("Google Analytics");
    openLane("Google Analytics");
    expect(first.container.querySelector("[data-lane-note]")).toBeNull();
    first.unmount();

    stubEditing(ga4Lane({ note: "Viewer grant pending on the GA4 property" }));
    const second = renderRoute("meadow.example", "", "sources");
    await second.findByText("Google Analytics");
    openLane("Google Analytics");
    expect(second.container.querySelector("[data-lane-note]")?.textContent).toBe("Viewer grant pending on the GA4 property");
  });

  it("leaves the observed chip alone — the operator's choice is not a health toggle", async () => {
    stubEditing(
      ga4Lane({ declared: "skipped", effective: "live", note: "REASON: declined." }),
      NOT_CONNECTED,
      {},
      null,
      new Date(Date.now() - 60_000).toISOString(),
      true,
    );
    googleAnswers([{ capability: "ga4-daily", state: "healthy" }]);
    const { findByText, container } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    const card = container.querySelector('[data-lane-config="ga4"]')!.closest("li")!;
    expect(card.querySelectorAll("[data-connection]")).toHaveLength(1);
    expect(card.querySelector("[data-connection]")).toHaveAttribute("data-connection", "working");
    expect(card.querySelector('[data-lane-use-again="ga4"]')).not.toBeNull();
  });

  it("opens a source's settings on its mapping alone, never a checklist restating its status", async () => {
    stubEditing(ga4Lane({ propertyId: "123456789", effective: "live", declared: "live" }));
    const { findByText, container } = renderRoute("meadow.example", "", "sources");

    await findByText("Google Analytics");
    openLane("Google Analytics");
    expect(container.querySelectorAll("[data-lane-step]")).toHaveLength(0);
    expect(container.querySelector('[data-lane-mapping="ga4"]')).not.toBeNull();
  });
});

describe("AssetDetailRoute — data the OS already paid for", () => {
  /** A supporting series long enough for the row to claim a trend. */
  const dailySeries = (values: number[]) =>
    values.map((v, index) => ({
      t: new Date(Date.UTC(2026, 5, 8 + index)).toISOString().slice(0, 10),
      v,
    }));

  it.each(["unequal coverage", "timezone change"] as const)("withholds headline and supporting percentages for %s", async (reason) => {
    const data = payload();
    const all = dailySeries([...Array<number>(7).fill(100), ...Array<number>(7).fill(200)]);
    const trend = {
      series: reason === "unequal coverage" ? all.filter((_, index) => index !== 1) : all,
      provisionalFrom: null,
      collectedAt: "2026-07-05T11:45:00.000Z",
      timeZoneChanges: reason === "timezone change"
        ? [{ effectiveOn: "2026-06-16", from: "America/Los_Angeles", to: "America/New_York" }]
        : [],
    };
    data.performance = { ...data.performance, sessions: trend, pageViews: trend };
    stubFetch(200, data);
    const { container, findByText } = renderPath("/assets/meadow.example/growth?range=7");
    await findByText("Also collected");
    const head = container.querySelector('[data-growth-chart="Sessions"] [data-growth-delta]')!;
    const supporting = container.querySelector('[data-collected-delta="page-views"]')!;
    for (const movement of [head, supporting]) {
      expect(movement.textContent).toContain("Not comparable");
      expect(movement.textContent).not.toContain("%");
      const evidence = movement.querySelector('[aria-label^="Not comparable:"]')!;
      expect(evidence.getAttribute("aria-label")).toContain(reason === "unequal coverage"
        ? "7 vs 6 days reported" : "reporting timezone changed");
      expect(evidence).toHaveAttribute("data-tone", "neutral");
    }
  });

  it("charts the GA4 and Search Console series that had no reader at all", async () => {
    const data = payload();
    // Fourteen complete days, so a 7-day window has a full 7-day window behind
    // it and the comparison is like-for-like on both sides.
    data.performance = {
      ...data.performance,
      sessions: {
        series: dailySeries([
          100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230,
        ]),
        provisionalFrom: null,
        collectedAt: "2026-07-05T11:45:00.000Z",
        timeZoneChanges: [],
      },
      searchPosition: {
        series: dailySeries([
          14, 13.8, 13.6, 13.4, 13.2, 13, 12.8, 12.6, 12.4, 12.2, 12, 11.8,
          11.6, 11.4,
        ]),
        provisionalFrom: null,
        collectedAt: "2026-07-05T11:45:00.000Z",
        timeZoneChanges: [],
      },
      webSearchImpressions: {
        ...data.performance.webSearchImpressions,
        google: {
          series: dailySeries(Array.from({ length: 14 }, () => 100)),
          provisionalFrom: null,
          collectedAt: "2026-07-05T11:45:00.000Z",
          timeZoneChanges: [],
        },
      },
    };
    stubFetch(200, data);
    const { container, findByText } = renderPath(
      "/assets/meadow.example/growth?range=7",
    );

    await findByText("Also collected");
    const sessions = container.querySelector('[data-growth-chart="Sessions"]')!;
    expect(sessions.textContent).toContain("1,400 visits");
    const strip = container.querySelector("#also-collected")!;
    expect(strip.textContent).toContain("Average position");
    expect(strip.textContent).toContain("12.0");
    const position = strip.querySelector('[data-collected-delta="search-position"]')!;
    expect(
      position.querySelector("[data-tone]")?.getAttribute("data-tone"),
    ).toContain("positive");
    expect(position.querySelector("[data-tone]")?.getAttribute("title")).toContain(
      "the last 7 days vs the 7 days before",
    );
    expect(strip.textContent).not.toContain("Page views");
  });

  it("marks the distorted day on the GA4 supporting trends and leaves the Search Console ones ordinary", async () => {
    const data = payload();
    data.performance = {
      ...data.performance,
      sessions: {
        series: dailySeries([120, 130, 128, 141, 150, 149, 160, 172]),
        provisionalFrom: null,
        collectedAt: "2026-07-05T11:45:00.000Z",
        timeZoneChanges: [
          {
            effectiveOn: "2026-06-12",
            from: "America/Los_Angeles",
            to: "America/New_York",
          },
        ],
      },
      searchPosition: {
        series: dailySeries([14.2, 14, 13.4, 13.1, 12.8, 12.4, 12.2, 11.9]),
        provisionalFrom: null,
        collectedAt: "2026-07-05T11:45:00.000Z",
        timeZoneChanges: [],
      },
    };
    stubFetch(200, data);
    const { container, findByText } = renderRoute("meadow.example", "", "growth");

    await findByText("Also collected");
    const sessions = container.querySelector('[data-growth-chart="Sessions"]')!;
    expect(within(sessions as HTMLElement).getByRole("list")).toHaveTextContent("7-day average");
    expect(sessions.textContent).not.toContain("reporting timezone moved");
    const markers = within(sessions as HTMLElement).getAllByRole("button", { name: /GA4: reporting timezone changed/ });
    expect(markers).toHaveLength(2);
    expect(container.querySelector("#performance [data-section-mark]")).toBeNull();
    fireEvent.focus(markers[1]!);
    const event = screen.getByRole("tooltip");
    expect(event).toHaveTextContent("Jun 12, 2026");
    expect(event).toHaveTextContent("America/Los_Angeles → America/New_York");
    expect(event).toHaveTextContent("value unaltered, not comparable");
    expect(container.querySelector("[data-about]")).toBeNull();
    const position = container.querySelector("#also-collected")!;
    expect(position.textContent).not.toContain("⚠");
  });

  it("withdraws the comparison when its own provider moved its clock", async () => {
    const data = payload();
    // Fifteen complete days: enough for a seven-day average and the one seven
    // days before it, which is the comparison the chip states.
    const days = (values: number[]) => dailySeries(values);
    const ga4Change = {
      effectiveOn: "2026-06-16",
      from: "America/Los_Angeles",
      to: "America/New_York",
    };
    data.performance = {
      ...data.performance,
      sessions: {
        series: days([
          120, 130, 128, 141, 150, 149, 160, 172, 168, 175, 181, 190, 186, 195,
          201,
        ]),
        provisionalFrom: null,
        collectedAt: "2026-07-05T11:45:00.000Z",
        timeZoneChanges: [ga4Change],
      },
      searchPosition: {
        series: days([
          14.2, 14, 13.4, 13.1, 12.8, 12.4, 12.2, 11.9, 11.7, 11.4, 11.1, 10.8,
          10.5, 10.2, 9.9,
        ]),
        provisionalFrom: null,
        collectedAt: "2026-07-05T11:45:00.000Z",
        timeZoneChanges: [],
      },
      webSearchImpressions: {
        ...data.performance.webSearchImpressions,
        google: {
          series: days(Array.from({ length: 15 }, () => 100)),
          provisionalFrom: null,
          collectedAt: "2026-07-05T11:45:00.000Z",
          timeZoneChanges: [],
        },
      },
    };
    stubFetch(200, data);
    const { container, findByText } = renderPath(
      "/assets/meadow.example/growth?range=7",
    );

    await findByText("Also collected");
    const sessions = container.querySelector('[data-growth-chart="Sessions"]')!;
    expect(sessions.querySelector("[data-growth-delta]")?.textContent).toBe("Not comparable");
    expect(
      sessions.querySelector("[data-growth-delta] [data-tone]")?.getAttribute("data-tone"),
    ).toBe("neutral");
    expect(sessions.querySelector("[data-time-zone-caveat]")).toBeNull();
    const caveat = container.querySelector("#performance [data-time-zone-caveat]");
    expect(caveat?.getAttribute("data-time-zone-caveat")).toBe("2026-06-16");
    expect(caveat?.textContent).toContain("Timezone changed · Not comparable");

    const position = container.querySelector(
      '[data-collected-delta="search-position"]',
    )!;
    expect(
      position.querySelector("[data-tone]")?.getAttribute("data-tone"),
    ).not.toBe("neutral");
    expect(position.querySelector("[data-time-zone-caveat]")).toBeNull();

    expect(container.querySelectorAll("[data-time-zone-caveat]")).toHaveLength(1);
  });

  it("states the headline timezone caveat once when two headline series moved on the same change", async () => {
    const data = payload();
    const gscChange = {
      effectiveOn: "2026-06-16",
      from: "America/Los_Angeles",
      to: "America/New_York",
    };
    const gscTrend = (values: number[]) => ({
      series: dailySeries(values),
      provisionalFrom: null,
      collectedAt: "2026-07-05T11:45:00.000Z",
      timeZoneChanges: [gscChange],
    });
    data.performance = {
      ...data.performance,
      webSearchClicks: {
        ...data.performance.webSearchClicks,
        google: gscTrend([
          45, 52, 55, 57, 50, 43, 31, 60, 58, 61, 64, 66, 62, 70, 72,
        ]),
      },
      webSearchImpressions: {
        ...data.performance.webSearchImpressions,
        google: gscTrend([
          900, 1000, 1040, 1100, 1060, 940, 700, 990, 1010, 1080, 1120, 1160,
          1090, 1200, 1240,
        ]),
      },
    };
    stubFetch(200, data);
    const { container, findAllByText } = renderPath(
      "/assets/meadow.example/growth?range=7",
    );

    await findAllByText("Clicks");
    const caveats = container.querySelectorAll("[data-time-zone-caveat]");
    expect(caveats).toHaveLength(1);
    expect(caveats[0]?.getAttribute("data-time-zone-caveat")).toBe("2026-06-16");
    const help = within(caveats[0]!.parentElement!).getByRole("button", { name: "About search charts" });
    fireEvent.click(help);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Google and Bing added, one line each");
  });

  it("withdraws headline percentages per series across a distorted window", async () => {
    const data = payload();
    const change = {
      effectiveOn: "2026-06-16",
      from: "America/Los_Angeles",
      to: "America/New_York",
    };
    const trend = (values: number[], changes: typeof change[]) => ({
      series: dailySeries(values),
      provisionalFrom: null,
      collectedAt: "2026-07-05T11:45:00.000Z",
      timeZoneChanges: changes,
    });
    data.performance = {
      ...data.performance,
      activeUsers: trend(
        [90, 100, 104, 110, 106, 94, 70, 99, 108, 112, 118, 121, 99, 88, 126],
        [change],
      ),
      webSearchClicks: {
        ...data.performance.webSearchClicks,
        google: trend(
          [45, 52, 55, 57, 50, 43, 31, 60, 58, 61, 64, 66, 62, 70, 72],
          [change],
        ),
      },
      webSearchImpressions: {
        ...data.performance.webSearchImpressions,
        google: trend(
          [900, 1000, 1040, 1100, 1060, 940, 700, 990, 1010, 1080, 1120, 1160,
            1090, 1200, 1240],
          [],
        ),
      },
    };
    stubFetch(200, data);
    const { container, findAllByText } = renderPath(
      "/assets/meadow.example/growth?range=7",
    );

    await findAllByText("Clicks");
    const tone = (chart: string) =>
      container
        .querySelector(`[data-growth-chart="${chart}"] [data-growth-delta] [data-tone]`)
        ?.getAttribute("data-tone");
    expect(
      container.querySelector('[data-growth-chart="Active users"] [data-growth-delta]')
        ?.textContent,
    ).toBe("Not comparable");
    expect(tone("Active users")).toBe("neutral");
    expect(tone("Clicks")).toBe("neutral");
    expect(tone("Impressions")).not.toBe("neutral");

    const caveats = [...container.querySelectorAll("[data-time-zone-caveat]")];
    expect(caveats).toHaveLength(2);
    expect(
      caveats.map((node) => node.getAttribute("data-time-zone-caveat")),
    ).toEqual(["2026-06-16", "2026-06-16"]);
  });

  it("waits for the nightly sweep: the hourly home-page check alone draws no Site health", async () => {
    const reading = { date: "2026-07-05", observedAt: "2026-07-05T11:00:00.000Z", status: "ok" as const, value: 120 };
    stubFetch(200, payload({ hygiene: {
      windowDays: 90,
      htmlDepth: { check: "html-depth", readings: [reading], latest: reading },
      robots: { check: "robots-ai-access", readings: [], latest: null },
      sitemap: { check: "sitemap", readings: [], latest: null },
      bots: [],
    } }));
    const { findAllByText, queryByText } = renderRoute("meadow.example", "", "sources");
    await findAllByText("Data sources");
    expect(queryByText("Site health")).toBeNull();
  });

  describe("Failed fetches — each failed nightly fetch, one line", () => {
    /** The same site, its report FETCHED by the OS. */
    function fetched(over: Partial<AssetDetailPayload> = {}): AssetDetailPayload {
      const base = payload(over);
      return {
        ...base,
        wiring: {
          ...base.wiring,
          mode: "pull",
          pull: {
            index: 0, url: "https://meadow.example/api/internal/metrics", enabled: true, format: "envelope",
            metricMap: null, auth: "Site token", authOwner: "workers/ingest/.dev.vars",
          },
          push: null,
        },
      };
    }
    const failure = (at: string, ongoing: boolean, inputs: Record<string, unknown>) => ({
      at, ongoing, message: `pull failed: ${String(inputs.error)}`, ruleInputs: inputs,
    });

    it("lists each night: a mark, the cause in the provider's words, and when — red while it is still failing", async () => {
      stubFetch(200, fetched({ fetchFailures: [
        failure("2026-07-05T02:30:00.000Z", true, { status: 401, providerError: "unauthorized", error: "401 unauthorized — token expired" }),
        failure("2026-07-04T02:30:00.000Z", true, { status: 503, providerError: "unconfigured", error: "503 unconfigured — set CF_ACCOUNT_ID" }),
        failure("2026-06-20T02:30:00.000Z", false, { status: 404, error: "non-200 response (404)" }),
      ] }));
      const { container, findByText } = renderRoute("meadow.example", "", "sources");
      await findByText("Failed fetches");
      const rows = [...container.querySelectorAll<HTMLElement>("[data-fetch-failure]")];
      expect(rows.map((row) => row.dataset.fetchFailure)).toEqual(["ongoing", "ongoing", "past"]);
      expect(rows[0]).toHaveTextContent("401 unauthorized");
      expect(rows[0]).toHaveTextContent(/\d+\S* ago$/);
      expect(rows[1]).toHaveTextContent("503 unconfigured");
      expect(rows[2]).toHaveTextContent("non-200 response (404)");
      expect(within(rows[1]!).getByTitle("503 unconfigured — set CF_ACCOUNT_ID")).toBeInTheDocument();
      expect(rows[0]!.querySelector("time")?.getAttribute("dateTime")).toBe("2026-07-05T02:30:00.000Z");
    });

    it("says No record yet when none is recorded", async () => {
      stubFetch(200, fetched({ fetchFailures: [] }));
      const view = renderRoute("meadow.example", "", "sources");
      await view.findByText("Failed fetches");
      expect(view.getByText("No record yet")).toBeInTheDocument();
    });

    it("draws nothing for a site that sends its own report", async () => {
      stubFetch(200, payload({ fetchFailures: [] }));
      const { findAllByText, queryByText } = renderRoute("meadow.example", "", "sources");
      await findAllByText("Data sources");
      expect(queryByText("Failed fetches")).toBeNull();
    });
  });

  it.each([2, 3])("retains failed hygiene checks as gaps and requires three numeric observations (%i)", async (count) => {
    const readings = [
      { date: "2026-07-01", observedAt: "2026-07-01T04:00:00.000Z", status: "ok" as const, value: 100 },
      { date: "2026-07-02", observedAt: "2026-07-02T04:00:00.000Z", status: "error" as const, value: null },
      { date: "2026-07-03", observedAt: "2026-07-03T04:00:00.000Z", status: "ok" as const, value: 200 },
      ...(count === 3 ? [{ date: "2026-07-05", observedAt: "2026-07-05T04:00:00.000Z", status: "ok" as const, value: 300 }] : []),
    ];
    const robots = { date: "2026-07-05", observedAt: "2026-07-05T04:00:00.000Z", status: "ok" as const, value: null };
    stubFetch(200, payload({ hygiene: {
      windowDays: 90,
      htmlDepth: { check: "html-depth", readings, latest: readings.at(-1)! },
      robots: { check: "robots-ai-access", readings: [robots], latest: robots },
      sitemap: { check: "sitemap", readings: [], latest: null },
      bots: [],
    } }));
    const { container, findByText } = renderRoute("meadow.example", "", "sources");
    await findByText("Site health");
    const card = container.querySelector<HTMLElement>('[data-hygiene-check="html-depth"]')!;
    const chart = within(card).queryByRole("img");
    if (count === 2) {
      expect(chart).toBeNull();
      return;
    }
    expect(card).toHaveTextContent("7-day average");
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: /trend details/ }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Jul 1–Jul 5");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.focus(chart!);
    expect(screen.getByRole("status")).toHaveTextContent("7-day average: 200 words of visible text");
    fireEvent.keyDown(chart!, { key: "Home" });
    fireEvent.keyDown(chart!, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("Jul 2");
    expect(screen.getByRole("status")).toHaveTextContent("No report");
    fireEvent.keyDown(chart!, { key: "ArrowRight" });
    fireEvent.keyDown(chart!, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("Jul 4");
    expect(screen.getByRole("status")).toHaveTextContent("No report");
  });

  it("renders the nightly site-health history the OS already collects", async () => {
    stubFetch(
      200,
      payload({
        hygiene: {
          windowDays: 90,
          htmlDepth: {
            check: "html-depth",
            readings: [
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
            ],
            latest: {
              date: "2026-07-05",
              observedAt: "2026-07-05T04:00:00.000Z",
              status: "warn",
              value: 88,
            },
          },
          robots: {
            check: "robots-ai-access",
            readings: [
              {
                date: "2026-07-05",
                observedAt: "2026-07-05T04:00:00.000Z",
                status: "warn",
                value: null,
              },
            ],
            latest: {
              date: "2026-07-05",
              observedAt: "2026-07-05T04:00:00.000Z",
              status: "warn",
              value: null,
            },
          },
          sitemap: {
            check: "sitemap",
            readings: [
              {
                date: "2026-07-04",
                observedAt: "2026-07-04T04:00:00.000Z",
                status: "ok",
                value: 4120,
              },
              {
                date: "2026-07-05",
                observedAt: "2026-07-05T04:00:00.000Z",
                status: "error",
                value: null,
              },
            ],
            latest: {
              date: "2026-07-05",
              observedAt: "2026-07-05T04:00:00.000Z",
              status: "error",
              value: null,
            },
          },
          bots: [
            { bot: "GPTBot", allowed: true },
            { bot: "ClaudeBot", allowed: false },
          ],
        },
      }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "sources");
    await findByText("Site health");

    expect(container.textContent).toContain("88");
    expect(container.textContent).toContain("words of visible text");
    expect(
      container.querySelector('[data-hygiene-check="html-depth"]')?.textContent,
    ).not.toContain("Jul 5, 2026");
    const blocked = container.querySelector('[data-hygiene-bot="ClaudeBot"]');
    expect(blocked?.textContent).toContain("blocked");
    expect(
      container.querySelector('[data-hygiene-bot="GPTBot"]')?.textContent,
    ).toContain("allowed");
    expect(container.textContent).toContain("Bad response");
    expect(container.textContent).toContain("Flagged");
    expect(container.textContent).toContain("URLs listed");
  });

  it("makes a stopped nightly health guard amber while a fresh one stays quiet", async () => {
    const freshAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const staleAt = new Date(Date.now() - 72 * 3_600_000).toISOString();
    const reading = (
      check: "html-depth" | "robots-ai-access" | "sitemap",
      observedAt: string,
      value: number | null,
    ) => ({
      check,
      readings: [
        {
          date: observedAt.slice(0, 10),
          observedAt,
          status: "ok" as const,
          value,
        },
      ],
      latest: {
        date: observedAt.slice(0, 10),
        observedAt,
        status: "ok" as const,
        value,
      },
    });
    stubFetch(
      200,
      payload({
        hygiene: {
          windowDays: 90,
          htmlDepth: reading("html-depth", freshAt, 900),
          robots: reading("robots-ai-access", staleAt, null),
          sitemap: reading("sitemap", freshAt, 4200),
          bots: [],
        },
      }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "sources");
    await findByText("Site health");

    const fresh = container.querySelector('[data-hygiene-check="html-depth"]');
    const stale = container.querySelector('[data-hygiene-check="robots-ai-access"]');
    const freshBadge = fresh?.querySelector('[title="Data age"]');
    const staleBadge = stale?.querySelector('[title^="Stale"]');
    expect(freshBadge).not.toBeNull();
    expect(freshBadge?.className).not.toContain("text-warn");
    expect(staleBadge).not.toBeNull();
    expect(staleBadge?.className).toContain("text-warn");
    expect(staleBadge?.textContent).toContain("3d");
  });

  it("renders no site-health section before the guard's first night", async () => {
    stubFetch(200, payload({ hygiene: null }));
    const { container, findByText, queryByRole } = renderRoute("meadow.example", "", "sources");
    await findByText("Daily metrics");
    expect(queryByRole("region", { name: "Site health" })).toBeNull();
    expect(container.querySelector("[data-hygiene-check]")).toBeNull();
  });

  it("shows the pre-registered checks and what the closed ones concluded", async () => {
    stubFetch(
      200,
      payload({
        watches: {
          open: [
            {
              id: "w1",
              metricIntegration: "gsc",
              metric: "clicks",
              scope: null,
              refKind: "annotation",
              ref: "41",
              registeredAt: "2026-06-20T09:00:00.000Z",
              nextCheckDate: "2026-07-04",
              readings: 1,
              checks: 3,
              status: "open",
              outcome: null,
              outcomeNote: null,
              closedAt: null,
              note: "June title batch",
            },
          ],
          closed: [
            {
              id: "w2",
              metricIntegration: "ga4",
              metric: "active_users",
              scope: null,
              refKind: "manual",
              ref: "spring-redesign",
              registeredAt: "2026-05-01T09:00:00.000Z",
              nextCheckDate: null,
              readings: 1,
              checks: 1,
              status: "closed",
              outcome: "inconclusive",
              outcomeNote: "Change was inside normal variation.",
              closedAt: "2026-05-15T04:00:00.000Z",
              note: null,
            },
          ],
          history: [],
        },
      }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "activity");

    await findByText("Bets");
    expect(container.textContent).toContain("Google clicks");
    expect(container.textContent).toContain("Jul 4, 2026");
    expect(container.textContent).toContain("next check");
    expect(container.textContent).toContain("Analytics active users");
    expect(container.textContent).toContain("No clear change");
    const ring = container.querySelector("[data-watch-progress] [data-progress-ring]");
    expect(ring?.getAttribute("data-done")).toBe("1");
    expect(ring?.getAttribute("data-total")).toBe("3");
    expect(ring?.getAttribute("aria-label")).toBe("1 of 3 checks read");
    expect(container.textContent).not.toContain("1 of 3 read");
    openRow("Google clicks");
    openRow("Analytics active users");
    expect(
      container.querySelector(
        '[data-watch-id="w1"] [data-watch-ref-unresolved]',
      )?.textContent,
    ).toBe("event 41");
    expect(
      container.querySelector(
        '[data-watch-id="w2"] [data-watch-ref-unresolved]',
      )?.textContent,
    ).toBe("ref spring-redesign");
  });

  it("names a checked query beside its series and shows only the figures once opened", async () => {
    stubFetch(
      200,
      payload({
        watches: {
          open: [],
          closed: [
            {
              id: "w-query",
              metricIntegration: "gsc",
              metric: "clicks",
              scope: { query: "high protein meal plan" },
              refKind: "manual",
              ref: "title-batch",
              registeredAt: "2026-06-20T09:00:00.000Z",
              nextCheckDate: null,
              readings: 2,
              checks: 2,
              status: "closed",
              outcome: "ship_confirmed",
              outcomeNote: "13/day vs baseline 10/day (+30%)",
              closedAt: "2026-07-18T03:30:00.000Z",
              note: null,
            },
          ],
          history: [],
        },
      }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "activity");

    await findByText("Bets");
    expect(container.querySelector("[data-watch-scope-subject]")?.textContent).toBe(
      "“high protein meal plan”",
    );
    openRow("Google clicks");
    expect(container.textContent).toContain("13/day vs baseline 10/day (+30%)");
    expect(container.textContent).not.toContain("gsc/clicks");
    expect(container.textContent).not.toMatch(/at \+\d+d/);
  });

  it("shows the originating task on a watch without borrowing its verdict", async () => {
    stubFetch(
      200,
      payload({
        handoffBeads: [
          {
            kind: "query",
            key: "tornado kit specs",
            beadId: "md-1w2",
            status: "closed",
            closedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        watches: {
          open: [
            {
              id: "watch-for-mp-1w2",
              metricIntegration: "gsc",
              metric: "clicks",
              scope: null,
              refKind: "manual",
              ref: "md-1w2",
              registeredAt: "2026-07-30T09:00:00.000Z",
              nextCheckDate: "2026-08-06",
              readings: 1,
              checks: 3,
              status: "open",
              outcome: null,
              outcomeNote: null,
              closedAt: null,
              note: "Did the shipped query work improve clicks?",
            },
          ],
          closed: [],
          history: [],
        },
      }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "activity");
    await findByText("Bets");

    openRow("Google clicks");
    const row = container.querySelector('[data-watch-id="watch-for-mp-1w2"]');
    const badge = row?.querySelector('[data-handoff-bead="closed"]');
    expect(badge?.textContent).toContain("md-1w2");
    expect(badge?.getAttribute("title")).toContain("not proof of shipment or outcome");
    expect(row?.querySelector("[data-watch-ref-unresolved]")).toBeNull();
    expect(row?.textContent).not.toMatch(
      /Improvement confirmed|Decline confirmed|No clear change|Could not be measured/,
    );
  });

  it("says no change is logged once, in the answer, instead of an age badge", async () => {
    stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example", "", "activity");
    await findByText("Timeline");

    expect(container.querySelector('[data-activity-answer="none"] h2')).toHaveTextContent("No changes logged yet");
    expect(container.querySelector("[data-lane-age]")).toBeNull();
  });

  it("tells an unreadable Timeline timestamp apart from one that never arrived", async () => {
    stubFetch(
      200,
      payload({ freshness: { ...payload().freshness, annotationAt: "not-a-date" } }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "activity");
    await findByText("Timeline");

    expect(container.querySelector('[data-activity-answer="unreadable"] h2')).toHaveTextContent("Last change date unreadable");
  });

  it("says nothing about watches when none are registered — there is no way to add one here", async () => {
    stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example", "", "activity");

    await findByText("Timeline");
    expect(container.textContent).not.toContain("Bets");
  });

  it("reads the link-outreach campaign as a funnel and the targets that moved", async () => {
    stubFetch(
      200,
      payload({
        reclamation: {
          counts: [
            { status: "queued", count: 33 },
            { status: "sent", count: 6 },
            { status: "opened", count: 5 },
            { status: "clicked", count: 4 },
            { status: "replied", count: 1 },
            { status: "skip", count: 10 },
          ],
          total: 59,
          recent: [
            {
              id: 1,
              domain: "city.extension.example",
              status: "replied",
              statusAt: "2026-07-14",
            },
            { id: 2, domain: "school-meadow.example", status: "queued", statusAt: null },
          ],
        },
      }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "activity");

    await findByText("Link outreach");
    for (const stage of ["33", "to pitch", "6", "sent", "5", "opened", "4", "clicked", "1", "replied"]) {
      expect(container.textContent).toContain(stage);
    }
    expect(container.textContent).not.toContain("link updated");
    expect(container.textContent).toContain("10 never pitch");
    expect(container.textContent).toContain("59 targets in all");
    expect(container.textContent).toContain("city.extension.example");
    expect(container.textContent).toContain("Jul 14, 2026");
    expect(container.textContent).toContain("school-meadow.example");
    const outreach = screen.getByRole("region", { name: "Link outreach" });
    expect(within(outreach).queryAllByRole("button")).toHaveLength(0);
    expect(within(outreach).queryAllByRole("link")).toHaveLength(0);
    expect(within(outreach).queryAllByRole("textbox")).toHaveLength(0);
  });

  it("states the reconciled net and keeps the estimates out of it", async () => {
    // A mixed month whose blended net would be $644.20: that number must
    // appear nowhere.
    stubFetch(200, payload({ ledger: MIXED_LEDGER }));
    const { findAllByText, findByText } = renderRoute("meadow.example", "", "financials");

    const section = (await findByText("Monthly accounting")).closest(CARD)!;
    // The month names the strip's cell and a row in the entries table below
    // it; the label is a span, the table cell a <td>.
    const tile = (await findAllByText("June 2026"))
      .find((node) => node.tagName === "SPAN")!.parentElement!;
    expect(tile.textContent).toContain("$498.10");
    expect(tile.textContent).toContain("$146.10");
    expect(tile.textContent).not.toContain("$644.20");
    expect(section.textContent).toContain("booked");
    expect(section.textContent).not.toContain("named separately");
    expect(tile.textContent).toContain("forecast $146.10");
    expect(section.textContent).not.toContain("estimated");
    expect(section.textContent).not.toContain("reconciled");
    expect(tile.textContent).toContain("ads $498.10");
    expect(tile.textContent).not.toContain("affiliate");
    expect(tile.textContent).not.toContain("inference");
  });

  it("draws the booked line even with nothing reconciled, so the forecast cannot take its place", async () => {
    stubFetch(
      200,
      payload({
        ledger: {
          ...MIXED_LEDGER,
          periods: [
            {
              period: "2026-06",
              booked: { figure: { currency: 'USD', revenue: 0, cost: 0, net: 0 }, revenueByFamily: [], costByFamily: [] },
              forecast: MIXED_LEDGER.periods[0]!.forecast,
            },
          ],
        },
      }),
    );
    const { findAllByText, findByText } = renderRoute("meadow.example", "", "financials");

    await findByText("Monthly accounting");
    const tile = (await findAllByText("June 2026"))
      .find((node) => node.tagName === "SPAN")!.parentElement!;
    expect(tile.textContent).toContain("—");
    expect(tile.textContent).toContain("forecast $146.10");
    expect(tile.textContent).not.toContain("$0.00");
  });

  it("states the panel-review obligation the card only marks", async () => {
    stubFetch(
      200,
      payload({
        panelReview: {
          beadId: "md-4a2",
          panelDate: "2026-07-01",
          dueAt: "2026-07-04T06:00:00.000Z",
          status: "open",
          closedAt: null,
          panel: true,
        },
        latestPanelDate: "2026-07-01",
      }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "activity");

    await findByText("Timeline");
    const line = container.querySelector("[data-panel-review-line]")!;
    expect(line.getAttribute("data-panel-review-line")).toBe("overdue");
    expect(line.textContent).toContain("Jul 1, 2026");
    expect(line.textContent).toContain("Jul 4, 2026");
    expect(line.textContent).toContain("md-4a2");
  });

  it("says nothing about a panel review for an asset with no panel", async () => {
    stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example", "", "activity");

    await findByText("Timeline");
    expect(container.querySelector("[data-panel-review-line]")).toBeNull();
  });

  it("keeps the obligation visible on an asset with no acquisition history", async () => {
    stubFetch(
      200,
      payload({
        performance: {
          activeUsers: emptyTrend(),
          webSearchClicks: { google: emptyTrend(), bing: emptyTrend() },
          webSearchImpressions: { google: emptyTrend(), bing: emptyTrend() },
          ...noSecondarySeries(),
        },
        executive: null,
        panelReview: {
          beadId: "md-4a2",
          panelDate: "2026-07-01",
          // The page reads the real clock (`useNow`), so a still-open
          // deadline must be stated relative to it.
          dueAt: new Date(Date.now() + 4 * 86_400_000).toISOString(),
          status: "open",
          closedAt: null,
          panel: true,
        },
        latestPanelDate: "2026-07-01",
      }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "activity");

    await findByText("Timeline");
    expect(
      container.querySelector("[data-panel-review-line]")!.getAttribute("data-panel-review-line"),
    ).toBe("pending");
  });

  it("says nothing about link outreach for an asset running no campaign", async () => {
    stubFetch(200, payload());
    const { container, findByText, queryByRole } = renderRoute("meadow.example", "", "activity");

    await findByText("Timeline");
    expect(queryByRole("region", { name: "Link outreach" })).toBeNull();
    expect(container.textContent).not.toContain("targets in all");
  });

  it("blocks a future timeline event until its time is corrected", async () => {
    const now = new Date("2026-09-24T12:00:00.000Z").getTime();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const fetchMock = stubFetch(200, payload());
      const { findByRole, findByLabelText, queryByText } = renderRoute("meadow.example", "", "activity");
      await openComposer(findByRole, "event");
      fireEvent.change(await findByLabelText("Description"), {
        target: { value: "Published the updated guide" },
      });
      const time = await findByLabelText("When it happened");
      const record = await findByRole("button", { name: "Record" });
      fireEvent.change(time, { target: { value: toLocalDateTimeInput(now + 120_000) } });
      expect(queryByText("Pick a time that has already happened.")).not.toBeNull();
      expect(record).toBeDisabled();
      fireEvent.submit(record.closest("form")!);
      expect(fetchMock.mock.calls.filter(([, init]) =>
        (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);

      fireEvent.change(time, { target: { value: toLocalDateTimeInput(now + 60_000) } });
      expect(queryByText("Pick a time that has already happened.")).toBeNull();
      expect(record).toBeEnabled();
      fireEvent.change(time, { target: { value: "" } });
      expect(record).toBeDisabled();
      fireEvent.change(time, { target: { value: toLocalDateTimeInput(now - 60_000) } });
      expect(record).toBeEnabled();
      fireEvent.click(record);
      await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) =>
        (init as RequestInit | undefined)?.method === "POST")).toHaveLength(1));
    } finally {
      clock.mockRestore();
    }
  });

  it("records a backdated timeline event through the asset's own write lane", async () => {
    const fetchMock = stubFetch(200, payload());
    const { findByRole, findByLabelText } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "event");
    fireEvent.change(await findByLabelText("What happened"), {
      target: { value: "config" },
    });
    fireEvent.change(await findByLabelText("When it happened"), {
      target: { value: "2026-07-12T18:04" },
    });
    fireEvent.change(await findByLabelText("Description"), {
      target: { value: "rotated the report token" },
    });
    fireEvent.click(await findByRole("button", { name: "Record" }));

    await waitFor(() => {
      const write = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(write).toBeDefined();
      expect(String(write![0])).toBe("/api/assets/meadow.example/annotations");
      const body = JSON.parse(String((write![1] as RequestInit).body)) as {
        kind: string;
        at: string;
        note: string;
      };
      expect(body.kind).toBe("config");
      expect(body.note).toBe("rotated the report token");
      expect(new Date(body.at).getUTCFullYear()).toBe(2026);
      expect(body.at).not.toBe("");
    });
  });

  it("will not submit an event with nothing written on it", async () => {
    stubFetch(200, payload());
    const { findByRole } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "event");
    expect(await findByRole("button", { name: "Record" })).toBeDisabled();
  });
});

// The change is dated relative to the clock rather than pinned, so these read
// the same in any month.
describe("AssetDetailRoute — starting an outcome check without leaving the page", () => {
  const DAY_MS = 86_400_000;
  const changeMs = Date.now() - 20 * DAY_MS;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  function withChange() {
    return payload({
      annotations: {
        items: [
          {
            id: 41,
            at: new Date(changeMs).toISOString(),
            kind: "deploy",
            ref: null,
            note: "July title batch",
          },
        ],
        olderCount: 0,
      },
    });
  }

  function postedBody(fetchMock: ReturnType<typeof stubFetch>) {
    const write = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(write).toBeDefined();
    expect(String(write![0])).toBe("/api/assets/meadow.example/watch-windows");
    return JSON.parse(String((write![1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
  }

  function stubFetchWithQueryHistory(
    body: AssetDetailPayload,
    history: WatchQueryHistory,
  ): ReturnType<typeof stubFetch> {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify(
            String(input).includes("/watch-query-history?") ? history : body,
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("registers the documented shape from one click, prefilled from the change", async () => {
    const fetchMock = stubFetch(200, withChange());
    const { findByRole } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "watch");
    fireEvent.click(await findByRole("button", { name: "Register" }));

    await waitFor(() => {
      expect(postedBody(fetchMock)).toEqual({
        ref_kind: "annotation",
        ref: "41",
        metric_integration: "gsc",
        metric: "clicks",
        // Four whole weeks ending the day BEFORE the change: the day it shipped
        // is part before and part after, so it is not in the window it is
        // measured against.
        baseline_start: day(changeMs - 28 * DAY_MS),
        baseline_end: day(changeMs - DAY_MS),
        check_offsets: [7, 14, 28],
        thresholds: {
          ship: { direction: "up", min_delta_pct: 10 },
          kill: { direction: "down", min_delta_pct: 10 },
        },
        note: "July title batch",
      });
    });
  });

  it("draws the plan before it is registered: win, loss, checks and verdict", async () => {
    stubFetch(200, withChange());
    const { container, findByRole } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "watch");
    const plan = container.querySelector<HTMLElement>("[data-watch-summary]")!;
    const today = new Date(Date.now()).toISOString().slice(0, 10);
    const on = (offset: number) => day(Date.parse(`${today}T00:00:00.000Z`) + offset * DAY_MS);
    expect(plan.textContent).toContain("Win▲ +10%");
    expect(plan.textContent).toContain("Loss▼ −10%");
    expect(plan.textContent).toContain(`Checks${formatSeriesDate(on(7))} · ${formatSeriesDate(on(14))}`);
    expect(plan.textContent).toContain(`Verdict${formatCalendarDate(on(28))}`);
    expect(plan.textContent).not.toMatch(/is the win|read again|days from today/);
  });

  it("refuses a baseline overlapping the registration in the UI, not only at the route", async () => {
    const fetchMock = stubFetch(200, withChange());
    const { container, findByRole, findByLabelText } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "watch");
    fireEvent.change(await findByLabelText("Baseline to"), {
      target: { value: day(Date.now() + 3 * DAY_MS) },
    });

    const register = await findByRole("button", { name: "Register" });
    expect(register).toBeDisabled();
    expect(
      container.querySelector("[data-watch-refusal]")?.textContent,
    ).toContain("Baseline must end by");
    expect(await findByLabelText("Baseline to")).toHaveAttribute(
      "max",
      new Date(Date.now()).toISOString().slice(0, 10),
    );
    fireEvent.click(register);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(false);
    });
  });

  it("refuses an asset-wide average in the UI, not only at the route", async () => {
    const fetchMock = stubFetch(200, withChange());
    const { container, findByRole, findByLabelText } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "watch");
    const picker = await findByLabelText("Which number");
    const averages = picker.querySelector("optgroup");
    expect(averages?.getAttribute("label")).toBe("One query only");
    expect(averages).toHaveProperty("disabled", true);
    expect(averages?.textContent).toContain("Google average position");
    fireEvent.change(picker, {
      target: { value: "gsc:position" },
    });

    const register = await findByRole("button", { name: "Register" });
    expect(register).toBeDisabled();
    expect(
      container.querySelector("[data-watch-refusal]")?.textContent,
    ).toContain("needs one query");
    fireEvent.click(register);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(false);
    });
  });

  it("names what it is watching when there is no timeline event to point at", async () => {
    const fetchMock = stubFetch(200, payload());
    const { findByRole, findByLabelText } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "watch");
    expect(await findByRole("button", { name: "Register" })).toBeDisabled();
    fireEvent.change(await findByLabelText("What are you watching"), {
      target: { value: "moved the recipe hub" },
    });
    fireEvent.click(await findByRole("button", { name: "Register" }));

    await waitFor(() => {
      expect(postedBody(fetchMock)).toMatchObject({
        ref_kind: "manual",
        ref: "moved the recipe hub",
      });
    });
  });

  /** Google clicks flat at 100/day for the whole history: nothing to clear, so
   * the floor is 0 and the smallest usable predicate is 1%. */
  function withFlatClicks() {
    const days = 120;
    const base = withChange();
    return {
      ...base,
      watches: {
        ...base.watches,
        history: [
          {
            integration: "gsc",
            metric: "clicks",
            firstDay: day(Date.now() - (days - 1) * DAY_MS),
            values: Array.from({ length: days }, () => 100),
            recordedChanges: {
              firstDay: day(Date.now() - (days - 1) * DAY_MS),
              lastDay: day(Date.now()),
              days: [],
              complete: true,
            },
          },
        ],
      },
    };
  }

  it("prefills the threshold from this asset's own series, not the README's example", async () => {
    const fetchMock = stubFetch(200, withFlatClicks());
    const { findByRole } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "watch");
    fireEvent.click(await findByRole("button", { name: "Register" }));

    await waitFor(() => {
      expect(postedBody(fetchMock).thresholds).toEqual({
        ship: { direction: "up", min_delta_pct: 1 },
        kill: { direction: "down", min_delta_pct: 1 },
      });
    });
  });

  it("says where the number came from, with the span and the floor behind it", async () => {
    stubFetch(200, withFlatClicks());
    const { container, findByRole } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "watch");
    const line = container.querySelector<HTMLElement>("[data-watch-calibration]")!;
    expect(line.getAttribute("data-watch-calibration-state")).toBe("calibrated");
    expect(line.textContent).toContain("Calibrated");
    expect(line.textContent).toContain("Typical move 0%");
    expect(line.textContent).toMatch(/\d+ comparisons · /);
    const noise = line.querySelector('[data-watch-noise] [role="progressbar"]');
    expect(noise?.getAttribute("aria-label")).toBe("Normal noise 0% against a 1% threshold");
    expect(line.textContent).not.toContain("Inside normal noise");
  });

  it("flags a threshold typed inside the asset's normal noise", async () => {
    // Alternating 100 / 160 by week: the asset moves a lot when nothing ships.
    const days = 120;
    const base = withChange();
    stubFetch(200, {
      ...base,
      watches: {
        ...base.watches,
        history: [
          {
            integration: "gsc",
            metric: "clicks",
            firstDay: day(Date.now() - (days - 1) * DAY_MS),
            values: Array.from({ length: days }, (_, index) =>
              Math.floor(index / 28) % 2 === 0 ? 100 : 160,
            ),
            recordedChanges: {
              firstDay: day(Date.now() - (days - 1) * DAY_MS),
              lastDay: day(Date.now()),
              days: [],
              complete: true,
            },
          },
        ],
      },
    });
    const { container, findByRole, findByLabelText } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "watch");
    fireEvent.change(await findByLabelText("Smallest move that counts %"), {
      target: { value: "2" },
    });
    const line = container.querySelector<HTMLElement>("[data-watch-calibration]")!;
    expect(line.getAttribute("data-watch-calibration-state")).toBe("custom");
    expect(line.textContent).toContain("Your number");
    expect(line.textContent).toContain("Inside normal noise");
  });

  it("marks an older payload historical instead of implying change exclusion", async () => {
    const days = 120;
    const base = withChange();
    stubFetch(200, {
      ...base,
      watches: {
        ...base.watches,
        history: [
          {
            integration: "gsc",
            metric: "clicks",
            firstDay: day(Date.now() - (days - 1) * DAY_MS),
            values: Array.from({ length: days }, () => 100),
          },
        ],
      },
    });
    const { container, findByRole } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "watch");
    const line = container.querySelector("[data-watch-calibration]");
    expect(line?.getAttribute("data-watch-calibration-state")).toBe("historical");
    expect(line?.textContent).toContain("Changes not excluded");
    expect(line?.textContent).not.toContain("skipped");
  });

  it("admits when it is showing the example instead of this asset's number", async () => {
    stubFetch(200, withChange());
    const { container, findByRole } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "watch");
    const line = container.querySelector("[data-watch-calibration]");
    expect(line?.getAttribute("data-watch-calibration-state")).toBe("uncalibrated");
    expect(line?.textContent).toContain("Not calibrated");
    expect(line?.textContent).toContain("Too little history");
    expect(line?.textContent).toContain("Default 10%");
    expect(line?.querySelector("[data-watch-noise]")).toBeNull();
  });

  /** An asset whose query table has one row the panel walls on Google. */
  function withQueryRow() {
    return payload({
      executive: {
        schemaVersion: 1,
        asset: "meadow.example",
        generatedAt: new Date().toISOString(),
        windowStart: "2026-06-01",
        windowEnd: "2026-06-30",
        sourceArchiveCount: 2,
        items: [
          {
            key: "search-striking-distance",
            kind: "recommendation",
            title: "Twelve pages sit just off page one",
            summary: "Twelve pages rank 11–20 on queries with real demand.",
            whyItMatters: "Moving them onto page one is the cheapest reach available.",
            primary: { value: "12", label: "Pages in reach" },
            confidence: "high",
            windowStart: "2026-06-01",
            windowEnd: "2026-06-30",
            evidence: [{ label: "Pages", value: "12" }],
            sources: ["gsc/page-query"],
            caveat: "Modelled demand, not observed clicks.",
          },
        ],
        suppressedItems: [],
        searchQueries: {
          google: null,
          bing: null,
          dataforseo: {
            observedAt: "2026-06-30T00:00:00.000Z",
            source: "dataforseo/ranked-keywords",
            caveat: "Modelled demand.",
            queries: [
              {
                query: "tornado kit specs",
                page: "/tornado-kit",
                organicPosition: 14,
                previousOrganicPosition: null,
                positionImprovement: null,
                aiCitationPosition: null,
                monthlySearches: 4400,
                keywordDifficulty: 21,
                estimatedVisits: 30,
                intent: "informational",
                aiOverview: "none",
                aioDevices: [],
              },
            ],
          },
        },
        searchPages: null,
        productUse: null,
        searchIntelligence: null,
        serpPanel: null,
        methodology: ["Derived from archived provider reports."],
      },
    });
  }

  function queryPositionHistory(
    values: (number | null)[],
    archiveDays: number,
    observedDays: number,
  ): WatchQueryHistory {
    return {
      integration: "gsc",
      metric: "position",
      query: "tornado kit specs",
      firstDay: day(Date.now() - (values.length - 1) * DAY_MS),
      values,
      archiveFirstDay: day(Date.now() - (archiveDays - 1) * DAY_MS),
      archiveLastDay: day(Date.now()),
      archiveDays,
      observedDays,
      recordedChanges: {
        firstDay: day(Date.now() - (values.length - 1) * DAY_MS),
        lastDay: day(Date.now()),
        days: [],
        complete: true,
      },
    };
  }

  it("opens the same composer from a query row, on that row's own metric", async () => {
    const fetchMock = stubFetch(200, withQueryRow());
    const { container, findByRole } = renderRoute("meadow.example", "", "search");

    fireEvent.click(
      await findByRole("button", { name: /watch the outcome for tornado kit specs/i }),
    );
    expect(
      container.querySelectorAll("[aria-label='Register an outcome check']"),
    ).toHaveLength(1);
    expect(
      container.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    ).toBe("Activity");
    fireEvent.click(await findByRole("button", { name: "Register" }));

    await waitFor(() => {
      expect(postedBody(fetchMock)).toMatchObject({
        metric_integration: "gsc",
        metric: "position",
        ref_kind: "manual",
        scope: { query: "tornado kit specs" },
        thresholds: {
          ship: { direction: "down", min_delta_pct: 10 },
          kill: { direction: "up", min_delta_pct: 10 },
        },
      });
      expect(String(postedBody(fetchMock).ref)).toContain("tornado kit specs");
    });
  });

  it("shows and sends the exact query grain", async () => {
    const history = queryPositionHistory(
      [
        ...Array.from({ length: 170 }, () => null),
        ...Array.from({ length: 9 }, () => 14),
        null,
      ],
      10,
      9,
    );
    const fetchMock = stubFetchWithQueryHistory(withQueryRow(), history);
    const { container, findByRole } = renderRoute("meadow.example", "", "search");

    fireEvent.click(
      await findByRole("button", { name: /watch the outcome for tornado kit specs/i }),
    );
    const scope = container.querySelector("[data-watch-scope]");
    expect(scope?.getAttribute("data-watch-scope")).toBe("query");
    expect(scope?.textContent).toBe("Only “tornado kit specs”");
    await waitFor(() => {
      const calibration = container.querySelector("[data-watch-calibration]");
      expect(calibration?.getAttribute("data-watch-calibration-state")).toBe(
        "uncalibrated",
      );
      expect(calibration?.textContent).toContain("Not calibrated");
      expect(calibration?.textContent).toContain("Too few days with this query");
      expect(calibration?.textContent).toContain("Default 10%");
    });

    fireEvent.click(await findByRole("button", { name: "Register" }));
    await waitFor(() => {
      expect(postedBody(fetchMock)).toMatchObject({
        scope: { query: "tornado kit specs" },
      });
    });
  });

  it("offers the way back when a provider widens a query check to the whole site", async () => {
    const fetchMock = stubFetch(200, withQueryRow());
    const { container, findByRole, findByLabelText } = renderRoute("meadow.example", "", "search");

    fireEvent.click(
      await findByRole("button", { name: /watch the outcome for tornado kit specs/i }),
    );
    fireEvent.change(await findByLabelText("Which number"), {
      target: { value: "ga4:sessions" },
    });
    const scope = container.querySelector("[data-watch-scope]");
    expect(scope?.getAttribute("data-watch-scope")).toBe("widened");
    expect(scope?.textContent).toContain("Whole site");
    fireEvent.click(await findByRole("button", { name: "Follow “tornado kit specs”" }));
    expect(container.querySelector("[data-watch-scope]")?.getAttribute("data-watch-scope")).toBe("query");
    fireEvent.click(await findByRole("button", { name: "Register" }));
    await waitFor(() => {
      expect(postedBody(fetchMock)).toMatchObject({
        metric_integration: "gsc",
        metric: "position",
        scope: { query: "tornado kit specs" },
      });
    });
  });

  it("uses the query's quiet-history floor even when the site moves differently", async () => {
    const days = 120;
    const base = withQueryRow();
    const noisySite = {
      ...base,
      watches: {
        ...base.watches,
        history: [
          {
            integration: "gsc",
            metric: "position",
            firstDay: day(Date.now() - (days - 1) * DAY_MS),
            values: Array.from({ length: days }, (_, index) =>
              Math.floor(index / 28) % 2 === 0 ? 10 : 30,
            ),
            recordedChanges: {
              firstDay: day(Date.now() - (days - 1) * DAY_MS),
              lastDay: day(Date.now()),
              days: [],
              complete: true,
            },
          },
        ],
      },
    };
    const queryHistory = queryPositionHistory(
      Array.from({ length: days }, () => 14),
      days,
      days,
    );
    const siteFloor = watchCalibration(noisySite.watches.history[0]!, 28)!;
    expect(siteFloor.suggestedPct).toBeGreaterThan(1);
    const fetchMock = stubFetchWithQueryHistory(noisySite, queryHistory);
    const { container, findByRole } = renderRoute("meadow.example", "", "search");

    fireEvent.click(
      await findByRole("button", { name: /watch the outcome for tornado kit specs/i }),
    );
    await waitFor(() => {
      const calibration = container.querySelector("[data-watch-calibration]");
      expect(calibration?.getAttribute("data-watch-calibration-state")).toBe(
        "calibrated",
      );
      expect(calibration?.textContent).toContain("Query calibrated");
      expect(calibration?.textContent).toContain("Typical move 0%");
      expect(calibration?.textContent).toContain("120 of 120 days carry this query");
      expect(calibration?.textContent).toMatch(/\d+ comparisons · /);
    });

    fireEvent.click(await findByRole("button", { name: "Register" }));
    await waitFor(() => {
      expect(postedBody(fetchMock).thresholds).toEqual({
        ship: { direction: "down", min_delta_pct: 1 },
        kill: { direction: "up", min_delta_pct: 1 },
      });
    });
  });

  it("opens the composer from a finding, on the metric its own sources name", async () => {
    const fetchMock = stubFetch(200, withQueryRow());
    const { container, findByRole, findByText } = renderRoute("meadow.example");

    fireEvent.click(await findByText(/All findings/));
    fireEvent.click(
      await findByRole("button", {
        name: /watch the outcome for twelve pages sit just off page one/i,
      }),
    );
    expect(container.querySelector("[data-watch-scope]")).toBeNull();
    fireEvent.click(await findByRole("button", { name: "Register" }));

    await waitFor(() => {
      expect(postedBody(fetchMock)).toMatchObject({
        metric_integration: "gsc",
        metric: "clicks",
        ref_kind: "manual",
        ref: "Twelve pages sit just off page one",
      });
    });
  });

  /** The same query row, this time with a task already filed from it. */
  function withFiledQueryRow() {
    const base = withQueryRow();
    return {
      ...base,
      handoffBeads: [
        {
          kind: "query" as const,
          key: "tornado kit specs",
          beadId: "md-1w2",
          status: "open" as const,
          closedAt: null,
        },
      ],
    };
  }

  it("registers a check whose ref is the task the row was filed as", async () => {
    const fetchMock = stubFetch(200, withFiledQueryRow());
    const { findByRole } = renderRoute("meadow.example", "", "search");

    fireEvent.click(
      await findByRole("button", { name: /watch the outcome for tornado kit specs/i }),
    );
    fireEvent.click(await findByRole("button", { name: "Register" }));

    await waitFor(() => {
      expect(postedBody(fetchMock)).toMatchObject({
        ref_kind: "manual",
        ref: "md-1w2",
      });
      expect(String(postedBody(fetchMock).note)).toContain("tornado kit specs");
    });
  });

  it("records a timeline event against the task that caused it", async () => {
    const fetchMock = stubFetch(200, withFiledQueryRow());
    const { container, findByRole, findByLabelText } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "event");
    fireEvent.change(await findByLabelText("Description"), {
      target: { value: "rewrote the tornado kit opener" },
    });
    const chooser = container.querySelector<HTMLSelectElement>(
      "[data-annotation-task]",
    )!;
    expect(chooser.value).toBe("");
    fireEvent.change(chooser, { target: { value: "md-1w2" } });
    fireEvent.click(await findByRole("button", { name: "Record" }));

    await waitFor(() => {
      const write = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(String(write![0])).toBe("/api/assets/meadow.example/annotations");
      expect(
        JSON.parse(String((write![1] as RequestInit).body)),
      ).toMatchObject({ kind: "deploy", ref: "md-1w2" });
    });
  });

  it("sends no ref at all when the change was not from a task", async () => {
    // `ref` is part of the store's identity (asset, at, kind, ref), so an empty
    // string is a value and would make two unrelated deploys collide.
    const fetchMock = stubFetch(200, withFiledQueryRow());
    const { findByRole, findByLabelText } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "event");
    fireEvent.change(await findByLabelText("Description"), {
      target: { value: "unrelated config change" },
    });
    fireEvent.click(await findByRole("button", { name: "Record" }));

    await waitFor(() => {
      const write = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(JSON.parse(String((write![1] as RequestInit).body)).ref).toBeNull();
    });
  });

  it("renders a recorded event's ref as the task, without claiming it worked", async () => {
    const base = withFiledQueryRow();
    stubFetch(200, {
      ...base,
      handoffBeads: [
        { ...base.handoffBeads[0]!, status: "closed", closedAt: "2026-08-01T00:00:00.000Z" },
      ],
      annotations: {
        items: [
          {
            id: 41,
            at: new Date(changeMs).toISOString(),
            kind: "deploy",
            ref: "md-1w2",
            note: "rewrote the tornado kit opener",
          },
        ],
        olderCount: 0,
      },
    });
    const { container, findByText } = renderRoute("meadow.example", "", "activity");

    await findByText("Timeline");
    openRow("rewrote the tornado kit opener");
    const badge = container.querySelector('[title*="md-1w2"]');
    expect(badge?.textContent).toContain("md-1w2");
    expect(badge?.getAttribute("title")).toContain("not proof of shipment or outcome");
    expect(container.textContent).not.toMatch(/it worked|confirmed|resolved/i);
  });

  it("re-derives when the operator changes which number is watched", async () => {
    const fetchMock = stubFetch(200, withFlatClicks());
    const { container, findByRole, findByLabelText } = renderRoute("meadow.example", "", "activity");

    await openComposer(findByRole, "watch");
    fireEvent.change(await findByLabelText("Smallest move that counts %"), {
      target: { value: "42" },
    });
    expect(
      container.querySelector("[data-watch-calibration]")?.textContent,
    ).toContain("Your number");

    fireEvent.change(await findByLabelText("Which number"), {
      target: { value: "gsc:impressions" },
    });
    fireEvent.click(await findByRole("button", { name: "Register" }));

    await waitFor(() => {
      expect(postedBody(fetchMock).thresholds).toEqual({
        ship: { direction: "up", min_delta_pct: 10 },
        kill: { direction: "down", min_delta_pct: 10 },
      });
    });
  });
});

describe("AssetDetailRoute — the Settings tab manages the asset", () => {
  /** The PATCH the store lane makes, or undefined when nothing was written. */
  function patchBody(fetchMock: ReturnType<typeof stubFetch>) {
    const call = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    return call
      ? {
          url: String(call[0]),
          body: JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>,
        }
      : undefined;
  }

  it("moves the lifecycle stage through the store lane, with an Undo to come back", async () => {
    toasts.success.mockReset();
    const fetchMock = stubFetch(200, payload());
    const { findByLabelText } = renderRoute("meadow.example", "", "settings");

    const stage = await findByLabelText("Change lifecycle stage");
    fireEvent.change(stage, { target: { value: "baselining" } });
    fireEvent.click(
      [...stage.parentElement!.querySelectorAll("button")].find(
        (b) => b.textContent === "Save",
      )!,
    );

    await waitFor(() => {
      expect(patchBody(fetchMock)).toEqual({
        url: "/api/assets/meadow.example",
        body: { column: "status", value: "baselining", expect: "live" },
      });
    });
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    const [message, options] = toasts.success.mock.calls[0] as [
      string,
      { action?: { label?: string } },
    ];
    expect(message).toBe("Saved — Lifecycle stage");
    expect(options.action?.label).toBe("Undo");
  });

  it("names what archiving stops before it writes anything", async () => {
    const fetchMock = stubFetch(200, payload());
    const { container, findByRole, getByRole } = renderRoute(
      "meadow.example",
      "",
      "settings",
    );

    fireEvent.click(await findByRole("button", { name: "Archive site…" }));
    const confirm = container.querySelector("[data-archive-confirm]")!;
    expect(confirm.textContent).toContain("Archiving Meadow Board stops:");
    expect(confirm.textContent).toContain("Data collection");
    expect(confirm.textContent).toContain("Alerts");
    expect(confirm.textContent).toContain("Its card on Home and the TV dashboard");
    expect(patchBody(fetchMock)).toBeUndefined();

    fireEvent.click(getByRole("button", { name: "Archive site" }));
    await waitFor(() => {
      expect(patchBody(fetchMock)).toEqual({
        url: "/api/assets/meadow.example",
        body: { column: "status", value: "retired", expect: "live" },
      });
    });
  });

  it("offers Restore instead of Archive on an asset that is already retired", async () => {
    const data = payload();
    data.asset = { ...data.asset, status: "retired" };
    const fetchMock = stubFetch(200, data);
    const { findByRole, queryByRole } = renderRoute("meadow.example", "", "settings");

    const restore = await findByRole("button", { name: "Restore" });
    expect(queryByRole("button", { name: "Archive site…" })).toBeNull();

    fireEvent.click(restore);
    await waitFor(() => {
      expect(patchBody(fetchMock)).toEqual({
        url: "/api/assets/meadow.example",
        body: { column: "status", value: "live", expect: "retired" },
      });
    });
  });

  function annotationBody(fetchMock: ReturnType<typeof stubFetch>) {
    const call = fetchMock.mock.calls.find(
      ([input, init]) =>
        (init as RequestInit | undefined)?.method === "POST" &&
        String(input).includes("/annotations"),
    );
    return call
      ? {
          url: String(call[0]),
          body: JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>,
        }
      : undefined;
  }

  /** A retired asset whose archiving IS on record, from `stage`. */
  function archivedFrom(stage: string, at = "2026-07-02T09:00:00.000Z"): AssetDetailPayload {
    const data = payload();
    data.asset = { ...data.asset, status: "retired" };
    data.annotations = {
      items: [{ id: 77, at, kind: "config", ref: `lifecycle:${stage}>retired`, note: null }],
      olderCount: 0,
    };
    return data;
  }

  it("records the stage an archive moved the asset out of", async () => {
    const fetchMock = stubFetch(200, payload());
    const { container, findByRole, getByRole } = renderRoute(
      "meadow.example",
      "",
      "settings",
    );

    fireEvent.click(await findByRole("button", { name: "Archive site…" }));
    expect(container.querySelector("[data-archive-confirm]")).not.toBeNull();
    fireEvent.click(getByRole("button", { name: "Archive site" }));

    await waitFor(() => {
      expect(annotationBody(fetchMock)).toEqual({
        url: "/api/assets/meadow.example/annotations",
        body: { kind: "config", ref: "lifecycle:live>retired" },
      });
    });
  });

  it("records a stage picked from Change stage… too, not only an archive", async () => {
    const fetchMock = stubFetch(200, payload());
    const { findByLabelText } = renderRoute("meadow.example", "", "settings");

    const stage = await findByLabelText("Change lifecycle stage");
    fireEvent.change(stage, { target: { value: "baselining" } });
    fireEvent.click(
      [...stage.parentElement!.querySelectorAll("button")].find(
        (b) => b.textContent === "Save",
      )!,
    );

    await waitFor(() => {
      expect(annotationBody(fetchMock)).toEqual({
        url: "/api/assets/meadow.example/annotations",
        body: { kind: "config", ref: "lifecycle:live>baselining" },
      });
    });
  });

  it("restores to the stage the timeline recorded, and says where that came from", async () => {
    const fetchMock = stubFetch(200, archivedFrom("baselining"));
    const { container, findByRole, queryByRole } = renderRoute(
      "meadow.example",
      "",
      "settings",
    );

    const restore = await findByRole("button", { name: "Restore to Baselining" });
    expect(container.querySelector("[data-restore-default]")).toBeNull();
    expect(container.querySelector("[data-restore-stage]")).toBeNull();
    expect(queryByRole("button", { name: "Restore to Live" })).toBeNull();
    expect(restore.parentElement!.textContent).toContain("Archived 2026-07-02");

    fireEvent.click(restore);
    await waitFor(() => {
      expect(patchBody(fetchMock)).toEqual({
        url: "/api/assets/meadow.example",
        body: { column: "status", value: "baselining", expect: "retired" },
      });
    });
  });

  it("reads the most recent archiving when the asset has been round the loop before", async () => {
    const data = payload();
    data.asset = { ...data.asset, status: "retired" };
    data.annotations = {
      items: [
        { id: 92, at: "2026-07-04T09:00:00.000Z", kind: "config", ref: "lifecycle:onboarding>retired", note: null },
        { id: 91, at: "2026-07-03T09:00:00.000Z", kind: "config", ref: "lifecycle:retired>onboarding", note: null },
        { id: 90, at: "2026-07-02T09:00:00.000Z", kind: "config", ref: "lifecycle:live>retired", note: null },
      ],
      olderCount: 0,
    };
    stubFetch(200, data);
    const { findByRole } = renderRoute("meadow.example", "", "settings");

    await findByRole("button", { name: "Restore to Onboarding" });
  });

  it("offers the stage to restore to when nothing records the stage the asset left", async () => {
    const data = payload();
    data.asset = { ...data.asset, status: "retired" };
    const fetchMock = stubFetch(200, data);
    const { container, findByRole } = renderRoute("meadow.example", "", "settings");

    const restore = await findByRole("button", { name: "Restore" });
    const picker = container.querySelector<HTMLSelectElement>("[data-restore-stage]")!;
    expect(picker.value).toBe("live");
    expect([...picker.options].map((o) => o.value)).not.toContain("retired");
    expect(container.querySelector("[data-restore-default]")!.textContent).toBe("No recorded stage");

    fireEvent.change(picker, { target: { value: "baselining" } });
    fireEvent.click(restore);
    await waitFor(() => {
      expect(patchBody(fetchMock)).toEqual({
        url: "/api/assets/meadow.example",
        body: { column: "status", value: "baselining", expect: "retired" },
      });
    });
  });

  it("ignores a config annotation that is not a lifecycle move", async () => {
    const data = payload();
    data.asset = { ...data.asset, status: "retired" };
    data.annotations = {
      items: [{ id: 60, at: "2026-07-02T09:00:00.000Z", kind: "config", ref: "flags@41", note: "raise alpha" }],
      olderCount: 0,
    };
    stubFetch(200, data);
    const { container, findByRole } = renderRoute("meadow.example", "", "settings");

    await findByRole("button", { name: "Restore" });
    expect(container.querySelector("[data-restore-default]")).not.toBeNull();
  });

  it("states the portfolio-wide knobs and points at Settings instead of editing them here", async () => {
    stubFetch(
      200,
      payload({
        rules: {
          scope: "portfolio-default",
          hasOverride: false,
          knobs: [
            {
              key: "alpha",
              label: "False-positive rate",
              jargon: "alpha",
              value: "0.01",
              explain: "How rare a reading has to be before it is called an anomaly.",
              owner: "config/constants.json",
              pointer: "/flag_defaults/alpha",
              raw: 0.01,
            },
          ],
        },
      }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "settings");

    await findByText("Alert rules in force");
    expect(container.textContent).toContain("False-positive rate");
    const pointers = [...container.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(pointers).toContain("/settings#alert-rules");
    expect(container.textContent).not.toContain("Applies to every site");
    expect(container.textContent).toContain("All sites' rules →");
    expect(container.textContent).not.toContain("Defaults live in Settings");
    // One Save per editable field: display name, automation, nightly report.
    // This fixture pushes, so neither pull knob renders.
    expect(container.querySelectorAll("[data-knob-editor]")).toHaveLength(3);
  });

  it("renames the asset in place, and the way back sits beside the field", async () => {
    toasts.success.mockReset();
    const fetchMock = stubFetch(200, payload());
    const { findByLabelText } = renderRoute("meadow.example", "", "settings");

    const field = await findByLabelText("Display name");
    fireEvent.change(field, { target: { value: "Meadow Board Food" } });
    fireEvent.click(
      [...field.parentElement!.querySelectorAll("button")].find(
        (b) => b.textContent === "Save",
      )!,
    );

    await waitFor(() => {
      expect(patchBody(fetchMock)).toEqual({
        url: "/api/assets/meadow.example",
        body: {
          column: "display_name",
          value: "Meadow Board Food",
          expect: "Meadow Board",
        },
      });
    });

    const editor = field.closest("[data-knob-editor]") as HTMLElement;
    const undo = await within(editor).findByRole("button", { name: "Undo" });
    expect(toasts.success).not.toHaveBeenCalled();

    fireEvent.click(undo);
    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(JSON.parse(String((patches[1]![1] as RequestInit).body))).toEqual({
        column: "display_name",
        value: "Meadow Board",
        expect: "Meadow Board Food",
      });
    });
  });

  it("marks the domain and the asset id as fixed, as a state rather than a sentence", async () => {
    stubFetch(200, payload());
    const { container, findByText } = renderRoute("meadow.example", "", "settings");

    await findByText("Identity");
    const fixed = [...container.querySelectorAll("[data-fixed-value]")];
    expect(fixed.map((node) => node.textContent)).toEqual([
      "meadow.exampleFixed once added",
      "meadow.exampleFixed once added",
    ]);
    for (const node of fixed) expect(node.querySelector("input, select, button")).toBeNull();
    expect(container.textContent).not.toContain("not a rename");
  });

  it("offers no name field on the OS's own row, and keeps the rest of its settings", async () => {
    const data = payload();
    data.asset = { ...data.asset, id: "root-os", displayName: "NoticeOS", domain: null, isOs: true };
    stubFetch(200, data);
    const { container, findByText, queryByLabelText } = renderRoute("root-os", "", "settings");

    await findByText("Identity");
    expect(queryByLabelText("Display name")).toBeNull();
    expect(container.textContent).not.toContain("Display name");
    expect([...container.querySelectorAll("[data-fixed-value]")].map((node) => node.textContent)).toContain(
      "root-osFixed once added",
    );
    await findByText("Alert rules in force");
    expect(container.querySelectorAll("[data-knob-editor]").length).toBeGreaterThan(0);
  });
});

describe("AssetDetailRoute — failed detail read", () => {
  it("renders a failure state with the status, not an endless Loading…", async () => {
    stubFetch(500, { error: "asset_detail_failed" });
    const { container, findByRole } = renderRoute("northwind.example");

    await findByRole("button", { name: /try again/i });
    expect(container.textContent).toContain("Couldn't load this site");
    expect(container.textContent).toContain("northwind.example");
    expect(container.textContent).toContain("HTTP 500");
    expect(container.textContent).not.toContain("Loading…");
  });

  it("retries the read when the operator asks", async () => {
    const fetchMock = stubFetch(500, { error: "asset_detail_failed" });
    const { findByRole } = renderRoute("northwind.example");

    const retry = await findByRole("button", { name: /try again/i });
    const attempts = fetchMock.mock.calls.length; // the hook's own retry already ran
    fireEvent.click(retry);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(attempts));
  });

  it("keeps the distinct 'no such asset' state for a 404", async () => {
    stubFetch(404, { error: "asset_not_found" });
    const { container, findByText } = renderRoute("does.not.exist");

    await findByText("No such site");
    expect(container.textContent).not.toContain("Couldn't load this site");
  });

  it("shows Loading… while the read is still in flight", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const { container } = renderRoute("northwind.example");
    expect(container.textContent).toContain("Loading…");
  });
});

/** The asset payload, the task-hub snapshot and the lane's own capability
 * answer, routed by URL — the Tasks tab reads all three. */
function stubFetchWithWork(detail: unknown, work: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const body = url.startsWith("/api/work")
      ? work
      : url.startsWith("/api/tasks/capabilities")
        ? { live: false, reason: "This build has no task lane." }
        : detail;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function workItem(over: Record<string, unknown> = {}) {
  return {
    id: "md-1w2",
    title: "Fix the recipe schema",
    status: "open",
    priority: 2,
    issueType: "task",
    assignee: null,
    updatedAt: "2026-07-05T11:55:00.000Z",
    closedAt: null,
    parent: null,
    deferUntil: null,
    ...over,
  };
}

function workProject(over: Record<string, unknown> = {}) {
  return {
    asset: "meadow.example",
    prefix: "md",
    name: "Meadow Board",
    ok: true,
    error: null,
    counts: {
      open: 3,
      highPriority: 1,
      ready: 1,
      inProgress: 0,
      blocked: 0,
      closedRecent: 0,
      deferred: 0,
      waiting: 2,
    },
    history: { waiting: [], urgent: [], open: [], inProgress: [], blocked: [], closed: [] },
    priorities: [0, 1, 2, 0, 0],
    epics: null,
    deferred: [],
    waiting: [],
    ready: [workItem()],
    inProgress: [],
    recentlyClosed: [],
    ...over,
  };
}

function workPayload(projects: unknown[]) {
  return {
    generatedAt: "2026-07-05T12:00:00.000Z",
    capturedAt: "2026-07-05T11:59:00.000Z",
    pollCadenceHours: 1 / 60,
    owner: "config/beads.json",
    projects,
    historyDays: 0,
  };
}

describe("AssetDetailRoute — Tasks tab", () => {
  it("renders this asset's board with the project pinned and its control gone", async () => {
    stubFetchWithWork(
      payload(),
      workPayload([
        workProject(),
        workProject({
          asset: "northwind.example",
          prefix: "nw",
          name: "Northwind",
          ready: [workItem({ id: "nw-77a", title: "Somebody else's queue" })],
        }),
      ]),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "tasks");

    await findByText("Fix the recipe schema");
    expect(container.textContent).not.toContain("Somebody else's queue");
    expect(container.querySelector("#tasks-project")).toBeNull();
    expect(
      container.querySelector('[data-tasks-board="meadow.example"]'),
    ).not.toBeNull();
    expect(
      [...container.querySelectorAll("th")].map((node) => node.textContent),
    ).not.toContain("Project");
    expect(container.querySelector('tr[data-task-row="md-1w2"]')!.textContent).toContain(
      "md-1w2",
    );
  });

  it("files a new task into this project, with the index's own ?new=1", async () => {
    stubFetchWithWork(payload(), workPayload([workProject()]));
    const { container, findByText } = renderRoute("meadow.example", "", "tasks");

    await findByText("Fix the recipe schema");
    const button = container.querySelector("[data-new-task]")!;
    expect(button.getAttribute("data-new-task-project")).toBe("meadow.example");
  });

  it("carries the open count and the inbox glyph on the tab itself", async () => {
    stubFetchWithWork(payload(), workPayload([workProject()]));
    const { container, findByText } = renderRoute("meadow.example");

    await findByText("What matters");
    await waitFor(() => {
      const tab = [...container.querySelectorAll('[role="tab"]')].find((t) =>
        t.textContent?.startsWith("Tasks"),
      )!;
      expect(tab.textContent).toBe("Tasks3");
      expect(tab.getAttribute("title")).toBe("3 open tasks — 2 waiting on you");
      expect(tab.querySelector("svg")).not.toBeNull();
    });
  });

  it("says how to wire a project rather than showing an empty queue", async () => {
    stubFetchWithWork(payload(), workPayload([]));
    const { container, findByText } = renderRoute("meadow.example", "", "tasks");

    await findByText("No task project for this site");
    expect(container.querySelector("[data-tasks-unwired]")).not.toBeNull();
    const door = [...container.querySelectorAll("a")].find((a) => a.textContent?.startsWith("Add a task project"))!;
    expect(door.getAttribute("href")).toBe("/settings#task-hub");
    expect(container.textContent).not.toContain("config/beads.json");
    expect(container.querySelector("[data-tasks-filters]")).toBeNull();
    const tab = [...container.querySelectorAll('[role="tab"]')].find((t) =>
      t.textContent?.startsWith("Tasks"),
    )!;
    expect(tab.textContent).toBe("Tasks");
  });
});

describe("AssetDetailRoute — Settings manages the tracked panel", () => {
  /** The detail read plus `GET /api/config` and `PUT /api/config`. The blanket
   * stub answers the payload to every URL, which makes the writability
   * question say no. */
  function stubPanelLanes(detail: AssetDetailPayload, writable = true) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url === "/api/config" && method === "GET") {
        return json({
          writable,
          reason: writable ? null : "Config is files; this build has none.",
        });
      }
      if (url === "/api/config" && method === "PUT") return json({ applied: 1, archive: null, commit: null });
      return json(detail);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /** The one changeset a save was sent as. */
  function sentOps(fetchMock: ReturnType<typeof stubPanelLanes>) {
    const call = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === "/api/config" &&
        (init as RequestInit | undefined)?.method === "PUT",
    );
    return call
      ? (
          JSON.parse(String((call[1] as RequestInit).body)) as {
            ops: Record<string, unknown>[];
          }
        ).ops
      : undefined;
  }

  /** Two tracked terms, one bare and one carrying its bet — both shapes the
   * file allows, in the mix it allows them in. */
  const PANEL = ["anvil specs", { query: "rocket skates specs", label: "Item head" }];
  const ROSTER = {
    enabled: true,
    reason: "live-lanes",
    note: "GSC + GA4 live.",
    since: "2026-08-03",
  };

  /** The portfolio cap the spend statement names: a knob the page already
   * carries. */
  const CAPPED = {
    owner: "config/constants.json" as const,
    note: "portfolio-wide",
    knobs: [
      {
        key: "monthly_caps.data_usd",
        pointer: "/monthly_caps/data_usd",
        label: "Monthly data cap",
        jargon: "monthly_caps.data_usd",
        value: 25,
        unit: "usd" as const,
      },
    ],
  };

  it("asks for a search source first when the site has none and tracks nothing", async () => {
    const data = payload({ panelConfig: { trackedQueries: null, roster: null } });
    data.integrations = { ...data.integrations, lanes: [] };
    stubFetch(200, data);
    const { container, findByText } = renderRoute("meadow.example", "", "settings");

    await findByText("Tracked search terms");
    const settings = container.querySelector<HTMLElement>("#tracked-panels")!;
    expect(settings.querySelector("[data-tracked-terms-needs-search]")).toHaveAttribute("href", "/assets/meadow.example/sources");
    expect(settings.querySelector("[data-panel-spend]")).toBeNull();
    expect(settings.textContent).not.toContain("Panel refresh");
  });

  it("states what the panel costs and how big it may get, beside the control that changes it", async () => {
    stubPanelLanes(
      payload({ panelConfig: { trackedQueries: PANEL, roster: ROSTER }, portfolio: CAPPED }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "settings");

    await findByText("Tracked search terms");
    // 2 terms x 2 devices x $0.004 = $0.02.
    const settings = container.querySelector<HTMLElement>("#tracked-panels")!;
    expect(settings.textContent).toContain("2 of 31 terms");
    expect(settings.textContent).toContain("$0.02 a week");
    const queries = settings.querySelector<HTMLDetailsElement>("details")!;
    expect(queries.open).toBe(false);
    expect(queries.querySelector("summary")!.textContent).toContain("Tracked queries");
    const spend = container.querySelector("[data-panel-spend]")!;
    expect(spend.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("2");
    const bill = spend.querySelector("[data-panel-bill]")!;
    expect(bill.textContent).toContain("Weekly · Mondays");
    expect(bill.textContent).toContain("2 devices");
    expect(bill.querySelector('a[href="/settings#budget"]')!.textContent).toContain(
      "Data cap $25 / month",
    );
    expect(container.textContent).not.toContain("$0.008");
  });

  it("adds a tracked term as one append inside this asset's own panel", async () => {
    const fetchMock = stubPanelLanes(
      payload({ panelConfig: { trackedQueries: PANEL, roster: ROSTER } }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "settings");

    await findByText("Tracked search terms");
    const editor = container.querySelector(
      '[data-collection-editor="serp-panel-queries"]',
    ) as HTMLElement;
    fireEvent.click(within(editor).getByRole("button", { name: "Add" }));
    const form = editor.querySelector("[data-collection-add]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("Query"), {
      target: { value: "magnet specs" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(sentOps(fetchMock)).toEqual([
        {
          kind: "file-json-insert",
          file: "config/serp-panel.json",
          pointer: "/assets/meadow.example/queries/-",
          value: "magnet specs",
        },
      ]),
    );
  });

  // Grouping is an exact string match on the stored label, so a case variant
  // would make two bets out of one and the collector would refuse the panel.
  it("refuses a relabel that would spell one cluster two ways", async () => {
    const fetchMock = stubPanelLanes(
      payload({
        panelConfig: {
          trackedQueries: [
            { query: "rocket skates specs", label: "Item head" },
            { query: "magnet specs", label: "Item head" },
          ],
          roster: ROSTER,
        },
      }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "settings");

    await findByText("Tracked search terms");
    const editor = container.querySelector(
      '[data-collection-editor="serp-panel-queries"]',
    ) as HTMLElement;
    const row = editor.querySelector(
      '[data-collection-row="magnet specs"]',
    ) as HTMLElement;
    const control = within(row).getByLabelText("Bet");
    fireEvent.change(control, { target: { value: "Item Head" } });
    fireEvent.click(
      within(control.parentElement as HTMLElement).getByRole("button", { name: "Save" }),
    );

    expect(row.textContent).toContain(
      'spells one cluster two ways: "Item head" and "Item Head"',
    );
    expect(sentOps(fetchMock)).toBeUndefined();
  });

  it("offers the bets this panel already names as a picker, and still takes a new one", async () => {
    const fetchMock = stubPanelLanes(
      payload({
        panelConfig: {
          trackedQueries: [
            { query: "rocket skates specs", label: "Item head" },
            { query: "anvil specs", label: "Item head" },
            "magnet specs",
          ],
          roster: ROSTER,
        },
      }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "settings");

    await findByText("Tracked search terms");
    const editor = container.querySelector(
      '[data-collection-editor="serp-panel-queries"]',
    ) as HTMLElement;
    const row = editor.querySelector(
      '[data-collection-row="magnet specs"]',
    ) as HTMLElement;
    const control = within(row).getByLabelText("Bet");
    const list = row.querySelector("datalist") as HTMLDataListElement;
    expect([...list.querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual([
      "Item head",
    ]);
    expect(control).toHaveAttribute("list", list.id);

    fireEvent.change(control, { target: { value: "Chain calories" } });
    fireEvent.click(
      within(control.parentElement as HTMLElement).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => expect(sentOps(fetchMock)).not.toBeUndefined());
    expect(sentOps(fetchMock)).toMatchObject([
      { value: { query: "magnet specs", label: "Chain calories" } },
    ]);
  });

  it("lets a term join an existing cluster, spelled exactly", async () => {
    const fetchMock = stubPanelLanes(
      payload({
        panelConfig: {
          trackedQueries: [
            { query: "rocket skates specs", label: "Item head" },
            "magnet specs",
          ],
          roster: ROSTER,
        },
      }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "settings");

    await findByText("Tracked search terms");
    const row = container.querySelector(
      '[data-collection-row="magnet specs"]',
    ) as HTMLElement;
    const control = within(row).getByLabelText("Bet");
    fireEvent.change(control, { target: { value: "Item head" } });
    fireEvent.click(
      within(control.parentElement as HTMLElement).getByRole("button", { name: "Save" }),
    );

    await waitFor(() =>
      expect(sentOps(fetchMock)).toEqual([
        {
          kind: "file-json-set",
          file: "config/serp-panel.json",
          pointer: "/assets/meadow.example/queries/1",
          expect: "magnet specs",
          value: { query: "magnet specs", label: "Item head" },
        },
      ]),
    );
  });

  it("starts a panel for an asset the add-asset wizard deliberately gave none", async () => {
    const fetchMock = stubPanelLanes(payload({ panelConfig: { trackedQueries: null, roster: ROSTER } }));
    const { container, findByText } = renderRoute("meadow.example", "", "settings");

    await findByText("Tracked search terms");
    const editor = container.querySelector(
      '[data-collection-editor="serp-panel-queries"]',
    ) as HTMLElement;
    expect(within(editor).getByText("None yet")).toBeInTheDocument();
    expect(editor.textContent).not.toContain("Add a term to start weekly tracking");
    fireEvent.click(within(editor).getByRole("button", { name: "Add" }));
    const form = editor.querySelector("[data-collection-add]") as HTMLElement;
    fireEvent.change(within(form).getByLabelText("Query"), {
      target: { value: "anvil specs" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(sentOps(fetchMock)).toEqual([
        {
          kind: "file-json-insert",
          file: "config/serp-panel.json",
          pointer: "/assets/meadow.example",
          value: { queries: ["anvil specs"] },
        },
      ]),
    );
  });

  it("changes the refresh roster in place, and never offers to remove the row", async () => {
    const fetchMock = stubPanelLanes(
      payload({ panelConfig: { trackedQueries: PANEL, roster: ROSTER } }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "settings");

    await findByText("Tracked search terms");
    const editor = container.querySelector(
      '[data-collection-editor="signal-panels"]',
    ) as HTMLElement;
    expect(
      within(editor).queryByRole("button", { name: "Remove meadow.example…" }),
    ).not.toBeInTheDocument();

    const control = within(editor).getByLabelText("Daily refresh");
    expect(within(editor).queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.change(control, { target: { value: "false" } });

    await waitFor(() =>
      expect(sentOps(fetchMock)).toEqual([
        {
          kind: "file-json-set",
          file: "config/signal-panels.json",
          pointer: "/assets/meadow.example/enabled",
          expect: true,
          value: false,
        },
      ]),
    );
  });

  /** The asset's lanes as `config/integrations.json` holds them; `declared` is
   * the file's own `status`, which the roster rule reads. */
  function searchLanes(statuses: Record<string, string>) {
    return Object.entries(statuses).map(([id, declared]) => ({
      catalog: {
        id,
        label: id,
        docRef: "docs/11-integrations.md#the-catalog",
        scope: "property" as const,
        layer: "provider" as const,
        usage: { cost: "free" as const },
        onFailure: "keeps-last-data" as const,
        credential: "shared" as const,
        derived: false,
      },
      cell: {
        assetId: "meadow.example",
        laneId: id,
        declared: declared as "live" | "needs-setup" | "skipped",
        effective: declared as "live" | "needs-setup" | "skipped",
        evidence: [],
        note: "",
        ref: null,
        since: "2026-07-06",
      },
      mapping: [],
        mappingSource: "fallback" as const,
    }));
  }

  function withLanes(statuses: Record<string, string>, roster: unknown) {
    const base = payload({
      panelConfig: {
        trackedQueries: PANEL,
        roster: roster as AssetDetailPayload["panelConfig"]["roster"],
      },
    });
    return {
      ...base,
      integrations: { ...base.integrations, lanes: searchLanes(statuses) },
    };
  }

  /** Pick the roster's `enabled` cell; a pick is the save. */
  function saveRoster(container: HTMLElement, value: "true" | "false") {
    const editor = container.querySelector(
      '[data-collection-editor="signal-panels"]',
    ) as HTMLElement;
    const control = within(editor).getByLabelText("Daily refresh");
    fireEvent.change(control, { target: { value } });
    return { editor, control };
  }

  // A refresh over an asset with no live lane writes an empty panel dir,
  // indistinguishable on disk from a collapsed one.
  it("refuses to switch the roster on for an asset with no live search lane", async () => {
    const fetchMock = stubPanelLanes(
      withLanes(
        { gsc: "needs-setup", ga4: "needs-setup", "bing-webmaster": "skipped" },
        { ...ROSTER, enabled: false, reason: "no-lane-yet", note: "GSC not wired." },
      ),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "settings");

    await findByText("Tracked search terms");
    const { editor } = saveRoster(container, "true");

    expect(editor.textContent).toContain(
      "enabled but no live search source in integrations.json",
    );
    expect(editor.textContent).toContain("gsc, ga4, bing-webmaster");
    expect(sentOps(fetchMock)).toBeUndefined();
  });

  it("switches the roster on once one of those lanes is live", async () => {
    const fetchMock = stubPanelLanes(
      withLanes(
        { gsc: "needs-setup", ga4: "live", "bing-webmaster": "skipped" },
        { ...ROSTER, enabled: false, reason: "no-lane-yet", note: "Waiting on GSC." },
      ),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "settings");

    await findByText("Tracked search terms");
    saveRoster(container, "true");

    await waitFor(() =>
      expect(sentOps(fetchMock)).toEqual([
        {
          kind: "file-json-set",
          file: "config/signal-panels.json",
          pointer: "/assets/meadow.example/enabled",
          expect: false,
          value: true,
        },
      ]),
    );
  });

  it("always lets the roster be switched OFF, which is the decision the file is for", async () => {
    const fetchMock = stubPanelLanes(
      withLanes({ gsc: "needs-setup", ga4: "needs-setup" }, ROSTER),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "settings");

    await findByText("Tracked search terms");
    saveRoster(container, "false");

    await waitFor(() =>
      expect(sentOps(fetchMock)).toEqual([
        {
          kind: "file-json-set",
          file: "config/signal-panels.json",
          pointer: "/assets/meadow.example/enabled",
          expect: true,
          value: false,
        },
      ]),
    );
  });

  it("a deployment with no filesystem shows the panel and says why it cannot be changed", async () => {
    stubPanelLanes(payload({ panelConfig: { trackedQueries: PANEL, roster: ROSTER } }), false);
    const { container, findByText } = renderRoute("meadow.example", "", "settings");

    await findByText("Tracked search terms");
    await waitFor(() =>
      expect(container.textContent).toContain("Config is files; this build has none."),
    );
    const editor = container.querySelector(
      '[data-collection-editor="serp-panel-queries"]',
    ) as HTMLElement;
    expect(within(editor).queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
    expect(editor.textContent).toContain("anvil specs");
  });
});

/** Both tabs render `metricWindow`, so rendered against the same payload they
 * must print the same figure. */
describe("AssetDetailRoute — the Overview and Growth agree about a number", () => {
  /** Two providers, deliberately different sizes and different provisional
   * tails, so a tab reading only one of them lands on a visibly wrong figure. */
  function twoProviders(): AssetDetailPayload {
    const data = payload();
    const daily = (values: number[], provisionalFrom: string | null) => ({
      series: values.map((v, index) => ({
        t: new Date(Date.UTC(2026, 5, 8 + index)).toISOString().slice(0, 10),
        v,
      })),
      provisionalFrom,
      collectedAt: "2026-07-05T11:45:00.000Z",
      timeZoneChanges: [],
    });
    data.performance = {
      ...data.performance,
      webSearchClicks: {
        google: daily([100, 110, 120, 130, 140, 150, 160], null),
        bing: daily([10, 11, 12, 13, 14, 15, 16], null),
      },
      webSearchImpressions: {
        google: daily([1000, 1100, 1200, 1300, 1400, 1500, 1600], null),
        bing: daily([100, 110, 120, 130, 140, 150, 160], null),
      },
    };
    return data;
  }

  /** What a tab prints for one measure, whitespace-normalised. */
  function figure(container: HTMLElement, selector: string): string {
    const node = container.querySelector(selector);
    return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  it("prints the same search clicks on the strip and on the chart pair", async () => {
    // Google 910 + Bing 91 = 1,001 over the seven days both providers reported.
    stubFetch(200, twoProviders());
    const overview = renderPath("/assets/meadow.example?range=7");
    await overview.findByText("What matters");
    expect(figure(overview.container, '[data-kpi="Search clicks"]')).toContain(
      "1,001",
    );
    overview.unmount();

    const growth = renderPath("/assets/meadow.example/growth?range=7");
    await growth.findByText("Audience");
    expect(figure(growth.container, '[data-growth-chart="Clicks"]')).toContain(
      "1,001",
    );
    expect(figure(growth.container, '[data-growth-chart="Clicks"]')).not.toContain(
      "910",
    );
  });

  it("prints the same impressions, in the same compact form, on both", async () => {
    stubFetch(200, twoProviders());
    const overview = renderPath("/assets/meadow.example?range=7");
    await overview.findByText("What matters");
    const strip = figure(overview.container, '[data-kpi="Impressions"]');
    overview.unmount();

    const growth = renderPath("/assets/meadow.example/growth?range=7");
    await growth.findByText("Audience");
    const pair = figure(growth.container, '[data-growth-chart="Impressions"]');

    // 9,100 + 910 = 10,010 -> "10K" on both; the format is part of the claim.
    expect(strip).toContain("10K");
    expect(pair).toContain("10K");
  });

  it("states a metric with fewer than three complete days as a dash on both", async () => {
    const data = twoProviders();
    const two = (values: number[]) => ({
      series: values.map((v, index) => ({
        t: new Date(Date.UTC(2026, 5, 8 + index)).toISOString().slice(0, 10),
        v,
      })),
      provisionalFrom: null,
      collectedAt: "2026-07-05T11:45:00.000Z",
      timeZoneChanges: [],
    });
    data.performance = {
      ...data.performance,
      webSearchClicks: { google: two([100, 110]), bing: two([]) },
    };
    stubFetch(200, data);

    const overview = renderPath("/assets/meadow.example?range=7");
    await overview.findByText("What matters");
    expect(figure(overview.container, '[data-kpi="Search clicks"]')).toContain("—");
    overview.unmount();

    const growth = renderPath("/assets/meadow.example/growth?range=7");
    await growth.findByText("Audience");
    expect(figure(growth.container, '[data-growth-chart="Clicks"]')).toContain("—");
  });
});

describe("AssetDetailRoute — the Search tab's search context", () => {
  const INTELLIGENCE: SearchIntelligenceSnapshot = {
    observedAt: "2026-07-27",
    costUsd: 0.42,
    rankings: {
      keywords: 184,
      top3: 6,
      top10: 21,
      top20: 44,
      estimatedVisits: 1320,
      estimatedPaidTrafficCost: 2410,
      aiOverviewReferences: 9,
    },
    backlinks: {
      rank: 212,
      backlinks: 3480,
      referringDomains: 128,
      newReferringDomains: 11,
      lostReferringDomains: 4,
    },
    ai: {
      googleMentions: 5,
      googleSearchVolume: 27000,
      chatgptMentions: 3,
      chatgptSearchVolume: 8100,
    },
    referringDomains: [],
    anchors: null,
    keywordIdeas: [],
    competitors: [],
  };

  function withIntelligence(
    overrides: Partial<typeof INTELLIGENCE> = {},
  ): AssetDetailPayload {
    const data = payload();
    data.executive = {
      ...data.executive!,
      searchIntelligence: { ...INTELLIGENCE, ...overrides },
    };
    return data;
  }

  /** The cells of one strip, in the order the DOM draws them. */
  function cells(container: HTMLElement, strip: number): string[] {
    // The strips themselves, not the cells: a `SmallMultiple` is also a grid.
    // Strip 0 stays visible; the rest are in the "More context" disclosure.
    const strips = [
      ...container.querySelectorAll(
        "#search-context > .grid, #search-context [data-context-more] > .grid",
      ),
    ] as HTMLElement[];
    return [...strips[strip]!.children].map(
      (cell) => cell.textContent?.trim() ?? "",
    );
  }

  it("leads the search context with the dollar value, above every count", async () => {
    stubFetch(200, withIntelligence());
    const { container, findByText } = renderRoute("meadow.example", "", "search");

    await findByText("Search context");
    const rankings = cells(container, 0);
    expect(rankings[0]).toContain("Traffic value");
    expect(rankings[0]).toContain("$2,410");
    expect(rankings[0]).toContain("1,320 visits a month, priced as ads");
    expect(rankings.slice(1).join(" ")).toContain("Keywords");
    expect(rankings.slice(1).join(" ")).toContain("184");
    const label = container.querySelector("#search-context h2")!.parentElement!;
    expect(label.textContent).toContain("Modelled · Jul 27, 2026");
    expect(label.querySelector("[data-info-tooltip-trigger]")).toBeNull();
  });

  it("gives the top-20 count and the link movement cells of their own", async () => {
    stubFetch(200, withIntelligence());
    const { container, findByText } = renderRoute("meadow.example", "", "search");

    await findByText("Search context");
    const rankings = cells(container, 0);
    const links = cells(container, 1);
    expect(rankings.some((cell) => cell.startsWith("Top 20") && cell.includes("44"))).toBe(
      true,
    );
    expect(links.some((cell) => cell.startsWith("Gained") && cell.includes("11"))).toBe(
      true,
    );
    expect(links.some((cell) => cell.startsWith("Lost") && cell.includes("4"))).toBe(
      true,
    );
    for (const value of ["6", "21", "9", "3,480", "212", "27,000", "8,100"]) {
      expect(container.querySelector("#search-context")!.textContent).toContain(value);
    }
    expect(container.textContent).not.toContain("net referring");
  });

  it("says the link report is unavailable rather than printing zeros", async () => {
    stubFetch(200, withIntelligence({ backlinks: null }));
    const { container, findByText } = renderRoute("meadow.example", "", "search");

    await findByText("Search context");
    const links = cells(container, 1);
    expect(links[0]).toContain("Linking domains");
    expect(links[0]).toContain("—");
    expect(links[0]).toContain("no link report");
    for (const label of ["Gained", "Lost", "Links", "Domain rank"]) {
      const cell = links.find((entry) => entry.startsWith(label))!;
      expect(cell).toContain("—");
      expect(cell).not.toMatch(/\b0\b/);
    }
  });

  it("says an AI mention figure was not reported rather than printing zero", async () => {
    stubFetch(
      200,
      withIntelligence({
        ai: {
          googleMentions: null,
          googleSearchVolume: null,
          chatgptMentions: 3,
          chatgptSearchVolume: 8100,
        },
      }),
    );
    const { container, findByText } = renderRoute("meadow.example", "", "search");

    await findByText("Search context");
    const all = [
      ...container.querySelectorAll(
        "#search-context > .grid > *, #search-context [data-context-more] > .grid > *",
      ),
    ].map((cell) => cell.textContent?.trim() ?? "");
    const cell = (label: string) => all.find((entry) => entry.startsWith(label))!;
    expect(cell("AI mentions")).toContain("—");
    expect(cell("AI mentions")).toContain("Google not reported");
    expect(cell("AI mentions")).toContain("3 ChatGPT");
    expect(cell("Google demand")).toContain("—");
    expect(cell("Google demand")).toContain("not reported");
    expect(cell("Google demand")).not.toMatch(/\b0\b/);
    expect(cell("ChatGPT demand")).toContain("8,100");
  });
});

describe("the Settings tab — the owning entity", () => {
  const ENTITIES = [
    { slug: "example-ventures", name: "Example Ventures LLC", form: "LLC", assets: ["meadow.example"] },
    { slug: "second-co", name: "Second Co" },
  ];

  /** The asset payload, plus the settings payload the picker reads its choices
   * from — two different reads, so the stub answers by URL. */
  function stubWithEntities(rows: unknown[] = ENTITIES) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url === "/api/config" && method === "PUT") return json({ applied: 1, archive: null, commit: null });
      if (url === "/api/config") return json({ writable: true, reason: null, sources: {} });
      if (url.startsWith("/api/settings")) {
        return json(settingsResponse({ entities: { owner: "config/entities.json", rows } }));
      }
      return json(payload());
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /** The one changeset the picker's Save sent. */
  function sentEntityOps(fetchMock: ReturnType<typeof stubWithEntities>) {
    const call = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === "/api/config" &&
        (init as RequestInit | undefined)?.method === "PUT",
    );
    return call
      ? (JSON.parse(String((call[1] as RequestInit).body)) as { ops: unknown[] }).ops
      : undefined;
  }

  it("shows the entity that owns this asset, chosen from the ones declared", async () => {
    stubWithEntities();
    renderRoute("meadow.example", "", "settings");

    const picker = (await screen.findByLabelText("Owning entity")) as HTMLSelectElement;
    expect(picker.value).toBe("example-ventures");
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      "Nobody has said",
      "Example Ventures LLC · LLC",
      "Second Co",
    ]);
  });

  it("moves the asset in one changeset: off the old list, onto the new one", async () => {
    const fetchMock = stubWithEntities();
    renderRoute("meadow.example", "", "settings");

    const picker = await screen.findByLabelText("Owning entity");
    fireEvent.change(picker, { target: { value: "second-co" } });
    const save = within(picker.closest("[data-knob-editor]") as HTMLElement).getByRole("button", {
      name: "Save",
    });
    fireEvent.click(save);

    await waitFor(() =>
      expect(sentEntityOps(fetchMock)).toEqual([
        {
          kind: "file-json-set",
          file: "config/entities.json",
          pointer: "/entities/0/assets",
          expect: ["meadow.example"],
          value: [],
        },
        {
          kind: "file-json-set",
          file: "config/entities.json",
          pointer: "/entities/1/assets",
          expectAbsent: true,
          value: ["meadow.example"],
        },
      ]),
    );
  });

  it("offers no picker before any entity is declared; its value is the link that declares one", async () => {
    stubWithEntities([]);
    const { container } = renderRoute("meadow.example", "", "settings");

    await screen.findByText("Identity");
    const declare = await screen.findByRole("link", { name: "Add an owner" });
    expect(screen.queryByLabelText("Owning entity")).toBeNull();
    expect(declare.getAttribute("href")).toBe("/settings#entities");
    expect(container.textContent).not.toMatch(/Declare one under|then pick it here/);
  });
});

describe("Growth headline and chart date scopes", () => {
  const day = (offset: number) => new Date(Date.UTC(2026, 8, 5 + offset)).toISOString().slice(0, 10);
  const dates = (range: number) => ({
    7: ["Aug 29–Sep 4, 2026", "Aug 30–Sep 5, 2026"],
    28: ["Aug 8–Sep 4, 2026", "Aug 9–Sep 5, 2026"],
    90: ["Jun 7–Sep 4, 2026", "Jun 8–Sep 5, 2026"],
  })[range]!;

  function delayedProviders() {
    const data = payload();
    const series = Array.from({ length: 190 }, (_, index) => ({ t: day(index - 189), v: 10 }))
      .filter((point) => point.t !== day(-3)); // Sep 2 is absent from both providers.
    data.performance.webSearchClicks = {
      google: {
        series: series.map((point) => point.t === day(0) ? { ...point, v: 999 } : point),
        provisionalFrom: day(0), collectedAt: "2026-09-05T12:00:00Z", timeZoneChanges: [],
      },
      bing: {
        series: series.filter((point) => point.t <= day(-2)).map((point) => ({ ...point, v: 2 })),
        provisionalFrom: null, collectedAt: "2026-09-03T12:00:00Z", timeZoneChanges: [],
      },
    };
    return data;
  }

  it.each([7, 28, 90])("distinguishes completed totals and raw chart context over %i days with gaps and delayed providers", async (range) => {
    stubFetch(200, delayedProviders());
    const view = renderPath(`/assets/meadow.example/growth?range=${range}`);
    await view.findByText("Audience");
    const chart = view.container.querySelector<HTMLElement>('[data-growth-chart="Clicks"]')!;
    const scope = chart.querySelector<HTMLElement>("[data-growth-headline-period]")!;
    const total = (12 * range - 14).toLocaleString("en-US");
    expect(chart).toHaveTextContent(`${total} from search`);
    expect(scope).toHaveTextContent(`${dates(range)[0]}`);
    expect(scope).toHaveTextContent(`${range - 1} of ${range} days reported`);
    expect(scope).toHaveAttribute("data-window-start", day(-range));
    expect(scope).toHaveAttribute("data-window-end", day(-1));
    expect(within(chart).getByText(`Chart · ${dates(range)[1]}`)).toBeVisible();

    const help = within(chart).getByRole("button", { name: /^About Chart/ });
    expect(chart.querySelectorAll("[data-info-tooltip-trigger]")).toHaveLength(1);
    fireEvent.focus(help);
    expect(screen.getByRole("tooltip")).toHaveTextContent(`Google · ${range - 1} of ${range} days`);
    expect(screen.getByRole("tooltip")).toHaveTextContent(`Bing · ${range - 2} of ${range} days`);
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("Newer chart reports are context only");
    fireEvent.keyDown(help, { key: "Escape" });
    fireEvent.click(help);
    expect(screen.getByRole("tooltip").querySelector("[data-provider-coverage]")).not.toBeNull();
    fireEvent.keyDown(help, { key: "Escape" });

    fireEvent.click(within(chart).getByText(`View data · ${range} days`));
    const table = await within(chart).findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(range);
    expect(rows[0]!.querySelector("time")).toHaveAttribute("datetime", day(1 - range));
    expect(rows.at(-1)!.querySelector("time")).toHaveAttribute("datetime", day(0));
    expect(within(rows.at(-1)!).getAllByRole("cell")[0]).toHaveTextContent(/^999 · Provisional$/);
    expect(within(rows.at(-1)!).getAllByRole("cell")[1]).toHaveTextContent(/^Not reported$/);
    const gap = table.querySelector(`time[datetime="${day(-3)}"]`)!.closest("tr")!;
    expect(within(gap).getAllByRole("cell").slice(0, 2).map((cell) => cell.textContent)).toEqual(["Not reported", "Not reported"]);

    fireEvent.click(view.getByRole("tab", { name: "Overview" }));
    await view.findByText("What matters");
    expect(view.container.querySelector('[data-kpi="Search clicks"]')).toHaveTextContent(total);
  });

  it("updates both visible date scopes when the traffic range changes", async () => {
    stubFetch(200, delayedProviders());
    const view = renderPath("/assets/meadow.example/growth?range=28");
    await view.findByText("Audience");
    for (const range of [7, 90, 28]) {
      fireEvent.click(within(view.getByRole("group", { name: "Traffic period" })).getByRole("button", { name: `${range}d` }));
      const chart = view.container.querySelector<HTMLElement>('[data-growth-chart="Clicks"]')!;
      expect(chart.querySelector("[data-growth-headline-period]")).toHaveTextContent(dates(range)[0]!);
      expect(within(chart).getByText(`Chart · ${dates(range)[1]}`)).toBeVisible();
      expect(chart).toHaveTextContent(`${(12 * range - 14).toLocaleString("en-US")} from search`);
    }
  });

  it("does not add a second date label when the headline and chart periods match", async () => {
    const data = delayedProviders();
    data.performance.webSearchClicks.google.provisionalFrom = null;
    stubFetch(200, data);
    const view = renderPath("/assets/meadow.example/growth?range=7");
    await view.findByText("Audience");
    const chart = view.container.querySelector<HTMLElement>('[data-growth-chart="Clicks"]')!;
    expect(chart.querySelector("[data-growth-headline-period]")).toHaveTextContent("Aug 30–Sep 5, 2026");
    expect(within(chart).queryByText(/^Chart ·/)).toBeNull();
  });

  it("keeps unfinished-only observations inspectable without inventing a completed period or total", async () => {
    const data = delayedProviders();
    data.performance.webSearchClicks.google.series = [{ t: day(0), v: 999 }];
    data.performance.webSearchClicks.bing.series = [];
    stubFetch(200, data);
    const view = renderPath("/assets/meadow.example/growth?range=7");
    await view.findByText("Audience");
    const chart = view.container.querySelector<HTMLElement>('[data-growth-chart="Clicks"]')!;
    expect(within(chart).getByLabelText("Not enough completed reports")).toHaveTextContent("—");
    expect(chart.querySelector("[data-growth-headline-period]")).toHaveTextContent("No completed reports");
    expect(chart.querySelector("[data-growth-headline-period]")).not.toHaveAttribute("data-window-end");
    expect(within(chart).getByText("Chart · Aug 30–Sep 5, 2026")).toBeVisible();
    fireEvent.click(within(chart).getByText("View data · 7 days"));
    expect(await within(chart).findByRole("table")).toHaveTextContent("999 · Provisional");
  });

  it("names sparse completed coverage without bypassing the three-report floor", async () => {
    const data = delayedProviders();
    data.performance.webSearchClicks.google.series = [
      { t: day(-2), v: 10 }, { t: day(-1), v: 10 }, { t: day(0), v: 999 },
    ];
    data.performance.webSearchClicks.bing.series = [];
    stubFetch(200, data);
    const view = renderPath("/assets/meadow.example/growth?range=7");
    await view.findByText("Audience");
    const chart = view.container.querySelector<HTMLElement>('[data-growth-chart="Clicks"]')!;
    expect(within(chart).getByLabelText("Not enough completed reports")).toHaveTextContent("—");
    expect(chart.querySelector("[data-growth-headline-period]")).toHaveTextContent("Aug 29–Sep 4, 2026");
    expect(chart.querySelector("[data-growth-headline-period]")).toHaveTextContent("2 of 7 days reported");
    expect(within(chart).queryByText("20 from search")).toBeNull();
  });

  it("states absent reporting without assigning either an invented period or zero", async () => {
    const data = delayedProviders();
    data.performance.webSearchClicks.google.series = [];
    data.performance.webSearchClicks.bing.series = [];
    stubFetch(200, data);
    const view = renderPath("/assets/meadow.example/growth?range=7");
    await view.findByText("Audience");
    const chart = view.container.querySelector<HTMLElement>('[data-growth-chart="Clicks"]')!;
    expect(chart).toHaveTextContent("No completed reports");
    expect(chart).toHaveTextContent("No reports in this window yet");
    expect(within(chart).queryByText(/^Chart ·/)).toBeNull();
    expect(within(chart).queryByRole("table")).toBeNull();
  });
});

describe("Growth chart calculation-only history", () => {
  it.each([7, 28, 90])("uses earlier provider reports for the first visible average without widening %i days", async (range) => {
    const data = payload();
    const end = Date.parse("2026-07-05T00:00:00Z");
    const points = Array.from({ length: range + 6 }, (_, index) => ({
      t: new Date(end - (range + 5 - index) * 86_400_000).toISOString().slice(0, 10),
      v: index < 6 ? 10 : 80,
    }));
    const firstVisible = points[6]!.t;
    data.performance.webSearchClicks = {
      google: {
        contextSeries: points.slice(0, 3), series: points.slice(3),
        provisionalFrom: null, collectedAt: "2026-07-05T11:00:00Z", timeZoneChanges: [],
      },
      bing: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
    };
    stubFetch(200, data);
    const view = renderPath(`/assets/meadow.example/growth?range=${range}`);
    await view.findByText("Audience");
    const chart = view.container.querySelector<HTMLElement>('[data-growth-chart="Clicks"]')!;
    expect(chart).toHaveTextContent(`${(80 * range).toLocaleString("en-US")} from search`);
    fireEvent.click(within(chart).getByText(`View data · ${range} days`));
    const table = await within(chart).findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(range + 1);
    expect(rows[1]!.querySelector("time")).toHaveAttribute("datetime", firstVisible);
    expect(rows[1]).toHaveTextContent("7-day avg: 20"); // (6 × 10 + 80) / 7
    expect(table.querySelector(`time[datetime="${points[0]!.t}"]`)).toBeNull();
    expect(table.querySelector(`time[datetime="${points[5]!.t}"]`)).toBeNull();
    for (const row of rows.slice(1)) expect(row.querySelector("td")).toHaveTextContent(/^80/);
  });
});

describe("Growth provider annotations on the current chart", () => {
  const change = { effectiveOn: "2026-07-15", from: "America/Los_Angeles", to: "America/New_York" };

  async function chart(
    googleChanges: (typeof change)[],
    bingChanges: (typeof change)[],
    googleProvisionalFrom: string | null = null,
  ) {
    const data = payload();
    const series = Array.from({ length: 28 }, (_, index) => ({
      t: new Date(Date.UTC(2026, 6, index + 1)).toISOString().slice(0, 10), v: 100,
    }));
    const trend = (timeZoneChanges: (typeof change)[], provisionalFrom: string | null = null) => ({
      series, timeZoneChanges, provisionalFrom, collectedAt: "2026-07-28T12:00:00Z",
    });
    data.performance.webSearchClicks = {
      google: trend(googleChanges, googleProvisionalFrom), bing: trend(bingChanges),
    };
    data.annotations.items = [];
    stubFetch(200, data);
    const view = renderPath("/assets/meadow.example/growth?range=28");
    await view.findByText("Audience");
    return view.container.querySelector<HTMLElement>('[data-growth-chart="Clicks"]')!;
  }

  function markedDates(element: HTMLElement) {
    return [...new Set([...element.querySelectorAll("[data-chart-event-dates]")]
      .flatMap((target) => target.getAttribute("data-chart-event-dates")!.split(" ")))].sort();
  }

  it("marks the two affected days, naming only the provider that moved", async () => {
    const element = await chart([change], []);
    expect(markedDates(element)).toEqual(["2026-07-14", "2026-07-15"]);
    fireEvent.focus(element.querySelector("[data-chart-event-dates]")!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Google: reporting timezone changed");
    expect(screen.getByRole("tooltip")).toHaveTextContent("America/Los_Angeles");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("Bing");
  });

  it("keeps each provider's own affected dates when both moved separately", async () => {
    const element = await chart([change], [{ ...change, effectiveOn: "2026-07-22", from: "UTC" }]);
    expect(markedDates(element)).toEqual(["2026-07-14", "2026-07-15", "2026-07-21", "2026-07-22"]);
  });

  it("uses one mark per shared date and discloses both providers", async () => {
    const element = await chart([change], [change]);
    expect(markedDates(element)).toEqual(["2026-07-14", "2026-07-15"]);
    expect(element.querySelectorAll('svg[role="img"] line.stroke-chart-distorted')).toHaveLength(2);
    fireEvent.click(element.querySelector("[data-chart-event-dates]")!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Google: reporting timezone changed");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Bing: reporting timezone changed");
  });

  it("keeps the provider values unchanged and attributes the table caveat", async () => {
    const element = await chart([change], []);
    fireEvent.click(within(element).getByText("View data · 28 days"));
    const table = await within(element).findByRole("table");
    const row = table.querySelector('time[datetime="2026-07-15"]')!.closest("tr")!;
    const cells = within(row).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent(/^100/);
    expect(cells[1]).toHaveTextContent(/^100/);
    expect(cells[2]).toHaveTextContent("Google: reporting timezone changed");
    expect(cells[2]).not.toHaveTextContent("Bing");
  });

  it("does not invent timezone annotations when neither provider moved", async () => {
    const element = await chart([], []);
    expect(element.querySelector("[data-chart-event-dates]")).toBeNull();
  });

  it("keeps a final Bing reading complete when the same Google date is provisional", async () => {
    const element = await chart([], [], "2026-07-28");
    fireEvent.click(within(element).getByText("View data · 28 days"));
    const table = await within(element).findByRole("table");
    const row = table.querySelector('time[datetime="2026-07-28"]')!.closest("tr")!;
    const cells = within(row).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("Provisional");
    expect(cells[0]).not.toHaveTextContent("7-day avg");
    expect(cells[1]).not.toHaveTextContent("Provisional");
    expect(cells[1]).toHaveTextContent("7-day avg: 100");
  });
});

describe("the Search tab before any tracked term", () => {
  /** Twenty-eight days of Bing ending on the fixture's last reported day. */
  const bing = (value: number) => ({
    series: Array.from({ length: 28 }, (_, index) => ({
      t: new Date(Date.parse("2026-07-05T00:00:00.000Z") - (27 - index) * 86_400_000).toISOString().slice(0, 10), v: value,
    })),
    provisionalFrom: null, collectedAt: null, timeZoneChanges: [],
  });

  /** The site with no tracked panel, no decisions and no search context. */
  function untracked(search: boolean): AssetDetailPayload {
    const data = payload();
    data.performance = {
      ...noSecondarySeries(),
      activeUsers: emptyTrend(),
      webSearchClicks: { google: emptyTrend(), bing: search ? bing(20) : emptyTrend() },
      webSearchImpressions: { google: emptyTrend(), bing: search ? bing(400) : emptyTrend() },
    };
    data.executive = { ...data.executive!, searchQueries: null, searchPages: null, searchIntelligence: null, serpPanel: null };
    data.integrations = { ...data.integrations, sources: [
      { id: "gsc", label: "Google Search Console", state: "needs-setup" },
      { id: "bing-webmaster", label: "Bing Webmaster Tools", state: "needs-setup" },
      { id: "dataforseo", label: "DataForSEO search intelligence", state: "needs-setup" },
    ] };
    return data;
  }

  /** The tab panel's own buttons and links: its actions. */
  const actions = (panel: HTMLElement) =>
    [...panel.querySelectorAll<HTMLElement>("a, button")].filter((node) => !node.closest("[data-hero-chart]") && !node.closest("[role='tooltip']"));

  it("shows the site's clicks and impressions and one step to tracking terms", async () => {
    connections.credentials = new Map();
    connections.items = [];
    stubFetch(200, untracked(true));
    const { container } = renderRoute("meadow.example", "", "search");
    await waitFor(() => expect(container.querySelector('[data-search-start="numbers"]')).not.toBeNull());
    const start = container.querySelector<HTMLElement>('[data-search-start="numbers"]')!;
    expect(start.querySelector('[data-growth-chart="Clicks"]')).toHaveTextContent("560 from search");
    expect(start.querySelector('[data-growth-chart="Impressions"]')).not.toBeNull();
    const next = start.querySelector<HTMLElement>("[data-search-next]")!;
    expect(next).toHaveTextContent("Tracked terms");
    expect(within(next).getByRole("link", { name: "Connect DataForSEO" }))
      .toHaveAttribute("href", "/integrations?connect=dataforseo&asset=meadow.example");
    expect(within(next).getAllByRole("link")).toHaveLength(1);
    expect(container.textContent).not.toContain("Not rechecked");
  });

  it("is one empty state leading to Connect when the site has no search numbers", async () => {
    connections.credentials = new Map();
    connections.items = [];
    stubFetch(200, untracked(false));
    const { container } = renderRoute("meadow.example", "", "search");
    await waitFor(() => expect(container.querySelector('[data-search-start="none"]')).not.toBeNull());
    const start = container.querySelector<HTMLElement>('[data-search-start="none"]')!;
    expect(start).toHaveTextContent("No search numbers yet");
    const connect = within(start).getByRole("link", { name: "Connect Bing Webmaster Tools" });
    expect(connect).toHaveAttribute("href", "/integrations?connect=bing-webmaster&asset=meadow.example");
    expect(actions(start)).toEqual([connect]);
    expect(container.querySelector("[data-hero-chart]")).toBeNull();
  });
});
