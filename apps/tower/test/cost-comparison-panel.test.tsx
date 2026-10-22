import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserRuntimeProvider } from "@/lib/browser-context";
import { createBrowserRuntime } from "@/lib/browser-runtime";
import { CostComposition } from "@/routes/financials/CostComposition";
import { costLine, costMonth } from "../e2e/monthly-cost-changes/fixtures";
import type { FinancialsPayload } from "@shared/financials";

const owned: Array<() => void> = [];
afterEach(() => { for (const close of owned.splice(0)) close(); });

function mount(previous = costMonth("2026-08"), current = costMonth(), response?: () => Promise<Response>) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response ? response() : Response.json(previous));
  const runtime = createBrowserRuntime({ mode: "standalone", clientGeneration: 1 }, { origin: "http://localhost", fetch, sendAnswer: async () => {} });
  const client = runtime.queries;
  client.setDefaultOptions({ queries: { retryDelay: 0 } });
  owned.push(() => { runtime.retire(); client.clear(); });
  const tree = (data: FinancialsPayload) => <BrowserRuntimeProvider value={{ runtime, workspaceLabel: null }}>
    <QueryClientProvider client={client}>
      <CostComposition period={data.period} lines={data.costLines} recurringCosts={data.recurringCosts} />
    </QueryClientProvider>
  </BrowserRuntimeProvider>;
  const view = render(tree(current));
  return { ...view, fetch, client, changeMonth: (data: FinancialsPayload) => view.rerender(tree(data)) };
}

async function toggle() {
  const summary = screen.getByText("Compare with previous month", { selector: "summary" });
  const expanded = summary.getAttribute("aria-expanded") !== "true";
  fireEvent.click(summary);
  await waitFor(() => expect(summary).toHaveAttribute("aria-expanded", String(expanded)));
}

