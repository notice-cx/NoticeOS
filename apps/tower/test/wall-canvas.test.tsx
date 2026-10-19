// The Wall draws a layout document. The default: the strip, then the loop;
// below them two columns, the last 24 hours over the site rows beside revenue
// over the work. A layout naming retired widgets is read as the default, never
// refused and never blank, by both `parseWallConfig` and the route's own read.

import { render } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { CalendarUpcoming, Ga4RealtimePayload } from "@noticeos/contract";
import type { AssetCard, WallPayload } from "@shared/wall";
import { DEFAULT_WALL_LAYOUT, parseWallConfig, type WallLayout } from "@shared/wall-layout";
import { WallCanvas } from "@/components/WallCanvas";

const NOW = Date.parse("2026-09-05T12:05:00.000Z");
vi.mock("@/hooks/useNow", () => ({ useNow: () => Date.parse("2026-09-05T12:05:00.000Z") }));

// The feed polls on its own; here it answered with one row.
vi.mock("@/hooks/useWallFeed", () => ({
  useWallFeed: () => ({
    data: {
      generatedAt: "2026-09-05T12:05:00.000Z",
      since: "2026-09-05T01:00:00.000Z",
      limit: 50,
      items: [{
        id: "task-1", at: "2026-09-05T11:40:00.000Z", kind: "task-done", label: "Task done",
        asset: "meadow.example", site: "Meadow Board", text: "Recipe cards load faster", count: 1, tone: "healthy",
      }],
    },
    isError: false,
  }),
}));

function asset(id: string, displayName: string): AssetCard {
  return { netByMonthCurrency: 'USD',
    id,
    displayName,
    status: "live",
    senseOnly: false,
    worstSeverity: null,
    openError: 0,
    openWarn: 0,
    booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
    forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
    netPeriod: "2026-09",
    pulseReceivedAt: "2026-09-05T11:00:00.000Z",
    firstReportAt: null,
    dataSources: [],
    activeUsers: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
    work: {
      open: 3,
      highPriority: 1,
      inProgress: 1,
      blocked: 0,
      closedRecent: 2,
      priorities: [0, 1, 2, 0, 0],
      capturedAt: "2026-09-05T12:04:50.000Z",
    },
    panelReview: null,
    searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
    netByMonth: [],
    netByMonthProvisionalFrom: null,
    latestPanelDate: null,
  };
}

const MEETINGS: CalendarUpcoming = {
  fetchedAt: "2026-09-05T12:05:00.000Z",
  feedsConfigured: 1,
  feedsOk: 1,
  calendars: [{ id: "work", color: null, status: "ok" }],
  meetings: [
    {
      calendar: "work",
      title: "Standup",
      startsAt: "2026-09-05T12:00:00.000Z",
      endsAt: "2026-09-05T12:30:00.000Z",
      allDay: false,
      location: null,
    },
  ],
};

const REALTIME: Ga4RealtimePayload = {
  generatedAt: "2026-09-05T12:05:00.000Z",
  assets: [],
};

