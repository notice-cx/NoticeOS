import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FlagRecord, WatchWindowItem } from "@shared/asset-detail";
import { activityEvents } from "@/routes/asset-detail/activity-timeline";
import { siteSourceGraph } from "@/routes/asset-detail/source-graph";
import { ChangeRows, changeScale } from "@/components/viz/ChangeRows";
import { FunnelBars } from "@/components/viz/FunnelBars";
import { siteAlertTimeline } from "@/routes/asset-detail/AlertsTab";
import { growthMoves } from "@/routes/asset-detail/growth-moves";
import { siteEquation, siteEstimatePace, siteLastMonth, siteMonthDays } from "@/routes/asset-detail/site-money";
import { ledgerMonth } from "@/routes/asset-detail/overview-metrics";
import { everyTabPayload } from "./asset-detail-fixture";

// The pictures a site's tabs open on, read from the same derivations their
// numbers come from: each case pins what a picture claims, not its markup.

const NOW = Date.parse("2026-07-05T14:00:00.000Z");
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.UTC(2026, 5, 8 + offset)).toISOString().slice(0, 10);
const trend = (values: number[]) => ({
  series: values.map((v, index) => ({ t: day(index), v })),
  provisionalFrom: null,
  collectedAt: "2026-07-05T11:45:00.000Z",
  timeZoneChanges: [],
});

describe("Growth's board of moves", () => {
  it("states each series' window figure and its move in the good direction", () => {
    const performance = {
      ...everyTabPayload().performance,
      sessions: trend([...Array<number>(7).fill(100), ...Array<number>(7).fill(150)]),
      searchPosition: trend([...Array<number>(7).fill(10), ...Array<number>(7).fill(8)]),
      webSearchImpressions: { google: trend(Array<number>(14).fill(100)), bing: trend([]) },
    };
    const moves = growthMoves(performance, 7);
    const sessions = moves.find((move) => move.key === "sessions")!;
    expect(sessions.value).toBe(1050);
    expect(sessions.improvement).toBe(50);
    // The earlier window's daily level is the strip's dashed line.
    expect(sessions.baseline).toBe(100);
    const position = moves.find((move) => move.key === "search-position")!;
    // Position 10 → 8 is a 20% fall in the number and a 20% improvement.
    expect(position.improvement).toBeCloseTo(20);
    expect(position.group).toBe("search");
  });

  it("draws a rate in percent, so its days have height on a strip whose floor is one", () => {
    const performance = {
      ...everyTabPayload().performance,
      searchCtr: trend(Array<number>(14).fill(0.04)),
      webSearchClicks: { google: trend(Array<number>(14).fill(4)), bing: trend([]) },
      webSearchImpressions: { google: trend(Array<number>(14).fill(100)), bing: trend([]) },
    };
    const ctr = growthMoves(performance, 7).find((move) => move.key === "search-ctr")!;
    expect(ctr.format(ctr.value!)).toBe("4.0%");
    expect(ctr.days.at(-1)!.v).toBeCloseTo(4);
    expect(ctr.stripFormat(4)).toBe("4.0%");
  });

  it("leaves a series with fewer than three reported days off the board", () => {
    const performance = { ...everyTabPayload().performance, pageViews: trend([10, 12]) };
    expect(growthMoves(performance, 7).some((move) => move.key === "page-views")).toBe(false);
  });

  it("grows a better move right and a worse one left from one zero line, on one scale", () => {
    const { container } = render(
      <ChangeRows
        title="Visitors"
        against="vs prior 7 days"
        rows={[
          { key: "up", label: "Up", figure: "10", improvement: 40 },
          { key: "down", label: "Down", figure: "5", improvement: -10 },
          { key: "none", label: "None", figure: null, absent: "too few days yet", improvement: null },
        ]}
      />,
    );
    const bar = (key: string) => container.querySelector(`[data-change-row="${key}"] [data-change-bar]`)!;
    expect(bar("up")).toHaveAttribute("data-change-bar", "better");
    expect(bar("down")).toHaveAttribute("data-change-bar", "worse");
    expect(bar("none")).toHaveAttribute("data-change-bar", "none");
    expect(container.querySelector('[data-change-row="none"] [data-change-absent]')).toHaveTextContent("too few days yet");
    expect(changeScale([40, -10, null])).toBe(40);
    expect(changeScale([2])).toBe(10);
    expect(changeScale([400])).toBe(100);
  });
});

