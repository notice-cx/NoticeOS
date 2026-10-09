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

vi.mock("@/hooks/useGa4Realtime", () => ({
  useGa4Realtime: () => ({
    data: { generatedAt: "2026-08-01T12:00:00.000Z", assets: [] },
    isError: false,
    isPending: false,
  }),
}));

import { AssetsRoute } from "@/routes/AssetsRoute";
import { AssetsTable } from "@/routes/assets/AssetsTable";

// A task source connected, as this installation's is (D32, bead
// ro-ujb9.143): the task screens here render exactly as before it existed.
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

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
    // The two comparison columns doc 21 asks this table for (bead
    // `ro-78qo.35`). Empty by default, so a case that wants one says so.
    searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
    netByMonth: [],
    netByMonthProvisionalFrom: null,
    // One point only, deliberately: it is enough for the "today's users" sort to
    // have a value while staying below `MIN_TREND_POINTS`, so no card in this
    // suite draws a chart and the assertions are about the route, not recharts.
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

/**
 * Four assets that differ on every axis the page filters and sorts by, in the
 * payload's seed order. Read the fixture as the answer key:
 *
 *   Meal Planner    live         automation enabled  1 error   P1×2   900 users  11:00
 *   Nosh        live         monitor only        2 warns   P1×0   500 users  10:00
 *   Areas   baselining   automation enabled  clear     none   100 users  Jul 30
 *   Fin        onboarding   automation enabled  clear     P1×1   no users   never
 */
const ASSETS: AssetCard[] = [
  assetCard({
    id: "meals.example",
    displayName: "Meal Planner",
    status: "live",
    worstSeverity: "error",
    openError: 1,
    activeUsers: {
      series: [{ t: "2026-08-01", v: 900 }],
      provisionalFrom: null,
      collectedAt: null,
      timeZoneChanges: [],
    },
    work: {
      open: 5,
      highPriority: 2,
      inProgress: 1,
      blocked: 0,
      closedRecent: 0,
      priorities: null,
      capturedAt: "2026-08-01T11:00:00.000Z",
    },
    pulseReceivedAt: "2026-08-01T11:00:00.000Z",
  }),
  assetCard({
    id: "nosh.example",
    displayName: "Nosh",
    status: "live",
    senseOnly: true,
    worstSeverity: "warn",
    openWarn: 2,
    activeUsers: {
      series: [{ t: "2026-08-01", v: 500 }],
      provisionalFrom: null,
      collectedAt: null,
      timeZoneChanges: [],
    },
    work: {
      open: 1,
      highPriority: 0,
      inProgress: 0,
      blocked: 0,
      closedRecent: 0,
      priorities: null,
      capturedAt: "2026-08-01T11:00:00.000Z",
    },
    pulseReceivedAt: "2026-08-01T10:00:00.000Z",
  }),
  assetCard({
    id: "areas.example",
    displayName: "Areas",
    status: "baselining",
    activeUsers: {
      series: [{ t: "2026-08-01", v: 100 }],
      provisionalFrom: null,
      collectedAt: null,
      timeZoneChanges: [],
    },
    pulseReceivedAt: "2026-07-30T10:00:00.000Z",
  }),
  assetCard({
    id: "fees.example",
    displayName: "Fin",
    status: "onboarding",
    work: {
      open: 2,
      highPriority: 1,
      inProgress: 0,
      blocked: 0,
      closedRecent: 0,
      priorities: null,
      capturedAt: "2026-08-01T11:00:00.000Z",
    },
    pulseReceivedAt: null,
  }),
];

/** A second site with nothing reported, beside a case's own: the comparison
 * machinery these cases read exists from two sites (bead ro-ujb9.128). */
const QUIET = assetCard({ id: "quiet.example", pulseReceivedAt: null });

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

function renderAssets(url = "/assets", assets: AssetCard[] = ASSETS, portfolio: Partial<WallPayload["portfolio"]> = {}) {
  state.data = payload(assets);
  state.data.portfolio = { ...state.data.portfolio, ...portfolio };
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <AssetsRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The table's order, read off the rows themselves. */
function shown(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-asset-row]")].map(
    (row) => row.getAttribute("data-asset-row") ?? "",
  );
}

function chip(group: string, name: RegExp): HTMLElement {
  return within(screen.getByRole("group", { name: group })).getByRole("button", {
    name,
  });
}

afterEach(() => {
  state.data = null;
  state.isPending = false;
});

