import { integrationStatus } from '@shared/integration-status';
import { INTEGRATION_PROVIDERS } from "@noticeos/contract";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem, CardDataSource, PortfolioBand, WallPayload } from "@shared/wall";
import { emptyWorkHistory, type WorkItem, type WorkPayload, type WorkProject } from "@shared/work";

const payload = vi.hoisted(
  (): WallPayload => ({
    generatedAt: "2026-07-29T12:00:00.000Z",
    portfolio: { netTrendCurrency: 'USD', netTrendAllCurrency: 'USD',
      period: "2026-07",
      periodIsCurrent: true,
      booked: { currency: 'USD', revenue: 100, cost: 20, net: 80 },
      forecast: { currency: 'USD', revenue: 45, cost: 0, net: 45 },
      netTrend: [{ t: "2026-07", v: 80 }],
      netTrendAll: [{ t: "2026-07", v: 80 }],
      trendGranularity: "monthly",
      bookedDelta: null,
      residue: {
        booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
        forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
      },
      firstRun: false,
      daysIn: 30,
    },
    system: {
      assetId: "root-os",
      hasPulse: true,
      spendTodayUsd: 1,
      dailyCapUsd: 2,
      ingest: { fresh: 1, stale: 0, notExpected: 0, expected: 1 },
      scheduledLanes: [
        { job: "backup", outcome: "ran", startedAt: "2026-07-29T11:00:00.000Z", lastRanAt: "2026-07-29T11:00:00.000Z", failedRuns: 0, failingSince: null },
      ],
    },
    dashboard: {
      countdown: {
        emoji: "🌁",
        label: "Team offsite - August 2026",
        targetAt: "2026-08-01T07:00:00.000Z",
      },
    },
    // One asset, carrying work but no signals: enough for the card's work
    // widget to render on both routes.
    assets: [
      { netByMonthCurrency: 'USD',
        id: "meadow.example",
        displayName: "Meadow Board",
        status: "live",
        senseOnly: false,
        worstSeverity: null,
        openError: 0,
        openWarn: 0,
        booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
        forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
        netPeriod: "2026-07",
        pulseReceivedAt: "2026-07-29T11:00:00.000Z",
        firstReportAt: null,
        dataSources: [],
        activeUsers: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
        work: {
          open: 12,
          highPriority: 3,
          inProgress: 2,
          blocked: 1,
          closedRecent: 4,
          priorities: [1, 2, 8, 3, 1],
          capturedAt: "2026-07-29T12:04:50.000Z",
        },
        // No entry in config/serp-panel.json: this asset buys no tracked panel.
        panelReview: null,
        searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
        netByMonth: [],
        netByMonthProvisionalFrom: null,
        latestPanelDate: null,
      },
    ],
    attention: [],
    snoozed: [],
    operator: {
      waiting: 0,
      urgent: 0,
      measuredProjects: 1,
      urgentMeasuredProjects: 1,
      projectCount: 1,
      capturedAt: "2026-07-29T12:04:50.000Z",
    },
    ledgerRecordedAt: "2026-07-29T12:00:00.000Z",
  }),
);

/** The work board's own poll. Home flattens `projects[].waiting`; the Wall does
 * not read it at all, which is why it is a separate mock the Wall tests ignore. */
const workState = vi.hoisted(() => ({
  isError: false,
  data: undefined as WorkPayload | undefined,
}));

vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({
    data: payload,
    isError: false,
    isPending: false,
  }),
}));

// The two reads every source status comes from: the stored credentials and
// the monitoring items. By default neither has answered, which the model
// reads as Unknown; a case about a source's status says what they answered.
const reads = vi.hoisted(() => ({
  providers: undefined as import("@shared/integrations-page").IntegrationCredentialsPayload | undefined,
  health: undefined as import("@noticeos/contract").IntegrationHealthPayload | undefined,
}));
vi.mock("@/hooks/useIntegrationProviders", () => ({
  INTEGRATION_PROVIDERS_KEY: ["integration-providers"],
  useIntegrationProviders: () => ({ data: reads.providers, isPending: reads.providers === undefined, isError: false }),
}));
vi.mock("@/hooks/useIntegrationHealth", () => ({
  INTEGRATION_HEALTH_KEY: ["integration-health"],
  useIntegrationHealth: () => ({
    data: reads.health, isError: false,
    status: integrationStatus(reads.health, false, Date.parse("2026-07-29T12:05:00.000Z")),
  }),
}));

vi.mock("@/hooks/useWork", () => ({
  useWork: () => ({
    data: workState.data,
    isError: workState.isError,
    isPending: workState.data === undefined,
  }),
}));

// With one site Home leads with that site's Overview lead, read through the
// Overview's own view. It has not answered unless a case says what it answered.
const detail = vi.hoisted(() => ({
  data: undefined as import("@shared/asset-detail-views").AssetDetailResponse | undefined,
  asked: [] as string[],
}));
vi.mock("@/hooks/useAssetDetail", () => ({
  useAssetDetail: (id: string, view: string) => {
    detail.asked.push(`${id}:${view}`);
    return { data: detail.data, isFetching: false, error: null };
  },
}));

vi.mock("@/hooks/useNow", () => ({
  useNow: () => Date.parse("2026-07-29T12:05:00.000Z"),
}));

vi.mock("@/hooks/useGa4Realtime", () => ({
  useGa4Realtime: () => ({
    data: { generatedAt: "2026-07-29T12:05:00.000Z", assets: [] },
    isError: false,
    isPending: false,
  }),
}));

// A meeting that is already running at the mocked instant, so the assertion
// does not depend on which local day 12:05Z falls on for the machine.
vi.mock("@/hooks/useCalendarUpcoming", () => ({
  useCalendarUpcoming: () => ({
    data: {
      fetchedAt: "2026-07-29T12:05:00.000Z",
      feedsConfigured: 2,
      feedsOk: 2,
      calendars: [
        { id: "work", color: null, status: "ok" },
        { id: "personal", color: null, status: "ok" },
      ],
      meetings: [
        {
          calendar: "work",
          title: "Standup",
          startsAt: "2026-07-29T11:45:00.000Z",
          endsAt: "2026-07-29T12:30:00.000Z",
          allDay: false,
          location: null,
        },
      ],
    },
    isError: false,
    isPending: false,
  }),
}));

// The Wall's live feed polls on its own; here it has answered with a quiet
// evening, so the column draws its empty state.
vi.mock("@/hooks/useWallFeed", () => ({
  useWallFeed: () => ({
    data: { generatedAt: "2026-07-29T12:05:00.000Z", since: "2026-07-29T01:00:00.000Z", items: [], limit: 50 },
    isError: false,
  }),
}));

// The clock proposal on the first-run screen: the saved clock, the browser's
// zone, and the one save it makes. Nothing is saved until a case presses.
const clockState = vi.hoisted(() => ({
  settings: undefined as { clock: { owner: string; timeZone: string; chosen: boolean } } | undefined,
  browser: "UTC",
  ops: [] as unknown[][],
  undone: 0,
}));
vi.mock("@/hooks/useSettings", () => ({ useSettings: () => ({ data: clockState.settings }) }));
vi.mock("@/hooks/useConfigWritable", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useConfigWritable")>()),
  useConfigWritable: () => ({ writable: true, reason: null, sources: {} }),
}));
vi.mock("@/hooks/useConfigSave", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useConfigSave")>()),
  useFieldConfigSave: () => async ({ ops }: { ops: unknown[] }) => {
    clockState.ops.push(ops);
    return { saved: true, undo: async () => { clockState.undone += 1; return { undone: true }; } };
  },
}));
vi.mock("@shared/scheduled-jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/scheduled-jobs")>()),
  localTimezone: () => clockState.browser,
}));

import { Sidebar } from "@/components/AppShell";
import { HomeRoute } from "@/routes/HomeRoute";
import { WallRoute } from "@/routes/WallRoute";
import { resetTaskSourceMock, taskSourceMock } from "./task-source-mock";
import { everyTabPayload, viewOf } from "./asset-detail-fixture";
import { backupLane, backupNight } from "./backup-lanes";

vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

const OPEN_ATTENTION = payload.attention;
const POPULATED_PORTFOLIO = payload.portfolio;
const SEEDED_ASSETS = payload.assets;
const SEEDED_SYSTEM = payload.system;
const SEEDED_DASHBOARD = payload.dashboard;

/** A second site beside the seeded one: Home's several-site view. */
function withSecondSite() {
  payload.assets = [...payload.assets, {
    ...SEEDED_ASSETS[0]!, id: "second.example", displayName: "Second Example",
    work: null, pulseReceivedAt: null,
  }];
}

