// The Wall draws a layout document (bead `ro-lzmq.1`), and the Wall nobody
// rearranged is D28's (bead `ro-trai.11`, docs/25-the-wall.md § Regions): the
// strip on top; below it a column — revenue beside Needs you, then the site
// rows — beside the full-height live feed.
//
// A LAYOUT SAVED BEFORE D28 names widgets the Wall no longer has. It is read,
// never refused and never blank, as the D28 default; both the contract's read
// (`parseWallConfig`) and the route's own are proven here.

import { render } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { CalendarUpcoming, Ga4RealtimePayload } from "@noticeos/contract";
import type { AssetCard, WallPayload } from "@shared/wall";
import { DEFAULT_WALL_LAYOUT, parseWallConfig, type WallLayout } from "@shared/wall-layout";
import { WallCanvas } from "@/components/WallCanvas";

const NOW = Date.parse("2026-09-05T12:05:00.000Z");
vi.mock("@/hooks/useNow", () => ({ useNow: () => Date.parse("2026-09-05T12:05:00.000Z") }));

// The feed polls on its own (bead ro-trai.9); here it answered with one row.
vi.mock("@/hooks/useWallFeed", () => ({
  useWallFeed: () => ({
    data: {
      generatedAt: "2026-09-05T12:05:00.000Z",
      since: "2026-09-05T01:00:00.000Z",
      limit: 50,
      items: [{
        id: "task-1", at: "2026-09-05T11:40:00.000Z", kind: "task-done", label: "Task done",
        asset: "meals.example", site: "Meal Planner", text: "Recipe cards load faster", count: 1, tone: "healthy",
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
    scheduledLanes: [{ job: "backup", outcome: "ran", startedAt: "2026-09-05T11:00:00.000Z" }],
  },
  dashboard: {
    countdown: { emoji: "🌁", label: "SF Trip", targetAt: "2026-10-01T07:00:00.000Z" },
  },
  assets: [asset("meals.example", "Meal Planner"), asset("nosh.example", "Nosh")],
  attention: [
    {
      id: 1,
      asset: "meals.example",
      assetDisplayName: "Meal Planner",
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
      asset: "nosh.example",
      assetDisplayName: "Nosh",
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

/** A Wall arranged before D28: nothing but widgets D28 retired. */
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
      { id: "assets", height: "fill", widgets: [{ id: "assets", type: "assets", width: 1, settings: { assets: ["nosh.example"] } }] },
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
 * track beside a capped widget also takes the row less the gaps and the caps
 * (bead ro-trai.31): `<floor>+rest-<caps>rem`.
 */
function tracks(row: Element): string[] {
  const inline = /--wall-row-tracks:\s*([^;]+)/u.exec(row.getAttribute("style") ?? "")?.[1] ?? "";
  return [...inline.replaceAll(/\s+/gu, " ").matchAll(/minmax\((.+?),\s*([\d.]+fr)\)/gu)].map(([, floor, weight]) => {
    const rest = /^max\((.+?), calc\(\(100% - \d+ \* var\(--wall-region-gap-x\) - ([\d.]+)rem\) \* [\d.]+ \/ [\d.]+\)\)$/u.exec(floor ?? "");
    const bare = (rest?.[1] ?? floor ?? "").replace(/^min\((.+),\s*100%\)$/u, "$1").trim();
    return `${bare === "0" ? "0rem" : bare}${rest ? `+rest-${rest[2]}rem` : ""}|${weight}`;
  });
}

/** Every D28 region the canvas drew, in document order. */
function regions(root: Element): string[] {
  return [...root.querySelectorAll("[data-wall-strip], [data-wall-revenue], [data-wall-needs], [data-wall-sites], [data-wall-feed]")]
    .map((el) => ["strip", "revenue", "needs", "sites", "feed"].find((name) => el.hasAttribute(`data-wall-${name}`))!);
}

/** Anything the old Wall drew that D28 took off it (docs/25 § What leaves the Wall). */
const RETIRED_MARKS = [
  "[data-attention-rail]",
  "[data-system-posture]",
  "[data-property-card]",
  "[data-property-grid]",
  "[data-clock-date-row]",
  "[data-meetings-panel]",
  "[data-proximity]",
  "[data-work-flow]",
  "[data-source]",
  "[data-widget-shell]",
].join(", ");

describe("the Wall nobody rearranged is D28", () => {
  it("draws the strip, then the column of revenue beside Needs you over the sites, beside the feed", () => {
    const view = canvas(DEFAULT_WALL_LAYOUT);
    const canvasEl = view.container.querySelector("[data-wall-canvas]")!;
    expect([...canvasEl.children].map((row) => [row.getAttribute("data-wall-row"), row.getAttribute("data-wall-row-height")])).toEqual([
      ["strip", "auto"],
      ["body", "fill"],
    ]);
    const body = view.container.querySelector("[data-wall-row='body']")!;
    const column = body.querySelector(":scope > [data-wall-column='business']")!;
    expect([...column.children].map((row) => row.getAttribute("data-wall-row"))).toEqual(["money", "sites"]);
    expect(body.querySelector(":scope > [data-wall-slot='feed'] > [data-wall-feed]")).not.toBeNull();
    expect(regions(view.container)).toEqual(["strip", "revenue", "needs", "sites", "feed"]);
  });

  // On a portrait tablet or a phone the rows dissolve and the Wall is one
  // column read in the operator's order (2026-09-23, beads ro-trai.29,
  // ro-trai.31): the sites before Needs you and the feed, because their
  // numbers are the state of the business.
  it("stacks below the TV in one order whatever the layout: strip, revenue, sites, Needs you, feed", () => {
    const view = canvas(DEFAULT_WALL_LAYOUT);
    for (const row of view.container.querySelectorAll("[data-wall-row]")) expect(row).toHaveClass("contents", "tv:grid");
    expect(view.container.querySelector("[data-wall-column]")).toHaveClass("contents", "tv:flex");
    const slots = [...view.container.querySelectorAll<HTMLElement>("[data-wall-slot]")];
    const stacked = [...slots].sort((a, b) => Number(a.style.order) - Number(b.style.order));
    expect(stacked.map((slot) => slot.getAttribute("data-wall-slot"))).toEqual(["strip", "revenue", "sites", "needs", "feed"]);
    for (const slot of slots) expect(slot).toHaveClass("tv:contents");
    // A layout that puts the feed first and the sites last reads the same.
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

  it("gives the column its 3.1 to the feed's 1, the feed its floor, and revenue its 1.55 beside Needs you", () => {
    const view = canvas(DEFAULT_WALL_LAYOUT);
    expect(tracks(view.container.querySelector("[data-wall-row='strip']")!)).toEqual(["0rem|1fr"]);
    // The feed's 30 rem cap is a floor on the column beside it (bead
    // ro-trai.31): past the cap the column takes the rest.
    expect(tracks(view.container.querySelector("[data-wall-row='body']")!)).toEqual(["0rem+rest-30rem|3.1fr", "21rem|1fr"]);
    expect(tracks(view.container.querySelector("[data-wall-row='money']")!)).toEqual(["0rem|1.55fr", "0rem|1fr"]);
    expect(tracks(view.container.querySelector("[data-wall-row='sites']")!)).toEqual(["0rem|1fr"]);
  });

  it("gives the body the height the strip leaves, and the site rows the height revenue leaves", () => {
    const view = canvas(DEFAULT_WALL_LAYOUT);
    // At the TV's width (`tv:`), where the rows are boxes (bead ro-trai.29).
    expect(view.container.querySelector("[data-wall-row='body']")).toHaveClass("tv:min-h-0", "tv:flex-1");
    expect(view.container.querySelector("[data-wall-row='sites']")).toHaveClass("tv:min-h-0", "tv:flex-1");
    expect(view.container.querySelector("[data-wall-row='strip']")).not.toHaveClass("tv:flex-1");
    expect(view.container.querySelector("[data-wall-row='money']")).not.toHaveClass("tv:flex-1");
  });

  it("spaces its regions on D28's frame tokens: 20px stacked, 28px side by side", () => {
    const view = canvas(DEFAULT_WALL_LAYOUT);
    expect(view.container.querySelector("[data-wall-canvas]")).toHaveClass("gap-wall-region");
    expect(view.container.querySelector("[data-wall-column]")).toHaveClass("tv:gap-wall-region");
    for (const row of view.container.querySelectorAll("[data-wall-row]")) {
      expect(row).toHaveClass("tv:gap-x-wall-region-x", "tv:gap-y-wall-region");
    }
  });

  it("draws nothing D28 took off the Wall", () => {
    const view = canvas(DEFAULT_WALL_LAYOUT);
    expect(view.container.querySelector(RETIRED_MARKS)).toBeNull();
    expect(view.container.textContent).not.toMatch(/Monthly net|Local time|All-time totals|Automation enabled|Monitor only|7d avg/);
  });
});

describe("a layout saved before D28", () => {
  it("is read as the D28 default and drawn whole — never refused, never blank", () => {
    const config = parseWallConfig(PRE_D28_SAVE);
    expect(config.retired?.replaced).toBe(true);
    const view = canvas(config.layout);
    expect(regions(view.container)).toEqual(["strip", "revenue", "needs", "sites", "feed"]);
    expect(view.container.querySelector(RETIRED_MARKS)).toBeNull();
    // Its old asset filter went with it: the default shows every site.
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
    const view = render(
      <MemoryRouter>
        <WallRoute />
      </MemoryRouter>,
    );
    expect(regions(view.container)).toEqual(["strip", "revenue", "needs", "sites", "feed"]);
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
          { id: "sites", type: "sites", width: 2, settings: { assets: ["nosh.example"] } },
          { id: "feed", type: "feed", width: 1 },
        ],
      },
      {
        id: "money",
        height: "auto",
        widgets: [
          { id: "revenue", type: "revenue", width: 1 },
          { id: "needs", type: "needs", width: 2.5, settings: { assets: ["nosh.example"] } },
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
    expect([...view.container.querySelectorAll("[data-site-row]")].map((row) => row.getAttribute("data-site-row"))).toEqual(["nosh.example"]);
    // Needs you is filtered by the same setting: the error on the site this
    // Wall does not show is not this Wall's business.
    const needs = view.container.querySelector("[data-wall-needs]")!;
    expect(needs.textContent).not.toMatch(/Meal Planner/u);
  });
});

describe("the default's column", () => {
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
      "business:money:0:0",
      "business:money:0:1",
      "business:sites:1:0",
      "-:body:1:1",
    ]);
    // The wrapper IS the grid cell: the only box between it and the row is the
    // widget's slot, which is no box at all at the TV's width (bead ro-trai.29).
    const slot = view.container.querySelector("[data-wall-row='strip']")!.children[0]!;
    expect(slot).toHaveAttribute("data-wall-slot", "strip");
    expect(slot).toHaveClass("tv:contents");
    expect(slot.children[0]!.getAttribute("data-selected")).toBe("-:strip:0:0");
    // The editor outlines the column so a stack reads as one thing.
    expect(view.container.querySelector("[data-wall-column]")).toHaveClass("outline-dashed");

    // And with no slot, the widget itself is the cell, and the TV draws no chrome.
    view.unmount();
    const tv = canvas(DEFAULT_WALL_LAYOUT);
    expect(tv.container.querySelector("[data-wall-row='strip'] > [data-wall-slot]")!.children[0]!.hasAttribute("data-wall-strip")).toBe(true);
    expect(tv.container.querySelector("[data-wall-column]")).not.toHaveClass("outline-dashed");
  });
});

// Bead ro-trai.3: the strip is a widget like any other, fed from the payload's
// system slice and countdown and the surface's own calendar poll.
describe("the top strip", () => {
  it("draws the time, current meeting and countdown with one Home link and no aggregate status", () => {
    const view = render(
      <MemoryRouter>
        <WallCanvas layout={DEFAULT_WALL_LAYOUT} data={PAYLOAD} nowMs={NOW} meetings={MEETINGS} ga4Realtime={REALTIME} />
      </MemoryRouter>,
    );
    const strip = view.container.querySelector("[data-wall-row='strip'] > [data-wall-slot] > [data-wall-strip]")!;
    // Numerals, and the locale's day period where it has one (bead ro-trai.3).
    expect(strip.querySelector("[data-strip-time]")?.textContent).toMatch(/^\d{1,2}[:.]\d{2}(AM|PM)?$/u);
    expect(strip.querySelector("[data-strip-meeting-cue]")?.textContent).toBe("Now");
    expect(strip.querySelector("[data-strip-meeting-title]")?.textContent).toBe("Standup");
    expect(strip.querySelector("[data-strip-meeting-distance]")?.textContent).toBe("25M left");
    expect(strip.querySelector("[data-strip-countdown]")?.textContent).toContain("SF Trip");
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

  it("alerts an independent calendar failure, retains events, and clears on recovery", () => {
    const view = render(<WallCanvas layout={DEFAULT_WALL_LAYOUT} data={PAYLOAD} nowMs={NOW} meetings={MEETINGS} calendarState="retrying" />);
    expect(view.container.querySelector("[data-strip-meeting-title]")).toHaveTextContent("Standup");
    expect(view.container.querySelector("[data-strip-calendar-status]")).toHaveTextContent("Retrying automatically");
    expect(view.container.querySelector("[data-wall-needs] [role='alert']")).toBeNull();
    view.rerender(<WallCanvas layout={DEFAULT_WALL_LAYOUT} data={PAYLOAD} nowMs={NOW} meetings={MEETINGS} calendarState="failed" />);
    expect(view.container.querySelector("[data-strip-meeting-title]")).toHaveTextContent("Standup");
    expect(view.container.querySelector("[data-strip-calendar-status]")).toHaveTextContent("cached");
    expect(view.container.querySelector("[data-wall-needs] [role='alert']")).toHaveTextContent("Calendar");
    expect(view.container.querySelector("[data-wall-needs] [role='alert']")).toHaveTextContent("Events not updating");

    view.rerender(<WallCanvas layout={DEFAULT_WALL_LAYOUT} data={PAYLOAD} nowMs={NOW} meetings={MEETINGS} />);
    expect(view.container.querySelector("[data-strip-calendar-status]")).toBeNull();
    expect(view.container.querySelector("[data-wall-needs] [role='alert']")).toBeNull();
    expect(view.container.querySelector("[data-strip-meeting-title]")).toHaveTextContent("Standup");
  });
});

describe("every D28 widget draws its own empty state", () => {
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
    expect(regions(view.container)).toEqual(["strip", "revenue", "needs", "sites", "feed"]);
    expect(view.container.querySelector("[data-strip-countdown]")).toBeNull();
    expect(view.container.querySelector("[data-strip-meeting]")).toBeNull();
    expect(view.container.querySelector("[data-wall-revenue]")).toHaveAttribute("data-wall-revenue", "none");
    expect(view.container.querySelector("[data-wall-needs]")).toHaveAttribute("data-wall-needs", "calm");
  });
});
