// The Wall's revenue and Needs attention widgets, drawn from the synthetic Wall fixture.

import { readFileSync } from "node:fs";
import path from "node:path";
import { render, within } from "./render";
import { describe, expect, it, vi } from "vitest";
import { NO_READS } from "@shared/connection-status";
import type { WallPayload } from "@shared/wall";
import type { WallLayout } from "@shared/wall-layout";
import { WallCanvas } from "@/components/WallCanvas";
import { NeedsYou } from "@/components/wall/NeedsYou";
import {
  RevenueHero,
  chartLabelsPlace,
  crossingLabelPlace,
  crossingPlaceName,
  previousLabelPlace,
  type Box,
  type ChartLabelScene,
  type CrossingPlacement,
  type CrossingScene,
  type PreviousPlacement,
} from "@/components/wall/RevenueHero";
import { wallIssues } from "@/lib/wall-issues";
import { WALL_FIXTURE_NOW, wallFixturePayload } from "../e2e/wall-fixture";

const NOW = Date.parse(WALL_FIXTURE_NOW);
const ZERO = { currency: 'USD', revenue: 0, cost: 0, net: 0 };

describe("the revenue widget", () => {
  it("leads with the month's revenue, where it lands, and the month against last month", () => {
    const data = wallFixturePayload();
    const { container } = render(<RevenueHero portfolio={data.portfolio} assets={data.assets} nowMs={NOW} />);
    const section = container.querySelector("[data-wall-revenue='pace']")!;
    expect(section).not.toBeNull();
    // No height of its own: the tile is as tall as its text, and in the TV's
    // layout the chart is a layer behind that text, ending above the dates.
    // On a phone it is a box under the figures.
    expect(section.className).not.toMatch(/\bh-/);
    expect(section).toHaveClass("relative", "isolate", "tv:text-shadow-knockout");
    expect(section.querySelector("[data-month-chart]")).toHaveClass("h-40", "tv:contents");
    expect(section.querySelector("[data-month-chart] [role='img']")).toHaveClass("tv:absolute", "tv:inset-x-0", "tv:top-0", "tv:bottom-wall-month-axis", "tv:-z-10");
    expect(within(section as HTMLElement).getByRole("heading").textContent).toBe("September revenue · estimated");
    expect(section.querySelector("[data-revenue-figure]")?.textContent).toBe("$1,185");
    // Plume Studio $1,310 + Mosaic Finder $385, the two ready projections.
    expect(section.querySelector("[data-revenue-pace]")?.textContent).toContain("on pace for $1,695");
    // Yesterday in place of the month's daily average: Plume Studio $43.18
    // + Mosaic Finder $12.07, both reports in.
    expect(section.querySelector("[data-revenue-pace]")?.textContent).toContain("Sep 21 · Pacific $55.25 est. · 9 days left");
    expect(section.textContent).not.toContain("a day");
    expect(section.querySelector("[data-revenue-yesterday]")?.getAttribute("data-revenue-yesterday")).toBe("all");
    // The change against last month is a projection, so it is neutral ink.
    const change = section.querySelector("[data-revenue-change]")!;
    expect(change.textContent).toBe("16% above Aug");
    expect(change.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("neutral");
    // Last month's total, the pace, and the day the month passes it.
    expect(section.querySelector("[data-previous-total]")).not.toBeNull();
    expect(section.querySelector("[data-month-actual]")).not.toBeNull();
    expect(section.querySelector("[data-month-pace]")).not.toBeNull();
    expect(section.querySelector("[data-month-crossing]")?.getAttribute("data-month-crossing")).toBe("projected");
    expect(section.querySelector("[data-month-crossing-label]")?.textContent).toBe("on pace to pass August on Sep 26");
    expect(section.textContent).toContain("August total $1,458");
  });

  it("says \"so far\" in place of \"est.\" and \"estimated\" in the business words, and nothing else changes", () => {
    const data = wallFixturePayload();
    const draw = (wordLevel?: "business" | "operational" | "technical") => {
      const { container, unmount } = render(<RevenueHero portfolio={data.portfolio} assets={data.assets} nowMs={NOW} wordLevel={wordLevel} />);
      const section = container.querySelector<HTMLElement>("[data-wall-revenue]")!;
      const words = {
        heading: within(section).getByRole("heading").textContent,
        yesterday: section.querySelector("[data-revenue-yesterday]")?.textContent,
        text: section.textContent,
      };
      unmount();
      return words;
    };
    const business = draw("business");
    expect(business.heading).toBe("September revenue");
    expect(business.yesterday).toBe("Sep 21 · Pacific $55.25 so far");
    expect(business.text).not.toMatch(/est\.|estimated/i);
    // The product and Everything words are the widget's own, unchanged.
    for (const level of [undefined, "operational", "technical"] as const) {
      expect(draw(level)).toEqual({
        heading: "September revenue · estimated",
        yesterday: "Sep 21 · Pacific $55.25 est.",
        text: business.text!.replace("September revenue", "September revenue · estimated").replace("$55.25 so far", "$55.25 est."),
      });
    }
  });

  it.each([
    [2, "50% below Aug"],
    [0.5, "100% above Aug"],
    [1, "0% level with Aug"],
  ] as const)("states a projection's direction against last month at ratio %s without a performance color", (previousFactor, label) => {
    const data = wallFixturePayload();
    const asset = data.assets.find((asset) => asset.revenueProjection?.status === "ready")!;
    const projection = asset.revenueProjection!;
    const { container } = render(<RevenueHero portfolio={data.portfolio} assets={[{
      ...asset,
      revenueProjection: { ...projection, previousMonthMinor: projection.projectedMinor! * previousFactor },
    }]} nowMs={NOW} />);
    const change = container.querySelector("[data-revenue-change]")!;
    expect(change.textContent).toBe(label);
    expect(change.querySelector("[data-tone]")).toHaveAttribute("data-tone", "neutral");
    expect(change.querySelector("[data-tone]")).toHaveAccessibleName(`Projected revenue ${label} total`);
  });

  it("gives no comparison verdict without a complete prior revenue month", () => {
    const data = wallFixturePayload();
    const asset = data.assets.find((asset) => asset.revenueProjection?.status === "ready")!;
    const { container } = render(<RevenueHero portfolio={data.portfolio} assets={[{
      ...asset, revenueProjection: { ...asset.revenueProjection!, previousMonthMinor: null },
    }]} nowMs={NOW} />);
    expect(container.querySelector("[data-revenue-pace]")).not.toBeNull();
    expect(container.querySelector("[data-revenue-change]")).toBeNull();
  });

  it("reads the same for an installation with one site", () => {
    const data = wallFixturePayload();
    const [only] = data.assets;
    const { container } = render(
      <RevenueHero
        portfolio={{ ...data.portfolio, forecast: { currency: 'USD', revenue: 924, cost: 0, net: 924 } }}
        assets={[only!]}
        nowMs={NOW}
      />,
    );
    // The one site's own projection: $924 so far, $1,310 at the month's end.
    expect(container.querySelector("[data-revenue-figure]")?.textContent).toBe("$924");
    expect(container.querySelector("[data-revenue-pace]")?.textContent).toContain("on pace for $1,310");
    // One site's yesterday is never "1 of 1".
    expect(container.querySelector("[data-revenue-yesterday]")?.textContent).toBe("Sep 21 · Pacific $43.18 est.");
    expect(container.querySelector("[data-month-crossing-label]")?.textContent).toMatch(/^on pace to pass August on Sep \d+$/);
  });

  it("says there is no revenue source in one line, with no chart", () => {
    const data = wallFixturePayload();
    const { container } = render(
      <RevenueHero
        portfolio={{ ...data.portfolio, forecast: ZERO, booked: ZERO, netTrend: [], firstRun: true }}
        assets={data.assets.map((asset) => ({ ...asset, revenueProjection: undefined }))}
      />,
    );
    const section = container.querySelector("[data-wall-revenue='none']")!;
    expect(section.textContent).toBe("No revenue source");
    expect(section.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("[data-month-chart]")).toBeNull();
  });
});

// Yesterday's revenue in the pace line: missing is not zero.
describe("yesterday on the revenue widget", () => {
  const withYesterday = (amounts: (number | null)[]) => {
    const data = wallFixturePayload();
    let next = 0;
    return {
      portfolio: data.portfolio,
      assets: data.assets.map((asset) =>
        asset.dailyRevenue ? { ...asset, dailyRevenue: { ...asset.dailyRevenue, amountMinor: amounts[next++] ?? null } } : asset,
      ),
    };
  };

  it("shows what is in and how many revenue sites it covers when a report is missing", () => {
    const { container } = render(<RevenueHero {...withYesterday([4_318, null])} nowMs={NOW} />);
    const yesterday = container.querySelector("[data-revenue-yesterday]")!;
    expect(yesterday.getAttribute("data-revenue-yesterday")).toBe("some");
    // Two of the six sites have a revenue source; the other four are not owed.
    expect(container.querySelector("[data-revenue-pace]")?.textContent).toContain("Sep 21 · Pacific $43.18 est. · 1 of 2 sites · 9 days left");
    // The figure is drawn as a figure; the words around it stay quiet.
    const figure = yesterday.querySelector("[data-revenue-yesterday-figure]")!;
    expect(figure.textContent).toBe("$43.18");
    expect(figure.className).toContain("font-semibold");
  });

  it("states received reports with incompatible bases without inventing a total or missing reports", () => {
    const data = withYesterday([4_318, 1_207]);
    const sources = data.assets.filter(asset => asset.dailyRevenue);
    sources[1]!.dailyRevenue = { ...sources[1]!.dailyRevenue!, timeZone: "UTC" };
    const { container } = render(<RevenueHero {...data} nowMs={NOW} />);
    const yesterday = container.querySelector("[data-revenue-yesterday]")!;
    expect(yesterday.getAttribute("data-revenue-yesterday")).toBe("mixed");
    expect(yesterday.textContent).toBe("Mixed report days · 2 of 2 sites · no total");
    expect(yesterday.querySelector("[data-revenue-yesterday-figure]")).toBeNull();
    expect(yesterday.textContent).not.toContain("not reported");
  });

  it("labels the actual received day when another clock's report is missing", () => {
    const data = withYesterday([4_318, null]);
    const sources = data.assets.filter(asset => asset.dailyRevenue);
    sources[1]!.dailyRevenue = { ...sources[1]!.dailyRevenue!, timeZone: "UTC" };
    const { container } = render(<RevenueHero {...data} nowMs={NOW} />);
    const yesterday = container.querySelector("[data-revenue-yesterday]")!;
    expect(yesterday.getAttribute("data-revenue-yesterday")).toBe("some");
    expect(yesterday.textContent).toBe("Sep 21 · Pacific $43.18 est. · 1 of 2 sites");
  });

  it("says so in words, with no number, before any report is in", () => {
    const { container } = render(<RevenueHero {...withYesterday([null, null])} nowMs={NOW} />);
    const yesterday = container.querySelector("[data-revenue-yesterday]")!;
    expect(yesterday.getAttribute("data-revenue-yesterday")).toBe("none");
    expect(container.querySelector("[data-revenue-pace]")?.textContent).toContain("Sep 21 · Pacific not reported yet · 9 days left");
    expect(yesterday.textContent).not.toMatch(/\$/);
  });

  it("states a recorded $0 as $0", () => {
    const { container } = render(<RevenueHero {...withYesterday([0, 0])} nowMs={NOW} />);
    expect(container.querySelector("[data-revenue-yesterday]")?.textContent).toBe("Sep 21 · Pacific $0.00 est.");
  });

  it("still shows yesterday under the reason while the month has no pace yet", () => {
    const data = wallFixturePayload();
    const assets = data.assets.map((asset) =>
      asset.revenueProjection
        ? {
            ...asset,
            revenueProjection: {
              ...asset.revenueProjection,
              status: "insufficient-history" as const,
              reason: "Learning from traffic and revenue · 12/21 days.",
              projectedMinor: null,
              dailyPaceMinor: null,
              points: [],
            },
          }
        : asset,
    );
    const { container } = render(<RevenueHero portfolio={data.portfolio} assets={assets} nowMs={NOW} />);
    expect(container.querySelector("[data-wall-revenue]")?.getAttribute("data-wall-revenue")).toBe("figure");
    expect(container.querySelector("[data-revenue-waiting]")?.textContent).toBe("Learning from traffic and revenue · 12/21 days.");
    expect(container.querySelector("[data-revenue-yesterday]")?.textContent).toBe("Sep 21 · Pacific $55.25 est.");
    expect(container.querySelector("[data-month-chart]")).toBeNull();
  });
});

// The month chart's crossing words ("on pace to pass August on Sep 26") never
// sit on today's dot. jsdom has no layout, so the chart's and the words' sizes
// are the ones a real browser measured at 390 and at the TV.
describe("the month chart's crossing words", () => {
  const LINE = { oneLine: { width: 216, height: 16 }, twoLines: { width: 148, height: 32 } };
  /** A phone's chart as the fixture draws it: 374 × 138 px, last month's line
   * at 34 px, today at day 21 just under it, the crossing on day 26. */
  const phone: CrossingScene = {
    plot: { width: 374, height: 138 },
    label: LINE,
    previousLabel: { width: 123, height: 22 },
    crossing: { x: 319.2, y: 33.85 },
    today: { x: 256.2, y: 53.3 },
    lines: [
      [{ x: 4.5, y: 138 }, { x: 256.2, y: 53.3 }],
      [{ x: 256.2, y: 53.3 }, { x: 319.2, y: 33.1 }, { x: 369.5, y: 16.7 }],
    ],
  };
  const clearOf = (placement: CrossingPlacement, size: { width: number; height: number }, box: { left: number; top: number; right: number; bottom: number }) =>
    placement.left + size.width <= box.left || placement.left >= box.right || placement.top + size.height <= box.top || placement.top >= box.bottom;

  it("keeps the TV's place — ending at the dot, above the line — where the chart is wide", () => {
    const tv = crossingLabelPlace({
      ...phone,
      plot: { width: 823, height: 156 },
      label: { oneLine: { width: 232, height: 18 }, twoLines: { width: 165, height: 36 } },
      previousLabel: { width: 135, height: 24 },
      crossing: { x: 702.3, y: 38.3 },
      today: { x: 563.8, y: 60.2 },
      lines: [[{ x: 9.9, y: 156 }, { x: 563.8, y: 60.2 }], [{ x: 563.8, y: 60.2 }, { x: 702.3, y: 37.4 }, { x: 813, y: 18.9 }]],
    });
    expect(crossingPlaceName(tv)).toBe("end-above");
  });

  it("wraps onto two lines above the line on a phone, clear of last month's label and today's halo", () => {
    const placed = crossingLabelPlace(phone);
    expect(crossingPlaceName(placed)).toBe("end-above-wrapped");
    const size = LINE.twoLines;
    expect(clearOf(placed, size, { left: 0, top: 33.85 - 22, right: 123, bottom: 33.85 })).toBe(true);
    expect(clearOf(placed, size, { left: 256.2 - 16, top: 53.3 - 16, right: 256.2 + 16, bottom: 53.3 + 16 })).toBe(true);
    // Below the line and ending at the dot is refused: it covers today's halo.
    expect(clearOf({ ...placed, left: 319.2 - 16 - 216, top: 33.85 + 8 }, LINE.oneLine, { left: 240.2, top: 37.3, right: 272.2, bottom: 69.3 })).toBe(false);
  });

  it("starts at the dot below the line when the month passed last month early", () => {
    // Passed on day 8, today day 21: right of the dot, below the line, the
    // month's own line is above it.
    const placed = crossingLabelPlace({
      ...phone,
      crossing: { x: 90, y: 100 },
      today: { x: 256.2, y: 20 },
      lines: [[{ x: 4.5, y: 138 }, { x: 90, y: 100 }, { x: 256.2, y: 20 }], [{ x: 256.2, y: 20 }, { x: 369.5, y: 5 }]],
    });
    expect(crossingPlaceName(placed)).toBe("start-below");
    expect(placed.left).toBeCloseTo(106);
  });

  it("draws the flip on the page from the chart's measured size", () => {
    const data = wallFixturePayload();
    const measured = (sizes: { plot: [number, number]; lead: [number, number]; tail: [number, number]; previous: [number, number] }) => {
      const size = (element: HTMLElement): [number, number] => {
        if (element.getAttribute("role") === "img" && element.parentElement?.hasAttribute("data-month-chart")) return sizes.plot;
        if (element.hasAttribute("data-previous-total-label")) return sizes.previous;
        const words = element.parentElement;
        if (words?.hasAttribute("data-month-crossing-label")) return element === words.firstElementChild ? sizes.lead : sizes.tail;
        return [0, 0];
      };
      const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
        return size(this)[0];
      });
      const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
        return size(this)[1];
      });
      const { container, unmount } = render(<RevenueHero portfolio={data.portfolio} assets={data.assets} nowMs={NOW} />);
      const words = container.querySelector<HTMLElement>("[data-month-crossing-label]")!;
      const seen = { place: words.getAttribute("data-month-crossing-place"), style: words.getAttribute("style"), className: words.className, text: words.textContent };
      unmount();
      width.mockRestore();
      height.mockRestore();
      return seen;
    };

    const onPhone = measured({ plot: [374, 138], lead: [148, 16], tail: [64, 16], previous: [123, 22] });
    expect(onPhone.place).toBe("end-above-wrapped");
    expect(onPhone.className).toContain("flex-col");
    // Anchored at the dot: its right edge 16 px left of it, its bottom 4 px above the line.
    expect(onPhone.style).toContain("right: calc(");
    expect(onPhone.style).toContain("bottom: calc(");
    expect(onPhone.text).toBe("on pace to pass August on Sep 26");

    const onTv = measured({ plot: [823, 156], lead: [165, 18], tail: [67, 18], previous: [135, 24] });
    expect(onTv.place).toBe("end-above");
    expect(onTv.className).not.toContain("flex-col");
  });
});