afterEach(() => {
  payload.attention = OPEN_ATTENTION;
  payload.portfolio = POPULATED_PORTFOLIO;
  payload.assets = SEEDED_ASSETS;
  payload.system = SEEDED_SYSTEM;
  payload.dashboard = SEEDED_DASHBOARD;
  workState.data = undefined;
  workState.isError = false;
  reads.providers = undefined;
  reads.health = undefined;
  detail.data = undefined;
  detail.asked.length = 0;
  clockState.settings = undefined;
  clockState.browser = "UTC";
  clockState.ops.length = 0;
  clockState.undone = 0;
});

/** Home with the query client Decide's verbs need: an answer goes through the
 * Tasks board's own path, which refreshes the task reads (useTaskRefresh). */
function homeTree() {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <HomeRoute />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderHome() {
  return render(homeTree());
}

function renderWall() {
  return render(
    <MemoryRouter>
      <WallRoute />
    </MemoryRouter>,
  );
}

/** The reads answered: Google connected, and these monitoring items. */
function googleAnswers(items: { capability: string; state: "healthy" | "failing" }[]) {
  const at = "2026-07-29T12:00:00.000Z";
  const credential = {
    provider: "google" as const, source: "store" as const, fields: [], assetsHeld: [], missingFields: [], auth: "oauth" as const,
    metadata: null, keyVersion: 1, createdAt: at, updatedAt: at, lastUsedAt: at, lastOkAt: at, lastError: null,
  };
  reads.providers = {
    generatedAt: at, keyPresent: true, keyReason: null,
    blockers: [],
    providers: [{ provider: INTEGRATION_PROVIDERS.find((entry) => entry.id === "google")!, credential, assets: [] }],
  };
  reads.health = {
    generatedAt: "2026-07-29T12:05:00.000Z", available: true, events: [],
    items: items.map(({ capability, state }, index) => ({
      id: `item-${index}`, provider: "google", capability, label: capability, asset: "meadow.example", detail: null, report: null, reportDate: null, state,
      lastAttemptAt: at, lastSuccessAt: state === "healthy" ? at : null, nextAttemptAt: null,
      failure: state === "failing" ? "access" : null, code: state === "failing" ? "access" : null,
      action: "Review the property connection.", coverage: "monitored",
    })),
  };
}

// Home keeps each source's one status; the Wall draws no icon row, and a
// failing source becomes the site's health bar and a bar on the Wall's timeline.
describe("Home shows each source's one status, and the Wall marks only a failing one", () => {
  const ga4: CardDataSource = { id: "ga4", label: "Google Analytics", state: "live", observedAt: "2026-07-29T12:00:00Z", verification: { kind: "collection-success", laneId: "ga4" } };
  const nightly: CardDataSource = { id: "nightly-report", label: "Nightly report", state: "live", observedAt: "2026-07-29T11:00:00Z", verification: { kind: "collection-success", laneId: "nightly-report" } };
  const statusOn = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll('[role="img"]')].find((mark) => mark.getAttribute("aria-label")?.startsWith(`${label}: `))?.getAttribute("aria-label");
  const siteHealthOn = (container: HTMLElement) => container.querySelector('[data-status-for="asset:meadow.example"][data-site-health]');
  const timelineOn = (container: HTMLElement) => container.querySelector("[data-wall-timeline]")!;

  it.each([
    ["configuration only", { ...nightly, observedAt: null, verification: undefined }],
    ["a dated outcome without success proof", { ...nightly, verification: undefined }],
    ["an old success", { ...nightly, observedAt: "2026-07-26T12:00:00Z" }],
    ["a future success", { ...nightly, observedAt: "2026-07-30T12:00:00Z" }],
    ["another source's success", { ...nightly, verification: { kind: "collection-success", laneId: "gsc" } }],
  ] satisfies [string, CardDataSource][])("keeps a nightly report with %s unproven on Home, and the Wall draws no icon for it", (_name, source) => {
    payload.assets = [{ ...SEEDED_ASSETS[0]!, dataSources: [source] }];
    const home = renderHome();
    expect(statusOn(home.container, "Nightly report")).toBe("Nightly report: Not checked");
    home.unmount();
    const wall = renderWall();
    expect(statusOn(wall.container, "Nightly report")).toBeUndefined();
    expect(siteHealthOn(wall.container)).toHaveAttribute("data-site-health", "healthy");
    expect(siteHealthOn(wall.container)).toHaveAccessibleName("Site health: On track");
    expect(timelineOn(wall.container)).toHaveAttribute("data-wall-timeline", "calm");
  });

  it("never shows a provider's source Working before the monitoring read answers", () => {
    payload.assets = [{ ...SEEDED_ASSETS[0]!, dataSources: [ga4] }];
    const home = renderHome();
    expect(statusOn(home.container, "Google Analytics")).toBe("Google Analytics: Unknown");
    home.unmount();
    const wall = renderWall();
    expect(statusOn(wall.container, "Google Analytics")).toBeUndefined();
    expect(siteHealthOn(wall.container)).toHaveAttribute("data-site-health", "healthy");
    expect(siteHealthOn(wall.container)).toHaveAccessibleName("Site health: On track");
    expect(timelineOn(wall.container)).toHaveAttribute("data-wall-timeline", "calm");
    expect(wall.container.querySelector("[data-system-state]")).toBeNull();
  });

  it("shows the monitoring model's Failing on Home, and the Wall's health bar and timeline despite a successful 15-minute run", () => {
    googleAnswers([{ capability: "ga4-daily", state: "healthy" }, { capability: "ga4-archive", state: "failing" }]);
    payload.assets = [{ ...SEEDED_ASSETS[0]!, dataSources: [ga4] }];
    const home = renderHome();
    expect(statusOn(home.container, "Google Analytics")).toBe("Google Analytics: Failing");
    home.unmount();
    const wall = renderWall();
    expect(statusOn(wall.container, "Google Analytics")).toBeUndefined();
    expect(siteHealthOn(wall.container)).toHaveAttribute("data-site-health", "error");
    expect(siteHealthOn(wall.container)).toHaveAccessibleName("Site health: GA4 failing");
    expect(timelineOn(wall.container)).toHaveAttribute("data-wall-timeline", "problems");
    expect(timelineOn(wall.container).querySelector('[data-span^="source-ga4"]')).toHaveAttribute("data-severity", "error");
    expect(timelineOn(wall.container).querySelector("[data-event-timeline-list]")).toHaveTextContent("GA4 collection failing");
    expect(wall.container.querySelector("[data-system-state]")).toBeNull();
  });

  it("shows a working source as a working check on Home, and the Wall's health bar without a concern", () => {
    googleAnswers([{ capability: "ga4-daily", state: "healthy" }]);
    payload.assets = [{ ...SEEDED_ASSETS[0]!, dataSources: [ga4, nightly] }];
    const home = renderHome();
    expect(statusOn(home.container, "Google Analytics")).toBe("Google Analytics: Working");
    expect(statusOn(home.container, "Nightly report")).toBe("Nightly report: Working");
    home.unmount();
    const wall = renderWall();
    expect(wall.container.querySelector("[data-source]")).toBeNull();
    expect(siteHealthOn(wall.container)).toHaveAttribute("data-site-health", "healthy");
    expect(siteHealthOn(wall.container)).toHaveAccessibleName("Site health: On track");
    expect(timelineOn(wall.container)).toHaveAttribute("data-wall-timeline", "calm");
  });
});

/** A panel by its title: the accessible name it gives its own section.
 * The assertions reach for the vocabulary's own marks rather than a route's
 * private class names, so they break only when the composition does. */
function panelFor(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

/** An open flag whose rule the translator has never heard of, so its headline
 * is the store's own message. */
function alert(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 1,
    asset: "meadow.example",
    assetDisplayName: "Meadow Board",
    severity: "warn",
    kind: "anomaly",
    message: "Signups well below normal",
    firedAt: "2026-07-29T09:00:00.000Z",
    metric: null,
    ruleId: "rule-the-translator-does-not-know",
    ruleInputs: null,
    correlatedChanges: [],
    occurrences: 1,
    firstFiredAt: "2026-07-29T09:00:00.000Z",
    ...overrides,
  };
}

function waiting(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "md-1w2",
    title: "Decide the recipe schema",
    status: "open",
    priority: 2,
    issueType: "task",
    assignee: null,
    updatedAt: "2026-07-29T11:00:00.000Z",
    closedAt: null,
    parent: null,
    deferUntil: null,
    ...overrides,
  };
}

function project(name: string, inbox: WorkItem[]): WorkProject {
  return {
    asset: name.toLowerCase(),
    prefix: name.slice(0, 2).toLowerCase(),
    name,
    ok: true,
    error: null,
    counts: {
      open: 3,
      highPriority: 0,
      ready: 2,
      inProgress: 1,
      blocked: 0,
      closedRecent: 0,
      deferred: 0,
      waiting: inbox.length,
    },
    history: emptyWorkHistory(),
    priorities: null,
    epics: null,
    ready: [],
    inProgress: [],
    recentlyClosed: [],
    deferred: [],
    waiting: inbox,
  };
}

