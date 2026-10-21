import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetDetailPayload } from "@shared/asset-detail";
import { shiftLabel } from "@shared/surface";
import type { SeriesPoint } from "@shared/wall";
import { AssetDetailRoute } from "@/routes/AssetDetailRoute";
import { leadMetric } from "@/routes/asset-detail/overview-metrics";
import { everyTabPayload } from "./asset-detail-fixture";
import { loadAssetTabs } from "./lazy-code";
import { resetTaskSourceMock, taskSourceMock } from "./task-source-mock";
import { stubJsonFetch } from "./stub-fetch";

vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

/**
 * The DOM pin in `asset-detail-tabs.test.tsx` records what this tab renders;
 * these are the rules: the figures drive the chart, the range re-derives every
 * number that follows it, a problem is drawn once where it lives, the prose is
 * behind the one disclosure, and the banner is there only while the setup is
 * open.
 */
vi.hoisted(() => {
  process.env.TZ = "UTC";
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** Noon on the day after the last day the fixture's providers reported. */
const NOW = Date.parse("2026-07-06T12:00:00.000Z");

const LAST_DAY = "2026-07-05";

function days(count: number, value: (index: number) => number): SeriesPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    t: shiftLabel(LAST_DAY, index - (count - 1)),
    v: value(index),
  }));
}

/** Sixty days rising by two, so the mean over the last 28 complete days (91)
 * and over the last 7 (112) are different whole numbers. */
const ACTIVE_USERS = days(60, (index) => (index + 1) * 2);

function trend(series: SeriesPoint[], provisionalFrom: string | null = LAST_DAY) {
  return { series, provisionalFrom, collectedAt: null, timeZoneChanges: [] };
}

const emptyTrend = () => ({
  series: [],
  provisionalFrom: null,
  collectedAt: null,
  timeZoneChanges: [],
});

function payload(over: Partial<AssetDetailPayload> = {}): AssetDetailPayload {
  return {
    generatedAt: "2026-07-06T11:00:00.000Z",
    osTimeZone: "America/Los_Angeles",
    asset: {
      id: "meadow.example",
      displayName: "Meadow Board",
      domain: "meadow.example",
      status: "live",
      senseOnly: false,
      isOs: false,
      firstReportAt: "2026-05-07T02:00:00.000Z",
      reportDays: 28,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      worstOpenSeverity: "info",
      openError: 0,
      openWarn: 0,
    },
    scheduledLanes: null,
    countersConfig: null,
    panelConfig: { trackedQueries: null, roster: null },
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
        auth: "per-property bearer",
        authOwner: "workers/ingest/.dev.vars",
      },
      lastPulseReceivedAt: "2026-07-06T02:00:00.000Z",
      lastPulseDate: "2026-07-06",
      pullFailure: null,
      ingestFreshness: null,
    },
    rules: { scope: "portfolio-default", hasOverride: false, knobs: [] },
    portfolio: { owner: "config/constants.json", note: "portfolio-wide", knobs: [] },
    performance: {
      activeUsers: trend(ACTIVE_USERS),
      sessions: trend(days(60, () => 200)),
      pageViews: emptyTrend(),
      events: emptyTrend(),
      searchCtr: emptyTrend(),
      searchPosition: emptyTrend(),
      webSearchClicks: {
        google: trend(days(60, () => 10)),
        bing: trend(days(60, () => 5)),
      },
      webSearchImpressions: {
        google: trend(days(60, () => 400)),
        bing: emptyTrend(),
      },
    },
    executive: {
      schemaVersion: 1,
      asset: "meadow.example",
      generatedAt: "2026-07-06T10:00:00.000Z",
      windowStart: "2026-07-01",
      windowEnd: "2026-07-05",
      sourceArchiveCount: 12,
      items: [
        {
          key: "unattributed-sessions",
          kind: "warning",
          title: "11.3% of sessions are unattributed",
          summary: "Analytics reports them as Unassigned.",
          whyItMatters: "Past 10%, every channel split inherits that uncertainty.",
          primary: { value: "8,208", label: "sessions" },
          confidence: "high",
          windowStart: "2026-07-01",
          windowEnd: "2026-07-05",
          evidence: [{ label: "Unassigned share", value: "11.3%" }],
          sources: ["ga4/sessions"],
          caveat: "Sampling applies above 500k events.",
        },
        {
          key: "striking-distance",
          kind: "recommendation",
          title: "Move “weekly meal plan” into the top results",
          summary: "/meal-plan is visible at position 6.1.",
          whyItMatters: "The page already earns impressions below the click positions.",
          primary: { value: "1,003", label: "captured impressions" },
          confidence: "high",
          windowStart: "2026-07-01",
          windowEnd: "2026-07-05",
          evidence: [{ label: "Average position", value: "6.1" }],
          sources: ["gsc/page-query"],
          caveat: "GSC returns top rows.",
        },
      ],
      suppressedItems: [],
      searchQueries: null,
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
        last24h: 59,
        avg7d: 122,
        total: 4233,
        series: days(30, (index) => 20 + index),
      },
      {
        name: "plansSaved",
        last24h: 31,
        avg7d: 30,
        total: 1907,
        series: days(30, () => 30),
      },
    ],
    flags: { open: [], notCurrent: [], snoozed: [], history: [], openError: 0, openWarn: 0 },
    ledger: {
      periods: [
        {
          period: "2026-07",
          booked: {
            figure: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
            revenueByFamily: [],
            costByFamily: [],
          },
          forecast: {
            figure: { currency: 'USD', revenue: 441, cost: 5, net: 436 },
            revenueByFamily: [{ currency: 'USD', family: "ads", amount: 441 }],
            costByFamily: [{ currency: 'USD', family: "inference", amount: 5 }],
          },
        },
        {
          period: "2026-06",
          booked: {
            figure: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
            revenueByFamily: [],
            costByFamily: [],
          },
          forecast: {
            figure: { currency: 'USD', revenue: 300, cost: 36, net: 264 },
            revenueByFamily: [{ currency: 'USD', family: "ads", amount: 300 }],
            costByFamily: [{ currency: 'USD', family: "inference", amount: 36 }],
          },
        },
      ],
      recentRows: [],
      empty: false,
      currency: "USD",
    },
    decisions: [],
    handoffBeads: [],
    operator: {
      capturedAt: "2026-07-06T11:00:00.000Z",
      waiting: 4,
      urgent: 2,
      items: [
        workItem("md-1", "Move every recurring charge off the closing card", 0),
        workItem("md-2", "File the dissolution before Sept 10", 1),
        workItem("md-3", "Apply to the ad network when the domain turns six months old", 2),
        workItem("md-4", "Write the sitemap regression check", 3),
      ],
    },
    annotations: {
      items: [
        {
          id: 41,
          at: "2026-07-02T09:00:00.000Z",
          kind: "deploy",
          ref: null,
          note: "July title batch",
        },
      ],
      olderCount: 0,
    },
    watches: { open: [], closed: [], history: [] },
    reclamation: null,
    hygiene: null,
    fetchFailures: [],
    codebase: { history: [], latest: null },
    integrations: {
      sources: [],
      lanes: [],
      summary: {
        counts: { live: 4, degraded: 0, "needs-setup": 2, skipped: 0, "not-applicable": 0 },
        total: 6,
        needsAttention: 2,
      },
    },
    ga4Config: { valueEvents: null, eventParams: null },
    freshness: {
      pulseReceivedAt: "2026-07-06T02:00:00.000Z",
      ledgerRecordedAt: "2026-07-03T00:00:00.000Z",
      flagFiredAt: null,
      annotationAt: "2026-07-02T09:00:00.000Z",
    },
    panelReview: null,
    latestPanelDate: null,
    ...over,
  };
}