const PAYLOAD: WallPayload = {
  generatedAt: "2026-09-05T12:02:00.000Z",
  portfolio: { netTrendCurrency: 'USD', netTrendAllCurrency: 'USD',
    period: "2026-09",
    periodIsCurrent: true,
    booked: { currency: 'USD', revenue: 400, cost: 100, net: 300 },
    forecast: { currency: 'USD', revenue: 120, cost: 0, net: 120 },
    netTrend: [{ t: "2026-09", v: 300 }],
    netTrendAll: [{ t: "2026-09", v: 300 }],
    trendGranularity: "monthly",
    bookedDelta: null,
    residue: {
      booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
      forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
    },
    firstRun: false,
    daysIn: 5,
  },
  system: {
    assetId: "root-os",
    hasPulse: true,
    spendTodayUsd: 1,
    dailyCapUsd: 2,
    ingest: { fresh: 2, stale: 0, notExpected: 0, expected: 2 },
    scheduledLanes: [{ job: "backup", outcome: "ran", startedAt: "2026-09-05T11:00:00.000Z", lastRanAt: "2026-09-05T11:00:00.000Z", failedRuns: 0, failingSince: null }],
  },
  dashboard: {
    countdown: { emoji: "🌁", label: "Team offsite", targetAt: "2026-10-01T07:00:00.000Z" },
  },
  assets: [asset("meadow.example", "Meadow Board"), asset("northwind.example", "Northwind")],
  attention: [
    {
      id: 1,
      asset: "meadow.example",
      assetDisplayName: "Meadow Board",
      severity: "error",
      kind: "anomaly",
      message: "Pulse missing",
      firedAt: "2026-09-05T09:00:00.000Z",
      metric: null,
      ruleId: "ingest-freshness",
      ruleInputs: null,
      correlatedChanges: [],
      occurrences: 1,
      firstFiredAt: "2026-09-05T09:00:00.000Z",
    },
    {
      id: 2,
      asset: "northwind.example",
      assetDisplayName: "Northwind",
      severity: "warn",
      kind: "anomaly",
      message: "Clicks down",
      firedAt: "2026-09-05T10:00:00.000Z",
      metric: "clicks",
      ruleId: "volume-drop",
      ruleInputs: null,
      correlatedChanges: [],
      occurrences: 1,
      firstFiredAt: "2026-09-05T10:00:00.000Z",
    },
  ],
  snoozed: [],
  operator: {
    waiting: 1,
    urgent: 0,
    measuredProjects: 2,
    urgentMeasuredProjects: 2,
    projectCount: 2,
    capturedAt: "2026-09-05T12:04:50.000Z",
  },
  ledgerRecordedAt: "2026-09-05T12:00:00.000Z",
};

/** A Wall holding nothing but retired widgets. */
const PRE_D28_SAVE = {
  layout: {
    version: 1,
    rows: [
      { id: "horizon", height: "auto", widgets: [
        { id: "attention", type: "attention", width: 1.7 },
        { id: "portfolio", type: "portfolio", width: 0.55 },
        { id: "system", type: "system", width: 0.75 },
      ] },
      { id: "time", height: "auto", widgets: [
        { id: "clock", type: "clock", width: 0.95 },
        { id: "meetings", type: "meetings", width: 0.9 },
        { id: "countdown", type: "countdown", width: 1.3 },
      ] },
      { id: "assets", height: "fill", widgets: [{ id: "assets", type: "assets", width: 1, settings: { assets: ["northwind.example"] } }] },
    ],
  },
  history: [],
};

function canvas(
  layout: WallLayout,
  overrides: Partial<WallPayload> = {},
  /** `null` is "no calendar answered", which is a case; `undefined` is "default". */
  meetings: CalendarUpcoming | null = MEETINGS,
  lastGood = false,
) {
  return render(
    <WallCanvas
      layout={layout}
      data={{ ...PAYLOAD, ...overrides }}
      nowMs={NOW}
      meetings={meetings}
      ga4Realtime={REALTIME}
      ga4RealtimeError={false}
      lastGood={lastGood}
    />,
  );
}

/**
 * A row's column tracks as `<floor>|<weight>` pairs, from the TV template the
 * canvas states inline. `0`, `0rem` and `min(0rem, 100%)` are one floor. A
 * track beside a capped widget also takes the row less the gaps and the caps:
 * `<floor>+rest-<caps>rem`.
 */
