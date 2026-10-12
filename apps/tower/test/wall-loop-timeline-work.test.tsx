// The default Wall's three visual-kit widgets: the timeline draws the worst
// problems its fixed height holds and counts the rest, the loop draws no
// number its read did not produce, and the work chart never turns an unread
// inbox into zeros.

import { render } from "./render";
import { describe, expect, it } from "vitest";
import { NO_READS } from "@shared/connection-status";
import type { AssetCard } from "@shared/wall";
import { loopNodes } from "@/components/wall/WallLoop";
import { WALL_TIMELINE_ROWS, fitTimeline } from "@/components/wall/WallTimeline";
import { WallWork } from "@/components/wall/WallWork";
import type { TimelineEvent, TimelineSpan } from "@/components/viz/EventTimeline";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");
const FROM = NOW - 86_400_000;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

const lanes = ["a.example", "b.example", "c.example", "d.example", "system"].map((id) => ({ id, label: id }));
const span = (id: string, lane: string, severity: "error" | "warn", hoursAgo: number): TimelineSpan => ({
  id, lane, from: at(hoursAgo), to: null, severity, label: id,
});
const mark = (id: string, lane: string, hoursAgo: number): TimelineEvent => ({ id, lane, at: at(hoursAgo), kind: "win", label: id });

describe("the timeline's budget", () => {
  it("is Needs you's three", () => {
    expect(WALL_TIMELINE_ROWS).toBe(3);
  });

  it("draws errors before warnings, the newest first, and counts the problems it left out", () => {
    const fitted = fitTimeline(
      {
        lanes,
        spans: [span("old-warn", "a.example", "warn", 30), span("new-error", "b.example", "error", 1), span("old-error", "c.example", "error", 9), span("new-warn", "d.example", "warn", 2)],
        events: [mark("win", "a.example", 3)],
      },
      FROM, NOW, 3,
    );
    expect(fitted.spans.map((s) => s.id)).toEqual(["new-error", "old-error", "new-warn"]);
    expect(fitted.more).toBe(1);
    // No line left for marks: the problems took the three.
    expect(fitted.events).toEqual([]);
    expect(fitted.lanes.map((lane) => lane.id)).toEqual(["b.example", "c.example", "d.example"]);
  });

  it("gives what is left to rows of marks, a problem's own row first, and drops marks outside the window", () => {
    const fitted = fitTimeline(
      {
        lanes,
        spans: [span("error", "c.example", "error", 1)],
        events: [mark("a", "a.example", 2), mark("b", "b.example", 2), mark("c", "c.example", 2), mark("stale", "d.example", 30)],
      },
      FROM, NOW, 3,
    );
    expect(fitted.more).toBe(0);
    expect(fitted.events.map((e) => e.id)).toEqual(["a", "c"]);
    expect(fitted.lanes.map((lane) => lane.id)).toEqual(["a.example", "c.example"]);
  });
});

function asset(id: string, work: AssetCard["work"]): AssetCard {
  return {
    netByMonthCurrency: "USD", id, displayName: id, status: "live", senseOnly: false, worstSeverity: null, openError: 0, openWarn: 0,
    booked: { currency: "USD", revenue: 0, cost: 0, net: 0 }, forecast: { currency: "USD", revenue: 0, cost: 0, net: 0 },
    netPeriod: "2026-09", pulseReceivedAt: at(1), firstReportAt: null, dataSources: [],
    activeUsers: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] }, work, panelReview: null,
    searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] }, netByMonth: [], netByMonthProvisionalFrom: null, latestPanelDate: null,
  };
}

const WORK = { open: 4, highPriority: 1, inProgress: 2, blocked: 1, closedRecent: 3, priorities: [0, 1, 2, 1, 0], capturedAt: at(0) };

describe("the loop", () => {
  const byId = (nodes: ReturnType<typeof loopNodes>) => Object.fromEntries(nodes.map((node) => [node.id, node]));

  it("says what nothing has read yet instead of drawing zeros", () => {
    const nodes = byId(loopNodes({ assets: [asset("a.example", null)], attention: [], operator: null }, NO_READS, NOW));
    expect(nodes.sense).toMatchObject({ caption: "no sources yet", state: "idle" });
    expect(nodes.attribute).toMatchObject({ caption: "not measured yet", state: "absent" });
    expect(nodes.decide).toMatchObject({ caption: "not read", state: "idle" });
    expect(nodes.act).toMatchObject({ caption: "not read" });
    expect(nodes.learn).toMatchObject({ caption: "no reading due", state: "idle" });
    for (const id of ["sense", "attribute", "decide", "act", "learn"]) expect(nodes[id]?.value, id).toBeUndefined();
  });

  it("counts what it read: work in progress, and a partial inbox as a lower bound", () => {
    const operator = { waiting: 3, urgent: 1, measuredProjects: 1, urgentMeasuredProjects: 1, projectCount: 2, capturedAt: at(0) };
    const nodes = byId(loopNodes({ assets: [asset("a.example", WORK), asset("b.example", WORK)], attention: [], operator }, NO_READS, NOW));
    expect(nodes.act).toMatchObject({ value: "4", caption: "in progress", state: "active" });
    expect(nodes.decide).toMatchObject({ value: "3+", caption: "waiting on you · 1+ urgent", state: "warn" });
    const unknown = byId(loopNodes({ assets: [], attention: [], operator: { ...operator, waiting: 0, urgent: 0 } }, NO_READS, NOW));
    expect(unknown.decide).toMatchObject({ caption: "waiting on you · unknown" });
    expect(unknown.decide?.value).toBeUndefined();
  });
});

describe("the work chart", () => {
  it("is one quiet line when nothing was read at all, never a chart of unknowns", () => {
    const { container } = render(<WallWork assets={[asset("a.example", null)]} operator={null} nowMs={NOW} />);
    expect(container.querySelector("[data-wall-work]")).toHaveAttribute("data-wall-work", "none");
    expect(container.querySelector("[data-wall-work]")).toHaveTextContent("Tasks unknown");
    expect(container.querySelector("[data-work-flow]")).toBeNull();
  });

  it("reads the three totals as not read when only the inbox was counted", () => {
    const operator = { waiting: 1, urgent: 0, measuredProjects: 1, urgentMeasuredProjects: 1, projectCount: 1, capturedAt: at(0) };
    const { container } = render(<WallWork assets={[asset("a.example", null)]} operator={operator} nowMs={NOW} />);
    expect(container.querySelector("[data-wall-work]")?.textContent?.match(/not read/g)).toHaveLength(3);
    expect(container.querySelector('[role="table"]')).toBeNull();
    expect(container.querySelector("a, button")).toBeNull();
  });

  it("draws one row per project with its counts", () => {
    const operator = { waiting: 2, urgent: 0, measuredProjects: 2, urgentMeasuredProjects: 2, projectCount: 2, capturedAt: at(0) };
    const { container } = render(<WallWork assets={[asset("a.example", WORK), asset("b.example", WORK)]} operator={operator} nowMs={NOW} />);
    expect([...container.querySelectorAll("[data-work-row]")].map((row) => row.getAttribute("data-work-row"))).toEqual(["a.example", "b.example"]);
    expect(container.querySelector('[data-material-condition~="human-gates"]')).toHaveTextContent("Waiting on you2");
  });
});