// The TV draws the month's chart behind the figures, filling the tile. jsdom
// has no layout, so the plot's size, the labels' sizes and where the tile's
// lines of text fall over the plot are the ones a browser measured at 1920 ×
// 1080: the tile beside Needs attention and stretched to its three rows, and
// the same tile at the height of its own text.
describe("the month chart behind the figures on the TV", () => {
  const LABEL = { oneLine: { width: 232.75, height: 18 }, twoLines: { width: 160, height: 36 } };
  const PREVIOUS = { width: 132, height: 24 };
  const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
  /** Beside Needs attention's three rows: 823 × 236, the pace at the tile's foot. */
  const stretched = {
    plot: { width: 823, height: 236 },
    text: { eyebrow: box(0, 0, 325, 20), figure: box(0, 27, 384, 172), pace: box(408, 122, 690, 161), chip: box(432, 173, 569, 194), date: box(408, 203, 744, 224) },
    today: { x: 563.84, y: 91.09 },
    crossing: { x: 702.33, y: 57.96 },
    lines: [[{ x: 9.9, y: 236 }, { x: 563.84, y: 91.09 }], [{ x: 563.84, y: 91.09 }, { x: 702.33, y: 57.96 }, { x: 813.1, y: 28.98 }]],
  };
  /** As tall as its own text: 762 × 174, the pace beside the figure. */
  const own = {
    plot: { width: 762, height: 174 },
    text: { eyebrow: box(0, 0, 325, 20), figure: box(0, 27, 384, 172), pace: box(408, 60, 690, 99), chip: box(432, 111, 569, 132), date: box(408, 141, 744, 162) },
    today: { x: 522.05, y: 67.16 },
    crossing: { x: 650.27, y: 42.74 },
    lines: [[{ x: 9.1, y: 174 }, { x: 522.05, y: 67.16 }], [{ x: 522.05, y: 67.16 }, { x: 650.27, y: 42.74 }, { x: 752.9, y: 21.37 }]],
  };
  const scene = (tile: typeof stretched, over: boolean): ChartLabelScene => ({
    plot: tile.plot,
    crossing: { at: tile.crossing, label: LABEL },
    previous: { rule: tile.crossing.y, label: PREVIOUS },
    today: tile.today,
    lines: tile.lines,
    over: over ? Object.values(tile.text) : null,
  });
  const wordsBox = (placed: CrossingPlacement): Box => {
    const size = placed.wrapped ? LABEL.twoLines : LABEL.oneLine;
    return box(placed.left, placed.top, placed.left + size.width, placed.top + size.height);
  };
  const previousBox = (placed: PreviousPlacement, rule: number): Box => {
    const top = placed.vertical === "above" ? rule - PREVIOUS.height : rule;
    return box(placed.left, top, placed.left + PREVIOUS.width, top + PREVIOUS.height);
  };
  const apart = (a: Box, b: Box) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;

  it("puts both labels where the figures over the chart leave room, clear of each other", () => {
    const placed = chartLabelsPlace(scene(stretched, true));
    expect(crossingPlaceName(placed.crossing!)).toBe("end-above");
    // Top left is under the figure, so last month's words take the first
    // clear place along its line: right of the figure, under the line.
    expect(placed.previous).toEqual({ vertical: "below", left: 392 });
    const words = wordsBox(placed.crossing!);
    const previous = previousBox(placed.previous!, stretched.crossing.y);
    for (const [name, text] of Object.entries(stretched.text)) {
      expect(apart(words, text), `the crossing's words over ${name}`).toBe(true);
      expect(apart(previous, text), `last month's words over ${name}`).toBe(true);
    }
    expect(apart(words, previous)).toBe(true);
  });

  it("leaves a label out rather than drawing it over the figures where nothing is clear", () => {
    const placed = chartLabelsPlace(scene(own, true));
    expect(crossingPlaceName(placed.crossing!)).toBe("end-above");
    expect(placed.previous).toBeNull();
    // Under the figures the same chart keeps the phone's places.
    const under = chartLabelsPlace(scene(own, false));
    expect(under.previous).toEqual({ vertical: "above", left: 0 });
    expect(under.crossing).not.toBeNull();
  });

  it("finds nowhere for last month's words when every place along the line is covered", () => {
    const everywhere = box(-10, -10, 1000, 1000);
    expect(previousLabelPlace({ plot: stretched.plot, label: PREVIOUS, rule: stretched.crossing.y, blocked: [everywhere], lines: [] })).toBeNull();
    // With nothing over it, the line's left end, above it.
    expect(previousLabelPlace({ plot: stretched.plot, label: PREVIOUS, rule: stretched.crossing.y, blocked: [], lines: [] })).toEqual({ vertical: "above", left: 0 });
  });

  it("draws the placements on the page from the tile's measured text, and hides a label with no clear place", () => {
    const data = wallFixturePayload();
    const drawn = (tile: typeof stretched) => {
      const sizes = (element: HTMLElement): [number, number] => {
        if (element.getAttribute("role") === "img" && element.parentElement?.hasAttribute("data-month-chart")) return [tile.plot.width, tile.plot.height];
        if (element.hasAttribute("data-previous-total-label")) return [PREVIOUS.width, PREVIOUS.height];
        const words = element.parentElement;
        if (words?.hasAttribute("data-month-crossing-label")) return element === words.firstElementChild ? [160, 18] : [69, 18];
        return [0, 0];
      };
      const lineOf = (node: Node): Box | null => {
        const at = node.parentElement;
        if (!at) return null;
        if (at.closest("h2")) return tile.text.eyebrow;
        if (at.closest("[data-revenue-figure]")) return tile.text.figure;
        if (at.closest("[data-revenue-change]")) return tile.text.chip;
        const pace = at.closest("[data-revenue-pace]");
        if (!pace) return null;
        return pace.firstElementChild?.contains(at) ? tile.text.pace : tile.text.date;
      };
      const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
        return sizes(this)[0];
      });
      const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
        return sizes(this)[1];
      });
      // The TV's layer: the plot is positioned in the tile, behind its text.
      const parent = vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("role") === "img" ? this.closest("[data-wall-revenue]") : null;
      });
      const computed = globalThis.getComputedStyle;
      const style = vi.spyOn(globalThis, "getComputedStyle").mockImplementation((element, pseudo) =>
        element instanceof HTMLElement && element.getAttribute("role") === "img" ? ({ position: "absolute" } as CSSStyleDeclaration) : computed(element, pseudo),
      );
      const rects = Range.prototype.getClientRects;
      Range.prototype.getClientRects = function (this: Range) {
        const line = lineOf(this.startContainer);
        const found = line ? [{ ...line, width: line.right - line.left, height: line.bottom - line.top }] : [];
        return found as unknown as DOMRectList;
      };
      const { container, unmount } = render(<RevenueHero portfolio={data.portfolio} assets={data.assets} nowMs={NOW} />);
      const crossing = container.querySelector<HTMLElement>("[data-month-crossing-label]")!;
      const previous = container.querySelector<HTMLElement>("[data-previous-total-label]")!;
      const seen = {
        crossing: crossing.getAttribute("data-month-crossing-place"),
        crossingHidden: crossing.classList.contains("invisible"),
        previous: previous.getAttribute("data-previous-total-place"),
        previousHidden: previous.classList.contains("invisible"),
        previousLeft: previous.style.left,
        previousBelow: previous.classList.contains("pt-1.5"),
      };
      unmount();
      Range.prototype.getClientRects = rects;
      style.mockRestore();
      parent.mockRestore();
      width.mockRestore();
      height.mockRestore();
      return seen;
    };

    const beside = drawn(stretched);
    expect(beside).toMatchObject({ crossing: "end-above", crossingHidden: false, previous: "below", previousHidden: false, previousBelow: true });
    expect(Number.parseFloat(beside.previousLeft)).toBeCloseTo((392 / 823) * 100, 3);

    const alone = drawn(own);
    expect(alone).toMatchObject({ crossing: "end-above", crossingHidden: false, previous: "none", previousHidden: true });
  });

  it("moves only with the chart kit's motion, all of which stops under reduced motion", () => {
    const css = readFileSync(path.resolve(import.meta.dirname, "../src/index.css"), "utf8");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    const stilled = reduced.slice(0, reduced.indexOf("\n}\n"));
    const data = wallFixturePayload();
    const { container } = render(<RevenueHero portfolio={data.portfolio} assets={data.assets} nowMs={NOW} />);
    const classes = new Set([...container.querySelectorAll("*")].flatMap((node) => (node.getAttribute("class") ?? "").split(/\s+/)));
    const motion = [...classes].filter((name) => /^(chart-[a-z-]+|viz-[a-z-]+)$/.test(name) && /morph|breathe|arrive|grow|draw|flow/.test(name));
    expect(motion).toContain("chart-morph");
    for (const name of motion) expect(stilled, name).toContain(`.${name}`);
    for (const name of classes) if (/animate-/.test(name)) expect(name, name).toMatch(/^motion-safe:/);
  });
});

