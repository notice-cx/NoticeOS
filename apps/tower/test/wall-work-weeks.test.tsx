// The Wall's Work this week tile with each figure's week: done this week
// against last week's on one bar with the partial week in words, a change
// chip on every figure whose earlier reading is known, and last week's done
// as a dashed outline under each project's bar.

import { readFileSync } from "node:fs";
import path from "node:path";
import { render, within } from "./render";
import { describe, expect, it, vi } from "vitest";
import type { AssetCard, WorkSummary } from "@shared/wall";
import type { WorkWeeks } from "@shared/work";
import { WallWork } from "@/components/wall/WallWork";
import { WorkFlow, WorkWeekChip, moreProjects, workRowsThatFit } from "@/components/viz/WorkFlow";
import { workFlowRows } from "@/lib/viz-adapters";

const NOW = Date.parse("2026-09-22T19:30:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

/** A Tuesday: two days into the week that began on Monday 09-21. */
function weeks(overrides: Partial<WorkWeeks> = {}): WorkWeeks {
  return {
    weekStart: "2026-09-21",
    daysIn: 2,
    done: { now: 6, notDone: 1, before: 4, lastWeek: 15, move: { by: 2, direction: "up", verdict: "good" } },
    waiting: { now: 2, before: 1, added: 2, move: { by: 1, direction: "up", verdict: "bad" } },
    urgent: { now: 1, before: 1, added: 0, move: { by: 0, direction: "flat", verdict: "neutral" } },
    inProgress: { now: 2, before: 3, added: 1, move: { by: -1, direction: "down", verdict: "neutral" } },
    blocked: { now: 1, before: 0, added: 1, move: { by: 1, direction: "up", verdict: "bad" } },
    ...overrides,
  };
}

function work(week: WorkWeeks | undefined, closedRecent = 9): WorkSummary {
  return { open: 4, highPriority: 1, inProgress: 2, blocked: 1, closedRecent, priorities: [0, 1, 2, 1, 0], capturedAt: at(0), ...(week ? { weeks: week } : {}) };
}

function asset(id: string, summary: WorkSummary | null): AssetCard {
  return {
    netByMonthCurrency: "USD", id, displayName: id, status: "live", senseOnly: false, worstSeverity: null, openError: 0, openWarn: 0,
    booked: { currency: "USD", revenue: 0, cost: 0, net: 0 }, forecast: { currency: "USD", revenue: 0, cost: 0, net: 0 },
    netPeriod: "2026-09", pulseReceivedAt: at(1), firstReportAt: null, dataSources: [],
    activeUsers: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] }, work: summary, panelReview: null,
    searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] }, netByMonth: [], netByMonthProvisionalFrom: null, latestPanelDate: null,
  };
}

const operator = { waiting: 4, urgent: 0, measuredProjects: 2, urgentMeasuredProjects: 2, projectCount: 2, capturedAt: at(0) };
const figure = (container: HTMLElement, label: string) => container.querySelector<HTMLElement>(`[data-work-figure="${label}"]`)!;