function tracks(row: Element): string[] {
  const inline = /--wall-row-tracks:\s*([^;]+)/u.exec(row.getAttribute("style") ?? "")?.[1] ?? "";
  return [...inline.replaceAll(/\s+/gu, " ").matchAll(/minmax\((.+?),\s*([\d.]+fr)\)/gu)].map(([, floor, weight]) => {
    const rest = /^max\((.+?), calc\(\(100% - \d+ \* var\(--wall-region-gap-x\) - ([\d.]+)rem\) \* [\d.]+ \/ [\d.]+\)\)$/u.exec(floor ?? "");
    const bare = (rest?.[1] ?? floor ?? "").replace(/^min\((.+),\s*100%\)$/u, "$1").trim();
    return `${bare === "0" ? "0rem" : bare}${rest ? `+rest-${rest[2]}rem` : ""}|${weight}`;
  });
}

const REGIONS = ["strip", "loop", "revenue", "sites", "timeline", "work", "needs", "feed"] as const;

/** Every region the canvas drew, in document order. */
function regions(root: Element): string[] {
  return [...root.querySelectorAll(REGIONS.map((name) => `[data-wall-${name}]`).join(", "))]
    .map((el) => REGIONS.find((name) => el.hasAttribute(`data-wall-${name}`))!);
}

/** The default's regions, in reading order. */
const DEFAULT_REGIONS = ["strip", "loop", "timeline", "sites", "revenue", "work"];

/** Marks of the retired widgets. */
const RETIRED_MARKS = [
  "[data-attention-rail]",
  "[data-system-posture]",
  "[data-property-card]",
  "[data-property-grid]",
  "[data-clock-date-row]",
  "[data-meetings-panel]",
  "[data-proximity]",
  "[data-source]",
  "[data-widget-shell]",
].join(", ");

