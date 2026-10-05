import { integrationStatus } from '@shared/integration-status';
import { INTEGRATION_PROVIDERS } from "@noticeos/contract";
import { fireEvent, render, screen, waitFor, within } from "./render";
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

function renderHome() {
  return render(
    <MemoryRouter>
      <HomeRoute />
    </MemoryRouter>,
  );
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
    expect(siteHealthOn(wall.container)).toHaveAccessibleName("Site health: No open issues");
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
    expect(siteHealthOn(wall.container)).toHaveAccessibleName("Site health: No open issues");
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
    expect(siteHealthOn(wall.container)).toHaveAccessibleName("Site health: No open issues");
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
function stripKpis(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-kpi-strip] [data-kpi]")];
}

/** One KPI by name. `data-kpi` carries the metric's own label since bead
 * `ro-78qo.1`, which is the same handle the surface audit reads. */
function kpiFor(container: HTMLElement, label: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    `[data-kpi-strip] [data-kpi="${label}"]`,
  );
  if (!found) throw new Error(`no KPI labelled "${label}" in the strip`);
  return found;
}

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
    expect(screen.queryAllByText("Waiting on you")).toHaveLength(0);
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
    expect(container.querySelector("[data-kpi-strip]")).not.toBeNull();
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
    expect(screen.queryAllByText("Waiting on you")).toHaveLength(0);
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
    expect(container.querySelector("[data-kpi-strip]")).not.toBeNull();
    expect(container.querySelectorAll("[data-asset-row]")).toHaveLength(2);
  });
});

/** Bead ro-78qo.6: `/` is doc 21's Home template — one strip, two `ListPanel`s,
 * one assets table, prose behind one `About`. The four separate tiles it used to
 * open with (bead ro-pbzu.3) are the four cells of that strip now. */