function workItem(id: string, title: string, priority: number) {
  return {
    id,
    title,
    status: "open",
    priority,
    issueType: "task",
    assignee: null,
    updatedAt: "2026-07-03T00:00:00.000Z",
    closedAt: null,
    parent: null,
    deferUntil: null,
  };
}

/** An asset still being set up: the state the banner exists for. */
function onboarding(): AssetDetailPayload {
  const base = payload();
  return {
    ...base,
    asset: { ...base.asset, status: "onboarding", firstReportAt: null },
    integrations: {
      ...base.integrations,
      sources: [
        { id: "nightly-report", label: "Nightly report", state: "live" },
        { id: "gsc", label: "Google Search Console", state: "live" },
        { id: "ga4", label: "Google Analytics 4", state: "needs-setup" },
      ],
    },
    freshness: { ...base.freshness, pulseReceivedAt: null },
  };
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="url" data-return-to={location.state?.returnTo}>{`${location.pathname}${location.search}`}</span>;
}

function renderOverview() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={["/assets/meadow.example"]}>
        <Routes>
          <Route path="/tasks/:id" element={<LocationProbe />} />
          <Route
            path="/assets/:id/:tab?"
            element={
              <>
                <AssetDetailRoute />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}


beforeAll(loadAssetTabs);

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  stubJsonFetch(payload());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetTaskSourceMock();
});