// A new installation's first three weeks: the revenue sites report daily, but
// no projection is ready and the ledger has no row yet.
describe("the revenue widget before the month has a pace or a ledger row", () => {
  const NO_LEDGER = { forecast: ZERO, booked: ZERO, netTrend: [], firstRun: true };
  const learningOnly = (earned: boolean) => {
    const data = wallFixturePayload();
    return {
      portfolio: { ...data.portfolio, ...NO_LEDGER },
      assets: data.assets.map((asset) =>
        asset.revenueProjection
          ? {
              ...asset,
              revenueProjection: {
                ...asset.revenueProjection,
                status: earned ? ("insufficient-history" as const) : ("waiting-revenue" as const),
                reason: earned ? "Learning from traffic and revenue · 12/21 days." : "Waiting for complete revenue reports.",
                earnedMinor: earned ? asset.revenueProjection.earnedMinor : null,
                projectedMinor: null,
                dailyPaceMinor: null,
                points: [],
              },
            }
          : asset,
      ),
    };
  };

  it("shows the month so far, the reason and yesterday, never 'No revenue source'", () => {
    const { container } = render(<RevenueHero {...learningOnly(true)} nowMs={NOW} />);
    const section = container.querySelector("[data-wall-revenue]")!;
    expect(section.getAttribute("data-wall-revenue")).toBe("figure");
    expect(section).not.toHaveClass("isolate");
    expect(section.textContent).not.toContain("No revenue source");
    expect(within(section as HTMLElement).getByRole("heading").textContent).toBe("September revenue · estimated");
    // Plume Studio $924 + Mosaic Finder $261 reported so far.
    expect(section.querySelector("[data-revenue-figure]")?.textContent).toBe("$1,185");
    expect(section.querySelector("[data-revenue-waiting]")?.textContent).toBe("Learning from traffic and revenue · 12/21 days.");
    expect(section.querySelector("[data-revenue-yesterday]")?.textContent).toBe("Sep 21 · Pacific $55.25 est.");
    expect(section.querySelector("[data-month-chart]")).toBeNull();
  });

  it("shows the reason and yesterday with no figure while no month is complete", () => {
    const { container } = render(<RevenueHero {...learningOnly(false)} nowMs={NOW} />);
    const section = container.querySelector("[data-wall-revenue]")!;
    expect(section.getAttribute("data-wall-revenue")).toBe("waiting");
    expect(section).not.toHaveClass("isolate");
    expect(section.querySelector("[data-revenue-figure]")).toBeNull();
    expect(section.querySelector("[data-revenue-waiting]")?.textContent).toBe("Waiting for complete revenue reports.");
    expect(section.querySelector("[data-revenue-yesterday]")?.textContent).toBe("Sep 21 · Pacific $55.25 est.");
    expect(section.textContent).not.toContain("No revenue source");
  });
});