describe("/assets — the portfolio index", () => {
  it("states each site's one health word, with no control nested in the row, and the row opens its asset", () => {
    // The Health cell is the site's one word (D44), the same derivation as
    // Home's strip and the site's header — never a row of provider glyphs.
    const { container } = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/assets"]}><Routes>
      <Route path="/assets" element={<AssetsTable assets={ASSETS} nowMs={Date.parse("2026-08-01T12:00:00.000Z")} />} />
      <Route path="/assets/:id" element={<p>Asset destination</p>} />
    </Routes></MemoryRouter></QueryClientProvider>);
    const health = (id: string) => container.querySelector(`[data-asset-row="${id}"] td[data-label="Health"] [data-status-for="asset:${id}"]`);
    expect(health("meals.example")).toHaveTextContent("Off track");
    expect(health("nosh.example")).toHaveTextContent("At risk");
    expect(health("areas.example")).toHaveTextContent("Setting up");
    expect(container.querySelector("[data-source]")).toBeNull();
    expect(container.querySelector("button button, a button")).toBeNull();
    fireEvent.click(container.querySelector('[data-asset-row="meals.example"]')!);
    expect(screen.getByText("Asset destination")).toBeVisible();
  });

  /**
   * Bead `ro-ujb9.13`. At 390 a site's stacked card drew all eight columns,
   * 330px a site, so the first screen held one of three — and the card that
   * opens the site said so to nobody without a pointer. On a phone the card is
   * its key status plus the ›; the desk keeps every column.
   */
  it("on a phone, is a site's key status and the › that opens it", () => {
    const { container } = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/assets"]}>
      <AssetsTable assets={ASSETS} nowMs={Date.parse("2026-08-01T12:00:00.000Z")} />
    </MemoryRouter></QueryClientProvider>);
    const row = container.querySelector<HTMLElement>('[data-asset-row="meals.example"]')!;
    // The row opens, and the table draws the › on its stacked card.
    expect(row).toHaveAttribute("data-row-opens");
    expect(row).toHaveClass("cursor-pointer");
    const table = container.querySelector("table")!;
    expect(table.className).toContain("@max-[40rem]:[&_tr[data-row-opens]]:after:content-['']");
    expect(table.className).toContain("@max-[40rem]:[&_tr[data-row-opens]]:after:rotate-45");
    // What folds on a phone, and what a glance keeps.
    expect(row).toHaveAttribute("data-stack-fold");
    const folded = [...row.querySelectorAll("td[data-fold]")].map((cell) => cell.getAttribute("data-label"));
    expect(folded).toEqual(["Visitors · 28d", "Search clicks · 28d", "Net · August 2026", "Tasks"]);
    const kept = [...row.querySelectorAll("td:not([data-fold])")].map((cell) => cell.getAttribute("data-label"));
    // A glance keeps the name, the health word and one figure (D44).
    expect(kept).toEqual([null, "Health", "Visitors"]);
  });

  it("renders every asset in seed order by default, with no filter to clear", () => {
    const { container } = renderAssets();

    expect(screen.getByRole("heading", { level: 1, name: "Sites" })).toBeInTheDocument();
    expect(shown(container)).toEqual([
      "meals.example",
      "nosh.example",
      "areas.example",
      "fees.example",
    ]);
    expect(screen.getByText("4 sites")).toBeInTheDocument();
    expect(screen.getByLabelText("Sort")).toHaveValue("seed");
    expect(screen.queryByRole("link", { name: "Clear" })).toBeNull();
  });

  it("offers Add a site as the page's one primary action, opened over the page (beads ro-qsoo, ro-ujb9.96.7.5)", () => {
    const { container } = renderAssets();

    // A button, not a link: adding a site is one question asked over this page,
    // not a page of its own (test/add-site.test.tsx pins what it opens).
    const action = screen.getByRole("button", { name: "Add a site" });
    expect(action).toHaveAttribute("data-add-site-open");
    // It belongs to the header, not to the grid: an index page's add button is
    // where a SaaS operator looks for it, and there is exactly one of them.
    expect(container.querySelector("[data-page-header]")?.contains(action)).toBe(true);
    expect(screen.getAllByRole("button", { name: "Add a site" })).toHaveLength(1);
  });

  it("counts every option against the whole portfolio, not against the other filters", () => {
    renderAssets("/assets?status=live");

    const options = within(screen.getByLabelText("Status"))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual([
      "All stages · 4",
      "Pre-launch · 0",
      "Onboarding · 1",
      "Baselining · 1",
      "Live · 2",
      "Retired · 0",
    ]);

    // One chip per health word the portfolio holds, worst first, each with its
    // count: the answer to "which need me?" without opening a control.
    expect(
      within(screen.getByRole("group", { name: "Health" }))
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["All 4", "Off track 1", "At risk 1", "Setting up 2"]);
  });

  it("reads its filters from the URL, so a narrowed grid is a link", () => {
    const { container } = renderAssets("/assets?status=live&health=at-risk");

    expect(shown(container)).toEqual(["nosh.example"]);
    expect(screen.getByLabelText("Status")).toHaveValue("live");
    expect(chip("Health", /At risk/)).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("1 of 4 sites · status: live · health: at risk"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clear" })).toBeInTheDocument();
  });

  it("narrows the grid when the operator picks a chip", () => {
    const { container } = renderAssets();

    fireEvent.click(chip("Health", /Off track/));

    expect(shown(container)).toEqual(["meals.example"]);
    expect(chip("Health", /Off track/)).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("1 of 4 sites · health: off track"),
    ).toBeInTheDocument();
  });

  it("orders from the URL, worst first, with seed order as the tie-break", () => {
    const { container } = renderAssets("/assets?sort=health");

    expect(shown(container)).toEqual([
      "meals.example",
      "nosh.example",
      "areas.example",
      "fees.example",
    ]);
    expect(screen.getByLabelText("Sort")).toHaveValue("health");
    expect(screen.getByText("4 sites · sorted by health")).toBeInTheDocument();
  });

  it("orders by name, urgent work and visitors", () => {
    const byName = renderAssets("/assets?sort=name");
    expect(shown(byName.container)).toEqual([
      "areas.example",
      "fees.example",
      "meals.example",
      "nosh.example",
    ]);
    byName.unmount();

    // An asset with no beads snapshot at all is not "no urgent work": it sinks
    // below the measured zero rather than joining it.
    const byWork = renderAssets("/assets?sort=work");
    expect(shown(byWork.container)).toEqual([
      "meals.example",
      "fees.example",
      "nosh.example",
      "areas.example",
    ]);
    byWork.unmount();

    const byUsers = renderAssets("/assets?sort=users");
    expect(shown(byUsers.container)).toEqual([
      "meals.example",
      "nosh.example",
      "areas.example",
      "fees.example",
    ]);
  });

  it("falls back to seed order when the URL carries an ordering it cannot name", () => {
    const { container } = renderAssets("/assets?sort=whatever-an-old-bookmark-said");

    expect(shown(container)).toEqual([
      "meals.example",
      "nosh.example",
      "areas.example",
      "fees.example",
    ]);
    expect(screen.getByText("4 sites")).toBeInTheDocument();
  });

  it("clears every filter and the ordering at once", () => {
    const { container } = renderAssets("/assets?status=live&health=off-track&sort=name");

    expect(shown(container)).toEqual(["meals.example"]);

    fireEvent.click(screen.getByRole("link", { name: "Clear" }));

    expect(shown(container)).toEqual([
      "meals.example",
      "nosh.example",
      "areas.example",
      "fees.example",
    ]);
    expect(screen.getByText("4 sites")).toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toHaveValue("all");
    expect(screen.getByLabelText("Sort")).toHaveValue("seed");
    expect(screen.queryByRole("link", { name: "Clear" })).toBeNull();
  });

  it("says nothing matches, and never calls it an empty portfolio", () => {
    const { container } = renderAssets("/assets?status=retired");

    expect(screen.getByText("No sites match these filters")).toBeInTheDocument();
    // The portfolio is NOT empty — a control is.
    expect(screen.queryByText("No sites yet")).toBeNull();
    expect(shown(container)).toEqual([]);
    // The line above names the filter and holds the way back, once: the empty
    // state repeats neither and gives no directions (bead ro-ujb9.96.6.10).
    const summary = container.querySelector<HTMLElement>("[data-assets-summary]")!;
    expect(summary).toHaveTextContent("0 of 4 sites · status: retired");
    expect(within(summary).getByRole("link", { name: "Clear" })).toBeInTheDocument();
    expect(screen.queryByText(/widen a filter/)).toBeNull();
  });

  it("still says the store is empty when the store is empty, with Add a site as the way on", () => {
    renderAssets("/assets", []);

    expect(screen.getByText("No sites yet")).toBeInTheDocument();
    // D30: an empty install leads to the next action, never to a seed row.
    expect(screen.queryByText(/seed row/)).toBeNull();
    expect(screen.getByRole("button", { name: "Add a site" })).toBeInTheDocument();
    expect(screen.queryByText("No sites match these filters")).toBeNull();
  });

  // Bead ro-ujb9.96.6.18: the table's own default is what any caller without
  // an Add a site of its own gets — the door, never "arrives with its seed row".
  it("gives any other empty site list the door: No sites yet, with Add a site beside it", () => {
    const { container } = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter>
      <AssetsTable assets={[]} nowMs={Date.parse("2026-08-01T12:00:00.000Z")} />
    </MemoryRouter></QueryClientProvider>);
    const door = container.querySelector<HTMLElement>("[data-no-sites]")!;
    expect(door).toHaveTextContent("No sites yet");
    expect(within(door).getByRole("button", { name: "Add a site" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/seed row|onboarded|nightly report/u);
    expect(container.querySelector("table")).toBeNull();
  });
});

