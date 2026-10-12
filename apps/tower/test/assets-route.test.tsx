import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "./render";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetCard, WallPayload } from "@shared/wall";

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
    pulseReceivedAt: "2026-07-30T10:00:00.000Z",
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

function renderAssets(url = "/assets", assets: AssetCard[] = ASSETS) {
  state.data = payload(assets);
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/assets" element={<AssetsRoute />} />
          <Route path="/assets/*" element={<p>Site page</p>} />
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
});

describe("/assets — which site needs you, and how each is doing", () => {
  it("draws one row per site in the saved order, each with its one health word, its name opening the site", () => {
    const { container } = renderAssets();

    expect(screen.getByRole("heading", { level: 1, name: "Sites" })).toBeInTheDocument();
    expect(shown(container)).toEqual(["meadow.example", "northwind.example", "acorn.example", "ferns.example"]);
    expect(row(container, "meadow.example")).toHaveTextContent("Off track");
    expect(row(container, "northwind.example")).toHaveTextContent("At risk");
    expect(row(container, "acorn.example")).toHaveTextContent("Setting up");
    expect(within(row(container, "meadow.example")).getByRole("link")).toHaveAttribute("href", "/assets/meadow.example");
    // A site with no number yet has an empty Overview, so its row opens its Data sources.
    expect(within(row(container, "ferns.example")).getByRole("link")).toHaveAttribute("href", "/assets/ferns.example/sources");
    fireEvent.click(within(row(container, "meadow.example")).getByRole("link"));
    expect(screen.getByText("Site page")).toBeVisible();
  });

  it("states each site's people, money and sources, and names what nobody reported", () => {
    const { container } = renderAssets();

    expect(row(container, "meadow.example")).toHaveTextContent("no revenue");
    expect(row(container, "ferns.example")).toHaveTextContent("no visitors reported");
    // A source the site does not use is not owed; the reads have not answered,
    // so the one owed source is not counted live.
    expect(within(row(container, "meadow.example")).getByText("0 of 1 data sources live")).toBeInTheDocument();
  });

  it("offers Add a site as the page's one primary action, opened over the page", () => {
    const { container } = renderAssets();

    // A button, not a link (test/add-site.test.tsx pins what it opens).
    const action = screen.getByRole("button", { name: "Add a site" });
    expect(action).toHaveAttribute("data-add-site-open");
    expect(container.querySelector("[data-page-header]")?.contains(action)).toBe(true);
    expect(screen.getAllByRole("button", { name: "Add a site" })).toHaveLength(1);
  });

  it("opens with one answer: which sites need you, each named a way in", () => {
    const { container } = renderAssets();

    const answer = container.querySelector<HTMLElement>("[data-sites-answer]")!;
    expect(answer).toHaveAttribute("data-surface-hero");
    expect(answer).toHaveAttribute("data-sites-answer", "needs-you");
    expect(within(answer).getByRole("heading", { level: 2 })).toHaveTextContent("2 of 4 sites need you");
    expect([...answer.querySelectorAll("a[data-sites-answer-site]")].map((link) => link.textContent)).toEqual(["Meadow Board", "Northwind"]);
    expect(answer.querySelector("[data-visitors-figure]")).toHaveTextContent("1,500");
  });

  it("says All on track when no site needs you, and counts the ones still setting up apart", () => {
    const calm = [assetCard({ id: "one.example" }), assetCard({ id: "two.example" })];
    const { container, unmount } = renderAssets("/assets", calm);
    expect(container.querySelector("[data-sites-answer]")).toHaveTextContent("All 2 sites on track");
    unmount();
    const young = [assetCard({ id: "one.example" }), assetCard({ id: "two.example", status: "baselining" })];
    const second = renderAssets("/assets", young);
    expect(second.container.querySelector("[data-sites-answer]")).toHaveTextContent("1 of 2 sites on track1 setting up");
  });

  it("answers for the portfolio, not the narrowed view", () => {
    const { container } = renderAssets("/assets?status=live");

    expect(container.querySelector("[data-sites-answer]")).toHaveTextContent("2 of 4 sites need you");
    expect(container.querySelector("[data-assets-summary]")).toHaveTextContent("2 of 4 sites · stage: live");
  });

  it("leaves tasks, search clicks, the ledger and the traffic period to each site's own page", () => {
    const { container } = renderAssets();

    expect(screen.queryByRole("group", { name: "Traffic period" })).toBeNull();
    expect(screen.queryByText(/open|urgent|No task data|Search clicks|Net ·/u)).toBeNull();
    expect(container.querySelector("table")).toBeNull();
  });
});