// Missing core hub readings are unknown, never an absent capability or all-clear.
describe("Home and the Wall with an unread core task hub", () => {
  afterEach(resetTaskSourceMock);

  it("keeps task navigation and an unknown inbox visible before any project has been read", () => {
    const prior = payload.operator;
    payload.operator = null;
    taskSourceMock.connected = null;
    withSecondSite();
    const { container } = renderHome();
    payload.operator = prior;

    expect(stripKpis(container).map((kpi) => kpi.getAttribute("data-kpi"))).toEqual(["Net · Jul", "Needs you", "Open alerts", "System"]);
    expect(screen.getByText("Waiting on you")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: /Tasks/ })).toBeVisible();
    expect(container.textContent).toContain("no project has been read yet");
    expect(container.textContent).toContain("Reading your tasks…");
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
 * Bead ro-ujb9.127: one site is the most common workspace, and with one site
 * the portfolio IS that site. Home used to open on "Portfolio · 1 asset" and a
 * comparison table of one row; it now leads with the site's own strip and
 * chart — the Overview's lead, from the Overview's own read.
 */
/**
 * Bead ro-ujb9.13: stacked in desk order, a phone put the one site's chart (or
 * the month's money) above Needs you and Open alerts — 942px down an 844px
 * screen. Below `sm` the status strip leads, then the site, then the rows that
 * need you, then the money, then the sites; the desk's order is its DOM order,
 * untouched. jsdom has no layout, so the order classes are asserted.
 */
describe("Home — on a phone, what needs you comes first (ro-ujb9.13)", () => {
  const order = (element: Element | null) => element?.className.match(/max-sm:order-(\d)/)?.[1] ?? null;

  it("orders status, the site, the rows, then the money, with one site", () => {
    detail.data = viewOf(everyTabPayload(), "overview");
    const { container } = renderHome();

    const status = screen.getByRole("region", { name: "Latest status" });
    expect(order(status)).toBe("1");
    expect(order(container.querySelector("[data-one-site-lead]"))).toBe("2");
    expect(order(screen.getByRole("region", { name: "Waiting on you" }).parentElement)).toBe("3");
    expect(order(screen.getByRole("region", { name: /^Financials/ }))).toBe("4");
    // The two sections join the page's own column on a phone, and only there.
    expect(status.parentElement).toHaveClass("max-sm:contents", "lg:grid-cols-4");
    // The desk reads in DOM order: the site's lead first, as doc 21 draws it.
    const all = [...container.querySelectorAll("[data-one-site-lead], section[aria-labelledby]")];
    expect(all[0]).toHaveAttribute("data-one-site-lead");
  });

  it("puts the sites after the money, from two sites", () => {
    withSecondSite();
    const { container } = renderHome();

    expect(order(screen.getByRole("region", { name: "Latest status" }))).toBe("1");
    expect(order(screen.getByRole("region", { name: "Sites" }))).toBe("5");
    // The status strip is the answer, and the one the audit measures.
    expect(container.querySelector("[data-surface-hero]")).toBe(screen.getByRole("region", { name: "Latest status" }));
  });
});

describe("Home — one site leads with its own numbers (ro-ujb9.127)", () => {
  it("leads with the site's strip fused to its chart, and draws no one-row table", () => {
    detail.data = viewOf(everyTabPayload(), "overview");
    const { container } = renderHome();

    // The site's own read, the one its Overview polls.
    expect(detail.asked).toContain("meals.example:overview");
    // The first thing under the header is the site's lead: the page's hero.
    const lead = container.querySelector<HTMLElement>("[data-surface-hero]")!;
    expect(lead).toHaveAttribute("data-one-site-lead", "meals.example");
    const traffic = within(lead).getByRole("region", { name: "Traffic · last 28 days" });
    expect(traffic.querySelectorAll("[data-kpi]")).toHaveLength(4);
    expect(traffic.querySelector("[data-hero-chart]")).toHaveTextContent("Active users · daily");
    // The site is named once, as the way to its page, beside its state.
    expect(within(lead).getByRole("link", { name: "Meal Planner →" })).toHaveAttribute("href", "/assets/meals.example");

    // No comparison table of one row, no "All sites", no census counting one.
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelectorAll("[data-asset-row]")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "All sites →" })).toBeNull();
    const census = container.querySelector("[data-portfolio-census]")!.textContent!;
    expect(census).toBe("updated 5m ago");
    expect(container.textContent).not.toMatch(/portfolio|1 site/i);

    // What needs the operator stays: the status strip, Waiting on you, Alerts.
    expect(screen.getByRole("region", { name: "Latest status" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Waiting on you" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Alerts" })).toBeInTheDocument();
    // The lead comes first; the status strip follows it.
    expect(lead.compareDocumentPosition(screen.getByRole("region", { name: "Latest status" })) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
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

  it("brings the comparison table back, and reads no single site, from two sites", () => {
    withSecondSite();
    detail.data = viewOf(everyTabPayload(), "overview");
    const { container } = renderHome();

    expect(container.querySelector("[data-one-site-lead]")).toBeNull();
    expect(detail.asked).toEqual([]);
    expect(container.querySelectorAll("[data-asset-row]")).toHaveLength(2);
    expect(screen.queryByRole("region", { name: "Traffic · last 28 days" })).toBeNull();
    // The status strip is the hero again.
    expect(container.querySelector("[data-surface-hero]")!.querySelector("[data-kpi-strip]")).not.toBeNull();
  });
});

describe("Home — the operator's overview", () => {
  it("answers the four questions in ONE strip, left to right", () => {
    withSecondSite();
    const { container } = renderHome();

    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    // The header's quiet census: what this page covers, and how old it is.
    expect(
      container.querySelector("[data-portfolio-census]")!.textContent,
    ).toContain("2 sites · updated");
    expect(container.querySelector("[data-portfolio-census]")!.textContent).not.toMatch(/portfolio/i);

    // ONE strip, and it IS the first screen's answer — the audit measures its
    // bottom edge against 900px (`ro-78qo.9`).
    const hero = container.querySelector("[data-surface-hero]")!;
    expect(hero).not.toBeNull();
    expect(hero.querySelector("[data-kpi-strip]")).not.toBeNull();
    const financials = screen.getByRole("region", { name: "Financials · July 2026" });
    const latestStatus = screen.getByRole("region", { name: "Latest status" });
    expect(financials).toContainElement(kpiFor(container, "Net · Jul"));
    expect(financials.querySelectorAll("[data-kpi]")).toHaveLength(1);
    expect(latestStatus).toContainElement(kpiFor(container, "Needs you"));
    expect(latestStatus).toContainElement(kpiFor(container, "Open alerts"));
    expect(latestStatus).toContainElement(kpiFor(container, "System"));
    expect(latestStatus).not.toContainElement(kpiFor(container, "Net · Jul"));
    expect(stripKpis(container).map((kpi) => kpi.getAttribute("data-kpi"))).toEqual([
      "Net · Jul",
      "Needs you",
      "Open alerts",
      "System",
    ]);
    // NOT SELECTABLE (doc 21): there is no chart under this strip for a KPI to
    // choose, and a button that does nothing is worse than a figure.
    expect(hero.querySelector("button[aria-pressed]")).toBeNull();

    // D13, money leads: the same figure the Portfolio card chooses — the
    // forecast, because it is the side carrying money — with its own word, and
    // its composition rather than a movement it cannot judge.
    const money = kpiFor(container, "Net · Jul");
    expect(within(money).getByText("$45")).toBeInTheDocument();
    expect(money.textContent).toContain("revenue $45 · cost $0 · estimated");
    expect(money.textContent).toContain("Jul");
    // The sum of booked and forecast is not a number this page can produce.
    expect(screen.queryByText("$125")).not.toBeInTheDocument();

    // A complete, fresh zero is the one state that reads calm.
    expect(kpiFor(container, "Needs you").textContent).toContain(
      "nothing is waiting on you",
    );
    expect(kpiFor(container, "Open alerts").textContent).toContain("all clear");
    // The System KPI carries the OS's own posture — the freshness fraction and
    // the jobs that ran — rather than the Wall's status strip in a link.
    const system = kpiFor(container, "System");
    expect(system.textContent).toContain("/ 1 fresh");
    expect(system.textContent).toContain("1 job");
    expect(container.querySelector("[data-system-posture]")).toBeNull();

    // Each panel links to the page that owns its subject. `/tasks` is the
    // canonical board; `/work` still redirects, but a link the product emits
    // itself should not spend a hop on it (bead ro-l1ed.6).
    expect(screen.getByRole("link", { name: "All tasks →" })).toHaveAttribute(
      "href",
      "/tasks",
    );
    expect(screen.getByRole("link", { name: "All alerts →" })).toHaveAttribute(
      "href",
      "/alerts",
    );
  });

  /** Doc 21 principle 3a (bead ro-ujb9.96.6.12): nothing on Home needs a
   * paragraph, so there is no About to hide one in. The facts it held are on
   * the screen — the month on Net's label, "+" and "N of M projects measured"
   * on Needs you, "first seen" on every alert row — or are the chart's own
   * marks (a hollow endpoint, a dash). */
  it("needs no About: its facts are on the numbers they qualify", () => {
    const { container } = renderHome();

    expect(container.querySelector("[data-about]")).toBeNull();
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  // Bead ro-bdkp: on the first days of a month the payload falls back to the
  // latest month that HAS ledger rows. An unlabelled figure in the money slot
  // would then be four-week-old money passing for today's — so the KPI names
  // the month in the card's own words rather than a second phrasing.
  it("names the fallback month when the newest ledger rows are not this month's", () => {
    payload.portfolio = {
      ...POPULATED_PORTFOLIO,
      period: "2026-08",
      periodIsCurrent: false,
    };

    const { container } = renderHome();

    // THE EYEBROW NAMES THE MONTH, which is the whole guard: on the 2nd of
    // September this figure is August's, and a KPI reading "Net this month"
    // over it would be four-week-old money passing for today's. Two words in
    // the label do that; the sentence explaining WHY a month can be the
    // fallback is About material and lives there.
    const money = kpiFor(container, "Net · Aug");
    expect(money).not.toBeNull();
    expect(screen.getByRole("region", { name: "Financials · August 2026" })).toContainElement(money);
    expect(stripKpis(container).map((kpi) => kpi.getAttribute("data-kpi"))[0]).toBe(
      "Net · Aug",
    );
    expect(
      screen.queryByText("August 2026 · latest month on the ledger"),
    ).toBeNull();
  });

  it("carries no clock, countdown, meeting, asset card or attention table", () => {
    const { container } = renderHome();

    expect(screen.queryByText("Local time")).toBeNull();
    expect(screen.queryByText("SF Trip - August 2026")).toBeNull();
    expect(screen.queryByRole("button", { name: "Configure" })).toBeNull();
    expect(container.querySelector("[data-strip-meeting]")).toBeNull();
    expect(screen.queryByText("Monthly net")).toBeNull();
    expect(screen.queryByText("Chart key")).toBeNull();
    // The asset GRID and its cards are `/assets`; Home has a table instead.
    expect(container.querySelector("[data-property-grid]")).toBeNull();
    expect(container.querySelector("[data-property-card]")).toBeNull();
    // Disposition is `/alerts`' business: no row action reaches this page.
    expect(screen.queryByRole("button", { name: "Mark alert read" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resolve alert" })).toBeNull();
  });

  it("gives every asset one row that opens its page", () => {
    withSecondSite();
    const { container } = renderHome();

    expect(container.querySelectorAll("[data-asset-row]")).toHaveLength(2);
    const row = container.querySelector<HTMLElement>('[data-asset-row="meals.example"]')!;
    expect(within(row).getByRole("link", { name: "Meal Planner" })).toHaveAttribute(
      "href",
      "/assets/meals.example",
    );
    // No source slots, no source marks; the month's money, the queue, and an
    // em dash wherever nothing was measured — never a zero.
    expect(row.querySelector('[aria-label="Data source integration states"]')).toBeNull();
    expect(row.textContent).not.toContain("Automation enabled");
    expect(row.textContent).toContain("not booked");
    expect(row.textContent).toContain("12 open");
    expect(row.textContent).toContain("3 urgent");
    expect(row.textContent).toContain("—");
  });

  it("offers All sites and counts them in the census once there are two (ro-ujb9.130)", () => {
    payload.assets = [
      SEEDED_ASSETS[0]!,
      { ...SEEDED_ASSETS[0]!, id: "second.example", displayName: "Second" },
    ];
    const { container } = renderHome();
    expect(container.querySelector("[data-portfolio-census]")!.textContent).toContain("2 sites · updated");
    expect(screen.getByRole("link", { name: "All sites →" })).toHaveAttribute("href", "/assets");
  });

  it("puts an open gate above a higher-priority ask in Waiting on you", () => {
    workState.data = workPayload([
      project("Meal Planner", [
        waiting({ id: "mp-9k1", priority: 0, title: "Top-priority ask" }),
      ]),
      project("NoticeOS", [
        waiting({
          id: "ro-3z7",
          priority: 3,
          issueType: "gate",
          title: "Approve the spend cap",
        }),
      ]),
    ]);

    renderHome();

    const rows = within(panelFor("Waiting on you")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // A gate holds a bead out of `bd ready`, so it leads regardless of its own
    // priority band.
    expect(rows[0]!.textContent).toContain("ro-3z7");
    // Doc 17: what the hub calls a "gate" reaches the operator as what it DOES.
    expect(rows[0]!.textContent).toContain("needs your approval");
    expect(rows[0]!.textContent).not.toContain("· gate");
    expect(rows[0]!.textContent).toContain("NoticeOS");
    expect(rows[1]!.textContent).toContain("mp-9k1");

    expect(screen.getByRole("link", { name: "All tasks →" })).toHaveAttribute(
      "href",
      "/tasks",
    );
  });

  it("tells an empty inbox apart from an inbox it has never seen", () => {
    workState.data = workPayload([project("Meal Planner", [])]);
    const clear = renderHome();
    expect(screen.getByText("Nothing is waiting on you.")).toBeInTheDocument();
    clear.unmount();

    workState.data = workPayload([project("Meal Planner", [])], null);
    renderHome();
    expect(screen.getByText("No tasks have been read yet.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing is waiting on you.")).toBeNull();
  });

  it("uses complete waiting totals and identifies the capped preview", () => {
    const capped = project("Meal Planner", Array.from({ length: 10 }, (_, index) =>
      waiting({ id: `mp-${index}`, title: `Request ${index + 1}` }),
    ));
    capped.counts.waiting = 24;
    workState.data = workPayload([capped]);
    renderHome();
    const panel = panelFor("Waiting on you");
    expect(panel).toHaveTextContent("24 waiting · 10 captured in preview");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(5);
    fireEvent.click(within(panel).getByRole("button", { name: "Show 5 more" }));
    expect(within(panel).getAllByRole("listitem")).toHaveLength(10);
    expect(panel).toHaveTextContent("24 waiting · 10 captured in preview");
    expect(within(panel).getByRole("link", { name: "All tasks →" })).toHaveAttribute("href", "/tasks");
  });

  it("names task update age separately from the fresh status read and premise verification", () => {
    workState.data = workPayload([project("Meal Planner", [waiting({ updatedAt: "2026-07-01T12:05:00.000Z" })])]);
    renderHome();
    const panel = panelFor("Waiting on you");
    expect(panel).toHaveTextContent("Task status read 10s ago");
    // The read's age and the preview's size are the facts; no info icon
    // explains the preview (bead ro-ujb9.96.6.12).
    expect(within(panel).queryByRole("button", { name: "What this task preview verifies" })).toBeNull();
    expect(panel).not.toHaveTextContent("Task status does not verify");
    expect(panel.querySelector("button button, a button")).toBeNull();
    const row = within(panel).getByRole("listitem");
    expect(row).toHaveTextContent("28d");
    expect(row).toHaveTextContent("updated");
    expect(within(row).queryByText("open")).toBeNull();
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
      const panel = panelFor("Waiting on you");
      expect(panel).not.toHaveTextContent("Nothing is waiting on you.");
      expect(panel).toHaveTextContent(/unknown/);
      if (failure === "stale snapshot") expect(panel).toHaveTextContent("stale snapshot");
      // The state is said once, in the header line; the empty row does not
      // repeat it (one status per subject).
      expect(panel.textContent!.match(/stale/g)?.length ?? 0).toBeLessThanOrEqual(1);
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
    const panel = panelFor("Waiting on you");
    expect(panel).toHaveTextContent("12+ waiting · partial read · 1 captured in preview");
    expect(panel).not.toHaveTextContent("111 waiting");
  });

  it("keeps an authoritative nonzero queue visible even when no rows were captured", () => {
    const emptyPreview = project("Meal Planner", []);
    emptyPreview.counts.waiting = 12;
    workState.data = workPayload([emptyPreview]);
    renderHome();
    const panel = panelFor("Waiting on you");
    expect(panel).toHaveTextContent("12 waiting");
    expect(panel).toHaveTextContent("No request details captured.");
    expect(panel).not.toHaveTextContent("Nothing is waiting on you.");
  });

  it("recovers from a failed initial read to an evidenced empty inbox", () => {
    workState.isError = true;
    const view = renderHome();
    expect(panelFor("Waiting on you")).toHaveTextContent("Could not refresh your tasks.");
    workState.isError = false;
    workState.data = workPayload([project("Meal Planner", [])]);
    view.rerender(<MemoryRouter><HomeRoute /></MemoryRouter>);
    expect(panelFor("Waiting on you")).toHaveTextContent("Nothing is waiting on you.");
    expect(panelFor("Waiting on you")).not.toHaveTextContent("Could not refresh");
  });

  it("shows five alerts and discloses the rest rather than dropping them", () => {
    payload.attention = Array.from({ length: 7 }, (_, index) =>
      alert({
        id: index + 1,
        message: `Alert ${index + 1}`,
        severity: index % 2 === 0 ? "error" : "warn",
      }),
    );

    const { container } = renderHome();

    const panel = panelFor("Alerts");
    const rows = within(panel).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    // Payload order, never re-sorted: the read model already ranks these.
    expect(rows[0]!.textContent).toContain("Alert 1");
    expect(screen.queryByText("Alert 6")).toBeNull();
    // A panel that silently kept five of seven would be lying about the size of
    // the queue: the header states the total and the expander names the rest.
    expect(within(panel).getByText("7 open")).toBeInTheDocument();
    expect(
      within(panel).getByRole("button", { name: "Show 2 more" }),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole("link", { name: "All alerts →" }),
    ).toHaveAttribute("href", "/alerts");

    // The strip is where the count and its severity split live — the panel
    // shows rows and never a second tally of the same fact.
    const kpi = kpiFor(container, "Open alerts");
    expect(within(kpi).getByText("7")).toBeInTheDocument();
    expect(within(kpi).getByText("4 errors")).toBeInTheDocument();
    expect(within(kpi).getByText("3 warnings")).toBeInTheDocument();
  });

  /** Doc 21's row: the evidence and the way through open IN PLACE, so reading
   * one alert never moves the rest of the page — and disposition stays on
   * `/alerts`, where the history is. */
  it("opens an alert row in place, and never states one fact twice", () => {
    payload.attention = [alert({ id: 4, message: "Signups well below normal" })];

    renderHome();

    const row = within(panelFor("Alerts")).getAllByRole("listitem")[0]!;
    expect(within(row).queryByRole("link")).toBeNull();
    // Its age is from the FIRST firing, and the row says so itself.
    expect(row).toHaveTextContent("first seen");

    fireEvent.click(within(row).getByRole("button"));

    // This rule has no translation, so the store's own words ARE the headline —
    // and the expanded row does not print them a second time.
    expect(within(row).getAllByText("Signups well below normal")).toHaveLength(1);
    expect(within(row).getByRole("link", { name: "Open Meal Planner" })).toHaveAttribute(
      "href",
      "/assets/meals.example",
    );
    // Still a reading surface: disposition is `/alerts`' business, and a
    // decision made from a five-row preview is made without the history.
    expect(within(row).queryByRole("button", { name: /Resolve/ })).toBeNull();
    expect(within(row).queryByRole("button", { name: /Mark alert read/ })).toBeNull();
  });

  /** Bead `ro-ujb9.199`: "Open <site>" used to open the Overview whatever the
   * site had collected. It goes where the sidebar sends the same site now —
   * its Data sources until its first number. */
  it("opens a site with no number yet on its Data sources, as the sidebar does", () => {
    const empty = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };
    payload.assets = [...SEEDED_ASSETS, { ...SEEDED_ASSETS[0]!, id: "fresh.example", displayName: "Fresh Example",
      pulseReceivedAt: null, firstReportAt: null, activeUsers: empty, searchClicks: empty,
      netByMonth: [], booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 }, forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
      dailyRevenue: undefined, dataSources: [], work: null,
    }];
    payload.attention = [alert({ id: 4, asset: "fresh.example", assetDisplayName: "Fresh Example" })];

    renderHome();

    const row = within(panelFor("Alerts")).getAllByRole("listitem")[0]!;
    fireEvent.click(within(row).getByRole("button"));
    expect(within(row).getByRole("link", { name: "Open Fresh Example" }))
      .toHaveAttribute("href", "/assets/fresh.example/sources");
  });

  /** `ro-kukv.6` / decision D15. Home shows the same one row the Wall and
   * `/alerts` show — the fact stated once, the assets on hover — and leaves the
   * four actions to `/alerts`, where this preview has always sent decisions. */
  it("shows assets that have never reported as ONE row, with no asset link and no chip", () => {
    payload.attention = [
      alert({
        id: 31,
        asset: "fees.example",
        assetDisplayName: "Fee Codes",
        severity: "error",
        ruleId: "ingest-freshness",
        ruleInputs: { rule: "ingest-freshness", state: "never-reported" },
        occurrences: 4,
        firstFiredAt: "2026-07-05T09:00:00.000Z",
        members: [
          { id: 31, asset: "fees.example", assetDisplayName: "Fee Codes", firedAt: "2026-07-05T09:00:00.000Z" },
          { id: 32, asset: "pullups.example", assetDisplayName: "Pull-up Standards", firedAt: "2026-07-06T09:00:00.000Z" },
          { id: 33, asset: "areas.info", assetDisplayName: "Area Lookup", firedAt: "2026-07-07T09:00:00.000Z" },
          { id: 34, asset: "pacer.example", assetDisplayName: "Pacer Test", firedAt: "2026-07-08T09:00:00.000Z" },
        ],
      }),
    ];

    renderHome();
    const row = within(panelFor("Alerts")).getAllByRole("listitem")[0]!;

    expect(row.textContent).toContain("Four sites have no nightly reports");
    // The assets it stands for are the caption; there is no single asset to
    // name, so the row names all four rather than the representative's.
    expect(row.textContent).toContain("Fee Codes, Pull-up Standards");
    // The count is of ASSETS, so the phrase that means re-firings stays away.
    expect(row.textContent).not.toContain("recurred");

    fireEvent.click(within(row).getByRole("button"));
    // …and the way through is `/alerts`, where the four expand into four
    // actions, not one asset page standing in for all of them.
    expect(within(row).getByRole("link", { name: "Open in Alerts" })).toHaveAttribute(
      "href",
      "/alerts",
    );
  });
});

/**
 * Bead ro-pbzu.8 — docs/14's 2026-09-04 rule on this page: *what does the eye
 * read before the words?* Each of these asserts one visual renders from real
 * data AND stays away when the data cannot support it, because a shape drawn
 * from nothing is the failure mode the rule is guarding against.
 */
describe("Home — a shape before the words", () => {
  const ASSETS = payload.assets;
  const OPERATOR = payload.operator;

  afterEach(() => {
    payload.assets = ASSETS;
    payload.operator = OPERATOR;
  });

  /** `days` consecutive daily points ending on the given date. */
  function daily(days: number, endsOn = "2026-07-29") {
    const end = Date.parse(`${endsOn}T00:00:00.000Z`);
    return Array.from({ length: days }, (_, index) => ({
      t: new Date(end - (days - 1 - index) * 86_400_000)
        .toISOString()
        .slice(0, 10),
      v: 100 + index,
    }));
  }

  /** The seeded site as the case needs it, beside a quiet second site: the
   * table these cases read is the several-site view (bead ro-ujb9.127). */
  function withAsset(overrides: Partial<(typeof ASSETS)[number]>) {
    payload.assets = [{ ...ASSETS[0]!, ...overrides }];
    withSecondSite();
  }

  describe("the Net KPI draws the portfolio's months under its figure", () => {
    /** The Sparkline's endpoint cap: hollow while the provider — here, the
     * month itself — has not closed the last point. */
    const endpointFill = (spark: Element) =>
      spark.querySelector("[data-chart-dot]")!.getAttribute("data-chart-dot") ?? "";

    it("charts every current row and hollows the month still being lived in", () => {
      payload.portfolio = {
        ...POPULATED_PORTFOLIO,
        netTrendAll: [
          { t: "2026-05", v: 40 },
          { t: "2026-06", v: 60 },
          { t: "2026-07", v: 80 },
        ],
      };

      const { container } = renderHome();

      const spark = kpiFor(container, "Net · Jul").querySelector("[data-spark]")!;
      expect(spark).not.toBeNull();
      // THE MONTHS THEMSELVES, not a seven-period mean of them: on a monthly
      // series the default averaging would flatten a six-month portfolio into a
      // line with no shape (bead ro-78qo.18). One path, because the KPI slot
      // draws no area — six filled shapes in a strip are a skyline, not six
      // trends.
      expect(spark.querySelectorAll("[data-chart-line]")).toHaveLength(1);
      expect(spark.querySelector("[data-chart-area]")).toBeNull();
      // July is open, so the last point is provisional and its cap goes hollow.
      expect(endpointFill(spark)).toBe("hollow");
    });

    it("reads a forecast-only EUR trend in the currency of its actual series", () => {
      payload.portfolio = {
        ...POPULATED_PORTFOLIO,
        booked: { currency: "EUR", revenue: 0, cost: 0, net: 0 },
        forecast: { currency: "EUR", revenue: 80, cost: 0, net: 80 },
        revenueRecorded: { booked: false, forecast: true },
        netTrend: [], netTrendCurrency: null, netTrendAllCurrency: "EUR",
        netTrendAll: [{ t: "2026-05", v: 40 }, { t: "2026-06", v: 60 }, { t: "2026-07", v: 80 }],
      };
      const { container } = renderHome();
      const kpi = kpiFor(container, "Net · Jul");
      fireEvent.focus(kpi.querySelector("[data-spark] svg")!);
      expect(kpi.querySelector('[data-status-for^="readout:"]')).toHaveTextContent("€80");
      expect(kpi.querySelector('[data-status-for^="readout:"]')).not.toHaveTextContent("Unavailable");
    });

    it("claims nothing is open when the headline fell back to a closed month", () => {
      payload.portfolio = {
        ...POPULATED_PORTFOLIO,
        period: "2026-08",
        periodIsCurrent: false,
        netTrendAll: [
          { t: "2026-06", v: 40 },
          { t: "2026-07", v: 60 },
          { t: "2026-08", v: 80 },
        ],
      };

      const { container } = renderHome();

      const spark = kpiFor(container, "Net · Aug").querySelector("[data-spark]")!;
      expect(spark).not.toBeNull();
      expect(endpointFill(spark)).toBe("solid");
    });

    it("draws no line below the three points that make a direction", () => {
      // The seed payload carries a single month — two dots joined by a segment
      // is a shape the eye reads as a trend and the data cannot support.
      const { container } = renderHome();
      expect(
        kpiFor(container, "Net · Jul").querySelector("[data-spark]"),
      ).toBeNull();
    });
  });

  it("shows what share of the inbox is urgent, and only on an exact count", () => {
    payload.operator = {
      waiting: 12,
      urgent: 3,
      measuredProjects: 1,
      urgentMeasuredProjects: 1,
      projectCount: 1,
      capturedAt: "2026-07-29T12:04:50.000Z",
    };
    const exact = renderHome();
    const bar = exact.container.querySelector("[data-inbox-urgency]")!;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute("aria-label")).toBe(
      "3 of 12 waiting on you are urgent",
    );
    expect(bar.querySelector('[data-segment="urgent"]')).not.toBeNull();
    expect(bar.querySelector('[data-segment="rest"]')).not.toBeNull();
    exact.unmount();

    // A project that could not supply an untruncated count makes BOTH figures
    // lower bounds ("3+ urgent · 12+ need you"), and a fraction of two lower
    // bounds is not a lower bound — it is a wrong fraction, drawn loud.
    payload.operator = { ...payload.operator, measuredProjects: 0, projectCount: 2 };
    const partial = renderHome();
    expect(partial.container.querySelector("[data-inbox-urgency]")).toBeNull();
    expect(kpiFor(partial.container, "Needs you")).toHaveAttribute("data-series", "unavailable");
    partial.unmount();

    // Nothing waiting: nothing to divide.
    payload.operator = OPERATOR;
    const empty = renderHome();
    expect(empty.container.querySelector("[data-inbox-urgency]")).toBeNull();
    expect(kpiFor(empty.container, "Needs you")).toHaveAttribute("data-series", "unavailable");
  });

  it("shows how much of the open-alert count is red", () => {
    payload.attention = Array.from({ length: 7 }, (_, index) =>
      alert({ id: index + 1, severity: index % 2 === 0 ? "error" : "warn" }),
    );

    const open = renderHome();
    const split = open.container.querySelector("[data-alert-split]")!;
    expect(split).not.toBeNull();
    expect(split.getAttribute("aria-label")).toBe(
      "4 of 7 open alerts are errors, 3 are warnings",
    );
    expect(split.querySelector('[data-segment="error"]')).not.toBeNull();
    expect(split.querySelector('[data-segment="warn"]')).not.toBeNull();
    open.unmount();

    // All clear is the tile's own state; a bar over zero would be a bar over
    // nothing.
    payload.attention = OPEN_ATTENTION;
    const clear = renderHome();
    expect(clear.container.querySelector("[data-alert-split]")).toBeNull();
    expect(kpiFor(clear.container, "Open alerts")).toHaveAttribute("data-series", "unavailable");
  });

  /**
   * The System KPI's shape is the coverage split, not a ring (design review on
   * `ro-78qo.6`). Two reasons and the second is the better one: the strip's
   * other counts are bars, so a third kind of graphic broke its grammar — and a
   * ring can only draw done-of-total, which cannot tell a portfolio that has
   * gone stale from one that never reported at all.
   */
  it("splits fresh, stale and unconfigured reporting without a fictitious error state", () => {
    payload.system = {
      ...payload.system,
      ingest: { fresh: 3, stale: 1, notExpected: 5, expected: 4 },
    };

    const covered = renderHome();
    const split = covered.container.querySelector("[data-coverage-split]")!;
    expect(split).not.toBeNull();
    // Read out as a SENTENCE, so the verbs agree with their counts — a
    // template with a hard-coded "are" says "1 are stale" on the day exactly
    // one asset goes quiet.
    expect(split.getAttribute("aria-label")).toBe(
      "3 of 4 sites owing a report sent a fresh one; 1 is stale",
    );
    // Current report state has only fresh/stale attention and neutral absence.
    expect(split.querySelector('[data-segment="fresh"]')!.className).toContain("bg-healthy");
    expect(split.querySelector('[data-segment="stale"]')!.className).toContain("bg-warn");
    expect(split.querySelector('[data-segment="never-reported"]')).toBeNull();
    // Pre-launch and retired assets are outside the fraction and inside the
    // bar, which is why the portfolio is bigger than the denominator.
    expect(split.querySelector('[data-segment="not-expected"]')).not.toBeNull();
    // The digits still say it; the bar is the shape beside them, never instead.
    expect(kpiFor(covered.container, "System").textContent).toContain("/ 4 fresh");
    // And the ring that read as a spinner is gone from the strip.
    expect(covered.container.querySelector("[data-progress-ring]")).toBeNull();
    covered.unmount();

    // Nothing expected to report: no denominator, so no fraction and no bar
    // over it — an empty track would read as a measured zero.
    payload.system = {
      ...payload.system,
      ingest: { fresh: 0, stale: 0, notExpected: 0, expected: 0 },
    };
    const nothing = renderHome();
    expect(nothing.container.querySelector("[data-coverage-split]")).toBeNull();
    expect(kpiFor(nothing.container, "System").textContent).toContain(
      "nothing expected to report",
    );
    expect(kpiFor(nothing.container, "System")).toHaveAttribute("data-series", "unavailable");
  });

  /**
   * The OS's own report is owed only where an OS row exists (bead
   * `ro-ujb9.161`). A new installation has none — `pnpm start`'s store and the
   * journey fixture both start without one — so red "no System report" beside
   * "nothing expected to report" contradicted itself on a stranger's first
   * screen. An installation WITH an OS row that sent nothing still says so in
   * error ink.
   */
  it("says no System report in red only when an OS row owes one", () => {
    const quiet = { fresh: 0, stale: 0, notExpected: 0, expected: 0 };
    payload.system = { ...payload.system, assetId: null, hasPulse: false, ingest: quiet };
    const fresh = renderHome();
    const tile = kpiFor(fresh.container, "System");
    expect(tile.textContent).not.toContain("System report");
    expect(tile.querySelector(".text-error")).toBeNull();
    fresh.unmount();

    payload.system = { ...payload.system, assetId: "os.example", hasPulse: false };
    const silent = kpiFor(renderHome().container, "System");
    const missing = [...silent.querySelectorAll(".text-error")].find((node) => node.textContent === "no System report");
    expect(missing).toBeDefined();
  });

  /**
   * The setup ring LEFT this row on 2026-09-05 (design review on `ro-78qo.6`).
   * `ro-28ma` put it here as a third fact — the stage word says which stage, the
   * ring how far through its checklist — and the argument still holds where
   * there is room for it. There is none here: at 16px, beside the mode glyph, a
   * part-filled segmented ring reads as a spinner, and it drew on five of six
   * rows, so the column's loudest shape was the one nobody could decode. The
   * fraction is stated in words on the asset's own header instead.
   */
  describe("the assets table's State cell", () => {
    const ONBOARDING = {
      status: "onboarding",
      displayName: "Meal Planner",
      pulseReceivedAt: "2026-07-29T11:00:00.000Z",
      firstReportAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
      dataSources: [
        { id: "nightly-report", label: "Nightly report", state: "live" as const, observedAt: "2026-07-29T11:00:00.000Z", verification: { kind: "collection-success" as const, laneId: "nightly-report" } },
        { id: "gsc", label: "Google Search Console", state: "live" as const, observedAt: "2026-07-29T11:00:00.000Z" },
        { id: "ga4", label: "Google Analytics 4", state: "needs-setup" as const },
      ],
    };

    it("shows each source's status instead of a manual lifecycle — and no progress ring", () => {
      withAsset(ONBOARDING);

      const { container } = renderHome();
      const row = container.querySelector('[data-asset-row="meals.example"]')!;
      const cell = row.querySelector('td[data-label="State"]')!;

      expect([...cell.querySelectorAll('[data-source]')].map((mark) => mark.getAttribute("aria-label"))).toEqual([
        "Nightly report: Working",
        "Google Search Console: Unknown",
        "Google Analytics 4: Unknown",
      ]);
      expect(cell.textContent).not.toContain("Onboarding");
      expect(cell.textContent).not.toContain("Automation enabled");
      expect(cell.querySelector("[data-severity-dot], [aria-label]")).not.toBeNull();
      // The shape that read as a spinner is gone from the whole row.
      expect(row.querySelector("[data-progress-ring]")).toBeNull();
    });

    it("does not confuse automation permission with observed data health", () => {
      withAsset({ ...ONBOARDING, senseOnly: true });

      const monitored = renderHome();
      const watching = monitored.container.querySelector('td[data-label="State"]')!;
      expect(watching.querySelector('[aria-label="Nightly report: Working"]')).not.toBeNull();
      monitored.unmount();

      withAsset({ ...ONBOARDING, senseOnly: false });
      const acting = renderHome().container.querySelector('td[data-label="State"]')!;
      expect(acting.querySelector('[aria-label="Nightly report: Working"]')).not.toBeNull();
    });
  });

  describe("the assets table's 28-day users column", () => {
    it("draws the series at doc 21's cell size, with no bands and no labels", () => {
      withAsset({
        activeUsers: {
          series: daily(28),
          provisionalFrom: "2026-07-29",
          collectedAt: "2026-07-29T12:00:00.000Z",
          timeZoneChanges: [],
        },
      });

      const { container } = renderHome();

      // Short enough to stay on ONE line: "USERS · TODAY" and "7-DAY" each broke
      // across two, which costs the table a whole row of height to say less.
      // The method is the line's own readout (asserted below), not a third
      // phrase on the header (bead ro-ujb9.96.6.10).
      expect(screen.getByRole("columnheader", { name: "Users · 28d" })).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "Daily users" })).toBeInTheDocument();
      const cell = container.querySelector("[data-users-spark]")!;
      expect(cell).not.toBeNull();
      // `Sparkline` at `size="cell"` — 96×24, one of the three sizes doc 21
      // allows, so five call sites cannot land on five nearly-equal rectangles.
      const svg = cell.querySelector("svg")!;
      expect(svg.getAttribute("viewBox")).toBe("0 0 96 24");
      // A wordless line and nothing else: anything needing an axis, week bands
      // or range labels is a `HeroChart`, not a table cell.
      expect(cell.querySelector("[data-week-band]")).toBeNull();
      expect(cell.querySelector("[data-chart-ranges]")).toBeNull();
      expect(cell.querySelector("[data-chart-axis]")).toBeNull();
      expect(within(cell as HTMLElement).getByRole("img")).toHaveAccessibleDescription(/trailing 7-day average/);
      const visibleCell = cell.cloneNode(true) as HTMLElement;
      visibleCell.querySelectorAll(".sr-only, title").forEach((node) => node.remove());
      expect(visibleCell.textContent).toBe("");
      // Today-so-far never poses as a settled reading: the loudest ink on the
      // line goes hollow while the provider is still counting the day.
      expect(svg.querySelector("[data-chart-dot]")!.getAttribute("data-chart-dot")).toBe("hollow");
    });

    // NINE COLUMNS THAT FIT THE CARD (bead `ro-pbzu.10`). At 1440 the card is
    // ~1142px and the row's natural width was 1201: the last two columns went
    // over the edge, "Last report" wrapped to "LAS / REPORT" and its cell was
    // cut mid-word. Four cells were holding that width open — three phrases
    // pinned with `whitespace-nowrap`, and a sparkline at a fixed `w-24` — and
    // a truncating asset name whose `truncate` (which carries nowrap) made the
    // column's MINIMUM the whole name.
    //
    // jsdom has no layout, so what is pinned here is the mechanism, not the
    // pixels: the classes that decide whether a column can give anything back.
    // Measured in a browser at 1440x900 and 1280x900 with two sites and a task
    // source (docs/artifacts/site-table-fit-2026-09-24, bead ro-ujb9.163), the
    // table's overflow is 0px at both; at 1280 it had crept back to 52px here
    // and 129px on /assets, cutting off Reported, as columns arrived.
    it("lets every column give width back, so ten of them fit the card", () => {
      withAsset({
        activeUsers: {
          series: daily(28),
          provisionalFrom: "2026-07-29",
          collectedAt: "2026-07-29T12:00:00.000Z",
          timeZoneChanges: [],
        },
      });

      const { container } = renderHome();
      const row = container.querySelector('[data-asset-row="meals.example"]')!;
      const cellFor = (label: string) =>
        row.querySelector<HTMLElement>(`td[data-label="${label}"]`)!;

      // The two phrases left. Each still renders in full; neither may hold its
      // column open at any width.
      for (const cell of [row.querySelector<HTMLElement>('td[data-label^="Net · "]')!, cellFor("Tasks")]) {
        expect(cell.className).not.toContain("whitespace-nowrap");
      }
      // STATE FITS ON ONE LINE NOW, so it can be nowrap: the mode is a glyph
      // rather than "· Automation enabled", which is what used to wrap every
      // row onto a second line. The cap is still what decides which column
      // gives when the table is tight.
      expect(cellFor("State").querySelector(".whitespace-nowrap")).toBeNull();
      // The permission is still stated — as a shape, a hover sentence and an
      // accessible word, never as colour alone.
      const mode = cellFor("State").querySelector('[title*="approved automation"]')!;
      expect(mode).toBeNull();

      // The trend cell is doc 21's fixed 96px `cell` sparkline now, so it is no
      // longer one of the columns the table negotiates with — which is why the
      // cap above had to grow by one step to keep the other eight honest.
      expect(row.querySelector("[data-users-spark] svg")!.getAttribute("viewBox")).toBe(
        "0 0 96 24",
      );

      // The identity cap is what makes the name's truncation real. It tightened
      // by one step when the search-clicks column arrived (`ro-78qo.35`): a
      // name is the column that can most afford to give width back.
      expect(row.querySelector(".max-w-44")).not.toBeNull();

      // A 13-INCH LAPTOP'S CARD (bead ro-ujb9.163). Below 64rem of box — 982px
      // at 1280 — the columns sit closer (8px a side, not 12), the name gives
      // one more step, and today's pace drops under its figure rather than
      // holding that column open. No column leaves.
      const table = container.querySelector("table")!;
      expect(table.className).toContain("@min-[40rem]:@max-[64rem]:[&_td]:px-2");
      expect(table.className).toContain("@min-[40rem]:@max-[64rem]:[&_th:not([aria-sort])]:px-2");
      expect(row.querySelector(".max-w-44")!.className).toContain("@max-[64rem]:max-w-36");
      expect(cellFor("Daily users").querySelector("[data-users-day] > span")!.className).toContain("flex-wrap");

      // NINE COLUMNS OF FACT. `ro-78qo.35` added the search-clicks line and put
      // net's own months under its figure, which took the table past the width
      // the shell leaves it — so the one column that was never a fact went: the
      // chevron. The row still says it opens, through the pointer cursor, the
      // hover ground and the asset name being a real link. EIGHT since bead
      // `ro-ujb9.96.6.10`: the range's move rides the users line it describes
      // instead of a column of its own that needed a paragraph to explain.
      expect(row.querySelectorAll("td")).toHaveLength(8);
      expect(row.querySelector(".lucide-chevron-right")).toBeNull();
    });

    it("says nothing below the three points that make a direction", () => {
      withAsset({
        activeUsers: {
          series: daily(2),
          provisionalFrom: null,
          collectedAt: null,
          timeZoneChanges: [],
        },
      });

      const { container } = renderHome();

      expect(container.querySelector("[data-users-spark]")).toBeNull();
      const row = container.querySelector('[data-asset-row="meals.example"]')!;
      expect(row.textContent).toContain("—");
    });
  });

  it("puts the queue's shape beside its counts, and none where none was measured", () => {
    withSecondSite();
    const distributed = renderHome();
    const bar = distributed.container
      .querySelector('[data-asset-row="meals.example"]')!
      .querySelector("[data-priority-bar]")!;
    expect(bar).not.toBeNull();
    // The seed asset's [1, 2, 8, 3, 1]: the two hot bands are drawn, so the row
    // says WHAT KIND of 12 this is rather than only that it is 12.
    expect(bar.querySelector('[data-priority-band="top"]')).not.toBeNull();
    expect(bar.querySelector('[data-priority-band="high"]')).not.toBeNull();
    distributed.unmount();

    // No distribution in the snapshot means no bar — never a flat one invented
    // from the total.
    withAsset({ work: { ...ASSETS[0]!.work!, priorities: null } });
    expect(renderHome().container.querySelector("[data-priority-bar]")).toBeNull();
  });

  /**
   * The ledger's honesty split is still on every figure — but it is said ONCE
   * where the whole column agrees, and per-row only where a row differs from
   * its header (bead `ro-78qo.6`). Six identical "Forecast" chips down a column
   * are one fact printed six times, in the loudest thing in the cell.
   */
  it("says the booking state once in the header, and marks only the exception", () => {
    withAsset({ booked: { currency: 'USD', revenue: 300, cost: 100, net: 200 } });
    const reconciled = renderHome();
    const bookedRow = reconciled.container.querySelector('[data-asset-row="meals.example"]')!;
    // One asset, one state: the header speaks for the column…
    expect(
      screen.getByRole("columnheader", { name: /Net · Jul\s*· reconciled/ }),
    ).toBeInTheDocument();
    // …so the row states the figure and nothing else.
    expect(bookedRow.textContent).toContain("$200");
    expect(bookedRow.textContent).not.toContain("Reconciled");
    expect(bookedRow.textContent).not.toContain("Forecast");
    reconciled.unmount();

    withAsset({ forecast: { currency: 'USD', revenue: 90, cost: 0, net: 90 } });
    const estimated = renderHome();
    expect(
      screen.getByRole("columnheader", { name: /Net · Jul\s*· forecast/ }),
    ).toBeInTheDocument();
    expect(
      estimated.container.querySelector('[data-asset-row="meals.example"]')!.textContent,
    ).not.toContain("Forecast");
    estimated.unmount();

    // TWO KINDS IN ONE COLUMN and the header cannot speak for it, so each row
    // says which it is — which is the state the chips existed for.
    payload.assets = [
      { ...SEEDED_ASSETS[0]!, booked: { currency: 'USD', revenue: 300, cost: 100, net: 200 } },
      {
        ...SEEDED_ASSETS[0]!,
        id: "nosh.example",
        displayName: "Nosh",
        forecast: { currency: 'USD', revenue: 90, cost: 0, net: 90 },
      },
    ];
    const mixed = renderHome();
    expect(
      screen.getByRole("columnheader", { name: "Net · Jul" }),
    ).toBeInTheDocument();
    expect(
      mixed.container.querySelector('[data-asset-row="meals.example"]')!.textContent,
    ).toContain("Reconciled");
    expect(
      mixed.container.querySelector('[data-asset-row="nosh.example"]')!.textContent,
    ).toContain("Forecast");
  });

  it("gives every waiting row the Tasks board's ask face — warn at every priority, a gate's △ (ro-ujb9.240)", () => {
    workState.data = workPayload([
      project("NoticeOS", [
        waiting({ id: "ro-3z7", priority: 3, issueType: "gate", title: "Approve the cap" }),
      ]),
      project("Meal Planner", [
        waiting({ id: "mp-9k1", priority: 0, title: "Top-priority ask" }),
        waiting({ id: "mp-2b4", priority: 1, title: "High-priority ask" }),
        waiting({ id: "mp-7c3", priority: 2, title: "Default-priority ask" }),
      ]),
    ]);

    renderHome();

    const rows = within(panelFor("Waiting on you")).getAllByRole("listitem");
    // A task's priority is not a severity (doc 14): an ask waiting on the
    // operator is warn at every band, a top one too — the same amber ring it
    // wears one click later on /tasks. It used to be red at P0, beside real
    // failures. Priority is the ORDER the rows arrive in, not their colour.
    expect(rows.map(rowTone)).toEqual([
      "text-warn",
      "text-warn",
      "text-warn",
      "text-warn",
    ]);
    // Never colour-only: the ring carries the tone and the mark the meaning, so
    // a gate holding other work (`△`) reads differently from an ask (`!`) on a
    // grayscale screen — the board's inbox marks, exactly.
    expect(rows.map((row) => row.querySelector("[aria-hidden]")!.textContent)).toEqual([
      "△",
      "!",
      "!",
      "!",
    ]);
    // The MEANING survives where a reader can read it: this row is holding work
    // out of the ready queue until it is answered, and that is not something a
    // colour can say — nor is "gate", which is the hub's word (doc 17).
    expect(rows[0]!.textContent).toContain("needs your approval");
    expect(rows[0]!.textContent).toContain("ro-3z7");
    expect(rows[3]!.textContent).not.toContain("needs your approval");
  });
});

// The dot beside a site in the nav is its worst OPEN ALERT, and it says so:
// read as a bare "Error" it was taken for a data source's status, which has its
// own marks (bead ro-32ry).
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

    // Home states the urgent count in its assets table and links to the board.
    withSecondSite();
    const home = renderHome();
    expect(home.container.textContent).toContain("3 urgent");
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

  it("says so in one line on Home rather than leaving a hole in the strip", () => {
    payload.portfolio = nothing;

    const { container } = renderHome();

    const money = kpiFor(container, "Net · Jul");
    // A DASH, not $0: a zero would claim a month was counted and came to
    // nothing. The reason rides the caption where the composition usually is.
    expect(within(money).getByText("—")).toBeInTheDocument();
    expect(money.textContent).toContain("no revenue or costs for Jul yet");
    expect(money.querySelector("[data-spark]")).toBeNull();
    expect(screen.queryByText(/· estimated/)).toBeNull();
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


it("Home composition evidence opens by focus and tap (ro-ujb9.241)", () => {
  const previousOperator = payload.operator;
  payload.operator = { waiting: 4, urgent: 1, measuredProjects: 1, urgentMeasuredProjects: 1,
    projectCount: 1, capturedAt: "2026-07-29T12:04:50.000Z" };
  payload.attention = [alert({ id: 1, severity: "error" }), alert({ id: 2, severity: "warn" })];
  payload.system = { ...payload.system, ingest: { fresh: 1, stale: 1, notExpected: 1, expected: 2 } };
  try {
    renderHome();
    for (const [name, evidence] of [["Needs you", "1 urgent of the 4 waiting on you."],
      ["Open alerts", "1 error and 1 warning flags are open."],
      ["System", "1 fresh · 1 stale · 1 not expected to report"]]) {
      const trigger = screen.getByRole("button", { name: `About ${name}` });
      fireEvent.focus(trigger);
      expect(screen.getByRole("tooltip")).toHaveTextContent(evidence!);
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.click(trigger);
      expect(screen.getByRole("tooltip")).toHaveTextContent(evidence!);
      fireEvent.keyDown(window, { key: "Escape" });
    }
  } finally { payload.operator = previousOperator; }
});