function workPayload(projects: WorkProject[], capturedAt: string | null = "2026-07-29T12:04:50.000Z"): WorkPayload {
  return {
    generatedAt: "2026-07-29T12:05:00.000Z",
    capturedAt,
    pollCadenceHours: 1 / 60,
    owner: "config/beads.json",
    projects,
    historyDays: 0,
  };
}

/** The page a stranger sees the first time they start NoticeOS against an empty
 * store. */
describe("Home — a fresh install", () => {
  /** An empty store: no asset rows, so no alerts and no assets either. */
  function emptyStore() {
    payload.assets = [];
    payload.attention = [];
  }

  it("says what NoticeOS does, then the three steps to a first asset", () => {
    emptyStore();

    const { container } = renderHome();

    expect(
      screen.getByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
    expect(container.querySelector("[data-first-run]")).not.toBeNull();
    expect(
      screen.getByRole("heading", { level: 2, name: "Your sites’ traffic, money and open work, in one place" }),
    ).toBeInTheDocument();

    const steps = container.querySelectorAll<HTMLElement>("[data-first-run-step]");
    expect(steps).toHaveLength(3);
    // Step 1 is the screen's one primary action, and it opens Add a site over
    // Home. What it opens is pinned in test/add-site.test.tsx.
    expect(screen.getByRole("button", { name: "Add your first site" })).toHaveAttribute("data-add-site-open");
    expect(screen.queryByRole("link", { name: /Add a/ })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Add a site" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Connect a source" }),
    ).toHaveAttribute("href", "/integrations");
    expect(screen.getByRole("link", { name: "Connect a source" }).tabIndex).toBe(0);

    expect([...steps].map((step) => step.textContent)).toEqual([
      "Step 1Add your first site",
      "Step 2Connect a source",
      "Step 3See your first number",
    ]);
    expect([...steps].map((step) => step.getAttribute("data-first-run-state"))).toEqual(["current", "next", "next"]);
    expect(container.querySelector("[data-first-run] p")).toBeNull();
  });

  it("names the arrival step by the number it ends on and sends it nowhere before a site exists", () => {
    emptyStore();

    const { container } = renderHome();
    const arrivalStep = container.querySelector<HTMLElement>("[data-first-run-step='3']")!;

    expect(arrivalStep).toHaveTextContent("See your first number");
    expect(within(arrivalStep).queryByRole("link")).toBeNull();
    expect(container.querySelector('[data-first-run] a[href="/health"]')).toBeNull();
    expect(screen.queryByText("Wait for the first nightly report")).not.toBeInTheDocument();
    expect(arrivalStep).not.toHaveTextContent("The night it lands");
    expect(arrivalStep).not.toHaveTextContent("the month's money");
  });

  it("renders no strip, no list and no table around it", () => {
    emptyStore();

    const { container } = renderHome();

    // The whole strip is gone, not four KPIs reading zero: a zero claims
    // something was measured.
    expect(container.querySelector("[data-kpi-strip]")).toBeNull();
    expect(container.querySelector("[data-surface-hero]")).toBeNull();
    expect(screen.queryAllByText("Decide")).toHaveLength(0);
    expect(container.querySelector("table")).toBeNull();
    // Not even the table's own empty state: one first-run state, not six.
    expect(container.querySelector("[data-no-sites]")).toBeNull();
    expect(screen.queryAllByText("No sites yet")).toHaveLength(0);
    expect(container.querySelector("[data-portfolio-census]")).toBeNull();
    expect(container.querySelector("[data-about]")).toBeNull();
  });

  it("stays out of the way once a site has reported", () => {
    const { container } = renderHome();

    expect(container.querySelector("[data-first-run]")).toBeNull();
    expect(container.querySelector("[data-home-brief]")).not.toBeNull();
    expect(container.querySelector('[data-one-site-lead="meadow.example"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-asset-row]")).toHaveLength(0);
  });

  /** The product ships UTC. Until somebody chooses a clock, the first run
   * shows the one in effect and one press to use the browser's, with Undo
   * beside it; a page view alone saves nothing. */
  it("offers the browser's clock with one press while nobody has chosen one, with Undo beside it", async () => {
    emptyStore();
    clockState.settings = { clock: { owner: "config/constants.json", timeZone: "UTC", chosen: false } };
    clockState.browser = "America/New_York";

    const { container } = renderHome();
    const row = container.querySelector<HTMLElement>("[data-first-run] [data-clock-proposal]")!;
    expect(row.querySelector("[data-clock-in-effect]")).toHaveTextContent("UTC");
    expect(clockState.ops).toHaveLength(0);

    fireEvent.click(within(row).getByRole("button", { name: "Use America / New York" }));
    await waitFor(() => expect(row.querySelector('[data-save-state="saved"]')).not.toBeNull());
    expect(clockState.ops).toEqual([[
      { kind: "file-json-set", file: "config/constants.json", pointer: "/os_time_zone", expect: "UTC", value: "America/New_York" },
    ]]);
    expect(row.querySelector("[data-clock-in-effect]")).toHaveTextContent("America / New York");
    expect(within(row).queryByRole("button", { name: /^Use / })).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(row.querySelector("[data-clock-in-effect]")).toHaveTextContent("UTC"));
    expect(clockState.undone).toBe(1);
    expect(within(row).getByRole("button", { name: "Use America / New York" })).toBeInTheDocument();
  });

  it("offers no clock once one is chosen, or when the browser reads the same one", () => {
    emptyStore();
    clockState.browser = "America/New_York";
    clockState.settings = { clock: { owner: "config/constants.json", timeZone: "UTC", chosen: true } };
    const chosen = renderHome();
    expect(chosen.container.querySelector("[data-clock-proposal]")).toBeNull();
    chosen.unmount();

    clockState.settings = { clock: { owner: "config/constants.json", timeZone: "America/New_York", chosen: false } };
    expect(renderHome().container.querySelector("[data-clock-proposal]")).toBeNull();
  });
});