describe("the Wall nobody rearranged is the default", () => {
  it("draws the strip and the loop, then the last 24 hours over the sites beside revenue over the work", () => {
    const view = canvas(DEFAULT_WALL_LAYOUT);
    const canvasEl = view.container.querySelector("[data-wall-canvas]")!;
    expect([...canvasEl.children].map((row) => [row.getAttribute("data-wall-row"), row.getAttribute("data-wall-row-height")])).toEqual([
      ["strip", "auto"],
      ["loop", "auto"],
      ["body", "fill"],
    ]);
    const body = view.container.querySelector("[data-wall-row='body']")!;
    const rowsOf = (id: string) => [...body.querySelector(`:scope > [data-wall-column='${id}']`)!.children].map((row) => row.getAttribute("data-wall-row"));
    expect(rowsOf("business")).toEqual(["timeline", "sites"]);
    expect(rowsOf("side")).toEqual(["money", "work"]);
    expect(regions(view.container)).toEqual(DEFAULT_REGIONS);
    // Needs attention and the feed stay in the library, off the default.
    expect(view.container.querySelector("[data-wall-needs], [data-wall-feed]")).toBeNull();
  });

  it("draws the loop's five stages, the timeline's problems and the work, all read-only", () => {
    const view = canvas(DEFAULT_WALL_LAYOUT);
    expect([...view.container.querySelectorAll("[data-wall-loop] [data-flow-node]")].map((node) => node.getAttribute("data-flow-node"))).toEqual([
      "sense", "attribute", "decide", "act", "learn",
    ]);
    // Two sites' work in progress, and the one person-task waiting.
    expect(view.container.querySelector('[data-flow-node="act"]')?.textContent).toContain("2");
    expect(view.container.querySelector('[data-flow-node="decide"]')).toHaveAttribute("data-state", "ok");
    // The payload's error and warning as bars on their sites' rows, the feed's task as a mark.
    const timeline = view.container.querySelector("[data-wall-timeline]")!;
    expect(timeline).toHaveAttribute("data-wall-timeline", "problems");
    expect(timeline.querySelector('[data-lane="meadow.example"] [data-span][data-severity="error"]')).not.toBeNull();
    expect(timeline.querySelector('[data-lane="northwind.example"] [data-span][data-severity="warn"]')).not.toBeNull();
    expect(timeline.querySelector('[data-event="task-1"]')).not.toBeNull();
    expect(view.container.querySelectorAll("[data-wall-work] [data-work-row]")).toHaveLength(2);
    // Nothing to press on the TV: no buttons, and the strip's Home is the one link.
    expect(view.container.querySelectorAll("button")).toHaveLength(0);
    expect(view.container.querySelectorAll("a")).toHaveLength(1);
  });

  // On a portrait tablet or a phone the rows dissolve and the Wall is one
  // column read in the operator's order: the sites before the problems and the
  // work, because their numbers are the state of the business.
  it("stacks below the TV in one order whatever the layout: strip, revenue, sites, problems, work, feed, loop", () => {
    const view = canvas(DEFAULT_WALL_LAYOUT);
    for (const row of view.container.querySelectorAll("[data-wall-row]")) expect(row).toHaveClass("contents", "tv:grid");
    expect(view.container.querySelector("[data-wall-column]")).toHaveClass("contents", "tv:flex");
    const slots = [...view.container.querySelectorAll<HTMLElement>("[data-wall-slot]")];
    const stacked = [...slots].sort((a, b) => Number(a.style.order) - Number(b.style.order));
    expect(stacked.map((slot) => slot.getAttribute("data-wall-slot"))).toEqual(["strip", "revenue", "sites", "timeline", "work", "loop"]);
    for (const slot of slots) expect(slot).toHaveClass("tv:contents");
    view.unmount();
    const turned = canvas({
      ...DEFAULT_WALL_LAYOUT,
      rows: [
        { id: "feed-row", height: "auto", widgets: [{ id: "feed", type: "feed", width: 1 }] },
        { id: "rest", height: "fill", widgets: [
          { id: "needs", type: "needs", width: 1 },
          { id: "sites", type: "sites", width: 1 },
          { id: "revenue", type: "revenue", width: 1 },
          { id: "strip", type: "strip", width: 1 },
        ] },
      ],
    });
    const again = [...turned.container.querySelectorAll<HTMLElement>("[data-wall-slot]")].sort(
      (a, b) => Number(a.style.order) - Number(b.style.order),
    );
    expect(again.map((slot) => slot.getAttribute("data-wall-slot"))).toEqual(["strip", "revenue", "sites", "needs", "feed"]);
  });

  it("gives the business column its 1.4 to the side's 1, with no floor on either", () => {
    const view = canvas(DEFAULT_WALL_LAYOUT);
    const row = (id: string) => tracks(view.container.querySelector(`[data-wall-row='${id}']`)!);
    expect(row("strip")).toEqual(["0rem|1fr"]);
    expect(row("loop")).toEqual(["0rem|1fr"]);
    expect(row("body")).toEqual(["0rem|1.4fr", "0rem|1fr"]);
    for (const id of ["money", "sites", "timeline", "work"]) expect(row(id), id).toHaveLength(1);
  });

  it("gives the body the height the strip and loop leave, the site rows what the timeline leaves, the work what revenue leaves", () => {
    const view = canvas(DEFAULT_WALL_LAYOUT);
    // At the TV's width (`tv:`), where the rows are boxes.
    for (const id of ["body", "sites", "work"]) {
      expect(view.container.querySelector(`[data-wall-row='${id}']`), id).toHaveClass("tv:min-h-0", "tv:flex-1");
    }
    for (const id of ["strip", "loop", "money", "timeline"]) {
      expect(view.container.querySelector(`[data-wall-row='${id}']`), id).not.toHaveClass("tv:flex-1");
    }
  });

  it("shares a column's height by its rows' sizes when they have them, the fill row weighing one", () => {
    const sized = JSON.parse(JSON.stringify(DEFAULT_WALL_LAYOUT)) as typeof DEFAULT_WALL_LAYOUT;
    const business = sized.rows[2]!.widgets[0]!;
    if (business.type !== "column") throw new Error("the default's first body slot is a column");
    business.rows[0]!.size = 1;
    business.rows[1]!.size = 2;
    const view = canvas(sized);
    const timeline = view.container.querySelector("[data-wall-row='timeline']")!;
    expect(timeline).toHaveClass("tv:grow-(--wall-row-grow)", "tv:basis-0", "tv:min-h-0");
    expect(timeline).not.toHaveClass("tv:flex-1");
    expect(timeline.getAttribute("style")).toContain("--wall-row-grow: 1");
    expect(view.container.querySelector("[data-wall-row='sites']")?.getAttribute("style")).toContain("--wall-row-grow: 2");
    // The other column is untouched: its rows still fit and fill.
    expect(view.container.querySelector("[data-wall-row='work']")).toHaveClass("tv:flex-1");
    expect(view.container.querySelector("[data-wall-row='money']")?.getAttribute("data-wall-row-size")).toBeNull();
  });

  it("spaces its regions on the frame tokens: 20px stacked, 28px side by side", () => {
    const view = canvas(DEFAULT_WALL_LAYOUT);
    expect(view.container.querySelector("[data-wall-canvas]")).toHaveClass("gap-wall-region");
    expect(view.container.querySelector("[data-wall-column]")).toHaveClass("tv:gap-wall-region");
    for (const row of view.container.querySelectorAll("[data-wall-row]")) {
      expect(row).toHaveClass("tv:gap-x-wall-region-x", "tv:gap-y-wall-region");
    }
  });

  it("draws nothing retired from the Wall", () => {
    const view = canvas(DEFAULT_WALL_LAYOUT);
    expect(view.container.querySelector(RETIRED_MARKS)).toBeNull();
    expect(view.container.textContent).not.toMatch(/Monthly net|Local time|All-time totals|Automation enabled|Monitor only|7d avg/);
  });
});