it("makes no initial read, loads through the owner-bound API only on opening, and reuses the normal cache on reopening", async () => {
  const { fetch, client } = mount();
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryAllByRole("button")).toHaveLength(0);
  expect(client.getQueryCache().getAll()).toHaveLength(0);
  await toggle();
  await screen.findByRole("list", { name: "Cost changes by source" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toContain("/api/financials?period=2026-08");
  const cached = client.getQueryData(["financials", "2026-08"]);
  await toggle();
  expect(screen.queryByRole("list", { name: "Cost changes by source" })).toBeNull();
  await toggle();
  await screen.findByRole("list", { name: "Cost changes by source" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(["financials", "2026-08"])).toBe(cached);
  expect(client.getQueryCache().getAll().map((query) => query.queryKey)).toEqual([["financials", "2026-08"]]);
});

it("shows cents, neutral signed changes, valid zero, unknown labels, added/absent sources and currency totals", async () => {
  const { container } = mount();
  await toggle();
  const list = await screen.findByRole("list", { name: "Cost changes by source" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows[0]).toHaveTextContent("Example hosting");
  expect(rows[0]).toHaveTextContent("+$2.11");
  expect(rows[1]).toHaveTextContent("example-model");
  expect(rows[1]).toHaveTextContent("−$2.03");
  expect(rows[2]).toHaveTextContent("No source");
  expect(rows[2]).toHaveTextContent("unknown-family");
  expect(within(rows[2]!).getAllByText("$0.00")).toHaveLength(3);
  for (const name of ["added", "absent"]) {
    const row = rows.find((item) => item.textContent?.startsWith(name))!;
    expect(row).toHaveTextContent("No record");
    expect(row).toHaveTextContent("Unavailable");
  }
  expect(container.querySelector('[aria-label="Recorded cost totals"]')).toHaveTextContent("$16.07Current$17.16Difference+$1.09");
  expect(container.querySelector('[data-cost-comparison] .text-positive, [data-cost-comparison] .text-negative')).toBeNull();
  expect(container).toHaveTextContent("Month-to-date costs against the complete previous calendar month");
  expect(container).not.toHaveTextContent(/saving|performance|improvement/i);
});

it("labels a closed month and uses previous labels for sources no longer in the current register", async () => {
  const previous = costMonth("2026-08", { recurringCosts: [{ ...costMonth().recurringCosts[0]!, id: "retired", label: "Retired subscription" }], costLines: [costLine("recurring:retired", 4)] });
  const { container } = mount(previous, costMonth("2026-09", { recurringCosts: [], currentPeriod: "2026-10" }));
  // The calendar fact is supplied by the financial read, not the browser clock.
  previous.currentPeriod = "2026-10";
  await toggle();
  await screen.findByRole("list", { name: "Cost changes by source" });
  expect(container).toHaveTextContent("Retired subscription");
  expect(container).toHaveTextContent("Recorded costs for two complete calendar months");
  expect(container).not.toHaveTextContent("Month-to-date");
});

it.each([
  ["wrong month", costMonth("2026-07"), "Previous month unavailable"],
  ["missing month entry", costMonth("2026-08", { periods: ["2026-07", "2026-09"] }), "No history for August 2026"],
  ["no costs", costMonth("2026-08", { costLines: [] }), "No cost records for August 2026"],
  ["empty ledger", costMonth("2026-08", { empty: true }), "No history for August 2026"],
] as const)("keeps %s unavailable instead of manufacturing zero", async (_name, previous, message) => {
  mount(previous);
  await toggle();
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(message));
  expect(screen.getByRole("status")).toHaveAttribute("data-status-for", "cost-comparison:2026-08");
  expect(screen.queryByRole("list", { name: "Cost changes by source" })).toBeNull();
});

it("shows loading then a failed-read state without inventing amounts", async () => {
  let fail!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { fail = resolve; });
  mount(undefined, undefined, async () => (await pending).clone());
  await toggle();
  expect(await screen.findByRole("status")).toHaveTextContent("Loading August 2026 costs");
  expect(screen.getByRole("status")).toHaveAttribute("data-status-for", "cost-comparison:2026-08");
  await act(async () => { fail(Response.json({ error: "unavailable" }, { status: 503 })); });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Previous month unavailable"));
  expect(screen.getByRole("status")).toHaveAttribute("data-status-for", "cost-comparison:2026-08");
  expect(screen.queryByRole("list", { name: "Cost changes by source" })).toBeNull();
});

it("uses December's key for January and rejects the previous period's data after a month change", async () => {
  const { fetch, changeMonth, client } = mount(costMonth("2025-12", { periods: ["2025-12", "2026-01"] }), costMonth("2026-01"));
  await toggle();
  await screen.findByRole("list", { name: "Cost changes by source" });
  expect(client.getQueryData(["financials", "2025-12"])).toBeDefined();
  fetch.mockImplementation(async () => Response.json(costMonth("2026-02", { periods: ["2026-02", "2026-03"] })));
  changeMonth(costMonth("2026-03"));
  expect(screen.queryByRole("list", { name: "Cost changes by source" })).toBeNull();
  await screen.findByRole("list", { name: "Cost changes by source" });
  expect(screen.getByText(/Previous: February 2026/)).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(client.getQueryData(["financials", "2026-02"])).toBeDefined();
});

it("reuses a financial month already in the owner cache without an additional read", async () => {
  const { fetch, client } = mount();
  client.setQueryData(["financials", "2026-08"], costMonth("2026-08"));
  await toggle();
  await screen.findByRole("list", { name: "Cost changes by source" });
  expect(fetch).not.toHaveBeenCalled();
});

it("hides last-good comparison amounts when a later history read fails", async () => {
  const { client } = mount(undefined, undefined, async () => Response.json({ error: "unavailable" }, { status: 503 }));
  client.setQueryData(["financials", "2026-08"], costMonth("2026-08"));
  await toggle();
  await screen.findByRole("list", { name: "Cost changes by source" });
  await act(async () => { await client.invalidateQueries({ queryKey: ["financials", "2026-08"] }); });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Previous month unavailable"));
  expect(screen.getByRole("status")).toHaveAttribute("data-status-for", "cost-comparison:2026-08");
  expect(client.getQueryData(["financials", "2026-08"])).toBeDefined();
  expect(screen.queryByRole("list", { name: "Cost changes by source" })).toBeNull();
});

it("shows each currency separately even when the month has no combined currency total", async () => {
  const previous = costMonth("2026-08", { costLines: [costLine("same", 1.01), costLine("same", 2.02, { currency: "EUR" })] });
  const current = costMonth("2026-09", { costLines: [costLine("same", 1.03), costLine("same", 1.01, { currency: "EUR" })] });
  const { container } = mount(previous, current);
  await toggle();
  const list = await screen.findByRole("list", { name: "Cost changes by source" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows[0]).toHaveTextContent("EUR");
  expect(rows[0]).toHaveTextContent("−€1.01");
  expect(rows[1]).toHaveTextContent("USD");
  expect(rows[1]).toHaveTextContent("+$0.02");
  const totals = container.querySelector('[aria-label="Recorded cost totals"]')!;
  expect(totals).toHaveTextContent("Total · EUR");
  expect(totals).toHaveTextContent("Total · USD");
});
