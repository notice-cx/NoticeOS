import { render, screen, within } from "./render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetCard, CardChannels, CardDataSource, CardProduct, SeriesPoint, SignalTrend, WallPayload } from "@shared/wall";
import type { WorkPayload } from "@shared/work";

// Home's four business modules (site health, the agents' week, where visitors
// come from, what is worth a look) and the views that draw them. The wall,
// work and provider reads are mocked; the stored view choice and the cards
// are the inputs that vary.

const ZERO = { currency: "USD", revenue: 0, cost: 0, net: 0 };
const NO_TREND: SignalTrend = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };

function card(id: string, over: Partial<AssetCard> = {}): AssetCard {
  return {
    id, displayName: id, status: "live", senseOnly: false, worstSeverity: null, openError: 0, openWarn: 0,
    booked: ZERO, forecast: ZERO, netPeriod: "2026-10", netByMonthCurrency: "USD",
    pulseReceivedAt: "2026-10-19T02:00:00.000Z", firstReportAt: null, dataSources: [],
    activeUsers: NO_TREND, searchClicks: NO_TREND, netByMonth: [], netByMonthProvisionalFrom: null,
    work: null, panelReview: null, latestPanelDate: null,
    ...over,
  };
}

const uptime: CardDataSource = { id: "uptime", label: "Uptime", state: "live" };

function product(over: Partial<CardProduct> = {}): CardProduct {
  return {
    observedAt: "2026-10-18T06:00:00.000Z", speed: "clear", worstSpeed: "good", errors: "clear",
    errorPeople: 0, jsErrorFinding: false, funnel: null, ...over,
  };
}

/** 56 finished days at a steady level: four weeks against four weeks. */
function clicks(perDay: number): SignalTrend {
  const start = Date.parse("2026-08-23T00:00:00.000Z");
  const series: SeriesPoint[] = Array.from({ length: 56 }, (_, index) => ({
    t: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
    v: perDay,
  }));
  return { series, provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };
}

const codebase = { date: "2026-10-18", commit: "abc1234", codeLines: 40_000, growthPercent30d: 4, comparedDays: 30 };

/** Every fact measured and fine. */
const healthy = (id: string, over: Partial<AssetCard> = {}) =>
  card(id, { dataSources: [uptime], product: product(), searchClicks: clicks(100), codebase, ...over });

const state = vi.hoisted(() => ({
  payload: null as unknown as WallPayload,
  work: undefined as WorkPayload | undefined,
}));

function wall(assets: AssetCard[]): WallPayload {
  return {
    generatedAt: "2026-10-19T12:00:00.000Z",
    portfolio: {
      netTrendCurrency: "USD", netTrendAllCurrency: "USD", period: "2026-10", periodIsCurrent: true,
      booked: { currency: "USD", revenue: 100, cost: 20, net: 80 },
      forecast: { currency: "USD", revenue: 45, cost: 0, net: 45 },
      netTrend: [{ t: "2026-10", v: 80 }], netTrendAll: [{ t: "2026-10", v: 80 }], trendGranularity: "monthly",
      bookedDelta: null, residue: { booked: ZERO, forecast: ZERO }, firstRun: false, daysIn: 19,
    },
    system: {
      assetId: "root-os", hasPulse: true, spendTodayUsd: 1, dailyCapUsd: 2,
      ingest: { fresh: 1, stale: 0, notExpected: 0, expected: 1 },
      scheduledLanes: [{ job: "backup", outcome: "ran", startedAt: "2026-10-19T11:00:00.000Z", lastRanAt: "2026-10-19T11:00:00.000Z", failedRuns: 0, failingSince: null }],
    },
    dashboard: {},
    assets,
    attention: [],
    snoozed: [],
    operator: { waiting: 0, urgent: 0, measuredProjects: 1, urgentMeasuredProjects: 1, projectCount: 1, capturedAt: "2026-10-19T12:00:00.000Z" },
    ledgerRecordedAt: "2026-10-19T12:00:00.000Z",
  } as unknown as WallPayload;
}

