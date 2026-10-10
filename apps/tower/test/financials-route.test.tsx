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

// The month is a URL, the page opens on the latest one holding rows, and the
// header says so when that is not this month.

const state = vi.hoisted(() => ({
  data: undefined as FinancialsPayload | undefined,
  /** What the read failed with, when it failed. */
  error: null as unknown,
  /** Every period the route asked the hook for, in order. */
  asked: [] as (string | null | undefined)[],
}));

// Sonner is mocked rather than mounted: the Undo is a callback, and calling it
// directly is what proves the second write's shape.
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
// case says, which leaves the page to count the month's rows.
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

/** The page as it renders when the read was refused: no payload, an error
 * carrying the months that do exist. */
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

/* A signed estimated adjustment is still unchecked money, counted by its size
   in Reconciled's "estimated" half. A signed sum would hide it: 100 booked +
   (−10) estimated reads as a fully reconciled 90. */
it('counts signed estimated adjustments as unconfirmed money, never on the net', () => {
  const { container } = renderPage(payload({ months: [{ period: '2026-08',
    booked: { currency: 'USD', revenue: 100, cost: 0, net: 100 },
    estimated: { currency: 'USD', revenue: -10, cost: 0, net: -10 },
    total: { currency: 'USD', revenue: 90, cost: 0, net: 90 },
  }] }));
  expect(container.querySelector('[data-money-confirmed] dd')).toHaveTextContent('$100');
  expect(container.querySelector('[data-money-answer] h2')).not.toHaveTextContent('estimate');
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
  expect(daily.querySelector('[data-legend-partial]')).toHaveTextContent('1 partial day');
  expect(daily.querySelector('[data-hero-bar][data-partial]')).not.toBeNull();
  expect(daily).not.toHaveTextContent('partial reports');
  expect(daily.querySelector('[data-hero-bar]')).toHaveAttribute('data-value', '12.34');
  expect(daily).not.toHaveTextContent('$200.00');
  const nom = daily.querySelector('[data-source-coverage-asset="nosh.example"]')!;
  expect(nom).toHaveTextContent(/Nosh\s*0\/1 days/);
  expect(nom.querySelector('.text-warn')).toHaveTextContent('0/1 days');
  expect(daily.querySelector('[data-source-coverage-asset="meals.example"] .text-warn')).toBeNull();
  expect(within(daily).getByRole('link', { name: /Nosh/ })).toHaveAttribute('href', '/assets/nosh.example/financials');
  expect(daily).not.toHaveTextContent('Only saved Mediavine estimates');
  expect(container.querySelector('[data-panel="months"] [data-hero-chart]')).toBeNull();
});

/* A source's count runs from its first report, so a site that joined
   mid-window is measured on the days it owed, not on the whole month. */
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

/** The config write lane, stubbed. A GET is the deployment's writability
 * answer; anything else is a changeset, recorded so a case can assert the
 * exact ops it sent. */
interface LaneCall {
  method: string;
  body: { ops: unknown[]; slug?: string } | null;
}

function stubLane(
  writable: { writable: boolean; reason: string | null } = { writable: true, reason: null },
  reply: { status: number; body: unknown } = { status: 200, body: { applied: 1, archive: null, commit: null } },
  /** The assets the integration matrix answers with, the picker behind the
   * Asset column. Undefined leaves that read unanswered. */
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

  // A month has to be a link: "open financials, then change the dropdown to
  // June" is not something you can send.
  it("puts a chosen month in the URL and asks the store for it", () => {
    renderPage(payload());

    fireEvent.change(picker(), { target: { value: "2026-06" } });

    expect(screen.getByTestId("search")).toHaveTextContent("?period=2026-06");
    expect(state.asked.at(-1)).toBe("2026-06");
  });
});