describe("a layout naming retired widgets", () => {
  it("is read as the default and drawn whole — never refused, never blank", () => {
    const config = parseWallConfig(PRE_D28_SAVE);
    expect(config.retired?.replaced).toBe(true);
    const view = canvas(config.layout);
    expect(regions(view.container)).toEqual(DEFAULT_REGIONS);
    expect(view.container.querySelector(RETIRED_MARKS)).toBeNull();
    expect(view.container.querySelectorAll("[data-site-row]")).toHaveLength(2);
  });

  it("is drawn as the default by the TV route even when it reaches the page unparsed", async () => {
    vi.resetModules();
    vi.doMock("@/hooks/useWall", () => ({
      useWall: () => ({ data: { ...PAYLOAD, dashboard: { ...PAYLOAD.dashboard, wall: PRE_D28_SAVE } }, isError: false, isPending: false }),
    }));
    vi.doMock("@/hooks/useConnections", () => ({ useConnections: () => ({ credentials: undefined, items: null }) }));
    vi.doMock("@/hooks/useGa4Realtime", () => ({ useGa4Realtime: () => ({ data: REALTIME, isError: false }) }));
    vi.doMock("@/hooks/useCalendarUpcoming", () => ({ useCalendarUpcoming: () => ({ data: MEETINGS, isError: false }) }));
    const { WallRoute } = await import("@/routes/WallRoute");
    // The route reads the browser runtime (the demo's view), so the owner
    // around it must come from the same fresh module graph.
    const { render: renderFresh } = await import("./render");
    const view = renderFresh(
      <MemoryRouter>
        <WallRoute />
      </MemoryRouter>,
    );
    expect(regions(view.container)).toEqual(DEFAULT_REGIONS);
    expect(view.container.querySelector(RETIRED_MARKS)).toBeNull();
    vi.doUnmock("@/hooks/useWall");
    vi.doUnmock("@/hooks/useConnections");
    vi.doUnmock("@/hooks/useGa4Realtime");
    vi.doUnmock("@/hooks/useCalendarUpcoming");
  });
});