vi.mock("@/hooks/useWall", () => ({ useWall: () => ({ data: state.payload, isError: false, isPending: false }) }));
vi.mock("@/hooks/useWork", () => ({ useWork: () => ({ data: state.work, isError: false, isPending: state.work === undefined }) }));
vi.mock("@/hooks/useIntegrationProviders", () => ({
  INTEGRATION_PROVIDERS_KEY: ["integration-providers"],
  useIntegrationProviders: () => ({ data: undefined, isPending: true, isError: false }),
}));
vi.mock("@/hooks/useIntegrationHealth", () => ({
  INTEGRATION_HEALTH_KEY: ["integration-health"],
  useIntegrationHealth: () => ({ data: undefined, isError: false, status: { kind: "unknown" } }),
}));
vi.mock("@/hooks/useAssetDetail", () => ({ useAssetDetail: () => ({ data: undefined, isFetching: false, error: null }) }));
vi.mock("@/hooks/useNow", () => ({ useNow: () => Date.parse("2026-10-19T12:05:00.000Z") }));
vi.mock("@/hooks/useWallFeed", () => ({
  useWallFeed: () => ({ data: { generatedAt: "2026-10-19T12:05:00.000Z", since: "2026-10-19T01:00:00.000Z", items: [], limit: 50 }, isError: false }),
}));
vi.mock("@/hooks/useSettings", () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

import { HomeRoute } from "@/routes/HomeRoute";
import { ChannelsModule, channelShares } from "@/routes/home/ChannelsModule";
import { FactoryModule } from "@/routes/home/FactoryModule";
import { GapsModule } from "@/routes/home/GapsModule";
import { HealthModule } from "@/routes/home/HealthModule";
import { storageKey } from "@/lib/browser-storage";

afterEach(() => {
  window.localStorage.removeItem(storageKey("view"));
  state.work = undefined;
});

function storeView(view: string, focus: string[] = []) {
  window.localStorage.setItem(storageKey("view"), JSON.stringify({ view, focus }));
}

function tree(children: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const renderHome = () => render(tree(<HomeRoute />));

/** The board's grid: the second child of the brief, under the answer. */
const grid = (container: HTMLElement) => container.querySelector("[data-home-brief]")!.children[1]!;

/** The modules in the order drawn, read off each region's own marker; a
 * stacked column contributes its members in order. */
function modulesDrawn(container: HTMLElement): string[] {
  if (grid(container).getAttribute("data-home-layout") === "stacks") {
    return [...grid(container).querySelectorAll("[data-home-module]")].map((el) => el.getAttribute("data-home-module")!);
  }
  const drawn: string[] = [];
  for (const child of [...grid(container).children]) {
    const module = child.getAttribute("data-home-module");
    if (module) drawn.push(module);
    else if (child.hasAttribute("data-surface-hero")) drawn.push("money");
    else if (child.hasAttribute("data-home-health")) drawn.push("sources");
    else if (child.hasAttribute("data-home-timeline")) drawn.push("timeline");
    else if (child.querySelector("[data-one-site-lead], [data-portfolio-rows]")) drawn.push("sites");
    else if (child.textContent?.includes("Revenue, yesterday")) drawn.push("yesterday");
    else {
      for (const member of [...child.children]) {
        if (member.hasAttribute("data-incident-list")) drawn.push("problems");
        else if (member.hasAttribute("data-decision-queue")) drawn.push("decide");
        else if (member.hasAttribute("data-home-agents")) drawn.push("agents");
        else drawn.push("unknown");
      }
    }
  }
  return drawn;
}

/** The rows of a stacked board: a full-width module, or the two columns'
 * modules in order. */
function rowsOf(container: HTMLElement): Array<{ full: string } | { wide: string[]; narrow: string[] }> {
  const board = grid(container);
  expect(board).toHaveAttribute("data-home-layout", "stacks");
  return [...board.children].map((row) => {
    const own = row.getAttribute("data-home-module");
    if (own) return { full: own };
    const members = (stack: string) =>
      [...(row.querySelector(`:scope > [data-home-stack="${stack}"]`)?.children ?? [])].map((el) => el.getAttribute("data-home-module")!);
    return { wide: members("wide"), narrow: members("narrow") };
  });
}

/** Every stack is a flex column with the grid's gap that falls back to one
 * column below the twelve-column width, and no module is stretched to its
 * neighbour's height. */
function expectContentHeight(container: HTMLElement) {
  for (const row of grid(container).querySelectorAll("[data-home-row]")) {
    expect(row.className.split(" ")).toEqual(["grid", "items-start", "gap-5", "@6xl:grid-cols-12", "[&>*]:min-w-0"]);
  }
  for (const stack of grid(container).querySelectorAll("[data-home-stack]")) {
    expect(stack).toHaveClass("flex", "flex-col", "gap-5");
    expect(stack.className).not.toMatch(/(^| )(h-full|items-stretch|grid-cols-2)( |$)/);
  }
  const modules = [...grid(container).querySelectorAll("[data-home-module]")];
  expect(modules.length).toBeGreaterThan(0);
  for (const module of modules) {
    const name = module.getAttribute("data-home-module");
    // A block wrapper, so nothing inside it grows to fill a flex track.
    expect(module.className, `${name} wrapper`).toBe("min-w-0");
    // A module beside others: neither its region nor the frame inside it
    // takes a percentage height.
    if (!module.closest("[data-home-stack]")) continue;
    for (const el of [module.firstElementChild, module.firstElementChild?.firstElementChild]) {
      if (el) expect(el.getAttribute("class") ?? "", `${name} stretches`).not.toMatch(/(^| )(h-full|self-stretch)( |$)/);
    }
  }
}

describe("the views draw their modules", () => {
  it("leaves Everything's grid exactly as it was with no choice stored", () => {
    state.payload = wall([card("first.example.com"), card("second.example.com")]);
    const { container } = renderHome();

    expect(modulesDrawn(container)).toEqual(["money", "yesterday", "sources", "problems", "decide", "sites", "timeline"]);
    expect(grid(container).getAttribute("class")).toBe("grid gap-5 @3xl:grid-cols-2 @6xl:grid-cols-12 [&>*]:min-w-0");
    expect([...grid(container).children].map((child) => child.getAttribute("class"))).toEqual([
      "@3xl:col-span-2 @6xl:col-span-8",
      "grid gap-5 @3xl:col-span-2 @3xl:grid-cols-2 @6xl:col-span-4 @6xl:grid-cols-1",
      "self-start rounded-xl bg-card p-5 ring-1 ring-border/70 @3xl:col-span-2 @6xl:col-span-8",
      "grid content-start items-start gap-5 @3xl:col-span-2 @3xl:grid-cols-2 @6xl:col-span-4 @6xl:grid-cols-1 [&>*]:min-w-0",
      "@3xl:col-span-2 @6xl:col-span-12",
      "rounded-xl bg-card px-5 py-4 ring-1 ring-border/70 @3xl:col-span-2 @6xl:col-span-12",
    ]);
    expect(container.querySelector("[data-home-module]")).toBeNull();
    expect(container.querySelector("[data-home-answer-health]")).toBeNull();
    expect(container.querySelector("[data-home-answer] h2")!.textContent).toBe("October so far $45 est. Nothing is broken.");
  });

  it("draws health, money, the agents' week and decide for the business view, in that order", () => {
    storeView("business");
    state.payload = wall([healthy("first.example.com"), card("second.example.com")]);
    const { container } = renderHome();

    expect(modulesDrawn(container)).toEqual(["health", "money", "factory", "decide"]);
    // Health is a row of its own; money and the agents' week stack on the
    // left, Decide on the right.
    expect(rowsOf(container)).toEqual([{ full: "health" }, { wide: ["money", "factory"], narrow: ["decide"] }]);
    expectContentHeight(container);
  });

  it("puts the agents' week first for the business view's agents pick", () => {
    storeView("business", ["agents"]);
    state.payload = wall([healthy("first.example.com")]);
    const { container } = renderHome();

    expect(modulesDrawn(container)).toEqual(["factory", "health", "money", "decide"]);
  });

  it("draws money, channels, gaps, problems, decide and the sites for the product view", () => {
    storeView("product");
    state.payload = wall([card("first.example.com"), card("second.example.com")]);
    const { container } = renderHome();

    // Problems under money and channels, so the left column is not the short one.
    expect(modulesDrawn(container)).toEqual(["money", "channels", "problems", "gaps", "decide", "sites"]);
    expect(rowsOf(container)).toEqual([
      { wide: ["money", "channels", "problems"], narrow: ["gaps", "decide"] },
      { full: "sites" },
    ]);
    expectContentHeight(container);
  });

  it("stacks the business view's agents pick in its own row above health", () => {
    storeView("business", ["agents"]);
    state.payload = wall([healthy("first.example.com")]);
    const { container } = renderHome();

    expect(rowsOf(container)).toEqual([
      { wide: ["factory"], narrow: [] },
      { full: "health" },
      { wide: ["money"], narrow: ["decide"] },
    ]);
  });

  it("leads the business view's answer with the sites' health", () => {
    storeView("business");
    state.payload = wall([
      healthy("first.example.com", { displayName: "First Site" }),
      healthy("second.example.com", { displayName: "Second Site", product: product({ speed: "fired" }) }),
      card("third.example.com", { status: "pre-launch" }),
    ]);
    const { container } = renderHome();

    const answer = container.querySelector("[data-home-answer-health]")!;
    expect(answer.textContent).toBe("1 of 2 sites are fine. Second Site: slow for 1 in 4 visitors. October so far $45.");
    expect(answer.firstElementChild).toHaveClass("text-warn");
  });

  it("names a site whose nightly report is late, and never calls it fine", () => {
    storeView("business");
    // 49 hours before the clock (12:05): past twice the nightly cadence.
    state.payload = wall([
      healthy("brief.example.com", { displayName: "Brief Site", pulseReceivedAt: "2026-10-17T11:05:00.000Z" }),
      healthy("second.example.com", { displayName: "Second Site" }),
    ]);
    const { container } = renderHome();

    expect(container.querySelector("[data-home-answer-health]")!.textContent).toMatch(/^1 of 2 sites are fine\. Brief Site: no report for 2 days\./);
    const row = container.querySelector<HTMLElement>('[data-site-health-row="brief.example.com"]')!;
    expect(row).toHaveAttribute("data-tech-health", "watch");
    expect(row.querySelector("[data-site-health-note]")!.textContent).toBe("No report for 2 days");
  });

  it("calls an estimated month \"so far\" in the business view and \"est.\" elsewhere", () => {
    state.payload = wall([healthy("first.example.com")]);
    storeView("business");
    const business = renderHome();
    expect(business.container.querySelector("[data-money-figure]")!.textContent).toBe("$45so far");
    // "So far" once: beside the figure, not in the label above it, and no "est." in the answer.
    expect(business.container.querySelector("[data-money-figure]")!.previousElementSibling!.textContent).toBe("Revenue, October");
    expect(business.container.querySelector("[data-home-answer-health]")!.textContent).toContain("October so far $45.");
    expect(business.container.querySelector("[data-home-answer-health]")!.textContent).not.toContain("est.");
    business.unmount();

    storeView("product");
    const product = renderHome();
    expect(product.container.querySelector("[data-money-figure]")!.textContent).toBe("$45est.");
    expect(product.container.querySelector("[data-money-figure]")!.previousElementSibling!.textContent).toBe("Revenue, October so far");
    expect(product.container.querySelector("[data-home-answer] h2")!.textContent).toMatch(/^October so far \$45 est\. /);
    product.unmount();

    storeView("everything");
    const everything = renderHome();
    expect(everything.container.querySelector("[data-money-figure]")!.previousElementSibling!.textContent).toBe("Revenue, October so far");
  });

  it("says every measured site is fine when none needs a look", () => {
    storeView("business");
    state.payload = wall([healthy("first.example.com"), healthy("second.example.com")]);
    const { container } = renderHome();

    expect(container.querySelector("[data-home-answer-health]")!.textContent).toMatch(/^All 2 sites are fine\./);
  });
});

describe("the site-health module", () => {
  const cards = [
    healthy("fine.example.com", { displayName: "Fine Site" }),
    healthy("slow.example.com", { displayName: "Slow Site", product: product({ speed: "fired", errors: "fired", errorPeople: 3 }) }),
    card("new.example.com", { displayName: "New Site", status: "pre-launch" }),
  ];

  const row = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-site-health-row="${id}"]`)!;

  it("draws one row per site under one header of five facts", () => {
    const { container } = render(tree(<HealthModule cards={cards} issues={[]} />));

    expect([...container.querySelectorAll("[data-fact-header]")].map((el) => el.textContent)).toEqual(["Up", "Speed", "Errors", "Search", "Code"]);
    expect(container.querySelectorAll("[data-site-health-row]")).toHaveLength(3);
    // One column template for the header and every row, so each word sits
    // over its own dots: on a phone (below `@md`) the name takes its own line
    // and the five dots share the width, each column at least a header wide.
    const header = container.querySelector<HTMLElement>("[data-site-health-header]")!;
    const template = (el: HTMLElement) => el.className.split(" ").filter((c) => /grid-cols/.test(c));
    expect(template(header)).toEqual(["grid-cols-5", "@md:grid-cols-[minmax(0,1fr)_repeat(5,3rem)]", "@2xl:grid-cols-[minmax(8rem,14rem)_repeat(5,3rem)_minmax(0,1fr)]"]);
    for (const site of container.querySelectorAll<HTMLElement>("[data-site-health-row]")) {
      expect(template(site)).toEqual(template(header));
      expect(site.querySelector("a")).toHaveClass("col-span-full", "@md:col-span-1");
    }
    expect(header.firstElementChild).toHaveClass("hidden", "@md:block");
    expect(within(row(container, "fine.example.com")).getByRole("link", { name: /Fine Site/ })).toHaveAttribute("href", "/assets/fine.example.com");
  });

  it("colours only the problem dots, keeps a hidden word on each and an empty ring for unknown", () => {
    const { container } = render(tree(<HealthModule cards={cards} issues={[]} />));

    const slow = row(container, "slow.example.com");
    const speed = slow.querySelector('[data-fact="speed"] [data-fact-dot]')!;
    expect(speed).toHaveAttribute("data-fact-dot", "warn");
    expect(speed).toHaveClass("bg-warn");
    expect(slow.querySelector('[data-fact="speed"] .sr-only')).toHaveTextContent("Slow");
    expect(within(slow).getByRole("button", { name: "Slow Site, Speed: Slow" })).toBeInTheDocument();

    const fine = row(container, "fine.example.com");
    for (const dot of fine.querySelectorAll("[data-fact-dot]")) {
      expect(dot).toHaveAttribute("data-fact-dot", "ok");
      expect(dot.className).not.toMatch(/bg-(warn|error)/);
    }
    expect(fine.querySelector('[data-fact="reachable"] .sr-only')).toHaveTextContent("Up");

    for (const dot of row(container, "new.example.com").querySelectorAll("[data-fact-dot]")) {
      expect(dot).toHaveAttribute("data-fact-dot", "unknown");
      expect(dot).toHaveClass("border-dashed");
      expect(dot.className).not.toMatch(/bg-(warn|error)/);
    }
  });

  it("writes each row's problems beside it, else Fine, else that nothing is measured yet", () => {
    const { container } = render(tree(<HealthModule cards={cards} issues={[]} />));

    const note = (id: string) => row(container, id).querySelector("[data-site-health-note]")!.textContent;
    expect(note("slow.example.com")).toBe("Slow for 1 in 4 visitors · 3 people hit an error");
    expect(note("fine.example.com")).toBe("Fine");
    expect(note("new.example.com")).toBe("Nothing measured yet");
  });

  it("colours a home page that did not load in the error colour", () => {
    const site = healthy("down.example.com");
    const down = { key: "alert-1", severity: "error" as const, assets: [site.id], site: site.id, line: "Home page down", mark: "Home page down", since: null, conditions: ["open-flags" as const] };
    const { container } = render(tree(<HealthModule cards={[site]} issues={[down]} />));

    expect(container.querySelector('[data-fact="reachable"] [data-fact-dot]')).toHaveClass("bg-error");
  });
});

describe("the agents' week", () => {
  it("reads not counted yet without any task project", () => {
    const { container } = render(tree(<FactoryModule cards={[card("first.example.com")]} work={null} nowMs={Date.parse("2026-10-19T12:00:00.000Z")} />));

    const figure = (key: string) => container.querySelector(`[data-factory-figure="${key}"]`)!;
    expect(figure("building")).toHaveTextContent("Buildingnot counted yet");
    expect(figure("finished")).toHaveTextContent("Finishednot counted yet");
    expect(figure("proven")).toHaveTextContent("Proven to work0");
    expect(container.querySelector("[data-factory-latest]")).toBeNull();
  });

  it("counts the bets that worked and lists the newest lines", () => {
    const watched = card("first.example.com", {
      displayName: "First Site",
      watches: { open: 2, latest: { id: "w-1", ref: "abc", outcome: "ship_confirmed", nextCheckDate: null, closedAt: "2026-10-17T00:00:00.000Z" } },
    });
    const { container } = render(tree(<FactoryModule cards={[watched]} work={null} nowMs={Date.parse("2026-10-19T12:00:00.000Z")} />));

    expect(container.querySelector('[data-factory-figure="proven"]')).toHaveTextContent("1");
    expect(screen.getByText("2 being watched")).toBeInTheDocument();
    expect(container.querySelector("[data-factory-latest]")).toHaveTextContent("Latest betFirst Site · Worked");
  });
});

describe("where visitors come from", () => {
  const split = (rows: [string, number][]): CardChannels => {
    const total = rows.reduce((sum, [, sessions]) => sum + sessions, 0);
    return { windowStart: "2026-09-21", windowEnd: "2026-10-18", rows: rows.map(([channel, sessions]) => ({ channel, sessions, share: sessions / total })) };
  };

  it("sums every site's visits by channel and shares them of the total", () => {
    const shares = channelShares([
      card("a.example.com", { channels: split([["Organic Search", 300], ["Direct", 100]]) }),
      card("b.example.com", { channels: split([["Direct", 500], ["Referral", 100]]) }),
      card("c.example.com"),
    ]);

    expect(shares).toEqual([
      { channel: "Direct", sessions: 600, share: 0.6 },
      { channel: "Organic Search", sessions: 300, share: 0.3 },
      { channel: "Referral", sessions: 100, share: 0.1 },
    ]);
    expect(channelShares([card("c.example.com")])).toBeNull();
  });

  it("draws five channels and the rest as Other", () => {
    const cards = [card("a.example.com", { channels: split([["A", 70], ["B", 60], ["C", 50], ["D", 40], ["E", 30], ["F", 20], ["G", 10]]) })];
    const { container } = render(tree(<ChannelsModule cards={cards} />));

    const rows = [...container.querySelectorAll("[data-channel]")];
    expect(rows.map((el) => el.getAttribute("data-channel"))).toEqual(["A", "B", "C", "D", "E", "Other"]);
    expect(rows.at(-1)).toHaveTextContent("Other11%");
    expect(rows.at(-1)).toHaveAttribute("data-channel-share", (30 / 280).toFixed(4));
  });

  it("draws the funnel with the largest drop across sites, the drop step coloured", () => {
    const cards = [
      card("a.example.com", { displayName: "A Site", product: product({ funnel: { name: "Signup", largestDrop: { fromStep: "Viewed /", toStep: "Signed up", lostPeople: 40, stepConversion: 0.2 } } }) }),
      card("b.example.com", { displayName: "B Site", product: product({ funnel: { name: "Checkout", largestDrop: { fromStep: "Cart", toStep: "Paid", lostPeople: 90, stepConversion: 0.1 } } }) }),
    ];
    const { container } = render(tree(<ChannelsModule cards={cards} />));

    const funnel = container.querySelector('[data-channels-funnel="Checkout"]')!;
    expect(funnel).toHaveTextContent("B Site · Checkout");
    expect(funnel).toHaveTextContent("90 people left between these two steps.");
    expect(funnel.querySelector('[data-funnel-step="to"] .bg-warn')).not.toBeNull();
    expect(funnel.querySelector('[data-funnel-step="from"] .bg-warn')).toBeNull();
    expect(container.querySelector("[data-channels-empty]")).toHaveTextContent("Not joined yet");
  });

  it("draws every step of the worst funnel, the biggest drop coloured, in a box its content's height", () => {
    // The demo's shape: four steps, the biggest loss between the second and third.
    const steps = [
      { label: "Visited", people: 1_000 },
      { label: "Opened a recipe", people: 580 },
      { label: "Saved it", people: 55 },
      { label: "Signed up", people: 12 },
    ];
    const cards = [
      card("a.example.com", {
        displayName: "Recipe Site",
        product: product({ funnel: { name: "Recipe to sign-up", largestDrop: { fromStep: "Opened a recipe", toStep: "Saved it", lostPeople: 525, stepConversion: 55 / 580 }, steps } }),
      }),
    ];
    const { container } = render(tree(<ChannelsModule cards={cards} />));

    const funnel = container.querySelector('[data-channels-funnel="Recipe to sign-up"]')!;
    const drawn = [...funnel.querySelectorAll("[data-funnel-step]")];
    expect(drawn.map((step) => step.querySelector("span")!.textContent)).toEqual(["Visited", "Opened a recipe", "Saved it", "Signed up"]);
    expect(drawn.map((step) => step.getAttribute("data-funnel-step"))).toEqual(["step-1", "from", "to", "step-4"]);
    expect(funnel.querySelectorAll(".bg-warn")).toHaveLength(1);
    expect(funnel.querySelector('[data-funnel-step="to"] .bg-warn')).not.toBeNull();
    expect(funnel).toHaveTextContent("525 people left between “Opened a recipe” and “Saved it”.");
    // The section is not stretched: its rows start at the top.
    const section = container.querySelector("[data-home-channels]")!;
    expect(section).toHaveClass("content-start");
    expect(section).not.toHaveClass("h-full");
  });

  it("says no funnel is declared, or that nothing is joined yet", () => {
    const declared = render(tree(<ChannelsModule cards={[card("a.example.com", { product: product() })]} />));
    expect(declared.container.querySelector("[data-channels-funnel]")).toHaveTextContent("No funnel declared yet");
    declared.unmount();
    const none = render(tree(<ChannelsModule cards={[card("a.example.com")]} />));
    expect(none.container.querySelector("[data-channels-funnel]")).toHaveTextContent("Not joined yet");
  });
});

describe("worth a look", () => {
  it("lists the gaps, each with a way to make a task, capped", () => {
    const cards = Array.from({ length: 5 }, (_, index) => card(`site-${index}.example.com`, { displayName: `Site ${index}`, codebase: null }));
    const { container } = render(tree(<GapsModule cards={cards} />));

    // Five sites each earn nothing, have no task project and send no code
    // report: fifteen gaps, eight listed.
    expect(container.querySelector("[data-home-gaps]")).toHaveAttribute("data-home-gaps", "8");
    expect(within(container).getByRole("region", { name: "Worth a look" })).toHaveTextContent("Worth a look8");
    expect(container.querySelectorAll("[data-business-gap]")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Show 5 more" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make a task for Site 0 earns nothing" })).toBeInTheDocument();
  });

  it("says nothing is missing on a complete portfolio", () => {
    const complete = card("full.example.com", {
      booked: { currency: "USD", revenue: 10, cost: 0, net: 10 },
      codebase,
      work: { open: 1, highPriority: 0, inProgress: 0, blocked: 0, closedRecent: 0, priorities: [0, 0, 1, 0, 0], capturedAt: "2026-10-19T12:00:00.000Z" },
    });
    const { container } = render(tree(<GapsModule cards={[complete]} />));

    expect(container).toHaveTextContent("Nothing is missing.");
  });
});
