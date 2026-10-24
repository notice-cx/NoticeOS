import { describe, expect, it } from "vitest";
import { render } from "./render";
import { CumulativeCompareMetric, MetricComparisonChart, MomentumMetric, MultiMetric, NumberMetric, SparklineCompareMetric } from "@/components/wall/MetricWidgets";
import { WallMetricBinding } from "@/components/wall/WallMetricEditing";

describe("Wall metric widgets", () => {
  it("retains the explicit primary count and separate pace when a comparison changes to Number", () => {
    const view = render(<WallMetricBinding tile={{ id: "today", source: "today", display: "number", size: "standard" }} configured><SparklineCompareMetric title="Today" primary={{ value: 0 }} secondary="12% ahead" referenceFact={{ label: "vs last Fri", value: 42 }} value="12%" /></WallMetricBinding>);
    expect(view.container.querySelector(".wall-metric-value")).toHaveTextContent(/^0$/);
    expect(view.container.querySelector(".wall-metric-note")).toHaveTextContent("12% ahead");
    expect(view.container.querySelector(".wall-metric-context")).toHaveTextContent("vs last Fri 42");
    view.rerender(<WallMetricBinding tile={{ id: "today", source: "today", display: "number", size: "standard" }} configured><SparklineCompareMetric title="Today" primary={{ value: null }} secondary="12% ahead" value="12%" /></WallMetricBinding>);
    expect(view.container.querySelector(".wall-metric-value [aria-label='Unavailable']")).not.toBeNull();
  });
  it("labels a primary count and its breakdown while keeping zero distinct from unavailable", () => {
    const view = render(<MultiMetric title="Work" primary={{ label: "Closed", value: 0, tone: "positive" }} metrics={[{ label: "Open", value: 12 }, { label: "Blocked", value: null }]} />);
    const primary = view.container.querySelector(".wall-metric-primary")!;
    expect(primary.querySelector("dt")).toHaveTextContent("Closed");
    expect(primary.querySelector("dd")).toHaveTextContent("0");
    expect(primary.querySelector("[aria-label='Unavailable']")).toBeNull();
    const details = view.container.querySelectorAll(".wall-metric-facts > div");
    expect(details[0]?.querySelector("dt")).toHaveTextContent("Open");
    expect(details[0]?.querySelector("dd")).toHaveTextContent("12");
    expect(details[1]?.querySelector("dt")).toHaveTextContent("Blocked");
    expect(details[1]?.querySelector("[aria-label='Unavailable']")).toHaveTextContent("—");
    view.rerender(<MultiMetric title="Work" primary={{ label: "Closed", value: null }} metrics={[{ label: "Open", value: 0 }]} />);
    expect(view.container.querySelector(".wall-metric-primary [aria-label='Unavailable']")).toHaveTextContent("—");
    expect(view.container.querySelector(".wall-metric-facts dd")).toHaveTextContent("0");
  });
  it("shares structured cumulative facts and comparison across base and expanded layouts", () => {
    const props = { title: "Cumulative count", value: 0, unit: "closed", valueNote: "Observed today", movement: { label: "2", direction: "down" as const, tone: "positive" as const, basis: "vs last week", meaning: "Two fewer than last week" }, secondary: [{ label: "Earlier period", value: 2, note: "Complete period", dividerBefore: true, labelPosition: "below" as const }], chartProps: { current: [{ t: "2026-10-19", v: 0 }], startLabel: "Mon", endLabel: "Sun" } };
    const view = render(<CumulativeCompareMetric {...props} />);
    expect(view.container.querySelector('[data-cumulative-layout="base"] .wall-metric-summary [data-metric-movement]')).toHaveAttribute("data-tone", "positive");
    expect(view.container.querySelector("[data-metric-value]")).toHaveTextContent("0");
    expect(view.container.querySelector('[data-metric-fact="Earlier period"]')).toHaveTextContent("Complete period");
    view.rerender(<CumulativeCompareMetric {...props} expanded />);
    expect(view.container.querySelector('[data-cumulative-layout="expanded"] .wall-metric-plot [data-metric-movement]')).toHaveAccessibleName("Two fewer than last week");
    expect(view.container.querySelector('[data-metric-fact="Earlier period"]')).toHaveAttribute("data-fact-divider");
    expect(view.container.querySelector('[data-metric-fact="Earlier period"]')).toHaveAttribute("data-label-position", "below");
  });

  it("keeps lower-bound qualifiers small and separate from the observed value", () => {
    const { container } = render(<NumberMetric title="Tasks" value={3} qualifier="At least" />);
    expect(container.querySelector(".wall-metric-qualifier")).toHaveTextContent("At least");
    expect(container.querySelector(".wall-metric-value")).toHaveTextContent(/^3$/);
  });

  it("shares daily cumulative bars at both heights, with real zeros, missing days, forecast distinction and the prior-period rule", () => {
    const props = { title: "Revenue", value: 12, chartProps: { current: [{ t: "2026-10-19", v: 0 }, { t: "2026-10-20", v: null }, { t: "2026-10-21", v: 12 }], forecast: [{ t: "2026-10-21", v: 12 }, { t: "2026-10-22", v: 15 }], previousTotal: { value: 18, label: "Last month total" }, domain: { start: "2026-10-19", end: "2026-10-25" }, startLabel: "Mon", endLabel: "Sun" } };
    const view = render(<CumulativeCompareMetric {...props} />);
    const verify = () => {
      expect(view.container.querySelectorAll('[data-metric-cumulative-bar="current"]')).toHaveLength(2);
      expect(view.container.querySelectorAll('[data-metric-cumulative-bar="forecast"]')).toHaveLength(1);
      expect(view.container.querySelector('[data-metric-cumulative-bar][data-date="2026-10-19"]')).toHaveAttribute("data-value", "0");
      expect(view.container.querySelector('[data-metric-cumulative-bar][data-date="2026-10-21"]')).toHaveAttribute("data-value", "12");
      expect(view.container.querySelector('[data-metric-cumulative-bar][data-date="2026-10-20"]')).toBeNull();
      expect(view.container.querySelectorAll('[data-metric-cumulative-day="missing"]')).toHaveLength(4);
      expect(view.container.querySelector('[data-metric-previous-total] title')).toHaveTextContent("Last month total: 18");
      expect(view.container.querySelector('[role="img"]')).toHaveAccessibleName(/total reached by each day.*Filled: observed.*Outlined: forecast.*Missing days have no bar/);
      expect(view.container.querySelector('[data-chart-line="solid"]')).toBeNull();
      const actual = view.container.querySelector('[data-metric-cumulative-bar][data-date="2026-10-21"]')!;
      const lastSlot = 4 + 6.5 * 192 / 7;
      expect(Number(actual.getAttribute("x"))).toBeLessThan(lastSlot);
      expect(view.container.querySelector(".wall-metric-axis")).toHaveTextContent("MonSun");
    };
    verify();
    view.rerender(<CumulativeCompareMetric {...props} expanded />);
    verify();
  });

  it("shows isolated observations without joining a missing interval", () => {
    const { container } = render(<MetricComparisonChart label="Count" current={[{ t: "2026-10-19", v: 0 }, { t: "2026-10-20", v: null }, { t: "2026-10-21", v: 4 }]} startLabel="Mon" endLabel="Wed" />);
    expect(container.querySelectorAll("[data-chart-dot]")).toHaveLength(2);
    expect(container.querySelector("[data-chart-line='solid']")?.getAttribute("d")?.match(/M/g)).toHaveLength(2);
  });

  it("places a comparison value and its label in the shared hierarchy", () => {
    const { container } = render(<SparklineCompareMetric title="Today" value="12%" comparison="provisional" chart={<div data-site-today-chart>Matching observed minutes</div>} />);
    expect(container.querySelector(".wall-metric-comparison")).toHaveTextContent("12%");
    expect(container.querySelector(".wall-metric-note")).toHaveTextContent("provisional");
    expect(container.querySelector("[data-site-today-chart]")).toHaveTextContent("Matching observed minutes");
    expect(container.querySelector("[aria-label='Unavailable']")).toBeNull();
  });
  it("keeps unavailable facts distinct from observed zeros without reserving empty slots", () => {
    const { container } = render(<MultiMetric title="Product counts" metrics={[{ label: "Users", value: null }, { label: "Projects", value: 0 }]} />);
    expect(container.querySelectorAll("dl > div")).toHaveLength(2);
    expect(container.querySelector("[aria-label='Unavailable']")).toHaveTextContent("—");
    expect(container.querySelectorAll("dd")[1]).toHaveTextContent("0");
  });

  it("allows a falling count to carry a positive comparison independently of its direction", () => {
    const { container } = render(<NumberMetric title="Blocked" value={2} movement={{ direction: "down", label: "3 vs last Friday", tone: "positive" }} history={{ data: [{ t: "2026-10-16", v: 5 }, { t: "2026-10-23", v: 2 }], startLabel: "Last Friday", endLabel: "Now" }} />);
    expect(container.querySelector(".wall-metric-movement")).toHaveClass("text-trend-positive");
    expect(container.querySelector(".wall-metric-movement")).toHaveTextContent("↓ 3 vs last Friday");
    expect(container.querySelector("[data-chart-line='solid']")).not.toBeNull();
    expect(container.querySelector(".wall-metric-axis")).toHaveTextContent("Last FridayNow");
  });

  it("breaks current history over missing observations and distinguishes reference and forecast", () => {
    const { container } = render(<MetricComparisonChart label="Revenue" startLabel="Oct 1" endLabel="Oct 31" current={[{ t: "2026-10-01", v: 1 }, { t: "2026-10-02", v: 2 }, { t: "2026-10-03", v: null }, { t: "2026-10-04", v: 4 }, { t: "2026-10-05", v: 5 }]} reference={[{ t: "2026-10-01", v: 2 }, { t: "2026-10-02", v: 3 }]} forecast={[{ t: "2026-10-05", v: 5 }, { t: "2026-10-06", v: 6 }]} previousTotal={{ value: 9, label: "Previous month total" }} />);
    const line = container.querySelector("[data-chart-line='solid']")!;
    expect(line.getAttribute("d")?.match(/M/g)).toHaveLength(2);
    expect(container.querySelector("[data-chart-line='ghost']")).toHaveAttribute("stroke-dasharray");
    expect(container.querySelector("[data-chart-line='projection']")).toHaveAttribute("stroke-dasharray");
    expect(container.querySelector("[data-metric-previous-total] title")).toHaveTextContent("Previous month total: 9");
  });

  it("does not manufacture history from a reference total", () => {
    const { container } = render(<MetricComparisonChart label="Done" current={[{ t: "2026-10-23", v: null }]} previousTotal={{ value: 10, label: "Last week" }} startLabel="Mon" endLabel="Sun" />);
    expect(container).toHaveTextContent("History unavailable");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("keeps a Friday observation short of the end of a full Monday to Sunday domain", () => {
    const { container } = render(<MetricComparisonChart label="Done" current={[{ t: "2026-10-19", v: 2 }, { t: "2026-10-23", v: 8 }]} domain={{ start: "2026-10-19", end: "2026-10-25" }} startLabel="Mon" endLabel="Sun" />);
    expect(container.querySelector("[data-chart-dot]")).toHaveAttribute("data-x", "132");
  });

  it("highlights only the latest window and leaves missing bars empty", () => {
    const { container } = render(<MomentumMetric title="Momentum" value={0} bars={[2, null, 0, 1]} highlightLast={2} startLabel="30 min ago" endLabel="Now" />);
    expect(container.querySelectorAll("[data-metric-bar='recent']")).toHaveLength(2);
    expect(container.querySelectorAll("[data-metric-bar='missing']")).toHaveLength(1);
    expect(container.querySelector("[data-metric-bar='missing']")).toHaveStyle({ "--metric-bar-height": "0%" });
    expect(container.querySelector("[role='img']")).toHaveAccessibleName(/1 unavailable/);
    expect(container.querySelector("[data-value='0']")).toHaveAttribute("data-metric-bar", "recent");
    expect(container.querySelector("[data-metric-bar='missing']")).not.toHaveAttribute("data-value");
  });

  it("names absent or nonfinite momentum history without inventing zero bars", () => {
    const view = render(<MomentumMetric title="Momentum" value={null} bars={[]} startLabel="30 min ago" endLabel="Now" />);
    expect(view.container).toHaveTextContent("History unavailable");
    expect(view.container.querySelector("[data-metric-bar]")).toBeNull();
    view.rerender(<MomentumMetric title="Momentum" value={null} bars={[null, Number.NaN, Number.POSITIVE_INFINITY]} startLabel="30 min ago" endLabel="Now" />);
    expect(view.container).toHaveTextContent("History unavailable");
    expect(view.container.querySelector("[data-metric-bar]")).toBeNull();
  });
});
