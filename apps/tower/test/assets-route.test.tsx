import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "./render";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetCard, WallPayload } from "@shared/wall";
import type { SiteDisplay } from "@shared/site-display";

const state = vi.hoisted(() => ({
  data: null as WallPayload | null,
  isPending: false,
}));

vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({ data: state.data, isPending: state.isPending, isError: false }),
}));

vi.mock("@/hooks/useNow", () => ({
  useNow: () => Date.parse("2026-08-01T12:00:00.000Z"),
}));

// The connection reads have not answered: every source is unknown, never
// "not connected".
vi.mock("@/hooks/useConnections", () => ({
  useConnections: () => ({ credentials: undefined, items: null }),
}));

import { ViewBar } from "@/components/ViewBar";
import { AssetsRoute } from "@/routes/AssetsRoute";

function assetCard(overrides: Partial<AssetCard> & { id: string }): AssetCard {
  return { netByMonthCurrency: 'USD',
    displayName: overrides.id,
    status: "live",
    senseOnly: false,
    worstSeverity: null,
    openError: 0,
    openWarn: 0,
    booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
    forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
    netPeriod: "2026-08",
    pulseReceivedAt: "2026-08-01T11:00:00.000Z",
    firstReportAt: null,
    dataSources: [],
    searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
    netByMonth: [],
    netByMonthProvisionalFrom: null,
    activeUsers: {
      series: [],
      provisionalFrom: null,
      collectedAt: null,
      timeZoneChanges: [],
    },
    work: null,
    panelReview: null,
    latestPanelDate: null,
    ...overrides,
  };
}

/** One finished day of people, the 31st of July. */
const users = (v: number): AssetCard["activeUsers"] => ({
  series: [{ t: "2026-07-31", v }],
  provisionalFrom: null,
  collectedAt: null,
  timeZoneChanges: [],
});

/**
 * Four sites that differ on every axis the page filters and orders by, in the
 * payload's saved order. Read the fixture as the answer key:
 *
 *   Meadow Board  live        1 error   900 people
 *   Northwind     live        2 warns   500 people   monitor only
 *   Areas         baselining  clear     100 people
 *   Fin           onboarding  clear     no people    never reported
 */
const ASSETS: AssetCard[] = [
  assetCard({
    id: "meadow.example",
    displayName: "Meadow Board",
    worstSeverity: "error",
    openError: 1,
    activeUsers: users(900),
    dataSources: [
      { id: "ga4", label: "Google Analytics", state: "live" },
      { id: "clarity", label: "Session recordings", state: "skipped" },
    ],
  }),
  assetCard({
    id: "northwind.example",
    displayName: "Northwind",
    senseOnly: true,
    worstSeverity: "warn",
    openWarn: 2,
    activeUsers: users(500),
    pulseReceivedAt: "2026-08-01T10:00:00.000Z",
  }),
  assetCard({
    id: "acorn.example",
    displayName: "Areas",
    status: "baselining",
    activeUsers: users(100),
    pulseReceivedAt: "2026-08-01T10:00:00.000Z",
  }),
  assetCard({
    id: "ferns.example",
    displayName: "Fin",
    status: "onboarding",
    pulseReceivedAt: null,
  }),
];

/** Only the slices `/assets` reads; every other band is another page's business. */
function payload(assets: AssetCard[]): WallPayload {
  return {
    generatedAt: "2026-08-01T12:00:00.000Z",
    portfolio: { netTrendCurrency: 'USD', netTrendAllCurrency: 'USD',
      period: "2026-08",
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
      daysIn: 1,
    },
    system: {
      assetId: "root-os",
      hasPulse: true,
      spendTodayUsd: 1,
      dailyCapUsd: 2,
      ingest: { fresh: 2, stale: 0, notExpected: 0, expected: 2 },
      scheduledLanes: [],
    },
    dashboard: {
      countdown: { emoji: "🌁", label: "SF", targetAt: "2026-09-01T07:00:00.000Z" },
    },
    assets,
    attention: [],
    snoozed: [],
    operator: {
      waiting: 0,
      urgent: 0,
      measuredProjects: 1,
      urgentMeasuredProjects: 1,
      projectCount: 1,
      capturedAt: "2026-08-01T11:59:30.000Z",
    },
    ledgerRecordedAt: null,
  };
}

