import { fireEvent, render, screen, within, waitFor } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { periodDelta, shiftLabel } from "@shared/surface";
import type { SeriesPoint } from "@shared/wall";
import { OwnerChip } from "@/components/OwnerChip";
import { About } from "@/components/surface/About";
import { FilterBar, FilterControls, FilterFold, FilterToggle } from "@/components/surface/FilterBar";
import { HeroChart, axisLabelWidth } from "@/components/surface/HeroChart";
import { Kpi, KpiStrip } from "@/components/surface/KpiStrip";
import { ListPanel, ListRow } from "@/components/surface/ListPanel";
import { RangeSelector } from "@/components/surface/RangeSelector";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { SmallMultiple, SmallMultipleStrip } from "@/components/surface/SmallMultiple";
import { Sparkline } from "@/components/surface/Sparkline";
import { StatusBanner } from "@/components/surface/StatusBanner";

const LAST_DAY = "2026-09-05";

/** `count` consecutive days ending on `LAST_DAY`. */
function days(count: number, value: (index: number) => number): SeriesPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    t: shiftLabel(LAST_DAY, index - (count - 1)),
    v: value(index),
  }));
}

const RISING = days(56, (index) => 10 + index);
/** Twenty-eight days of one value, then twenty-eight of another — a movement
 * whose size is what is under test. */
const days28 = (value: number) => days(56, () => value).slice(0, 28);
const daysAfter28 = (value: number) => days(56, () => value).slice(28);
const FALLING = days(56, (index) => 100 - index);

