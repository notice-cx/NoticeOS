// Work metrics retain unavailable evidence, current counts and each state's
// improvement direction while sharing the Wall's standard metric widgets.

import { render, within } from "./render";
import { describe, expect, it } from "vitest";
import type { AssetCard, WorkSummary } from "@shared/wall";
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

describe("the Wall's metric work tile", () => {
  it("marks totals as lower bounds when another selected asset has no task counts", () => {
    const { container } = render(<WallWork assets={[asset("a.example", work(weeks())), asset("b.example", null)]} operator={operator} nowMs={NOW} />);
    for (const title of ["In progress", "Blocked", "Done this week"]) {
      const tile = within(container).getByRole("region", { name: title });
      expect(tile).toHaveTextContent("At least");
      expect(tile).toHaveTextContent("Some task counts unavailable");
      expect(tile.querySelector("[data-metric-movement]")).toBeNull();
      expect(tile.querySelector("svg[role=img]")).toBeNull();
    }
  });

  it("does not turn a partial observed zero into an empty aggregate queue", () => {
    const w = weeks();
    w.done.now = 0;
    const summary = { ...work(w), inProgress: 0, blocked: 0 };
    const { container } = render(<WallWork assets={[asset("a.example", summary), asset("b.example", null)]} operator={operator} nowMs={NOW} />);
    for (const title of ["In progress", "Blocked", "Done this week"]) {
      const tile = within(container).getByRole("region", { name: title });
      expect(tile.querySelector(".wall-metric-value")).toHaveTextContent("—");
      expect(tile).not.toHaveTextContent("At least");
    }
  });

  it("places the slim heading above four full-width metric tracks", () => {
    const { container } = render(<WallWork assets={[asset("a.example", work(weeks()))]} operator={operator} nowMs={NOW} />);
    const band = container.querySelector(".wall-work-band")!;
    expect(band.children).toHaveLength(4);
    expect(band.querySelector("h2")).toBeNull();
    const header = container.querySelector(".wall-work-heading")!;
    expect(header.querySelector("h2")).toHaveTextContent("Work this week");
    expect(header.querySelector("[data-work-days-in]")).not.toBeNull();
    expect(header.nextElementSibling).toBe(band);
    expect(band.lastElementChild).toHaveAttribute("aria-label", "Done this week");
    expect(band.querySelectorAll(".wall-metric-title svg")).toHaveLength(4);
  });

  it("uses fresh snapshot counts while withholding a history whose endpoint differs", () => {
    const w = weeks();
    w.blocked.history = [{ t: "2026-09-21", v: 0 }, { t: "2026-09-22", v: 1 }];
    const summary = { ...work(w), blocked: 4 };
    const { container } = render(<WallWork assets={[asset("a.example", summary)]} operator={operator} nowMs={NOW} />);
    const blocked = within(container).getByRole("region", { name: "Blocked" });
    expect(blocked.querySelector(".wall-metric-value")).toHaveTextContent("4");
    expect(blocked.querySelector(".wall-metric-movement")).toHaveTextContent("4vs a week ago");
    expect(blocked).toHaveTextContent("History unavailable");
  });

  it("shows stale source counts with a stale label and no state comparison", () => {
    const summary = { ...work(weeks()), capturedAt: at(48) };
    const { container } = render(<WallWork assets={[asset("a.example", summary)]} operator={null} nowMs={NOW} />);
    expect(container).toHaveTextContent("Snapshot stale");
    const blocked = within(container).getByRole("region", { name: "Blocked" });
    expect(blocked.querySelector(".wall-metric-movement")).toBeNull();
    expect(blocked.querySelector("svg[role=img]")).toBeNull();
  });

  it("uses daily closes under a cumulative line and last week's total without project bars", () => {
    const w = weeks();
    w.done.history = [{ t: "2026-09-21", v: 2 }, { t: "2026-09-22", v: 6 }];
    const { container } = render(<WallWork assets={[asset("a.example", work(w)), asset("b.example", work(w))]} operator={operator} nowMs={NOW} />);
    const done = within(container).getByRole("region", { name: "Done this week" });
    expect(done).toHaveTextContent("12");
    expect(done).toHaveTextContent("Last week total · 30");
    expect(Array.from(done.querySelectorAll("[data-metric-daily-bar]"), bar => bar.getAttribute("data-value"))).toEqual(["4", "8"]);
    expect(done.querySelector("[data-chart-line='solid']")).not.toBeNull();
    expect(done.querySelector("[data-chart-line='projection']")).toBeNull();
    expect(done.querySelector("[data-metric-previous-total]")).not.toBeNull();
    expect(done.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("[data-pace-bar], [data-work-row]")).toBeNull();
  });

  it("keeps trailing closes out of this week's total when history is absent", () => {
    const { container } = render(<WallWork assets={[asset("a.example", work(undefined, 99))]} operator={operator} nowMs={NOW} />);
    const done = within(container).getByRole("region", { name: "Done this week" });
    expect(done).toHaveTextContent("History unavailable");
    expect(done).not.toHaveTextContent("99");
  });

  it("preserves partial and stale inbox counts and withholds their comparisons", () => {
    const { container } = render(<WallWork assets={[asset("a.example", work(weeks()))]} operator={{ ...operator, waiting: 3, measuredProjects: 1 }} nowMs={NOW} />);
    const decisions = within(container).getByRole("region", { name: "Your decisions" });
    expect(decisions.querySelector('.wall-metric-qualifier')).toHaveTextContent("At least");
    expect(decisions.querySelector('.wall-metric-value')).toHaveTextContent("3");
    expect(decisions).toHaveTextContent("Some projects unread");
    expect(decisions.querySelector(".wall-metric-movement")).toBeNull();
    expect(decisions.querySelector(".wall-metric-axis")).toBeNull();
  });

  it("uses each state's improvement direction and keeps in progress neutral", () => {
    const { container } = render(<WallWork assets={[asset("a.example", work(weeks())), asset("b.example", work(weeks()))]} operator={operator} nowMs={NOW} />);
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