describe("/financials — saying which month it is showing", () => {
  it("answers the page's question instead of asking it, on every month", () => {
    const { container } = renderPage(payload());
    expect(container.querySelector("[data-page-header]")?.textContent).not.toContain("Am I making money");
    expect(container.querySelector("[data-money-answer] h2")?.textContent).toMatch(/^August net [+−-]?\$/u);
    expect(container.querySelector("[data-period-fallback]")).toBeNull();
  });

  it("still lets a mid-history month be chosen, and shows it in the selector", () => {
    renderPage(payload({ period: "2026-06" }), "/financials?period=2026-06");
    expect(picker()).toHaveValue("2026-06");
  });
});

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
    expect(links[0]).toHaveAttribute("href", "/financials");
    expect(links[1]).toHaveAttribute("href", "/financials?period=2026-07");
  });

  it("keeps the selector, valued at the month that is not there", () => {
    renderRefusal(refusal("period_not_found", 404), "/financials?period=2020-01");

    // The selector's value is the requested month rather than a real one, so
    // picking any real month is a change the control actually fires.
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

  /** A read that failed for any other reason is still a broken ledger. */
  it("still shows the ledger error for a failure that is not about the month", () => {
    renderRefusal(new Error("GET /api/financials failed: 500"), "/financials");

    expect(screen.getByText("The ledger did not answer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing recorded for/)).toBeNull();
  });

  it("keeps the last-good figures when a later refresh fails", () => {
    state.error = new Error("GET /api/financials failed: 500");
    const { container } = renderPage(payload());

    expect(container.querySelector("[data-money-answer]")).not.toBeNull();
    expect(screen.queryByText("The ledger did not answer")).toBeNull();
  });
});

// The refusal has to reach the page carrying the months.
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

    // Both months, in calendar order: the trajectory is the one block about
    // the ledger rather than the chosen period.
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

  /* Revenue is connected on another page, so it is a link; costs are declared
     on this one, so the registers are open in place. */
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
    expect(container.querySelector("[data-money-answer]")).toBeNull();
    expect(container).not.toHaveTextContent("configure operating costs");
  });
});

// Every block answers its question with a shape before a sentence: the
// trajectory as bars around a visible zero, each asset's slice of the month's
// revenue as a proportion, and where a cost figure came from as a glyph.