describe("a rearranged layout", () => {
  const rearranged: WallLayout = {
    version: 1,
    rows: [
      {
        id: "body",
        height: "fill",
        widgets: [
          { id: "sites", type: "sites", width: 2, settings: { assets: ["northwind.example"] } },
          { id: "feed", type: "feed", width: 1 },
        ],
      },
      {
        id: "money",
        height: "auto",
        widgets: [
          { id: "revenue", type: "revenue", width: 1 },
          { id: "needs", type: "needs", width: 2.5, settings: { assets: ["northwind.example"] } },
        ],
      },
    ],
  };

  it("draws the rows in the document's order, not the default's", () => {
    const view = canvas(rearranged);
    const rows = [...view.container.querySelectorAll("[data-wall-row]")].map((row) => row.getAttribute("data-wall-row"));
    expect(rows).toEqual(["body", "money"]);
    expect(regions(view.container)).toEqual(["sites", "feed", "revenue", "needs"]);
  });

  it("drops the widgets the document does not list", () => {
    const view = canvas(rearranged);
    expect(view.container.querySelector("[data-wall-strip]")).toBeNull();
    expect(view.container.querySelector("[data-wall-column]")).toBeNull();
  });

  it("uses the widths and floors the document gives, in widget order", () => {
    const view = canvas(rearranged);
    expect(tracks(view.container.querySelector("[data-wall-row='body']")!)).toEqual(["0rem+rest-30rem|2fr", "21rem|1fr"]);
    expect(tracks(view.container.querySelector("[data-wall-row='money']")!)).toEqual(["0rem|1fr", "0rem|2.5fr"]);
  });

  it("shows only the sites a widget's filter lists, in the filter's order", () => {
    const both = canvas(DEFAULT_WALL_LAYOUT);
    expect(both.container.querySelectorAll("[data-site-row]")).toHaveLength(2);
    both.unmount();

    const view = canvas(rearranged);
    expect([...view.container.querySelectorAll("[data-site-row]")].map((row) => row.getAttribute("data-site-row"))).toEqual(["northwind.example"]);
    const needs = view.container.querySelector("[data-wall-needs]")!;
    expect(needs.textContent).not.toMatch(/Meadow Board/u);
  });
});

describe("the default's columns", () => {
  it("hands the editing slot each widget with its column, and the wrapper is the grid cell", () => {
    const view = render(
      <WallCanvas
        layout={DEFAULT_WALL_LAYOUT}
        data={PAYLOAD}
        nowMs={NOW}
        meetings={MEETINGS}
        editing={({ widget, row, rowIndex, column, index, node }) => (
          <div data-selected={`${column?.id ?? "-"}:${row.id}:${rowIndex}:${index}`} data-widget={widget.id}>
            {node}
          </div>
        )}
      />,
    );
    const chrome = [...view.container.querySelectorAll("[data-selected]")].map((el) => el.getAttribute("data-selected"));
    expect(chrome).toEqual([
      "-:strip:0:0",
      "-:loop:1:0",
      "business:timeline:0:0",
      "business:sites:1:0",
      "side:money:0:0",
      "side:work:1:0",
    ]);
    // The wrapper is the grid cell: the only box between it and the row is
    // the widget's slot, which is no box at all at the TV's width.
    const slot = view.container.querySelector("[data-wall-row='strip']")!.children[0]!;
    expect(slot).toHaveAttribute("data-wall-slot", "strip");
    expect(slot).toHaveClass("tv:contents");
    expect(slot.children[0]!.getAttribute("data-selected")).toBe("-:strip:0:0");
    expect(view.container.querySelector("[data-wall-column]")).toHaveClass("outline-dashed");

    view.unmount();
    const tv = canvas(DEFAULT_WALL_LAYOUT);
    expect(tv.container.querySelector("[data-wall-row='strip'] > [data-wall-slot]")!.children[0]!.hasAttribute("data-wall-strip")).toBe(true);
    expect(tv.container.querySelector("[data-wall-column]")).not.toHaveClass("outline-dashed");
  });
});

