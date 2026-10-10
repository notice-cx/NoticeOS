import { integrationStatus } from '@shared/integration-status';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingOp } from "@shared/changeset";
import type { AssetCard, WallPayload } from "@shared/wall";
import {
  DEFAULT_WALL_LAYOUT,
  WALL_LAYOUT_POINTER,
  WALL_RETIRED_WARNING,
  WALL_TV_HEIGHT,
  parseWallConfig,
  wallLayoutWidgets,
  type WallConfig,
  type WallLayout,
} from "@shared/wall-layout";

/**
 * `/wall/edit`, the Wall's composer. The grammar is tested without a DOM in
 * `wall-editor.test.ts`; here, that this page is wired to it, plus what only
 * the page can keep. Sonner is mocked because the toast is not the subject.
 */
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const state = vi.hoisted(() => ({
  wall: null as WallPayload | null,
  writable: { writable: true, reason: null as string | null },
  /** What `useConfigSave` was handed, in order. */
  saves: [] as { ops: SettingOp[]; label: string; slug?: string }[],
  /** Whether the write lane accepts. A refused save must not clear the page. */
  accept: true,
}));

vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({ data: state.wall, isPending: state.wall === null, isError: false }),
}));

vi.mock("@/hooks/useNow", () => ({
  useNow: () => Date.parse("2026-09-05T12:00:00.000Z"),
}));

vi.mock("@/hooks/useCalendarUpcoming", () => ({
  useCalendarUpcoming: () => ({
    data: {
      fetchedAt: "2026-09-05T11:55:00.000Z",
      feedsConfigured: 1,
      feedsOk: 1,
      calendars: [{ id: "work", color: null, status: "ok" }],
      meetings: [
        {
          calendar: "work",
          title: "Design review",
          startsAt: "2026-09-05T13:00:00.000Z",
          endsAt: "2026-09-05T13:30:00.000Z",
          allDay: false,
          location: null,
        },
      ],
    },
    isError: false,
  }),
}));

vi.mock("@/hooks/useGa4Realtime", () => ({
  useGa4Realtime: () => ({
    data: { generatedAt: "2026-09-05T12:00:00.000Z", assets: [] },
    isError: false,
  }),
}));

// The feed widget's own poll: a quiet evening.
vi.mock("@/hooks/useWallFeed", () => ({
  useWallFeed: () => ({
    data: { generatedAt: "2026-09-05T12:00:00.000Z", since: "2026-09-05T01:00:00.000Z", items: [], limit: 50 },
    isError: false,
  }),
}));

vi.mock("@/hooks/useConfigWritable", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useConfigWritable")>(
    "@/hooks/useConfigWritable",
  );
  return { ...actual, useConfigWritable: () => state.writable };
});

vi.mock("@/hooks/useConfigSave", () => ({
  useConfigSave: () => (request: { ops: SettingOp[]; label: string; slug?: string }) => {
    state.saves.push(request);
    return Promise.resolve(state.accept);
  },
  // The countdown's form reaches for it whether or not this page ever adds or
  // removes the landmark; the panel renders that exact form.
  useLandmarkSave: () => () => Promise.resolve(state.accept),
  refusalMessage: (err: unknown) => String(err),
}));

import { WallEditRoute } from "@/routes/WallEditRoute";
import { WallRoute } from "@/routes/WallRoute";

function assetCard(id: string, displayName: string): AssetCard {
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
    activeUsers: {
      series: [],
      provisionalFrom: null,
      collectedAt: null,
      timeZoneChanges: [],
    },
    work: null,
    panelReview: null,
    searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
    netByMonth: [],
    netByMonthProvisionalFrom: null,
    latestPanelDate: null,
    counters: {
      heading: "All-time totals", cadenceHours: 0.25, defaultMetrics: ["accounts"],
      cards: [
        { metric: "accounts", label: "Accounts", value: 1200, source: "counters", observedAt: "2026-09-05T12:00:00.000Z" },
        { metric: "leads", label: "Leads", value: 0, source: "nightly", observedAt: "2026-09-05T11:00:00.000Z" },
      ],
    },
  };
}

const ASSETS = [assetCard("meadow.example", "Meadow Board"), assetCard("northwind.example", "Northwind")];

/** The payload both routes read. `wall` is what `config/tower.json` holds at
 * `/wall`, which is `null` in a clone nobody has rearranged, or the raw value
 * as the store holds it. */
