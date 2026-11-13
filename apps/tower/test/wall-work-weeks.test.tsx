// Work metrics retain unavailable evidence, current counts and each state's
// improvement direction while sharing the Wall's standard metric widgets.

import { render, within } from "./render";
import { describe, expect, it } from "vitest";
import type { WorkSummary } from "@shared/wall";
import type { WorkWeeks } from "@shared/work";
import { WallWork } from "@/components/wall/WallWork";
import { WorkWeekChip } from "@/components/viz/WorkFlow";

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

const operator = { waiting: 4, urgent: 0, measuredProjects: 2, urgentMeasuredProjects: 2, projectCount: 2, capturedAt: at(0) };

describe("the Wall's metric work tile", () => {
  it("marks totals as lower bounds when another project has no task counts", () => {
    const { container } = render(<WallWork projects={[work(weeks()), null]} operator={operator} nowMs={NOW} />);
    const status = within(container).getByRole("region", { name: "Task status" });
    expect(status.querySelector('[data-task-status="open"]')).toHaveTextContent("≥4");
    expect(status.querySelector('[data-task-status="in-progress"]')).toHaveTextContent("≥2");
    expect(status.querySelector('[data-task-status="blocked"]')).toHaveTextContent("≥1");
    const done = within(container).getByRole("region", { name: "Done this week" });
    expect(done).toHaveTextContent("At least");
    expect(done.querySelector("[data-week-comparison]")).toBeNull();
  });

  it("does not turn a partial observed zero into an empty aggregate queue", () => {
    const w = weeks();
    w.done.now = 0;
    const summary = { ...work(w), open: 0, inProgress: 0, blocked: 0 };
    const { container } = render(<WallWork projects={[summary, null]} operator={operator} nowMs={NOW} />);
    const status = within(container).getByRole("region", { name: "Task status" });
    expect(status.querySelectorAll('[aria-label="Unavailable"]')).toHaveLength(3);
    expect(status.querySelector(".wall-task-status-track")).toBeNull();
    const done = within(container).getByRole("region", { name: "Done this week" });
    expect(done.querySelector(".wall-metric-value")).toHaveTextContent("—");
    expect(done).not.toHaveTextContent("At least");
  });

  it("sums task status across projects and uses the workspace inbox count", () => {
    const { container } = render(<WallWork projects={[work(weeks()), work(weeks())]} operator={operator} nowMs={NOW} />);
    const status = within(container).getByRole("region", { name: "Task status" });
    expect(status.querySelector('[data-task-status="open"]')).toHaveTextContent("8");
    const decisions = within(container).getByRole("region", { name: "Your decisions" });
    expect(decisions.querySelector(".wall-metric-value")).toHaveTextContent("4");
  });

  it("uses fresh snapshot counts while withholding a history whose endpoint differs", () => {
    const w = weeks();
    w.blocked.history = [{ t: "2026-09-21", v: 0 }, { t: "2026-09-22", v: 1 }];
    const summary = { ...work(w), blocked: 4 };
    const { container } = render(<WallWork projects={[summary]} operator={operator} nowMs={NOW}
      widget={{ id: "work", type: "work", width: 1, settings: { metrics: [{ id: "blocked", source: "blocked", display: "number", size: "standard" }] } }} />);
    const blocked = within(container).getByRole("region", { name: "Blocked" });
    expect(blocked.querySelector(".wall-metric-value")).toHaveTextContent("4");
    expect(blocked.querySelector(".wall-metric-movement")).toHaveTextContent("4vs a week ago");
    expect(blocked).toHaveTextContent("History unavailable");
  });

  it("shows stale source counts with a stale label and no state comparison", () => {
    const summary = { ...work(weeks()), capturedAt: at(48) };
    const { container } = render(<WallWork projects={[summary]} operator={null} nowMs={NOW} />);
    expect(container).toHaveTextContent("Snapshot stale");
    const done = within(container).getByRole("region", { name: "Done this week" });
    expect(done.querySelector("[data-week-comparison]")).toBeNull();
    const status = within(container).getByRole("region", { name: "Task status" });
    expect(status.querySelector('[data-task-status="blocked"]')).toHaveTextContent("1");
  });

  it("scales the weekly comparison to the same elapsed time in each week", () => {
    const { container } = render(<WallWork projects={[work(weeks()), work(weeks())]} operator={operator} nowMs={NOW} />);
    const done = within(container).getByRole("region", { name: "Done this week" });
    const bars = within(done).getByRole("img", { name: "12 completed this week. 8 by the same time last week." });
    const width = (kind: string) => (bars.querySelector<HTMLElement>(`[data-week-bar="${kind}"]`)!).style.getPropertyValue("--week-bar-fill");
    expect(width("current")).toBe("100%");
    expect(Number.parseFloat(width("previous"))).toBeCloseTo(100 * 8 / 12);
  });

  it("keeps trailing closes out of this week's total when history is absent", () => {
    const { container } = render(<WallWork projects={[work(undefined, 99)]} operator={operator} nowMs={NOW} />);
    const done = within(container).getByRole("region", { name: "Done this week" });
    expect(done).toHaveTextContent("History unavailable");
    expect(done).not.toHaveTextContent("99");
  });

  it("preserves partial and stale inbox counts and withholds their comparisons", () => {
    const { container } = render(<WallWork projects={[work(weeks())]} operator={{ ...operator, waiting: 3, measuredProjects: 1 }} nowMs={NOW} />);
    const decisions = within(container).getByRole("region", { name: "Your decisions" });
    expect(decisions.querySelector('.wall-metric-qualifier')).toHaveTextContent("At least");
    expect(decisions.querySelector('.wall-metric-value')).toHaveTextContent("3");
    expect(decisions).toHaveTextContent("Some projects unread");
    expect(decisions.querySelector(".wall-metric-movement")).toBeNull();
    expect(decisions.querySelector(".wall-metric-axis")).toBeNull();
  });

  it("uses each state's improvement direction and keeps in progress neutral", () => {
    const { container } = render(<WallWork projects={[work(weeks()), work(weeks())]} operator={operator} nowMs={NOW}
      widget={{ id: "work", type: "work", width: 1, settings: { metrics: [
        { id: "in-progress", source: "in-progress", display: "number", size: "standard" },
        { id: "blocked", source: "blocked", display: "number", size: "standard" },
      ] } }} />);
    expect(within(container).getByRole("region", { name: "In progress" }).querySelector(".wall-metric-movement")).toHaveClass("text-spark");
    expect(within(container).getByRole("region", { name: "Blocked" }).querySelector(".wall-metric-movement")).toHaveClass("text-trend-negative");
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