/** One figure in the hero row, by the measure it states. */
function measure(container: HTMLElement, key: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[data-overview-numbers] [data-measure="${key}"]`);
  if (!node) throw new Error(`no ${key} figure`);
  return node;
}

/** The figure itself, or its named absence. */
function figureOf(node: HTMLElement): string {
  return (node.querySelector("[data-stat-figure]") ?? node.querySelector("[data-stat-absent]"))?.textContent ?? "";
}

function chartOf(container: HTMLElement): HTMLElement {
  const chart = container.querySelector<HTMLElement>("[data-overview-chart]");
  if (!chart) throw new Error("no chart");
  return chart;
}

/** A warning the signups rule raised, on the given onset. */
function signupsAlert(firstFiredAt: string) {
  return {
    ...everyTabPayload().flags.open[0]!,
    id: 71,
    severity: "warn" as const,
    metric: "signups",
    ruleId: "flow-poisson-low",
    ruleInputs: { metric: "signups", observed: 12, baselinePerDay: 40, alpha: 0.01 },
    firedAt: firstFiredAt,
    firstFiredAt,
  };
}

/** The same site with no Analytics, Search Console or Bing series at all. */
function noTraffic(): AssetDetailPayload {
  const body = payload();
  const none = { google: emptyTrend(), bing: emptyTrend() };
  body.performance = { ...body.performance, activeUsers: emptyTrend(), sessions: emptyTrend(),
    webSearchClicks: none, webSearchImpressions: none };
  return body;
}

/** Thirty days of ad revenue estimates ending on the fixture's last day,
 * $5.00 a day. */
function revenue() {
  const revenueDays = Array.from({ length: 30 }, (_, index) => ({ date: shiftLabel(LAST_DAY, index - 29), amountMinor: 500 }));
  return { from: shiftLabel(LAST_DAY, -89), to: LAST_DAY, days: revenueDays, reportedThrough: LAST_DAY };
}

describe("Asset Overview — the site's numbers over one chart", () => {
  it("leads with money, then people, search and the product figure, each naming its window and its role", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const numbers = container.querySelector<HTMLElement>("[data-overview-numbers]")!;
    const stats = [...numbers.querySelectorAll<HTMLElement>("[data-stat]")];
    expect(stats.map((one) => one.getAttribute("data-stat"))).toEqual([
      "Net, July", "Visitors a day, 28 days", "Search clicks, 28 days", "Signups, latest report",
    ]);
    expect(stats.map((one) => one.getAttribute("data-stat-role"))).toEqual(["money", "people", "people", "context"]);
    // Every figure carries its recent days, at stat scale.
    for (const key of ["people", "search", "product"]) expect(measure(container, key).querySelector("[data-bar-strip]")).not.toBeNull();
  });

  it("states people as a daily mean and search clicks as Google and Bing added", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    // A person who visits on two days is one person: 28 complete days rising
    // by two average 91, never a sum.
    expect(figureOf(measure(container, "people"))).toBe("91");
    // Clicks are Google plus Bing on the same days: 28 × (10 + 5).
    expect(figureOf(measure(container, "search"))).toBe("420");
    expect(figureOf(measure(container, "product"))).toBe("59");
  });

  it("names the window each change is made against, and its direction", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const change = measure(container, "people").querySelector("[data-tone]")!;
    expect(change.getAttribute("data-tone")).toMatch(/^positive/);
    expect(change).toHaveAttribute("aria-label", expect.stringContaining("vs prior 28 days"));
  });

  it("re-derives every figure that follows the range, and leaves the month and the report alone", async () => {
    const { container, getByTestId } = renderOverview();
    await screen.findByRole("tablist");
    const money = figureOf(measure(container, "money"));
    // The default is the bare URL, not `?range=28`: one page, one address.
    expect(getByTestId("url").textContent).toBe("/assets/meadow.example");

    fireEvent.click(screen.getByRole("button", { name: "7d" }));

    // The figures count to their new readings.
    await waitFor(() => expect(figureOf(measure(container, "people"))).toBe("112"), { timeout: 3000 });
    await waitFor(() => expect(figureOf(measure(container, "search"))).toBe("105"), { timeout: 3000 });
    expect(measure(container, "people").querySelector("[data-stat]")).toHaveAttribute("data-stat", "Visitors a day, 7 days");
    expect(figureOf(measure(container, "money"))).toBe(money);
    expect(figureOf(measure(container, "product"))).toBe("59");
    expect(getByTestId("url").textContent).toBe("/assets/meadow.example?range=7");
  });

  it("states the accounting month's net to the cent, estimated, with what it is made of, and opens Money", async () => {
    const body = payload();
    body.ledger.periods[0]!.forecast = {
      figure: { currency: "USD", revenue: 441.37, cost: 5.18, net: 436.19 },
      revenueByFamily: [{ currency: "USD", family: "ads", amount: 441.37 }],
      costByFamily: [{ currency: "USD", family: "inference", amount: 5.18 }],
    };
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const money = measure(container, "money");
    expect(money).toHaveTextContent("+$436.19est.");
    expect(money).toHaveTextContent("ads $441.37 · costs $5.18");
    expect(money.querySelector("a")).toHaveAttribute("href", "/assets/meadow.example/financials");
    // Booked and estimated never join: one month on this side is no history.
    expect(money.querySelector("[data-bar-strip]")).toBeNull();
  });

  it("opens the chart on the first measure with days and moves it when another figure is pressed", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    expect(chartOf(container)).toHaveAttribute("data-overview-chart", "people");
    expect(measure(container, "people")).toHaveAttribute("aria-pressed", "true");
    expect(chartOf(container)).toHaveTextContent("GA4");

    fireEvent.click(measure(container, "search"));
    expect(chartOf(container)).toHaveAttribute("data-overview-chart", "search");
    expect(chartOf(container)).toHaveTextContent("Google + Bing");
    expect(measure(container, "people")).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelectorAll('[data-overview-numbers] [aria-pressed="true"]')).toHaveLength(1);

    // The operator's pick survives a range change.
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(measure(container, "search").querySelector("[data-stat]")).toHaveAttribute("data-stat", "Search clicks, 7 days"));
    expect(chartOf(container)).toHaveAttribute("data-overview-chart", "search");
  });

  it("names the best and lowest complete days at their bars, and shows the unfinished day as still counting", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const chart = chartOf(container);
    // Jul 5 is still being counted, so Jul 4 is both the newest and the best.
    expect([...chart.querySelectorAll("[data-overview-landmark]")].map((label) => label.textContent)).toEqual([
      "Best · Jul 4 · 118", "Lowest · Jun 8 · 66",
    ]);
    expect(chart.querySelector('[data-overview-day="2026-07-05"]')).toHaveAttribute("data-state", "counting");
    expect(chart.querySelector('[data-overview-day="2026-07-04"]')).toHaveAttribute("data-state", "now");
    // The yardstick: the 28 days before, a day at a time, as a dashed level.
    expect(chart.querySelector("[data-overview-usual]")).not.toBeNull();
    expect(chart).toHaveTextContent("prior 28 days · 35 a day");
  });

  it("marks every shipped change on the axis, each opening its own note", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    expect(within(chartOf(container)).getByRole("button", { name: "Event on Jul 2, 2026: July title batch" })).toBeInTheDocument();
  });

  it("steps through the days from the keyboard with the same readout the pointer shows", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    // The chart names the days it covers.
    const plot = within(chartOf(container)).getByRole("group", { name: "Visitors a day by day, Jun 8 to Jul 5" });
    fireEvent.focus(plot);
    expect(within(plot).getByRole("status")).toHaveTextContent("Jul 5120 visitors · still counting");
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    expect(within(plot).getByRole("status")).toHaveTextContent("Jul 4118 visitors");
    fireEvent.keyDown(plot, { key: "Escape" });
    expect(within(plot).queryByRole("status")).toBeNull();
  });

  it("draws a day only one search source reported as partial and a day neither did as missing, and names the hole", async () => {
    const body = payload();
    const gone = ["2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02"];
    body.performance.webSearchClicks.google = trend(days(60, () => 10).filter((point) => !gone.includes(point.t)));
    body.performance.webSearchClicks.bing = trend(days(60, () => 5).filter((point) => point.t !== "2026-07-02"));
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    fireEvent.click(measure(container, "search"));
    const chart = chartOf(container);
    expect(chart.querySelector('[data-overview-day="2026-06-30"]')).toHaveAttribute("data-state", "partial");
    expect(chart.querySelector('[data-overview-day="2026-07-02"]')).toHaveAttribute("data-state", "missed");
    expect(chart.querySelector('[data-overview-lane="gap"]')).toHaveTextContent("Google not reported · Jun 29–Jul 1 · 1 more");
    // A partial or missing day is never the lowest day.
    expect(chart).not.toHaveTextContent("Lowest · Jun 30");
  });

  it("shades a window being watched on the measure it watches, named by what changed", async () => {
    stubJsonFetch(payload({ watches: { open: [{
      id: "watch-1", metricIntegration: "ga4", metric: "active_users", scope: null, refKind: "annotation", ref: "41",
      registeredAt: "2026-07-02T12:00:00.000Z", nextCheckDate: "2026-07-10", readings: 0, checks: 3, status: "open",
      outcome: null, outcomeNote: null, closedAt: null, note: "July title batch",
    }], closed: [], history: [] } }));
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    expect(chartOf(container).querySelector('[data-overview-span="watch"]')).not.toBeNull();
    expect(chartOf(container).querySelector('[data-overview-lane="watch"]')).toHaveTextContent("Watching July title batch · verdict Jul 10");
    fireEvent.click(measure(container, "search"));
    expect(chartOf(container).querySelector('[data-overview-span="watch"]')).toBeNull();
  });
});

describe("Asset Overview — an alert drawn on the series it is about", () => {
  it("lets a fresh alert take the chart: its onset, the rule's normal and its own words, linked to Alerts", async () => {
    const body = payload();
    body.flags = { ...body.flags, open: [signupsAlert("2026-07-05T03:00:00.000Z")], openWarn: 1 };
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const product = measure(container, "product");
    expect(product.querySelector("[data-stat]")).toHaveAttribute("data-stat-role", "warning");
    expect(product).toHaveTextContent("Alert since Jul 5 · normally ~40 a day");
    const chart = chartOf(container);
    expect(chart).toHaveAttribute("data-overview-chart", "product");
    expect(chart.querySelector('[data-overview-span="alert"]')).not.toBeNull();
    expect(chart.querySelector("[data-overview-normal]")).not.toBeNull();
    expect(chart).toHaveTextContent("normally ~40 a day · range 26–55");
    const alert = within(chart.querySelector<HTMLElement>('[data-overview-lane="alert"]')!).getByRole("link");
    expect(alert).toHaveTextContent("Signups well below normal — 12 vs ~40/day");
    expect(alert).toHaveAttribute("href", "/assets/meadow.example/alerts");
    // Drawn once: the alert list does not repeat it.
    expect(container.querySelector("[data-alert-current]")).toBeNull();
  });

  it("keeps a week-old alert on its figure and leaves the chart to the first measure", async () => {
    const body = payload();
    body.flags = { ...body.flags, open: [signupsAlert("2026-06-20T03:00:00.000Z")], openWarn: 1 };
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    expect(chartOf(container)).toHaveAttribute("data-overview-chart", "people");
    expect(measure(container, "product").querySelector("[data-stat]")).toHaveAttribute("data-stat-role", "warning");
    expect(measure(container, "product")).toHaveTextContent("Alert since Jun 20");
  });

  it("lists the open alerts the page does not already draw, worst first, each linking to Alerts", async () => {
    const body = payload();
    const home = {
      ...everyTabPayload().flags.open[0]!, id: 72, severity: "error" as const, metric: "home", ruleId: "hygiene-home-unreachable",
      ruleInputs: { url: "https://meadow.example/", http_status: 503 }, firstFiredAt: "2026-07-06T09:00:00.000Z",
    };
    body.flags = { ...body.flags, open: [signupsAlert("2026-07-05T03:00:00.000Z"), home], openError: 1, openWarn: 1 };
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const list = container.querySelector<HTMLElement>("[data-alert-current]")!;
    const rows = list.querySelectorAll("[data-incident]");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-state", "error");
    expect(rows[0]).toHaveTextContent("Home page");
    expect(within(list).getByRole("link", { name: /Home page/ })).toHaveAttribute("href", "/assets/meadow.example/alerts");
    expect(within(list).getByRole("link", { name: "All alerts →" })).toHaveAttribute("href", "/assets/meadow.example/alerts");
    expect(container.querySelector("[data-verdict-line]")).toHaveTextContent("1 error · 1 warning open");
  });

  it("draws no alert box when nothing else is open", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    expect(container.querySelector("[data-alert-current]")).toBeNull();
    expect(container.querySelector("[data-verdict-line]")).toHaveTextContent("no open alerts");
  });
});

describe("Asset Overview — leads with the numbers the site has", () => {
  const clarity = { source: "clarity" as const, reportDate: LAST_DAY,
    collectedAt: "2026-07-05T11:00:00.000Z", windowHours: 72 as const, truncated: false,
    page: { url: "https://meadow.example/planner", sessions: 114, scriptErrors: 19 }, unattributedSessions: null };

  it.each([
    { title: "costs with unbooked revenue", booked: { currency: "USD", revenue: 0, cost: 20, net: -20 }, estimates: true, net: "−$20", unbooked: true },
    { title: "ordinary booked revenue", booked: { currency: "USD", revenue: 100, cost: 20, net: 80 }, estimates: true, net: "+$80", unbooked: true },
    { title: "booked costs without estimates", booked: { currency: "USD", revenue: 0, cost: 20, net: -20 }, estimates: false, net: "−$20", unbooked: false },
  ])("qualifies the booked net for $title", async ({ booked, estimates, net, unbooked }) => {
    const body = noTraffic();
    body.ledger.periods[0]!.booked.figure = booked;
    if (estimates) body.dailyRevenue = revenue();
    else delete body.dailyRevenue;
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const verdict = container.querySelector("[data-verdict-line]")!;
    expect(verdict).toHaveTextContent(`Jul booked net so far ${net}`);
    const card = measure(container, "money");
    if (estimates) {
      expect(figureOf(card)).toBe("$140");
      expect(card).toHaveTextContent(`July booked net so far ${net}`);
    } else {
      expect(figureOf(card)).toBe("−$20.00");
      expect(card).not.toHaveTextContent("est.");
    }
    expect(card.textContent?.includes("unbooked")).toBe(unbooked);
    expect(body.ledger.periods[0]!.booked.figure).toEqual(booked);
  });

  it("opens a revenue-only site on its ad revenue, on the network's own days", async () => {
    stubJsonFetch({ ...noTraffic(), dailyRevenue: revenue() });
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const money = measure(container, "money");
    // 28 days × $5.00, an estimate.
    expect(money.querySelector("[data-stat]")).toHaveAttribute("data-stat", "Ad revenue, 28 days");
    expect(money).toHaveTextContent("$140est.");
    expect(money).toHaveTextContent("July net +$436 est.");
    expect(chartOf(container)).toHaveAttribute("data-overview-chart", "money");
    expect(container.querySelector('[data-measure="people"]')).toBeNull();
    // 7 × $5.00.
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    // The figure counts to its new reading.
    await waitFor(() => expect(figureOf(measure(container, "money"))).toBe("$35.00"), { timeout: 3000 });
  });

  it("draws people a day from product analytics when that is where the site's people are", async () => {
    const body = noTraffic();
    const productDays = Array.from({ length: 28 }, (_, index) => ({ date: shiftLabel(LAST_DAY, index - 27), people: 100, pageviews: 500, sessions: 140 }));
    body.executive = { ...body.executive!, product: {
      source: "posthog", observedAt: LAST_DAY, collectedAt: null, families: [],
      webDaily: { windowStart: productDays[0]!.date, windowEnd: LAST_DAY, reportDate: LAST_DAY, days: productDays },
      funnels: [], vitals: null, exceptions: null, rageClicks: null, onceEvents: [], checks: [], caveat: "",
    } };
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    expect(measure(container, "people").querySelector("[data-stat]")).toHaveAttribute("data-stat", "People a day, 28 days");
    expect(figureOf(measure(container, "people"))).toBe("100");
    expect(chartOf(container)).toHaveTextContent("PostHog");
  });

  it("keeps a session report beside the numbers, with its named page and its fixed 72 hours", async () => {
    const body = noTraffic();
    body.executive = { ...body.executive!, clarity: { ...clarity, truncated: true } };
    stubJsonFetch(body);
    renderOverview();
    const lead = await screen.findByRole("region", { name: "Session report · 72 hours" });
    expect(within(lead).getByRole("link", { name: "meadow.example/planner" })).toHaveAttribute("href", clarity.page.url);
    expect(lead).toHaveTextContent("Limited export");
    expect(lead.querySelector("[data-hero-chart]")).toBeNull();
  });

  it("keeps a weekly ranking beside the numbers, declaring there is no series", async () => {
    const body = noTraffic();
    body.executive = { ...body.executive!, searchIntelligence: {
      observedAt: "2026-07-01", costUsd: 0.1,
      rankings: { keywords: 312, top3: 4, top10: 21, top20: 60, estimatedVisits: 880, estimatedPaidTrafficCost: 410, aiOverviewReferences: 2 },
      backlinks: null, ai: { googleMentions: null, googleSearchVolume: null, chatgptMentions: null, chatgptSearchVolume: null },
      referringDomains: [], anchors: null, keywordIdeas: [], competitors: [],
    } };
    stubJsonFetch(body);
    renderOverview();
    const lead = await screen.findByRole("region", { name: "Search position" });
    expect(lead.querySelectorAll('[data-series="unavailable"]')).toHaveLength(4);
  });

  it("names the absence and the way to the data sources when the site has no numbers at all", async () => {
    const body = noTraffic();
    body.metrics = [];
    body.ledger = { periods: [], recentRows: [], empty: true, currency: "USD" };
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const empty = container.querySelector<HTMLElement>('[data-overview-numbers="empty"]')!;
    expect(empty).toHaveTextContent("No numbers reported yet");
    expect(within(empty).getByRole("link", { name: "Data sources →" })).toHaveAttribute("href", "/assets/meadow.example/sources");
    expect(container.querySelector("[data-overview-chart]")).toBeNull();
  });
});

describe("Asset Overview — data sources over thirty days", () => {
  const source = (id: string, label: string, state: "live" | "degraded", observedAt = "2026-07-06T09:00:00.000Z") =>
    ({ id, label, state, observedAt, verification: { kind: "collection-success" as const, laneId: id } });

  it("draws each source in use a cell per day, names the longest hole, and keeps the rest on one line", async () => {
    const body = payload();
    const hole = ["2026-06-20", "2026-06-21", "2026-06-22"];
    body.performance.webSearchClicks.google = trend(days(60, () => 10).filter((point) => !hole.includes(point.t)));
    body.performance.webSearchImpressions.google = trend(days(60, () => 400).filter((point) => !hole.includes(point.t)));
    body.integrations = { ...body.integrations, sources: [source("gsc", "Google Search Console", "live"), source("dataforseo", "DataForSEO", "live")] };
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const strip = container.querySelector<HTMLElement>("[data-source-history]")!;
    expect(strip).toHaveTextContent("Data sources · last 30 days");
    expect(strip.querySelector("[data-source-history-headline]")).toHaveTextContent("Search missed 3 days · Jun 20–22");
    const search = strip.querySelector<HTMLElement>('[data-source-row="gsc"]')!;
    expect(search.querySelectorAll("[data-source-day]")).toHaveLength(30);
    expect(search.querySelector('[data-source-day="2026-06-21"]')).toHaveAttribute("data-state", "missed");
    expect(search.querySelector('[data-source-day="2026-06-23"]')).toHaveAttribute("data-state", "reported");
    expect(within(search).getByRole("img")).toHaveAccessibleName(/^Google Search Console, Jun 7 to Jul 6: reported \d+ of \d+ days; missed Jun 20–22/);
    // The strip prints the days it covers.
    expect(strip).toHaveTextContent("Jun 7");
    expect(strip).toHaveTextContent("Jul 6");
    // A weekly source has no day-by-day record here, and keeps its state on one line.
    expect(strip.querySelector('[data-source-undaily] [data-source-row="dataforseo"]')).not.toBeNull();
    expect(within(strip).getByRole("link", { name: "Data sources →" })).toHaveAttribute("href", "/assets/meadow.example/sources");
  });

  it("draws a nightly report that stopped arriving where it lives, and does not list its alert again", async () => {
    const body = payload();
    body.metrics = body.metrics.map((metric) => ({ ...metric, series: metric.series.filter((point) => point.t <= "2026-07-02") }));
    body.integrations = { ...body.integrations, sources: [source("nightly-report", "Nightly report", "degraded", "2026-07-02T02:00:00.000Z")] };
    body.flags = { ...body.flags, openWarn: 1, open: [{
      ...everyTabPayload().flags.open[0]!, id: 73, severity: "warn" as const, metric: "pulse", ruleId: "ingest-freshness",
      ruleInputs: { rule: "ingest-freshness", state: "stale", lastReceivedAt: "2026-07-02T02:00:00.000Z", ageHours: 82, thresholdHours: 48 },
      firstFiredAt: "2026-07-04T02:00:00.000Z",
    }] };
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const report = container.querySelector<HTMLElement>('[data-source-row="nightly-report"]')!;
    expect(report.querySelector('[data-source-day="2026-07-02"]')).toHaveAttribute("data-state", "reported");
    expect(report.querySelector('[data-source-day="2026-07-05"]')).toHaveAttribute("data-state", "late");
    expect(container.querySelector("[data-alert-current]")).toBeNull();
  });
});

/** The chart the one-site lead opens on, which Home still draws. */
describe("SiteLead — the chart it opens on", () => {
  it("derives the chart it opens on from the data, in the strip's own order", () => {
    const strip = (drawable: string[]) =>
      (["activeUsers", "sessions", "clicks", "impressions"] as const).map((key) => ({ key, selectable: drawable.includes(key) }));
    expect(leadMetric(strip(["activeUsers", "sessions", "clicks", "impressions"]))).toBe("activeUsers");
    expect(leadMetric(strip(["clicks", "impressions"]))).toBe("clicks");
    expect(leadMetric(strip([]))).toBeNull();
    expect(leadMetric(strip(["clicks", "impressions"]), "impressions")).toBe("impressions");
    expect(leadMetric(strip(["clicks", "impressions"]), "sessions")).toBe("clicks");
  });
});

describe("Asset Overview — explanations are disclosed, essential context stays visible", () => {
  it("keeps report freshness visible while hiding long explanatory paragraphs", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");

    const panel = container.querySelector('[role="tabpanel"]')!;
    const loose = [...panel.querySelectorAll("p")].filter(
      (paragraph) => !paragraph.closest("details:not([open])"),
    );
    expect(loose).toEqual([]);
    expect(screen.getByRole("button", { name: "About product reports" })).toHaveTextContent(/Report .*ago/);
    expect(screen.queryByText(/Report received/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "About product reports" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Report received");
  });

  it("states the product figure once: the hero row has it, the product cells have the rest", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const product = screen.getByRole("region", { name: "Product use" });
    expect(product).toHaveTextContent(/plans saved/i);
    expect(product).not.toHaveTextContent(/signups/i);
    expect(measure(container, "product")).toHaveTextContent("Signups");
  });

  it("explains nothing the surface already draws", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    expect(container.querySelector("[data-about]")).toBeNull();
    for (const name of ["About traffic figures", "About this financial snapshot", "About open alert counts"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(measure(container, "money")).toHaveTextContent("est.");
  });
});


// The site's all-time totals live on its own Overview.
describe("Asset Overview — the site's all-time totals", () => {
  const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

  it("shows each total with its value and read age, amber past twice the counters cadence", async () => {
    stubJsonFetch({
      ...payload(),
      counters: {
        heading: "All-time totals",
        cadenceHours: 0.25,
        cards: [
          { metric: "accounts", label: "Accounts", value: 1284, observedAt: minutesAgo(10), source: "counters" },
          { metric: "leads", label: "Leads", value: 312, observedAt: minutesAgo(45), source: "counters" },
          { metric: "orders", label: "Orders", value: 97, observedAt: minutesAgo(600), source: "nightly" },
          { metric: "plans", label: "Plans saved", value: null, observedAt: null, source: null },
        ],
      },
    });
    const { container } = renderOverview();
    const section = await screen.findByRole("region", { name: "All-time totals" });
    expect(section).toHaveAttribute("data-site-totals");
    const cells = [...section.querySelectorAll<HTMLElement>(".bg-card")];
    // A stale age says so to a screen reader, not only in amber.
    expect(cells.map((cell) => cell.textContent)).toEqual(["Accounts1,28410m", "Leads31245m · stale", "Orders97"]);
    const age = (index: number) => cells[index]!.querySelector("[data-age-state]")!;
    // 10 minutes is inside two 15-minute cadences; 45 is past it.
    expect(age(0).className).not.toContain("text-warn");
    expect(age(1).className).toContain("text-warn");
    expect(age(0).querySelector("[data-age-glyph]")).toHaveAttribute("data-age-glyph", "aged");
    expect(age(1).querySelector("[data-age-glyph]")).toHaveAttribute("data-age-glyph", "stale");
    expect(cells[2]!.querySelector("[data-age-state]")).toBeNull();
    expect(section.textContent).not.toContain("Plans saved");
    expect(container.querySelector("[data-site-totals]")).toBe(section);
  });

  it("draws nothing for a site with no totals configured, or none with a number yet", async () => {
    stubJsonFetch({ ...payload(), counters: null });
    const first = renderOverview();
    await screen.findByRole("tablist");
    expect(first.container.querySelector("[data-site-totals]")).toBeNull();
    first.unmount();

    stubJsonFetch({ ...payload(), counters: { heading: "All-time totals", cadenceHours: 0.25,
      cards: [{ metric: "plans", label: "Plans saved", value: null, observedAt: null, source: null }] } });
    const second = renderOverview();
    await screen.findByRole("tablist");
    expect(second.container.querySelector("[data-site-totals]")).toBeNull();
  });
});

describe("Asset Overview — the setup banner", () => {
  it("says how far the setup has got and where to finish it", async () => {
    stubJsonFetch(onboarding());
    const { container } = renderOverview();
    await screen.findByRole("tablist");

    const banner = await screen.findByRole("status");
    expect(banner.textContent).toContain("Data setup");
    // A row of values: the fraction, then each step still to do by name. The
    // site has never sent a nightly report, so the report is no step to do.
    expect(banner.textContent).toMatch(/\d of 2 done · to do: .+/u);
    expect(banner.textContent?.toLowerCase()).not.toContain("nightly report");
    expect(banner.textContent).not.toContain("—");
    expect(
      within(banner).getByRole("link", { name: /Review data setup/ }),
    ).toHaveAttribute("href", "/assets/meadow.example/sources");
    expect(container.querySelector('#setup [role="status"]')).not.toBeNull();
  });

  it("disappears entirely once observed setup is complete", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");

    expect(screen.queryByRole("status")).toBeNull();
    expect(container.textContent).not.toContain("Data setup");
  });
});

describe("Asset Overview — the two lists", () => {
  it("opens the exact waiting task and preserves the asset date range for return", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    const needs = within(container.querySelector<HTMLElement>('section[aria-label="Needs attention"]')!);
    const task = needs.getByRole("link", { name: /Move every recurring charge off the closing card/ });
    expect(task).toHaveAttribute("href", "/tasks/md-1");
    fireEvent.click(task);
    expect(await screen.findByTestId("url")).toHaveTextContent("/tasks/md-1");
    expect(screen.getByTestId("url")).toHaveAttribute("data-return-to", "/assets/meadow.example?range=7");
  });

  it("ranks the operator's queue urgent first and discloses the rest", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");

    const needs = within(
      container.querySelector<HTMLElement>('section[aria-label="Needs attention"]')!,
    );
    expect(needs.getByText("Last known: 2 urgent · 4 waiting")).toBeTruthy();
    const rows = container.querySelectorAll(
      'section[aria-label="Needs attention"] ul > li',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Move every recurring charge off");
    // The fourth is disclosed, never dropped.
    expect(needs.getByRole("button", { name: "Show 1 more" })).toBeTruthy();
    expect(needs.getByRole("link", { name: /All tasks/ })).toHaveAttribute(
      "href",
      "/assets/meadow.example/tasks",
    );
  });

  it("gives every ask the Tasks board's face — warn at every priority, a gate's △", async () => {
    const base = payload();
    stubJsonFetch(payload({
      operator: {
        ...base.operator,
        items: [
          workItem("md-1", "Move every recurring charge off the closing card", 0),
          { ...workItem("md-g", "Approve the spend cap", 1), issueType: "gate" },
          workItem("md-3", "Apply to the ad network when the domain turns six months old", 2),
        ],
      },
    }));
    const { container } = renderOverview();
    await screen.findByRole("tablist");

    const rings = [...container.querySelectorAll('section[aria-label="Needs attention"] ul > li')].map(
      (row) => row.querySelector("[aria-hidden]")!,
    );
    // A task's priority is not a severity: every ask is warn, a top one too;
    // the gate keeps the △ that says it holds other work.
    expect(rings.map((ring) => ring.textContent)).toEqual(["!", "△", "!"]);
    for (const ring of rings) {
      expect(ring.className).toContain("text-warn");
      expect(ring.className).not.toMatch(/\btext-(error|muted-foreground)\b/);
    }
  });

  it("keeps core task surfaces visible with an honestly unread inbox", async () => {
    taskSourceMock.connected = null;
    stubJsonFetch(payload({ operator: { capturedAt: null, waiting: null, urgent: null, items: [] } }));
    const { container } = renderOverview();
    await screen.findByRole("tablist");

    const needs = within(container.querySelector<HTMLElement>('section[aria-label="Needs attention"]')!);
    expect(needs.getByText("Count unavailable")).toBeVisible();
    expect(needs.getByText("Tasks not read yet")).toBeVisible();
    expect(needs.queryByText("Nothing waiting")).toBeNull();
    expect(screen.getByRole("tab", { name: /^Tasks/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Activity/ })).toBeInTheDocument();
    expect(container.querySelector("[data-file-task]")).not.toBeNull();
    expect(container.querySelector('section[aria-label="What matters"]')).not.toBeNull();
  });

  it("keeps insight and discovery marks distinct in Overview and All findings", async () => {
    const body = payload();
    const snapshot = body.executive!;
    snapshot.items = (["insight", "discovery"] as const).map((kind) => ({
      ...snapshot.items[0]!, key: kind, kind, title: `${kind} from the saved report`,
    }));
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const marks = [
      { kind: "insight", icon: "lucide-lightbulb", tone: "text-muted-foreground" },
      { kind: "discovery", icon: "lucide-search", tone: "text-info" },
    ];
    const overview = marks.map(({ kind, icon, tone }) => {
      const mark = container.querySelector(`[data-finding-row="${kind}"] svg.${icon}`);
      expect(mark).not.toBeNull();
      expect(mark).toHaveClass(tone);
      return mark!.innerHTML;
    });
    fireEvent.click(screen.getByText("All findings · 2"));
    await waitFor(() => expect(container.querySelectorAll("[data-insight-kind]")).toHaveLength(2));
    marks.forEach(({ kind, icon, tone }, index) => {
      const mark = container.querySelector(`[data-insight-kind="${kind}"] svg.${icon}`);
      expect(mark).not.toBeNull();
      expect(mark).toHaveClass(tone);
      expect(mark!.innerHTML).toBe(overview[index]);
    });
  });

  it("leads the findings with the warning and opens the first one", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");

    const matters = container.querySelector<HTMLElement>(
      'section[aria-label="What matters"]',
    )!;
    const rows = matters.querySelectorAll("ul > li");
    expect(rows[0]!.textContent).toContain("11.3% of sessions are unattributed");
    // The first row is expanded, with its evidence and the three actions; the
    // finding's own paragraphs are behind All findings.
    expect(rows[0]!.textContent).toContain("Unassigned share");
    expect(rows[0]!.textContent).toContain("11.3%");
    expect(rows[0]!.textContent).not.toContain("Why it matters");
    expect(
      within(rows[0] as HTMLElement).getByRole("button", { name: "Dismiss" }),
    ).toBeTruthy();
    expect(
      within(rows[0] as HTMLElement).getByRole("button", { name: "Watch outcome" }),
    ).toBeTruthy();
  });

  // An empty What matters is a state in the panel's own noun, never a
  // sentence about an internal job.
  it.each([
    ["no analysis saved yet", null, "No findings yet"],
    ["an analysis that found nothing", "empty", "Nothing found"],
    ["every finding dismissed", "dismissed", "All findings dismissed"],
  ] as const)("shows a state, not a sentence, with %s", async (_case, shape, state) => {
    const body = payload();
    if (shape === null) body.executive = null;
    else if (shape === "empty") body.executive = { ...body.executive!, items: [] };
    else {
      body.decisions = body.executive!.items.map((item) => ({
        kind: "finding" as const, key: item.key, status: "dismissed" as const,
        decidedAt: "2026-07-05T00:00:00.000Z", updatedAt: "2026-07-05T00:00:00.000Z",
      }));
    }
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const matters = container.querySelector<HTMLElement>('section[aria-label="What matters"]')!;
    expect(matters.querySelector("ul")).toBeNull();
    const empty = matters.lastElementChild as HTMLElement;
    expect(empty.textContent).toBe(state);
    expect(matters.textContent).not.toMatch(/archive analysis|has not run|in this saved analysis/u);
  });
});