describe("FunnelBars", () => {
  it("hatches a step nobody measured instead of drawing a zero", () => {
    const { container } = render(
      <FunnelBars
        ariaLabel="Ranks"
        shares
        steps={[
          { key: "tracked", label: "Tracked", value: 10 },
          { key: "top10", label: "Top 10", value: 4 },
          { key: "cites", label: "Cites us", value: null, note: "not checked" },
        ]}
      />,
    );
    const step = (key: string) => container.querySelector(`[data-funnel-step="${key}"]`)!;
    expect(step("top10").textContent).toContain("4");
    expect(step("top10").textContent).toContain("40%");
    expect(step("cites").textContent).toContain("—");
    expect(step("cites").textContent).toContain("not checked");
    expect(step("cites").querySelector(".viz-hatch")).not.toBeNull();
    expect(step("cites").textContent).not.toMatch(/\b0\b/);
  });
});

describe("Money's month", () => {
  const history = {
    from: "2026-05-01",
    to: "2026-07-04",
    reportedThrough: "2026-07-04",
    days: [
      ...Array.from({ length: 30 }, (_, index) => ({ date: `2026-06-${String(index + 1).padStart(2, "0")}`, amountMinor: 1000 })),
      { date: "2026-07-01", amountMinor: 1200 },
      { date: "2026-07-02", amountMinor: 1300 },
      { date: "2026-07-04", amountMinor: 1100 },
    ],
  };

  it("draws a day the source did not report as a gap, never a zero", () => {
    const days = siteMonthDays(history, "2026-07", "2026-07-04", "meadow.example", "Meadow Board")!;
    expect(days.days.map((point) => point.v)).toEqual([12, 13, null, 11]);
    expect(days.usualDay).toBeCloseTo(12);
    expect(days.short).toEqual([]);
  });

  it("states no month so far over a missing day, and last month only when every day of it reported", () => {
    expect(siteEstimatePace(history, "2026-07", "2026-07-04")).toBeNull();
    const pace = siteEstimatePace(history, "2026-07", "2026-07-02")!;
    expect(pace.value).toBe(25);
    expect(pace.previousAtSameDay).toBe(20);
    expect(pace.previousTotal).toBe(300);
    const gappy = { ...history, days: history.days.filter((entry) => entry.date !== "2026-06-15") };
    expect(siteEstimatePace(gappy, "2026-07", "2026-07-02")!.previousTotal).toBeNull();
  });

  it("reads the equation from the booked rows and never adds the estimate in", () => {
    const data = everyTabPayload();
    data.ledger = {
      ...data.ledger,
      empty: false,
      periods: [
        {
          period: "2026-07",
          booked: { figure: { currency: "USD", revenue: 0, cost: 69, net: -69 }, revenueByFamily: [], costByFamily: [{ currency: "USD", family: "infra", amount: 69 }] },
          forecast: { figure: { currency: "USD", revenue: 655, cost: 0, net: 655 }, revenueByFamily: [{ currency: "USD", family: "ads", amount: 655 }], costByFamily: [] },
        },
        {
          period: "2026-06",
          booked: { figure: { currency: "USD", revenue: 1890, cost: 68, net: 1822 }, revenueByFamily: [{ currency: "USD", family: "ads", amount: 1890 }], costByFamily: [] },
          forecast: { figure: { currency: "USD", revenue: 0, cost: 0, net: 0 }, revenueByFamily: [], costByFamily: [] },
        },
      ],
    };
    const equation = siteEquation(data.ledger, ledgerMonth(data.ledger)!, "2026-07")!;
    expect(equation).toMatchObject({ period: "2026-07", open: true, revenue: 0, cost: 69, net: -69, costRecorded: true });
    expect(siteLastMonth(data.ledger, equation)).toEqual({ period: "2026-06", revenue: 1890 });
  });
});