// The strip is a widget like any other, fed from the payload's system slice
// and countdown and the surface's own calendar poll.
describe("the top strip", () => {
  it("draws the time, current meeting and countdown with one Home link and no aggregate status", () => {
    const view = render(
      <MemoryRouter>
        <WallCanvas layout={DEFAULT_WALL_LAYOUT} data={PAYLOAD} nowMs={NOW} meetings={MEETINGS} ga4Realtime={REALTIME} />
      </MemoryRouter>,
    );
    const strip = view.container.querySelector("[data-wall-row='strip'] > [data-wall-slot] > [data-wall-strip]")!;
    // Numerals, and the locale's day period where it has one.
    expect(strip.querySelector("[data-strip-time]")?.textContent).toMatch(/^\d{1,2}[:.]\d{2}(AM|PM)?$/u);
    expect(strip.querySelector("[data-strip-meeting-cue]")?.textContent).toBe("Now");
    expect(strip.querySelector("[data-strip-meeting-title]")?.textContent).toBe("Standup");
    expect(strip.querySelector("[data-strip-meeting-distance]")?.textContent).toBe("25M left");
    expect(strip.querySelector("[data-strip-countdown]")?.textContent).toContain("Team offsite");
    expect(strip.querySelector("[data-system-state]")).toBeNull();
    expect(strip.querySelector("a[data-strip-home]")).toHaveAttribute("href", "/");
    expect(view.container.querySelectorAll("a")).toHaveLength(1);
  });

  it("says how old the values are only when the Wall's poll failed", () => {
    const fresh = canvas(DEFAULT_WALL_LAYOUT);
    expect(fresh.container.querySelector("[data-strip-held]")).toBeNull();
    fresh.unmount();

    const held = canvas(DEFAULT_WALL_LAYOUT, {}, MEETINGS, true);
    expect(held.container.querySelector("[data-strip-held]")?.textContent).toBe("Refreshed 3m ago · reconnecting");
  });

  it("puts an independent calendar failure on the timeline, retains events, and clears on recovery", () => {
    const calendarBar = (root: Element) => root.querySelector("[data-wall-timeline] [data-span^='calendar-read']");
    const view = render(<WallCanvas layout={DEFAULT_WALL_LAYOUT} data={PAYLOAD} nowMs={NOW} meetings={MEETINGS} calendarState="retrying" />);
    expect(view.container.querySelector("[data-strip-meeting-title]")).toHaveTextContent("Standup");
    expect(view.container.querySelector("[data-strip-calendar-status]")).toHaveTextContent("Retrying automatically");
    expect(calendarBar(view.container)).toBeNull();
    view.rerender(<WallCanvas layout={DEFAULT_WALL_LAYOUT} data={PAYLOAD} nowMs={NOW} meetings={MEETINGS} calendarState="failed" />);
    expect(view.container.querySelector("[data-strip-meeting-title]")).toHaveTextContent("Standup");
    expect(view.container.querySelector("[data-strip-calendar-status]")).toHaveTextContent("cached");
    // On the System's row, an error since an unknown time, named for a screen reader.
    expect(calendarBar(view.container)).toHaveAttribute("data-severity", "error");
    expect(view.container.querySelector("[data-event-timeline-list]")).toHaveTextContent("Events not updating");

    view.rerender(<WallCanvas layout={DEFAULT_WALL_LAYOUT} data={PAYLOAD} nowMs={NOW} meetings={MEETINGS} />);
    expect(view.container.querySelector("[data-strip-calendar-status]")).toBeNull();
    expect(calendarBar(view.container)).toBeNull();
    expect(view.container.querySelector("[data-strip-meeting-title]")).toHaveTextContent("Standup");
  });
});