/** The guide stays until the first number arrives. */
describe("Home — a site still being set up", () => {
  const at = "2026-07-29T12:00:00.000Z";
  const bingSource: CardDataSource = { id: "bing-webmaster", label: "Bing Webmaster Tools", state: "needs-setup" };
  const gscSource: CardDataSource = { id: "gsc", label: "Google Search Console", state: "needs-setup" };
  const emptySeries = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };
  /** A site just added: nothing reported, nothing collected, no money. */
  function newSite(id: string, displayName: string) {
    return { ...SEEDED_ASSETS[0]!, id, displayName, status: "onboarding", pulseReceivedAt: null, firstReportAt: null,
      activeUsers: emptySeries, searchClicks: emptySeries, netByMonth: [], work: null,
      booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 }, forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
      dataSources: [gscSource, bingSource],
    };
  }
  /** The reads answered: Bing's key accepted or not, and, once this site's
   * collection was started, its daily work scheduled but not yet run, which
   * the status model reads as Collecting. */
  function bingAnswers(connected: boolean, startedFor: string | null = null) {
    const credential = {
      provider: "bing-webmaster" as const, source: "store" as const, fields: [], assetsHeld: [], missingFields: [], auth: null,
      metadata: null, keyVersion: 1, createdAt: at, updatedAt: at, lastUsedAt: at, lastOkAt: at, lastError: null,
    };
    reads.providers = {
      generatedAt: at, keyPresent: true, keyReason: null,
      blockers: [],
      providers: connected
        ? [{ provider: INTEGRATION_PROVIDERS.find((entry) => entry.id === "bing-webmaster")!, credential, assets: [] }]
        : [],
    };
    reads.health = {
      generatedAt: "2026-07-29T12:05:00.000Z", available: true, events: [],
      items: startedFor === null ? [] : [{
        id: "bing-daily", provider: "bing-webmaster", capability: "bing-daily", label: "Bing daily reports", asset: startedFor,
        detail: null, report: null, reportDate: null, state: "never-run", lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, failure: null, code: null,
        action: "Review the verified site and Bing connection.", coverage: "monitored",
      }],
    };
  }
  function steps(container: HTMLElement) {
    return [...container.querySelectorAll<HTMLElement>("[data-first-run-step]")].map((step) => ({
      state: step.getAttribute("data-first-run-state"),
      text: step.textContent,
    }));
  }

  it("ticks the added site and makes its first source's Connect the one action", () => {
    payload.assets = [newSite("journey.example", "Journey Example")];
    payload.attention = [];
    bingAnswers(false);

    const { container } = renderHome();

    expect(steps(container)).toEqual([
      { state: "done", text: "Step 1Journey Example added" },
      { state: "current", text: "Step 2Connect Bing Webmaster Tools" },
      { state: "next", text: "Step 3See your first number" },
    ]);
    expect(screen.getByRole("link", { name: "Connect Bing Webmaster Tools" }))
      .toHaveAttribute("href", "/integrations?connect=bing-webmaster&asset=journey.example");
    expect(screen.getByRole("link", { name: "See your first number" })).toHaveAttribute("href", "/assets/journey.example");
    expect(screen.getByRole("link", { name: "See your first number" }).tabIndex).toBe(0);
    expect(container.querySelector('[data-first-run-state="current"]')).toBe(container.querySelector("[data-first-run-step='2']"));
    expect(screen.queryByRole("button", { name: "Add your first site" })).toBeNull();
    expect(container.querySelector("[data-kpi-strip]")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("[data-portfolio-census]")).toBeNull();
    expect(screen.queryAllByText("Decide")).toHaveLength(0);
  });

  it("keeps Connect as the one action while the key is saved but this site is not collecting", () => {
    payload.assets = [newSite("journey.example", "Journey Example")];
    payload.attention = [];
    bingAnswers(true);

    const { container } = renderHome();

    expect(steps(container).map((step) => step.state)).toEqual(["done", "current", "next"]);
    expect(screen.getByRole("link", { name: "Connect Bing Webmaster Tools" }))
      .toHaveAttribute("href", "/integrations?connect=bing-webmaster&asset=journey.example");
  });

  it("ticks the connection and makes the first number the one action while it is collected", () => {
    payload.assets = [newSite("journey.example", "Journey Example")];
    payload.attention = [];
    bingAnswers(true, "journey.example");

    const { container } = renderHome();

    expect(steps(container).map((step) => step.state)).toEqual(["done", "done", "current"]);
    expect(steps(container)[1]!.text).toBe("Step 2Bing Webmaster Tools connected");
    const number = screen.getByRole("link", { name: "See your first number" });
    expect(number).toHaveAttribute("href", "/assets/journey.example");
    expect(number.closest("[data-first-run-step]")).toHaveAttribute("data-first-run-state", "current");
    expect(container.querySelector("[data-kpi-strip]")).toBeNull();
  });

  it("follows the newest of several sites still being set up", () => {
    payload.assets = [newSite("first.example", "First Example"), newSite("second.example", "Second Example")];
    payload.attention = [];
    bingAnswers(false);

    const { container } = renderHome();

    expect(steps(container)[0]!.text).toBe("Step 1Second Example added");
    expect(screen.getByRole("link", { name: "Connect Bing Webmaster Tools" }))
      .toHaveAttribute("href", "/integrations?connect=bing-webmaster&asset=second.example");
  });

  it.each([
    ["a day of search clicks", { searchClicks: { ...emptySeries, series: [{ t: "2026-07-28", v: 21 }] } }],
    ["a day of users", { activeUsers: { ...emptySeries, series: [{ t: "2026-07-28", v: 9 }] } }],
    ["a nightly report", { firstReportAt: at, pulseReceivedAt: at }],
    ["money on the ledger", { forecast: { currency: 'USD', revenue: 12, cost: 0, net: 12 } }],
    ["a recorded collection", { dataSources: [{ ...bingSource, state: "live" as const, verification: { kind: "collection-success" as const, laneId: "bing-webmaster" } }] }],
  ])("gives way to the dashboard at the first number: %s", (_name, number) => {
    payload.assets = [newSite("first.example", "First Example"), { ...newSite("second.example", "Second Example"), ...number }];
    bingAnswers(true);

    const { container } = renderHome();

    expect(container.querySelector("[data-first-run]")).toBeNull();
    expect(container.querySelector("[data-home-brief]")).not.toBeNull();
    expect([...container.querySelectorAll("[data-portfolio-row]")].map((row) => row.getAttribute("data-portfolio-row")))
      .toEqual(["first.example", "second.example"]);
  });
});

// Missing core hub readings are unknown, never an absent capability or all-clear.
describe("Home and the Wall with an unread core task hub", () => {
  afterEach(resetTaskSourceMock);

  it("keeps the brief and an unread Decide visible before any project has been read", () => {
    const prior = payload.operator;
    payload.operator = null;
    taskSourceMock.connected = null;
    withSecondSite();
    const { container } = renderHome();
    payload.operator = prior;

    expect(container.querySelector("[data-home-brief]")).not.toBeNull();
    expect(panelFor("Decide")).toHaveTextContent("Reading your tasks…");
    expect(screen.getByRole("link", { name: "All tasks →" })).toHaveAttribute("href", "/tasks");
  });

  it("shows the Wall's tasks as unknown while keeping specific non-task concerns covered", () => {
    const prior = payload.operator;
    payload.operator = null;
    payload.attention = [];
    const { container } = renderWall();
    payload.operator = prior;

    // The inbox is unread, so the work chart's waiting figure says so; the
    // site's own snapshot still counts its work.
    const waiting = container.querySelector('[data-wall-work] [data-material-condition~="human-gates"]')!;
    expect(waiting).toHaveTextContent("not read");
    expect(waiting.textContent).not.toMatch(/\d/);
    // Every non-task concern is still evaluated, and calm.
    const timeline = container.querySelector("[data-wall-timeline]")!;
    expect(timeline.getAttribute("data-material-condition")?.split(" ")).toEqual([
      "open-flags", "rollback-failure", "signal-freshness", "os-runner-health", "scheduled-lane-health", "budget-guardrail",
    ]);
    expect(timeline.querySelector("[data-timeline-status]")).toHaveTextContent("Nothing broken");
    expect(container.querySelector('[data-flow-node="decide"]')).toHaveTextContent("not read");
    expect(container.textContent).not.toContain("0 urgent");
  });
});

/** With one site the portfolio is that site, so Home draws the site's own
 * strip and chart under the money, never a site list of one row. */
describe("Home — one site leads with its own numbers", () => {
  it("draws the site's own strip and chart under the money, and no one-row site list", () => {
    detail.data = viewOf(everyTabPayload(), "overview");
    const { container } = renderHome();

    expect(detail.asked).toContain("meadow.example:overview");
    const hero = container.querySelector<HTMLElement>("[data-surface-hero]")!;
    expect(hero.closest("[data-home-brief]")).not.toBeNull();
    const lead = container.querySelector<HTMLElement>('[data-one-site-lead="meadow.example"]')!;
    expect(hero.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const traffic = within(lead).getByRole("region", { name: "Traffic · last 28 days" });
    expect(traffic.querySelectorAll("[data-kpi]")).toHaveLength(4);
    expect(traffic.querySelector("[data-hero-chart]")).toHaveTextContent("Active users · daily");
    expect(within(lead).getByRole("link", { name: "Meadow Board →" })).toHaveAttribute("href", "/assets/meadow.example");

    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("[data-portfolio-rows]")).toBeNull();
    expect(screen.queryByRole("link", { name: "All sites →" })).toBeNull();
    expect(container.querySelector("[data-portfolio-census]")!.textContent).toBe("updated 5m ago");
    expect(container.textContent).not.toMatch(/portfolio|1 site/i);
    expect(panelFor("Decide")).toBeInTheDocument();
  });

  it("leads with the one site's revenue when revenue is what it has", () => {
    const body = everyTabPayload();
    const empty = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };
    body.performance = { ...body.performance, activeUsers: empty, sessions: empty,
      webSearchClicks: { google: empty, bing: empty }, webSearchImpressions: { google: empty, bing: empty } };
    body.dailyRevenue = { from: "2026-05-01", to: "2026-07-28", reportedThrough: "2026-07-28",
      days: [{ date: "2026-07-27", amountMinor: 400 }, { date: "2026-07-28", amountMinor: 600 }] };
    detail.data = viewOf(body, "overview");
    const { container } = renderHome();
    const lead = container.querySelector<HTMLElement>('[data-one-site-lead="meadow.example"]')!;
    const revenue = within(lead).getByRole("region", { name: "Daily revenue" });
    expect(revenue).toHaveTextContent("$10.00");
    expect(within(revenue).getByRole("link", { name: "Meadow Board →" })).toHaveAttribute("href", "/assets/meadow.example");
    expect(within(lead).queryByRole("region", { name: "Traffic · last 28 days" })).toBeNull();
  });

  it("holds the site's place, with its state and its link, until its numbers arrive", () => {
    const { container } = renderHome();
    const lead = container.querySelector<HTMLElement>('[data-one-site-lead="meadow.example"]')!;
    expect(lead.querySelector("[data-kpi]")).toBeNull();
    expect(within(lead).getByRole("link", { name: "Meadow Board →" })).toBeInTheDocument();
    expect(container.querySelector("table")).toBeNull();
  });

  it("lists the sites, and reads no single site, from two sites", () => {
    withSecondSite();
    detail.data = viewOf(everyTabPayload(), "overview");
    const { container } = renderHome();

    expect(container.querySelector("[data-one-site-lead]")).toBeNull();
    expect(detail.asked).toEqual([]);
    expect(container.querySelectorAll("[data-portfolio-rows] [data-portfolio-row]")).toHaveLength(2);
    expect(screen.queryByRole("region", { name: "Traffic · last 28 days" })).toBeNull();
    expect(container.querySelector("[data-home-brief] [data-surface-hero]")).not.toBeNull();
  });
});

