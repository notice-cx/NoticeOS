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
        { job: "backup", outcome: "ran", startedAt: "2026-07-29T11:00:00.000Z" },
      ],
    },
    dashboard: {
      countdown: {
        emoji: "🌁",
        label: "SF Trip - August 2026",
        targetAt: "2026-08-01T07:00:00.000Z",
      },
    },
    // One asset, carrying work but no signals: enough for the card's work
    // widget to render on both routes, which is what the Wall's link count
    // below is really guarding.
    assets: [
      { netByMonthCurrency: 'USD',
        id: "meals.example",
        displayName: "Meal Planner",
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
        // No entry in config/serp-panel.json: this asset buys no tracked
        // panel, so it owes no review and its card must carry no trace of one.
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

// The two reads every source status comes from (bead `ro-ujb9.96.7.16`): the
// stored credentials and the monitoring items. The sidebar reads the first for
// its expiry dot (bead `ro-vu8d.8`), and Home's and the Wall's source marks
// read both. By default neither has answered, which the model reads as
// Unknown; a case about a source's status says what they answered.
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

// With one site Home leads with that site's Overview lead (bead
// ro-ujb9.127), read through the Overview's own view. It has not answered
// unless a case says what it answered.
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

// A meeting that is already RUNNING at the mocked instant, so the assertion does
// not depend on which local day 12:05Z falls on for the machine running it.
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

// The Wall's live feed (D28, bead ro-trai.9) polls on its own; here it has
// answered with a quiet evening, so the column draws its empty state.
vi.mock("@/hooks/useWallFeed", () => ({
  useWallFeed: () => ({
    data: { generatedAt: "2026-07-29T12:05:00.000Z", since: "2026-07-29T01:00:00.000Z", items: [], limit: 50 },
    isError: false,
  }),
}));

// The clock proposal on the first-run screen (bead ro-ujb9.134): the saved
// clock, the browser's zone, and the one save it makes. Nothing is saved
// until a case presses the button.
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

// A task source connected, as this installation's is (D32, bead
// ro-ujb9.143): the task screens here render exactly as before it existed.
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

const OPEN_ATTENTION = payload.attention;
const POPULATED_PORTFOLIO = payload.portfolio;
const SEEDED_ASSETS = payload.assets;
const SEEDED_SYSTEM = payload.system;

/** A second site beside the seeded one: Home's several-site view, whose
 * comparison table is what a case about the table reads (bead ro-ujb9.127). */
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
      id: `item-${index}`, provider: "google", capability, label: capability, asset: "meals.example", detail: null, report: null, reportDate: null, state,
      lastAttemptAt: at, lastSuccessAt: state === "healthy" ? at : null, nextAttemptAt: null,
      failure: state === "failing" ? "access" : null, code: state === "failing" ? "access" : null,
      action: "Review the property connection.", coverage: "monitored",
    })),
  };
}

// D28 (bead ro-trai.11, docs/25-the-wall.md § What leaves the Wall): the eight
// source icons per site leave the Wall for the desk. Home keeps each source's
// one status; the Wall draws no icon row, and a FAILING source becomes the
// site's health bar and a specific Needs you concern — never an unproven one.
describe("Home shows each source's one status, and the Wall marks only a failing one (ro-ujb9.96.7.16)", () => {
  const ga4: CardDataSource = { id: "ga4", label: "Google Analytics", state: "live", observedAt: "2026-07-29T12:00:00Z", verification: { kind: "collection-success", laneId: "ga4" } };
  const nightly: CardDataSource = { id: "nightly-report", label: "Nightly report", state: "live", observedAt: "2026-07-29T11:00:00Z", verification: { kind: "collection-success", laneId: "nightly-report" } };
  const statusOn = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll('[role="img"]')].find((mark) => mark.getAttribute("aria-label")?.startsWith(`${label}: `))?.getAttribute("aria-label");
  const siteHealthOn = (container: HTMLElement) => container.querySelector('[data-status-for="asset:meals.example"][data-site-health]');
  const needsOn = (container: HTMLElement) => container.querySelector("[data-wall-needs]")!;

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
    expect(needsOn(wall.container)).toHaveAttribute("data-wall-needs", "calm");
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
    expect(needsOn(wall.container)).toHaveAttribute("data-wall-needs", "calm");
    expect(wall.container.querySelector("[data-system-state]")).toBeNull();
  });

  it("shows the monitoring model's Failing on Home, and the Wall's health bar and Needs you despite a successful 15-minute run", () => {
    googleAnswers([{ capability: "ga4-daily", state: "healthy" }, { capability: "ga4-archive", state: "failing" }]);
    payload.assets = [{ ...SEEDED_ASSETS[0]!, dataSources: [ga4] }];
    const home = renderHome();
    expect(statusOn(home.container, "Google Analytics")).toBe("Google Analytics: Failing");
    home.unmount();
    const wall = renderWall();
    expect(statusOn(wall.container, "Google Analytics")).toBeUndefined();
    expect(siteHealthOn(wall.container)).toHaveAttribute("data-site-health", "error");
    expect(siteHealthOn(wall.container)).toHaveAccessibleName("Site health: GA4 failing");
    expect(within(needsOn(wall.container) as HTMLElement).getByText("GA4 collection failing")).toBeVisible();
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
    expect(needsOn(wall.container)).toHaveAttribute("data-wall-needs", "calm");
  });
});