/**
 * Bead ro-ujb9.128: filters, a sort, a range and a strip adding the sites up
 * are how sites are COMPARED. Over no site they were twelve controls and 30
 * words round "No sites yet"; over one they filtered a single row.
 */
describe("/assets — the comparison arrives with a second site (ro-ujb9.128)", () => {
  /** Everything that exists to compare sites, by the handle each one wears. */
  function machinery(container: HTMLElement) {
    return {
      range: screen.queryByRole("group", { name: "Traffic period" }),
      filters: container.querySelector("[data-assets-filters]"),
      chips: container.querySelectorAll("[data-assets-filter]").length,
      sort: screen.queryByLabelText("Sort"),
      status: screen.queryByLabelText("Status"),
      answer: container.querySelector("[data-sites-answer]"),
      summary: container.querySelector("[data-assets-summary]"),
      about: container.querySelector("[data-about]"),
      sortableHeaders: container.querySelectorAll("th[aria-sort]").length,
    };
  }

  it("with no sites, is its header, Add a site and one empty state", () => {
    const { container } = renderAssets("/assets", []);
    expect(machinery(container)).toEqual({
      range: null, filters: null, chips: 0, sort: null, status: null, answer: null, summary: null, about: null, sortableHeaders: 0,
    });
    expect(screen.getByText("No sites yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toEqual([screen.getByRole("button", { name: "Add a site" })]);
    // No age for a page with nothing on it.
    expect(container.querySelector("[data-assets-age]")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
  });

  it("with one site, is that site's row and nothing to filter, sort or add up", () => {
    const { container } = renderAssets("/assets", [ASSETS[0]!]);
    expect(machinery(container)).toEqual({
      range: null, filters: null, chips: 0, sort: null, status: null, answer: null, summary: null, about: null, sortableHeaders: 0,
    });
    expect(shown(container)).toEqual(["meals.example"]);
    expect(within(container.querySelector<HTMLElement>('[data-asset-row="meals.example"]')!)
      .getByRole("link", { name: "Meal Planner" }).getAttribute("href")).toMatch(/^\/assets\/meals\.example/);
    expect(container.querySelector("[data-assets-age]")).toHaveTextContent("updated");
    // A link that narrows cannot hide the only site.
    renderAssets("/assets?status=retired&health=at-risk", [ASSETS[0]!]);
    expect(screen.queryByText("No sites match these filters")).toBeNull();
  });

  it("with two sites, compares them as before", () => {
    const { container } = renderAssets("/assets", ASSETS.slice(0, 2));
    const shownMachinery = machinery(container);
    expect(shownMachinery.range).not.toBeNull();
    expect(shownMachinery.filters).not.toBeNull();
    expect(shownMachinery.chips).toBe(1);
    expect(shownMachinery.sort).not.toBeNull();
    expect(shownMachinery.status).not.toBeNull();
    expect(shownMachinery.answer).toHaveTextContent("2 of 2 sites need you");
    expect(shownMachinery.summary).toHaveTextContent("2 sites");
    // Comparing needs no paragraph (bead ro-ujb9.96.6.10).
    expect(shownMachinery.about).toBeNull();
    expect(shownMachinery.sortableHeaders).toBeGreaterThan(0);
    expect(shown(container)).toEqual(["meals.example", "nosh.example"]);
  });

  // Bead ro-ujb9.163. Measured in a browser (docs/artifacts/site-table-fit-
  // 2026-09-24): the arrow each sortable header laid out beside its label held
  // 16px open in all seven — invisible until the column was the one ordering —
  // and five columns are as wide as their header, so this table ran 77px wider
  // than Home's identical one and 129px past its 982px card at 1280. jsdom has
  // no layout, so the mechanism is what is pinned: the arrow is positioned out
  // of the flow, before a right-aligned label and after a left-aligned one.
  it("orders by a header whose arrow takes no width, before a right-aligned label", () => {
    const { container } = renderAssets("/assets", ASSETS.slice(0, 2));
    const headers = [...container.querySelectorAll<HTMLElement>("th[aria-sort]")];
    expect(headers.length).toBe(6);
    for (const header of headers) {
      const glyph = header.querySelector("svg")!;
      expect(glyph.getAttribute("class")).toContain("absolute");
      // It hangs off the label, so it rides beside the words, not the cell edge.
      expect(glyph.parentElement!.className).toContain("relative");
      // The header's padding narrows with the table's (below 64rem).
      expect(header.querySelector("button")!.className).toContain("@max-[64rem]:px-2");
    }
    const glyphOf = (name: string) =>
      headers.find((header) => header.textContent === name)!.querySelector("svg")!.getAttribute("class")!;
    expect(glyphOf("Visitors")).toContain("right-full");
    expect(glyphOf("Site")).toContain("left-full");
    expect(glyphOf("Tasks")).toContain("left-full");
  });
});

/**
 * Doc 21, bead `ro-78qo.7`. The page is a COMPARISON: the strip is the portfolio
 * added up and the table is the same assets one per row. Nothing on it duplicates
 * an asset's own page.
 */
describe("/assets — composed to doc 21", () => {
  it("opens with one answer: which sites need you, by the one health word (D44)", () => {
    const { container } = renderAssets();

    // No strip of equal boxes: one sentence, the sites it names, and the
    // month's figure from Home's own derivation.
    const answer = container.querySelector<HTMLElement>("[data-sites-answer]")!;
    expect(answer).toHaveAttribute("data-surface-hero");
    expect(answer).toHaveAttribute("data-sites-answer", "needs-you");
    expect(within(answer).getByRole("heading", { level: 2 })).toHaveTextContent("2 of 4 sites need you");
    expect(answer).toHaveTextContent("Meal Planner · Nosh");
    expect(container.querySelector("[data-kpi-strip]")).toBeNull();
    expect(screen.getByRole("button", { name: "Filters & sort" })).toHaveAttribute("aria-expanded", "false");
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

  it("counts active filters on the phone control without counting traffic range or sort", () => {
    const { container } = renderAssets("/assets?status=live&health=at-risk&range=7&sort=name");
    // The shared fold (bead ro-ujb9.13): the badge is the digit, the name says what it counts.
    const control = screen.getByRole("button", { name: "Filters & sort, 2 on" });
    expect(control).toHaveAttribute("aria-expanded", "false");
    expect(control).toHaveClass("sm:hidden");
    const filters = container.querySelector("[data-assets-filters]")!;
    expect(filters).toHaveClass("max-sm:hidden", "flex");
    expect(control).toHaveAttribute("aria-controls", filters.id);
    fireEvent.click(control);
    expect(control).toHaveAttribute("aria-expanded", "true");
    expect(filters).not.toHaveClass("max-sm:hidden");
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "all" } });
    expect(screen.getByRole("button", { name: "Filters & sort, 1 on" })).toBeInTheDocument();
    // The period is not a filter: it stays in view beside the button.
    expect(container.querySelector("[data-assets-traffic-controls]")).toContainElement(control);
    expect(container.querySelector("[data-assets-traffic-controls]")).toContainElement(screen.getByRole("group", { name: "Traffic period" }));
  });

  /**
   * The audit's own rule, held locally so a regression fails in `pnpm test`
   * rather than only under a browser: every number that CAN have a series shows
   * one, a number whose shape is how a total DIVIDES shows its composition, and
   * a number with neither declares the gap in words.
   */
  it("gives every KPI a series, a composition or a declared gap", () => {
    const { container } = renderAssets();

    for (const cell of container.querySelectorAll("[data-kpi]")) {
      const answered =
        cell.querySelector("[data-spark]") !== null ||
        cell.querySelector("[data-composition]") !== null ||
        cell.getAttribute("data-series") === "unavailable";
      expect(
        answered,
        `${cell.getAttribute("data-kpi")} shows a bare number`,
      ).toBe(true);
      if (cell.getAttribute("data-series") === "unavailable") {
        // The reason remains reachable by keyboard/tap, not only native hover.
        expect(cell.getAttribute("data-series-reason")).toBeTruthy();
        fireEvent.click(within(cell as HTMLElement).getByRole("button", { name: `About ${cell.getAttribute("data-kpi")}` }));
        expect(screen.getByRole("tooltip")).toHaveTextContent(cell.getAttribute("data-series-reason")!);
        fireEvent.keyDown(window, { key: "Escape" });
      }
    }
  });

  it("answers for the portfolio, not the filtered view", () => {
    const { container } = renderAssets("/assets?status=live");

    // Two of the four are live, and the answer still speaks for all four: it
    // is a fact about the portfolio, and the summary line below owns the
    // current view's arithmetic.
    expect(container.querySelector("[data-sites-answer]")).toHaveTextContent("2 of 4 sites need you");
    expect(screen.getByText("2 of 4 sites · status: live")).toBeInTheDocument();
  });


  it("draws the urgent count and share in PriorityBar's ink, never an attention hue (ro-ujb9.240)", () => {
    const { container } = renderAssets();

    // A task's priority is not a severity (doc 14): "2 urgent" wears the
    // foreground ink the top bands' marks wear, not amber, and the strip's
    // urgent share is the same ramp as the table's bars.
    const urgent = container.querySelector<HTMLElement>('[data-asset-row="meals.example"] [data-urgent-count]')!;
    expect(urgent.textContent).toBe("2 urgent");
    expect(urgent.className).toContain("text-foreground");
    expect(urgent.className).not.toMatch(/\btext-(error|warn|info)\b/);
  });

  it("sorts from the header row, and a second press returns to seed order", () => {
    const { container } = renderAssets();

    fireEvent.click(screen.getByRole("button", { name: /^Site/ }));
    expect(shown(container)).toEqual([
      "areas.example",
      "fees.example",
      "meals.example",
      "nosh.example",
    ]);
    expect(screen.getByLabelText("Sort")).toHaveValue("name");
    expect(screen.getByText("4 sites · sorted by name")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Site/ }));
    expect(shown(container)).toEqual([
      "meals.example",
      "nosh.example",
      "areas.example",
      "fees.example",
    ]);
    expect(screen.getByLabelText("Sort")).toHaveValue("seed");
  });

  it("orders by net and by the 7-day move, with an unmeasured row last", () => {
    const withMoney = [
      assetCard({ id: "a.example", booked: { currency: 'USD', revenue: 10, cost: 1, net: 9 } }),
      assetCard({ id: "b.example", booked: { currency: 'USD', revenue: 10, cost: 40, net: -30 } }),
      assetCard({ id: "c.example" }),
    ];
    const { container } = renderAssets("/assets?sort=net", withMoney);

    // Nothing booked is NOT the worst month: it is no month at all, and it
    // sinks below the loss rather than joining it.
    expect(shown(container)).toEqual(["a.example", "b.example", "c.example"]);
  });

  /**
   * Bead `ro-78qo.35`. Doc 21's Assets row names three sparkline columns and the
   * page shipped with one, because the payload carried one. These are the other
   * two, and the comparison column that finally follows the range.
   */
  describe("the three things an operator compares", () => {
    /** `n` consecutive days ending on 2026-08-01, the fixture's "today". */
    const days = (n: number, from = 100) =>
      Array.from({ length: n }, (_, index) => ({
        t: new Date(
          Date.parse("2026-08-01T00:00:00.000Z") - (n - 1 - index) * 86_400_000,
        )
          .toISOString()
          .slice(0, 10),
        v: from + index,
      }));

    const withSeries = () => [
      assetCard({ netByMonthCurrency: 'USD',
        id: "full.example",
        activeUsers: {
          // 62 days of context in front of 28 of readings — the ninety the
          // payload carries, and the reason 90d is offered at all.
          contextSeries: days(90).slice(0, 62),
          series: days(90).slice(62),
          provisionalFrom: null,
          collectedAt: null,
          timeZoneChanges: [],
        },
        searchClicks: {
          contextSeries: days(90, 500).slice(0, 62),
          series: days(90, 500).slice(62),
          provisionalFrom: null,
          collectedAt: null,
          timeZoneChanges: [],
        },
        netByMonth: [
          { t: "2026-05", v: 120 },
          // A month nothing was booked in is a HOLE, never a zero.
          { t: "2026-06", v: null },
          { t: "2026-07", v: 240 },
          { t: "2026-08", v: 90 },
        ],
        netByMonthProvisionalFrom: "2026-08",
        booked: { currency: 'USD', revenue: 100, cost: 10, net: 90 },
      }),
      QUIET,
    ];


    it("changes only traffic when switching 7 and 90 days", () => {
      const { container } = renderAssets("/assets?range=7", withSeries(), {
        firstRun: false,
        booked: { currency: 'USD', revenue: 440, cost: 200, net: 240 },
      });
      const answer = container.querySelector("[data-sites-answer]")!.textContent;
      const range = screen.getByRole("group", { name: "Traffic period" });
      expect(container.querySelector("[data-assets-traffic-controls]")).toContainElement(range);
      expect(screen.getByText("Traffic period")).toBeInTheDocument();
      fireEvent.click(within(range).getByRole("button", { name: "90d" }));

      // The answer is not a traffic figure: the range leaves it alone.
      expect(container.querySelector("[data-sites-answer]")!.textContent).toBe(answer);
      expect(screen.getByRole("columnheader", { name: /^Visitors · 90d/ })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "full.example" })).toHaveAttribute("href", "/assets/full.example?range=90");
    });



    it("draws clicks and net beside users, each with its own line", () => {
      const { container } = renderAssets("/assets", withSeries());

      expect(container.querySelector("[data-users-spark]")).not.toBeNull();
      expect(container.querySelector("[data-clicks-spark]")).not.toBeNull();
      // Net's line lives in the Net CELL rather than in a column of its own:
      // the figure and its shape are one fact, so a second Net header would be
      // that fact twice (doc 14).
      const net = container.querySelector<HTMLElement>('td[data-label="Net · August 2026"]')!;
      expect(net.querySelector("[data-net-spark]")).not.toBeNull();
      expect(net.textContent).toContain("$90");
      expect(net.textContent).toContain("Booked");
    });

    it("windows all three by date when the range changes", () => {
      const label = (container: HTMLElement, mark: string) =>
        container
          .querySelector(`[${mark}] [role='img']`)
          ?.getAttribute("aria-label") ?? "";

      const ninety = renderAssets("/assets?range=90", withSeries());
      expect(label(ninety.container, "data-users-spark")).toContain("2026-05-04");
      expect(label(ninety.container, "data-clicks-spark")).toContain("2026-05-04");
      expect(
        screen.getByRole("columnheader", { name: /^Visitors · 90d/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("columnheader", { name: /^Search clicks · 90d/ }),
      ).toBeInTheDocument();
      ninety.unmount();

      const week = renderAssets("/assets?range=7", withSeries());
      expect(label(week.container, "data-users-spark")).toContain("2026-07-26");
      expect(label(week.container, "data-clicks-spark")).toContain("2026-07-26");
      // The MONTHLY line does not window: it is the asset's whole ledger, and a
      // range measured in days has nothing to say to it.
      expect(
        week.container.querySelector("[data-net-spark] [role='img']")
          ?.getAttribute("aria-label"),
      ).toContain("2026-05 to 2026-08");
    });

    /**
     * The move was a column of its own headed "7-day", which took a paragraph
     * to explain. It now rides the users line it describes, under the header
     * that names the users and the window — doc 21's KPI unit at row height —
     * and that header is the one that orders by it (bead ro-ujb9.96.6.10).
     * At ninety days there is nothing to compare against, so nothing is drawn.
     */
    it("puts the range's move beside the users line, and draws none it cannot defend", () => {
      const week = renderAssets("/assets?range=7", withSeries());
      expect(screen.queryByRole("columnheader", { name: "7-day" })).toBeNull();
      const users = week.container.querySelector<HTMLElement>('tr[data-asset-row="full.example"] td[data-label="Visitors · 7d"]')!;
      expect(users.querySelector("[data-users-spark]")).not.toBeNull();
      // Seven rising days against the seven before them.
      expect(users.querySelector("[data-tone]")?.textContent).toMatch(/%/u);
      expect(users.querySelector("[data-tone]")).toHaveAccessibleName(/Active users over/);
      fireEvent.click(screen.getByRole("button", { name: /^Visitors · 7d/ }));
      expect(screen.getByLabelText("Sort")).toHaveValue("trend");
      week.unmount();

      const ninety = renderAssets("/assets?range=90", withSeries());
      const wide = ninety.container.querySelector<HTMLElement>('tr[data-asset-row="full.example"] td[data-label="Visitors · 90d"]')!;
      expect(wide.querySelector("[data-users-spark]")).not.toBeNull();
      expect(wide.textContent).not.toMatch(/%|—/u);
    });

    it("names daily users consistently and prints the settled report's older day", () => {
      const { container } = renderAssets("/assets", [assetCard({
        id: "older.example",
        activeUsers: { series: [{ t: "2026-07-30", v: 900 }], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
      })]);
      expect(screen.getByRole("columnheader", { name: "Visitors" })).toBeInTheDocument();
      expect(screen.queryByRole("columnheader", { name: "Today" })).toBeNull();
      const daily = container.querySelector<HTMLElement>('tr[data-asset-row="older.example"] td[data-label="Visitors"]')!;
      expect(daily.querySelector("time")).toHaveAttribute("dateTime", "2026-07-30");
      expect(daily).toHaveTextContent("900Jul 30");
      expect(daily.querySelector("[data-users-day]")).toHaveAttribute("data-users-day", "2026-07-30");
      expect(daily.querySelector("[title]")).toBeNull();
    });

    it("says why a line is missing in a label rather than drawing a zero", () => {
      // The default fixture wires no search provider at all.
      const { container } = renderAssets();
      const clicks = container.querySelector<HTMLElement>(
        'td[data-label="Search clicks · 28d"]',
      )!;
      expect(clicks.textContent).toContain("—");
      fireEvent.focus(within(clicks).getByRole("button", { name: "No days reported yet" }));
      expect(screen.getByRole("tooltip")).toHaveTextContent("No days reported yet");
    });

    // The line says how it is drawn in its own readout; the header names the
    // quantity and the window only, with no paragraph behind it — a longer
    // header held the row past the card at 1440 (bead ro-ujb9.96.6.10).
    it("names the quantity and window on the header, and the method on the line", () => {
      const { container } = renderAssets("/assets", withSeries());
      for (const name of ["Visitors · 28d", "Search clicks · 28d"]) {
        const header = screen.getByRole("columnheader", { name });
        expect(within(header).queryByRole("button", { name: /^About/ })).toBeNull();
      }
      for (const mark of ["data-users-spark", "data-clicks-spark"]) {
        expect(within(container.querySelector<HTMLElement>(`tr[data-asset-row="full.example"] [${mark}]`)!)
          .getByRole("img")).toHaveAccessibleDescription(/trailing 7-day average/);
      }
    });
  });

  it("re-derives the sparkline column when the range changes", () => {
    /** `n` consecutive days ending on 2026-08-01, the fixture's "today". */
    const days = (n: number) =>
      Array.from({ length: n }, (_, index) => ({
        t: new Date(
          Date.parse("2026-08-01T00:00:00.000Z") - (n - 1 - index) * 86_400_000,
        )
          .toISOString()
          .slice(0, 10),
        v: 100 + index,
      }));
    const long = [
      assetCard({
        id: "long.example",
        activeUsers: {
          series: days(28),
          provisionalFrom: null,
          collectedAt: null,
          timeZoneChanges: [],
        },
      }),
      QUIET,
    ];

    const wide = renderAssets("/assets", long);
    expect(
      wide.container.querySelector("[data-users-spark] [role='img']")
        ?.getAttribute("aria-label"),
    ).toContain("2026-07-05 to 2026-08-01");
    wide.unmount();

    const narrow = renderAssets("/assets?range=7", long);
    // Seven days, by DATE rather than by point count.
    expect(
      narrow.container.querySelector("[data-users-spark] [role='img']")
        ?.getAttribute("aria-label"),
    ).toContain("2026-07-26 to 2026-08-01");
  });

  it("offers all three of doc 21's windows", () => {
    renderAssets();

    const range = screen.getByRole("group", { name: "Traffic period" });
    // 90d arrived with the payload that can fill it (bead `ro-78qo.35`): the
    // asset series is 62 days of context in front of 28 days of readings, which
    // is the ninety this button asks for. Until then the page offered 7 and 28
    // only, because a button that drew 28 days under a label saying three
    // months would have been the page lying about its own window.
    expect(
      within(range).getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["7d", "28d", "90d"]);
  });

  /**
   * The whole point of the rebuild: an asset's active bet, live counters,
   * product totals, hourly chart and 28-day bars belong to ONE asset, so they
   * live on that asset's Overview and this page shows none of them.
   */
  it("shows no per-asset card content at all", () => {
    const { container } = renderAssets();

    expect(container.querySelector("[data-property-card]")).toBeNull();
    expect(screen.queryByText(/All-time totals/)).toBeNull();
    // One row per asset, and the row opens the asset.
    expect(container.querySelectorAll("[data-asset-row]")).toHaveLength(4);
    expect(screen.getByRole("link", { name: "Meal Planner" })).toHaveAttribute(
      "href",
      "/assets/meals.example",
    );
  });

  /** Bead ro-ujb9.96.7.4: a site with no number yet has an empty Overview, so
   * its row opens its Data sources, where its next action is. */
  it("opens a site with no number yet on its Data sources", () => {
    renderAssets("/assets", [assetCard({ id: "meals.example", displayName: "Meal Planner" }), QUIET]);

    expect(screen.getByRole("link", { name: "quiet.example" })).toHaveAttribute("href", "/assets/quiet.example/sources");
    expect(screen.getByRole("link", { name: "Meal Planner" })).toHaveAttribute("href", "/assets/meals.example");
  });

  /** Bead ro-ujb9.96.6.10: every fact the About's five paragraphs carried is
   * on the page as a label, a state or a line's own readout, so there is no
   * paragraph left to fold away. */
  it("needs no About", () => {
    const { container } = renderAssets();

    expect(container.querySelector("[data-about]")).toBeNull();
    expect(screen.queryByText(/About these numbers/)).toBeNull();
  });
});


describe("Sites reasons support focus and tap (ro-ujb9.241)", () => {
  it("opens a missing task reason without activating its navigation row", () => {
    const asset = assetCard({ id: "reason.example" });
    const { container } = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/assets"]}><Routes>
      <Route path="/assets" element={<AssetsTable assets={[asset]} nowMs={Date.parse("2026-08-01T12:00:00Z")} />} />
      <Route path="*" element={<div>Opened site</div>} />
    </Routes></MemoryRouter></QueryClientProvider>);
    const reason = screen.getByRole("button", { name: "No task data" });
    fireEvent.focus(reason);
    expect(screen.getByRole("tooltip")).toHaveTextContent("No task data");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.pointerDown(reason, { pointerType: "touch" });
    fireEvent.click(reason);
    expect(screen.getByRole("tooltip")).toHaveTextContent("No task data");
    expect(screen.queryByText("Opened site")).toBeNull();
    fireEvent.click(container.querySelector('[data-asset-row="reason.example"]')!);
    expect(screen.getByText("Opened site")).toBeVisible();
  });

  it("explains incomparable users and the still-counted day through actual controls", () => {
    const series = Array.from({ length: 28 }, (_, i) => ({ t: `2026-07-${String(i + 1).padStart(2, "0")}`, v: 100 }));
    series.splice(15, 1);
    const { unmount } = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><AssetsTable assets={[assetCard({ id: "reason.example", activeUsers: {
      series, provisionalFrom: null, collectedAt: null, timeZoneChanges: [],
    } })]} nowMs={Date.parse("2026-08-01T12:00:00Z")} rangeDays={7} /></MemoryRouter></QueryClientProvider>);
    fireEvent.focus(screen.getByRole("button", { name: "Why users are not comparable" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Active users over");
    unmount();
    renderAssets("/assets", [assetCard({ id: "counting.example", activeUsers: {
      series: [{ t: "2026-08-01", v: 0 }], provisionalFrom: "2026-08-01", collectedAt: null, timeZoneChanges: [],
    } })]);
    const today = screen.getByRole("button", { name: "About today's users" });
    expect(screen.getByRole("columnheader", { name: "Visitors" })).toBeInTheDocument();
    expect(today.closest("td")).toHaveAttribute("data-label", "Visitors");
    expect(today.closest("[data-users-day]")).toHaveAttribute("data-users-day", "open");
    expect(today).toHaveTextContent("0");
    fireEvent.click(today);
    expect(screen.getByRole("tooltip")).toHaveTextContent("So far today, still being counted");
  });
});