it('shows unknown current revenue with dated estimated history instead of a cost-only zero', () => {
  const data = wallFixturePayload();
  const assets = data.assets.filter(asset => asset.revenueProjection).map(asset => ({ ...asset, revenueProjection: { ...asset.revenueProjection!, earnedMinor: null } }));
  const { container } = render(<RevenueHero portfolio={{ ...data.portfolio, revenueRecorded: { booked: false, forecast: false }, forecast: { currency: 'USD', revenue: 0, cost: 35, net: -35 }, booked: ZERO }} assets={assets} nowMs={NOW} />);
  const section = container.querySelector('[data-wall-revenue="waiting"]')!;
  expect(section).not.toBeNull();
  expect(section.querySelector('[data-revenue-figure]')).toBeNull();
  expect(section.querySelector('[data-revenue-waiting]')).toHaveTextContent("Waiting for revenue reports.");
  expect(section.querySelector('[data-revenue-previous-month]')).toHaveTextContent('August 2026 $1,458 est.');
  expect(section.querySelector('[data-revenue-pace]')).toHaveTextContent('on pace for');
});

it('names partial dated previous-month coverage without calling it a portfolio total', () => {
  const data = wallFixturePayload();
  const sources = data.assets.filter(asset => asset.revenueProjection);
  const assets = sources.map((asset, index) => ({ ...asset, revenueProjection: { ...asset.revenueProjection!, earnedMinor: null, previousMonthMinor: index === 0 ? 30000 : null } }));
  const { container } = render(<RevenueHero portfolio={{ ...data.portfolio, revenueRecorded: { booked: false, forecast: false }, forecast: { currency: 'USD', revenue: 0, cost: 35, net: -35 }, booked: ZERO }} assets={assets} nowMs={NOW} />);
  expect(container.querySelector('[data-revenue-figure]')).toBeNull();
  expect(container.querySelector('[data-revenue-previous-month]')).toHaveTextContent('August 2026 $300 est. · 1 of 2 sites');
  expect(container.querySelector('[data-revenue-change]')).toBeNull();
});

