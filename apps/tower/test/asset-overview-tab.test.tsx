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
 * these are the rules: the strip drives the chart, the range re-derives every
 * number under it, the prose is behind the one disclosure, and the banner is
 * there only while the setup is open.
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

/** One KPI cell, by the label printed on it. */
function kpi(container: HTMLElement, label: string): HTMLElement {
  const cell = [...container.querySelectorAll<HTMLElement>("[data-kpi]")].find((one) =>
    one.textContent?.startsWith(label),
  );
  if (!cell) throw new Error(`no KPI labelled ${label}`);
  return cell;
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

describe("Asset Overview — the strip drives the chart", () => {
  it("Growth displays Google rates from matching impressions rather than daily averages", async () => {
    const body = payload();
    body.performance.webSearchClicks.google = trend(days(3, (i) => [1, 10, 1][i]!), null);
    body.performance.webSearchImpressions.google = trend(days(3, (i) => [1, 1000, 1][i]!), null);
    body.performance.searchCtr = trend(days(3, () => .99), null);
    body.performance.searchPosition = trend(days(3, (i) => [1, 10, 1][i]!), null);
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    fireEvent.click(screen.getByRole("tab", { name: "Growth" }));
    const strip = container.querySelector("#also-collected")!;
    expect(strip.textContent).toContain("Click rate1.2%");
    expect(strip.textContent).toContain("Average position10.0");
    expect(strip.textContent).not.toContain("99.0%");
  });

  it("never reconstructs a daily alert trend from current records", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const alerts = container.querySelector<HTMLElement>("[data-alert-current]")!;
    expect(alerts.textContent).toContain("None open");
    expect(alerts.querySelector("[data-spark]")).toBeNull();
    expect(alerts.querySelector("[data-hero-chart]")).toBeNull();
    expect(alerts.querySelector("[data-info-tooltip-trigger]")).toBeNull();
    expect(within(alerts).getByRole("link", { name: /None open/ })).toHaveAttribute("href", "/assets/meadow.example/alerts");
  });

  it("states the open alerts as the split the operator acts on", async () => {
    const body = payload();
    const flag = everyTabPayload().flags.open[0]!;
    body.flags = {
      ...body.flags,
      open: [flag, { ...flag, id: 92, severity: "warn" }, { ...flag, id: 93, severity: "warn" }],
      openError: 1,
      openWarn: 2,
    };
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const alerts = container.querySelector<HTMLElement>("[data-alert-current]")!;
    const row = within(alerts).getByRole("link", { name: /1 error · 2 warnings/ });
    expect(row).toHaveAttribute("href", "/assets/meadow.example/alerts");
    expect(row).toHaveTextContent("last fired");
  });

  it("draws daily users with their 7-day average, last week's same weekday and the weekly change", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const chart = container.querySelector<HTMLElement>("[data-hero-chart]")!;
    expect(chart.querySelector('[data-hero-raw="GA4"]')).not.toBeNull();
    expect(chart.querySelector('[data-hero-line="GA4"]')).not.toBeNull();
    expect(chart.textContent).toContain("7-day average");
    const lastWeek = chart.querySelector('[data-hero-line="Same day last week"]')!;
    expect(lastWeek.getAttribute("stroke-dasharray")).toBe("2 5");
    // A reference, so it reads second: thinner than the lead.
    expect(lastWeek).toHaveAttribute("data-hero-weight", "reference");
    expect(chart.querySelector('[data-hero-line="GA4"]')).toHaveAttribute("data-hero-weight", "lead");
    expect(chart.querySelector('[data-hero-raw="Same day last week"]')).toBeNull();
    // The series rises by two a day, so the last seven complete days average
    // 14 more than the seven before them.
    const weekly = chart.querySelector<HTMLElement>("[data-weekly-change]")!;
    expect(weekly.textContent).toBe("7 days vs the 7 before14%");
    expect(weekly.querySelector("[data-tone]")).toHaveAttribute("data-tone", "positive");
    expect(weekly.querySelector("[data-time-zone-caveat]")).toBeNull();
  });

  it("keeps the weekly change's number and takes its colour away across a reporting-timezone change", async () => {
    const body = payload();
    body.performance.activeUsers = {
      ...body.performance.activeUsers,
      timeZoneChanges: [{ effectiveOn: "2026-06-30", from: "America/Los_Angeles", to: "America/New_York" }],
    };
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const weekly = container.querySelector<HTMLElement>("[data-weekly-change]")!;
    expect(weekly.textContent).toContain("14%");
    expect(weekly.querySelector("[data-tone]")).toHaveAttribute("data-tone", "neutral");
    expect(weekly.querySelector("[data-time-zone-caveat]")).toHaveAttribute("data-time-zone-caveat", "2026-06-30");
  });

  it("draws the selected metric and moves the chart when another KPI is pressed", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");

    expect(kpi(container, "Avg. daily users").querySelector("button[aria-pressed]")).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector("[data-hero-chart]")?.textContent).toContain(
      "Active users · daily",
    );

    fireEvent.click(kpi(container, "Search clicks").querySelector("button[aria-pressed]")!);

    expect(kpi(container, "Search clicks").querySelector("button[aria-pressed]")).toHaveAttribute("aria-pressed", "true");
    expect(kpi(container, "Avg. daily users").querySelector("button[aria-pressed]")).toHaveAttribute("aria-pressed", "false");
    const chart = container.querySelector("[data-hero-chart]")!;
    expect(chart.textContent).toContain("Search clicks · daily");
    expect(within(chart as HTMLElement).getByRole("button", { name: "Google" })).toBeTruthy();
    expect(within(chart as HTMLElement).getByRole("button", { name: "Bing" })).toBeTruthy();
  });

  it("derives the chart it opens on from the data, in the strip's own order", () => {
    const strip = (drawable: string[]) =>
      (["activeUsers", "sessions", "clicks", "impressions"] as const).map((key) => ({ key, selectable: drawable.includes(key) }));
    expect(leadMetric(strip(["activeUsers", "sessions", "clicks", "impressions"]))).toBe("activeUsers");
    expect(leadMetric(strip(["clicks", "impressions"]))).toBe("clicks");
    expect(leadMetric(strip([]))).toBeNull();
    expect(leadMetric(strip(["clicks", "impressions"]), "impressions")).toBe("impressions");
    expect(leadMetric(strip(["clicks", "impressions"]), "sessions")).toBe("clicks");
  });

  /** The first number a site collects lands on a chart of that number. */
  function onlyTraffic(keep: "users" | "search" | "none"): AssetDetailPayload {
    const body = payload();
    const none = { google: emptyTrend(), bing: emptyTrend() };
    body.performance = {
      ...body.performance,
      activeUsers: keep === "users" ? body.performance.activeUsers : emptyTrend(),
      sessions: keep === "users" ? body.performance.sessions : emptyTrend(),
      webSearchClicks: keep === "search" ? { google: emptyTrend(), bing: trend(days(28, () => 21), null) } : none,
      webSearchImpressions: keep === "search" ? { google: emptyTrend(), bing: trend(days(28, () => 200), null) } : none,
    };
    return body;
  }

  it("opens a users-only site on its daily users", async () => {
    stubJsonFetch(onlyTraffic("users"));
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    expect(kpi(container, "Avg. daily users").querySelector("button[aria-pressed]")).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector("[data-hero-chart]")).toHaveTextContent("Active users · daily");
    expect(container.textContent).not.toContain("No series yet");
  });

  it("opens a search-only site on its clicks, not on an empty users chart", async () => {
    stubJsonFetch(onlyTraffic("search"));
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    expect(kpi(container, "Search clicks").textContent).toContain("588");
    expect(kpi(container, "Search clicks").querySelector("button[aria-pressed]")).toHaveAttribute("aria-pressed", "true");
    expect(kpi(container, "Avg. daily users").querySelector("button[aria-pressed]")).toBeNull();
    const chart = container.querySelector<HTMLElement>("[data-hero-chart]")!;
    expect(chart).toHaveTextContent("Search clicks · daily");
    expect(chart.querySelector('[data-hero-line="Bing"]')).not.toBeNull();
    expect(container.textContent).not.toContain("No series yet");
    expect(container.querySelectorAll('[data-kpi] button[aria-pressed="true"]')).toHaveLength(1);
  });

  it("draws no empty chart for a site with no traffic series at all", async () => {
    stubJsonFetch(onlyTraffic("none"));
    renderOverview();
    await screen.findByRole("tablist");
    const traffic = screen.getByRole("region", { name: "Traffic · last 28 days" });
    expect(traffic.querySelectorAll("[data-kpi]")).toHaveLength(4);
    expect(traffic.querySelector('button[aria-pressed="true"]')).toBeNull();
    for (const figure of traffic.querySelectorAll("[data-kpi]")) {
      expect(figure).toHaveAttribute("data-series", "unavailable");
      expect(figure).toHaveAttribute("data-series-reason", "No reports in this period.");
    }
    expect(traffic.querySelector("[data-hero-chart]")).toBeNull();
    expect(traffic.textContent).not.toContain("No series yet");
  });

  it("keeps the operator's own pick over the default once made", async () => {
    stubJsonFetch(onlyTraffic("search"));
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    fireEvent.click(kpi(container, "Impressions").querySelector("button[aria-pressed]")!);
    expect(container.querySelector("[data-hero-chart]")).toHaveTextContent("Impressions · daily");
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await screen.findByRole("region", { name: "Traffic · last 7 days" });
    expect(container.querySelector("[data-hero-chart]")).toHaveTextContent("Impressions · daily");
  });

  it("states a daily count of people per day, and events as their total", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");

    // A person who visits on two days is one person, so active users is a
    // mean: 28 complete days rising by two average 91.
    expect(kpi(container, "Avg. daily users").textContent).toContain("91");
    // Sessions are events and add up: 28 × 200.
    expect(kpi(container, "Sessions").textContent).toContain("5,600");
    // Clicks are Google plus Bing on the same days: 28 × (10 + 5).
    expect(kpi(container, "Search clicks").textContent).toContain("420");
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

describe("Asset Overview — leads with the number the site has", () => {
  /** The same site with no Analytics, Search Console or Bing series at all. */
  function noTraffic(): AssetDetailPayload {
    const body = payload();
    const none = { google: emptyTrend(), bing: emptyTrend() };
    body.performance = { ...body.performance, activeUsers: emptyTrend(), sessions: emptyTrend(),
      webSearchClicks: none, webSearchImpressions: none };
    return body;
  }

  const clarity = { source: "clarity" as const, reportDate: LAST_DAY,
    collectedAt: "2026-07-05T11:00:00.000Z", windowHours: 72 as const, truncated: false,
    page: { url: "https://meadow.example/planner", sessions: 114, scriptErrors: 19 }, unattributedSessions: null };

  it("opens Clarity on its named reported page and fixed72-hour facts, without a daily chart", async () => {
    const body = noTraffic();
    body.executive = { ...body.executive!, clarity: { ...clarity, truncated: true } };
    stubJsonFetch(body);
    const { container } = renderOverview();
    const lead = await screen.findByRole("region", { name: "Session report · 72 hours" });
    expect(kpiLabels(container).slice(0, 2)).toEqual(["Page sessions", "Script errors"]);
    expect(kpi(lead, "Page sessions")).toHaveTextContent("114");
    expect(kpi(lead, "Script errors")).toHaveTextContent("19");
    expect(within(lead).getByRole("link", { name: "meadow.example/planner" })).toHaveAttribute("href", clarity.page.url);
    expect(lead).toHaveTextContent("Collected Jul 5, 2026");
    expect(lead).toHaveTextContent("Limited export");
    expect(lead).not.toHaveTextContent("No previous period");
    expect(lead.querySelector("[data-hero-chart]")).toBeNull();
    expect(screen.queryByRole("region", { name: "Traffic · last 28 days" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(kpi(lead, "Script errors")).toHaveTextContent("19"));
    expect(lead).toHaveTextContent("72 hours");
  });

  it("names an unattributed bucket honestly and keeps an explicit zero distinct from Unknown", async () => {
    const body = noTraffic();
    body.executive = { ...body.executive!, clarity: { ...clarity, page: null, unattributedSessions: 0 } };
    stubJsonFetch(body);
    const first = renderOverview();
    const lead = await screen.findByRole("region", { name: "Session report · 72 hours" });
    expect(kpi(lead, "Unattributed sessions")).toHaveTextContent("0");
    expect(lead).not.toHaveTextContent("Page sessions");
    first.unmount();
    stubJsonFetch({ ...body, executive: { ...body.executive!, clarity: { ...clarity, page: null, collectedAt: null } } });
    renderOverview();
    const unknown = await screen.findByRole("region", { name: "Session report · 72 hours" });
    expect(kpi(unknown, "Unattributed sessions")).toHaveTextContent("Unknown");
    expect(unknown).toHaveTextContent("Reported Jul 5, 2026");
    expect(unknown).not.toHaveTextContent("Collected");
  });

  it("preserves traffic, revenue and PostHog priority ahead of Clarity", async () => {
    const traffic = payload();
    traffic.executive = { ...traffic.executive!, clarity };
    stubJsonFetch(traffic);
    const first = renderOverview();
    await screen.findByRole("region", { name: "Traffic · last 28 days" });
    expect(screen.queryByRole("region", { name: "Session report · 72 hours" })).toBeNull();
    first.unmount();
    const body = noTraffic();
    body.executive = { ...body.executive!, clarity };
    stubJsonFetch({ ...body, dailyRevenue: revenue() });
    const second = renderOverview();
    await screen.findByRole("region", { name: "Daily revenue" });
    expect(screen.queryByRole("region", { name: "Session report · 72 hours" })).toBeNull();
    second.unmount();
    body.executive.product = { source: "posthog", observedAt: LAST_DAY, collectedAt: null, families: [],
      webDaily: { windowStart: LAST_DAY, windowEnd: LAST_DAY, reportDate: LAST_DAY,
        days: [{ date: LAST_DAY, people: 10, pageviews: 20, sessions: 12 }] },
      funnels: [], vitals: null, exceptions: null, rageClicks: null, onceEvents: [], checks: [], caveat: "" };
    stubJsonFetch(body); renderOverview();
    await screen.findByRole("region", { name: "Traffic · last 28 days" });
    expect(screen.queryByRole("region", { name: "Session report · 72 hours" })).toBeNull();
  });

  /** Every [data-kpi] on the tab, in document order: what is drawn first. */
  function kpiLabels(container: HTMLElement): string[] {
    return [...container.querySelectorAll<HTMLElement>('[role="tabpanel"] [data-kpi]')].map((one) => one.getAttribute("data-kpi") ?? "");
  }

  /** Thirty days of ad revenue estimates ending on yesterday (the fixture's
   * saved clock: 2026-07-05), $5.00 a day. */
  function revenue() {
    const days = Array.from({ length: 30 }, (_, index) => ({ date: shiftLabel(LAST_DAY, index - 29), amountMinor: 500 }));
    return { from: shiftLabel(LAST_DAY, -89), to: LAST_DAY, days, reportedThrough: LAST_DAY };
  }

  it("opens a revenue-only site on its daily revenue, not on four dashes", async () => {
    stubJsonFetch({ ...noTraffic(), dailyRevenue: revenue() });
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    expect(screen.queryByRole("region", { name: "Traffic · last 28 days" })).toBeNull();
    const lead = screen.getByRole("region", { name: "Daily revenue" });
    // 28 days × $5.00.
    expect(kpiLabels(container)[0]).toBe("Reported earnings");
    expect(kpi(lead, "Reported earnings")).toHaveTextContent("$140.00");
    expect(lead.querySelector("[data-hero-chart]")).not.toBeNull();
    expect(container.textContent).not.toContain("Avg. daily users");
    // 7 × $5.00.
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(kpi(screen.getByRole("region", { name: "Daily revenue" }), "Reported earnings")).toHaveTextContent("$35.00"));
  });

  it("opens a PostHog-only site on its people a day, in the traffic strip, with PostHog named on the chart", async () => {
    const body = noTraffic();
    const days = Array.from({ length: 28 }, (_, index) => ({ date: shiftLabel(LAST_DAY, index - 27), people: 100, pageviews: 500, sessions: 140 }));
    body.executive = { ...body.executive!, product: {
      source: "posthog", observedAt: LAST_DAY, collectedAt: null, families: [],
      webDaily: { windowStart: days[0]!.date, windowEnd: LAST_DAY, reportDate: LAST_DAY, days },
      funnels: [], vitals: null, exceptions: null, rageClicks: null, onceEvents: [], checks: [], caveat: "",
    } };
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const traffic = screen.getByRole("region", { name: "Traffic · last 28 days" });
    expect(kpiLabels(container).slice(0, 3)).toEqual(["People a day", "Page views", "Sessions"]);
    expect(traffic.querySelectorAll("[data-kpi]")).toHaveLength(3);
    expect(kpi(traffic, "People a day")).toHaveTextContent("100");
    expect(kpi(traffic, "Page views")).toHaveTextContent("14K");
    expect(kpi(traffic, "People a day").querySelector("button[aria-pressed]")).toHaveAttribute("aria-pressed", "true");
    const chart = traffic.querySelector<HTMLElement>("[data-hero-chart]")!;
    expect(chart).toHaveTextContent("People · daily");
    expect(chart.querySelector('[data-hero-line="PostHog"]')).not.toBeNull();
    expect(traffic.textContent).not.toContain("Search clicks");
  });

  it("opens a DataForSEO-only site on its rankings, declaring there is no series yet", async () => {
    const body = noTraffic();
    body.executive = { ...body.executive!, searchIntelligence: {
      observedAt: "2026-07-01", costUsd: 0.1,
      rankings: { keywords: 312, top3: 4, top10: 21, top20: 60, estimatedVisits: 880, estimatedPaidTrafficCost: 410, aiOverviewReferences: 2 },
      backlinks: null, ai: { googleMentions: null, googleSearchVolume: null, chatgptMentions: null, chatgptSearchVolume: null },
      referringDomains: [], anchors: null, keywordIdeas: [], competitors: [],
    } };
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const lead = screen.getByRole("region", { name: "Search position" });
    expect(kpiLabels(container).slice(0, 4)).toEqual(["Keywords", "Top 10", "Visits a month", "Traffic value"]);
    expect(kpi(lead, "Keywords")).toHaveTextContent("312");
    expect(lead.querySelectorAll('[data-series="unavailable"]')).toHaveLength(4);
    expect(screen.queryByRole("region", { name: "Traffic · last 28 days" })).toBeNull();
  });

  it("keeps a site with Bing or Analytics data on its traffic chart, whatever else it has", async () => {
    const body = payload();
    stubJsonFetch({ ...body, dailyRevenue: revenue() });
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const traffic = screen.getByRole("region", { name: "Traffic · last 28 days" });
    expect(traffic.querySelectorAll("[data-kpi]")).toHaveLength(4);
    expect(traffic.querySelector("[data-hero-chart]")).toHaveTextContent("Active users · daily");
    expect(kpiLabels(container)[0]).toBe("Avg. daily users");
    expect(screen.queryByRole("region", { name: "Daily revenue" })).toBeNull();
  });
});

describe("Asset Overview — the range controls traffic, not independent snapshots", () => {
  it("recomputes the value, the delta's window and the URL", async () => {
    const { container, getByTestId } = renderOverview();
    await screen.findByRole("tablist");

    expect(kpi(container, "Avg. daily users").textContent).toContain("91");
    expect(kpi(container, "Avg. daily users").querySelector("[data-tone]")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("28 days"),
    );
    // The default is the bare URL, not `?range=28`: one page, one address.
    expect(getByTestId("url").textContent).toBe("/assets/meadow.example");

    fireEvent.click(screen.getByRole("button", { name: "7d" }));

    await waitFor(() =>
      expect(kpi(container, "Avg. daily users").textContent).toContain("112"),
    );
    expect(kpi(container, "Avg. daily users").querySelector("[data-tone]")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("7 days"),
    );
    expect(getByTestId("url").textContent).toBe("/assets/meadow.example?range=7");
  });

  it("groups four traffic metrics separately from the accounting month and recorded alert status", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const traffic = screen.getByRole("region", { name: "Traffic · last 28 days" });
    const financials = screen.getByRole("region", { name: "Money · July 2026" });
    const alerts = screen.getByRole("region", { name: "Open alerts" });
    expect(alerts).toHaveTextContent("last fired");
    expect(traffic.querySelectorAll("[data-kpi]")).toHaveLength(4);
    expect(traffic.querySelector("[data-hero-chart]")).not.toBeNull();
    expect(traffic).not.toHaveTextContent("Net");
    expect(traffic).not.toHaveTextContent("Open alerts");
    expect(traffic.compareDocumentPosition(financials) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(traffic.compareDocumentPosition(alerts) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const net = kpi(financials, "Net").textContent;
    expect(net).toContain("436");
    expect(within(financials).getByRole("link", { name: "View financials" })).toHaveAttribute("href", "/assets/meadow.example/financials");
    expect(container.querySelector("#product-report")).toHaveTextContent("Product use");
    expect(container.querySelector("#product-use")).toBeNull();
    expect(screen.getByRole("region", { name: "Product use" })).toHaveTextContent("Latest reported 24 hours");

    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await screen.findByRole("region", { name: "Traffic · last 7 days" });
    expect(kpi(container, "Sessions")).toHaveTextContent("1,400");
    expect(kpi(financials, "Net").textContent).toBe(net);
    expect(screen.getByRole("region", { name: "Money · July 2026" })).toBe(financials);
    expect(within(alerts).getByRole("link", { name: /None open/ })).toHaveAttribute("href", "/assets/meadow.example/alerts?range=7");
    expect(within(financials).getByRole("link", { name: "View financials" })).toHaveAttribute("href", "/assets/meadow.example/financials");
  });

  it("keeps net history available as accounting months outside the traffic selector", async () => {
    renderOverview();
    await screen.findByRole("tablist");
    const financials = screen.getByRole("region", { name: "Money · July 2026" });
    expect(financials.querySelector("[data-hero-chart]")).toBeNull();
    fireEvent.click(within(financials).getByText("Monthly net history"));
    await within(financials).findByText("Net · by accounting month, Estimated");
    expect(financials).not.toHaveTextContent("One point per accounting month");
    fireEvent.click(within(financials).getByRole("button", { name: "About Net · by accounting month, Estimated" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("One point per accounting month");
    fireEvent.keyDown(window, { key: "Escape" });
    const monthly = financials.querySelector("[data-hero-chart]")?.textContent;
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(financials.querySelector("[data-hero-chart]")?.textContent).toBe(monthly);
  });

  it("shows the monthly net trend before its disclosure and keeps traffic dates separate", async () => {
    const body = payload();
    body.ledger.periods.push({ ...structuredClone(body.ledger.periods[1]!), period: "2026-05" });
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const net = kpi(container, "Net");
    const spark = within(net).getByRole("img", { name: "Net by accounting month trend" });
    expect(spark).toHaveAccessibleDescription(expect.stringContaining("reported monthly values, not averaged"));
    expect(net).not.toHaveAttribute("data-series", "unavailable");
    const trend = spark.innerHTML;
    fireEvent.click(screen.getByRole("button", { name: "7d" }));
    await screen.findByRole("region", { name: "Traffic · last 7 days" });
    expect(spark.innerHTML).toBe(trend);
  });

  it.each([0, 2])("explains the missing net trend with %i accounting months", async (count) => {
    const body = payload();
    body.ledger.periods = body.ledger.periods.slice(0, count);
    stubJsonFetch(body);
    const { container } = renderOverview();
    await screen.findByRole("tablist");
    const net = kpi(container, "Net");
    expect(net).toHaveAttribute("data-series", "unavailable");
    expect(net.querySelector("[data-spark]")).toBeNull();
    expect(net).toHaveAttribute("data-series-reason", count === 0
      ? "No financial totals recorded"
      : "At least three accounting months are needed for a trend.");
  });

  it("states standalone net and its composition to the cent with a separate Estimated label", async () => {
    const body = payload();
    body.ledger.periods[0]!.forecast = {
      figure: { currency: 'USD', revenue: 441.37, cost: 5.18, net: 436.19 },
      revenueByFamily: [{ currency: 'USD', family: "ads", amount: 441.37 }],
      costByFamily: [{ currency: 'USD', family: "inference", amount: 5.18 }],
    };
    stubJsonFetch(body);
    renderOverview();
    await screen.findByRole("tablist");
    const financials = screen.getByRole("region", { name: "Money · July 2026" });
    const net = kpi(financials, "Net");
    expect(net).toHaveTextContent("$436.19 Estimated");
    expect(within(net).getByText("Estimated")).toBeVisible();
    expect(net).toHaveTextContent("ads $441.37 · costs $5.18");
    expect(net).not.toHaveTextContent("forecast");
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

  it("explains nothing the surface already draws", async () => {
    const { container } = renderOverview();
    await screen.findByRole("tablist");

    expect(container.querySelector("[data-about]")).toBeNull();
    for (const name of ["About traffic figures", "About this financial snapshot", "About open alert counts"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(kpi(container, "Avg. daily users")).toHaveTextContent("7-day average");
    expect(container.querySelector("[data-hero-chart]")).toHaveTextContent("GA4");
    const financials = screen.getByRole("region", { name: "Money · July 2026" });
    expect(within(financials).getByText("Estimated")).toBeVisible();
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

  it("disappears entirely once the asset is live", async () => {
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
    const needs = within(container.querySelector<HTMLElement>('section[aria-label="Needs you"]')!);
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
      container.querySelector<HTMLElement>('section[aria-label="Needs you"]')!,
    );
    expect(needs.getByText("Last known: 2 urgent · 4 waiting")).toBeTruthy();
    const rows = container.querySelectorAll(
      'section[aria-label="Needs you"] ul > li',
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

    const rings = [...container.querySelectorAll('section[aria-label="Needs you"] ul > li')].map(
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

    const needs = within(container.querySelector<HTMLElement>('section[aria-label="Needs you"]')!);
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