/**
 * Home is a doc 21 surface since bead `ro-78qo.6`, so the assertions reach for
 * the vocabulary's own marks rather than for a route's private class names: the
 * strip by `[data-kpi-strip]`, one KPI by its eyebrow, a panel by the accessible
 * name `ListPanel` puts on its section. A test written against the markup would
 * have to be rewritten the next time a component's box changes; these break only
 * when the COMPOSITION does, which is what doc 21 is about.
 */
/** A `ListPanel` by its title — the accessible name it gives its own section. */
function panelFor(name: string): HTMLElement {
  return screen.getByRole("region", { name });
}

/** A `ListRow`'s tone, read off the ring that carries it. The glyph is
 * `aria-hidden`, so this is deliberately the one thing here read from a class:
 * doc 21 assigns the row's four tones and nothing else states which one a row
 * got. */
const ROW_TONES = ["text-error", "text-warn", "text-healthy", "text-muted-foreground"];

function rowTone(row: Element): string | undefined {
  const ring = row.querySelector("[aria-hidden]");
  return ring?.className.split(" ").find((name) => ROW_TONES.includes(name));
}

/** An open flag whose rule the translator has never heard of, so its headline is
 * the store's own message — the fallback every surface has to render. */
function alert(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: 1,
    asset: "meals.example",
    assetDisplayName: "Meal Planner",
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
    id: "mp-1w2",
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

/**
 * Bead ro-vtf7: the page a stranger sees the first time they run `os:up` against
 * an empty store. Four tiles reading zero and "No sites onboarded yet" is five
 * designed empty states adding up to an undesigned page, and docs/15 principle 2
 * says every state is designed.
 */
describe("Home — a fresh install", () => {
  /** An empty store: no asset rows, so no alerts and no assets either. */
  function emptyStore() {
    payload.assets = [];
    payload.attention = [];
  }

  it("says what NoticeOS does, then the three steps to a first asset", () => {
    emptyStore();

    const { container } = renderHome();

    // Still Home: the page header is the one thing that survives.
    expect(
      screen.getByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
    expect(container.querySelector("[data-first-run]")).not.toBeNull();
    // One line saying what this is, as a heading — not a paragraph.
    expect(
      screen.getByRole("heading", { level: 2, name: "Your sites’ traffic, money and open work, in one place" }),
    ).toBeInTheDocument();

    const steps = container.querySelectorAll<HTMLElement>("[data-first-run-step]");
    expect(steps).toHaveLength(3);
    // Step 1 is the screen's ONE primary action, and it opens Add a site over
    // Home (bead `ro-ujb9.96.7.5`) rather than going to a page: the domain is
    // the only question. It was the five-step wizard at `/assets/new` (bead
    // `ro-qsoo`), and before that a seed migration plus hand edits to three
    // config files.
    // (What it opens is pinned in test/add-site.test.tsx.)
    expect(screen.getByRole("button", { name: "Add your first site" })).toHaveAttribute("data-add-site-open");
    expect(screen.queryByRole("link", { name: /Add a/ })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Add a site" })).toBeNull();
    // Step 2 points at `/integrations` since bead `ro-vu8d.2`, not at
    // `/health`: this step connects accounts.
    expect(
      screen.getByRole("link", { name: "Connect a source" }),
    ).toHaveAttribute("href", "/integrations");
    expect(screen.getByRole("link", { name: "Connect a source" }).tabIndex).toBe(0);

    // Each step IS its title (bead ro-ujb9.96.6.12): the screen it opens says
    // the rest when it matters, so no note rides under any of them.
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

    // The first number appears on the site's Overview (bead ro-ujb9.123), and
    // there is no site yet: no link, and never System health.
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
    // something was measured, and nothing has been.
    expect(container.querySelector("[data-kpi-strip]")).toBeNull();
    expect(container.querySelector("[data-surface-hero]")).toBeNull();
    expect(screen.queryAllByText("Decide")).toHaveLength(0);
    expect(container.querySelector("table")).toBeNull();
    // Not even the table's own empty state (bead ro-ujb9.96.6.18: "No sites
    // yet" with Add a site) — one first-run state, not six.
    expect(container.querySelector("[data-no-sites]")).toBeNull();
    expect(screen.queryAllByText("No sites yet")).toHaveLength(0);
    // And no census: there is no portfolio to count.
    expect(container.querySelector("[data-portfolio-census]")).toBeNull();
    // The prose disclosure explains numbers this page is not showing.
    expect(container.querySelector("[data-about]")).toBeNull();
  });

  it("stays out of the way once a site has reported", () => {
    const { container } = renderHome();

    expect(container.querySelector("[data-first-run]")).toBeNull();
    expect(container.querySelector("[data-home-brief]")).not.toBeNull();
    // One site: its own lead, not a table row (bead ro-ujb9.127).
    expect(container.querySelector('[data-one-site-lead="meals.example"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-asset-row]")).toHaveLength(0);
  });

  /**
   * Bead ro-ujb9.134: the product ships UTC, and "yesterday's revenue" follows
   * that clock. Until somebody chooses one, the first run shows the clock in
   * effect and one press to use the browser's, with Undo beside it — and a
   * page view alone saves nothing.
   */
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
    // Back where it was, and the offer is still one press away.
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

/**
 * Bead ro-ujb9.123: the guide stays until the first number arrives. Home used
 * to switch to the dashboard the moment one site existed — dashes, "0+" and a
 * red System tile for a site that was still being set up — and the only guide
 * on the product vanished after its first step.
 */
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
  /** The reads answered: Bing's key accepted or not, and — once this site's
   * collection was started — its daily work scheduled but not yet run, which
   * the status model reads as Collecting. */
  function bingAnswers(connected: boolean, startedFor: string | null = null) {
    const credential = {
      provider: "bing-webmaster" as const, source: "store" as const, fields: [], assetsHeld: [], missingFields: [], auth: null,
      metadata: null, keyVersion: 1, createdAt: at, updatedAt: at, lastUsedAt: at, lastOkAt: at, lastError: null,
    };
    // A provider with no stored key is simply absent from the answer.
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
    // Step 2 opens THIS site's first source in the connect panel — the same
    // source its Data sources lead with — not Integrations in general.
    expect(screen.getByRole("link", { name: "Connect Bing Webmaster Tools" }))
      .toHaveAttribute("href", "/integrations?connect=bing-webmaster&asset=journey.example");
    // Step 3 opens the site's Overview, where the first number appears.
    expect(screen.getByRole("link", { name: "See your first number" })).toHaveAttribute("href", "/assets/journey.example");
    expect(screen.getByRole("link", { name: "See your first number" }).tabIndex).toBe(0);
    expect(container.querySelector('[data-first-run-state="current"]')).toBe(container.querySelector("[data-first-run-step='2']"));
    // The one primary action; Add is not offered again.
    expect(screen.queryByRole("button", { name: "Add your first site" })).toBeNull();
    // No dashboard of dashes around it.
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

    // The account is connected; this site is not started, so Connect opens the
    // panel on its sites, where Start is.
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
    expect(container.querySelectorAll("[data-site-cell]")).toHaveLength(2);
  });
});

/** Bead ro-78qo.6: `/` is doc 21's Home template — one strip, two `ListPanel`s,
 * one assets table, prose behind one `About`. The four separate tiles it used to
 * open with (bead ro-pbzu.3) are the four cells of that strip now. */
// Missing core hub readings are unknown, never an absent capability or all-clear.
// D44 (doc 21 § Home — the Morning Brief): `/` opens with what changed since
// the operator last looked — the greeting line, at most five highlight cards
// with the first the big thing, Decide at three rows, the sites in seed order
// and a finish line. The OS never describes itself here.
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

    const needs = container.querySelector("[data-wall-needs]")!;
    expect(needs.querySelector("[data-needs-meta]")).toHaveTextContent("Tasks unknown");
    expect(needs.getAttribute("data-material-condition")?.split(" ")).toEqual([
      "open-flags", "human-gates", "os-runner-health", "scheduled-lane-health", "signal-freshness", "budget-guardrail",
    ]);
    expect(needs.querySelector('[data-material-condition="human-gates"]')).toHaveTextContent("Tasks unknown");
    expect(needs.querySelector("[data-needs-calm]")?.textContent).toBe("Nothing broken");
    expect(needs.textContent).not.toContain("0 urgent tasks");
  });
});