function renderAssets(url = "/assets", assets: AssetCard[] = ASSETS, sites?: SiteDisplay, controls = false) {
  const read = payload(assets);
  state.data = sites === undefined ? read : { ...read, dashboard: { ...read.dashboard, sites } };
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/assets" element={<>{controls ? <><ViewBar /><PathProbe /></> : null}<AssetsRoute /></>} />
          <Route path="/assets/*" element={<p>Asset page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The comparison's order, read off the rows themselves. */
function shown(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-portfolio-row]")].map((row) => row.getAttribute("data-portfolio-row") ?? "");
}

function row(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-portfolio-row="${id}"]`)!;
}

function pressed(group: string): string[] {
  return within(screen.getByRole("group", { name: group }))
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.textContent ?? "");
}

afterEach(() => {
  state.data = null;
  state.isPending = false;
  window.localStorage.clear();
});

describe("/assets — which asset needs attention, and how each is doing", () => {
  it("draws one row per asset in the saved order, each with its one health word, its name opening the asset", () => {
    const { container } = renderAssets();

    expect(screen.getByRole("heading", { level: 1, name: "Portfolio" })).toBeInTheDocument();
    expect(shown(container)).toEqual(["meadow.example", "northwind.example", "acorn.example", "ferns.example"]);
    expect(row(container, "meadow.example")).toHaveTextContent("Off track");
    expect(row(container, "northwind.example")).toHaveTextContent("At risk");
    expect(row(container, "acorn.example")).toHaveTextContent("On track");
    expect(within(row(container, "meadow.example")).getByRole("link")).toHaveAttribute("href", "/assets/meadow.example");
    // A site with no number yet has an empty Overview, so its row opens its Data sources.
    expect(within(row(container, "ferns.example")).getByRole("link")).toHaveAttribute("href", "/assets/ferns.example/sources");
    fireEvent.click(within(row(container, "meadow.example")).getByRole("link"));
    expect(screen.getByText("Asset page")).toBeVisible();
  });

  it("states each asset's people, money and sources, and names what nobody reported", () => {
    const { container } = renderAssets();

    expect(row(container, "meadow.example")).toHaveTextContent("no revenue");
    expect(row(container, "ferns.example")).toHaveTextContent("no visitors reported");
    // A source the site does not use is not owed; the reads have not answered,
    // so the one owed source is not counted live.
    expect(within(row(container, "meadow.example")).getByText("0 of 1 data sources live")).toBeInTheDocument();
  });

  it("offers Add an asset as the page's one primary action, opened over the page", () => {
    const { container } = renderAssets();

    // A button, not a link (test/add-site.test.tsx pins what it opens).
    const action = screen.getByRole("button", { name: "Add an asset" });
    expect(action).toHaveAttribute("data-add-site-open");
    expect(container.querySelector("[data-page-header]")?.contains(action)).toBe(true);
    expect(screen.getAllByRole("button", { name: "Add an asset" })).toHaveLength(1);
  });

  it("opens with one answer: which assets need attention, each named a way in", () => {
    const { container } = renderAssets();

    const answer = container.querySelector<HTMLElement>("[data-sites-answer]")!;
    expect(answer).toHaveAttribute("data-surface-hero");
    expect(answer).toHaveAttribute("data-sites-answer", "needs-you");
    expect(within(answer).getByRole("heading", { level: 2 })).toHaveTextContent("2 of 4 assets need attention");
    expect([...answer.querySelectorAll("a[data-sites-answer-site]")].map((link) => link.textContent)).toEqual(["Meadow Board", "Northwind"]);
    expect(answer.querySelector("[data-visitors-figure]")).toHaveTextContent("1,500");
  });

  it("says All on track when no asset needs attention, regardless of manual stage", () => {
    const calm = [assetCard({ id: "one.example" }), assetCard({ id: "two.example" })];
    const { container, unmount } = renderAssets("/assets", calm);
    expect(container.querySelector("[data-sites-answer]")).toHaveTextContent("All 2 assets on track");
    unmount();
    const young = [assetCard({ id: "one.example" }), assetCard({ id: "two.example", status: "baselining" })];
    const second = renderAssets("/assets", young);
    expect(second.container.querySelector("[data-sites-answer]")).toHaveTextContent("All 2 assets on track");
  });

  it("includes a late reporting asset in attention counts during baselining", () => {
    const late = assetCard({ id: "late.example", status: "baselining", pulseReceivedAt: "2026-07-30T10:00:00.000Z" });
    const { container } = renderAssets("/assets", [late, assetCard({ id: "fine.example" })]);
    expect(row(container, late.id)).toHaveTextContent("At risk");
    expect(container.querySelector("[data-sites-answer]")).toHaveTextContent("1 of 2 assets at risk");
    expect(screen.queryByRole("button", { name: /setting up/i })).toBeNull();
  });

  it("answers for the portfolio, not the narrowed view", () => {
    const { container } = renderAssets("/assets?status=live");

    expect(container.querySelector("[data-sites-answer]")).toHaveTextContent("2 of 4 assets need attention");
    expect(container.querySelector("[data-assets-summary]")).toHaveTextContent("2 of 4 assets · stage: live");
  });

  it("leaves tasks, search clicks, the ledger and the traffic period to each asset's own page", () => {
    const { container } = renderAssets();

    expect(screen.queryByRole("group", { name: "Traffic period" })).toBeNull();
    expect(screen.queryByText(/open|urgent|No task data|Search clicks|Net ·/u)).toBeNull();
    expect(container.querySelector("table")).toBeNull();
  });
});

describe("/assets — the health split is the Health filter", () => {
  it("splits the whole portfolio by health word, worst first, with each count in its legend", () => {
    const { container } = renderAssets();

    const bar = screen.getByRole("img", { name: "Asset health: 1 off track, 1 at risk, 2 on track" });
    expect([...bar.querySelectorAll("[data-segment]")].map((segment) => segment.getAttribute("data-segment"))).toEqual([
      "off-track", "at-risk", "on-track",
    ]);
    expect(bar.querySelector('[data-segment="off-track"]')!.className).toContain("bg-error");
    expect(bar.querySelector('[data-segment="on-track"]')!.className).not.toMatch(/bg-(error|warn)/u);
    expect(within(screen.getByRole("group", { name: "Health" })).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "1 off track", "1 at risk", "2 on track",
    ]);
    expect(pressed("Health")).toEqual([]);
    expect(container.querySelector("[data-assets-summary]")).toBeNull();
  });

  it("shows only a word's assets on a press, and all of them on a second", () => {
    const { container } = renderAssets();

    fireEvent.click(screen.getByRole("button", { name: "2 on track" }));
    expect(shown(container)).toEqual(["acorn.example", "ferns.example"]);
    expect(pressed("Health")).toEqual(["2 on track"]);
    expect(container.querySelector('[data-segment="off-track"]')!.className).toContain("opacity-25");
    expect(container.querySelector("[data-assets-summary]")).toHaveTextContent("2 of 4 assets · health: on track");

    fireEvent.click(screen.getByRole("button", { name: "2 on track" }));
    expect(shown(container)).toHaveLength(4);
    expect(pressed("Health")).toEqual([]);
  });

  it("reads its filters from the URL, so a narrowed list is a link, and keeps a picked word nobody wears pressable", () => {
    const { container } = renderAssets("/assets?status=live&health=at-risk");
    expect(shown(container)).toEqual(["northwind.example"]);
    expect(screen.getByLabelText("Stage")).toHaveValue("live");
    expect(pressed("Health")).toEqual(["1 at risk"]);
    expect(container.querySelector("[data-assets-summary]")).toHaveTextContent("1 of 4 assets · stage: live · health: at risk");

    const nobody = renderAssets("/assets?health=monitor-only");
    expect(within(nobody.container.querySelector<HTMLElement>("[data-health-split]")!).getByRole("button", { name: "0 monitor only" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(nobody.container.querySelector("[data-assets-summary]")).toHaveTextContent("0 of 4 assets · health: monitor only");
  });
});

describe("/assets — the stage", () => {
  it("counts every stage against the whole portfolio, not against the other filter", () => {
    renderAssets("/assets?health=off-track");

    expect(within(screen.getByLabelText("Stage")).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "All stages · 4",
      "Pre-launch · 0",
      "Onboarding · 1",
      "Live · 2",
      "Retired · 0",
    ]);
  });

  it("says nothing matches, and never calls it an empty portfolio", () => {
    const { container } = renderAssets("/assets?status=retired");

    expect(screen.getByText("No assets match these filters")).toBeInTheDocument();
    expect(screen.queryByText("No assets yet")).toBeNull();
    expect(shown(container)).toEqual([]);
    const summary = container.querySelector<HTMLElement>("[data-assets-summary]")!;
    expect(summary).toHaveTextContent("0 of 4 assets · stage: retired");
    expect(within(summary).getByRole("link", { name: "Clear" })).toBeInTheDocument();
  });

  it("clears both filters at once and keeps the order", () => {
    const { container } = renderAssets("/assets?status=live&health=off-track&sort=name");
    expect(shown(container)).toEqual(["meadow.example"]);

    fireEvent.click(screen.getByRole("link", { name: "Clear" }));

    expect(shown(container)).toEqual(["acorn.example", "ferns.example", "meadow.example", "northwind.example"]);
    expect(screen.getByLabelText("Stage")).toHaveValue("all");
    expect(pressed("Order")).toEqual(["A–Z"]);
    expect(container.querySelector("[data-assets-summary]")).toBeNull();
  });

  /** On a phone the order and the stage wait behind one press; the health
   * legend is the picture's own and stays in view. */
  it("folds the order and the stage behind one phone control, counting only the stage", () => {
    const { container } = renderAssets("/assets?status=live&health=at-risk&sort=name");
    const control = screen.getByRole("button", { name: "Order & stage, 1 on" });
    expect(control).toHaveClass("sm:hidden");
    const filters = container.querySelector("[data-assets-filters]")!;
    expect(filters).toHaveClass("max-sm:hidden");
    expect(filters).toContainElement(screen.getByRole("group", { name: "Order" }));
    expect(filters).not.toContainElement(screen.getByRole("group", { name: "Health" }));
    fireEvent.click(control);
    expect(filters).not.toHaveClass("max-sm:hidden");
  });
});

describe("/assets — the orderings", () => {
  it("keeps the saved order by default, with nothing to clear", () => {
    renderAssets();
    expect(pressed("Order")).toEqual(["Your order"]);
    expect(screen.queryByRole("link", { name: "Clear" })).toBeNull();
  });

  it("orders from the URL: who needs attention, people and name", () => {
    const byHealth = renderAssets("/assets?sort=health");
    expect(shown(byHealth.container)).toEqual(["meadow.example", "northwind.example", "acorn.example", "ferns.example"]);
    expect(pressed("Order")).toEqual(["Needs attention"]);
    byHealth.unmount();

    // A site with no finished day sinks below every measured one.
    const byPeople = renderAssets("/assets?sort=users", [ASSETS[3]!, ...ASSETS.slice(0, 3)]);
    expect(shown(byPeople.container)).toEqual(["meadow.example", "northwind.example", "acorn.example", "ferns.example"]);
    byPeople.unmount();

    const byName = renderAssets("/assets?sort=name");
    expect(shown(byName.container)).toEqual(["acorn.example", "ferns.example", "meadow.example", "northwind.example"]);
  });

  it("falls back to the saved order when the URL carries an ordering it cannot name", () => {
    for (const old of ["whatever-an-old-bookmark-said", "work", "trend", "net"]) {
      const { container, unmount } = renderAssets(`/assets?sort=${old}`);
      expect(shown(container)).toEqual(["meadow.example", "northwind.example", "acorn.example", "ferns.example"]);
      expect(pressed("Order")).toEqual(["Your order"]);
      unmount();
    }
  });

  it("orders on one press, and the saved order is one press back", () => {
    const { container } = renderAssets();

    fireEvent.click(within(screen.getByRole("group", { name: "Order" })).getByRole("button", { name: "A–Z" }));
    expect(shown(container)).toEqual(["acorn.example", "ferns.example", "meadow.example", "northwind.example"]);
    fireEvent.click(within(screen.getByRole("group", { name: "Order" })).getByRole("button", { name: "Your order" }));
    expect(shown(container)).toEqual(["meadow.example", "northwind.example", "acorn.example", "ferns.example"]);
  });
});

/** A site whose Home and Sites list switch is off is listed nowhere here and
 * counted as hidden; an archived site stays off until restored. */
describe("/assets — assets hidden by their own switch", () => {
  it("leaves a list-off asset out of the rows, the answer and the stage counts, and says how many are hidden", () => {
    const { container } = renderAssets("/assets", ASSETS, { "northwind.example": { list: false } });
    expect(shown(container)).toEqual(["meadow.example", "acorn.example", "ferns.example"]);
    expect(container.querySelector("[data-sites-answer]")).toHaveTextContent("1 of 3 assets off track");
    expect(container.querySelector("[data-assets-summary]")).toHaveTextContent(/^3 assets\s*·\s*1 hidden$/u);
    expect(container.querySelector("[data-assets-hidden]")).toHaveAttribute("data-assets-hidden", "1");
    expect(screen.getByRole("option", { name: "Live · 1" })).toBeInTheDocument();
  });

  it("keeps archived assets hidden even with a saved list switch", () => {
    const retired = ASSETS.map((card) => (card.id === "acorn.example" ? { ...card, status: "retired" } : card));
    const off = renderAssets("/assets", retired);
    expect(shown(off.container)).toEqual(["meadow.example", "northwind.example", "ferns.example"]);
    expect(off.container.querySelector("[data-assets-hidden]")).toHaveAttribute("data-assets-hidden", "1");
    off.unmount();
    const on = renderAssets("/assets", retired, { "acorn.example": { list: true } });
    expect(shown(on.container)).toEqual(["meadow.example", "northwind.example", "ferns.example"]);
    expect(on.container.querySelector("[data-assets-hidden]")).toHaveAttribute("data-assets-hidden", "1");
  });

  it("excludes archived assets from rows, answer and health bar", () => {
    const retired = ASSETS.map((card) => (card.id === "meadow.example" ? { ...card, status: "retired" } : card));
    const { container } = renderAssets("/assets", retired, { "meadow.example": { list: true } });
    expect(row(container, "meadow.example")).toBeNull();
    // Northwind at risk, of the three watched sites.
    expect(container.querySelector("[data-sites-answer]")).toHaveTextContent("1 of 3 assets at risk");
    expect(container.querySelector("[data-health-split]")).not.toHaveTextContent("Retired");
  });

  it("says every asset is hidden rather than that there are none", () => {
    const { container } = renderAssets("/assets", ASSETS.slice(0, 2), { "meadow.example": { list: false }, "northwind.example": { list: false } });
    expect(screen.getByText("Every asset is hidden")).toBeInTheDocument();
    expect(screen.queryByText("No assets yet")).toBeNull();
    expect(container.querySelector("[data-assets-hidden]")).toHaveTextContent("2 hidden");
  });
});

/** The answer, the split and the controls are how sites are compared; over
 * one site they would sort a single row. */
describe("/assets — the comparison arrives with a second site", () => {
  function machinery(container: HTMLElement) {
    return {
      answer: container.querySelector("[data-sites-answer]"),
      split: container.querySelector("[data-health-split]"),
      filters: container.querySelector("[data-assets-filters]"),
      order: screen.queryByRole("group", { name: "Order" }),
      stage: screen.queryByLabelText("Stage"),
      summary: container.querySelector("[data-assets-summary]"),
    };
  }
  const none = { answer: null, split: null, filters: null, order: null, stage: null, summary: null };

  it("with no assets, is its header, Add an asset and one empty state", () => {
    const { container } = renderAssets("/assets", []);
    expect(machinery(container)).toEqual(none);
    expect(screen.getByText("No assets yet")).toBeInTheDocument();
    expect(container.querySelector("[data-assets-empty]")).toHaveAttribute("data-surface-hero");
    expect(screen.getAllByRole("button")).toEqual([screen.getByRole("button", { name: "Add an asset" })]);
    expect(container.querySelector("[data-assets-age]")).toBeNull();
  });

  it("with one asset, is that asset's row and nothing to filter, order or add up", () => {
    const { container } = renderAssets("/assets?status=retired&health=at-risk", [ASSETS[0]!]);
    expect(machinery(container)).toEqual(none);
    expect(shown(container)).toEqual(["meadow.example"]);
    expect(screen.queryByText("No assets match these filters")).toBeNull();
    expect(container.querySelector("[data-assets-age]")).toHaveTextContent("updated");
  });

  it("with two assets, compares them", () => {
    const { container } = renderAssets("/assets", ASSETS.slice(0, 2));
    const shownMachinery = machinery(container);
    expect(shownMachinery.answer).toHaveTextContent("2 of 2 assets need attention");
    expect(shownMachinery.split).not.toBeNull();
    expect(shownMachinery.order).not.toBeNull();
    expect(shownMachinery.stage).not.toBeNull();
    expect(shown(container)).toEqual(["meadow.example", "northwind.example"]);
  });
});

function PathProbe() {
  const location = useLocation();
  return <output data-testid="portfolio-path">{location.pathname}{location.search}{location.hash}</output>;
}

function pickView(name: string) {
  fireEvent.click(within(screen.getByRole("group", { name: "View" })).getByRole("button", { name }));
}

function comparisonColumns(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[role="columnheader"][data-portfolio-column]')].map((cell) => cell.getAttribute("data-portfolio-column")!);
}

describe("Portfolio purpose views", () => {
  it("compares actual people, money and source evidence in different priorities", () => {
    const { container } = renderAssets("/assets", [ASSETS[2]!, ASSETS[1]!, ASSETS[0]!], undefined, true);
    pickView("Growth");
    expect(shown(container)).toEqual(["meadow.example", "northwind.example", "acorn.example"]);
    expect(comparisonColumns(container)).toEqual(["people", "revenue", "share", "sources"]);
    pickView("Revenue");
    expect(pressed("Order")).toEqual(["Money"]);
    expect(comparisonColumns(container)).toEqual(["revenue", "share", "people", "sources"]);
    pickView("Reliability");
    expect(pressed("Order")).toEqual(["Needs attention"]);
    expect(comparisonColumns(container)).toEqual(["sources", "people", "revenue", "share"]);
    expect(screen.getByTestId("portfolio-path")).toHaveTextContent("/assets");
  });

  it("retains filters, unrelated query state, and an explicit saved order across view changes", () => {
    const { container } = renderAssets("/assets?status=live&health=at-risk&sort=seed&range=7#comparison", ASSETS, undefined, true);
    pickView("Growth");
    pickView("Revenue");
    pickView("Reliability");
    expect(shown(container)).toEqual(["northwind.example"]);
    expect(pressed("Order")).toEqual(["Your order"]);
    expect(screen.getByRole("combobox", { name: "Stage" })).toHaveValue("live");
    expect(screen.getByTestId("portfolio-path")).toHaveTextContent("/assets?status=live&health=at-risk&sort=seed&range=7#comparison");
    fireEvent.click(screen.getByRole("link", { name: "Clear" }));
    expect(screen.getByTestId("portfolio-path")).toHaveTextContent("/assets?sort=seed&range=7");
    expect(shown(container)).toEqual(ASSETS.map((asset) => asset.id));
  });

  it("records an explicit Your order press so a later purpose cannot replace it", () => {
    const { container } = renderAssets("/assets", [ASSETS[2]!, ASSETS[0]!, ASSETS[1]!], undefined, true);
    pickView("Growth");
    fireEvent.click(within(screen.getByRole("group", { name: "Order" })).getByRole("button", { name: "Your order" }));
    expect(screen.getByTestId("portfolio-path")).toHaveTextContent("sort=seed");
    pickView("Reliability");
    expect(shown(container)).toEqual(["acorn.example", "meadow.example", "northwind.example"]);
  });

  it("compares measured delivery counts and leaves unmeasured work unknown", () => {
    const work = { open: 4, highPriority: null, inProgress: 2, blocked: 3, closedRecent: 5, priorities: null, capturedAt: "2026-08-01T11:00:00Z" };
    const { container } = renderAssets("/assets", [ASSETS[2]!, { ...ASSETS[0]!, work }], undefined, true);
    pickView("Delivery");
    expect(shown(container)).toEqual(["meadow.example", "acorn.example"]);
    expect(comparisonColumns(container)[0]).toBe("work");
    expect(row(container, "meadow.example")).toHaveTextContent("2 in progress");
    expect(row(container, "meadow.example")).toHaveTextContent("3 blocked · 5 done this week");
    expect(row(container, "acorn.example")).toHaveTextContent("not measured");
  });
});