describe("the Wall's work tile, week against week", () => {
  it("draws this week's done against last week's on one bar, with the partial week in words", () => {
    const { container } = render(<WallWork assets={[asset("a.example", work(weeks())), asset("b.example", work(weeks()))]} operator={operator} nowMs={NOW} />);
    expect(container.querySelector("[data-work-days-in]")).toHaveTextContent("2 days in");
    // Done is this calendar week from the closes, not the trailing seven days.
    expect(figure(container, "Done this week")).toHaveTextContent(/^Done this week12/);
    const bar = container.querySelector<HTMLElement>("[data-work-weeks] [data-pace-bar]")!;
    expect(bar).toHaveAttribute("data-pace", "ahead");
    expect(bar).toHaveTextContent("Done last week by today 8");
    expect(bar).toHaveTextContent("Done last week total 30");
  });

  it("gives each figure its change in words, toned by which way is better for it", () => {
    const { container } = render(<WallWork assets={[asset("a.example", work(weeks())), asset("b.example", work(weeks()))]} operator={operator} nowMs={NOW} />);
    // Done: 12 against 8 by today last week, more is better.
    const done = within(figure(container, "Done this week"));
    expect(done.getByLabelText("4 more than last week by today")).toHaveAttribute("data-tone", "positive");
    // Waiting on the operator: 4 now against 2 a week ago, more is worse. The
    // TV keeps each move to one line, without how many entered.
    const decisions = figure(container, "Your decisions");
    expect(within(decisions).getByLabelText("2 more than a week ago")).toHaveAttribute("data-tone", "negative");
    expect(decisions).toHaveTextContent(/vs a week ago$/);
    expect(container.querySelector("[data-week-added]")).toBeNull();
    // In progress has no better direction: an arrow and words, no colour.
    expect(within(figure(container, "In progress")).getByLabelText("2 fewer than a week ago")).toHaveAttribute("data-tone", "neutral");
    expect(within(figure(container, "Blocked")).getByLabelText("2 more than a week ago")).toHaveAttribute("data-tone", "negative");
  });

  it("draws no chip where the earlier reading is not known, and no week bar without last week", () => {
    const unknown = weeks({
      done: { now: 6, notDone: 0, before: null, lastWeek: null, move: null },
      waiting: { now: 2, before: null, added: null, move: null },
      inProgress: { now: 2, before: null, added: null, move: null },
      blocked: { now: 1, before: null, added: null, move: null },
    });
    const { container } = render(<WallWork assets={[asset("a.example", work(unknown))]} operator={{ ...operator, waiting: 2, projectCount: 1, measuredProjects: 1, urgentMeasuredProjects: 1 }} nowMs={NOW} />);
    expect(container.querySelector("[data-week-move]")).toBeNull();
    expect(container.querySelector("[data-work-weeks]")).toBeNull();
    expect(container.querySelector("[data-work-days-in]")).toHaveTextContent("2 days in");
  });

  it("draws Done this week as one number with no plus sign: the days in say the week is still running", () => {
    const { container } = render(<WallWork assets={[asset("a.example", work(weeks())), asset("b.example", work(weeks()))]} operator={operator} nowMs={NOW} />);
    expect(figure(container, "Done this week")).toHaveTextContent(/^Done this week12(?!\+)/);
    expect(container.textContent).not.toContain("+");
    expect(container.querySelector("[data-work-days-in]")).toHaveTextContent("2 days in");
  });

  it("compares no lower-bound inbox", () => {
    const { container } = render(<WallWork assets={[asset("a.example", work(weeks()))]} operator={{ ...operator, measuredProjects: 1 }} nowMs={NOW} />);
    expect(figure(container, "Your decisions").querySelector("[data-week-move]")).toBeNull();
  });

  it("keeps each project's done left of the line with last week's as a dashed outline under it, on one scale", () => {
    const { container } = render(<WallWork assets={[asset("a.example", work(weeks())), asset("b.example", work(weeks({ done: { now: 1, notDone: 0, before: 0, lastWeek: 0, move: null } })))]} operator={operator} nowMs={NOW} />);
    const outline = container.querySelector<HTMLElement>('[data-work-row="a.example"] [data-work-last-week]')!;
    expect(outline).toHaveAttribute("data-work-last-week", "15");
    expect(outline.className).toContain("border-dashed");
    // The scale is the largest of any row's done, last week's or queue: 15.
    expect(outline.style.width).toBe("100%");
    // A project that closed nothing last week has no outline.
    expect(container.querySelector('[data-work-row="b.example"] [data-work-last-week]')).toBeNull();
    expect(container.querySelector('[data-work-row="a.example"]')).toHaveAttribute("aria-label", expect.stringContaining("6 done this week, 15 last week"));
  });

  it("keeps the trailing week's done for a site with no week reading", () => {
    const { container } = render(<WallWork assets={[asset("a.example", work(undefined, 9))]} operator={{ ...operator, projectCount: 1, measuredProjects: 1, urgentMeasuredProjects: 1 }} nowMs={NOW} />);
    expect(figure(container, "Done this week")).toHaveTextContent(/^Done this week9/);
    expect(container.querySelector("[data-work-days-in]")).toBeNull();
    expect(container.querySelector("[data-week-move]")).toBeNull();
  });

  it("moves only with the kit's motion, all of which stops under reduced motion", () => {
    const css = readFileSync(path.resolve(import.meta.dirname, "../src/index.css"), "utf8");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    const stilled = reduced.slice(0, reduced.indexOf("}", reduced.indexOf(".viz-draw,")));
    const { container } = render(<WallWork assets={[asset("a.example", work(weeks()))]} operator={operator} nowMs={NOW} />);
    const classes = new Set([...container.querySelectorAll<HTMLElement>("*")].flatMap((node) => (node.getAttribute("class") ?? "").split(/\s+/)));
    const motion = [...classes].filter((name) => /^viz-(arrive|breathe|grow-x|grow-y|draw|flow)$/.test(name));
    expect(motion).toEqual(expect.arrayContaining(["viz-arrive", "viz-grow-x"]));
    for (const name of motion) expect(stilled, name).toContain(`.${name}`);
    for (const name of classes) if (/animate-/.test(name)) expect(name, name).toMatch(/^motion-safe:/);
  });
});