describe("/assets — the health split is the Health filter", () => {
  it("splits the whole portfolio by health word, worst first, with each count in its legend", () => {
    const { container } = renderAssets();

    const bar = screen.getByRole("img", { name: "Site health: 1 off track, 1 at risk, 2 setting up" });
    expect([...bar.querySelectorAll("[data-segment]")].map((segment) => segment.getAttribute("data-segment"))).toEqual([
      "off-track", "at-risk", "setting-up",
    ]);
    expect(bar.querySelector('[data-segment="off-track"]')!.className).toContain("bg-error");
    expect(bar.querySelector('[data-segment="setting-up"]')!.className).not.toMatch(/bg-(error|warn)/u);
    expect(within(screen.getByRole("group", { name: "Health" })).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "1 off track", "1 at risk", "2 setting up",
    ]);
    expect(pressed("Health")).toEqual([]);
    expect(container.querySelector("[data-assets-summary]")).toBeNull();
  });

  it("shows only a word's sites on a press, and all of them on a second", () => {
    const { container } = renderAssets();

    fireEvent.click(screen.getByRole("button", { name: "2 setting up" }));
    expect(shown(container)).toEqual(["acorn.example", "ferns.example"]);
    expect(pressed("Health")).toEqual(["2 setting up"]);
    expect(container.querySelector('[data-segment="off-track"]')!.className).toContain("opacity-25");
    expect(container.querySelector("[data-assets-summary]")).toHaveTextContent("2 of 4 sites · health: setting up");

    fireEvent.click(screen.getByRole("button", { name: "2 setting up" }));
    expect(shown(container)).toHaveLength(4);
    expect(pressed("Health")).toEqual([]);
  });

  it("reads its filters from the URL, so a narrowed list is a link, and keeps a picked word nobody wears pressable", () => {
    const { container } = renderAssets("/assets?status=live&health=at-risk");
    expect(shown(container)).toEqual(["northwind.example"]);
    expect(screen.getByLabelText("Stage")).toHaveValue("live");
    expect(pressed("Health")).toEqual(["1 at risk"]);
    expect(container.querySelector("[data-assets-summary]")).toHaveTextContent("1 of 4 sites · stage: live · health: at risk");

    const nobody = renderAssets("/assets?health=on-track");
    expect(within(nobody.container.querySelector<HTMLElement>("[data-health-split]")!).getByRole("button", { name: "0 on track" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(nobody.container.querySelector("[data-assets-summary]")).toHaveTextContent("0 of 4 sites · health: on track");
  });
});

describe("/assets — the stage", () => {
  it("counts every stage against the whole portfolio, not against the other filter", () => {
    renderAssets("/assets?health=off-track");

    expect(within(screen.getByLabelText("Stage")).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "All stages · 4",
      "Pre-launch · 0",
      "Onboarding · 1",
      "Baselining · 1",
      "Live · 2",
      "Retired · 0",
    ]);
  });

  it("says nothing matches, and never calls it an empty portfolio", () => {
    const { container } = renderAssets("/assets?status=retired");

    expect(screen.getByText("No sites match these filters")).toBeInTheDocument();
    expect(screen.queryByText("No sites yet")).toBeNull();
    expect(shown(container)).toEqual([]);
    const summary = container.querySelector<HTMLElement>("[data-assets-summary]")!;
    expect(summary).toHaveTextContent("0 of 4 sites · stage: retired");
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

  it("orders from the URL: who needs you, people and name", () => {
    const byHealth = renderAssets("/assets?sort=health");
    expect(shown(byHealth.container)).toEqual(["meadow.example", "northwind.example", "acorn.example", "ferns.example"]);
    expect(pressed("Order")).toEqual(["Needs you"]);
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

  it("with no sites, is its header, Add a site and one empty state", () => {
    const { container } = renderAssets("/assets", []);
    expect(machinery(container)).toEqual(none);
    expect(screen.getByText("No sites yet")).toBeInTheDocument();
    expect(container.querySelector("[data-assets-empty]")).toHaveAttribute("data-surface-hero");
    expect(screen.getAllByRole("button")).toEqual([screen.getByRole("button", { name: "Add a site" })]);
    expect(container.querySelector("[data-assets-age]")).toBeNull();
  });

  it("with one site, is that site's row and nothing to filter, order or add up", () => {
    const { container } = renderAssets("/assets?status=retired&health=at-risk", [ASSETS[0]!]);
    expect(machinery(container)).toEqual(none);
    expect(shown(container)).toEqual(["meadow.example"]);
    expect(screen.queryByText("No sites match these filters")).toBeNull();
    expect(container.querySelector("[data-assets-age]")).toHaveTextContent("updated");
  });

  it("with two sites, compares them", () => {
    const { container } = renderAssets("/assets", ASSETS.slice(0, 2));
    const shownMachinery = machinery(container);
    expect(shownMachinery.answer).toHaveTextContent("2 of 2 sites need you");
    expect(shownMachinery.split).not.toBeNull();
    expect(shownMachinery.order).not.toBeNull();
    expect(shownMachinery.stage).not.toBeNull();
    expect(shown(container)).toEqual(["meadow.example", "northwind.example"]);
  });
});
