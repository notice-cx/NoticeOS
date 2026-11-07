import { fireEvent, render, screen, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { AlertDailyPayload } from "@shared/alert-daily";

const state = vi.hoisted(() => ({ data: undefined as AlertDailyPayload | undefined, isError: false, isFetching: false, refetch: vi.fn() }));
vi.mock("@/hooks/useAlertDaily", () => ({ useAlertDaily: () => state }));
import { AlertDaily } from "@/routes/alerts/AlertDaily";

beforeEach(() => { state.data = undefined; state.isError = false; state.isFetching = false; state.refetch.mockClear(); });
function show() { return render(<MemoryRouter><AlertDaily /></MemoryRouter>); }

it("exposes dated rising/falling snapshots, missing days and zero in a data table", async () => {
  state.data = { generatedAt: "2026-09-22T12:00:00Z", days: [7, 12, null, 3, 0].map((open, i) => ({
    day: `2026-09-${18 + i}`, open, errors: open === null ? null : 0, warnings: open,
    observedAt: open === null ? null : `2026-09-${18 + i}T06:00:00Z`,
  })) };
  const { container } = show();
  expect(screen.getByText(/Missing days are unknown/)).not.toBeVisible();
  fireEvent.click(screen.getByText('How daily totals are counted'));
  expect(screen.getByText(/not newly fired alerts/)).toBeVisible();
  expect(screen.getByText(/Missing days are unknown/)).toBeVisible();
  fireEvent.click(screen.getByText(/^View data/));
  const table = await screen.findByRole("table");
  expect(within(table).getAllByRole("row")).toHaveLength(6);
  for (const [i, value] of [7, 12, "Not reported", 3, 0].entries()) {
    const row = within(table).getAllByRole("row")[i + 1]!;
    expect(row.querySelector("time")).toHaveAttribute("dateTime", `2026-09-${18 + i}`);
    expect(within(row).getByRole("cell", { name: String(value) })).toBeVisible();
  }
  expect(container.querySelector('time[datetime="2026-09-20"]')?.closest("tr")).toHaveTextContent("Snapshot missing; count unknown");
});

it("shows loading, empty history and an initial read error as distinct states with retry", () => {
  const view = show();
  expect(screen.getByRole("status")).toHaveTextContent("Loading");
  state.data = { generatedAt: "2026-09-22T12:00:00Z", days: [] };
  view.rerender(<MemoryRouter><AlertDaily /></MemoryRouter>);
  expect(screen.getByText("No daily alert snapshots recorded yet.")).toBeVisible();
  state.data = undefined;
  state.isError = true;
  view.rerender(<MemoryRouter><AlertDaily /></MemoryRouter>);
  expect(screen.queryByText("No daily alert snapshots recorded yet.")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Counts are unknown");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(state.refetch).toHaveBeenCalledOnce();
});

it("identifies retained data after a failed refresh", () => {
  state.data = { generatedAt: "2026-09-22T12:00:00Z", days: [{ day: "2026-09-22", open: 0, errors: 0, warnings: 0, observedAt: "2026-09-22T06:00:00Z" }] };
  state.isError = true;
  show();
  expect(screen.getByRole("status")).toHaveTextContent("Showing the last successful read");
  expect(screen.getByRole('heading', { name: 'Open alerts by day' })).toBeVisible();
});

it("excludes informational notices and distinguishes an earlier daily count from the current total", async () => {
  state.data = { generatedAt: '2026-09-22T12:00:00Z', days: [{ day: "2026-09-22", open: 12, errors: 1, warnings: 1,
    observedAt: "2026-09-22T03:00:00Z" }] };
  const { container } = show();
  expect(container.querySelector('[data-alert-daily-current]')).toBeNull();
  fireEvent.click(screen.getByText('How daily totals are counted'));
  expect(screen.getByText(/Informational notices are excluded/)).toBeVisible();
  fireEvent.click(screen.getByText(/^View data/));
  const table = await screen.findByRole("table");
  expect(within(table).getByRole("cell", { name: "2" })).toBeVisible();
  expect(within(table).queryByRole("cell", { name: "12" })).toBeNull();
  expect(table).toHaveTextContent("1 error · 1 warning");
  expect(container).not.toHaveTextContent("UTC UTC");
  expect(state.data.days[0]!.open).toBe(12);
});