describe("Needs attention", () => {
  it("is one calm line when nothing needs the operator", () => {
    const { container } = render(
      <NeedsYou
        issues={[]}
        operator={{ waiting: 0, urgent: 0, measuredProjects: 6, urgentMeasuredProjects: 6, projectCount: 6, capturedAt: new Date(NOW - 60_000).toISOString() }}
        nowMs={NOW}
      />,
    );
    const calm = container.querySelector("[data-needs-calm]")!;
    expect(calm.textContent).toBe("Nothing needs attention");
    expect(calm.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("[data-needs-row]")).toBeNull();
    expect(container.querySelector("[data-needs-meta]")).toBeNull();
  });

  it("uses lower-bound words for urgent tasks in a partially read inbox", () => {
    const { container } = render(<NeedsYou issues={[]} nowMs={NOW}
      operator={{ waiting: 3, urgent: 1, measuredProjects: 1, urgentMeasuredProjects: 1, projectCount: 2, capturedAt: new Date(NOW).toISOString() }} />);
    expect(container.querySelector("[data-needs-meta]")).toHaveTextContent("at least 1 urgent tasks");
    expect(container).not.toHaveTextContent("Nothing needs attention");
  });

  it("lists the fixture's warning with its site, sentence and age, and the urgent tasks beside the heading", () => {
    const data = wallFixturePayload();
    const { container } = render(
      <NeedsYou
        issues={wallIssues({ assets: data.assets, attention: data.attention, connections: NO_READS, nowMs: NOW })}
        operator={data.operator}
        nowMs={NOW}
      />,
    );
    const rows = container.querySelectorAll("[data-needs-row]");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-needs-row")).toBe("warn");
    expect(rows[0]!.textContent).toContain("Plume Studio");
    expect(rows[0]!.querySelector("[data-needs-line]")?.textContent).toMatch(/^Plans saved well below normal/);
    expect(rows[0]!.querySelector("[data-needs-age]")?.textContent).toBe("2h");
    expect(container.querySelector("[data-needs-meta]")?.textContent).toBe("1 of 1 · 1 urgent task");
  });

  it("never rotates: every row stays in place until it resolves", () => {
    const data = wallFixturePayload();
    const fire = [
      ...data.attention,
      { ...data.attention[0]!, id: 7001, severity: "error" as const, ruleId: "hygiene-home-unreachable", metric: "home", ruleInputs: { http_status: 503 }, asset: "acorn.example", assetDisplayName: "Acorn Atlas", firstFiredAt: new Date(NOW - 25 * 60_000).toISOString() },
      { ...data.attention[0]!, id: 7002, asset: "mosaic.example", assetDisplayName: "Mosaic Finder", firstFiredAt: new Date(NOW - 60 * 60_000).toISOString() },
      { ...data.attention[0]!, id: 7003, asset: "ripple.example", assetDisplayName: "Ripple Index", firstFiredAt: new Date(NOW - 30 * 60_000).toISOString() },
    ];
    const { container } = render(
      <NeedsYou issues={wallIssues({ assets: data.assets, attention: fire, connections: NO_READS, nowMs: NOW })} operator={data.operator} nowMs={NOW} />,
    );
    const sites = [...container.querySelectorAll("[data-needs-row]")].map((row) => row.querySelector("span")?.textContent);
    expect(sites).toEqual(["Acorn Atlas", "Ripple Index", "Mosaic Finder"]);
    expect(container.querySelector("[data-needs-meta]")?.textContent).toBe("3 of 4 · 1 urgent task");
    expect(container.querySelector("[data-attention-progress]")).toBeNull();
  });
});