describe("every default widget draws its own empty state", () => {
  it("keeps every region with no countdown, no calendar, no money and nothing wrong", () => {
    const view = canvas(
      DEFAULT_WALL_LAYOUT,
      {
        dashboard: {},
        attention: [],
        portfolio: { ...PAYLOAD.portfolio, booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 }, forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 }, netTrend: [], netTrendAll: [], firstRun: true },
      },
      null,
    );
    expect(regions(view.container)).toEqual(DEFAULT_REGIONS);
    expect(view.container.querySelector("[data-strip-countdown]")).toBeNull();
    expect(view.container.querySelector("[data-strip-meeting]")).toBeNull();
    expect(view.container.querySelector("[data-wall-revenue]")).toHaveAttribute("data-wall-revenue", "none");
    expect(view.container.querySelector("[data-wall-timeline]")).toHaveAttribute("data-wall-timeline", "calm");
    expect(view.container.querySelector("[data-timeline-status]")).toHaveTextContent("Nothing broken");
  });
});

// A site's own TV switch (`config/tower.json` `/sites`) takes it off every
// widget at once, whatever a widget's site list names; its Work this week
// switch takes its row out of Work alone. Revenue keeps the whole month.
describe("a site off the TV by its own setting", () => {
  const everything: WallLayout = {
    version: 1,
    rows: [
      { id: "top", height: "auto", widgets: [{ id: "strip", type: "strip", width: 1 }] },
      { id: "loop", height: "auto", widgets: [{ id: "loop", type: "loop", width: 1 }] },
      {
        id: "body",
        height: "fill",
        widgets: [
          { id: "sites", type: "sites", width: 1, settings: { assets: ["meadow.example", "northwind.example"] } },
          { id: "timeline", type: "timeline", width: 1 },
          { id: "work", type: "work", width: 1 },
          { id: "needs", type: "needs", width: 1 },
          { id: "feed", type: "feed", width: 1 },
          { id: "revenue", type: "revenue", width: 1 },
        ],
      },
    ],
  };
  const siteRows = (root: Element) => [...root.querySelectorAll("[data-site-row]")].map((row) => row.getAttribute("data-site-row"));

  it("is in no widget, even one whose own list names it", () => {
    const view = canvas(everything, { dashboard: { ...PAYLOAD.dashboard, sites: { "meadow.example": { tv: false } } } });
    expect(siteRows(view.container)).toEqual(["northwind.example"]);
    expect(view.container.querySelector('[data-wall-timeline] [data-lane="meadow.example"]')).toBeNull();
    expect(view.container.querySelectorAll("[data-wall-work] [data-work-row]")).toHaveLength(1);
    expect(view.container.querySelector("[data-wall-needs]")!.textContent).not.toMatch(/Meadow Board/u);
    expect(view.container.querySelector("[data-wall-feed]")!.textContent).not.toMatch(/Recipe cards load faster/u);
    // Only the other site's task is in progress on the loop.
    expect(view.container.querySelector('[data-flow-node="act"]')?.textContent).toContain("1");
  });

  it("leaves Work this week alone when only its Work switch is off", () => {
    const view = canvas(everything, { dashboard: { ...PAYLOAD.dashboard, sites: { "northwind.example": { work: false } } } });
    expect(siteRows(view.container)).toEqual(["meadow.example", "northwind.example"]);
    expect(view.container.querySelectorAll("[data-wall-work] [data-work-row]")).toHaveLength(1);
  });

  it("is a retired site until its TV switch is turned on", () => {
    const retired = [asset("meadow.example", "Meadow Board"), { ...asset("northwind.example", "Northwind"), status: "retired" }];
    const off = canvas(everything, { assets: retired });
    expect(siteRows(off.container)).toEqual(["meadow.example"]);
    off.unmount();
    const on = canvas(everything, { assets: retired, dashboard: { ...PAYLOAD.dashboard, sites: { "northwind.example": { tv: true } } } });
    expect(siteRows(on.container)).toEqual(["meadow.example", "northwind.example"]);
  });
});