describe("/financials — the first screen answers the whole question", () => {
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

  /** The audit measures the first screen against a block the page names, so
   * the mark is part of the contract, not styling. */
  it("declares the monthly summary and keeps accounting history in its disclosure", () => {
    const { container } = renderPage(threeMonths());

    const hero = container.querySelector("[data-surface-hero]")!;
    expect(hero).not.toBeNull();
    expect(hero).toHaveAttribute("data-money-answer");
    expect(hero.querySelector("[data-hero-chart]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Month by month/ }));
    expect(container.querySelector('[data-panel="months"] [data-hero-chart]')).not.toBeNull();
  });

  /** The month's net in a sentence, then revenue, cost and what is confirmed
   * beside it. */
  it("states the selected month as its net in a sentence, with revenue, cost and what is confirmed", () => {
    const { container } = renderPage(threeMonths());

    expect(container.querySelector("[data-kpi]")).toBeNull();
    expect(container.querySelector("[data-money-answer] h2")).toHaveTextContent("August net +$241");
    const labels = [...container.querySelectorAll("[data-money-answer] dt")].map((node) => node.textContent);
    expect(labels).toEqual(["Revenue", "Cost", "Confirmed"]);
    expect(container.querySelector("[data-money-revenue] dd")).toHaveTextContent("$441");
    expect(container.querySelector("[data-money-cost] dd")).toHaveTextContent("$200");
    expect(container.querySelector("[data-money-confirmed] dd")).toHaveTextContent("$300");
  });

  it("says a cost nobody recorded is none recorded, never $0, and the net is revenue only", () => {
    const { container } = renderPage(payload({ costLines: [], months: [{ period: '2026-08',
      booked: { currency: 'USD', revenue: 90, cost: 0, net: 90 },
      estimated: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
      total: { currency: 'USD', revenue: 90, cost: 0, net: 90 },
    }] }));
    expect(container.querySelector("[data-money-cost] dd")).toHaveTextContent("—none recorded");
    expect(container.querySelector("[data-money-answer]")).toHaveTextContent("revenue only");
    expect(container.querySelector('[data-panel="cost-breakdown"]')).toBeNull();
  });

  /** The chart takes a signed domain, so the net is a line of its own and no
   * footnote is needed. */
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

  /** The open month is capped with a hollow point and the strip withholds the
   * month-on-month deltas, because a month four days in is always short. The
   * state is said once, as the header's "Month to date" chip. */
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
    expect(container.querySelector("[data-money-answer] h2")).toHaveTextContent(/so far$/u);
    expect(container.querySelector("[data-money-answer]")!.textContent).not.toMatch(/%/);
    expect(container).not.toHaveTextContent("still open");
    expect(container.querySelector('[data-panel="months"] [data-month-open]')).toHaveTextContent("to date");
  });

  it("says nothing about an open month when the month shown is closed", () => {
    const { container } = renderPage(threeMonths());
    expect(container.querySelector("[data-month-to-date]")).toBeNull();
  });

  /** Everything read one cell at a time is a collapsed panel: the audit
   * measures what a reader sees. */
  it("keeps the month table, the cost breakdown and the registers closed", () => {
    const { container } = renderPage(threeMonths());

    const panels = [...container.querySelectorAll("[data-panel]")];
    expect(panels.map((panel) => panel.getAttribute("data-panel"))).toEqual([
      "months",
      "cost-breakdown",
      "costs",
    ]);
    // Closed means not rendered, not merely hidden: a closed `<details>` still
    // lays its contents out.
    expect(panels.every((panel) => !panel.hasAttribute("data-panel-open"))).toBe(true);
    expect(container.querySelector("[data-collection-editor]")).toBeNull();
    expect(container.querySelector("table")).not.toBeNull(); // the by-asset one

    // The two registers are config files, which is what the audit's opt-out
    // declares: the chip rule is about a view surface printing an owner it
    // cannot act on, not about an editor that writes the file.
    expect(
      container.querySelector('[data-panel="costs"]')!.hasAttribute("data-config-surface"),
    ).toBe(true);
  });

  /** No paragraph anywhere: each fact is drawn on the figure it qualifies. */
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

  /** A share of nothing is not a small share. */
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

  /** Below `sm` this table is a stack of cards and this link is the only
   * control on each. jsdom has no layout, so the shape is asserted: the box
   * grows and a negative margin of half the growth gives the cell back the
   * height it had. */
  it("gives each asset name a thumb-sized target the cards do not pay for", () => {
    const { container } = renderPage(payload());

    const link = container.querySelector(
      'a[href="/assets/meals.example/financials"]',
    ) as HTMLElement;
    expect(link).not.toBeNull();
    expect(link.className).toContain("max-sm:min-h-11");
    expect(link.className).toContain("max-sm:inline-flex");
    expect(link.className).toContain("max-sm:-my-3");
    expect(link.className).not.toContain(" inline-flex");
  });

  /** The share bar beside it answers which asset is carrying this month; this
   * answers which one is getting better. */
  it("draws each asset's net month by month, muted and unsmoothed", () => {
    const { container } = renderPage(payload());

    const cell = container.querySelector("[data-property-trend='meals.example']");
    expect(cell).not.toBeNull();
    const spark = cell!.querySelector("svg")!;
    expect(spark.getAttribute("aria-label")).toBe(
      "Meal Planner net by month, 2026-06 to 2026-08",
    );
    // Net's movement carries no verdict, so the line is `text-muted-foreground`
    // and never the positive/negative scale.
    expect(cell!.querySelector(".text-muted-foreground")).not.toBeNull();
    // Three monthly points, drawn as they are: one move and two curved
    // segments, each ending on a month's reading.
    expect(spark.querySelector("[data-chart-line]")!.getAttribute("d")!.match(/[MC]/g)).toHaveLength(3);
  });

  /** The open month is still being counted, so the loudest ink on the line
   * must not read as settled. */
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

  /** Two points are a slope, not a trend. */
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
    // The reason opens from a key or a tap, not a hover-only title.
    expect(screen.getByRole("button", { name: "No trend: Needs 3 months of history" })).toHaveTextContent("—");
  });

  /** A sparkline spaces its points by position, so a series carrying only the
   * months that booked something would draw January, June and August as three
   * consecutive months. The payload carries the whole axis with a null in
   * each hole, and the line breaks over them. */
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
    // Two runs, not one: a second `M` is the break.
    expect(path.match(/M/g)).toHaveLength(2);
    expect(
      container.querySelector("[data-property-trend] svg")!.getAttribute("aria-label"),
    ).toBe("Meal Planner net by month, 2026-05 to 2026-08");
  });

  /** The floor counts readings, not positions. */
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
    // The reason opens from a key or a tap, not a hover-only title.
    expect(screen.getByRole("button", { name: "No trend: Needs 3 months of history" })).toHaveTextContent("—");
  });

  /** The figures in this row are August's; a line running into September
   * under them would be two periods drawn as one unit. */
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
  /* The chip is the operator's own word for the kind; the source is the name
     the operator gave the subscription, not the key the row is filed under. */
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