function payload(wall: WallConfig | unknown | null = null): WallPayload {
  return {
    generatedAt: "2026-09-05T12:00:00.000Z",
    portfolio: { netTrendCurrency: 'USD', netTrendAllCurrency: 'USD',
      period: "2026-09",
      periodIsCurrent: true,
      booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
      forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
      netTrend: [],
      netTrendAll: [],
      trendGranularity: "monthly",
      bookedDelta: null,
      residue: {
        booked: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
        forecast: { currency: 'USD', revenue: 0, cost: 0, net: 0 },
      },
      firstRun: true,
      daysIn: 1,
    },
    system: {
      assetId: "root-os",
      hasPulse: true,
      spendTodayUsd: 1,
      dailyCapUsd: 2,
      ingest: { fresh: 2, stale: 0, notExpected: 0, expected: 2 },
      scheduledLanes: [],
    },
    dashboard: {
      countdown: { emoji: "🌁", label: "SF MOVE", targetAt: "2026-11-16T08:00:00.000Z" },
      ...(wall === null ? {} : { wall }),
    } as WallPayload["dashboard"],
    assets: ASSETS,
    attention: [],
    snoozed: [],
    operator: {
      waiting: 0,
      urgent: 0,
      measuredProjects: 2,
      urgentMeasuredProjects: 2,
      projectCount: 2,
      capturedAt: "2026-09-05T11:59:30.000Z",
    },
    ledgerRecordedAt: null,
  };
}