describe("Activity's last ninety days", () => {
  const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
  const watch = (over: Partial<WatchWindowItem>): WatchWindowItem => ({
    id: "w1", metricIntegration: "ga4", metric: "sessions", scope: null, refKind: "manual", ref: "redesign",
    registeredAt: ago(40), nextCheckDate: null, readings: 2, checks: 2, status: "closed", outcome: "kill_confirmed",
    outcomeNote: null, closedAt: ago(8), note: "Trail page redesign", ...over,
  });

  it("marks each change on its row and a bet where it began and where its verdict came in", () => {
    const events = activityEvents(
      [
        { id: 1, at: ago(36), kind: "deploy", ref: null, note: "Trail page redesign. Shipped behind no flag." },
        { id: 2, at: ago(5), kind: "incident", ref: null, note: "Host outage" },
        { id: 3, at: ago(120), kind: "config", ref: null, note: "Too old to draw" },
      ],
      { open: [watch({ id: "w2", status: "open", outcome: null, closedAt: null, registeredAt: ago(3), note: null })], closed: [watch({})] },
      NOW,
    );
    expect(events.map((event) => [event.id, event.lane, event.kind, event.severity ?? null])).toEqual([
      ["change:1", "changes", "shipped", null],
      ["change:2", "changes", "problem", "error"],
      ["watch:w2:start", "bets", "note", null],
      ["watch:w1:start", "bets", "note", null],
      ["watch:w1:verdict", "bets", "problem", "warn"],
    ]);
    expect(events[0]!.label).toBe("Trail page redesign");
    expect(events.at(-1)!.label).toBe("Trail page redesign · decline confirmed");
  });

  it("opens the task a mark names: a change's ref, the task a bet watches, a verdict's readback task", () => {
    const events = activityEvents(
      [
        { id: 1, at: ago(36), kind: "deploy", ref: "md-1w2", note: "Trail page redesign" },
        { id: 2, at: ago(30), kind: "config", ref: "cache rule", note: "Cache rule" },
      ],
      {
        open: [watch({ id: "w2", status: "open", outcome: null, closedAt: null, registeredAt: ago(3), refKind: "decision", ref: "md-9k1" })],
        closed: [
          watch({ readbackTaskId: "md-r4.1" }),
          // An annotation ref is the change's own id, never a task's.
          watch({ id: "w3", refKind: "annotation", ref: "md-2" }),
        ],
      },
      NOW,
    );
    const href = (id: string) => events.find((event) => event.id === id)?.href ?? null;
    expect(href("change:1")).toBe("/tasks/md-1w2");
    expect(href("change:2")).toBeNull();
    expect(href("watch:w2:start")).toBe("/tasks/md-9k1");
    expect(href("watch:w1:start")).toBeNull();
    expect(href("watch:w1:verdict")).toBe("/tasks/md-r4.1");
    expect(href("watch:w3:start")).toBeNull();
    expect(href("watch:w3:verdict")).toBeNull();
  });
});

describe("Data sources' graph", () => {
  const columns = [
    { id: "ga4", label: "Google Analytics", short: "GA4" },
    { id: "bing-webmaster", label: "Bing Webmaster Tools", short: "Bing" },
    { id: "uptime", label: "Uptime monitoring", short: "Uptime" },
    { id: "clarity", label: "Microsoft Clarity", short: "Clarity" },
    { id: "nightly-report", label: "Nightly report", short: "Report" },
  ];

  it("draws each connected source into the asset, lights the failing one and names the rest", () => {
    const graph = siteSourceGraph(
      {
        id: "meadow.example",
        name: "Meadow Board",
        cells: [
          { column: "ga4", state: "not-connected" },
          { column: "bing-webmaster", state: "working", detail: "35 daily rows" },
          { column: "uptime", state: "failing", detail: "HTTP 503", since: "2026-07-05T13:20:00.000Z" },
          { column: "clarity", state: "not-using" },
          { column: "nightly-report", state: "overdue", detail: "Due daily" },
        ],
      },
      columns,
      { id: "meadow.example", name: "Meadow Board" },
    );
    expect(graph.nodes.map((node) => [node.id, node.state, node.caption ?? null])).toEqual([
      ["bing-webmaster", "ok", null],
      ["uptime", "error", "HTTP 503"],
      ["nightly-report", "warn", "Due daily"],
      ["meadow.example", "error", null],
    ]);
    expect(graph.nodes.find((node) => node.id === "nightly-report")!.label).toBe("Nightly report");
    expect(graph.edges.every((edge) => edge.to === "meadow.example")).toBe(true);
    expect(graph.notConnected).toEqual(["GA4"]);
  });
});

describe("Alerts' last thirty days", () => {
  const base = everyTabPayload().flags.open[0]!;
  const flag = (over: Partial<FlagRecord>): FlagRecord => ({ ...base, ...over });
  const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

  it("draws one row per condition, open first, and only what settled inside the window", () => {
    const flags = {
      ...everyTabPayload().flags,
      open: [
        flag({ id: 1, severity: "warn", ruleId: "flow-poisson-low", metric: "signups", firstFiredAt: ago(2) }),
        flag({ id: 2, severity: "error", ruleId: "uptime-down", metric: null, firstFiredAt: ago(0.1) }),
        flag({ id: 3, severity: "info", kind: "milestone", ruleId: "growth-threshold", metric: "sessions", firstFiredAt: ago(3) }),
      ],
      history: [
        flag({ id: 4, severity: "warn", ruleId: "flow-poisson-low", metric: "signups", firstFiredAt: ago(9), resolvedAt: ago(8) }),
        flag({ id: 5, severity: "warn", ruleId: "ingest-freshness", metric: null, firstFiredAt: ago(45), resolvedAt: ago(40) }),
      ],
    };
    const { lanes, spans } = siteAlertTimeline(flags, NOW);
    expect(lanes.map((lane) => lane.id)).toEqual(["uptime-down:", "flow-poisson-low:signups"]);
    expect(spans.map((span) => [span.id, span.lane, span.to === null ? "open" : "closed"])).toEqual([
      ["open:1", "flow-poisson-low:signups", "open"],
      ["open:2", "uptime-down:", "open"],
      ["settled:4", "flow-poisson-low:signups", "closed"],
    ]);
  });
});