/**
 * Bead ro-ujb9.127: with one site the portfolio IS that site, so Home draws
 * the site's own strip and chart — the Overview's lead, from the Overview's
 * own read — under the brief (D44), and never a comparison table of one row.
 */
describe("Home — one site leads with its own numbers (ro-ujb9.127)", () => {
  it("draws the site's strip fused to its chart under the brief, and no one-row table", () => {
    detail.data = viewOf(everyTabPayload(), "overview");
    const { container } = renderHome();

    // The site's own read, the one its Overview polls.
    expect(detail.asked).toContain("meals.example:overview");
    // The brief is the hero (D44); the site's lead follows Decide.
    const hero = container.querySelector<HTMLElement>("[data-surface-hero]")!;
    expect(hero).toHaveAttribute("data-home-brief");
    const lead = container.querySelector<HTMLElement>('[data-one-site-lead="meals.example"]')!;
    expect(hero.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const traffic = within(lead).getByRole("region", { name: "Traffic · last 28 days" });
    expect(traffic.querySelectorAll("[data-kpi]")).toHaveLength(4);
    expect(traffic.querySelector("[data-hero-chart]")).toHaveTextContent("Active users · daily");
    // The site is named once, as the way to its page, beside its state.
    expect(within(lead).getByRole("link", { name: "Meal Planner →" })).toHaveAttribute("href", "/assets/meals.example");

    // No comparison table, no sites strip, no "All sites", no census counting one.
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("[data-sites-strip]")).toBeNull();
    expect(screen.queryByRole("link", { name: "All sites →" })).toBeNull();
    expect(container.querySelector("[data-portfolio-census]")!.textContent).toBe("updated 5m ago");
    expect(container.textContent).not.toMatch(/portfolio|1 site/i);
    // What needs the operator stays: Decide.
    expect(panelFor("Decide")).toBeInTheDocument();
  });

  it("leads with the one site's revenue when revenue is what it has (ro-ujb9.146)", () => {
    const body = everyTabPayload();
    const empty = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };
    body.performance = { ...body.performance, activeUsers: empty, sessions: empty,
      webSearchClicks: { google: empty, bing: empty }, webSearchImpressions: { google: empty, bing: empty } };
    body.dailyRevenue = { from: "2026-05-01", to: "2026-07-28", reportedThrough: "2026-07-28",
      days: [{ date: "2026-07-27", amountMinor: 400 }, { date: "2026-07-28", amountMinor: 600 }] };
    detail.data = viewOf(body, "overview");
    const { container } = renderHome();
    const lead = container.querySelector<HTMLElement>('[data-one-site-lead="meals.example"]')!;
    const revenue = within(lead).getByRole("region", { name: "Daily revenue" });
    expect(revenue).toHaveTextContent("$10.00");
    expect(within(revenue).getByRole("link", { name: "Meal Planner →" })).toHaveAttribute("href", "/assets/meals.example");
    expect(within(lead).queryByRole("region", { name: "Traffic · last 28 days" })).toBeNull();
  });

  it("holds the site's place, with its state and its link, until its numbers arrive", () => {
    const { container } = renderHome();
    const lead = container.querySelector<HTMLElement>('[data-one-site-lead="meals.example"]')!;
    expect(lead.querySelector("[data-kpi]")).toBeNull();
    expect(within(lead).getByRole("link", { name: "Meal Planner →" })).toBeInTheDocument();
    expect(container.querySelector("table")).toBeNull();
  });

  it("draws the sites strip, and reads no single site, from two sites", () => {
    withSecondSite();
    detail.data = viewOf(everyTabPayload(), "overview");
    const { container } = renderHome();

    expect(container.querySelector("[data-one-site-lead]")).toBeNull();
    expect(detail.asked).toEqual([]);
    expect(container.querySelectorAll("[data-site-cell]")).toHaveLength(2);
    expect(screen.queryByRole("region", { name: "Traffic · last 28 days" })).toBeNull();
    expect(container.querySelector("[data-surface-hero]")).toHaveAttribute("data-home-brief");
  });
});