// The Costs section is the two cost registers, editable through the same
// write lane a knob uses: one changeset per action, each carrying its exact
// inverse, and a row the schema refuses never becoming a request. The lane is
// stubbed: what is asserted is the shape of what the page asked for.

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

/**
 * Open one of the page's collapsed panels. A panel mounts its body only when
 * open, so a case about a register, the month table or the cost breakdown has
 * to press the header first. Idempotent.
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
  // The candidate list is the integration matrix's: the whole roster, not this
  // period's ledger split, so an asset that has booked nothing is offerable.
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
    // The two optional fields left blank are dropped rather than written as
    // empty strings: an omitted `to` means "still live".
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
    // that index is refused rather than deleting their work.
    expect(onlyOp(calls, 1)).toEqual({
      kind: "file-json-delete",
      file: "config/recurring-costs.json",
      pointer: "/costs/2",
      expect: row,
    });
  });

  // A price change is a new row, not an edit: every month already booked was
  // booked at the amount, so the cell is locked and the change is the row's To.
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

  // A domain order is a prepaid annual term, so the figure the ledger books is
  // the price over twelve: a computed column beside the editable ones.
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
    // The row comes back where it was: this table is drawn in file order, so
    // an appended undo would silently reorder the list.
    expect(onlyOp(calls, 1)).toEqual({
      kind: "file-json-insert",
      file: "config/domain-costs.json",
      pointer: "/domains/0",
      value: ORDERS[0],
    });
  });

  /** The month totals and the months behind the period picker are built from
   * these files, so the write lane throws the ledger read away once the dev
   * server has restarted around the changed file. */
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
  /** Each case spoils exactly one field of an otherwise valid row, so the
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
      { ...NEW_COST, Site: "Menu Plate" },
      "Site must be a site id",
    );
  });

  /** Uniqueness is the one rule a JSON pointer cannot express, so it is
   * checked in the browser: a duplicate `id` is part of the ledger's
   * idempotency key and would re-book every month. */
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
    // One copy for the whole screen: the sentence is a fact about the build,
    // not about a table.
    const paused =
      document.querySelectorAll("[data-saves-paused]").length +
      document.querySelectorAll("[data-collection-read-only]").length +
      document.querySelectorAll("[data-knob-read-only]").length;
    expect(paused).toBe(1);
    expect(document.querySelector("[data-saves-paused]")).toHaveTextContent("Saves paused");
    expect(document.querySelectorAll("[data-collection-locked]")).toHaveLength(2);

    expect(
      within(editor("recurring-costs")).getByText("Claude Code (Max)"),
    ).toBeInTheDocument();
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
    // Biggest first, and only what is live in the shown month: the retired
    // plan closed in May, so meals.example's line is its amortizing domain alone.
    expect(lines.map((line) => line.getAttribute("data-declared-asset"))).toEqual([
      "root-os",
      "meals.example",
    ]);
    expect(lines[0]).toHaveTextContent("$200.00");
    expect(lines[1]).toHaveTextContent("$0.39");
    expect(
      lines.map((line) =>
        line.querySelector("[data-property-favicon]")?.getAttribute("data-property-favicon"),
      ),
    ).toEqual(["root-os", "meals.example"]);
    expect(
      lines[1]?.querySelector("[data-segment-bar]")?.getAttribute("aria-label"),
    ).toBe("Meal Planner is 0.2% of the declared monthly cost");
  });

  /** The cash already spent, and how much of the list is still being spread
   * across the shown month: two facts no row states. */
  it("states the orders' total and how many still amortize into this month", () => {
    stubLane();
    const { container } = renderPage(withCosts());
    openPanel("costs");

    const terms = container.querySelector("[data-domain-terms]")?.textContent;
    expect(terms).toBe("1 order · $4.63 paid · 1 amortizing this month");
    expect(terms).not.toContain("12 months");
  });

  /** With nothing declared for the month there is no denominator, so the
   * strip is absent rather than empty. */
  it("draws no run-rate strip when the two files declare nothing for the month", () => {
    stubLane();
    const { container } = renderPage(
      withCosts({ recurringCosts: [], domainOrders: [], domains: [] }),
    );

    expect(container.querySelector("[data-declared-run-rate]")).toBeNull();
    expect(editor("recurring-costs")).toBeInTheDocument();
    expect(editor("domain-costs")).toBeInTheDocument();
  });
});

