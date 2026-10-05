import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DomainOrder,
  type DomainSchedule,
  type FinancialsPayload,
  type RecurringCost,
} from "@shared/financials";

// /financials after bead `ro-69vb`. The page used to describe the current
// calendar month and nothing else, so on the first days of a month its three
// period-scoped blocks all read $0.00 directly under a trajectory table showing
// a real August — and no past month could be opened at all. The month is now a
// URL, the page opens on the latest one holding rows, and the header says so
// when that is not this month.

const state = vi.hoisted(() => ({
  data: undefined as FinancialsPayload | undefined,
  /** What the read failed with, when it failed (bead `ro-dm67`). */
  error: null as unknown,
  /** Every period the route asked the hook for, in order. */
  asked: [] as (string | null | undefined)[],
}));

// The page EDITS its own inputs since bead `ro-x5gu.2`, so the toast the write
// lane answers with is part of the route now. Sonner is mocked rather than
// mounted: the Undo is a callback, and calling it directly is what proves the
// second write's shape.
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

vi.mock("@/hooks/useFinancials", () => ({
  useFinancials: (period?: string | null) => {
    state.asked.push(period);
    return {
      data: state.data,
      isPending: false,
      isError: state.error !== null,
      error: state.error,
    };
  },
}));

// How many sites the installation has (the sidebar's read): unknown unless a
// case says, which leaves the page to count the month's rows (bead
// ro-ujb9.129).
const wall = vi.hoisted(() => ({ sites: null as number | null }));
vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({
    data: wall.sites === null ? undefined : { assets: Array.from({ length: wall.sites }, (_, index) => ({ id: `site-${index}` })) },
    isPending: wall.sites === null,
    isError: false,
  }),
}));

import { FinancialsPeriodError, fetchFinancials } from "@/lib/api";
import FinancialsRoute from "@/routes/FinancialsRoute";

function payload(overrides: Partial<FinancialsPayload> = {}): FinancialsPayload {
  return {
    generatedAt: "2026-09-04T12:00:00.000Z",
    period: "2026-08",
    periods: ["2026-06", "2026-07", "2026-08"],
    periodIsCurrent: false,
    currentPeriod: "2026-09",
    months: [
      {
        period: "2026-08",
        booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
        estimated: { currency: 'USD', revenue: 440.94, cost: 200, net: 240.94 },
        total: { currency: 'USD', revenue: 440.94, cost: 200, net: 240.94 },
      },
    ],
    properties: [
      {
        asset: "meals.example",
        displayName: "Meal Planner",
        isOs: false,
        revenueReported: true,
        figure: { currency: 'USD', revenue: 440.94, cost: 3.05, net: 437.89 },
        months: [
          { period: "2026-06", figure: { currency: 'USD', revenue: 100, cost: 3.05, net: 96.95 } },
          { period: "2026-07", figure: { currency: 'USD', revenue: 200, cost: 3.05, net: 196.95 } },
          { period: "2026-08", figure: { currency: 'USD', revenue: 440.94, cost: 3.05, net: 437.89 } },
        ],
      },
    ],
    overhead: { currency: 'USD', revenue: 0, cost: 200, net: -200 },
    costLines: [
      { currency: 'USD',
        family: "inference",
        provenance: "stated",
        source: "recurring:claude-code",
        amount: 200,
        rows: 1,
      },
    ],
    domains: [],
    recurringCosts: [],
    domainOrders: [],
    empty: false,
    ...overrides,
  };
}

/** The URL the page is actually on, so a selection can be proved to be a link
 * rather than component state. */
function Location() {
  return <span data-testid="search">{useLocation().search}</span>;
}

/** The page as it renders when the read was REFUSED — no payload, an error
 * carrying the months that do exist (bead `ro-dm67`). */
function renderRefusal(error: unknown, entry: string) {
  state.error = error;
  return renderPage(undefined, entry);
}

/** The client the page's own writes invalidate through — held so a test can
 * watch the financials read being thrown away after a save. */
let client: QueryClient;