function inRouter(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

/**
 * Bead `ro-ujb9.13`: at 390×844 Alerts and Tasks spent two rows of selects
 * above their first alert or task. The fold is shared: one press on a phone,
 * the page's own row on a desk. jsdom has no layout, so the rule is asserted.
 */
describe("FilterBar", () => {
  function bar(active: number) {
    return render(
      <FilterBar
        active={active}
        className="flex flex-wrap items-center gap-2"
        marks={{ "data-demo-filters": "" }}
        aside={<span data-aside>2m</span>}
      >
        <select aria-label="Severity" defaultValue="all"><option value="all">Any severity</option></select>
        <select aria-label="Kind" defaultValue="all"><option value="all">Any kind</option></select>
      </FilterBar>,
    );
  }

  it("folds the controls behind one Filters press on a phone and nowhere else", () => {
    const { container } = bar(0);
    const row = container.querySelector("[data-demo-filters]")!;
    const toggle = within(row as HTMLElement).getByRole("button", { name: "Filters" });
    // The button is a phone's only: the desk has the row itself.
    expect(toggle).toHaveClass("sm:hidden");
    const controls = row.querySelector("[data-filter-controls]")!;
    expect(controls).toHaveAttribute("data-filter-controls", "folded");
    expect(controls).toHaveClass("contents", "max-sm:hidden");
    expect(controls.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(toggle).toHaveAttribute("aria-controls", controls.id);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(controls).toHaveAttribute("data-filter-controls", "open");
    expect(controls).not.toHaveClass("max-sm:hidden");
    // The controls are still the page's own flex items (`contents`).
    expect(within(controls as HTMLElement).getAllByRole("combobox")).toHaveLength(2);
  });

  it("says how many filters are on, and keeps the aside out of the fold", () => {
    const { container } = bar(2);
    const toggle = screen.getByRole("button", { name: "Filters, 2 on" });
    expect(toggle).toHaveAttribute("data-filter-count", "2");
    expect(toggle.textContent).toContain("2");
    const aside = container.querySelector("[data-aside]")!;
    expect(aside.closest("[data-filter-controls]")).toBeNull();
    expect(aside.closest("[data-demo-filters]")).not.toBeNull();
  });

  it("lets a toggle share another row, the controls folding where they are", () => {
    const { container } = render(
      <FilterFold active={1} label="Filters & sort">
        <div data-range-row>
          <FilterToggle />
        </div>
        <FilterControls className="flex" marks={{ "data-demo": "" }}>
          <select aria-label="Sort" defaultValue="a"><option value="a">Default order</option></select>
        </FilterControls>
      </FilterFold>,
    );
    const toggle = screen.getByRole("button", { name: "Filters & sort, 1 on" });
    expect(container.querySelector("[data-range-row]")).toContainElement(toggle);
    const controls = container.querySelector("[data-demo]")!;
    expect(controls).toHaveClass("flex", "max-sm:hidden");
    fireEvent.click(toggle);
    expect(controls).not.toHaveClass("max-sm:hidden");
  });
});

describe("RangeSelector", () => {
  it("presses the selected range and hands the days back on a click", () => {
    const onChange = vi.fn();
    render(<RangeSelector value={28} onChange={onChange} />);

    expect(screen.getByRole("button", { name: "28d" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "90d" }));
    expect(onChange).toHaveBeenCalledWith(90);
  });

  it("keeps every control at the phone thumb floor (bead ro-md80)", () => {
    render(<RangeSelector value={28} onChange={() => undefined} />);
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("max-sm:min-h-11");
    }
  });
});

describe("Kpi", () => {
  it("colours a valid comparison and withdraws the delta when the measurement changed", () => {
    const { rerender } = render(
      <KpiStrip columns={1}>
        <Kpi label="Active users" value="1,234" delta={periodDelta(RISING, 28)} />
      </KpiStrip>,
    );
    expect(screen.getByLabelText(/the last 28 days/)).toHaveAttribute(
      "data-tone",
      "positive-strong",
    );

    // The reported headline remains, but an incomparable percentage must not
    // look like a measured change merely because its color is neutral.
    rerender(
      <KpiStrip columns={1}>
        <Kpi
          label="Active users"
          value="1,234"
          delta={periodDelta(RISING, 28, [
            { effectiveOn: "2026-09-01", from: "UTC", to: "America/New_York" },
          ])}
        />
      </KpiStrip>,
    );
    const withdrawn = screen.getByLabelText(/reporting timezone changed/);
    expect(withdrawn).toHaveAttribute("data-tone", "neutral");
    expect(withdrawn).toHaveTextContent("Not comparable");
    fireEvent.focus(screen.getByRole("button", { name: "About Active users" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("reporting timezone changed");
    expect(withdrawn).not.toHaveTextContent("%");
    expect(screen.getByText("1,234")).toBeVisible();
  });

  it("does not present unequal reporting coverage as huge growth", () => {
    const delta = periodDelta(days(92, (index) => index < 2 ? 1 : 100), 90)!;
    expect(delta.comparable).toBe(false);
    expect(delta.percent).toBeGreaterThan(100_000);
    const { container } = render(<Kpi label="Events" value="9,000" delta={delta} />);
    expect(screen.getByText("Not comparable")).toBeVisible();
    expect(screen.getByLabelText(/90 vs 2 days reported/)).toBeInTheDocument();
    expect(screen.getByText("9,000")).toBeVisible();
    expect(container.textContent).not.toContain("%");
    expect(container.querySelector("[data-spark]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "About Events" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("90 vs 2 days reported");
  });

  /**
   * Bead `ro-ujb9.13`. Two columns stacked a six-KPI strip three rows deep on a
   * phone — 380px of Alerts' first screen before its first alert — and three
   * KPIs left a hole in a fourth cell. The phone strip is now ONE row: three
   * side by side, four or more scrolling sideways with a cell peeking in, and
   * the desk grid is unchanged. jsdom has no layout, so the rule is asserted.
   */
  it("is one swipeable row on a phone from four KPIs, and a grid everywhere else", () => {
    const { container } = render(
      <KpiStrip columns={6}>
        <Kpi label="Open" value="1" />
        <Kpi label="Errors" value="1" />
        <Kpi label="Warnings" value="0" />
        <Kpi label="Started · 7d" value="1" />
      </KpiStrip>,
    );
    const strip = container.querySelector("[data-kpi-strip]")!;
    expect(strip).toHaveAttribute("data-phone-row", "swipe");
    const classes = strip.className.split(" ");
    for (const rule of ["max-sm:grid-flow-col", "max-sm:grid-cols-none", "max-sm:overflow-x-auto", "max-sm:snap-x", "max-sm:[&>*]:snap-start"]) {
      expect(classes).toContain(rule);
    }
    // A 44% floor makes the row swipe; intrinsic words may widen each cell.
    expect(classes).toContain("max-sm:auto-cols-[minmax(44%,max-content)]");
    // The desk keeps its grid: nothing unprefixed scrolls or flows by column.
    expect(classes).toContain("lg:grid-cols-6");
    expect(classes.filter((name) => /^(grid-flow-col|overflow-x-auto|snap-x)$/.test(name))).toEqual([]);
  });

  it("keeps three KPIs together and lets enlarged words widen their cells", () => {
    const { container } = render(
      <KpiStrip columns={3}>
        <Kpi label="Needs you" value="2" />
        <Kpi label="Open alerts" value="1" />
        <Kpi label="System" value="—" />
      </KpiStrip>,
    );
    const strip = container.querySelector("[data-kpi-strip]")!;
    expect(strip).toHaveAttribute("data-phone-row", "three");
    expect(strip.className.split(" ")).toContain("max-sm:grid-cols-[repeat(3,minmax(min-content,1fr))]");
    expect(strip.className).toContain("max-sm:overflow-x-auto");
  });

  it("keeps two KPIs side by side on a phone, and counts only the cells it draws", () => {
    const { container } = render(
      <KpiStrip columns={3}>
        <Kpi label="Open alerts" value="1" />
        {null}
        <Kpi label="System" value="—" />
      </KpiStrip>,
    );
    const strip = container.querySelector("[data-kpi-strip]")!;
    expect(strip).not.toHaveAttribute("data-phone-row");
    expect(strip.className.split(" ")).toContain("grid-cols-2");
    expect(strip.className).not.toContain("max-sm:grid-flow-col");
  });

  it("brings the selected KPI into a swiping row's view, once per selection", () => {
    const { container, rerender } = render(
      <KpiStrip columns={4}>
        {["Users", "Sessions", "Search clicks", "Impressions"].map((label) => (
          <Kpi key={label} label={label} value="1" selected={label === "Search clicks"} onSelect={() => {}} />
        ))}
      </KpiStrip>,
    );
    const strip = container.querySelector<HTMLElement>("[data-kpi-strip]")!;
    expect(container.querySelector("[data-kpi-selected]")).toHaveAttribute("data-kpi", "Search clicks");
    // jsdom has no layout, so the row is given one: 390 wide, cells 172 apart.
    Object.defineProperty(strip, "scrollWidth", { configurable: true, value: 688 });
    Object.defineProperty(strip, "clientWidth", { configurable: true, value: 358 });
    strip.getBoundingClientRect = () => ({ left: 16, width: 358 }) as DOMRect;
    const cells = [...strip.querySelectorAll<HTMLElement>("[data-kpi]")];
    cells.forEach((cell, index) => {
      cell.getBoundingClientRect = () => ({ left: 16 + index * 172 - strip.scrollLeft, width: 171 }) as DOMRect;
    });
    const rows = (selected: string) => ["Users", "Sessions", "Search clicks", "Impressions"].map((label) => (
      <Kpi key={label} label={label} value="1" selected={label === selected} onSelect={() => {}} />
    ));
    rerender(<KpiStrip columns={4}>{rows("Impressions")}</KpiStrip>);
    // The cell before it too, so the row still peeks on the right.
    expect(strip.scrollLeft).toBe(344);
    // A reader's own swipe back is not pulled forward again by a re-render.
    strip.scrollLeft = 0;
    rerender(<KpiStrip columns={4}>{rows("Impressions")}</KpiStrip>);
    expect(strip.scrollLeft).toBe(0);
  });

  it("names a fall as a fall", () => {
    render(<Kpi label="Impressions" value="43.4k" delta={periodDelta(FALLING, 28)} />);
    expect(screen.getByLabelText(/the last 28 days/)).toHaveAttribute(
      "data-tone",
      "negative-strong",
    );
  });

  it("withdraws the colour under the two-percent floor", () => {
    // 28 days at 100, then 28 at 101: real, and not a verdict.
    const barely = [...days28(100), ...daysAfter28(101)];
    render(<Kpi label="Signups" value="2,828" delta={periodDelta(barely, 28)} />);
    expect(screen.getByLabelText(/the last 28 days/)).toHaveAttribute("data-tone", "neutral");
  });

  it("colours by what is GOOD for the metric, not by which way it moved", () => {
    // Open alerts falling is the good direction (doc 21).
    render(
      <Kpi
        label="Open alerts"
        value="4"
        improvement="down"
        delta={periodDelta(FALLING, 28)}
      />,
    );
    expect(screen.getByLabelText(/the last 28 days/)).toHaveAttribute(
      "data-tone",
      "positive-strong",
    );
  });

  it("spends no colour on a metric whose direction means nothing", () => {
    render(<Kpi label="Net" value="$436" improvement="none" delta={periodDelta(RISING, 28)} />);
    expect(screen.getByLabelText(/the last 28 days/)).toHaveAttribute("data-tone", "neutral");
  });

  it("draws no sparkline for a metric with fewer than three points", () => {
    const { rerender } = render(
      <Kpi label="Signups" value="12" spark={RISING.slice(-2)} />,
    );
    expect(screen.queryByLabelText("Signups trend")).toBeNull();
    rerender(<Kpi label="Signups" value="12" spark={RISING.slice(-3)} />);
    expect(screen.getByLabelText("Signups trend")).toBeInTheDocument();
  });

  /**
   * A MONTHLY series is not smoothed over seven of anything (bead `ro-78qo.18`).
   * Seven periods of a monthly series is seven MONTHS, and Home's Net KPI —
   * six months of portfolio ledger — came out as a near-straight line with the
   * one month worth seeing averaged away. The switch draws the periods
   * themselves, and the provisional mark comes with it: the caller with a reason
   * to turn averaging off is drawing raw periods, the last of which is the one
   * still being lived in.
   */
  it("can draw a monthly spark unsmoothed, with the open period hollow", () => {
    const months = [
      { t: "2026-06", v: 40 },
      { t: "2026-07", v: 600 },
      { t: "2026-08", v: 80 },
    ];
    const { container, rerender } = render(
      <Kpi label="Net" value="$80" improvement="none" spark={months} />,
    );
    const path = () => container.querySelector("[data-chart-line]")!.getAttribute("d")!;
    // Averaged, the spike is a step nobody can see the shape of: three points
    // whose values are 40, 320 and 240 rather than 40, 600 and 80.
    const smoothed = path();

    rerender(
      <Kpi
        label="Net"
        value="$80"
        improvement="none"
        spark={months}
        sparkAverage={false}
        sparkProvisionalFrom="2026-08"
      />,
    );
    expect(path()).not.toBe(smoothed);
    // The month still being lived in is not a settled reading.
    expect(container.querySelector("[data-chart-dot]")).toHaveAttribute("data-chart-dot", "hollow");
  });

  /**
   * The third answer beside a series and a composition: the series does not
   * exist YET (bead `ro-78qo.6`). Six KPIs each printing a grey "no series"
   * placard is six identical pills saying nothing, so the honest treatment is
   * to draw nothing and declare the gap where a reader and the surface audit
   * can both find it.
   */
  it("declares a series that does not exist yet, and draws nothing in its place", () => {
    const { container } = render(
      <Kpi
        label="Ready"
        value="18"
        seriesUnavailable="the queue keeps 7 days of snapshots"
      />,
    );
    const kpi = container.querySelector('[data-kpi="Ready"]')!;
    expect(kpi.getAttribute("data-series")).toBe("unavailable");
    expect(kpi.getAttribute("data-series-reason")).toBe(
      "the queue keeps 7 days of snapshots",
    );
    // The absence IS the missing line (bead ro-ujb9.96.6.15): nothing is
    // printed under the number, and the reason is one tap away.
    expect(kpi.textContent).not.toContain("History unavailable");
    expect(kpi.textContent).not.toContain("the queue keeps 7 days of snapshots");
    fireEvent.click(screen.getByRole("button", { name: "About Ready" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("the queue keeps 7 days of snapshots");
    expect(kpi.querySelector("[data-spark]")).toBeNull();
    expect(kpi.textContent).not.toContain("no series");
  });

  it("draws the series and declares no gap when it is given both", () => {
    const { container } = render(
      <Kpi
        label="Ready"
        value="18"
        spark={RISING}
        seriesUnavailable="the queue keeps 7 days of snapshots"
      />,
    );
    const kpi = container.querySelector('[data-kpi="Ready"]')!;
    expect(kpi.querySelector("[data-spark]")).not.toBeNull();
    expect(kpi.hasAttribute("data-series")).toBe(false);
    expect(kpi.hasAttribute("data-series-reason")).toBe(false);
  });

  it("says there is no previous period rather than printing a zero", () => {
    const { container } = render(<Kpi label="Net" value="$436" delta={null} />);
    const none = container.querySelector('[data-delta="none"]')!;
    expect(none).toHaveTextContent("— No previous period");
    expect(none.hasAttribute("title")).toBe(false);
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("is a control only when it selects something", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <Kpi label="Active users" value="1,234" selected onSelect={onSelect} />,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalled();

    rerender(<Kpi label="Active users" value="1,234" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("HeroChart", () => {
  const twoProviders = [
    { name: "Google", points: RISING, tone: "primary" as const },
    { name: "Bing", points: FALLING, tone: "bing" as const },
  ];

  it("toggles a provider off and refuses to hide the last visible one", () => {
    render(<HeroChart series={twoProviders} range={28} />);
    const google = screen.getByRole("button", { name: /Google/ });
    const bing = screen.getByRole("button", { name: /Bing/ });

    fireEvent.click(bing);
    expect(bing).toHaveAttribute("aria-pressed", "false");

    // An empty plot is not a view of the data.
    fireEvent.click(google);
    expect(google).toHaveAttribute("aria-pressed", "true");
  });

  it("draws no toggles for a single series", () => {
    render(<HeroChart series={[{ name: "GA4", points: RISING }]} range={28} />);
    expect(screen.queryByRole("group", { name: "Chart series" })).toBeNull();
    expect(screen.queryByRole("button", { name: "GA4" })).toBeNull();
    // The legend keys the one line and its average; nothing needs an info icon.
    expect(screen.getByRole("list")).toHaveTextContent("GA4");
    expect(screen.getByRole("list")).toHaveTextContent("7-day average");
    expect(screen.queryByRole("button", { name: "About this chart" })).toBeNull();
  });

  it("keeps supporting chart footnotes on demand without changing point inspection", () => {
    const { container } = render(<HeroChart title="Monthly net" series={[{ name: "Net", points: RISING }]}
      range={28} footnote="This accounting window is independent of the traffic selector." />);
    expect(container.textContent).not.toContain("This accounting window");
    expect(screen.getByText("Monthly net")).toBeVisible();
    fireEvent.focus(screen.getByRole("button", { name: "About Monthly net" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("This accounting window is independent of the traffic selector.");
    fireEvent.keyDown(screen.getByRole("button", { name: "About Monthly net" }), { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(screen.getByRole("group", { name: "Explore Net values" }));
    expect(screen.getByRole("status")).toHaveTextContent("Net");
  });

  it("states the provisional tail and the annotation it drew", () => {
    render(
      <HeroChart
        series={[{ name: "GA4", points: RISING }]}
        range={28}
        provisionalFrom={LAST_DAY}
        annotations={[{ date: "2026-09-01", label: "GA4 reporting timezone changed" }]}
      />,
    );
    expect(screen.getByText("Provisional")).toBeVisible();
    fireEvent.focus(screen.getByRole("button", { name: "About this chart" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Marked periods are provisional");
    const marker = screen.getByRole("button", { name: "Event on Sep 1, 2026: GA4 reporting timezone changed" });
    expect(screen.queryByText("GA4 reporting timezone changed")).toBeNull();
    fireEvent.focus(marker);
    expect(screen.getByRole("tooltip")).toHaveTextContent("GA4 reporting timezone changed");
  });

  it("claims no average and no mark it did not draw", () => {
    render(
      <HeroChart
        series={[{ name: "Net", points: [{ t: "2026-08", v: 436 }, { t: "2026-09", v: 200 }] }]}
        range={2}
        variant="monthly"
        annotations={[{ date: "2026-01-01", label: "long before this window" }]}
      />,
    );
    expect(screen.queryByText(/7-day average/)).toBeNull();
    expect(screen.queryByText(/long before this window/)).toBeNull();
  });

  it("names its own absence rather than drawing an empty grid", () => {
    render(<HeroChart series={[]} />);
    expect(screen.getByLabelText("No series yet")).toBeInTheDocument();
  });

  /** The y tick labels, top row first, as the gutter prints them. */
  function yLabels(container: HTMLElement) {
    const gutter = container.querySelector("[data-hero-gutter]")!;
    return [...gutter.querySelectorAll("span")].map((span) => span.textContent ?? "");
  }

  it("gives the y labels a gutter wide enough to print them whole (bead ro-78qo.15)", () => {
    // 5,000 read as "000" on the full-width hero: the label column was `auto`
    // over absolutely positioned spans, so it measured nothing and the card
    // clipped the overflow.
    const { container } = render(
      <HeroChart series={[{ name: "GA4", points: days(28, () => 5_000) }]} range={28} />,
    );

    const labels = yLabels(container);
    expect(labels).toContain("5,000");
    const gutter = container.querySelector("[data-hero-gutter]")!;
    const widest = Math.max(...labels.map((label) => axisLabelWidth(label)));
    expect(Number(gutter.getAttribute("data-hero-gutter"))).toBeGreaterThanOrEqual(widest);
    expect((gutter.parentElement as HTMLElement).style.gridTemplateColumns).toBe(
      `${widest}px minmax(0,1fr)`,
    );
  });

  it("anchors the last date at the end of the plot rather than breaking it in two", () => {
    const { container } = render(
      <HeroChart series={[{ name: "GA4", points: RISING }]} range={28} />,
    );

    const last = screen.getByText("Sep 5");
    expect(last.className).toContain("whitespace-nowrap");
    // End-anchored, so there is no width to its right for it to wrap into.
    expect(last.className).toContain("end-0");
    expect(last.style.left).toBe("");
    // One text node, not "Sep" over "5".
    expect(last.childNodes).toHaveLength(1);
    // And a right gutter, so the provisional cap on the final point survives.
    const grid = container.querySelector("[data-hero-gutter]")!.parentElement as HTMLElement;
    expect(Number.parseFloat(grid.style.paddingInlineEnd)).toBeGreaterThan(0);
  });

  it("ticks a 0/1 series at whole numbers instead of printing 1 1 1 0 0", () => {
    const { container } = render(
      <HeroChart
        series={[{ name: "Open", points: days(28, (index) => (index < 20 ? 1 : 0)) }]}
        range={28}
        variant="step"
      />,
    );

    const labels = yLabels(container);
    expect(labels).toEqual(["0", "1"]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  /**
   * A SIGNED DOMAIN (bead `ro-78qo.28`). meals.example's ledger runs June at
   * −$224 and August in the black; a zero-based scale can only draw that by
   * dropping the loss-making months off the floor of the plot.
   */
  describe("a series that crosses zero", () => {
    const NET = [
      { t: "2026-06", v: -224.42 },
      { t: "2026-07", v: -69.87 },
      { t: "2026-08", v: 240.94 },
      { t: "2026-09", v: 118.3 },
    ];
    const usd = (value: number) =>
      `${value < 0 ? "−" : ""}$${Math.abs(value).toLocaleString("en-US", {
        maximumFractionDigits: 0,
      })}`;

    function signed() {
      return render(
        <HeroChart series={[{ name: "Net", points: NET }]} range={4} variant="monthly" format={usd} />,
      );
    }

    it("runs the scale from a nice-rounded bottom to a nice-rounded top, with zero on a tick", () => {
      const { container } = signed();
      const labels = yLabels(container);

      expect(labels).toEqual(["−$400", "−$200", "$0", "$200", "$400"]);
      expect(new Set(labels).size).toBe(labels.length);
    });

    it("draws every point INSIDE the plot box rather than under its floor", () => {
      const { container } = signed();
      // 240px tall by default: the box runs from PAD_TOP (10) to height minus
      // PAD_BOTTOM (234). Every y the lead path visits has to land inside it.
      const path = container.querySelector("path.fill-current")!.getAttribute("d")!;
      const ys = [...path.matchAll(/[ML]\s*[\d.]+\s+([\d.]+)/g)].map((one) => Number(one[1]));
      expect(ys.length).toBeGreaterThan(3);
      for (const y of ys) {
        expect(y).toBeGreaterThanOrEqual(10);
        expect(y).toBeLessThanOrEqual(234);
      }
      // And the two losing months are BELOW the zero line, the two earners above.
      const zero = container.querySelector("[data-hero-zero]")!;
      const zeroY = Number(zero.getAttribute("y1"));
      expect(Math.min(...ys)).toBeLessThan(zeroY);
      expect(Math.max(...ys)).toBeGreaterThan(zeroY);
    });

    it("fills the area toward the zero line, not toward the bottom of the plot", () => {
      const { container } = signed();
      const area = container.querySelector("path.fill-current")!.getAttribute("d")!;
      const zeroY = Number(container.querySelector("[data-hero-zero]")!.getAttribute("y1"));
      // The area closes on the baseline twice — once at each end of the run.
      const closing = [...area.matchAll(/L[\d.]+ ([\d.]+)/g)].map((one) => Number(one[1]));
      expect(closing.filter((y) => Math.abs(y - zeroY) < 0.01).length).toBe(2);
      expect(zeroY).toBeLessThan(234);
    });

    it("keeps a mark and the hover crosshair spanning the whole plot", () => {
      const { container } = render(
        <HeroChart
          series={[{ name: "Net", points: NET }]}
          range={4}
          variant="monthly"
          format={usd}
          annotations={[{ date: "2026-07", label: "Mediavine switched payout terms" }]}
        />,
      );
      const mark = [...container.querySelectorAll("line")].find(
        (line) => line.getAttribute("stroke-dasharray") === "3 3",
      )!;
      // Not stopped at the zero line half-way down the box.
      expect(Number(mark.getAttribute("y2"))).toBeCloseTo(234, 5);
    });

    it("leaves a positive-only series on the scale it always had", () => {
      // Zero-based, four gaps of 1,000 — the axis before this bead, asserted by
      // its labels rather than by a snapshot.
      const { container } = render(
        <HeroChart series={[{ name: "GA4", points: days(28, (index) => index * 100) }]} range={28} />,
      );
      expect(yLabels(container)).toEqual(["0", "1,000", "2,000", "3,000", "4,000"]);
      expect(container.querySelector("[data-hero-zero]")).toBeNull();
    });
  });

  it("answers a hover with the day and every visible series", () => {
    const { container } = render(<HeroChart series={twoProviders} range={28} />);
    const plot = container.querySelector('svg[role="img"]')!.parentElement!;
    fireEvent.pointerMove(plot, { clientX: 0 });
    const readout = screen.getByRole("status");
    expect(readout).toHaveTextContent("Google");
    expect(readout).toHaveTextContent("Bing");
  });

  it("uses one named key per series and matches its pattern to the line", () => {
    const { container } = render(<HeroChart series={twoProviders} range={28} average={false} />);
    for (const name of ["Google", "Bing"]) {
      expect(screen.getAllByText(name)).toHaveLength(1);
    }
    expect(container.querySelector('[data-hero-line="Google"]')).not.toHaveAttribute("stroke-dasharray");
    expect(container.querySelector('[data-hero-line="Bing"]')).toHaveAttribute("stroke-dasharray", "8 5");
    expect(screen.getByRole("button", { name: "Bing" }).querySelector("line")).toHaveAttribute("stroke-dasharray", "8 5");
  });

  it("keys every drawn mark at the weight it is drawn, in one row (ro-ujb9.12)", () => {
    const { container } = render(<HeroChart series={twoProviders} range={28} provisionalFrom={LAST_DAY} />);
    const key = screen.getByRole("list", { name: "Chart key" });
    // Two averaged series: each key is its lead line, and the method pair
    // names the bold average and the faint daily line once for both.
    expect(key).toHaveTextContent(/^Google\s*Bing\s*7-day average\s*Daily\s*Provisional$/);
    const leadWidth = container.querySelector('[data-hero-line="Google"]')!.getAttribute("stroke-width");
    expect(leadWidth).toBe("2.5");
    expect(screen.getByRole("button", { name: "Google" }).querySelector("line")).toHaveAttribute("stroke-width", leadWidth);
    const raw = container.querySelector('[data-hero-raw="Google"]')!;
    const rawKey = key.querySelector('[data-hero-key-method="raw"] line')!;
    expect(rawKey.getAttribute("stroke-width")).toBe(raw.getAttribute("stroke-width"));
    expect(rawKey.getAttribute("stroke-opacity")).toBe(raw.getAttribute("stroke-opacity"));
    // The series keys are words in ink, never the brand accent.
    expect(screen.getByRole("button", { name: "Google" }).className).not.toMatch(/text-primary|bg-accent-soft/);
    // The hollow end is keyed, and the key is where its explanation opens.
    const provisional = within(key).getByRole("button", { name: "About this chart" });
    expect(provisional).toHaveTextContent("Provisional");
    expect(provisional.querySelector("circle")).not.toBeNull();
  });

  it("names the average on the one series it smooths, so no glyph is keyed twice", () => {
    render(<HeroChart series={[{ name: "Bing", points: RISING, tone: "bing" }]} range={28} />);
    const key = screen.getByRole("list", { name: "Chart key" });
    expect(key).toHaveTextContent(/^Bing · 7-day average\s*Daily$/);
    expect(key.querySelector('[data-hero-key-method="average"]')).toBeNull();
    // The daily key wears the series' own ink.
    expect(key.querySelector('[data-hero-key-method="raw"] svg')).toHaveClass("text-search-bing");
  });

  it("draws a reference thinner, dotted, in quiet ink, and never averaged or washed", () => {
    const { container } = render(<HeroChart series={[
      { name: "GA4", points: RISING },
      { name: "Same day last week", points: FALLING, provisionalFrom: null, reference: true },
    ]} range={28} />);
    const reference = container.querySelector('[data-hero-line="Same day last week"]')!;
    expect(reference).toHaveAttribute("data-hero-weight", "reference");
    expect(reference).toHaveAttribute("stroke-width", "1.5");
    expect(reference).toHaveAttribute("stroke-dasharray", "2 5");
    expect(reference.parentElement).toHaveClass("text-spark");
    expect(container.querySelector('[data-hero-raw="Same day last week"]')).toBeNull();
    expect(container.querySelector('[data-hero-line="GA4"]')).toHaveAttribute("stroke-width", "2.5");
    // Only the lead is averaged, so its own key names the average.
    expect(screen.getByRole("button", { name: "GA4 · 7-day average" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Same day last week" }).querySelector("line")).toHaveAttribute("stroke-width", "1.5");
  });

  it("strikes a hidden series through as well as unpressing it", () => {
    render(<HeroChart series={twoProviders} range={28} />);
    const bing = screen.getByRole("button", { name: "Bing" });
    fireEvent.click(bing);
    expect(bing).toHaveAttribute("aria-pressed", "false");
    expect(bing).toHaveClass("line-through");
    expect(screen.getByRole("button", { name: "Google" })).not.toHaveClass("line-through");
  });

  it("lets a keyboard inspect exact dates and dismiss the readout", () => {
    render(<HeroChart series={[{ name: "Users", points: days(3, (index) => index + 10) }]} range={3} />);
    const plot = screen.getByRole("group", { name: "Explore Users values" });
    expect(plot).toHaveAttribute("tabindex", "0");
    fireEvent.focus(plot);
    expect(screen.getByRole("status")).toHaveTextContent("Sep 5");
    expect(screen.getByRole("status")).toHaveTextContent("12");
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    expect(screen.getByRole("status")).toHaveTextContent("Sep 4");
    fireEvent.keyDown(plot, { key: "Home" });
    expect(screen.getByRole("status")).toHaveTextContent("Sep 3");
    fireEvent.keyDown(plot, { key: "End" });
    expect(screen.getByRole("status")).toHaveTextContent("Sep 5");
    fireEvent.keyDown(plot, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("opens a touch/keyboard data table with gaps and provisional/annotation context", async () => {
    render(<HeroChart series={[{ name: "Users", points: [
      { t: "2026-09-03", v: 10 }, { t: "2026-09-05", v: 12 },
    ] }]} range={3} provisionalFrom="2026-09-05"
      annotations={[{ date: "2026-09-03", label: "Reporting timezone changed" }]} />);
    const summary = screen.getByText("View data · 3 days");
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(summary);
    await waitFor(() => expect(screen.getByRole("table")).toBeVisible());
    const table = screen.getByRole("table");
    expect(within(table).getByText("Not reported")).toBeVisible();
    expect(within(table).getByRole("cell", { name: "12 · Provisional" })).toBeVisible();
    expect(within(table).getByText("Reporting timezone changed")).toBeVisible();
    expect(within(table).getByRole("rowheader", { name: "Sep 3, 2026" })).toBeVisible();
    fireEvent.keyDown(table, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
    expect(summary).toHaveFocus();
  });

  it("reveals values on a pointer press without requiring hover", () => {
    render(<HeroChart series={twoProviders} range={28} />);
    const plot = screen.getByRole("group", { name: /Explore Google/ });
    fireEvent.pointerDown(plot, { pointerType: "touch", clientX: 0 });
    // Pointer press focuses the plot; focus must preserve the tapped date.
    fireEvent.focus(plot);
    expect(screen.getByRole("status")).toHaveTextContent("Google");
    expect(screen.getByRole("status")).toHaveTextContent("Bing");
    expect(screen.getByRole("status")).toHaveTextContent("Aug 9");
  });
});

describe("Sparkline", () => {
  /**
   * The empty state is ONE GLYPH (bead `ro-78qo.24`). The words "no series" on
   * a pill wrapped to two lines inside the 64×22 box the `kpi` size fixes with
   * an inline width, which no call site could widen.
   */
  it("draws a dash whose reason opens from a key or a tap, rather than a label that wraps", () => {
    const { container } = render(
      <Sparkline
        data={[]}
        ariaLabel="Active users trend"
        emptyReason="GA4 has reported nothing for this asset yet"
        data-spark=""
      />,
    );
    const box = container.querySelector<HTMLElement>("[data-spark]")!;
    // One glyph, at caption size, on one line at 64px — no words to break.
    expect(box.textContent).toBe("—");
    expect(box.className).toContain("whitespace-nowrap");
    expect(box.className).toContain("text-xs");
    expect(box.className).not.toContain("bg-muted");
    expect(box.style.width).toBe("64px");
    // The reason is not a hover-only title (ro-ujb9.14): the dash is a control
    // a keyboard reaches and a tap opens, named with the reason.
    expect(container.querySelector("[title]")).toBeNull();
    const dash = screen.getByRole("button", { name: "Active users trend: GA4 has reported nothing for this asset yet" });
    fireEvent.focus(dash);
    expect(screen.getByRole("tooltip")).toHaveTextContent("GA4 has reported nothing for this asset yet");
    fireEvent.keyDown(dash, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(dash);
    expect(screen.getByRole("tooltip")).toBeVisible();
  });

  it("stays a plain dash inside a control that already states the gap", () => {
    render(<Sparkline data={[]} ariaHidden ariaLabel="Users trend" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the declared box at every size, so a strip does not jump", () => {
    const { container } = render(
      <>
        <Sparkline data={[]} ariaLabel="kpi" />
        <Sparkline data={[]} size="cell" ariaLabel="cell" />
        <Sparkline data={[]} size="wide" ariaLabel="wide" />
      </>,
    );
    const boxes = [...container.querySelectorAll("span")].map((span) => ({
      width: span.style.width,
      height: span.style.height,
      text: span.textContent,
    }));
    expect(boxes).toEqual([
      { width: "64px", height: "22px", text: "—" },
      { width: "96px", height: "24px", text: "—" },
      // The wide form has no declared width — it takes its cell's.
      { width: "", height: "30px", text: "—" },
    ]);
  });

  it("caps a provisional endpoint hollow and a settled one solid (bead ro-y91)", () => {
    const { container, rerender } = render(
      <Sparkline data={days(28, (index) => index)} provisionalFrom={LAST_DAY} />,
    );
    expect(container.querySelector("[data-chart-dot]")).toHaveAttribute("data-chart-dot", "hollow");

    rerender(<Sparkline data={days(28, (index) => index)} />);
    expect(container.querySelector("[data-chart-dot]")).toHaveAttribute("data-chart-dot", "solid");
  });

  /**
   * HOLES (bead `ro-78qo.37`). A ledger month nobody booked is missing from the
   * payload, and a line that simply joins the months it was handed draws March
   * beside July as though they were consecutive.
   */
  describe("a series with holes in it", () => {
    const FOUR = [
      { t: "2026-09-02", v: 0 },
      { t: "2026-09-03", v: 1 },
      { t: "2026-09-04", v: 2 },
      { t: "2026-09-05", v: 3 },
    ];
    const paths = (container: HTMLElement) =>
      [...container.querySelectorAll("[data-chart-area], [data-chart-line]")].map((path) => path.getAttribute("d"));

    it("draws a series with no holes as one smooth run through every reading", () => {
      // The geometry spelled out rather than snapshotted: 64×22, four points,
      // 20px apart, over a domain of 0 to 3. The line is a monotone curve
      // (bead ro-trai.19) through each reading; on a straight run its control
      // points lie on the line, so it draws exactly the straight line it did.
      const { container } = render(<Sparkline data={FOUR} average={false} area />);
      const line = "M2 20 C8.67 18 15.33 16 22 14 C28.67 12 35.33 10 42 8 C48.67 6 55.33 4 62 2";
      expect(paths(container)).toEqual([`${line} L62 22 L2 22 Z`, line]);
    });

    it("breaks the line over a hole instead of spanning it", () => {
      const withHole = [FOUR[0]!, FOUR[1]!, { t: "2026-09-04", v: null }, FOUR[3]!];
      const { container } = render(<Sparkline data={withHole} average={false} />);
      const [line] = paths(container);

      // Two subpaths, and no segment from the 3rd to the 4th period.
      expect(line).toBe("M2 20 L22 14 M62 2");
    });

    it("caps the last READING when the series ends in a hole", () => {
      const trailing = [FOUR[0]!, FOUR[1]!, FOUR[2]!, { t: "2026-09-05", v: null }];
      const { container } = render(<Sparkline data={trailing} average={false} />);
      expect(container.querySelector("[data-chart-dot]")!.getAttribute("data-x")).toBe("42");
    });

    it("says a dash for the hole under the pointer, never a zero", () => {
      const withHole = [FOUR[0]!, { t: "2026-09-03", v: null }, FOUR[2]!, FOUR[3]!];
      const { container } = render(<Sparkline data={withHole} average={false} readout />);
      fireEvent.pointerMove(container.querySelector("svg")!, { clientX: 0 });
      // jsdom has no layout, so the pointer lands on the first index; move to
      // the hole by asserting the readout renders a dash for it.
      const { container: second } = render(
        <Sparkline data={[{ t: "2026-09-03", v: null }, FOUR[2]!]} average={false} readout />,
      );
      fireEvent.pointerMove(second.querySelector("svg")!, { clientX: 0 });
      expect(second.querySelector("[role=status]")!.textContent).toContain("—");
    });

    it("is the same answer as no series at all when every period is a hole", () => {
      render(
        <Sparkline
          data={[
            { t: "2026-09-04", v: null },
            { t: "2026-09-05", v: null },
          ]}
          ariaLabel="Net trend"
        />,
      );
      expect(screen.getByLabelText("Net trend: No series yet").textContent).toBe("—");
    });
  });

  it("reads out the day under the pointer only when asked to", () => {
    const { rerender } = render(<Sparkline data={days(28, (index) => index)} readout />);
    fireEvent.pointerMove(screen.getByRole("img"), { clientX: 0 });
    expect(screen.getByRole("status")).toBeInTheDocument();

    rerender(<Sparkline data={days(28, (index) => index)} />);
    fireEvent.pointerMove(screen.getByRole("img"), { clientX: 0 });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers dated spark values by keyboard and pointer press", () => {
    render(<Sparkline data={days(3, (index) => index + 10)} readout ariaLabel="Users trend" />);
    const spark = screen.getByRole("img", { name: "Users trend" });
    expect(spark).toHaveAttribute("tabindex", "0");
    fireEvent.focus(spark);
    expect(screen.getByRole("status")).toHaveTextContent("Sep 5");
    fireEvent.keyDown(spark, { key: "ArrowLeft" });
    expect(screen.getByRole("status")).toHaveTextContent("Sep 4");
    fireEvent.keyDown(spark, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.pointerDown(spark, { pointerType: "touch", clientX: 0 });
    expect(screen.getByRole("status")).toHaveTextContent("Sep 3");
  });

  it("does not put a second focus target inside a KPI selection button", () => {
    const { container } = render(<Kpi label="Users" value="12" spark={RISING} onSelect={() => undefined} />);
    expect(container.querySelector("button svg")).not.toHaveAttribute("tabindex");
  });
});

describe("SectionLabel", () => {
  it("draws the eyebrow, its one caption and its link out", () => {
    inRouter(
      <SectionLabel
        title="Search"
        caption="Google and Bing added, one line each"
        action={{ to: "/assets/meals.example/search", label: "Queries and pages →" }}
      />,
    );

    const eyebrow = screen.getByRole("heading", { level: 2, name: "Search" });
    // Doc 21's eyebrow: 11px, tracked 0.08em, uppercase, muted.
    expect(eyebrow.className).toContain("text-[11px]");
    expect(eyebrow.className).toContain("tracking-[0.08em]");
    expect(eyebrow.className).toContain("uppercase");
    expect(eyebrow.className).toContain("text-muted-foreground");
    expect(screen.getByText("Google and Bing added, one line each")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Queries and pages →" })).toHaveAttribute(
      "href",
      "/assets/meals.example/search",
    );
  });

  it("draws nothing it was not given", () => {
    const { container } = inRouter(<SectionLabel title="Product use" />);
    expect(container.querySelectorAll("span")).toHaveLength(0);
    expect(screen.queryByRole("link")).toBeNull();
  });

  /**
   * The header a DISCLOSURE opens with (bead `ro-78qo.39`). `SectionLabel`
   * never renders a `<summary>`: the press target, its focus ring and its
   * marker belong to the caller, so the two concerns stay where they are and
   * the type is still drawn in one place.
   */
  it("renders no control of its own, so a summary can wrap it", () => {
    const { container } = inRouter(<SectionLabel title="Tracked queries" caption="29" />);
    expect(container.querySelector("summary")).toBeNull();
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  /** Doc 21 keeps owner chips to Settings and Sources — and that is where the
   * end of an eyebrow row holds something that is not a link. */
  it("takes a node at the end of the row for what is not a link", () => {
    inRouter(
      <SectionLabel title="Identity">
        <OwnerChip path="db · assets row" />
      </SectionLabel>,
    );
    expect(screen.getByRole("button", { name: /assets row/ })).toBeInTheDocument();
  });

  it("puts its id on the heading, which is what a section labels itself by", () => {
    const { container } = inRouter(<SectionLabel id="product-use" title="Product use" />);
    expect(container.querySelector("#product-use")!.tagName).toBe("H2");
  });

  it("claims the phone's 44px target rather than adding it to the row", () => {
    // A 44px eyebrow row on the DESK is the page cost bead `ro-9smi` went to
    // lengths to avoid: the floor is a phone rule, and the height comes back to
    // the layout through the negative margin.
    inRouter(<SectionLabel title="Assets" action={{ to: "/assets", label: "All assets →" }} />);
    const link = screen.getByRole("link", { name: "All assets →" });
    expect(link.className).toContain("max-sm:min-h-11");
    expect(link.className).toContain("max-sm:-my-2.5");
    expect(link.className).not.toContain(" min-h-11");
  });
});

describe("SmallMultiple", () => {
  it("draws the figure, what it is against, and its shape", () => {
    render(
      <SmallMultipleStrip columns={2}>
        <SmallMultiple
          label="Signups"
          value={59}
          secondary="avg 122 / day"
          spark={days(28, (index) => index)}
        />
        <SmallMultiple label="Top 3" value={6} />
      </SmallMultipleStrip>,
    );
    expect(screen.getByText("avg 122 / day")).toBeInTheDocument();
    expect(screen.getByLabelText("Signups trend")).toBeInTheDocument();
    // A cell with no series draws none, rather than an empty box.
    expect(screen.queryByLabelText("Top 3 trend")).toBeNull();
  });
});

describe("ListPanel", () => {
  function panel() {
    return inRouter(
      <ListPanel title="Needs you" count="10 urgent · 67 open" action={{ label: "All tasks", to: "/work" }}>
        <ListRow tone="error" title="First" value="3d" valueLabel="open" />
        <ListRow tone="warn" title="Second" />
        <ListRow tone="info" title="Third" />
        <ListRow tone="ok" title="Fourth" />
        <ListRow tone="info" title="Fifth">
          The evidence for the fifth row.
        </ListRow>
      </ListPanel>,
    );
  }

  it("shows three rows and discloses the rest rather than dropping them", () => {
    panel();
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.queryByText("Fourth")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(screen.getByText("Fourth")).toBeInTheDocument();
    expect(screen.getByText("Fifth")).toBeInTheDocument();
  });

  it("groups rows under their shared subject: closed, the first row of each of the first three groups", () => {
    const row = (title: string) => <ListRow key={title} tone="warn" title={title} />;
    const { container } = inRouter(
      <ListPanel
        title="Where it breaks"
        groups={[
          { key: "a", title: "/calculator", count: "3 found", rows: [row("Chrome OS"), row("age input"), row("TypeError")] },
          { key: "b", title: "/", count: "1 found", rows: [row("Script error")] },
          { key: "c", title: "/my", count: "1 found", rows: [row("m.default")] },
          { key: "d", title: "Whole site", count: "1 found", rows: [row("fires twice")] },
        ]}
      />,
    );
    // The subject is a heading, said once, with its count read as words.
    expect(screen.getByRole("heading", { name: "/calculator 3 found" })).toBeInTheDocument();
    expect(screen.getByText("Chrome OS")).toBeInTheDocument();
    expect(screen.queryByText("age input")).toBeNull();
    expect(screen.getByText("Script error")).toBeInTheDocument();
    expect(screen.getByText("m.default")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Whole site/ })).toBeNull();
    expect(container.querySelectorAll("[data-list-group]")).toHaveLength(3);

    // The expander names every row the closed panel did not show, and opens
    // them in place, inside their groups.
    fireEvent.click(screen.getByRole("button", { name: "Show 3 more" }));
    expect(screen.getByText("age input")).toBeInTheDocument();
    expect(screen.getByText("fires twice")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-list-group]")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(screen.queryByText("age input")).toBeNull();
  });

  /**
   * Bead `ro-ujb9.13`. On a phone there is no hover to find out by, so a row's
   * last mark is the only way to know what a press does: › opens a page (the
   * disclosure indicator; it was an ↗, which reads as "leaves the product"),
   * ⌄ opens the row in place, and a row that does nothing has neither mark and
   * no hover ground.
   */
  it("says what a press does with its last mark, and a static row says nothing", () => {
    const { container } = inRouter(
      <ListPanel title="Waiting on you">
        <ListRow title="Opens" to="/tasks/jt-1" />
        <ListRow title="Expands">The evidence.</ListRow>
        <ListRow title="Static" />
      </ListPanel>,
    );
    const [opens, expands, still] = [...container.querySelectorAll("li")];
    expect(opens!.querySelector('[data-row-affordance="open"]')).toHaveClass("lucide-chevron-right");
    expect(opens!.querySelector(".lucide-arrow-up-right")).toBeNull();
    expect(within(opens!).getByRole("link", { name: /Opens/ })).toHaveAttribute("href", "/tasks/jt-1");
    expect(expands!.querySelector('[data-row-affordance="expand"]')).toHaveClass("lucide-chevron-down");
    expect(within(expands!).getByRole("button", { name: /Expands/ })).toHaveAttribute("aria-expanded", "false");
    expect(still!.querySelector("[data-row-affordance]")).toBeNull();
    expect(within(still!).queryByRole("button")).toBeNull();
    expect(within(still!).queryByRole("link")).toBeNull();
    expect(still!.innerHTML).not.toContain("hover:");
  });

  it("expands a row in place, and only a row with evidence behind it", () => {
    panel();
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));

    const withEvidence = screen.getByRole("button", { name: /Fifth/ });
    expect(withEvidence).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(withEvidence);
    expect(screen.getByText("The evidence for the fifth row.")).toBeInTheDocument();

    // A row with nothing behind it is not a button at all.
    expect(screen.queryByRole("button", { name: /First/ })).toBeNull();
  });

  /**
   * Bead `ro-78qo.40`. A mark that describes the ROW has to sit on the row: on a
   * child it claims a smaller subtree than it means, and the materiality suite
   * and `pnpm surface:audit` both read these by selector.
   */
  it("spreads a caller's data marks onto the row itself", () => {
    const { container } = inRouter(
      <ListPanel title="Needs you">
        <ListRow
          title="Marked"
          marks={{
            "data-flag-severity": "error",
            "data-material-condition": "open-flags rollback-failure",
          }}
        />
      </ListPanel>,
    );

    const row = container.querySelector("li[data-flag-severity='error']");
    expect(row).not.toBeNull();
    // The whole row, not the line inside it.
    expect(row!.tagName).toBe("LI");
    expect(row!.textContent).toContain("Marked");
    // A space-separated condition list still matches the `~=` the materiality
    // suite selects with.
    expect(
      container.querySelector('li[data-material-condition~="rollback-failure"]'),
    ).toBe(row);
  });

  /**
   * Beads `ro-ujb9.96.7.11` and `ro-ujb9.96.7.5`. A row's one decision sits on
   * the row — an inbox Approve, a source's Connect — BESIDE the row's own
   * press, never inside it, so pressing it neither opens the row nor is lost
   * inside another control.
   */
  it("puts the row's one action beside its press, never inside it", () => {
    const connect = vi.fn();
    const { container } = inRouter(
      <ListPanel title="Data sources">
        <ListRow title="Bing Webmaster Tools" rowActions={<button type="button" onClick={connect}>Connect</button>}>
          The row's own settings.
        </ListRow>
      </ListPanel>,
    );
    const press = screen.getByRole("button", { name: /Bing Webmaster Tools/ });
    const action = screen.getByRole("button", { name: "Connect" });
    expect(press.contains(action)).toBe(false);
    expect(action.closest("[data-list-row-actions]")).not.toBeNull();
    fireEvent.click(action);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(press).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(press);
    expect(press).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector("[data-list-row-body]")?.textContent).toContain("The row's own settings.");
  });

  /**
   * Bead `ro-ujb9.79`. The opened body was an implicit grid column, which sizes
   * to its widest child's min-content: one unbreakable doc reference stretched
   * every paragraph in the row and pushed a 390px Sources tab 285px wide.
   */
  it("holds an opened row's evidence to the row's own width", () => {
    const { container } = panel();
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    fireEvent.click(screen.getByRole("button", { name: /Fifth/ }));

    const body = container.querySelector("[data-list-row-body]")!;
    expect(body.textContent).toContain("The evidence for the fifth row.");
    expect(body.className).toContain("grid-cols-[minmax(0,1fr)]");
    // Phone only: a desk-width row keeps its exact layout.
    expect(body.className.split(" ")).toContain("max-sm:wrap-anywhere");
  });

  it("carries the mark in a glyph as well as a colour (doc 14)", () => {
    panel();
    const first = screen.getByText("First").closest("li")!;
    expect(within(first).getByText("!")).toBeInTheDocument();
  });

  /**
   * ONE EYEBROW IN THE PRODUCT (bead `ro-78qo.33`). The panel's header used to
   * draw the same title, count and link that `SectionLabel` draws — so the test
   * is that the two are now the same markup, not that they look alike.
   */
  it("draws its header through SectionLabel", () => {
    const panel = inRouter(
      <ListPanel title="Needs you" count="10 urgent · 67 open" action={{ label: "All tasks", to: "/work" }} />,
    );
    const header = panel.container.querySelector("section")!.firstElementChild!;

    const label = inRouter(
      <SectionLabel
        title="Needs you"
        caption="10 urgent · 67 open"
        action={{ label: "All tasks →", to: "/work" }}
        className="px-4 pb-2 pt-3"
      />,
    );

    expect(header.outerHTML).toBe(label.container.firstElementChild!.outerHTML);
  });

  it("says it is empty in its own words", () => {
    inRouter(<ListPanel title="Nothing waiting" empty="No open work on this asset." />);
    expect(screen.getByText("No open work on this asset.")).toBeInTheDocument();
  });
});

describe("StatusBanner", () => {
  it("disappears when its state closes", () => {
    const { container, rerender } = inRouter(
      <StatusBanner lead="Setting up" subject="asset-setup:example.com" ring={{ done: 3, total: 4, title: "3 of 4 done" }}>
        Two sources still need setting up.
      </StatusBanner>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Setting up");
    // The subject it is about, for the flow gate's one status per subject (bead ro-ujb9.96.10).
    expect(screen.getByRole("status")).toHaveAttribute("data-status-for", "asset-setup:example.com");

    rerender(
      <MemoryRouter>
        <StatusBanner open={false} lead="Setting up" subject="asset-setup:example.com" />
      </MemoryRouter>,
    );
    expect(container.querySelector("[role=status]")).toBeNull();
  });
});

describe("the audit contract", () => {
  /** Every surface component that has anything to mark or press, in one tree —
   * which is how `pnpm surface:audit` meets them on a real route. */
  function everySurface() {
    return inRouter(
      <>
        <SectionLabel
          title="Audience"
          caption="Google Analytics, daily"
          action={{ label: "Growth →", to: "/assets/meals.example/growth" }}
        />
        <KpiStrip columns={2}>
          <Kpi label="Active users" value="1,234" spark={RISING} onSelect={() => undefined} />
          <Kpi label="Impressions" value="43.4k" spark={FALLING} />
        </KpiStrip>
        <HeroChart
          series={[
            { name: "Google", points: RISING, tone: "primary" },
            { name: "Bing", points: FALLING, tone: "bing" },
          ]}
          range={28}
        />
        <RangeSelector value={28} onChange={() => undefined} />
        <SmallMultipleStrip columns={2}>
          <SmallMultiple label="Signups" value={59} spark={RISING} />
        </SmallMultipleStrip>
        <Sparkline data={RISING} data-spark="" />
        <ListPanel
          title="Needs you"
          action={{ label: "All tasks", to: "/work" }}
        >
          <ListRow tone="error" title="First" />
          <ListRow tone="warn" title="Second" />
          <ListRow tone="info" title="Third" />
          <ListRow tone="ok" title="Fourth" />
        </ListPanel>
        <StatusBanner lead="Setting up" subject="asset-setup:example.com" action={{ label: "Finish", to: "/settings" }}>
          Two sources still need setting up.
        </StatusBanner>
        <About>What the numbers are.</About>
        <OwnerChip path="config/constants.json" />
      </>,
    );
  }

  it("renders the six marks the audit looks for", () => {
    const { container } = everySurface();
    for (const mark of [
      "[data-kpi-strip]",
      "[data-kpi]",
      "[data-spark]",
      "[data-hero-chart]",
      "[data-about]",
      "[data-owner-chip]",
    ]) {
      expect(container.querySelector(mark), mark).not.toBeNull();
    }
  });

  it("names the KPI in its own mark, so an offence can be reported by metric", () => {
    // Before bead ro-78qo.1 the mark was empty and the audit could only quote
    // the element's text — value, delta and caption — back at the operator.
    const { container } = everySurface();
    const marks = [...container.querySelectorAll("[data-kpi]")].map((node) =>
      node.getAttribute("data-kpi"),
    );
    expect(marks).toEqual(["Active users", "Impressions"]);
  });

  /**
   * The chip-on-a-view-surface rule is the one offence whose report is useless
   * without the value (bead `ro-78qo.21`): a failure that says only "a chip is
   * on this page" leaves the operator hunting by eye across the eighteen on
   * /settings.
   */
  it("names the owning path in the chip's own mark", () => {
    const { container } = everySurface();
    expect(container.querySelector("[data-owner-chip]")!.getAttribute("data-owner-chip")).toBe(
      "config/constants.json",
    );
  });

  it("keeps every pressable control at the phone thumb floor (bead ro-md80)", () => {
    const { container } = everySurface();
    const pressable = [...container.querySelectorAll("button, summary, a[href]")];
    expect(pressable.length).toBeGreaterThan(6);
    for (const control of pressable) {
      expect(control.className, control.textContent ?? "").toContain("max-sm:min-h-11");
    }
  });
});

describe("About", () => {
  it("is closed by default and opens only when asked", () => {
    const { rerender } = render(<About>What the numbers are.</About>);
    expect(screen.getByText("About these numbers").closest("details")).not.toHaveAttribute("open");

    rerender(<About defaultOpen>What the numbers are.</About>);
    expect(screen.getByText("About these numbers").closest("details")).toHaveAttribute("open");
  });
});