// On the TV the tile is as tall as its content: one band for the heading and
// the four figures, the two weeks' bar with its words beside it, and each
// project one row as tall as its bar. A box too short for every project
// draws the rows that fit whole and counts the rest on one line.
describe("the Work tile's height on the TV", () => {
  const six = ["a", "b", "c", "d", "e", "f"].map((id) => asset(`${id}.example`, work(weeks())));

  it("draws each project as one row as tall as its bar, with no padding, while the desk keeps its spacing", () => {
    const { container } = render(<WallWork assets={six} operator={operator} nowMs={NOW} />);
    const rows = [...container.querySelectorAll<HTMLElement>("[data-work-row]")];
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.className).not.toMatch(/\bpy-/);
      // The name's line is the bar's height (`--text-wall-row`, 1.25 rem), and
      // the two weeks' done bars sit inside the same h-5.
      expect(row.querySelector("[title]")).toHaveClass("text-wall-row");
      expect(row.querySelector("[data-work-last-week]")!.parentElement!.parentElement).toHaveClass("h-5");
    }
    const css = readFileSync(path.resolve(import.meta.dirname, "../src/index.css"), "utf8");
    expect(css).toContain("--text-wall-row--line-height: calc(1.25rem * var(--wall-boost-body, 1));");

    const desk = render(<WorkFlow rows={workFlowRows(six)} title="Work" />).container;
    for (const row of desk.querySelectorAll("[data-work-row]")) {
      expect(row).toHaveClass("py-2");
      expect(row.querySelector("[title]")).toHaveClass("text-sm");
    }
  });

  it("sets the heading and the four figures on one band and the two weeks' words beside their bar, where the tile is wide enough", () => {
    const { container } = render(<WallWork assets={six} operator={operator} nowMs={NOW} />);
    const band = container.querySelector("[data-work-band]")!;
    expect(band).toHaveClass("@7xl:flex-row");
    expect(band.querySelector("header")).not.toBeNull();
    expect(band.querySelectorAll("[data-work-figure]")).toHaveLength(4);
    for (const value of band.querySelectorAll("[data-work-figure-value]")) expect(value).toHaveClass("@7xl:flex-row", "@7xl:whitespace-nowrap");
    expect(container.querySelector("[data-work-weeks] [data-pace-bar]")).toHaveClass("@2xl:flex-row");
    // The desk keeps its heading over its figures and the bar's words under it.
    const desk = render(<WorkFlow rows={workFlowRows(six)} weeks={weeks()} title="Work" />).container;
    expect(desk.querySelector("[data-work-band]")).toBeNull();
    expect(desk.querySelector("[data-pace-bar]")).not.toHaveClass("@2xl:flex-row");
  });

  it("counts the rows that fit whole, leaving one row's height for the line that counts the rest", () => {
    // 124 px of figures and bar above the rows, 21 px rows.
    expect(workRowsThatFit({ height: 250, top: 124, row: 21, rows: 6 })).toBe(6);
    expect(workRowsThatFit({ height: 205, top: 124, row: 21, rows: 6 })).toBe(2);
    expect(workRowsThatFit({ height: 130, top: 124, row: 21, rows: 6 })).toBe(0);
    expect(workRowsThatFit({ height: 0, top: 0, row: 0, rows: 6 })).toBe(6);
  });

  it("draws the rows that fit and one line for the rest when the box is short, never a cut row", () => {
    const sizes = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-wall-work") ? 205 : 0;
    });
    const tops = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return this.matches("[data-work-row], [data-work-more]") ? 124 : 0;
    });
    const heights = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.matches("[data-work-row], [data-work-more]") ? 21 : 0;
    });
    const { container } = render(<WallWork assets={six} operator={operator} nowMs={NOW} />);
    sizes.mockRestore();
    tops.mockRestore();
    heights.mockRestore();
    expect(container.querySelector("[data-wall-work]")).toHaveAttribute("data-work-shown", "2");
    expect(container.querySelectorAll("[data-work-row]")).toHaveLength(2);
    const more = container.querySelector("[data-work-more]")!;
    expect(more).toHaveTextContent("+4 more projects");
    expect(more).toHaveAttribute("role", "row");
  });

  it("names one left-out project in the singular", () => {
    const { container } = render(<WorkFlow rows={workFlowRows(six)} title="Work" compact shownRows={5} />);
    expect(container.querySelector("[data-work-more]")).toHaveTextContent("+1 more project");
    expect(moreProjects(2)).toBe("+2 more projects");
    // Every row fits: no line at all.
    const all = render(<WorkFlow rows={workFlowRows(six)} title="Work" compact shownRows={6} />).container;
    expect(all.querySelector("[data-work-more]")).toBeNull();
  });
});

describe("the work figure's change chip", () => {
  it("says a level week as level, with no colour, and how many entered the state", () => {
    const { container } = render(<WorkWeekChip move={{ by: 0, direction: "flat", verdict: "neutral" }} against="a week ago" added={3} />);
    expect(within(container).getByLabelText("Level with a week ago")).toHaveAttribute("data-tone", "neutral");
    expect(container).toHaveTextContent("levelwith a week ago· 3 added");
  });

  it("names the count and the comparison when the figure moved", () => {
    const { container } = render(<WorkWeekChip move={{ by: -2, direction: "down", verdict: "good" }} against="a week ago" added={0} />);
    expect(within(container).getByLabelText("2 fewer than a week ago")).toHaveAttribute("data-tone", "positive");
    expect(container).toHaveTextContent("2vs a week ago");
    expect(container.querySelector("[data-week-added]")).toBeNull();
  });

  it("is nothing at all without an earlier reading", () => {
    const { container } = render(<WorkWeekChip move={null} against="a week ago" />);
    expect(container).toBeEmptyDOMElement();
  });
});