function renderPage(data: FinancialsPayload | undefined, entry = "/financials") {
  state.data = data;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <FinancialsRoute />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const picker = () => screen.getByRole("combobox", { name: "Accounting period" });

/* A signed estimated adjustment is still unchecked money: it is counted by its
   size in Reconciled's "estimated" half (bead ro-ujb9.96.6.9), where it used to
   be flagged by an "includes estimates" suffix on Net — the same fact in two
   KPIs. A signed sum would have hidden it: 100 booked + (−10) estimated reads
   as a fully reconciled 90. */
it('counts signed estimated adjustments as estimated money, once, on Reconciled', () => {
  const { container } = renderPage(payload({ months: [{ period: '2026-08',
    booked: { currency: 'USD', revenue: 100, cost: 0, net: 100 },
    estimated: { currency: 'USD', revenue: -10, cost: 0, net: -10 },
    total: { currency: 'USD', revenue: 90, cost: 0, net: 90 },
  }] }));
  const reconciled = container.querySelector('[data-kpi="Reconciled"]')!;
  expect(reconciled).toHaveTextContent('$100.00');
  expect(reconciled).toHaveTextContent('$10.00 estimated');
  expect(reconciled.querySelector('[data-segment="estimated"]')).not.toBeNull();
  expect(container.querySelector('[data-kpi="Net"]')).not.toHaveTextContent('estimate');
});

it('shows daily portfolio coverage before asset contributions and keeps monthly costs outside its bars', () => {
  const { container } = renderPage(payload({ dailyRevenue: {
    from: '2026-08-01', to: '2026-08-31', reportedThrough: '2026-08-31',
    days: [{ date: '2026-08-31', amountMinor: 1234 }],
    sources: [{ asset: 'meals.example', displayName: 'Meal Planner', since: '2026-04-01' }, { asset: 'nosh.example', displayName: 'Nosh', since: '2026-08-10' }],
    coverage: [{ date: '2026-08-31', reported: 1, missingAssets: ['nosh.example'] }],
  } }));
  const daily = screen.getByRole('region', { name: 'Daily revenue' });
  expect(daily).toHaveTextContent('Aug 1, 2026 – Aug 31, 2026');
  // The partial day is the chart's own key, with its count — not a sentence.
  expect(daily.querySelector('[data-legend-partial]')).toHaveTextContent('1 partial day');
  expect(daily.querySelector('[data-hero-bar][data-partial]')).not.toBeNull();
  expect(daily).not.toHaveTextContent('partial reports');
  expect(daily.querySelector('[data-hero-bar]')).toHaveAttribute('data-value', '12.34');
  expect(daily).not.toHaveTextContent('$200.00');
  // Each source carries its own coverage, and the one that missed days wears
  // the warn ink on its count.
  const nom = daily.querySelector('[data-source-coverage-asset="nosh.example"]')!;
  expect(nom).toHaveTextContent(/Nosh\s*0\/1 days/);
  expect(nom.querySelector('.text-warn')).toHaveTextContent('0/1 days');
  expect(daily.querySelector('[data-source-coverage-asset="meals.example"] .text-warn')).toBeNull();
  expect(within(daily).getByRole('link', { name: /Nosh/ })).toHaveAttribute('href', '/assets/nosh.example/financials');
  expect(daily).not.toHaveTextContent('Only saved Mediavine estimates');
  expect(container.querySelector('[data-panel="months"] [data-hero-chart]')).toBeNull();
});

/* Bead `ro-rd6r`: a source's count runs from its first report, so a site that
   joined mid-window is measured on the days it owed, not on the whole month. */
it('counts each source against the days since it first reported', () => {
  renderPage(payload({ dailyRevenue: {
    from: '2026-09-01', to: '2026-09-03', reportedThrough: '2026-09-03',
    days: [{ date: '2026-09-01', amountMinor: 700 }, { date: '2026-09-02', amountMinor: 700 }, { date: '2026-09-03', amountMinor: 740 }],
    sources: [{ asset: 'meals.example', displayName: 'Meal Planner', since: '2026-04-01' }, { asset: 'nosh.example', displayName: 'Nosh', since: '2026-09-02' }],
    coverage: [
      { date: '2026-09-01', reported: 1, missingAssets: [] },
      { date: '2026-09-02', reported: 1, missingAssets: ['nosh.example'] },
      { date: '2026-09-03', reported: 2, missingAssets: [] },
    ],
  } }));
  const daily = screen.getByRole('region', { name: 'Daily revenue' });
  expect(daily.querySelector('[data-source-coverage-asset="meals.example"]')).toHaveTextContent(/Meal Planner\s*3\/3 days/);
  expect(daily.querySelector('[data-source-coverage-asset="nosh.example"]')).toHaveTextContent(/Nosh\s*1\/2 days/);
  expect(daily.querySelector('[data-legend-partial]')).toHaveTextContent('1 partial day');
});

it('shows only the missing site as short when two sites share a display name', () => {
  renderPage(payload({ dailyRevenue: {
    from: '2026-09-01', to: '2026-09-02', reportedThrough: '2026-09-02',
    days: [{ date: '2026-09-01', amountMinor: 1200 }, { date: '2026-09-02', amountMinor: 700 }],
    sources: [
      { asset: 'first.example', displayName: 'Blog', since: '2026-09-01' },
      { asset: 'second.example', displayName: 'Blog', since: '2026-09-01' },
    ],
    coverage: [
      { date: '2026-09-01', reported: 2, missingAssets: [] },
      { date: '2026-09-02', reported: 1, missingAssets: ['second.example'] },
    ],
  } }));
  const daily = screen.getByRole('region', { name: 'Daily revenue' });
  const first = daily.querySelector<HTMLLIElement>('[data-source-coverage-asset="first.example"]')!;
  const second = daily.querySelector<HTMLLIElement>('[data-source-coverage-asset="second.example"]')!;
  expect(first).toHaveTextContent(/Blog\s*2\/2 days/);
  expect(first.querySelector('.text-warn')).toBeNull();
  expect(second).toHaveTextContent(/Blog\s*1\/2 days/);
  expect(second.querySelector('.text-warn')).toHaveTextContent('1/2 days');
  expect(within(second).getByRole('link', { name: /Blog/ })).toHaveAttribute('href', '/assets/second.example/financials');
  fireEvent.keyDown(within(daily).getByRole('group', { name: 'Explore Estimated ad revenue values' }), { key: 'End' });
  expect(within(daily).getByRole('status')).toHaveTextContent('Missing: Blog');
  expect(within(daily).getByRole('status')).not.toHaveTextContent('second.example');
});

/**
 * The config write lane, stubbed.
 *
 * A GET is the deployment's writability answer; anything else is a changeset,
 * recorded so a case can assert the exact ops it sent. Nothing here writes a
 * file — the point is the SHAPE of what the page asks for.
 */
interface LaneCall {
  method: string;
  body: { ops: unknown[]; slug?: string } | null;
}

function stubLane(
  writable: { writable: boolean; reason: string | null } = { writable: true, reason: null },
  reply: { status: number; body: unknown } = { status: 200, body: { applied: 1, archive: null, commit: null } },
  /** The assets the integration matrix answers with — the picker behind the
   * Asset column (bead `ro-x5gu.10`). Undefined leaves that read unanswered,
   * which is how the cases above see no picker and no candidate refusal. */
  assets?: string[],
): LaneCall[] {
  const calls: LaneCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && String(input).includes("/api/integrations")) {
        return new Response(
          JSON.stringify({
            assets: (assets ?? []).map((id) => ({ id, displayName: id, isOs: false })),
            catalog: [],
            derivedLanes: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "GET") {
        return new Response(JSON.stringify(writable), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      calls.push({
        method,
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

beforeEach(() => {
  toasts.success.mockReset();
  toasts.error.mockReset();
});

afterEach(() => {
  state.data = undefined;
  state.error = null;
  state.asked = [];
  wall.sites = null;
  vi.unstubAllGlobals();
});

describe("/financials — picking a period", () => {
  it("offers every month the ledger holds, named in full, newest first", () => {
    renderPage(payload());

    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["August 2026", "July 2026", "June 2026"]);
    // The shown month is what the control reads, so nothing else in the header
    // has to repeat it.
    expect(picker()).toHaveValue("2026-08");
  });

  it("asks the store for the month in the URL", () => {
    renderPage(payload({ period: "2026-07" }), "/financials?period=2026-07");

    expect(state.asked.at(-1)).toBe("2026-07");
    expect(picker()).toHaveValue("2026-07");
  });

  it("asks for nothing in particular when the URL names no month", () => {
    renderPage(payload());
    expect(state.asked.at(-1)).toBeNull();
  });

  // A month has to be a LINK: the operator's whole workflow here is checking a
  // figure against a receipt with somebody else, and "open financials, then
  // change the dropdown to June" is not something you can send.
  it("puts a chosen month in the URL and asks the store for it", () => {
    renderPage(payload());

    fireEvent.change(picker(), { target: { value: "2026-06" } });

    expect(screen.getByTestId("search")).toHaveTextContent("?period=2026-06");
    expect(state.asked.at(-1)).toBe("2026-06");
  });
});

describe("/financials — saying which month it is showing", () => {
  /**
   * THE SUBTITLE IS THE PAGE\'S QUESTION, NOT A FACT ABOUT THE QUERY (doc 21).
   *
   * It used to read "latest month with rows" whenever the ledger\'s newest month
   * was not the calendar one — a sentence about how the payload picked a period,
   * which is the sort of thing a database says and an operator never asks. The
   * selector opposite names the month in full and a reader standing in September
   * can see it; what nothing on the page said was what the page is FOR.
   */
  it("puts the page\'s one question in the header, on every month", () => {
    const { container } = renderPage(payload());
    expect(container.querySelector("[data-page-header]")?.textContent).toContain(
      "Am I making money, and where?",
    );
    expect(container.querySelector("[data-period-fallback]")).toBeNull();

    // Including the month being lived in, and a mid-history month chosen by
    // hand: the question does not depend on which period is shown.
    renderPage(
      payload({ period: "2026-09", periods: ["2026-08", "2026-09"], periodIsCurrent: true }),
    );
    expect(document.body.textContent).toContain("Am I making money, and where?");
  });

  it("still lets a mid-history month be chosen, and shows it in the selector", () => {
    renderPage(payload({ period: "2026-06" }), "/financials?period=2026-06");
    expect(picker()).toHaveValue("2026-06");
  });
});

// Bead `ro-dm67`. A bookmark to last quarter's month is exactly the link a
// finance page receives. It used to land on "The ledger did not answer" — a
// sentence about a broken database — with the selector gone too, because the
// selector is drawn from a payload that never arrived, so the only way out was
// editing the URL.
describe("/financials — a month the ledger cannot answer", () => {
  const refusal = (
    code: "period_not_found" | "period_malformed",
    status: number,
    periods = ["2026-06", "2026-07", "2026-08"],
  ) => new FinancialsPeriodError(code, status, periods);

  it("names the month it could not find instead of blaming the ledger", () => {
    const { container } = renderRefusal(
      refusal("period_not_found", 404),
      "/financials?period=2020-01",
    );

    expect(screen.getByText("Nothing recorded for January 2020")).toBeInTheDocument();
    expect(screen.queryByText("The ledger did not answer")).toBeNull();
    expect(container.querySelector("[data-period-missing]")).toHaveAttribute(
      "data-period-missing",
      "2020-01",
    );
  });

  it("offers every month the ledger holds as a link, newest first", () => {
    renderRefusal(refusal("period_not_found", 404), "/financials?period=2020-01");

    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "August 2026",
      "July 2026",
      "June 2026",
    ]);
    // The newest month is what the page opens on by itself, so it is the bare
    // URL — following it leaves no stale month to bookmark a second time.
    expect(links[0]).toHaveAttribute("href", "/financials");
    expect(links[1]).toHaveAttribute("href", "/financials?period=2026-07");
  });

  it("keeps the selector, valued at the month that is not there", () => {
    renderRefusal(refusal("period_not_found", 404), "/financials?period=2020-01");

    // The bug was the selector vanishing with the payload. Its value is the
    // requested month rather than a real one, so picking any real month is a
    // change the control actually fires.
    expect(picker()).toHaveValue("2020-01");
    fireEvent.change(picker(), { target: { value: "2026-07" } });
    expect(screen.getByTestId("search")).toHaveTextContent("?period=2026-07");
  });

  it("answers a value that is not a month at all the same way, quoted", () => {
    renderRefusal(refusal("period_malformed", 400), "/financials?period=last-quarter");

    expect(
      screen.getByText("Nothing recorded for “last-quarter”"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(picker()).toHaveValue("last-quarter");
  });

  /* A ledger holding no month at all has nothing to fall back to, so it is the
     first run: the next step, not a sentence saying there is none (bead
     ro-ujb9.96.6.9). */
  it("answers with the first-run step when the ledger holds no month", () => {
    renderRefusal(refusal("period_not_found", 404, []), "/financials?period=2020-01");

    expect(screen.getByText("No money recorded yet")).toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Connect a revenue source →" })).toHaveAttribute(
      "href",
      "/integrations",
    );
    expect(screen.queryByRole("combobox", { name: "Accounting period" })).toBeNull();
  });

  /** A read that failed for any other reason is still a broken ledger, and the
   * page must keep saying so rather than inventing a missing month. */
  it("still shows the ledger error for a failure that is not about the month", () => {
    renderRefusal(new Error("GET /api/financials failed: 500"), "/financials");

    expect(screen.getByText("The ledger did not answer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing recorded for/)).toBeNull();
  });

  /* A refresh that fails after the ledger answered once keeps the figures on
     screen (bead ro-ujb9.96.6.9) — the old hint promised exactly that in a
     sentence while the page blanked to the error. */
  it("keeps the last-good figures when a later refresh fails", () => {
    state.error = new Error("GET /api/financials failed: 500");
    const { container } = renderPage(payload());

    expect(container.querySelector("[data-kpi-strip]")).not.toBeNull();
    expect(screen.queryByText("The ledger did not answer")).toBeNull();
  });
});

// The other half of the same bead: the refusal has to REACH the page carrying
// the months. Losing `periods[]` in the fetch layer is what left the route with
// nothing but a generic failure to render.
describe("fetchFinancials — a refusal keeps the months", () => {
  const refusalResponse = (body: unknown, status: number) =>
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })));

  it("turns 404 period_not_found into an error carrying the periods", async () => {
    refusalResponse({ error: "period_not_found", periods: ["2026-07", "2026-08"] }, 404);

    const error = await fetchFinancials("2020-01").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(FinancialsPeriodError);
    expect((error as FinancialsPeriodError).periods).toEqual(["2026-07", "2026-08"]);
    expect((error as FinancialsPeriodError).status).toBe(404);
  });

  it("does the same for the 400 a malformed month gets", async () => {
    refusalResponse({ error: "period_malformed", periods: ["2026-08"] }, 400);

    const error = await fetchFinancials("last-quarter").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(FinancialsPeriodError);
    expect((error as FinancialsPeriodError).periods).toEqual(["2026-08"]);
  });

  it("leaves every other failure a plain error", async () => {
    refusalResponse({ error: "financials_assembly_failed" }, 500);

    const error = await fetchFinancials("2026-08").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(FinancialsPeriodError);
  });
});

describe("/financials — what the selector does not touch", () => {
  it("keeps the month-by-month table on the whole ledger", () => {
    renderPage(
      payload({
        period: "2026-08",
        months: [
          {
            period: "2026-07",
            booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
            estimated: { currency: 'USD', revenue: 200, cost: 0, net: 200 },
            total: { currency: 'USD', revenue: 200, cost: 0, net: 200 },
          },
          {
            period: "2026-08",
            booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
            estimated: { currency: 'USD', revenue: 440.94, cost: 200, net: 240.94 },
            total: { currency: 'USD', revenue: 440.94, cost: 200, net: 240.94 },
          },
        ],
      }),
    );

    // Both months, in calendar order — the trajectory is the one block that is
    // about the ledger rather than about the chosen period. It is behind the
    // month panel since doc 21: the chart above answers "is this getting better
    // or worse", and this table answers "what exactly did July book".
    const months = openPanel("months");
    expect(within(months).getByText("2026-07")).toBeInTheDocument();
    expect(within(months).getByText("2026-08")).toBeInTheDocument();
  });

  it("offers no selector when there is nothing to account for", () => {
    stubLane();
    renderPage(payload({ periods: [], months: [], empty: true }));

    expect(screen.getByText("No money recorded yet")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Accounting period" })).toBeNull();
  });

  /* THE FIRST RUN IS THE TWO STEPS (bead ro-ujb9.96.6.9). Revenue is connected
     on another page, so it is a link; costs are declared on this one, so the
     registers are open in place instead of a sentence saying to configure them. */
  it("offers the revenue link and opens the cost registers on a first run", () => {
    stubLane();
    const { container } = renderPage(
      withCosts({ periods: [], months: [], properties: [], costLines: [], empty: true }),
    );

    expect(screen.getByRole("link", { name: "Connect a revenue source →" })).toHaveAttribute(
      "href",
      "/integrations",
    );
    const costs = container.querySelector('[data-panel="costs"]')!;
    expect(costs).toHaveAttribute("data-panel-open");
    expect(costs.querySelector('[data-collection-editor="recurring-costs"]')).not.toBeNull();
    expect(container.querySelector("[data-kpi-strip]")).toBeNull();
    expect(container).not.toHaveTextContent("configure operating costs");
  });
});

// /financials after bead `ro-me00`, under doc 14's 2026-09-04 rule and doc 19
// finding 8. Every block now answers its question with a shape before a
// sentence: the trajectory as bars around a visible zero, each asset's slice of
// the month's revenue as a proportion, and where a cost figure came from as a
// glyph. Nothing here is decoration — each visual states something the figure
// beside it cannot.

describe("/financials — the first screen answers the whole question (doc 21)", () => {
  const threeMonths = () =>
    payload({
      months: [
        {
          period: "2026-06",
          booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
          estimated: { currency: 'USD', revenue: 0, cost: 224.42, net: -224.42 },
          total: { currency: 'USD', revenue: 0, cost: 224.42, net: -224.42 },
        },
        {
          period: "2026-07",
          booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
          estimated: { currency: 'USD', revenue: 40, cost: 190, net: -150 },
          total: { currency: 'USD', revenue: 40, cost: 190, net: -150 },
        },
        {
          period: "2026-08",
          booked: { currency: 'USD', revenue: 300, cost: 0, net: 300 },
          estimated: { currency: 'USD', revenue: 140.94, cost: 200, net: -59.06 },
          total: { currency: 'USD', revenue: 440.94, cost: 200, net: 240.94 },
        },
      ],
    });

  /** The audit measures the first screen against a block the page NAMES. A
   * surface that declares no hero cannot be certified at all
   * (`scripts/README.md`), so the mark is part of the contract, not styling. */
  it("declares the monthly summary and keeps accounting history in its disclosure", () => {
    const { container } = renderPage(threeMonths());

    const hero = container.querySelector("[data-surface-hero]")!;
    expect(hero).not.toBeNull();
    expect(hero.querySelector("[data-kpi-strip]")).not.toBeNull();
    expect(hero.querySelector("[data-hero-chart]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Month by month/ }));
    expect(container.querySelector('[data-panel="months"] [data-hero-chart]')).not.toBeNull();
  });

  /**
   * FOUR FIGURES, NOT FIVE. "Forecast" was the unreconciled half of the same
   * gross that "Reconciled" states — $681.63 unsettled is not a forecast of
   * anything, it is the grey half of Reconciled's own bar — so one KPI carried
   * the fact twice. What is left is the money, and the share as a shape.
   */
  it("states the selected month as four figures, net first with its composition", () => {
    const { container } = renderPage(threeMonths());

    const kpis = [...container.querySelectorAll("[data-kpi]")].map((kpi) =>
      kpi.getAttribute("data-kpi"),
    );
    expect(kpis).toEqual(["Net", "Revenue", "Cost", "Reconciled"]);

    // Doc 21: Net's movement carries no verdict, so it shows what it is MADE OF
    // instead of a percentage.
    const net = container.querySelector('[data-kpi="Net"]')!;
    expect(net.textContent).toContain("$240.94");
    expect(net.textContent).toContain("revenue $440.94 · cost $200.00");

    // Reconciled says how much of the month has been checked, names the other
    // half beside it — the way a bank shows available beside pending — and
    // draws the split, with no explanation tooltip behind it.
    const settled = container.querySelector('[data-kpi="Reconciled"]')!;
    expect(settled.textContent).toContain("$300.00");
    expect(settled.textContent).toContain("$340.94 estimated");
    expect(settled.querySelector("[data-composition]")).toHaveAttribute(
      "aria-label",
      "$300.00 reconciled, $340.94 estimated",
    );
    expect(settled.querySelector("[data-composition]")).not.toHaveAttribute("title");
    expect(within(settled as HTMLElement).queryByRole("button", { name: "About Reconciled" })).toBeNull();
  });

  /**
   * Doc 21 principle 2: a number without its shape is noise. Three of the four
   * have the ledger's own monthly series; Reconciled has the composition, which
   * is what its reader actually wants — how much of the month is checked.
   */
  it("gives every figure in the strip its own shape", () => {
    const { container } = renderPage(threeMonths());

    for (const kpi of container.querySelectorAll("[data-kpi]")) {
      const shape =
        kpi.querySelector("[data-spark]") ?? kpi.querySelector("[data-composition]");
      expect(shape, `${kpi.getAttribute("data-kpi")} draws nothing`).not.toBeNull();
    }
    // The three money trends are the ledger's own months, not a smoothed line.
    expect(container.querySelectorAll("[data-spark]")).toHaveLength(3);
  });

  /**
   * REVENUE AND COST, NOT NET (bead `ro-78qo.28`). `HeroChart`'s scale is
   * zero-based, so June at −$224.42 would be drawn below the plot floor. Two
   * lines that never go negative say the same thing truthfully — the distance
   * between them IS the net — and the Net figure keeps its own sparkline.
   */
  /**
   * NET IS A LINE NOW (bead `ro-78qo.28`). The chart used to draw revenue and
   * cost with a footnote saying the distance between them was the net, because
   * the scale was zero-based and a month at −$224 had nowhere to go. It takes a
   * signed domain since that bead, so the page's headline figure is something
   * the operator can point at — and the footnote goes, because a third toggle
   * says it without a sentence.
   */
  it("draws revenue, cost and net as three toggles and no explanatory footnote", () => {
    const { container } = renderPage(threeMonths());

    fireEvent.click(screen.getByRole("button", { name: /Month by month/ }));
    const chart = container.querySelector("[data-hero-chart]")!;
    expect(chart.textContent).toContain("Revenue");
    expect(chart.textContent).toContain("Cost");
    expect(chart.textContent).toContain("Net");
    expect(chart.textContent).not.toContain("the month's net");
  });

  it("gives each financial series one key with a distinct color and line pattern", () => {
    const { container } = renderPage(threeMonths());
    fireEvent.click(screen.getByRole("button", { name: /Month by month/ }));
    const chart = container.querySelector("[data-hero-chart]")! as HTMLElement;
    for (const [name, tone, pattern] of [
      ["Revenue", "text-financial-revenue", null],
      ["Cost", "text-financial-cost", "8 5"],
      ["Net", "text-foreground", "2 5"],
    ] as const) {
      expect(within(chart).getAllByText(name)).toHaveLength(1);
      const line = chart.querySelector(`[data-hero-line="${name}"]`)!;
      expect(line.parentElement).toHaveClass(tone);
      expect(line.getAttribute("stroke-dasharray")).toBe(pattern);
      const key = within(chart).getByRole("button", { name }).querySelector("line")!;
      expect(key.getAttribute("stroke-dasharray")).toBe(pattern);
    }
  });

  it("draws the strip's three money lines in the chart's own series ink (ro-ujb9.12)", () => {
    const { container } = renderPage(threeMonths());
    for (const [kpi, tone] of [
      ["Net", "text-foreground"],
      ["Revenue", "text-financial-revenue"],
      ["Cost", "text-financial-cost"],
    ] as const) {
      expect(container.querySelector(`[data-kpi="${kpi}"] [data-spark]`), kpi).toHaveClass(tone);
    }
  });

  it("preserves cents in chart point details and data while keeping the axis compact", async () => {
    const { container } = renderPage(threeMonths());
    fireEvent.click(screen.getByRole("button", { name: /Month by month/ }));
    const chart = container.querySelector("[data-hero-chart]")! as HTMLElement;
    const axisLabels = [...chart.querySelectorAll("[data-hero-gutter] > span")]
      .map((label) => label.textContent);
    expect(axisLabels).toEqual(["-$400", "-$200", "$0", "$200", "$400", "$600"]);

    fireEvent.focus(within(chart).getByRole("group", {
      name: "Explore Revenue and Cost and Net values",
    }));
    const details = within(chart).getByRole("status");
    for (const value of ["$440.94", "$200.00", "$240.94"]) {
      expect(within(details).getByText(value)).toBeInTheDocument();
    }
    expect(within(details).queryByText("$441")).toBeNull();

    fireEvent.click(within(chart).getByText("View data · 3 months"));
    const table = await within(chart).findByRole("table");
    const august = within(table).getByRole("rowheader", { name: "Aug '26" }).closest("tr")!;
    for (const value of ["$440.94", "$200.00", "$240.94"]) {
      expect(within(august).getByText(value)).toBeInTheDocument();
    }
    const june = within(table).getByRole("rowheader", { name: "Jun '26" }).closest("tr")!;
    expect(within(june).getByText("-$224.42")).toBeInTheDocument();
  });

  /** The month the store is standing in is not finished: the chart caps it with
   * a hollow point and the strip withholds the month-on-month deltas, because a
   * month four days in is always short. The state is said ONCE, as the header's
   * "Month to date" chip (bead ro-ujb9.96.6.9); where the delta would sit, the
   * last closed month's whole figure stands as the reference. */
  it("marks the open month provisional and withholds its deltas", () => {
    const { container } = renderPage(
      payload({
        period: "2026-09",
        periods: ["2026-08", "2026-09"],
        periodIsCurrent: true,
        months: [
          {
            period: "2026-08",
            booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
            estimated: { currency: 'USD', revenue: 440.94, cost: 200, net: 240.94 },
            total: { currency: 'USD', revenue: 440.94, cost: 200, net: 240.94 },
          },
          {
            period: "2026-09",
            booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
            estimated: { currency: 'USD', revenue: 12, cost: 6, net: 6 },
            total: { currency: 'USD', revenue: 12, cost: 6, net: 6 },
          },
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Month by month/ }));
    expect(container.querySelector("[data-hero-chart]")!).toHaveTextContent("Provisional");
    fireEvent.click(screen.getByRole("button", { name: "About Monthly performance" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Marked periods are provisional");
    expect(container.querySelector("[data-month-to-date]")).toHaveTextContent("Month to date");
    const revenue = container.querySelector('[data-kpi="Revenue"]')!;
    expect(revenue.textContent).toContain("Aug total $440.94");
    expect(revenue.textContent).not.toMatch(/%/);
    expect(container.querySelector('[data-kpi="Cost"]')!.textContent).toContain("Aug total $200.00");
    expect(container).not.toHaveTextContent("still open");
    // The month table marks the row, with the chart's hollow mark.
    expect(container.querySelector('[data-panel="months"] [data-month-open]')).toHaveTextContent("to date");
  });

  it("says nothing about an open month when the month shown is closed", () => {
    const { container } = renderPage(threeMonths());
    expect(container.querySelector("[data-month-to-date]")).toBeNull();
  });

  /** Everything read one cell at a time is a collapsed panel, and closed is the
   * whole point: the audit measures what a reader SEES, and so does the reader
   * (doc 21 principle 3). */
  it("keeps the month table, the cost breakdown and the registers closed", () => {
    const { container } = renderPage(threeMonths());

    const panels = [...container.querySelectorAll("[data-panel]")];
    expect(panels.map((panel) => panel.getAttribute("data-panel"))).toEqual([
      "months",
      "cost-breakdown",
      "costs",
    ]);
    // Closed means NOT RENDERED, not merely hidden: a closed `<details>` still
    // lays its contents out, which is how the first cut of this page measured
    // 3,795px at 1440 with a 1,350px column on screen.
    expect(panels.every((panel) => !panel.hasAttribute("data-panel-open"))).toBe(true);
    expect(container.querySelector("[data-collection-editor]")).toBeNull();
    expect(container.querySelector("table")).not.toBeNull(); // the by-asset one

    // The two registers ARE config files, which is exactly what the audit's
    // opt-out declares — the chip rule is about a view surface printing an
    // owner it cannot act on, not about an editor that writes the file.
    expect(
      container.querySelector('[data-panel="costs"]')!.hasAttribute("data-config-surface"),
    ).toBe(true);
  });

  /** Doc 21 principle 3a (bead ro-ujb9.96.6.9): no paragraph anywhere — no
   * About, no known-gaps panel, no explanation tooltip on the strip or the
   * by-asset table. Each fact is drawn on the figure it qualifies instead. */
  it("carries no About, no known-gaps panel and no explanation tooltips", () => {
    const { container } = renderPage(threeMonths());

    expect(container.querySelector("[data-about]")).toBeNull();
    expect(container.querySelector('[data-panel="gaps"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "How asset costs are allocated" })).toBeNull();
    expect(screen.queryByRole("button", { name: "About Reconciled" })).toBeNull();
  });

  it("says so plainly when the ledger holds no month at all", () => {
    const { container } = renderPage(payload({ months: [], periods: [] }));

    expect(container.querySelector("[data-hero-chart]")).toBeNull();
    expect(screen.getByText("No money recorded yet")).toBeInTheDocument();
  });
});

describe("/financials — each asset's slice of the month", () => {
  it("draws every asset's revenue share beside its figure", () => {
    const { container } = renderPage(payload());

    const bar = container.querySelector("[data-revenue-share]");
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("aria-label")).toBe(
      "Meal Planner earned 100% of the period's revenue",
    );
  });

  /** A share of nothing is not a small share. With no revenue at all, an empty
   * track on every row would be a proportion of a denominator that does not
   * exist. */
  it("draws no share bar when the period earned nothing", () => {
    const { container } = renderPage(
      payload({
        properties: [
          {
            asset: "meals.example",
            displayName: "Meal Planner",
            isOs: false,
            revenueReported: true,
            figure: { currency: 'USD', revenue: 0, cost: 3.05, net: -3.05 },
            months: [{ period: "2026-08", figure: { currency: 'USD', revenue: 0, cost: 3.05, net: -3.05 } }],
          },
        ],
        overhead: { currency: 'USD', revenue: 0, cost: 200, net: -200 },
      }),
    );

    expect(container.querySelectorAll("[data-revenue-share]")).toHaveLength(0);
  });

  /**
   * THE NAME IS THE CARD'S ONE WAY OUT (bead `ro-zmyq`). Below `sm` this table
   * is a stack of cards and this link is the only control on each of them,
   * drawn at 20px — not a button, a field, a palette row or a nav row, which is
   * how it survived `ro-md80`'s sweep and `ro-9smi`'s. jsdom has no layout, so
   * the SHAPE is asserted: the box grows and a negative margin of half the
   * growth gives the cell back the height it had, which is why the six cards
   * cost the page nothing.
   */
  it("gives each asset name a thumb-sized target the cards do not pay for", () => {
    const { container } = renderPage(payload());

    const link = container.querySelector(
      'a[href="/assets/meals.example/financials"]',
    ) as HTMLElement;
    expect(link).not.toBeNull();
    expect(link.className).toContain("max-sm:min-h-11");
    expect(link.className).toContain("max-sm:inline-flex");
    expect(link.className).toContain("max-sm:-my-3");
    // The desk owes nothing: a pointer hits 20px exactly.
    expect(link.className).not.toContain(" inline-flex");
  });

  /**
   * WHICH ASSET IS GETTING BETTER (bead `ro-78qo.29`, doc 21). The share bar
   * beside it answers which one is carrying THIS month, which on a portfolio
   * where one asset is nearly all the revenue is known before the page loads.
   */
  it("draws each asset's net month by month, muted and unsmoothed", () => {
    const { container } = renderPage(payload());

    const cell = container.querySelector("[data-property-trend='meals.example']");
    expect(cell).not.toBeNull();
    const spark = cell!.querySelector("svg")!;
    expect(spark.getAttribute("aria-label")).toBe(
      "Meal Planner net by month, 2026-06 to 2026-08",
    );
    // Net's movement carries no verdict — an asset with no revenue source
    // wired has not failed at anything — so the line is `text-muted-foreground`
    // and never the positive/negative scale.
    expect(cell!.querySelector(".text-muted-foreground")).not.toBeNull();
    // Three monthly points, drawn as they are. A trailing average over six
    // months would smooth away the only thing there is to see. The line is one
    // move and two curved segments, each ending ON a month's reading.
    expect(spark.querySelector("[data-chart-line]")!.getAttribute("d")!.match(/[MC]/g)).toHaveLength(3);
  });

  /**
   * The month the STORE is standing in is four days old and still being
   * counted, so the loudest ink on the line must not read as settled. August is
   * closed and gets a solid cap; September, once it has a row, gets a hollow
   * one.
   */
  it("caps a closed month's line solid and the open month's hollow", () => {
    const august = renderPage(payload());
    expect(
      august.container.querySelector("[data-property-trend] [data-chart-dot]")!.getAttribute("data-chart-dot"),
    ).toBe("solid");
    august.unmount();

    const open = renderPage(
      payload({
        period: "2026-09",
        periods: ["2026-06", "2026-07", "2026-08", "2026-09"],
        periodIsCurrent: true,
        months: [
          {
            period: "2026-09",
            booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
            estimated: { currency: 'USD', revenue: 60, cost: 200, net: -140 },
            total: { currency: 'USD', revenue: 60, cost: 200, net: -140 },
          },
        ],
        properties: [
          {
            asset: "meals.example",
            displayName: "Meal Planner",
            isOs: false,
            revenueReported: true,
            figure: { currency: 'USD', revenue: 60, cost: 3.05, net: 56.95 },
            months: [
              { period: "2026-07", figure: { currency: 'USD', revenue: 200, cost: 3.05, net: 196.95 } },
              { period: "2026-08", figure: { currency: 'USD', revenue: 440.94, cost: 3.05, net: 437.89 } },
              { period: "2026-09", figure: { currency: 'USD', revenue: 60, cost: 3.05, net: 56.95 } },
            ],
          },
        ],
      }),
      "/financials?period=2026-09",
    );

    expect(
      open.container.querySelector("[data-property-trend] [data-chart-dot]")!.getAttribute("data-chart-dot"),
    ).toBe("hollow");
  });

  /** Two points are a slope, not a trend. The cell says so rather than drawing
   * a line the ledger cannot support. */
  it("prints a dash, with its reason, for an asset with under three months", () => {
    const { container } = renderPage(
      payload({
        properties: [
          {
            asset: "nosh.example",
            displayName: "Nosh",
            isOs: false,
            revenueReported: true,
            figure: { currency: 'USD', revenue: 0, cost: 9.14, net: -9.14 },
            months: [{ period: "2026-08", figure: { currency: 'USD', revenue: 0, cost: 9.14, net: -9.14 } }],
          },
        ],
      }),
    );

    const cell = container.querySelector("[data-property-trend]");
    expect(cell).toBeNull();
    // The reason opens from a key or a tap, not a hover-only title (ro-ujb9.14).
    expect(screen.getByRole("button", { name: "No trend: Needs 3 months of history" })).toHaveTextContent("—");
  });

  /**
   * A SPARKLINE HAS NO AXIS (bead `ro-78qo.37`). It spaces its points by their
   * POSITION, so a series carrying only the months that booked something would
   * draw January, June and August as three consecutive months — a claim about
   * which months these are that the ledger never made. The payload carries the
   * asset's whole axis with a null in each hole, and the line breaks over them.
   */
  it("breaks the line over a month the asset booked nothing in", () => {
    const { container } = renderPage(
      payload({
        properties: [
          {
            asset: "meals.example",
            displayName: "Meal Planner",
            isOs: false,
            revenueReported: true,
            figure: { currency: 'USD', revenue: 440.94, cost: 3.05, net: 437.89 },
            months: [
              { period: "2026-05", figure: { currency: 'USD', revenue: 10, cost: 0, net: 10 } },
              { period: "2026-06", figure: { currency: 'USD', revenue: 100, cost: 0, net: 100 } },
              { period: "2026-07", figure: null },
              { period: "2026-08", figure: { currency: 'USD', revenue: 440.94, cost: 3.05, net: 437.89 } },
            ],
          },
        ],
      }),
    );

    const path = container
      .querySelector("[data-property-trend] svg [data-chart-line]")!
      .getAttribute("d")!;
    // TWO RUNS, NOT ONE. A second `M` is the break: May–June is drawn, July is
    // not, and August starts a new stroke rather than continuing a line across
    // a month nothing was recorded in.
    expect(path.match(/M/g)).toHaveLength(2);
    // Four positions on the axis, three of them readings.
    expect(
      container.querySelector("[data-property-trend] svg")!.getAttribute("aria-label"),
    ).toBe("Meal Planner net by month, 2026-05 to 2026-08");
  });

  /**
   * THE FLOOR COUNTS READINGS, NOT POSITIONS. An axis of ten months holding two
   * figures is still two figures, and the three-point floor is about what the
   * ledger recorded rather than how far apart it recorded it.
   */
  it("still dashes when the axis is long but holds under three readings", () => {
    const { container } = renderPage(
      payload({
        properties: [
          {
            asset: "meals.example",
            displayName: "Meal Planner",
            isOs: false,
            revenueReported: true,
            figure: { currency: 'USD', revenue: 440.94, cost: 3.05, net: 437.89 },
            months: [
              { period: "2026-05", figure: { currency: 'USD', revenue: 10, cost: 0, net: 10 } },
              { period: "2026-06", figure: null },
              { period: "2026-07", figure: null },
              { period: "2026-08", figure: { currency: 'USD', revenue: 440.94, cost: 3.05, net: 437.89 } },
            ],
          },
        ],
      }),
    );

    expect(container.querySelector("[data-property-trend]")).toBeNull();
    // The reason opens from a key or a tap, not a hover-only title (ro-ujb9.14).
    expect(screen.getByRole("button", { name: "No trend: Needs 3 months of history" })).toHaveTextContent("—");
  });

  /**
   * The figures in this row are August's. A line running into September under
   * them would be two periods drawn as one unit — the same rule the strip's own
   * sparklines are held to.
   */
  it("stops the line at the month the row's figures describe", () => {
    const { container } = renderPage(
      payload({
        period: "2026-07",
        months: [
          {
            period: "2026-07",
            booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
            estimated: { currency: 'USD', revenue: 200, cost: 200, net: 0 },
            total: { currency: 'USD', revenue: 200, cost: 200, net: 0 },
          },
        ],
        properties: [
          {
            asset: "meals.example",
            displayName: "Meal Planner",
            isOs: false,
            revenueReported: true,
            figure: { currency: 'USD', revenue: 200, cost: 3.05, net: 196.95 },
            months: [
              { period: "2026-05", figure: { currency: 'USD', revenue: 50, cost: 0, net: 50 } },
              { period: "2026-06", figure: { currency: 'USD', revenue: 100, cost: 3.05, net: 96.95 } },
              { period: "2026-07", figure: { currency: 'USD', revenue: 200, cost: 3.05, net: 196.95 } },
              { period: "2026-08", figure: { currency: 'USD', revenue: 440.94, cost: 3.05, net: 437.89 } },
            ],
          },
        ],
      }),
      "/financials?period=2026-07",
    );

    expect(
      container.querySelector("[data-property-trend] svg")!.getAttribute("aria-label"),
    ).toBe("Meal Planner net by month, 2026-05 to 2026-07");
  });
});

describe("/financials — where a cost figure came from", () => {
  /* The chip is the operator's own word for the kind, so it needs no glossary
     tooltip; the source is the name he gave the subscription, not the key the
     row is filed under (bead ro-ujb9.96.6.9). */
  it("names each cost's kind and source in plain words, with nothing behind them", () => {
    stubLane();
    const { container } = renderPage(
      withCosts({
        costLines: [
          { currency: 'USD', family: "inference", provenance: "stated", source: "recurring:claude-code", amount: 200, rows: 1 },
          { currency: 'USD', family: "api", provenance: "metered", source: "metered:dataforseo", amount: 7.83, rows: 2 },
          { currency: 'USD', family: "infra", provenance: "amortized", source: "domains", amount: 12.7, rows: 5 },
          { currency: 'USD', family: "operator", provenance: "unclassified", source: null, amount: 2, rows: 1 },
        ],
      }),
    );
    const panel = openPanel("cost-breakdown");

    const types = [...panel.querySelectorAll('td[data-label="Type"]')].map((cell) => cell.textContent);
    expect(types).toEqual(["Subscription", "Usage", "Prepaid yearly", "No source"]);
    const sources = [...panel.querySelectorAll("td[data-cost-source]")].map((cell) => cell.textContent);
    expect(sources).toEqual(["Claude Code (Max)", "DataForSEO×2", "Domain orders×5", "—"]);
    expect(within(panel).queryAllByRole("button")).toHaveLength(1); // the panel's own toggle
    expect(container).not.toHaveTextContent("recurring:claude-code");
  });
});

// ---------------------------------------------------------------------------
// /financials EDITS ITS OWN INPUTS (bead `ro-x5gu.2`).
//
// Every cost figure on this page is built from two config files, and until this
// landed the only way to correct one was a text editor: the page showed the
// consequence and hid the cause. The Costs section is those two registers,
// editable through the same write lane a knob uses — one changeset per action,
// each carrying its exact inverse, and a row the schema refuses never becoming
// a request at all.
//
// The lane is STUBBED: no file is written, and what is asserted is the shape of
// what the page asked for.
// ---------------------------------------------------------------------------

const RECURRING: RecurringCost[] = [
  {
    id: "claude-code",
    label: "Claude Code (Max)",
    asset: "root-os",
    family: "inference",
    amountUsdPerMonth: 200,
    from: "2026-06",
    note: "Portfolio overhead.",
  },
  // Closed before the shown month, so the run-rate strip can be proved to read
  // each row's term rather than merely counting rows.
  {
    id: "old-plan",
    label: "Retired plan",
    asset: "meals.example",
    family: "infra",
    amountUsdPerMonth: 99,
    from: "2026-01",
    to: "2026-05",
  },
];

const ORDERS: DomainOrder[] = [
  {
    domain: "meals.example",
    asset: "meals.example",
    kind: "registration",
    paidUsd: 4.63,
    paidOn: "2026-03-18",
  },
];

const SCHEDULE: DomainSchedule[] = [
  {
    domain: "meals.example",
    asset: "meals.example",
    paidUsd: 4.63,
    paidOn: "2026-03-18",
    perMonth: 0.39,
    firstPeriod: "2026-03",
    lastPeriod: "2027-02",
  },
];

const withCosts = (overrides: Partial<FinancialsPayload> = {}) =>
  payload({
    recurringCosts: RECURRING,
    domainOrders: ORDERS,
    domains: SCHEDULE,
    ...overrides,
  });

/** One register's table. Both are on screen, and a column label ("Asset")
 * belongs to both — so nothing below is looked up on the page as a whole. */
/**
 * Open one of the page's collapsed panels (doc 21, bead `ro-78qo.16`).
 *
 * A panel MOUNTS ITS BODY ONLY WHEN OPEN — the whole reason the rebuilt page
 * measures 1,350px rather than 3,795 — so a case about a register, the month
 * table or the cost breakdown has to press the header first, exactly as an
 * operator does. Idempotent, so a helper can call it without knowing whether a
 * case already has.
 */
function openPanel(mark: string): HTMLElement {
  const panel = document.querySelector(`[data-panel="${mark}"]`);
  if (!(panel instanceof HTMLElement)) throw new Error(`no panel ${mark}`);
  if (!panel.hasAttribute("data-panel-open")) {
    fireEvent.click(panel.querySelector("button")!);
  }
  return panel;
}

function editor(register: string): HTMLElement {
  openPanel("costs");
  const found = document.querySelector(`[data-collection-editor="${register}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no editor for ${register}`);
  return found;
}

/** The open Add form inside one register's table. */
function addForm(register: string): HTMLElement {
  const found = editor(register).querySelector("[data-collection-add]");
  if (!(found instanceof HTMLElement)) throw new Error(`no add form in ${register}`);
  return found;
}

/** Open the Add form and fill in the fields a case names, nothing else. */
function startAdd(register: string, values: Record<string, string>): HTMLElement {
  fireEvent.click(within(editor(register)).getByRole("button", { name: "Add" }));
  const form = addForm(register);
  for (const [label, value] of Object.entries(values)) {
    fireEvent.change(within(form).getByLabelText(label), { target: { value } });
  }
  return form;
}

/** A valid new subscription, so a refusal case can spoil exactly one field. */
const NEW_COST = {
  Id: "chatgpt",
  Label: "ChatGPT Team",
  Site: "root-os",
  Family: "inference",
  "USD / month": "60",
  From: "2026-09",
};

/** One editable cell and the Save beside it. */
function cell(register: string, column: string, rowKey: string) {
  const found = editor(register).querySelector(`[data-collection-row="${rowKey}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no row ${rowKey}`);
  const control = within(found).getByLabelText(column);
  const save = within(control.parentElement as HTMLElement).getByRole("button", {
    name: "Save",
  });
  return { control, save };
}

/** The one op a change made. Every action here is a single-op changeset. */
function onlyOp(calls: LaneCall[], index = 0): Record<string, unknown> {
  const ops = calls[index]?.body?.ops ?? [];
  expect(ops).toHaveLength(1);
  return ops[0] as Record<string, unknown>;
}

describe("/financials — the Costs section writes the files it reads", () => {
  // An `asset-id` field checked its SHAPE and nothing else (bead `ro-x5gu.10`),
  // so "meals.fod" booked a recurring cost against an asset no row in the
  // store has: the money left the by-asset split while the total went on
  // including it. The candidate list is the integration matrix's — the whole
  // roster, not this period's ledger split, so an asset that has booked nothing
  // yet is still offerable.
  it("refuses an asset id the OS does not have, and offers the ones it does", async () => {
    const calls = stubLane(undefined, undefined, [
      "root-os",
      "meals.example",
      "nosh.example",
    ]);
    renderPage(withCosts());

    const list = await waitFor(() => {
      const found = editor("recurring-costs").querySelector("datalist");
      if (found === null) throw new Error("no picker yet");
      return found;
    });
    expect([...list.querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual([
      "root-os",
      "meals.example",
      "nosh.example",
    ]);

    const form = startAdd("recurring-costs", { ...NEW_COST, Site: "meals.fod" });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    expect(await within(form).findByRole("alert")).toHaveTextContent(
      'asset "meals.fod" is not one of root-os, meals.example, nosh.example',
    );
    expect(calls).toHaveLength(0);
  });

  it("adds a subscription as one append, and the Undo deletes exactly it", async () => {
    const calls = stubLane();
    renderPage(withCosts());

    const form = startAdd("recurring-costs", NEW_COST);
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    const row = {
      id: "chatgpt",
      label: "ChatGPT Team",
      asset: "root-os",
      family: "inference",
      amountUsdPerMonth: 60,
      from: "2026-09",
    };
    // The two optional fields left blank are DROPPED rather than written as
    // empty strings — an omitted `to` means "still live", and `""` is a month
    // nobody can parse.
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-insert",
      file: "config/recurring-costs.json",
      pointer: "/costs/-",
      value: row,
    });

    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    toasts.success.mock.calls[0]?.[1]?.action.onClick();
    await waitFor(() => expect(calls).toHaveLength(2));
    // Guarded by the row itself, so an Undo pressed after somebody else moved
    // that index is refused rather than deleting their work instead.
    expect(onlyOp(calls, 1)).toEqual({
      kind: "file-json-delete",
      file: "config/recurring-costs.json",
      pointer: "/costs/2",
      expect: row,
    });
  });

  // A PRICE CHANGE IS A NEW ROW, NOT AN EDIT (bead `ro-ujb9.96.6.17`). Every
  // month already booked was booked at the amount, so the cell is the value
  // under a lock — Stripe's rule for a price — and the change is the row's To,
  // a control on the same row, guarded by what it was rendered from.
  it("fixes a subscription's amount once added and closes the row with its To", async () => {
    const calls = stubLane();
    renderPage(withCosts());

    const row = editor("recurring-costs").querySelector(
      "[data-collection-row='claude-code']",
    ) as HTMLElement;
    const amount = row.querySelector("[data-collection-fixed='amountUsdPerMonth']");
    expect(amount?.textContent).toContain("200");
    expect(amount?.getAttribute("title")).toBe("Fixed once added");
    expect(within(row).queryByLabelText("USD / month")).toBeNull();

    const { control, save } = cell("recurring-costs", "To", "claude-code");
    fireEvent.change(control, { target: { value: "2026-09" } });
    fireEvent.click(save);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onlyOp(calls)).toMatchObject({
      kind: "file-json-set",
      file: "config/recurring-costs.json",
      pointer: "/costs/0/to",
      value: "2026-09",
    });
  });

  // WHAT THE ROW COSTS A MONTH IS ARITHMETIC, NOT A FIELD (bead `ro-x5gu.11`).
  // A domain order is a prepaid annual term, so the figure the ledger actually
  // books is the price over twelve — which the read-only schedule table this
  // section replaced printed per row, and the editable one could not. It is a
  // computed column now: beside the editable ones, carrying no control.
  it("prints each order's amortized month beside the fields, with nothing to edit", () => {
    stubLane();
    renderPage(withCosts());

    const table = editor("domain-costs");
    expect(within(table).getByRole("columnheader", { name: "Per month" })).toBeTruthy();
    const cell = table.querySelector("[data-collection-derived='amortized']") as HTMLElement;
    expect(cell.textContent).toContain("$0.39");
    expect(cell.textContent).toContain("2026-03 → 2027-02");
    expect(cell.querySelector("input")).toBeNull();
    expect(cell.querySelector("button")).toBeNull();
  });

  it("removes a domain order behind a confirm, and the Undo puts the row back", async () => {
    const calls = stubLane();
    renderPage(withCosts());

    const table = editor("domain-costs");
    fireEvent.click(within(table).getByRole("button", { name: "Remove meals.example…" }));
    fireEvent.click(within(table).getByRole("button", { name: "Remove meals.example" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onlyOp(calls)).toEqual({
      kind: "file-json-delete",
      file: "config/domain-costs.json",
      pointer: "/domains/0",
      expect: ORDERS[0],
    });

    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    toasts.success.mock.calls[0]?.[1]?.action.onClick();
    await waitFor(() => expect(calls).toHaveLength(2));
    // The row comes back WHERE IT WAS (bead `ro-asj9`). This table is drawn in
    // FILE ORDER, so an appended undo would silently reorder the list around a
    // row nothing had changed.
    expect(onlyOp(calls, 1)).toEqual({
      kind: "file-json-insert",
      file: "config/domain-costs.json",
      pointer: "/domains/0",
      value: ORDERS[0],
    });
  });

  /**
   * The month totals above and the months behind the period picker are both
   * built from these files, so a save that left the ledger read on screen would
   * show figures the page no longer agrees with. The write lane throws that
   * read away once the dev server has restarted around the changed file.
   */
  it("throws the ledger read away after a save, so the month recomputes", async () => {
    const calls = stubLane();
    renderPage(withCosts());
    const invalidated = vi.spyOn(client, "invalidateQueries");

    const { control, save } = cell("recurring-costs", "To", "claude-code");
    fireEvent.change(control, { target: { value: "2026-09" } });
    fireEvent.click(save);

    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(
      () => expect(invalidated).toHaveBeenCalledWith({ queryKey: ["financials"] }),
      { timeout: 4000 },
    );
  });
});

describe("/financials — a row the schema refuses never becomes a request", () => {
  /** Each case spoils exactly ONE field of an otherwise valid row, so the
   * sentence it gets back can only be about that field. */
  const refuses = async (
    register: string,
    values: Record<string, string>,
    sentence: string,
  ) => {
    const calls = stubLane();
    renderPage(withCosts());

    const form = startAdd(register, values);
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));

    expect(await within(form).findByRole("alert")).toHaveTextContent(sentence);
    expect(calls).toHaveLength(0);
  };

  it("refuses a month that is not one, naming the field", async () => {
    await refuses(
      "recurring-costs",
      { ...NEW_COST, From: "2026-13" },
      "From must be a month, YYYY-MM",
    );
  });

  it("refuses a negative amount, naming the field and its floor", async () => {
    await refuses(
      "recurring-costs",
      { ...NEW_COST, "USD / month": "-5" },
      "USD / month must be at least 0",
    );
  });

  it("refuses something that is not an asset id", async () => {
    await refuses(
      "recurring-costs",
      { ...NEW_COST, Site: "My Plate" },
      "Site must be a site id",
    );
  });

  /**
   * Uniqueness is the one rule a JSON pointer cannot express, so it is checked
   * in the browser against the rows the payload already carries: a duplicate
   * `id` is part of the ledger's idempotency key and would re-book every month.
   */
  it("refuses an id already in the list, before anything is sent", async () => {
    await refuses(
      "recurring-costs",
      { ...NEW_COST, Id: "claude-code" },
      'Id "claude-code" is already in this list',
    );
  });

  it("refuses a bad month in a cell too, under the input it was typed in", async () => {
    const calls = stubLane();
    renderPage(withCosts());

    const { control, save } = cell("recurring-costs", "From", "claude-code");
    fireEvent.change(control, { target: { value: "2026-13" } });
    fireEvent.click(save);

    expect(await screen.findByText("From must be a month, YYYY-MM")).toBeInTheDocument();
    expect(control).toHaveAttribute("aria-invalid", "true");
    expect(calls).toHaveLength(0);
  });
});

describe("/financials — the Costs section on a deployment that cannot write", () => {
  it("shows both tables with every control gone, and says why once", async () => {
    stubLane({
      writable: false,
      reason: "This build has no filesystem, so file-owned settings are read-only.",
    });
    renderPage(withCosts());
    openPanel("costs");

    await waitFor(() =>
      expect(document.querySelector("[data-saves-paused]")).toHaveTextContent(
        "This build has no filesystem, so file-owned settings are read-only.",
      ),
    );
    // ONE copy for the whole screen (bead ro-p8qq): the sentence is a fact
    // about the BUILD, not about a table, so the page says it once above the
    // tables and each table shows only its lock.
    const paused =
      document.querySelectorAll("[data-saves-paused]").length +
      document.querySelectorAll("[data-collection-read-only]").length +
      document.querySelectorAll("[data-knob-read-only]").length;
    expect(paused).toBe(1);
    expect(document.querySelector("[data-saves-paused]")).toHaveTextContent("Saves paused");
    expect(document.querySelectorAll("[data-collection-locked]")).toHaveLength(2);

    // The rows stay readable — a deployment that cannot write is not one that
    // cannot show what the files hold.
    expect(
      within(editor("recurring-costs")).getByText("Claude Code (Max)"),
    ).toBeInTheDocument();
    // No Save that could not work, and no way to open an Add form.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });
});

describe("/financials — what the two files declare, by asset", () => {
  it("groups the declared monthly cost by asset, each behind its own favicon", () => {
    stubLane();
    const { container } = renderPage(withCosts());
    openPanel("costs");

    const lines = [...container.querySelectorAll("[data-declared-asset]")];
    // Biggest first, and only what is live in the shown month: the retired plan
    // closed in May, so meals.example's line is its amortizing domain alone.
    expect(lines.map((line) => line.getAttribute("data-declared-asset"))).toEqual([
      "root-os",
      "meals.example",
    ]);
    expect(lines[0]).toHaveTextContent("$200.00");
    expect(lines[1]).toHaveTextContent("$0.39");
    // Identity is the glyph here as everywhere else in this Tower.
    expect(
      lines.map((line) =>
        line.querySelector("[data-property-favicon]")?.getAttribute("data-property-favicon"),
      ),
    ).toEqual(["root-os", "meals.example"]);
    // The share is the shape beside the figure, and it says what it means.
    expect(
      lines[1]?.querySelector("[data-segment-bar]")?.getAttribute("aria-label"),
    ).toBe("Meal Planner is 0.2% of the declared monthly cost");
  });

  /** The cash already spent, and how much of the list is still being spread
   * across the shown month — two facts no row states, and the reason the
   * read-only schedule table this section replaced is not missed. */
  it("states the orders' total and how many still amortize into this month", () => {
    stubLane();
    const { container } = renderPage(withCosts());
    openPanel("costs");

    const terms = container.querySelector("[data-domain-terms]")?.textContent;
    expect(terms).toBe("1 order · $4.63 paid · 1 amortizing this month");
    // The amortization RULE is no sentence here (bead `ro-ujb9.96.6.17`): the
    // Per month column shows each order's share and its first → last month.
    expect(terms).not.toContain("12 months");
  });

  /** A share of nothing is not a small share: with nothing declared for the
   * month there is no denominator, so the strip is absent rather than empty. */
  it("draws no run-rate strip when the two files declare nothing for the month", () => {
    stubLane();
    const { container } = renderPage(
      withCosts({ recurringCosts: [], domainOrders: [], domains: [] }),
    );

    expect(container.querySelector("[data-declared-run-rate]")).toBeNull();
    // Both tables are still there, each saying what an empty register means.
    expect(editor("recurring-costs")).toBeInTheDocument();
    expect(editor("domain-costs")).toBeInTheDocument();
  });
});

// What the page does not know is drawn where it applies (bead ro-ujb9.96.6.9):
// the three paragraphs under "What this page does not know" became a dash in
// the row, the Reconciled bar, and a chip on the domain order.
describe("/financials — what the page does not know, on the figure it qualifies", () => {
  it("prints a dash, not $0.00, for an asset nothing reported revenue for", () => {
    const { container } = renderPage(
      payload({
        properties: [
          {
            asset: "meals.example",
            displayName: "Meal Planner",
            isOs: false,
            revenueReported: true,
            figure: { currency: 'USD', revenue: 440.94, cost: 3.05, net: 437.89 },
            months: [{ period: "2026-08", figure: { currency: 'USD', revenue: 440.94, cost: 3.05, net: 437.89 } }],
          },
          {
            asset: "areas.example",
            displayName: "areas.example",
            isOs: false,
            revenueReported: false,
            figure: { currency: 'USD', revenue: 0, cost: 0.92, net: -0.92 },
            months: [{ period: "2026-08", figure: { currency: 'USD', revenue: 0, cost: 0.92, net: -0.92 } }],
          },
        ],
      }),
    );

    const dash = container.querySelector('[data-revenue-unreported="areas.example"]')!;
    expect(dash).toHaveTextContent("—");
    expect(dash.querySelector("[title]")).toBeNull();
    fireEvent.focus(within(dash as HTMLElement).getByRole("button", { name: /no revenue reported$/ }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("No revenue reported");
    // No share bar for a row with no revenue row: a share of nothing reported
    // is not a small share.
    expect(container.querySelector('[data-revenue-share="areas.example"]')).toBeNull();
    expect(container.querySelector('[data-revenue-unreported="meals.example"]')).toBeNull();
  });

  it("marks a domain term that runs out this month or next with its renewal month", () => {
    stubLane();
    const { container } = renderPage(
      withCosts({
        domainOrders: [
          ...ORDERS,
          { domain: "nosh.example", asset: "nosh.example", kind: "registration", paidUsd: 109.69, paidOn: "2025-10-09" },
        ],
        domains: [
          ...SCHEDULE,
          {
            domain: "nosh.example",
            asset: "nosh.example",
            paidUsd: 109.69,
            paidOn: "2025-10-09",
            perMonth: 9.14,
            firstPeriod: "2025-10",
            lastPeriod: "2026-09",
          },
        ],
      }),
    );
    openPanel("costs");

    // currentPeriod is 2026-09: nosh.example's term ends this month, meals.example's
    // runs to 2027-02 and says nothing.
    expect(container.querySelector('[data-domain-renews="nosh.example"]')).toHaveTextContent(
      "Renews Oct 2026",
    );
    expect(container.querySelector('[data-domain-renews="meals.example"]')).toBeNull();
  });
});

/**
 * Bead ro-ujb9.129: with one site and $82 of revenue the page stated $82.00
 * five times — Net, the daily chart, the by-site row, "Sites, direct" and the
 * total — under "Overhead · allocated to none $0.00". A table whose every row
 * equals its total reads as a broken report, and one site has nothing to
 * allocate.
 */
describe("/financials — one site states its money once (ro-ujb9.129)", () => {
  const site = (asset: string, displayName: string, revenue: number) => ({
    asset, displayName, isOs: false, revenueReported: true,
    figure: { currency: 'USD', revenue, cost: 0, net: revenue },
    months: [{ period: "2026-08", figure: { currency: 'USD', revenue, cost: 0, net: revenue } }],
  });
  const none = { currency: 'USD', revenue: 0, cost: 0, net: 0 };
  const daily = {
    from: "2026-08-01", to: "2026-08-31", reportedThrough: "2026-08-31",
    days: [{ date: "2026-08-31", amountMinor: 8200 }],
    sources: [{ asset: "journey.example", displayName: "Journey Example", since: "2026-08-01" }],
    coverage: [{ date: "2026-08-31", reported: 1, missingAssets: [] }],
  };
  const month = (revenue: number) => [{ period: "2026-08", booked: none,
    estimated: { currency: 'USD', revenue, cost: 0, net: revenue }, total: { currency: 'USD', revenue, cost: 0, net: revenue } }];
  /** Each body row's first cell, the row's name. */
  const rowNames = (container: HTMLElement) =>
    [...container.querySelectorAll("tbody tr")].map((row) => row.querySelector("td")?.firstChild?.textContent?.trim() ?? "");

  it("draws no by-site table and no overhead rows when nothing is shared", () => {
    wall.sites = 1;
    const { container } = renderPage(payload({
      months: month(82), properties: [site("journey.example", "Journey Example", 82)],
      overhead: none, costLines: [], dailyRevenue: daily,
    }));
    expect(screen.queryByRole("heading", { name: "By site" })).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).not.toMatch(/Sites, direct|Overhead|Total net|allocated/);
    // The headings name revenue, never the portfolio's, and no per-site
    // coverage line restates the figure's own "1 of 31 days reported".
    const revenue = screen.getByRole("region", { name: "Daily revenue" });
    expect(revenue.querySelector("[data-source-coverage]")).toBeNull();
    expect(container.textContent).not.toMatch(/portfolio/i);
    // The month's money is the strip's, stated there.
    expect(container.querySelector('[data-kpi="Revenue"]')).toHaveTextContent("$82.00");
  });

  it("keeps the site's row, the overhead and the total when a cost is shared, with no subtotal repeating the row", () => {
    wall.sites = 1;
    const { container } = renderPage(payload({
      months: month(82), properties: [site("journey.example", "Journey Example", 82)],
      overhead: { currency: 'USD', revenue: 0, cost: 20, net: -20 }, dailyRevenue: daily,
    }));
    expect(screen.getByRole("heading", { name: "By site" })).toBeInTheDocument();
    const names = rowNames(container);
    expect(names[0]).toContain("Journey Example");
    expect(names.slice(1)).toEqual(["Overhead", "Total net"]);
    expect(container.textContent).not.toContain("Sites, direct");
  });

  it("keeps the whole split with two sites even when only one earned this month", () => {
    wall.sites = 2;
    const { container } = renderPage(payload({
      months: month(82), properties: [site("journey.example", "Journey Example", 82)],
      overhead: none, costLines: [], dailyRevenue: daily,
    }));
    expect(screen.getByRole("heading", { name: "By site" })).toBeInTheDocument();
    expect(rowNames(container).slice(1)).toEqual(["Sites, direct", "Overhead", "Total net"]);
    expect(container.querySelector("[data-source-coverage]")).not.toBeNull();
  });

  it("keeps the whole split, subtotal included, from two sites", () => {
    wall.sites = 2;
    const { container } = renderPage(payload({
      properties: [site("journey.example", "Journey Example", 60), site("second.example", "Second Example", 22)],
      overhead: none,
    }));
    expect(screen.getByRole("heading", { name: "By site" })).toBeInTheDocument();
    const names = rowNames(container);
    expect(names[0]).toContain("Journey Example");
    expect(names[1]).toContain("Second Example");
    expect(names.slice(2)).toEqual(["Sites, direct", "Overhead", "Total net"]);
  });
});


describe('/financials — stated currency and unavailable mixed totals', () => {
  const figure = (revenue: number, cost: number, currency = 'EUR') => ({ currency, revenue, cost, net: revenue - cost });
  it('labels a pure EUR month and each cost line without USD formatting', () => {
    const base = payload();
    const data = payload({
      months: [{ period: '2026-08', booked: figure(440.94, 200), estimated: figure(0, 0), total: figure(440.94, 200) }],
      properties: base.properties.map(property => ({ ...property, figure: figure(440.94, 3.05),
        months: property.months.map(month => ({ ...month, figure: figure(100, 3.05) })) })),
      overhead: figure(0, 200), costLines: base.costLines.map(line => ({ ...line, currency: 'EUR' })),
    });
    const { container } = renderPage(data);
    expect(container.querySelector('[data-kpi="Net"]')).toHaveTextContent('+€240.94');
    expect(container.querySelector('[data-kpi="Revenue"]')).toHaveTextContent('€440.94');
    expect(container.querySelector('[data-kpi="Cost"]')).toHaveTextContent('€200.00');
    expect(container.querySelector('[data-kpi="Net"]')).not.toHaveTextContent('$');
    fireEvent.click(screen.getByRole('button', { name: /Where the cost comes from/ }));
    expect(screen.getAllByText('€200.00').length).toBeGreaterThan(0);
  });
  it('keeps individual asset currencies readable when the portfolio total is unavailable', () => {
    const base = payload();
    const unknown = { currency: null, revenue: null, cost: null, net: null };
    const data = payload({ months: [{ period: '2026-08', booked: unknown, estimated: unknown, total: unknown }],
      properties: [
        { ...base.properties[0]!, figure: figure(100, 0), months: [] },
        { ...base.properties[0]!, asset: 'nosh.example', displayName: 'Nosh', figure: figure(200, 0, 'USD'), months: [] },
      ], overhead: figure(0, 0, 'USD'), costLines: [],
    });
    const { container } = renderPage(data);
    expect(container.querySelector('[data-kpi="Net"]')).toHaveTextContent('Unavailable');
    expect(container.querySelector('[data-kpi="Net"]')).not.toHaveTextContent('$0');
    expect(screen.getAllByText('€100.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$200.00').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-segment="reconciled"]')).toBeNull();
  });
});