describe("Home — the answer, the money and what is broken", () => {
  const answerLine = (container: HTMLElement) => container.querySelector("[data-home-answer] h2");
  const incidentKeys = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-incident-list] [data-incident]")].map((row) => row.getAttribute("data-incident"));

  it("opens with the greeting and one sentence on the month and what is broken, then the month's money as the lead", () => {
    withSecondSite();
    const { container } = renderHome();

    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(container.querySelector("[data-portfolio-census]")!.textContent).toContain("2 sites · updated");
    expect(container.querySelector("[data-portfolio-census]")!.textContent).not.toMatch(/portfolio/i);

    const answer = container.querySelector<HTMLElement>("[data-home-answer]")!;
    expect(answer.querySelector("[data-brief-since]")).toHaveTextContent(/^Good (morning|afternoon|evening) · since .+ · nothing changed$/);
    expect(answerLine(container)).toHaveTextContent("July so far $45 est. Nothing is broken.");

    // The audit measures the lead's bottom edge against 900px.
    const hero = container.querySelector<HTMLElement>("[data-surface-hero]")!;
    expect(answer.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const money = hero.querySelector<HTMLElement>("[data-money-hero]")!;
    expect(money).toHaveAccessibleName("Revenue, July so far");
    // The month's ledger rows are an estimate, and the figure says so.
    expect(money.querySelector("[data-money-figure]")).toHaveTextContent("$45est.");
    expect(container.querySelector('[data-stat="Revenue, yesterday"]')).toHaveAttribute("href", "/financials");
    expect(container.querySelector('[data-stat="Visitors, yesterday"]')).toHaveAttribute("href", "/assets");

    expect(container.querySelector("[data-kpi-strip]")).toBeNull();
    expect(container.querySelector("[data-about]")).toBeNull();
    expect(container.textContent).not.toMatch(/\bfresh\b|\bjobs?\b|snapshot|captured in preview/i);

    // The page ends on the last day drawn on a time axis.
    const regions = [...container.querySelectorAll("[data-home-brief] section[aria-label]")];
    expect(regions.at(-1)).toHaveAttribute("data-home-timeline");

    expect(screen.getByRole("link", { name: "All alerts →" })).toHaveAttribute("href", "/alerts");
    expect(screen.getByRole("link", { name: "All tasks →" })).toHaveAttribute("href", "/tasks");
    expect(screen.getByRole("link", { name: "All sites →" })).toHaveAttribute("href", "/assets");
  });

  // On the first days of a month the payload falls back to the latest month
  // that has ledger rows, and the money names that month.
  it("names the fallback month on the money hero and in the answer when the newest ledger rows are not this month's", () => {
    payload.portfolio = { ...POPULATED_PORTFOLIO, period: "2026-08", periodIsCurrent: false };
    const { container } = renderHome();
    expect(container.querySelector("[data-money-hero]")).toHaveAccessibleName("Revenue, August so far");
    expect(answerLine(container)).toHaveTextContent(/^August so far \$45 est\./);
    expect(screen.queryByText("August 2026 · latest month on the ledger")).toBeNull();
  });

  it("carries no clock, countdown, meeting, asset card or attention table", () => {
    const { container } = renderHome();
    expect(screen.queryByText("Local time")).toBeNull();
    expect(screen.queryByText("Team offsite - August 2026")).toBeNull();
    expect(screen.queryByRole("button", { name: "Configure" })).toBeNull();
    expect(container.querySelector("[data-strip-meeting]")).toBeNull();
    expect(container.querySelector("[data-property-grid]")).toBeNull();
    expect(container.querySelector("[data-property-card]")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark alert read" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve alert" })).toBeNull();
  });

  it("counts backups failing two nights as one broken thing, drawn in the System row that opens System health", () => {
    const now = Date.parse("2026-07-29T12:05:00.000Z");
    const backups = (container: HTMLElement) => container.querySelector('[data-health-cell="system:backups"]')!;

    payload.system = { ...SEEDED_SYSTEM, scheduledLanes: [backupLane(now, 1, backupNight(now, 1))] };
    const oneNight = renderHome();
    expect(answerLine(oneNight.container)).toHaveTextContent(/Nothing is broken\.$/);
    expect(backups(oneNight.container)).toHaveAttribute("data-state", "overdue");
    oneNight.unmount();

    payload.system = { ...SEEDED_SYSTEM, scheduledLanes: [backupLane(now, 12, backupNight(now, 12))] };
    const { container } = renderHome();
    expect(answerLine(container)).toHaveTextContent(/1 thing is broken\.$/);
    expect(backups(container)).toHaveAttribute("data-state", "failing");
    const link = backups(container).querySelector("a")!;
    expect(link).toHaveAttribute("href", "/health");
    expect(link).toHaveAccessibleName("System · Backups · Failing since 11d ago · last good copy 12d ago");
    // The grid draws it, so the problems beside the grid do not repeat it.
    expect(incidentKeys(container)).not.toContain("system-backups-failing");
  });

  it("ranks errors above warnings, newest first, and folds what has been open over a week into one line", () => {
    payload.attention = Array.from({ length: 7 }, (_, index) =>
      alert({
        id: index + 1,
        message: `Alert ${index + 1}`,
        severity: index % 2 === 0 ? "error" : "warn",
        firedAt: `2026-07-2${index + 1}T09:00:00.000Z`,
        firstFiredAt: `2026-07-2${index + 1}T09:00:00.000Z`,
      }),
    );

    const { container } = renderHome();
    expect(answerLine(container)).toHaveTextContent("4 things are broken, 3 at risk.");
    const list = container.querySelector<HTMLElement>("[data-incident-list]")!;
    expect(list).toHaveTextContent("4 broken3 at risk");
    expect(incidentKeys(container)).toEqual(["alert-7", "alert-5", "alert-3", "alert-6", "alert-4"]);
    expect([...list.querySelectorAll("[data-incident]")].map((row) => row.getAttribute("data-state")))
      .toEqual(["error", "error", "error", "warn", "warn"]);
    const first = list.querySelector('[data-incident="alert-7"] a')!;
    expect(first).toHaveAttribute("href", "/assets/meadow.example");
    expect(first).toHaveAccessibleName(/^Meadow Board · Alert 7 · since 2d ago$/);

    // Alerts 1 and 2 have been open over a week: one quiet line, opened in place.
    const fold = within(list).getByRole("button", { name: /^Open for over a week · 2/ });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(fold).toHaveTextContent("Alert 1 on Meadow Board · Alert 2 on Meadow Board");
    fireEvent.click(fold);
    expect(incidentKeys(container)).toEqual(["alert-7", "alert-5", "alert-3", "alert-6", "alert-4", "alert-1", "alert-2"]);
  });

  it("draws a failing source in the grid where it lives, and does not repeat it in the problems list", () => {
    googleAnswers([{ capability: "ga4-daily", state: "failing" }]);
    const ga4: CardDataSource = { id: "ga4", label: "Google Analytics", state: "live", observedAt: "2026-07-29T12:00:00Z", verification: { kind: "collection-success", laneId: "ga4" } };
    payload.assets = [{ ...SEEDED_ASSETS[0]!, dataSources: [ga4] }];
    payload.attention = [alert({ id: 5, severity: "warn" })];

    const { container } = renderHome();
    const cell = container.querySelector<HTMLElement>('[data-health-cell="meadow.example:ga4"]')!;
    expect(cell).toHaveAttribute("data-state", "failing");
    expect(within(cell).getByRole("link")).toHaveAccessibleName(/^Meadow Board · Google Analytics · Failing/);
    expect(within(cell).getByRole("link")).toHaveAttribute("href", "/assets/meadow.example?tab=sources");
    const headline = container.querySelector("[data-health-headline]")!;
    expect(headline).toHaveAttribute("data-health-headline", "failing");
    expect(headline).toHaveTextContent("Google Analytics on Meadow Board");

    expect(incidentKeys(container)).toEqual(["alert-5"]);
    expect(answerLine(container)).toHaveTextContent("1 thing is broken, 1 at risk.");
  });

  /** A site with no number yet opens on its Data sources, as the sidebar sends it. */
  it("opens a site with no number yet on its Data sources from its problem row", () => {
    const empty = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };
    payload.assets = [...SEEDED_ASSETS, { ...SEEDED_ASSETS[0]!, id: "fresh.example", displayName: "Fresh Example",
      pulseReceivedAt: null, firstReportAt: null, activeUsers: empty, searchClicks: empty,
      netByMonth: [], booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 }, forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
      dailyRevenue: undefined, dataSources: [], work: null,
    }];
    payload.attention = [alert({ id: 4, asset: "fresh.example", assetDisplayName: "Fresh Example" })];

    const { container } = renderHome();
    expect(container.querySelector('[data-incident="alert-4"] a')).toHaveAttribute("href", "/assets/fresh.example/sources");
  });

  /** One fact about four sites is one problem, and the way through is `/alerts`. */
  it("lists sites that have never reported as ONE problem, pointing at Alerts", () => {
    payload.attention = [
      alert({
        id: 31, asset: "ferns.example", assetDisplayName: "Fern Index", severity: "error",
        ruleId: "ingest-freshness", ruleInputs: { rule: "ingest-freshness", state: "never-reported" },
        occurrences: 4, firstFiredAt: "2026-07-05T09:00:00.000Z",
        members: [
          { id: 31, asset: "ferns.example", assetDisplayName: "Fern Index", firedAt: "2026-07-05T09:00:00.000Z" },
          { id: 32, asset: "puffin.example", assetDisplayName: "Puffin Post", firedAt: "2026-07-06T09:00:00.000Z" },
          { id: 33, asset: "acorn.example.net", assetDisplayName: "Acorn Atlas", firedAt: "2026-07-07T09:00:00.000Z" },
          { id: 34, asset: "pebble.example", assetDisplayName: "Pebble Works", firedAt: "2026-07-08T09:00:00.000Z" },
        ],
      }),
    ];

    const { container } = renderHome();
    const list = container.querySelector<HTMLElement>("[data-incident-list]")!;
    // Open since July 5th, so it waits in the fold for what is over a week old.
    fireEvent.click(within(list).getByRole("button", { name: /^Open for over a week · 1/ }));
    const rows = list.querySelectorAll<HTMLElement>("[data-incident]");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Four sites have no nightly reports");
    expect(rows[0]!.textContent).not.toContain("recurred");
    expect(rows[0]!.querySelector("a")).toHaveAttribute("href", "/alerts");
  });

  it("puts yesterday's visitors beside the money, against the same day a week before", () => {
    const days = Array.from({ length: 14 }, (_, index) => ({ t: `2026-07-${String(15 + index).padStart(2, "0")}`, v: index === 13 ? 130 : 100 }));
    payload.assets = [{ ...SEEDED_ASSETS[0]!, activeUsers: { series: days, provisionalFrom: "2026-07-29", collectedAt: null, timeZoneChanges: [] } }];

    const up = renderHome();
    const tile = up.container.querySelector<HTMLElement>('[data-stat="Visitors, yesterday"]')!;
    expect(tile.querySelector("[data-stat-figure]")).toHaveTextContent("130");
    expect(within(tile).getByLabelText("30% up vs a week before")).toBeInTheDocument();
    expect(within(tile).getByRole("img", { name: /^Visitors a day, last two weeks, Jul 15 to Jul 28/ })).toBeInTheDocument();
    expect(tile).toHaveTextContent(/as of Jul 28/);
    up.unmount();

    payload.assets = [{ ...SEEDED_ASSETS[0]!, activeUsers: { series: days.map((day, index) => ({ ...day, v: index === 13 ? 70 : 100 })), provisionalFrom: "2026-07-29", collectedAt: null, timeZoneChanges: [] } }];
    const down = renderHome();
    const fell = down.container.querySelector<HTMLElement>('[data-stat="Visitors, yesterday"]')!;
    expect(fell.querySelector("[data-stat-figure]")).toHaveTextContent("70");
    expect(within(fell).getByLabelText("30% down vs a week before")).toBeInTheDocument();
  });

  it("gives every site one row with its health word, in seed order, that opens its page", () => {
    withSecondSite();
    payload.attention = [alert({ id: 9, severity: "error" })];

    const { container } = renderHome();
    const rows = [...container.querySelectorAll<HTMLElement>("[data-portfolio-row]")];
    expect(rows.map((row) => row.getAttribute("data-portfolio-row"))).toEqual(["meadow.example", "second.example"]);
    expect(rows[0]).toHaveTextContent("Off track");
    expect(rows[1]).toHaveTextContent("On track");
    expect(within(rows[0]!).getByRole("link", { name: /Meadow Board/ })).toHaveAttribute("href", "/assets/meadow.example");
    expect(rows[0]).toHaveTextContent("no visitors reported");
    // The grid keeps the same order, with the System last.
    expect([...container.querySelectorAll("[data-health-row]")].map((row) => row.getAttribute("data-health-row")))
      .toEqual(["meadow.example", "second.example", "system"]);
    expect(container.textContent).not.toContain("Automation enabled");
    expect(container.textContent).not.toContain("12 open");
  });

  // A retired site is watched by nobody: no row until its switch is on, then
  // a row that reads Retired, and never a problem counted in the answer.
  it("leaves a retired site out of its rows and its counts, and reads it Retired once its switch is on", () => {
    withSecondSite();
    payload.assets = [...payload.assets, { ...SEEDED_ASSETS[0]!, id: "old.example", displayName: "Old Example", status: "retired", work: null }];
    payload.attention = [alert({ id: 9, severity: "error" }), alert({ id: 10, severity: "error", asset: "old.example", assetDisplayName: "Old Example" })];
    const rows = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-portfolio-row]")];

    const hidden = renderHome();
    expect(rows(hidden.container).map((row) => row.getAttribute("data-portfolio-row"))).toEqual(["meadow.example", "second.example"]);
    expect(incidentKeys(hidden.container)).toEqual(["alert-9"]);
    expect(answerLine(hidden.container)).toHaveTextContent("1 thing is broken.");
    hidden.unmount();

    payload.dashboard = { ...SEEDED_DASHBOARD, sites: { "old.example": { list: true } } };
    const shown = renderHome();
    const old = rows(shown.container).find((row) => row.getAttribute("data-portfolio-row") === "old.example")!;
    expect(old).toHaveTextContent("Retired");
    expect(old).not.toHaveTextContent("Off track");
    expect(answerLine(shown.container)).toHaveTextContent("1 thing is broken.");
  });

  // Hiding a site from Home takes its rows away, never its problems: a source
  // failing on a hidden site is listed, because no grid row draws it.
  it("leaves a site whose Home and Sites list switch is off out of its rows, and still lists its problems", () => {
    googleAnswers([{ capability: "ga4-daily", state: "failing" }]);
    const ga4: CardDataSource = { id: "ga4", label: "Google Analytics", state: "live", observedAt: "2026-07-29T12:00:00Z", verification: { kind: "collection-success", laneId: "ga4" } };
    withSecondSite();
    payload.assets = [{ ...payload.assets[0]!, dataSources: [ga4] }, payload.assets[1]!];
    payload.attention = [alert({ id: 9, severity: "error" })];
    payload.dashboard = { ...SEEDED_DASHBOARD, sites: { "meadow.example": { list: false } } };

    const { container } = renderHome();
    expect([...container.querySelectorAll("[data-portfolio-row]")].map((row) => row.getAttribute("data-portfolio-row"))).toEqual(["second.example"]);
    expect([...container.querySelectorAll("[data-health-row]")].map((row) => row.getAttribute("data-health-row"))).toEqual(["second.example", "system"]);
    expect(container.querySelector('[data-lane="meadow.example"]')).toBeNull();
    expect(incidentKeys(container)).toEqual(expect.arrayContaining(["alert-9", expect.stringMatching(/^source-/u)]));
    expect(answerLine(container)).toHaveTextContent("2 things are broken.");
  });
});