describe("Home — the Morning Brief (D44)", () => {
  it("opens with the greeting line, the month's money as a card, and an end", () => {
    withSecondSite();
    const { container } = renderHome();

    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    // The header's quiet census: what this page covers, and how old it is.
    expect(container.querySelector("[data-portfolio-census]")!.textContent).toContain("2 sites · updated");
    expect(container.querySelector("[data-portfolio-census]")!.textContent).not.toMatch(/portfolio/i);

    // THE BRIEF IS THE FIRST SCREEN'S ANSWER — the audit measures its bottom
    // edge against 900px (`ro-78qo.9`).
    const hero = container.querySelector<HTMLElement>("[data-surface-hero]")!;
    expect(hero).toHaveAttribute("data-home-brief");
    expect(within(hero).getByRole("heading", { level: 2 })).toHaveTextContent(/^Good (morning|afternoon|evening)$/);
    // A quiet evening with no open problem: nothing changed, and the line says so.
    expect(hero.querySelector("[data-brief-since]")).toHaveTextContent("nothing changed");

    // D13, money leads — as a card, not a strip cell: the ledger's July
    // revenue with its month named, and the way to Money.
    const money = hero.querySelector<HTMLElement>('[data-highlight="money"]')!;
    expect(money).not.toBeNull();
    expect(money).toHaveTextContent("July revenue so far");
    expect(money.querySelector("[data-highlight-action]")).toHaveAttribute("href", "/financials");

    // No strip, and no OS self-talk: freshness, jobs and snapshots belong to
    // System health (doc 17 altitude).
    expect(container.querySelector("[data-kpi-strip]")).toBeNull();
    expect(container.textContent).not.toMatch(/\bfresh\b|\bjobs?\b|snapshot|captured in preview/i);

    // The brief ends, and says how old the reading is.
    const end = hero.querySelector("[data-finish-line]")!;
    expect(end).toHaveTextContent("That's everything");
    expect(end).toHaveTextContent("data as of 5m ago");

    // Each panel links to the page that owns its subject.
    expect(screen.getByRole("link", { name: "All tasks →" })).toHaveAttribute("href", "/tasks");
    expect(screen.getByRole("link", { name: "All sites →" })).toHaveAttribute("href", "/assets");
  });

  /** Doc 21 principle 3a: nothing on Home needs a paragraph, so there is no
   * About to hide one in. */
  it("needs no About: its facts are on the cards they qualify", () => {
    const { container } = renderHome();
    expect(container.querySelector("[data-about]")).toBeNull();
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  // Bead ro-bdkp: on the first days of a month the payload falls back to the
  // latest month that HAS ledger rows, and the card names that month.
  it("names the fallback month on the money card when the newest ledger rows are not this month's", () => {
    payload.portfolio = { ...POPULATED_PORTFOLIO, period: "2026-08", periodIsCurrent: false };
    const { container } = renderHome();
    expect(container.querySelector('[data-highlight="money"]')).toHaveTextContent("August revenue so far");
    expect(screen.queryByText("August 2026 · latest month on the ledger")).toBeNull();
  });

  it("carries no clock, countdown, meeting, asset card or attention table", () => {
    const { container } = renderHome();
    expect(screen.queryByText("Local time")).toBeNull();
    expect(screen.queryByText("SF Trip - August 2026")).toBeNull();
    expect(screen.queryByRole("button", { name: "Configure" })).toBeNull();
    expect(container.querySelector("[data-strip-meeting]")).toBeNull();
    expect(container.querySelector("[data-property-grid]")).toBeNull();
    expect(container.querySelector("[data-property-card]")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    // Disposition is `/alerts`' business: no row action reaches this page.
    expect(screen.queryByRole("button", { name: "Mark alert read" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve alert" })).toBeNull();
  });

  it("ranks an error above a warning, makes the first card the big thing, and caps the brief at five", () => {
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
    const hero = container.querySelector<HTMLElement>("[data-surface-hero]")!;
    const cards = [...hero.querySelectorAll<HTMLElement>("[data-highlight]")];

    // Five cards, the count of everything before the cap, and still an end.
    expect(cards).toHaveLength(5);
    expect(hero.querySelector("[data-brief-since]")).toHaveTextContent("7 things changed");
    expect(hero.querySelector("[data-finish-line]")).not.toBeNull();
    // Errors first, newest first within them: the newest error is the big thing.
    expect(cards[0]).toHaveAttribute("data-highlight", "alert");
    expect(cards[0]).toHaveAttribute("data-highlight-big");
    expect(cards[0]).toHaveTextContent("Alert 7");
    expect(cards.map((card) => card.getAttribute("data-highlight-big") !== null)).toEqual([true, false, false, false, false]);
    expect(cards.slice(0, 4).map((card) => card.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Alert 7"), expect.stringContaining("Alert 5"), expect.stringContaining("Alert 3"), expect.stringContaining("Alert 1")]),
    );
    expect(cards[4]).toHaveTextContent("Alert 6");
    expect(screen.queryByText(/Alert 2/)).toBeNull();
    // Money ranks after every open problem, so it fell past the cap.
    expect(hero.querySelector('[data-highlight="money"]')).toBeNull();
    // The one verb opens the site; the card names it.
    expect(cards[0]!.querySelector("[data-highlight-action]")).toHaveAttribute("href", "/assets/meals.example");
    expect(cards[0]).toHaveTextContent("Alert · Meal Planner");
    expect(cards[0]).toHaveTextContent("since");
  });

  /** Bead `ro-ujb9.199`: a site with no number yet opens on its Data sources,
   * as the sidebar sends it. */
  it("opens a site with no number yet on its Data sources from its alert card", () => {
    const empty = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };
    payload.assets = [...SEEDED_ASSETS, { ...SEEDED_ASSETS[0]!, id: "fresh.example", displayName: "Fresh Example",
      pulseReceivedAt: null, firstReportAt: null, activeUsers: empty, searchClicks: empty,
      netByMonth: [], booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 }, forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
      dailyRevenue: undefined, dataSources: [], work: null,
    }];
    payload.attention = [alert({ id: 4, asset: "fresh.example", assetDisplayName: "Fresh Example" })];

    const { container } = renderHome();
    const card = container.querySelector<HTMLElement>('[data-highlight="alert"]')!;
    expect(card.querySelector("[data-highlight-action]")).toHaveAttribute("href", "/assets/fresh.example/sources");
  });

  /** `ro-kukv.6` / decision D15: one fact about four sites is ONE card, and
   * the way through is `/alerts`, where the four expand into four actions. */
  it("shows sites that have never reported as ONE card, pointing at Alerts", () => {
    payload.attention = [
      alert({
        id: 31, asset: "fees.example", assetDisplayName: "Fee Codes", severity: "error",
        ruleId: "ingest-freshness", ruleInputs: { rule: "ingest-freshness", state: "never-reported" },
        occurrences: 4, firstFiredAt: "2026-07-05T09:00:00.000Z",
        members: [
          { id: 31, asset: "fees.example", assetDisplayName: "Fee Codes", firedAt: "2026-07-05T09:00:00.000Z" },
          { id: 32, asset: "pullups.example", assetDisplayName: "Pull-up Standards", firedAt: "2026-07-06T09:00:00.000Z" },
          { id: 33, asset: "areas.info", assetDisplayName: "Area Lookup", firedAt: "2026-07-07T09:00:00.000Z" },
          { id: 34, asset: "pacer.example", assetDisplayName: "Pacer Test", firedAt: "2026-07-08T09:00:00.000Z" },
        ],
      }),
    ];

    const { container } = renderHome();
    const cards = container.querySelectorAll<HTMLElement>('[data-highlight="alert"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent("Four sites have no nightly reports");
    expect(cards[0]!.textContent).not.toContain("recurred");
    expect(cards[0]!.querySelector("[data-highlight-action]")).toHaveAttribute("href", "/alerts");
  });

  it("says a visitors move in business words, and only when the week moved it", () => {
    const days = Array.from({ length: 14 }, (_, index) => ({ t: `2026-07-${String(15 + index).padStart(2, "0")}`, v: index === 13 ? 130 : 100 }));
    payload.assets = [{ ...SEEDED_ASSETS[0]!, activeUsers: { series: days, provisionalFrom: "2026-07-29", collectedAt: null, timeZoneChanges: [] } }];

    const moved = renderHome();
    const hero = moved.container.querySelector<HTMLElement>("[data-surface-hero]")!;
    expect(hero.querySelector("[data-page-answer-figures]")).toHaveTextContent("Visitors yesterday130");
    const card = hero.querySelector<HTMLElement>('[data-highlight="people"]')!;
    expect(card).toHaveTextContent("Visitors up 30% on the same day last week");
    expect(card).toHaveTextContent("130 yesterday · 100 a week before");
    expect(card.querySelector("[data-spark]")).not.toBeNull();
    moved.unmount();

    // Two percent is weather: the figure stays, the card does not.
    payload.assets = [{ ...SEEDED_ASSETS[0]!, activeUsers: { series: days.map((day, index) => ({ ...day, v: index === 13 ? 102 : 100 })), provisionalFrom: "2026-07-29", collectedAt: null, timeZoneChanges: [] } }];
    const quiet = renderHome();
    expect(quiet.container.querySelector("[data-page-answer-figures]")).toHaveTextContent("Visitors yesterday102");
    expect(quiet.container.querySelector('[data-highlight="people"]')).toBeNull();
  });

  it("gives every site one cell with its health word, in seed order, that opens its page", () => {
    withSecondSite();
    payload.attention = [alert({ id: 9, severity: "error" })];

    const { container } = renderHome();
    const cells = [...container.querySelectorAll<HTMLElement>("[data-site-cell]")];
    expect(cells.map((cell) => cell.getAttribute("data-site-cell"))).toEqual(["meals.example", "second.example"]);
    // The first site has an open error: Off track. The second has nothing: On track.
    expect(cells[0]!.querySelector('[data-status-for="asset:meals.example"]')).toHaveTextContent("Off track");
    expect(cells[1]!.querySelector('[data-status-for="asset:second.example"]')).toHaveTextContent("On track");
    expect(within(cells[0]!).getByRole("link", { name: /Meal Planner/ })).toHaveAttribute("href", "/assets/meals.example");
    // A cell says one figure and never a zero for nothing measured.
    expect(cells[0]).toHaveTextContent("nothing reported yesterday");
    // No source marks, no automation chips, no task counts: the table on
    // Sites holds the comparison.
    expect(container.textContent).not.toContain("Automation enabled");
    expect(container.textContent).not.toContain("12 open");
  });
});

describe("Home — Decide (D44)", () => {
  it("puts an open gate above a higher-priority ask, with its verb on the row", () => {
    workState.data = workPayload([
      project("Meal Planner", [waiting({ id: "mp-9k1", priority: 0, title: "Top-priority ask" })]),
      project("NoticeOS", [waiting({ id: "ro-3z7", priority: 3, issueType: "gate", title: "Approve the spend cap" })]),
    ]);

    renderHome();

    const rows = within(panelFor("Decide")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // A gate holds work out of the ready queue, so it leads regardless of its
    // own priority band — and reaches the operator as what it DOES (doc 17),
    // with Approve on the row (Linear Triage, in the brief's prior art).
    expect(rows[0]).toHaveTextContent("Approve the spend cap");
    expect(rows[0]).toHaveTextContent("needs your approval");
    expect(rows[0]).toHaveTextContent("NoticeOS");
    expect(rows[0]!.textContent).not.toContain("· gate");
    // Business altitude: the task's id stays on the page the row opens.
    expect(rows[0]!.textContent).not.toContain("ro-3z7");
    expect(within(rows[0]!).getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(within(rows[0]!).getByRole("link")).toHaveAttribute("href", "/tasks/ro-3z7");
    expect(rows[1]).toHaveTextContent("Top-priority ask");
    expect(within(rows[1]!).getByRole("button", { name: "Answer" })).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All tasks →" })).toHaveAttribute("href", "/tasks");
  });

  it("tells an empty inbox apart from an inbox it has never seen", () => {
    workState.data = workPayload([project("Meal Planner", [])]);
    const clear = renderHome();
    expect(screen.getByText("Nothing to decide.")).toBeInTheDocument();
    clear.unmount();

    workState.data = workPayload([project("Meal Planner", [])], null);
    renderHome();
    expect(screen.getByText("No tasks read yet.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing to decide.")).toBeNull();
  });

  it("shows three rows, names the rest as the way out, and discloses them in place", () => {
    const capped = project("Meal Planner", Array.from({ length: 10 }, (_, index) =>
      waiting({ id: `mp-${index}`, title: `Request ${index + 1}` }),
    ));
    capped.counts.waiting = 24;
    workState.data = workPayload([capped]);
    renderHome();
    const panel = panelFor("Decide");
    expect(panel).toHaveTextContent("24 waiting");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
    expect(within(panel).getByRole("link", { name: "7 more →" })).toHaveAttribute("href", "/tasks");
    fireEvent.click(within(panel).getByRole("button", { name: "Show 7 more" }));
    expect(within(panel).getAllByRole("listitem")).toHaveLength(10);
  });

  it("names the wait beside each row, and nothing about the read itself", () => {
    workState.data = workPayload([project("Meal Planner", [waiting({ updatedAt: "2026-07-01T12:05:00.000Z" })])]);
    renderHome();
    const panel = panelFor("Decide");
    expect(panel).not.toHaveTextContent("Task status read");
    expect(panel).not.toHaveTextContent("captured in preview");
    expect(panel.querySelector("button button, a button")).toBeNull();
    const row = within(panel).getByRole("listitem");
    expect(row).toHaveTextContent("28d");
    expect(row).toHaveTextContent("waiting");
  });

  it.each(["failed project", "unmeasured inbox", "no projects", "stale snapshot", "failed refresh"])(
    "does not claim a clear inbox after a %s",
    (failure) => {
      const emptyProject = project("Meal Planner", []);
      if (failure === "failed project") emptyProject.ok = false;
      if (failure === "unmeasured inbox") emptyProject.counts.waiting = null;
      workState.data = workPayload(failure === "no projects" ? [] : [emptyProject],
        failure === "stale snapshot" ? "2026-07-29T11:00:00.000Z" : undefined);
      workState.isError = failure === "failed refresh";
      renderHome();
      const panel = panelFor("Decide");
      expect(panel).not.toHaveTextContent("Nothing to decide.");
      expect(panel).toHaveTextContent(/not fully read|unknown/);
      if (failure === "stale snapshot") expect(panel).toHaveTextContent("outdated");
      // The state is said once, in the header line; the empty row does not
      // repeat it (one status per subject).
      expect(panel.textContent!.match(/outdated/g)?.length ?? 0).toBeLessThanOrEqual(1);
    },
  );

  it("states known totals as a lower bound when one project is unreadable", () => {
    const known = project("Meal Planner", [waiting()]);
    known.counts.waiting = 12;
    const failed = project("NoticeOS", []);
    failed.ok = false;
    failed.counts.waiting = 99;
    workState.data = workPayload([known, failed]);
    renderHome();
    const panel = panelFor("Decide");
    expect(panel).toHaveTextContent("12+ waiting · partial read");
    expect(panel).not.toHaveTextContent("111 waiting");
  });

  it("keeps an authoritative nonzero queue visible even when no rows were captured", () => {
    const emptyPreview = project("Meal Planner", []);
    emptyPreview.counts.waiting = 12;
    workState.data = workPayload([emptyPreview]);
    renderHome();
    const panel = panelFor("Decide");
    expect(panel).toHaveTextContent("12 waiting");
    expect(panel).toHaveTextContent("No request details read.");
    expect(panel).not.toHaveTextContent("Nothing to decide.");
  });

  it("recovers from a failed initial read to an evidenced empty inbox", () => {
    workState.isError = true;
    const view = renderHome();
    expect(panelFor("Decide")).toHaveTextContent("Could not read your tasks.");
    workState.isError = false;
    workState.data = workPayload([project("Meal Planner", [])]);
    view.rerender(homeTree());
    expect(panelFor("Decide")).toHaveTextContent("Nothing to decide.");
    expect(panelFor("Decide")).not.toHaveTextContent("Could not read");
  });

  it("gives every row the Tasks board's ask face — warn at every priority, a gate's △ (ro-ujb9.240)", () => {
    workState.data = workPayload([
      project("NoticeOS", [waiting({ id: "ro-3z7", priority: 3, issueType: "gate", title: "Approve the cap" })]),
      project("Meal Planner", [
        waiting({ id: "mp-9k1", priority: 0, title: "Top-priority ask" }),
        waiting({ id: "mp-2b4", priority: 1, title: "High-priority ask" }),
        waiting({ id: "mp-7c3", priority: 2, title: "Default-priority ask" }),
      ]),
    ]);

    renderHome();

    const panel = panelFor("Decide");
    fireEvent.click(within(panel).getByRole("button", { name: "Show 1 more" }));
    const rows = within(panel).getAllByRole("listitem");
    // A task's priority is not a severity (doc 14): an ask waiting on the
    // operator is warn at every band. Priority is the ORDER, not the colour.
    expect(rows.map(rowTone)).toEqual(["text-warn", "text-warn", "text-warn", "text-warn"]);
    // Never colour-only: a gate holding other work (`△`) reads differently
    // from an ask (`!`) on a grayscale screen — the board's inbox marks.
    expect(rows.map((row) => row.querySelector("[aria-hidden]")!.textContent)).toEqual(["△", "!", "!", "!"]);
    expect(rows[0]).toHaveTextContent("needs your approval");
    expect(rows[3]!.textContent).not.toContain("needs your approval");
  });
});

describe("the nav's site dot names its open alerts, never a bare severity (ro-32ry)", () => {
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
      // A site with no open alert draws no dot at all, as before.
      expect(dot("gamma.example")).toBeNull();
      // No visible words were added: the row still reads as the site's name.
      expect(container.querySelector('[data-nav-asset="alpha.example"]')!.textContent).toBe("Alpha");
    } finally {
      payload.assets = saved;
    }
  });
});

describe("Home and Wall phase scoping", () => {
  it("sends the desk to Health, the page's own name and path (bead ro-034)", () => {
    // The nav used to say "Data sources", which stopped being true when the top
    // row of that page became whether this machine can reach the internet. Since
    // bead ro-pbzu.1 that nav is the SHELL's sidebar rather than Home's own
    // header, so the assertion moved with it — and Home must no longer carry a
    // second copy of it.
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

  // D28 (bead ro-trai.11, docs/25-the-wall.md § Regions): with nothing saved,
  // the route draws the strip, then a column of revenue beside Needs you over
  // the site rows, beside the full-height feed — and no header row above it.
  it("draws D28 when nothing is saved: the strip, revenue beside Needs you over the sites, the feed beside", () => {
    const { container } = renderWall();

    // Each widget sits in its slot, which is no box at the TV's width and
    // places it in the one column below it (bead ro-trai.29).
    const strip = container.querySelector("[data-wall-row='strip'] > [data-wall-slot] > [data-wall-strip]");
    expect(strip).not.toBeNull();
    const body = container.querySelector("[data-wall-row='body']")!;
    expect(body).toHaveAttribute("data-wall-row-height", "fill");
    const column = body.querySelector(":scope > [data-wall-column]")!;
    expect(column.querySelector("[data-wall-row='money'] > [data-wall-slot] > [data-wall-revenue]")).not.toBeNull();
    expect(column.querySelector("[data-wall-row='money'] > [data-wall-slot] > [data-wall-needs]")).not.toBeNull();
    expect(column.querySelector("[data-wall-row='sites'] > [data-wall-slot] > [data-wall-sites]")).not.toBeNull();
    expect(body.querySelector(":scope > [data-wall-slot] > [data-wall-feed]")).not.toBeNull();
    expect(strip!.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The strip keeps identity, time, the meeting and the countdown; system
    // concerns belong to Needs you rather than an aggregate header badge.
    expect(strip!.textContent).toContain("SF Trip - August 2026");
    expect(strip!.querySelector("[data-strip-meeting-distance]")).toHaveTextContent("25M left");
    expect(strip!.querySelector("[data-strip-meeting-cue]")).toHaveTextContent("Now");
    expect(strip!.querySelector("[data-strip-clock-group]")).not.toBeNull();
    expect(strip!.querySelector("[data-strip-agenda]")).not.toBeNull();
    expect(strip!.querySelector("[data-strip-countdown-value]")).not.toBeNull();
    expect(strip!.querySelector("[data-system-state]")).toBeNull();
    expect(column.querySelector("[data-needs-calm]")).toHaveTextContent("Nothing needs you");
    // The page inset is D28's frame, on tokens.
    expect(container.querySelector(".wall-root")).toHaveClass("md:px-wall-inset-x", "md:py-wall-inset-y");
    expect(screen.queryByRole("button", { name: "Configure" })).not.toBeInTheDocument();
  });

  // Everything the header row carried has one home now (docs/25 § What leaves
  // the Wall): identity is the strip's, the Tasks legend and its strips are the
  // desk's, integrations failing are specific Needs you concerns and site health.
  it("draws no header row: no Tasks legend, no Integrations link, no refresh age while polls succeed", () => {
    const { container } = renderWall();

    expect(container.querySelector("[data-wall-header]")).toBeNull();
    expect(container.querySelector("[data-work-flow-legend]")).toBeNull();
    expect(container.querySelector("[data-work-flow]")).toBeNull();
    expect(container.textContent).not.toMatch(/Integrations:/);
    expect(container.textContent).not.toMatch(/View refreshed|Refreshed .* ago/);
    expect(container.querySelector("[data-strip-held]")).toBeNull();
    // The old panels are gone with it: the seven-segment clock, the countdown
    // panel, the alert rail and the System card.
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

    // Urgent tasks stay as Needs you's count, never as rows (docs/25 § Needs you).
    const needs = container.querySelector("[data-wall-needs]")!;
    expect(needs.querySelector("[data-needs-meta]")?.textContent).toContain("4 urgent tasks");
    expect(needs.textContent).not.toContain("Nothing needs you");
  });

  it("gives the TV one link, Home, on the strip's brand, and no controls", () => {
    const { container } = renderWall();

    const home = screen.getByRole("link", { name: "NoticeOS" });
    expect(home).toHaveAttribute("href", "/");
    expect(home.closest("[data-wall-strip]")).not.toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  /** Bead ro-rkp: absence is the render for an asset with no tracked SERP
   * panel — no badge, no dash, no explainer. Asserted at ROUTE level because
   * that is where a well-meaning "nothing to review" placeholder would appear
   * on every card in the portfolio. */
  it("leaves no trace of a panel review on an asset that has no panel", () => {
    for (const Route of [HomeRoute, WallRoute]) {
      const { container, unmount } = render(
        <MemoryRouter>
          <Route />
        </MemoryRouter>,
      );
      expect(container.querySelector("[data-panel-review]")).toBeNull();
      expect(container.querySelector('[aria-label*="SERP panel"]')).toBeNull();
      expect(container.textContent).not.toContain("SERP panel");
      unmount();
    }
  });

  it("keeps task strips off the Wall and urgency on the desk", () => {
    const wall = renderWall();
    expect(wall.container.textContent).not.toContain("3 urgent");
    // The bet strip and the per-card net left the Wall on 2026-08-31 (operator
    // decision); D28 took the task-count strips too (docs/25 § What leaves the
    // Wall). They stay on the desk below.
    expect(wall.container.textContent).not.toContain("Active bet");
    expect(wall.container.textContent).not.toContain("Homepage answer-card experiment");
    expect(wall.container.querySelector("[data-priority-bar]")).toBeNull();
    expect(wall.container.querySelector("[data-work-status]")).toBeNull();
    expect(wall.container.querySelector('a[href="/tasks"]')).toBeNull();
    wall.unmount();

    // Home's Decide links to the board; the per-site counts are on Sites (D44).
    withSecondSite();
    const home = renderHome();
    expect(home.container.querySelector('a[href="/tasks"]')).not.toBeNull();
    // And nothing on either surface still points at the old address.
    expect(home.container.querySelector('a[href="/work"]')).toBeNull();
  });
});

/** Bead ro-yf3, and D28's revenue widget since bead ro-trai.11: a month with no
 * ledger row is one quiet line on the TV ("No revenue source") while the rest
 * of the Wall draws; Home's tile strip is fixed, so there it says so in one
 * line of its own. */
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
    // Everything else still renders: a quiet line, not a broken route.
    for (const region of ["strip", "needs", "sites", "feed"]) {
      expect(container.querySelector(`[data-wall-${region}]`)).not.toBeNull();
    }
  });

  it("draws no money card on Home rather than a $0 nobody counted", () => {
    payload.portfolio = nothing;

    const { container } = renderHome();

    // Absence is the honest render (bead ro-yf3): no money card, no $0, and
    // no estimate word over nothing. The brief still ends.
    expect(container.querySelector('[data-highlight="money"]')).toBeNull();
    expect(container.querySelector("[data-page-answer]")!.textContent).not.toContain("$");
    expect(screen.queryByText(/· estimated/)).toBeNull();
    expect(container.querySelector("[data-finish-line]")).not.toBeNull();
  });

  it("brings the month's figure back on the first forecast-only row", () => {
    // One estimated row and nothing reconciled: the least data that is still
    // data. The figure returns, named an estimate.
    payload.portfolio = { ...nothing, forecast: { currency: 'USD', revenue: 45, cost: 0, net: 45 } };

    const { container } = renderWall();

    const revenue = container.querySelector("[data-wall-revenue]")!;
    expect(revenue.querySelector("[data-revenue-figure]")?.textContent).toBe("$45");
    expect(revenue.textContent).toMatch(/· estimated/);
    // Still nothing reconciled, so the booked word stays unstated.
    expect(screen.queryByText(/· reconciled/)).not.toBeInTheDocument();
  });
});

