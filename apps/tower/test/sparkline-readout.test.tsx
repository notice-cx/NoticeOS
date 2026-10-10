import { fireEvent, render, screen, within } from "./render";
import { describe, expect, it, vi } from "vitest";
import { averageSeries, fillSeriesGaps, shiftLabel } from "@shared/surface";
import { Kpi } from "@/components/surface/KpiStrip";
import { Sparkline } from "@/components/surface/Sparkline";
import { formatUsd } from "@/lib/format";
import { metricWindow } from "@/routes/asset-detail/overview-metrics";

const COUNTS = [43, 67, 145, 126, 275, 144, 59].map((v, index) => ({
  t: shiftLabel("2026-09-05", index - 6), v,
}));

describe("Sparkline plotted-value contract", () => {
  it("keeps unreported calendar dates as inspectable gaps with correct spacing", () => {
    const input = [
      { t: "2026-09-01", v: 10 },
      { t: "2026-09-02", v: 20 },
      { t: "2026-09-05", v: 30 },
    ];
    const { container } = render(<Sparkline data={input} average={false} readout />);
    expect(container.querySelector("path")!.getAttribute("d")).toBe("M2 20 L17 11 M62 2");
    const chart = screen.getByRole("img");
    fireEvent.focus(chart);
    fireEvent.keyDown(chart, { key: "Home" });
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("Sep 3");
    expect(screen.getByRole("status")).toHaveTextContent("No report");
    expect(input).toHaveLength(3);
  });

  it("preserves missing months and exact money rather than joining distant ledger periods", () => {
    const { container } = render(<Sparkline data={[
      { t: "2026-01", v: 10.25 }, { t: "2026-03", v: 30.75 },
    ]} average={false} readout format={(value) => formatUsd(value, { cents: true })} />);
    expect(container.querySelector("path")!.getAttribute("d")).toBe("M2 20 M62 2");
    const chart = screen.getByRole("img");
    fireEvent.focus(chart);
    expect(screen.getByRole("status")).toHaveTextContent("Monthly value: $30.75");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByRole("status")).toHaveTextContent("No report");
  });

  it("inserts gaps in pre-averaged inputs without recalculating their observations", () => {
    render(<Sparkline data={[
      { t: "2026-09-01", v: 122.7 }, { t: "2026-09-03", v: 95.5 },
    ]} preAveragedWindow={7} readout format={(value) => value.toFixed(1)} />);
    const chart = screen.getByRole("img");
    fireEvent.focus(chart);
    expect(screen.getByRole("status")).toHaveTextContent("7-day average: 95.5");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByRole("status")).toHaveTextContent("No report");
  });

  it.each([
    [{ t: "first", v: 1 }, { t: "second", v: 2 }],
    [{ t: "2026-01", v: 1 }, { t: "2026-03-01", v: 2 }],
    [{ t: "2026-02-30", v: 1 }, { t: "2026-03-05", v: 2 }],
    [{ t: "2026-09-05", v: 1 }, { t: "2026-09-01", v: 2 }],
  ])("does not guess a calendar from unsupported or unordered labels", (...series) => {
    expect(fillSeriesGaps(series)).toEqual(series);
  });

  it("retains explicitly null dates without duplicating them", () => {
    expect(fillSeriesGaps([
      { t: "2026-09-01", v: 1 }, { t: "2026-09-02", v: null }, { t: "2026-09-04", v: 4 },
    ])).toEqual([
      { t: "2026-09-01", v: 1 }, { t: "2026-09-02", v: null }, { t: "2026-09-03", v: null }, { t: "2026-09-04", v: 4 },
    ]);
  });

  it("labels the plotted average separately from a divergent daily count", () => {
    const { container } = render(<Sparkline data={COUNTS} readout format={(value) => value.toFixed(1)} />);
    fireEvent.focus(screen.getByRole("img"));
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Sep 5");
    expect(status).toHaveTextContent("7-day average: 122.7");
    expect(status).toHaveTextContent("Daily value: 59.0");
    expect(status).not.toHaveTextContent("days reported");
    // The tooltip's primary quantity is the same averaged value the endpoint is
    // positioned by.
    const values = averageSeries(COUNTS).map((point) => point.v);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const expectedY = 2 + (1 - (values.at(-1)! - min) / (max - min)) * 18;
    expect(Number(container.querySelector("[data-chart-dot]")!.getAttribute("data-y"))).toBeCloseTo(expectedY);
  });

  it("keeps daily raw-series values unsmoothed and explicitly identified", () => {
    render(<Sparkline data={COUNTS} average={false} readout />);
    const chart = screen.getByRole("img");
    fireEvent.focus(chart);
    expect(screen.getByRole("status")).toHaveTextContent("Daily value: 59");
    expect(screen.getByRole("status")).not.toHaveTextContent("average");
    expect(chart).toHaveAccessibleDescription(/reported daily values, not averaged/);
  });

  it("describes actual dates and averaging semantics even without a readout", () => {
    render(<Sparkline data={COUNTS} ariaLabel="Signups trend" />);
    const chart = screen.getByRole("img", { name: "Signups trend" });
    expect(chart).toHaveAccessibleDescription(/trailing 7-day average of reported days/);
    expect(chart).toHaveAccessibleDescription(/2026-08-30 to 2026-09-05/);
    expect(chart.querySelector("title")).toHaveTextContent("trailing 7-day average");
    expect(chart).not.toHaveAttribute("tabindex");
  });

  it("names partial calendar windows instead of implying seven observed days", () => {
    render(<Sparkline data={[
      { t: "2026-09-01", v: 100 },
      { t: "2026-09-03", v: null },
      { t: "2026-09-05", v: 20 },
    ]} readout />);
    const chart = screen.getByRole("img");
    fireEvent.focus(chart);
    expect(screen.getByRole("status")).toHaveTextContent("7-day average: 60");
    expect(screen.getByRole("status")).toHaveTextContent("2 of 7 days reported");
    fireEvent.keyDown(chart, { key: "Home" });
    expect(screen.getByRole("status")).toHaveTextContent("1 of 7 days reported");
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("7-day average: —");
    expect(screen.getByRole("status")).toHaveTextContent("No report");
    expect(screen.getByRole("status")).not.toHaveTextContent("Daily value:");
  });

  it("does not count old observations outside the averaging calendar window", () => {
    render(<Sparkline data={[
      { t: "2026-08-01", v: 1000 },
      { t: "2026-09-04", v: 20 },
      { t: "2026-09-05", v: 40 },
    ]} readout />);
    fireEvent.focus(screen.getByRole("img"));
    expect(screen.getByRole("status")).toHaveTextContent("7-day average: 30");
    expect(screen.getByRole("status")).toHaveTextContent("2 of 7 days reported");
  });

  it("preserves money formatting and uses months for a monthly averaging window", () => {
    render(<Sparkline data={[
      { t: "2026-07", v: 12.25 },
      { t: "2026-08", v: 37.75 },
    ]} averageWindow={2} readout format={(value) => formatUsd(value, { cents: true })} />);
    fireEvent.focus(screen.getByRole("img"));
    expect(screen.getByRole("status")).toHaveTextContent("2-month average: $25.00");
    expect(screen.getByRole("status")).toHaveTextContent("Monthly value: $37.75");
  });

  it("marks every inspected provisional point, not only the endpoint", () => {
    const { container } = render(<Sparkline data={COUNTS} readout provisionalFrom="2026-09-04" />);
    const chart = screen.getByRole("img");
    fireEvent.focus(chart);
    expect(container.querySelector("[data-chart-dot]")).toHaveAttribute("data-chart-dot", "hollow");
    expect(screen.getByRole("status")).toHaveTextContent("provisional");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByRole("status")).toHaveTextContent("Sep 4 · provisional");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByRole("status")).not.toHaveTextContent("provisional");
    fireEvent.keyDown(chart, { key: "End" });
    expect(screen.getByRole("status")).toHaveTextContent("Sep 5 · provisional");
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("uses the same plotted readout for pointer movement and touch press", () => {
    render(<Sparkline data={COUNTS} readout />);
    const chart = screen.getByRole("img");
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, right: 100, top: 0, bottom: 22, width: 100, height: 22, toJSON: () => ({}),
    });
    fireEvent.pointerMove(chart, { clientX: 100 });
    expect(screen.getByRole("status")).toHaveTextContent("7-day average: 123");
    expect(screen.getByRole("status")).toHaveTextContent("Daily value: 59");
    fireEvent.pointerDown(chart, { pointerType: "touch", clientX: 0 });
    expect(screen.getByRole("status")).toHaveTextContent("Aug 30");
    expect(screen.getByRole("status")).toHaveTextContent("7-day average: 43");
  });
});

