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
  show();
  fireEvent.click(screen.getByText(/^View data/));
  const table = await screen.findByRole("table");
  expect(within(table).getAllByRole("row")).toHaveLength(6);
  for (const [i, value] of [7, 12, null, 3, 0].entries()) {
    const row = within(table).getAllByRole("row")[i + 1]!;
    expect(row.querySelector("time")).toHaveAttribute("dateTime", `2026-09-${18 + i}`);
    const shown = within(row).getAllByRole('cell')[0]!.textContent?.trim() ?? '';
    expect(/^\d+$/.test(shown) ? Number(shown) : null).toBe(value);
  }
});

it("shows loading, empty history and an initial read error as distinct states with retry", () => {
  const view = show();
  expect(screen.getByRole("status")).toBeVisible();
  state.data = { generatedAt: "2026-09-22T12:00:00Z", days: [] };
  view.rerender(<MemoryRouter><AlertDaily /></MemoryRouter>);
  expect(screen.queryByRole("status")).toBeNull();
  expect(view.container.querySelector('[data-hero-chart]')).toBeNull();
  state.data = undefined;
  state.isError = true;
  view.rerender(<MemoryRouter><AlertDaily /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(state.refetch).toHaveBeenCalledOnce();
});

it("retains the chart and exposes retry after a failed refresh", () => {
  state.data = { generatedAt: "2026-09-22T12:00:00Z", days: [{ day: "2026-09-22", open: 0, errors: 0, warnings: 0, observedAt: "2026-09-22T06:00:00Z" }] };
  state.isError = true;
  const { container } = show();
  expect(container.querySelector('[data-hero-chart]')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(state.refetch).toHaveBeenCalledOnce();
});

it("excludes informational notices and distinguishes an earlier daily count from the current total", async () => {
  state.data = { generatedAt: '2026-09-22T12:00:00Z', days: [{ day: "2026-09-22", open: 12, errors: 1, warnings: 1,
    observedAt: "2026-09-22T03:00:00Z" }] };
  show();
  fireEvent.click(screen.getByText(/^View data/));
  const table = await screen.findByRole("table");
  expect(within(table).getByRole("cell", { name: "2" })).toBeVisible();
  expect(within(table).queryByRole("cell", { name: "12" })).toBeNull();
  expect(state.data.days[0]!.open).toBe(12);
});