describe("the Wall draws both from a layout", () => {
  it("places revenue and Needs attention in one row", () => {
    const layout: WallLayout = {
      version: 1,
      rows: [
        { id: "body", height: "auto", widgets: [{ id: "revenue", type: "revenue", width: 1.55 }, { id: "needs", type: "needs", width: 1 }] },
      ],
    };
    const data: WallPayload = wallFixturePayload();
    const { container } = render(<WallCanvas layout={layout} data={data} nowMs={NOW} />);
    const row = container.querySelector("[data-wall-row='body']")!;
    expect(row.querySelector("[data-wall-revenue]")).not.toBeNull();
    expect(row.querySelector("[data-wall-needs]")).not.toBeNull();
  });

  it("asks the revenue widget's yesterday on the Wall's own clock", () => {
    const layout: WallLayout = {
      version: 1,
      rows: [{ id: "money", height: "auto", widgets: [{ id: "revenue", type: "revenue", width: 1 }] }],
    };
    const data: WallPayload = wallFixturePayload();
    const yesterday = (nowMs: number) =>
      render(<WallCanvas layout={layout} data={data} nowMs={nowMs} />).container.querySelector("[data-revenue-yesterday]")?.textContent;
    expect(yesterday(NOW)).toBe("Sep 21 · Pacific $55.25 est.");
    // A day later on the Wall's clock the held reports describe the day
    // before yesterday, so none of them is yesterday's.
    expect(yesterday(NOW + 86_400_000)).toBe("Sep 22 · Pacific not reported yet");
  });
});