function renderEditor(wall: WallConfig | unknown | null = null) {
  state.wall = payload(wall);
  // A data router, not `MemoryRouter`: the page's unsaved-changes guard is
  // react-router's own blocker, which only exists on one.
  const router = createMemoryRouter(
    [
      { path: "/wall/edit", element: <WallEditRoute /> },
      { path: "/settings", element: <p>Settings</p> },
    ],
    { initialEntries: ["/wall/edit"] },
  );
  return {
    router,
    ...render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

/** The widgets the preview drew, in layout order. */
function drawn(): string[] {
  return [...document.querySelectorAll("[data-wall-edit-widget]")].map(
    (el) => el.getAttribute("data-wall-edit-widget") ?? "",
  );
}

function widget(id: string): HTMLElement {
  const el = document.querySelector(`[data-wall-edit-widget="${id}"]`);
  if (!el) throw new Error(`no widget ${id} in the preview`);
  return el as HTMLElement;
}

/** jsdom has no DataTransfer, so the drag carries a stub that answers the two
 * questions the handlers ask it. */
function dragged(widgetId: string) {
  return {
    types: ["application/x-noticeos-wall-widget"],
    getData: () => widgetId,
    setData: () => {},
    dropEffect: "move",
    effectAllowed: "move",
  };
}

/**
 * Take a widget out through its own chrome. The toolbar is drawn only over
 * the widget being pointed at, so reaching its Remove means hovering the
 * widget first.
 */
function removeFromChrome(widgetId: string, label: string) {
  fireEvent.mouseEnter(widget(widgetId));
  fireEvent.click(screen.getByRole("button", { name: `Remove ${label}` }));
}

/** The layout's Save — the save bar's, not the countdown form's the strip's
 * panel borrows. */
function saveButton(): HTMLElement {
  return within(document.querySelector("[data-wall-save-bar]") as HTMLElement).getByRole("button", { name: "Save" });
}

/** Write a version note beside Save and press it — one press, no second step. */
function saveWith(note: string) {
  fireEvent.change(screen.getByLabelText("Version note"), { target: { value: note } });
  fireEvent.click(saveButton());
}

function savedLayout(index = 0): WallLayout {
  const op = state.saves[index]?.ops[0];
  if (!op || op.kind !== "file-json-set") throw new Error("no file op");
  return (op.value as unknown as WallConfig).layout;
}

function savedConfig(index = 0): WallConfig {
  const op = state.saves[index]?.ops[0];
  if (!op || op.kind !== "file-json-set") throw new Error("no file op");
  return op.value as unknown as WallConfig;
}

/** The critical chip that names a refused part, by its subject. */
function refusedChip(subject: "wall:layout" | "wall:countdown"): HTMLElement | null {
  return document.querySelector(`[data-wall-save-bar] [data-status-for="${subject}"]`);
}

function warnings(): (string | null)[] {
  return [...document.querySelectorAll("[data-wall-warning]")].map((el) => el.textContent);
}

/** A Wall with only the site rows on it: the library then offers the rest. */
const SITES_ONLY: WallConfig = {
  layout: {
    version: 1,
    rows: [{ id: "only", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] }],
  },
  history: [],
};

/** A layout holding only retired widgets. */
const PRE_D28 = {
  layout: {
    version: 1,
    rows: [
      { id: "horizon", height: "auto", widgets: [{ id: "attention", type: "attention", width: 2 }, { id: "system", type: "system", width: 0.75 }] },
      { id: "assets", height: "fill", widgets: [{ id: "assets", type: "assets", width: 1 }] },
    ],
  },
  history: [
    { savedAt: "2026-09-04T12:00:00.000Z", reason: "Alerts wider", layout: { version: 1, rows: [{ id: "a", height: "fill", widgets: [{ id: "assets", type: "assets", width: 1 }] }] } },
  ],
};

beforeEach(() => {
  state.saves = [];
  state.accept = true;
  state.writable = { writable: true, reason: null };
});

afterEach(() => {
  state.wall = null;
  vi.clearAllMocks();
});

/** The layout's save state (the chip whose subject is `wall:layout`) — the
 * library's placed widgets say "On the TV" too. */
function layoutState(label: string): Element | null {
  return [...document.querySelectorAll('[data-status-for="wall:layout"]')].find((el) => el.textContent?.includes(label)) ?? null;
}

describe("the page it opens on", () => {
  it("draws the default Wall when nothing has ever been saved", () => {
    renderEditor();
    expect(drawn()).toEqual(["strip", "revenue", "needs", "sites", "feed"]);
    expect(layoutState("On the TV")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(warnings()).toEqual([]);
  });

  it("draws the saved layout when there is one", () => {
    renderEditor(SITES_ONLY);
    expect(drawn()).toEqual(["sites"]);
  });

  it("names a layout that reached the browser unreadable as refused, and saves nothing on its own", () => {
    renderEditor({ layout: { version: 9, rows: [] } });
    const chip = refusedChip("wall:layout");
    expect(chip?.textContent).toBe("Saved layout refused");
    expect(chip?.getAttribute("title")).toContain("version 1");
    expect(state.saves).toEqual([]);
  });
});

// A saved layout the Tower cannot read: the Worker draws the default in its
// place and names the refusal beside it, with the value as stored
// (`dashboard.refused.wall`). A Save or a Revert from there is guarded by what
// the store holds.
describe("a saved layout the Tower refused", () => {
  const BROKEN = {
    layout: { version: 1, rows: [] },
    history: [{ savedAt: "2026-09-04T12:00:00.000Z", reason: "Sites only", layout: SITES_ONLY.layout }],
  };
  const REASON = "config/tower.json wall.layout: A layout needs at least one row.";
  /** What the Worker serves for it: the versions that still read under the
   * default, and the refusal. */
  function refusedPayload(countdown = true): void {
    state.wall = payload({ layout: DEFAULT_WALL_LAYOUT, history: BROKEN.history });
    state.wall.dashboard.refused = { wall: { saved: BROKEN, reason: REASON } };
    if (!countdown) delete state.wall.dashboard.countdown;
  }
  function renderRefused(): void {
    refusedPayload();
    const router = createMemoryRouter([{ path: "/wall/edit", element: <WallEditRoute /> }], {
      initialEntries: ["/wall/edit"],
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  it("names the save as refused where \"On the TV\" would stand, with the reason on hover", () => {
    renderRefused();
    expect(drawn()).toEqual(["strip", "revenue", "needs", "sites", "feed"]);
    const chip = refusedChip("wall:layout");
    expect(chip?.textContent).toBe("Saved layout refused");
    expect(chip?.getAttribute("title")).toBe(REASON);
    expect(layoutState("On the TV")).toBeNull();
    expect(document.querySelector("[data-wall-unreadable]")).toBeNull();
    expect(document.querySelectorAll("[data-wall-version]")).toHaveLength(1);
  });

  it("saves the default as drawn without a change, guarded by the value as stored", () => {
    renderRefused();
    expect(saveButton()).toHaveProperty("disabled", false);
    fireEvent.click(saveButton());
    const op = state.saves[0]?.ops[0];
    expect(op && op.kind === "file-json-set" ? op.expect : null).toEqual(BROKEN);
    const next = savedConfig();
    expect(next.layout).toEqual(DEFAULT_WALL_LAYOUT);
    expect(next.history).toEqual(BROKEN.history);
    expect(() => parseWallConfig(next)).not.toThrow();
  });

  it("reverts to a version that still reads, guarded by the value as stored", () => {
    renderRefused();
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    const op = state.saves[0]?.ops[0];
    expect(op && op.kind === "file-json-set" ? op.expect : null).toEqual(BROKEN);
    expect(savedConfig().layout).toEqual(SITES_ONLY.layout);
  });

  it("an arranged Save is guarded the same way", () => {
    renderRefused();
    removeFromChrome("feed", "Live feed");
    saveWith("Without the feed");
    const op = state.saves[0]?.ops[0];
    expect(op && op.kind === "file-json-set" ? op.expect : null).toEqual(BROKEN);
  });
});

// A countdown the Tower refused leaves the saved layout beside it standing,
// is named once as the countdown's state, and the strip's form saves over the
// value as stored.
describe("a saved countdown the Tower refused", () => {
  const STORED = { emoji: "", label: "Launch", targetAt: "2026-10-01T16:00:00.000Z" };
  const REASON = "config/tower.json countdown.emoji must contain one emoji";
  function renderRefusedCountdown(): void {
    state.wall = payload();
    delete state.wall.dashboard.countdown;
    state.wall.dashboard.refused = { countdown: { saved: STORED, reason: REASON } };
    const router = createMemoryRouter([{ path: "/wall/edit", element: <WallEditRoute /> }], {
      initialEntries: ["/wall/edit"],
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  it("names it once, and the layout's own state stays \"On the TV\"", () => {
    renderRefusedCountdown();
    expect(layoutState("On the TV")).not.toBeNull();
    const chip = refusedChip("wall:countdown");
    expect(chip?.textContent).toBe("Saved countdown refused");
    expect(chip?.getAttribute("title")).toBe(REASON);
    fireEvent.click(document.querySelector("[data-wall-countdown-refused]") as HTMLElement);
    expect(document.querySelector('[data-wall-widget-panel="strip"]')).not.toBeNull();
    expect(document.querySelector("[data-wall-countdown-absent]")).toBeNull();
    expect(document.querySelectorAll('[data-status-for="wall:countdown"]')).toHaveLength(1);
  });

  it("the strip's form starts from what still reads and saves over the value as stored", () => {
    renderRefusedCountdown();
    fireEvent.click(document.querySelector("[data-wall-countdown-refused]") as HTMLElement);
    const panel = document.querySelector('[data-wall-widget-panel="strip"]') as HTMLElement;
    expect((within(panel).getByLabelText("Countdown label") as HTMLInputElement).value).toBe("Launch");
    fireEvent.change(within(panel).getByLabelText("Countdown emoji"), { target: { value: "🚀" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]?.ops).toEqual([{
      kind: "file-json-set",
      file: "config/tower.json",
      pointer: "/countdown",
      expect: STORED,
      value: { emoji: "🚀", label: "Launch", targetAt: STORED.targetAt },
    }]);
  });
});

// A layout naming widgets the Wall retired opens, never refused, never blank,
// as the default with one warning, and the first Save replaces it, guarded by
// the value the store holds.
describe("a layout naming retired widgets", () => {
  for (const [name, wall] of [
    ["as the store holds it", PRE_D28],
    ["as the Worker parsed it", parseWallConfig(PRE_D28)],
  ] as const) {
    it(`opens as the default with one warning, and Save is guarded by the save itself (${name})`, () => {
      renderEditor(wall);
      expect(drawn()).toEqual(["strip", "revenue", "needs", "sites", "feed"]);
      expect(warnings()).toEqual([WALL_RETIRED_WARNING]);
      expect(document.querySelector('[data-save-state="refused"]')).toBeNull();
      expect(document.querySelector("[data-wall-versions-empty]")).not.toBeNull();

      removeFromChrome("feed", "Live feed");
      saveWith("Default without the feed");
      const op = state.saves[0]?.ops[0];
      expect(op && op.kind === "file-json-set" ? op.expect : null).toEqual(PRE_D28);
      const next = savedConfig();
      expect(next).not.toHaveProperty("retired");
      expect(next.history).toEqual([
        { savedAt: expect.any(String), reason: "Default without the feed", layout: DEFAULT_WALL_LAYOUT },
      ]);
    });
  }
});

describe("adding and removing", () => {
  it("adds the widget the library's button names", () => {
    renderEditor(SITES_ONLY);
    fireEvent.click(screen.getByRole("button", { name: "Add Live feed" }));
    expect(drawn()).toContain("feed");
    expect(document.querySelector('[data-wall-widget-panel="feed"]')).not.toBeNull();
  });

  it("shows a placed one-of-a-kind widget as ON THE WALL instead of an Add", () => {
    renderEditor();
    expect(screen.queryByRole("button", { name: "Add Needs you" })).toBeNull();
    const row = document.querySelector('[data-wall-library-item="needs"]');
    expect(row?.querySelector('[data-wall-library-refusal="On the TV"]')).not.toBeNull();
    expect(row?.textContent).not.toContain("can appear only once");
  });

  it("removes from the widget's own chrome", () => {
    renderEditor();
    removeFromChrome("feed", "Live feed");
    expect(drawn()).not.toContain("feed");
  });

  it("shows one toolbar at a time, over the widget being pointed at", () => {
    renderEditor();
    // Five toolbars at full size cover the television the preview exists to
    // show, so the ring is the affordance until a widget is the subject.
    expect(document.querySelectorAll("[data-wall-edit-chrome]")).toHaveLength(0);
    fireEvent.mouseEnter(widget("strip"));
    expect(document.querySelectorAll("[data-wall-edit-chrome]")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Remove Top strip" })).toBeTruthy();
    fireEvent.mouseLeave(widget("strip"));
    expect(document.querySelectorAll("[data-wall-edit-chrome]")).toHaveLength(0);
    fireEvent.click(widget("strip"));
    fireEvent.mouseLeave(widget("strip"));
    expect(document.querySelectorAll("[data-wall-edit-chrome]")).toHaveLength(1);
  });
});

describe("arranging", () => {
  it("moves a widget by dragging it onto another", () => {
    renderEditor();
    fireEvent.dragStart(widget("feed"), { dataTransfer: dragged("feed") });
    fireEvent.drop(widget("revenue"), { dataTransfer: dragged("feed"), clientX: 0 });
    expect(drawn()).toEqual(["strip", "feed", "revenue", "needs", "sites"]);
  });

  it("moves a widget by dropping it on an empty row's line", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Add a row" }));
    const line = document.querySelector('[data-wall-row-line="row-5"]');
    expect(line).not.toBeNull();
    fireEvent.drop(line as HTMLElement, { dataTransfer: dragged("strip") });
    expect(drawn().at(-1)).toBe("strip");
  });

  it("moves a widget by button, for a keyboard", () => {
    renderEditor();
    fireEvent.click(widget("needs"));
    fireEvent.click(screen.getByRole("button", { name: "Move left" }));
    expect(drawn().slice(1, 3)).toEqual(["needs", "revenue"]);
  });

  it("disables a direction with nowhere to go", () => {
    renderEditor();
    fireEvent.click(widget("revenue"));
    expect(screen.getByRole("button", { name: "Move left" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Move right" })).toHaveProperty("disabled", false);
  });

  it("reorders rows and moves the remaining height", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Move row 2 up" }));
    saveWith("Strip at the bottom");
    expect(savedLayout().rows.map((row) => row.id)).toEqual(["body", "strip"]);
  });

  it("gives the remaining height to one row and takes it from the other", () => {
    renderEditor();
    const rows = document.querySelectorAll('[data-wall-row-line]');
    fireEvent.click(within(rows[0] as HTMLElement).getByRole("button", { name: /Remaining height/u }));
    saveWith("The strip takes the screen");
    expect(savedLayout().rows.map((row) => row.height)).toEqual(["fill", "auto"]);
  });

  it("only lets an empty row be removed", () => {
    renderEditor();
    expect(screen.getByRole("button", { name: "Remove row 1" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Add a row" }));
    expect(screen.getByRole("button", { name: "Remove row 3" })).toHaveProperty("disabled", false);
  });

  it("stacks a widget in a column, takes it back out, and saves a column", () => {
    renderEditor();
    fireEvent.click(widget("strip"));
    fireEvent.click(screen.getByRole("button", { name: /Stack in column/u }));
    expect(document.querySelector("[data-wall-column='column']")).not.toBeNull();
    expect(screen.getByText(/Row 1 column, row 1, position 1 of 1/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Take out of column/u }));
    expect(document.querySelector("[data-wall-column='column']")).toBeNull();
    expect(drawn()).toEqual(["strip", "revenue", "needs", "sites", "feed"]);
    expect(saveButton()).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: /Stack in column/u }));
    const line = document.querySelector("[data-wall-column-row-line='row-5']");
    expect(line).not.toBeNull();
    fireEvent.drop(line as HTMLElement, { dataTransfer: dragged("feed") });
    saveWith("Feed under the strip");
    const column = savedLayout().rows[0]?.widgets[0];
    expect(column).toMatchObject({
      id: "column",
      type: "column",
      width: 1,
      rows: [{ height: "auto", widgets: [{ id: "strip" }, { id: "feed" }] }],
    });
    expect(savedConfig().history[0]?.reason).toBe("Feed under the strip");
  });
});

describe("the selected widget's settings", () => {
  it("offers the widgets on the Wall to pick when nothing is selected, and says nothing else", () => {
    // The panel's empty state is the widgets themselves, one press each, in
    // the Wall's reading order; there is no hint line.
    renderEditor();
    const panel = document.querySelector('[data-wall-widget-panel="none"]') as HTMLElement;
    expect(within(panel).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Top strip", "Revenue", "Needs you", "Sites", "Live feed",
    ]);
    expect(panel.querySelector("p")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Needs you" }));
    expect(document.querySelector('[data-wall-widget-panel="needs"]')).not.toBeNull();
  });

  it("resizes on the contract's step grid and says the share of the row", () => {
    renderEditor();
    fireEvent.click(widget("revenue"));
    fireEvent.click(screen.getByRole("button", { name: "Wider" }));
    saveWith("A little more room for the money");
    expect(wallLayoutWidgets(savedLayout()).find((w) => w.id === "revenue")?.width).toBe(1.6);
    expect(document.querySelector("[data-wall-width-share]")?.textContent).toContain("%");
  });

  it("filters the sites a per-site widget shows", () => {
    renderEditor();
    fireEvent.click(widget("sites"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Northwind" }));
    saveWith("Only Meadow Board on the TV");
    const sites = wallLayoutWidgets(savedLayout()).find((w) => w.id === "sites");
    expect(sites?.settings).toEqual({ assets: ["meadow.example"] });
  });

  it("offers no site filter on a widget the renderer does not filter", () => {
    renderEditor();
    fireEvent.click(widget("revenue"));
    expect(document.querySelector("[data-wall-asset-filter]")).toBeNull();
  });

  it("previews and saves per-site pulse choices while retaining the site filter", () => {
    renderEditor();
    fireEvent.click(widget("sites"));
    const choices = document.querySelector('[data-wall-pulse-picker="meadow.example"]') as HTMLElement;
    expect(within(choices).getByRole("checkbox", { name: /Accounts/ })).toBeChecked();
    expect(within(choices).getByRole("checkbox", { name: /Leads/ })).not.toBeChecked();
    fireEvent.click(within(choices).getByRole("checkbox", { name: /Accounts/ }));
    fireEvent.click(within(choices).getByRole("checkbox", { name: /Leads/ }));
    expect(widget("sites").querySelector('[data-site-row="meadow.example"] [data-site-total="accounts"]')).toBeNull();
    expect(widget("sites").querySelector('[data-site-row="meadow.example"] [data-site-total="leads"] dd')?.textContent).toBe("0");
    fireEvent.click(screen.getByRole("checkbox", { name: "Northwind" }));
    saveWith("Leads on the Wall");
    const saved = wallLayoutWidgets(savedLayout()).find((w) => w.id === "sites");
    expect(saved?.settings).toEqual({ assets: ["meadow.example"], pulseMetrics: { "meadow.example": ["leads"] } });
  });

  it("saves an explicit empty pulse selection without changing another site's defaults", () => {
    renderEditor();
    fireEvent.click(widget("sites"));
    const choices = document.querySelector('[data-wall-pulse-picker="meadow.example"]') as HTMLElement;
    fireEvent.click(within(choices).getByRole("checkbox", { name: /Accounts/ }));
    saveWith("Hide Meadow Board totals");
    expect(wallLayoutWidgets(savedLayout()).find((w) => w.id === "sites")?.settings?.pulseMetrics).toEqual({ "meadow.example": [] });
    expect(widget("sites").querySelector('[data-site-row="northwind.example"] [data-site-total="accounts"]')).not.toBeNull();
  });

  it("shows the countdown's OWN form for the strip rather than a second one", () => {
    renderEditor();
    fireEvent.click(widget("strip"));
    expect(screen.getByLabelText("Countdown emoji")).toHaveProperty("value", "🌁");
    expect(screen.getByLabelText("Countdown label")).toHaveProperty("value", "SF MOVE");
  });

  it("names that form once, not once per component that frames it", () => {
    renderEditor();
    fireEvent.click(widget("strip"));
    const panel = document.querySelector("[data-wall-widget-panel]") as HTMLElement;
    expect(within(panel).getAllByText("Top strip settings")).toHaveLength(1);
    expect(within(panel).getAllByRole("button", { name: "config/tower.json" })).toHaveLength(1);
  });
});

describe("what the operator is told", () => {
  it("prints the refusal and darkens Save", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Add a row" }));
    expect(document.querySelector("[data-wall-refusal]")?.textContent).toBe(
      "Row 3 needs at least one widget.",
    );
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });

  it("prints a warning beside a Save that still works", () => {
    renderEditor();
    // Taking the site rows out of the column takes their row with them.
    removeFromChrome("sites", "Sites");
    expect(document.querySelector("[data-wall-refusal]")).toBeNull();
    expect(warnings()).toContain("No sites on the TV");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
  });

  it("states how far past the TV the layout runs, from the box's own height", () => {
    // jsdom has no layout engine, so the one thing faked is the box's measured
    // height; the number it is compared against is the television's 1080.
    const measured = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(WALL_TV_HEIGHT + 320);
    renderEditor();
    expect(warnings()).toContain("This layout runs 320 px past the TV.");
    measured.mockRestore();
  });
});

describe("save", () => {
  it("writes exactly one file op, at the pointer, guarded by what it read", () => {
    renderEditor();
    removeFromChrome("feed", "Live feed");
    saveWith("The feed moves to the kitchen screen");

    expect(state.saves).toHaveLength(1);
    const request = state.saves[0];
    expect(request?.ops).toHaveLength(1);
    const op = request?.ops[0];
    expect(op).toMatchObject({
      kind: "file-json-set",
      file: "config/tower.json",
      pointer: WALL_LAYOUT_POINTER,
      expect: null,
    });
    expect(request?.slug).toBe("wall-layout");
    expect(savedLayout().rows[1]?.widgets.map((w) => w.id)).toEqual(["business"]);
  });

  it("guards against the value it actually read when a layout is already saved", () => {
    renderEditor(SITES_ONLY);
    fireEvent.click(screen.getByRole("button", { name: "Add Live feed" }));
    saveWith("The feed too");
    const op = state.saves[0]?.ops[0];
    expect(op && op.kind === "file-json-set" ? op.expect : null).toEqual(SITES_ONLY);
  });

  it("keeps the replaced layout as a version, with the operator's own words", () => {
    renderEditor();
    removeFromChrome("feed", "Live feed");
    saveWith("The feed moves to the kitchen screen");
    const next = savedConfig();
    expect(next.history).toHaveLength(1);
    expect(next.history[0]?.reason).toBe("The feed moves to the kitchen screen");
    expect(next.history[0]?.layout).toEqual(DEFAULT_WALL_LAYOUT);
  });

  it("saves on one press, and names the version by what changed when there is no note", () => {
    renderEditor();
    removeFromChrome("feed", "Live feed");
    expect(screen.getByLabelText("Version note")).toHaveProperty("placeholder", "Removed Live feed");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(state.saves).toHaveLength(1);
    expect(savedConfig().history[0]?.reason).toBe("Removed Live feed");
    expect(screen.queryByRole("button", { name: "Save the layout" })).toBeNull();
  });

  it("saves on Enter in the note field, with the operator's words", () => {
    renderEditor();
    removeFromChrome("feed", "Live feed");
    const field = screen.getByLabelText("Version note");
    fireEvent.change(field, { target: { value: "Feed off the TV" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(savedConfig().history[0]?.reason).toBe("Feed off the TV");
  });

  it("goes quiet once the write lands", async () => {
    renderEditor();
    removeFromChrome("feed", "Live feed");
    saveWith("The feed moves to the kitchen screen");
    await waitFor(() =>
      expect(layoutState("On the TV")).not.toBeNull(),
    );
    expect(drawn()).not.toContain("feed");
  });

  // The payload still holds the old document for a beat after a Save, so a
  // second Save in that beat must build on the one that just landed.
  it("builds the next Save on the one that just landed, and guards on it, before the payload catches up", async () => {
    renderEditor();
    removeFromChrome("feed", "Live feed");
    saveWith("Feed off the TV");
    await waitFor(() => expect(layoutState("On the TV")).not.toBeNull());
    expect(document.querySelector('[data-save-state="saved"] [data-status-for="wall:layout"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add Live feed" }));
    expect(document.querySelector('[data-save-state="unsaved"] [data-status-for="wall:layout"]')).not.toBeNull();
    saveWith("Feed back");
    await waitFor(() => expect(state.saves).toHaveLength(2));
    const second = state.saves[1]?.ops[0];
    expect(second && second.kind === "file-json-set" ? second.expect : undefined).toEqual(savedConfig(0));
    expect(savedConfig(1).history.map((version) => version.reason)).toEqual(["Feed back", "Feed off the TV"]);
  });

  it("keeps the operator's arrangement when the lane refuses", async () => {
    state.accept = false;
    renderEditor();
    removeFromChrome("feed", "Live feed");
    saveWith("The feed moves to the kitchen screen");
    await waitFor(() => expect(state.saves).toHaveLength(1));
    expect(drawn()).not.toContain("feed");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("puts the saved layout back on Discard", () => {
    renderEditor();
    removeFromChrome("feed", "Live feed");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(drawn()).toContain("feed");
    expect(state.saves).toHaveLength(0);
  });
});

describe("versions", () => {
  const earlier = SITES_ONLY.layout;
  const saved: WallConfig = {
    layout: DEFAULT_WALL_LAYOUT,
    history: [
      { savedAt: "2026-09-04T12:00:00.000Z", reason: "Sites only", layout: earlier },
    ],
  };

  it("lists what the Wall used to show, and how long ago", () => {
    renderEditor(saved);
    const version = document.querySelector('[data-wall-version="0"]');
    expect(version?.textContent).toContain("Sites only");
    expect(version?.textContent).toContain("1d ago");
    expect(version?.textContent).toContain("1 row, 1 widget");
  });

  it("reverts as a SAVE — a new version, and the reverted entry still there", () => {
    renderEditor(saved);
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(state.saves).toHaveLength(1);
    const next = savedConfig();
    expect(next.layout).toEqual(earlier);
    expect(next.history[0]?.layout).toEqual(DEFAULT_WALL_LAYOUT);
    expect(next.history[0]?.reason).toContain("Reverted to the layout saved");
    expect(next.history[1]).toEqual(saved.history[0]);
  });

  it("asks for no reason: the entry already has one", () => {
    renderEditor(saved);
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(screen.queryByLabelText("Version note")).toBeNull();
  });

  it("says plainly when there is nothing to go back to", () => {
    renderEditor();
    expect(document.querySelector("[data-wall-versions-empty]")?.textContent).toBe(
      "No saved versions yet",
    );
  });
});

describe("configuration saves paused", () => {
  it("keeps the editor readable and disabled with one shared save status", () => {
    state.writable = { writable: false, reason: "Config store unreachable" };
    renderEditor(SITES_ONLY);
    const paused = document.querySelector("[data-saves-paused]") as HTMLElement;
    expect(document.querySelectorAll("[data-saves-paused]")).toHaveLength(1);
    expect(within(paused).getByText("Saves paused")).toBeTruthy();
    expect(within(paused).getByRole("status")).toHaveTextContent("Saves paused · Config store unreachable");
    expect(document.querySelector("[data-wall-read-only]")).toBeNull();
    expect(drawn()).toEqual(["sites"]);
    expect(screen.getByRole("button", { name: "Add Live feed" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Add a row" })).toHaveProperty("disabled", true);
  });

  it("uses the shared settings fallback when no refusal reason is supplied", () => {
    state.writable = { writable: false, reason: null };
    renderEditor(SITES_ONLY);
    const paused = document.querySelector("[data-saves-paused]") as HTMLElement;
    expect(within(paused).getByRole("status")).toHaveTextContent("Saves paused · Settings cannot be saved right now.");
    expect(paused.textContent).not.toMatch(/file|deployment/i);
    expect(state.saves).toHaveLength(0);
  });

  it("shows no paused status while configuration saves are available", () => {
    renderEditor(SITES_ONLY);
    expect(document.querySelector("[data-saves-paused]")).toBeNull();
    expect(screen.getByRole("button", { name: "Add a row" })).toHaveProperty("disabled", false);
  });
});

describe("the three ways in", () => {
  it("answers at /wall/edit, inside the shell", async () => {
    const { deskRoutes, routes } = await import("@/App");
    expect(deskRoutes.map((route) => route.path)).toContain("/wall/edit");
    expect(routes.some((route) => route.path === "/wall")).toBe(true);
  });

  it("is in the command palette, and not in the sidebar", async () => {
    const { NAV_ITEMS, PAGE_ITEMS, TV_EDIT_ITEM } = await import("@/components/nav-items");
    expect(PAGE_ITEMS).toContain(TV_EDIT_ITEM);
    expect(TV_EDIT_ITEM.label).toBe("Edit the TV layout");
    expect(NAV_ITEMS.map((item) => item.to)).not.toContain("/wall/edit");
  });

  // The third way in is Settings' TV dashboard section, asserted in
  // `settings-route.test.tsx`; the television itself is deliberately not one.
});

describe("a phone", () => {
  /** jsdom has no layout engine, so the measured width is faked and what is
   * asserted is what follows from it: the television scales down, the chrome
   * stops being drawn once it would be wider than the widget it labels, and
   * the classes that stack the panes. The picture itself is Playwright's job. */
  const PHONE_PANE = 358;
  let rect: ReturnType<typeof vi.spyOn> | null = null;
  const deskWidth = window.innerWidth;

  beforeEach(() => {
    // jsdom's default viewport is 1024, and the fit check reads the real one.
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    rect = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue({
        width: PHONE_PANE,
        height: 0,
        top: 0,
        left: 0,
        right: PHONE_PANE,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
  });

  afterEach(() => {
    rect?.mockRestore();
    rect = null;
    Object.defineProperty(window, "innerWidth", { value: deskWidth, configurable: true });
  });

  it("scales the television to the width it is given", () => {
    renderEditor();
    expect(
      document.querySelector("[data-wall-preview]")?.getAttribute("data-wall-preview-scale"),
    ).toBe("0.186");
  });

  it("drops the widget chrome that would be wider than its widget", () => {
    renderEditor();
    expect(document.querySelectorAll("[data-wall-edit-chrome]")).toHaveLength(0);
    // A touch never fires a drag, so every action the chrome lost is in the panel.
    fireEvent.click(widget("feed"));
    expect(document.querySelector('[data-wall-widget-panel="feed"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(drawn()).not.toContain("feed");
  });

  it("states the fit here too, because what it measures is still the television", () => {
    // The box is 1920 wide on every screen and is the `wall` query container
    // every breakpoint reads, so at 390 the widgets inside it draw the
    // television's arrangement and the height that comes back can be believed.
    const measured = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(WALL_TV_HEIGHT + 320);
    renderEditor();
    expect(warnings()).toContain("This layout runs 320 px past the TV.");
    measured.mockRestore();
  });

  it("stacks the three panes and keeps Save on the page", () => {
    renderEditor(SITES_ONLY);
    const panes = document.querySelector("[data-wall-library]")?.parentElement;
    expect(panes?.className).toContain("flex-col");
    expect(panes?.className).toContain("xl:grid");
    fireEvent.click(screen.getByRole("button", { name: "Add Live feed" }));
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
  });
});

describe("the television itself", () => {
  it("renders no edit chrome of any kind", () => {
    state.wall = payload();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider
          router={createMemoryRouter([{ path: "/wall", element: <WallRoute /> }], {
            initialEntries: ["/wall"],
          })}
        />
      </QueryClientProvider>,
    );
    for (const selector of [
      "[data-wall-edit-widget]",
      "[data-wall-edit-chrome]",
      "[data-wall-library]",
      "[data-wall-rows]",
      "[data-wall-save-bar]",
      "[data-wall-versions]",
      "[data-wall-preview]",
      "[draggable]",
    ]) {
      expect(document.querySelectorAll(selector)).toHaveLength(0);
    }
    expect(screen.queryByRole("button", { name: /Add / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByText(WALL_RETIRED_WARNING)).toBeNull();
  });
});

vi.mock('@/hooks/useIntegrationHealth', () => ({ INTEGRATION_HEALTH_KEY: ['integration-health'], useIntegrationHealth: () => ({ data: undefined, isError: false, status: integrationStatus(undefined, false, Date.now()) }) }));