describe("Home — Decide", () => {
  it("puts an open gate above a higher-priority ask, with its verb on the row", () => {
    workState.data = workPayload([
      project("Meadow Board", [waiting({ id: "md-9k1", priority: 0, title: "Top-priority ask" })]),
      project("System", [waiting({ id: "ro-3z7", priority: 3, issueType: "gate", title: "Approve the spend cap" })]),
    ]);

    renderHome();

    const rows = within(panelFor("Decide")).getAllByRole("listitem");
    // A gate holds work out of the ready queue, so it leads regardless of its
    // own priority band.
    expect(rows.map((row) => row.getAttribute("data-queue-item"))).toEqual(["ro-3z7", "md-9k1"]);
    expect(rows[0]).toHaveTextContent("Approve the spend cap");
    expect(within(rows[0]!).getByLabelText("Approval")).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("System");
    expect(rows[0]!.textContent).not.toContain("· gate");
    expect(rows[0]!.textContent).not.toContain("ro-3z7");
    expect(within(rows[0]!).getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(within(rows[0]!).getByRole("link")).toHaveAttribute("href", "/tasks/ro-3z7");
    expect(rows[1]).toHaveTextContent("Top-priority ask");
    expect(within(rows[1]!).getByLabelText("Question")).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("button", { name: "Answer" })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("button", { name: "Close as" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All tasks →" })).toHaveAttribute("href", "/tasks");
  });

  it("tells an empty inbox apart from an inbox it has never seen", () => {
    workState.data = workPayload([project("Meadow Board", [])]);
    const clear = renderHome();
    expect(screen.getByText("Nothing to decide.")).toBeInTheDocument();
    clear.unmount();

    workState.data = workPayload([project("Meadow Board", [])], null);
    renderHome();
    expect(screen.getByText("No tasks read yet.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing to decide.")).toBeNull();
  });

  it("counts the whole queue, shows four rows, and discloses the rest in place", () => {
    const capped = project("Meadow Board", Array.from({ length: 10 }, (_, index) =>
      waiting({ id: `md-${index}`, title: `Request ${index + 1}` }),
    ));
    capped.counts.waiting = 24;
    workState.data = workPayload([capped]);
    renderHome();
    const panel = panelFor("Decide");
    expect(panel).toHaveTextContent(/24\s*for you to decide/);
    expect(within(panel).getAllByRole("listitem")).toHaveLength(4);
    fireEvent.click(within(panel).getByRole("button", { name: "Show 6 more" }));
    expect(within(panel).getAllByRole("listitem")).toHaveLength(10);
    expect(within(panel).getByRole("link", { name: "All tasks →" })).toHaveAttribute("href", "/tasks");
  });

  it("names the wait beside each row, and nothing about the read itself", () => {
    workState.data = workPayload([project("Meadow Board", [waiting({ updatedAt: "2026-07-01T12:05:00.000Z" })])]);
    renderHome();
    const panel = panelFor("Decide");
    expect(panel).not.toHaveTextContent("Task status read");
    expect(panel).not.toHaveTextContent("captured in preview");
    expect(panel.querySelector("button button, a button")).toBeNull();
    const row = within(panel).getByRole("listitem");
    expect(within(row).getByLabelText("waiting 28d")).toHaveTextContent("28d");
  });

  it.each(["failed project", "unmeasured inbox", "no projects", "stale snapshot", "failed refresh"])(
    "does not claim a clear inbox after a %s",
    (failure) => {
      const emptyProject = project("Meadow Board", []);
      if (failure === "failed project") emptyProject.ok = false;
      if (failure === "unmeasured inbox") emptyProject.counts.waiting = null;
      workState.data = workPayload(failure === "no projects" ? [] : [emptyProject],
        failure === "stale snapshot" ? "2026-07-29T11:00:00.000Z" : undefined);
      workState.isError = failure === "failed refresh";
      renderHome();
      const panel = panelFor("Decide");
      expect(panel).not.toHaveTextContent("Nothing to decide.");
      expect(panel).toHaveTextContent(/not fully read|unknown/);
      expect(panel.textContent!.match(/outdated/g)?.length ?? 0).toBeLessThanOrEqual(1);
    },
  );

  it("names a stale count outdated, once, beside the count", () => {
    workState.data = workPayload([project("Meadow Board", [waiting()])], "2026-07-29T11:00:00.000Z");
    renderHome();
    const panel = panelFor("Decide");
    expect(panel).toHaveTextContent(/1\s*for you to decide · oldest 1h · outdated/);
    expect(panel.textContent!.match(/outdated/g)).toHaveLength(1);
  });

  it("states known totals as a lower bound when one project is unreadable", () => {
    const known = project("Meadow Board", [waiting()]);
    known.counts.waiting = 12;
    const failed = project("System", []);
    failed.ok = false;
    failed.counts.waiting = 99;
    workState.data = workPayload([known, failed]);
    renderHome();
    const panel = panelFor("Decide");
    expect(panel).toHaveTextContent(/12\s*for you to decide · oldest 1h · partial read/);
    expect(panel).not.toHaveTextContent("111");
  });

  it("keeps an authoritative nonzero queue visible even when no rows were captured", () => {
    const emptyPreview = project("Meadow Board", []);
    emptyPreview.counts.waiting = 12;
    workState.data = workPayload([emptyPreview]);
    renderHome();
    const panel = panelFor("Decide");
    expect(panel).toHaveTextContent(/12\s*for you to decide/);
    expect(panel).toHaveTextContent("No request details read.");
    expect(panel).not.toHaveTextContent("Nothing to decide.");
  });

  it("recovers from a failed initial read to an evidenced empty inbox", () => {
    workState.isError = true;
    const view = renderHome();
    expect(panelFor("Decide")).toHaveTextContent("Could not read your tasks.");
    workState.isError = false;
    workState.data = workPayload([project("Meadow Board", [])]);
    view.rerender(homeTree());
    expect(panelFor("Decide")).toHaveTextContent("Nothing to decide.");
    expect(panelFor("Decide")).not.toHaveTextContent("Could not read");
  });

  it("gives every row the ask face — warn at every priority, a gate's triangle", () => {
    workState.data = workPayload([
      project("System", [waiting({ id: "ro-3z7", priority: 3, issueType: "gate", title: "Approve the cap" })]),
      project("Meadow Board", [
        waiting({ id: "md-9k1", priority: 0, title: "Top-priority ask" }),
        waiting({ id: "md-2b4", priority: 1, title: "High-priority ask" }),
        waiting({ id: "md-7c3", priority: 2, title: "Default-priority ask" }),
      ]),
    ]);

    renderHome();

    const rows = within(panelFor("Decide")).getAllByRole("listitem");
    const glyphs = rows.map((row) => row.querySelector("svg[aria-label]")!);
    // A task's priority is not a severity: priority is the order, not the colour.
    expect(glyphs.map((glyph) => glyph.classList.contains("text-warn"))).toEqual([true, true, true, true]);
    // Never colour-only: a gate holding other work is a triangle, an ask a
    // question mark, and each says which.
    expect(glyphs.map((glyph) => glyph.getAttribute("aria-label"))).toEqual(["Approval", "Question", "Question", "Question"]);
    expect(within(rows[0]!).getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(within(rows[3]!).queryByRole("button", { name: "Approve" })).toBeNull();
  });
});

describe("the nav's site dot names its open alerts, never a bare severity", () => {
  it("reads '1 open error alert' and '2 open warning alerts' in its name and hover", () => {
    const saved = payload.assets;
    const [site] = saved;
    payload.assets = [
      { ...site!, id: "alpha.example", displayName: "Alpha", worstSeverity: "error", openError: 1, openWarn: 0 },
      { ...site!, id: "beta.example", displayName: "Beta", worstSeverity: "warn", openError: 0, openWarn: 2 },
      { ...site!, id: "gamma.example", displayName: "Gamma", worstSeverity: null, openError: 0, openWarn: 0 },
    ];
    try {
      const { container } = render(
        <MemoryRouter>
          <Sidebar theme="dark" onToggleTheme={() => {}} />
        </MemoryRouter>,
      );
      const dot = (id: string) => container.querySelector(`[data-nav-asset="${id}"] [role="img"]`);
      expect(dot("alpha.example")).toHaveAccessibleName("1 open error alert");
      expect(dot("alpha.example")).toHaveAttribute("title", "1 open error alert");
      expect(dot("beta.example")).toHaveAccessibleName("2 open warning alerts");
      expect(dot("beta.example")).toHaveAttribute("title", "2 open warning alerts");
      expect(dot("gamma.example")).toBeNull();
      expect(container.querySelector('[data-nav-asset="alpha.example"]')!.textContent).toBe("Alpha");
    } finally {
      payload.assets = saved;
    }
  });
});

describe("Home and Wall phase scoping", () => {
  it("sends the desk to Health, the page's own name and path", () => {
    // That nav is the shell's sidebar rather than Home's own header, and Home
    // must not carry a second copy of it.
    const shell = render(
      <MemoryRouter>
        <Sidebar theme="dark" onToggleTheme={() => {}} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "System health" })).toHaveAttribute("href", "/health");
    expect(screen.queryByRole("link", { name: "Data sources" })).toBeNull();
    shell.unmount();

    renderHome();
    expect(screen.queryByRole("link", { name: "System health" })).toBeNull();
    expect(screen.queryByRole("link", { name: "TV dashboard" })).toBeNull();
  });

  // With nothing saved, the route draws the strip and the loop, then the last
  // 24 hours over the site rows beside revenue over the work, and no header
  // row above it.
  it("draws the default layout when nothing is saved: the strip and the loop, the last 24 hours over the sites beside revenue over the work", () => {
    const { container } = renderWall();

    // Each widget sits in its slot, which is no box at the TV's width and
    // places it in the one column below it.
    const strip = container.querySelector("[data-wall-row='strip'] > [data-wall-slot] > [data-wall-strip]");
    expect(strip).not.toBeNull();
    const body = container.querySelector("[data-wall-row='body']")!;
    expect(body).toHaveAttribute("data-wall-row-height", "fill");
    expect(container.querySelector("[data-wall-row='loop'] > [data-wall-slot] > [data-wall-loop]")).not.toBeNull();
    const business = body.querySelector(":scope > [data-wall-column='business']")!;
    const side = body.querySelector(":scope > [data-wall-column='side']")!;
    expect(business.querySelector("[data-wall-row='timeline'] > [data-wall-slot] > [data-wall-timeline]")).not.toBeNull();
    expect(business.querySelector("[data-wall-row='sites'] > [data-wall-slot] > [data-wall-sites]")).not.toBeNull();
    expect(side.querySelector("[data-wall-row='money'] > [data-wall-slot] > [data-wall-revenue]")).not.toBeNull();
    expect(side.querySelector("[data-wall-row='work'] > [data-wall-slot] > [data-wall-work]")).not.toBeNull();
    // Needs attention and the feed stay in the library, off the default.
    expect(container.querySelector("[data-wall-needs], [data-wall-feed]")).toBeNull();
    expect(strip!.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip!.textContent).toContain("Team offsite - August 2026");
    expect(strip!.querySelector("[data-strip-meeting-distance]")).toHaveTextContent("25M left");
    expect(strip!.querySelector("[data-strip-meeting-cue]")).toHaveTextContent("Now");
    expect(strip!.querySelector("[data-strip-clock-group]")).not.toBeNull();
    expect(strip!.querySelector("[data-strip-agenda]")).not.toBeNull();
    expect(strip!.querySelector("[data-strip-countdown-value]")).not.toBeNull();
    expect(strip!.querySelector("[data-system-state]")).toBeNull();
    expect(business.querySelector("[data-timeline-status]")).toHaveTextContent("Nothing broken");
    expect(container.querySelector(".wall-root")).toHaveClass("md:px-wall-inset-x", "md:py-wall-inset-y");
    expect(screen.queryByRole("button", { name: "Configure" })).not.toBeInTheDocument();
  });

  it("draws no header row: no Tasks legend, no Integrations link, no refresh age while polls succeed", () => {
    const { container } = renderWall();

    expect(container.querySelector("[data-wall-header]")).toBeNull();
    expect(container.querySelector("[data-work-flow-legend]")).toBeNull();
    // The work chart is the Wall's one task surface, in its own region.
    expect(container.querySelectorAll("[data-work-flow]")).toHaveLength(1);
    expect(container.querySelector("[data-work-flow]")!.closest("[data-wall-work]")).not.toBeNull();
    expect(container.textContent).not.toMatch(/Integrations:/);
    expect(container.textContent).not.toMatch(/View refreshed|Refreshed .* ago/);
    expect(container.querySelector("[data-strip-held]")).toBeNull();
    expect(screen.queryByText("Local time")).toBeNull();
    expect(container.querySelector("[data-attention-rail]")).toBeNull();
    expect(container.querySelector("[data-system-posture]")).toBeNull();
    expect(screen.queryByText("Monthly net")).toBeNull();
    expect(container.querySelectorAll('[data-widget-shell="frameless"]')).toHaveLength(0);
  });

  it("cannot call the Wall calm while urgent human work exists", () => {
    const prior = payload.operator;
    payload.operator = {
      waiting: 12,
      urgent: 4,
      measuredProjects: 1,
      urgentMeasuredProjects: 1,
      projectCount: 1,
      capturedAt: "2026-07-29T12:04:50.000Z",
    };
    const { container } = renderWall();
    payload.operator = prior;

    const waiting = container.querySelector('[data-wall-work] [data-material-condition~="human-gates"]')!;
    expect(waiting).toHaveTextContent("12");
    expect(waiting).toHaveTextContent("4 urgent");
    const decide = container.querySelector('[data-flow-node="decide"]')!;
    expect(decide).toHaveAttribute("data-state", "warn");
    expect(decide).toHaveTextContent("for you to decide · 4 urgent");
  });

  it("gives the TV one link, Home, on the strip's brand, and no controls", () => {
    const { container } = renderWall();

    const home = screen.getByRole("link", { name: "NoticeOS" });
    expect(home).toHaveAttribute("href", "/");
    expect(home.closest("[data-wall-strip]")).not.toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  /** Absence is the render for an asset with no tracked SERP panel. Asserted
   * at route level because that is where a "nothing to review" placeholder
   * would appear on every card. */
  it("leaves no trace of a panel review on an asset that has no panel", () => {
    for (const Route of [HomeRoute, WallRoute]) {
      const { container, unmount } = render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <Route />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(container.querySelector("[data-panel-review]")).toBeNull();
      expect(container.querySelector('[aria-label*="SERP panel"]')).toBeNull();
      expect(container.textContent).not.toContain("SERP panel");
      unmount();
    }
  });

  it("puts the work on the Wall as a chart with no way into the tasks, and leaves the tasks themselves to the desk", () => {
    const wall = renderWall();
    // The work chart: the site's project as a row, with its counts.
    const work = wall.container.querySelector("[data-wall-work] [data-work-flow]")!;
    expect(work).not.toBeNull();
    expect([...work.querySelectorAll("[data-work-row]")].map((row) => row.getAttribute("data-work-row"))).toEqual(["meadow.example"]);
    expect(work.querySelector('[data-work-row="meadow.example"]')).toHaveAccessibleName(/2 in progress, 1 blocked/u);
    // Counts only: no task's own words, and nothing to press through to them.
    expect(wall.container.textContent).not.toContain("Active bet");
    expect(wall.container.textContent).not.toContain("Homepage answer-card experiment");
    expect(wall.container.querySelector('a[href="/tasks"], a[href="/work"]')).toBeNull();
    expect(wall.container.querySelector("[data-wall-work] a, [data-wall-work] button")).toBeNull();
    wall.unmount();

    withSecondSite();
    const home = renderHome();
    expect(home.container.querySelector('a[href="/tasks"]')).not.toBeNull();
    expect(home.container.querySelector('a[href="/work"]')).toBeNull();
  });
});

/** A month with no ledger row is one quiet line on the TV while the rest of
 * the Wall draws; on Home the money gives its place to the visitors. */
describe("Portfolio card with no ledger row at all", () => {
  const nothing: PortfolioBand = { netTrendCurrency: 'USD', netTrendAllCurrency: 'USD',
    period: "2026-07",
    periodIsCurrent: true,
    booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
    forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
    netTrend: [],
    netTrendAll: [],
    trendGranularity: "monthly",
    bookedDelta: null,
    residue: {
      booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
      forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
    },
    firstRun: true,
    daysIn: 3,
  };

  it("is one quiet line on the Wall, and the rest of the surface is intact", () => {
    payload.portfolio = nothing;

    const { container } = renderWall();

    expect(container.querySelector("[data-wall-revenue]")).toHaveAttribute("data-wall-revenue", "none");
    expect(container.querySelector("[data-wall-revenue]")?.textContent).toBe("No revenue source");
    expect(
      screen.queryByText(/P&L starts with the first reconciled month/),
    ).not.toBeInTheDocument();
    for (const region of ["strip", "loop", "timeline", "sites", "work"]) {
      expect(container.querySelector(`[data-wall-${region}]`)).not.toBeNull();
    }
  });

  it("draws no money on Home rather than a $0 nobody counted, and lets yesterday's visitors lead", () => {
    payload.portfolio = nothing;

    const { container } = renderHome();

    // No money hero, no revenue tile, no $0, and no estimate word over nothing.
    expect(container.querySelector("[data-money-hero]")).toBeNull();
    expect(container.querySelector('[data-stat="Revenue, yesterday"]')).toBeNull();
    expect(container.querySelector("[data-home-answer]")!.textContent).not.toContain("$");
    expect(container.textContent).not.toContain("$0");
    expect(screen.queryByText(/· estimated|est\./)).toBeNull();
    // The visitors take the lead's place, once.
    const visitors = container.querySelectorAll('[data-stat="Visitors, yesterday"]');
    expect(visitors).toHaveLength(1);
    expect(visitors[0]!.closest("[data-surface-hero]")).not.toBeNull();
  });

  it("brings the month's figure back on the first forecast-only row", () => {
    // One estimated row and nothing reconciled: the figure returns, named an estimate.
    payload.portfolio = { ...nothing, forecast: { currency: 'USD', revenue: 45, cost: 0, net: 45 } };

    const { container } = renderWall();

    const revenue = container.querySelector("[data-wall-revenue]")!;
    expect(revenue.querySelector("[data-revenue-figure]")?.textContent).toBe("$45");
    expect(revenue.textContent).toMatch(/· estimated/);
    expect(screen.queryByText(/· reconciled/)).not.toBeInTheDocument();
  });
});

