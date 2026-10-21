import type { ComponentProps } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DailyMeasureChart } from "@/components/viz/DailyMeasureChart";
import { SourceHistory } from "@/components/viz/SourceHistory";
import { DAILY_MEASURE_DEMO, DAILY_MEASURE_LANDMARKS, SOURCE_HISTORY_DOMAIN, SOURCE_HISTORY_HEADLINE, SOURCE_HISTORY_NOW, SOURCE_HISTORY_ROWS } from "@/routes/kitchen-sink/overview-visuals-demo";

const chart = (over: Partial<ComponentProps<typeof DailyMeasureChart>> = {}) => render(
  <MemoryRouter><DailyMeasureChart measure={DAILY_MEASURE_DEMO} landmarks={DAILY_MEASURE_LANDMARKS} tone="text-traffic"
    changes={[{ date: "2026-09-04", label: "Navigation updated", detail: "Synthetic release note" }]}
    watches={[{ start: "2026-08-30", end: "2026-09-09", label: "Watching navigation" }]}
    alertTo="/alerts" {...over} /></MemoryRouter>,
);
const sources = () => render(<SourceHistory rows={SOURCE_HISTORY_ROWS} headline={SOURCE_HISTORY_HEADLINE}
  domain={SOURCE_HISTORY_DOMAIN} nowMs={SOURCE_HISTORY_NOW} notConnected={["Product analytics"]} />);

afterEach(() => vi.restoreAllMocks());

describe("DailyMeasureChart presentation", () => {
  it("draws caller-supplied evidence with distinct bands, complete-day labels and day states", () => {
    const { container } = chart();
    expect(container.querySelector("[data-overview-normal]")).toHaveStyle({ bottom: "37.5%", height: "calc(62.5% - 37.5%)" });
    expect(container.querySelector('[data-overview-span="watch"]')).toHaveStyle({ left: "0%", width: `${9 / 14 * 100}%` });
    expect(container.querySelector('[data-overview-span="alert"]')).toHaveClass("text-warn");
    expect(container.querySelector('[data-overview-span="partial"]')).toHaveClass("viz-hatch");
    for (const [date, state] of [["06", "missed"], ["07", "partial"], ["13", "now"], ["14", "counting"]]) {
      expect(container.querySelector(`[data-overview-day="2026-09-${date}"]`)).toHaveAttribute("data-state", state);
    }
    expect(container.querySelectorAll("[data-overview-landmark]")).toHaveLength(2);
    expect(screen.getByText("Best · Sep 3 · 160")).toBeInTheDocument();
    expect(screen.getByText("Lowest · 35")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Search clicks below normal/ })).toHaveAttribute("href", "/alerts");
  });

  it("keeps date navigation, incomplete-day readouts and change notes available from the keyboard", () => {
    chart();
    const plot = screen.getByRole("group", { name: /Search clicks a day by day/ });
    fireEvent.focus(plot);
    expect(screen.getByRole("status")).toHaveTextContent("20 clicks · still counting");
    fireEvent.keyDown(plot, { key: "Home" });
    expect(screen.getByRole("status")).toHaveTextContent("Sep 1");
    for (let index = 0; index < 3; index++) fireEvent.keyDown(plot, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("Navigation updated");
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("not reported");
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("95 clicks · Search not reported");
    fireEvent.keyDown(plot, { key: "End" });
    expect(screen.getByRole("status")).toHaveTextContent("Sep 14");
    fireEvent.keyDown(plot, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders caller selections without selecting a best day itself, and accepts an empty series", () => {
    const { container, rerender } = chart({ landmarks: { best: null, worst: null, newest: null } });
    expect(container.querySelector("[data-overview-landmark]")).toBeNull();
    rerender(<DailyMeasureChart measure={{ ...DAILY_MEASURE_DEMO, days: [] }} landmarks={DAILY_MEASURE_LANDMARKS} tone="text-traffic" changes={[]} watches={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("SourceHistory presentation", () => {
  it("uses the supplied headline and coverage summary while drawing every daily state and no-record sources", () => {
    const { container } = sources();
    expect(container.querySelector("[data-source-history-headline]")).toHaveTextContent(SOURCE_HISTORY_HEADLINE.text);
    const row = container.querySelector('[data-source-row="Search"]')!;
    expect(within(row as HTMLElement).getByRole("img")).toHaveAccessibleName(SOURCE_HISTORY_ROWS[0]!.summary);
    for (const state of ["reported", "missed", "counting", "before", "late"]) {
      expect(row.querySelector(`[data-source-day][data-state="${state}"]`)).toBeInTheDocument();
    }
    expect(container.querySelector('[data-source-row="Search"] [data-state="late"]')).toHaveClass("bg-error");
    expect(container.querySelector('[data-source-row="Analytics"] [data-state="late"]')).toHaveClass("bg-warn");
    expect(container.querySelector('[data-source-row="Revenue"] [data-state="late"]')).toHaveClass("border-dashed");
    expect(container.querySelector('[data-source-row="Uptime"] [data-source-day]')).toBeNull();
    expect(screen.getByText("Not connected: Product analytics")).toBeInTheDocument();
  });

  it("navigates dates and source rows, skips no-record rows, and clears the readout", () => {
    sources();
    const grid = screen.getByRole("group");
    fireEvent.focus(grid);
    expect(screen.getByRole("status")).toHaveTextContent("Search daily reports · Sep 14 · not reported");
    fireEvent.keyDown(grid, { key: "Home" });
    expect(screen.getByRole("status")).toHaveTextContent("before this source began");
    fireEvent.keyDown(grid, { key: "End" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(screen.getByRole("status")).toHaveTextContent("Analytics daily reports");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(screen.getByRole("status")).toHaveTextContent("Revenue daily reports · Sep 14 · not in yet");
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    fireEvent.keyDown(grid, { key: "ArrowLeft" });
    expect(screen.getByRole("status")).toHaveTextContent("Analytics daily reports · Sep 13");
    fireEvent.keyDown(grid, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