// What the page does not know is drawn where it applies: a dash in the row,
// the Reconciled bar, and a chip on the domain order.
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

    // currentPeriod is 2026-09: nosh.example's term ends this month,
    // meals.example's runs to 2027-02 and says nothing.
    expect(container.querySelector('[data-domain-renews="nosh.example"]')).toHaveTextContent(
      "Renews Oct 2026",
    );
    expect(container.querySelector('[data-domain-renews="meals.example"]')).toBeNull();
  });
});

/** With one site, a table whose every row equals its total reads as a broken
 * report, and one site has nothing to allocate. */
describe("/financials — one site states its money once", () => {
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
    const revenue = screen.getByRole("region", { name: "Daily revenue" });
    expect(revenue.querySelector("[data-source-coverage]")).toBeNull();
    expect(container.textContent).not.toMatch(/portfolio/i);
    expect(container.querySelector("[data-money-revenue] dd")).toHaveTextContent("$82");
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
    // No overhead: "Sites, direct" would be the total again.
    expect(rowNames(container).slice(1)).toEqual(["Total net"]);
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
    expect(names.slice(2)).toEqual(["Total net"]);
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
    expect(container.querySelector('[data-money-answer] h2')).toHaveTextContent('+€241');
    expect(container.querySelector('[data-money-revenue] dd')).toHaveTextContent('€441');
    expect(container.querySelector('[data-money-cost] dd')).toHaveTextContent('€200');
    expect(container.querySelector('[data-money-answer]')).not.toHaveTextContent('$');
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
    expect(container.querySelector('[data-money-answer] h2')).toHaveTextContent('Unavailable');
    expect(container.querySelector('[data-money-answer] h2')).not.toHaveTextContent('$0');
    expect(screen.getAllByText('€100.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$200.00').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-segment="reconciled"]')).toBeNull();
  });
});