describe("KPI visible trend context", () => {
  it("names a selectable KPI once without repeating its nested chart description", () => {
    const { container } = render(<Kpi label="Signups" value="859" spark={COUNTS} onSelect={() => {}} />);
    const button = screen.getByRole("button", { name: /^Signups/ });
    expect(button).toHaveAccessibleName(/^Signups\s*859/);
    expect(button).not.toHaveAccessibleName(/Trend:|Line:|Only reported|2026-08-30/);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).not.toHaveAttribute("tabindex");
    expect(container.querySelector("[data-spark-caption]")).toBeNull();
    fireEvent.pointerDown(container.querySelector("svg")!, { pointerType: "touch", clientX: 0 });
    expect(container.querySelector("[role=status]")).toHaveTextContent("7-day average: 43");
    expect(button).not.toHaveAccessibleName(/7-day average: 43/);
  });

  it("does not smooth metricWindow's pre-averaged series a second time", () => {
    const result = metricWindow([{
      series: COUNTS, contextSeries: [], collectedAt: null, provisionalFrom: null, timeZoneChanges: [],
    }], 7, "sum");
    const { container } = render(<Kpi label="Signups" value={result.value} spark={result.spark} sparkPreAveragedWindow={7} format={(value) => value.toFixed(1)} />);
    fireEvent.focus(screen.getByRole("img"));
    expect(screen.getByRole("status")).toHaveTextContent("7-day average: 122.7");
    expect(screen.getByRole("status")).not.toHaveTextContent("Daily value:");
    expect(screen.getByRole("status")).not.toHaveTextContent("days reported");
    expect(screen.getByRole("img")).toHaveAccessibleDescription(/precomputed trailing 7-day average/);
    const values = result.spark.map((point) => point.v);
    const expectedY = 2 + (1 - (values.at(-1)! - Math.min(...values)) / (Math.max(...values) - Math.min(...values))) * 18;
    expect(Number(container.querySelector("[data-chart-dot]")!.getAttribute("data-y"))).toBeCloseTo(expectedY);
    fireEvent.click(screen.getByRole("button", { name: "About Signups" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Trend: 7-day average");
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects an invalid pre-averaged window %s", (window) => {
    expect(() => render(<Sparkline data={COUNTS} preAveragedWindow={window} />)).toThrow("positive integer");
  });

  // The line's method is stated once, in the cell's explanation and the
  // line's own readout, never as a caption under the number.
  it("names the rolling line in the explanation, not under the number", () => {
    const { container } = render(<Kpi label="Signups" value="859" spark={COUNTS} />);
    expect(container.querySelector("[data-spark-caption]")).toBeNull();
    expect(container.textContent).not.toContain("Trend:");
    fireEvent.focus(screen.getByRole("button", { name: "About Signups" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Trend: 7-day average");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Aug 30 – Sep 5");
  });

  it("lets a weekly headline name the daily quantity its line actually plots", () => {
    render(<Kpi label="Closed this week" value="859" spark={COUNTS} sparkAverage={false} sparkLabel="Tasks closed per day" />);
    fireEvent.click(screen.getByRole("button", { name: "About Closed this week" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Tasks closed per day · daily values");
    fireEvent.focus(screen.getByRole("img", { name: "Tasks closed per day trend" }));
    expect(within(screen.getByRole("status")).getByText("59")).toBeInTheDocument();
  });

  it("identifies monthly history without applying daily smoothing", () => {
    render(<Kpi label="Net · Aug" value="$30" sparkAverage={false} spark={[
      { t: "2026-06", v: 10 }, { t: "2026-07", v: 20 }, { t: "2026-08", v: 30 },
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: "About Net · Aug" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Trend: monthly values");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("7-day");
  });
});
