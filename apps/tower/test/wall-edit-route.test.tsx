import { SAVED_COLUMN_LAYOUT } from "./saved-wall-layout";
import { integrationStatus } from '@shared/integration-status';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingOp } from "@shared/changeset";
import type { AssetCard, WallPayload } from "@shared/wall";
import type { SiteDisplay } from "@shared/site-display";
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
 * the page can keep. A drag is the browser's own, which jsdom cannot perform,
 * so arranging is driven here through the Move menu, which reaches every
 * place a drag can; the TV layout journey drags and resizes in Chromium.
 * Sonner is mocked because the toast is not the subject.
 */
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/hooks/useWallWeather", () => ({ useWallWeather: () => undefined }));

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

function renderEditor(wall: WallConfig | unknown | null = null, sites?: SiteDisplay, assets?: AssetCard[]) {
  const read = { ...payload(wall), ...(assets ? { assets } : {}) };
  state.wall = sites === undefined ? read : { ...read, dashboard: { ...read.dashboard, sites } };
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

/**
 * Take a widget out through its own chrome. The toolbar is drawn only over
 * the widget being pointed at, so reaching its Remove means hovering the
 * widget first.
 */
function removeFromChrome(widgetId: string, label: string) {
  fireEvent.mouseEnter(widget(widgetId));
  fireEvent.click(screen.getByRole("button", { name: `Remove ${label}` }));
}

/** A button on the editor's toolbar, by its name. */
function toolbarButton(name: string): HTMLElement {
  return within(document.querySelector("[data-wall-toolbar]") as HTMLElement).getByRole("button", { name: new RegExp(`^${name}`, "u") });
}

/** Open the Add drawer or the versions from the toolbar. */
function openDrawer(name: "Add a widget" | "Versions") {
  fireEvent.click(toolbarButton(name));
}

/** Open a widget's Move menu from its toolbar on the TV. */
function openMoveMenu(label: string) {
  fireEvent.click(within(document.querySelector("[data-wall-preview]") as HTMLElement).getByRole("button", { name: `Move ${label}` }));
}

/** Pick one item of a widget's Move menu. */
function chooseMove(label: string, item: RegExp) {
  openMoveMenu(label);
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

/** What the page last said about a move, for a screen reader. */
function announced(): string | null {
  return document.querySelector('[data-status-for="readout:wall-arrange"]')?.textContent ?? null;
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

/** The default Wall, in the order the preview draws it. */
const DEFAULT_DRAWN = ["strip", "work", "needs", "sites", "revenue", "feed"];
const SAVED_DRAWN = ["strip", "loop", "timeline", "sites", "revenue", "work"];
const SAVED_COLUMNS: WallConfig = { layout: SAVED_COLUMN_LAYOUT, history: [] };

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
    expect(drawn()).toEqual(DEFAULT_DRAWN);
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
    expect(chip?.textContent).toBe("Saved layout is invalid");
    expect(chip?.getAttribute("title")).toContain("version 1");
    expect(state.saves).toEqual([]);
  });
});

describe("metric tiles and row focus", () => {
  it("edits one shared Portfolio tile without changing saved section geometry or preview filters", async () => {
    renderEditor(SAVED_COLUMNS);
    const today = document.querySelector<HTMLButtonElement>('[data-site-row="meadow.example"] [data-wall-metric-select="today"]')!;
    fireEvent.click(today);
    expect(screen.getByLabelText("Title")).toBeDefined();
    expect(saveButton()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Focus on row" }));
    expect(document.querySelectorAll("[data-site-row]")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Visitors today" } });
    fireEvent.change(screen.getByLabelText("Preview asset"), { target: { value: "northwind.example" } });
    expect(document.querySelector('[data-site-row="northwind.example"] [data-wall-metric="today"]')?.getAttribute("aria-label")).toBe("Visitors today");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelectorAll("[data-site-row]")).toHaveLength(2);
    expect(document.activeElement).toBe(document.querySelector('[data-site-row="northwind.example"] [data-wall-metric-select="today"]'));
    fireEvent.click(toolbarButton("Undo"));
    expect(screen.getByLabelText("Title")).toHaveProperty("value", "");
    fireEvent.click(toolbarButton("Redo"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(state.saves).toHaveLength(1));
    const config = savedConfig();
    const updated = wallLayoutWidgets(config.layout).find(item => item.type === "sites")!;
    expect(updated.settings?.metrics?.find(item => item.id === "today")?.title).toBe("Visitors today");
    expect(updated.settings?.assets).toBeUndefined();
    const withoutMetrics = structuredClone(config.layout);
    delete wallLayoutWidgets(withoutMetrics).find(item => item.type === "sites")!.settings;
    expect(withoutMetrics).toEqual(SAVED_COLUMN_LAYOUT);
    const op = state.saves[0]!.ops[0]!;
    expect(op.kind === "file-json-set" && op.expect).toEqual(SAVED_COLUMNS);
    expect(config.history[0]?.layout).toEqual(SAVED_COLUMN_LAYOUT);
  });

  it("previews the full composition only on request, with exact Undo and a guarded Save", async () => {
    renderEditor(SAVED_COLUMNS);
    expect(drawn()).toEqual(SAVED_DRAWN);
    fireEvent.click(screen.getByRole("button", { name: "Use full Wall layout" }));
    expect(drawn()).toEqual(DEFAULT_DRAWN);
    expect(state.saves).toHaveLength(0);
    fireEvent.click(toolbarButton("Undo"));
    expect(drawn()).toEqual(SAVED_DRAWN);
    fireEvent.click(toolbarButton("Redo"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(state.saves).toHaveLength(1));
    expect(savedConfig().layout).toEqual(DEFAULT_WALL_LAYOUT);
    expect(savedConfig().history[0]?.layout).toEqual(SAVED_COLUMN_LAYOUT);
  });
});

// A saved layout the Tower cannot read: the Worker draws the default in its
// place and names the refusal beside it, with the value as stored
// (`dashboard.refused.wall`). A Save or a Revert from there is guarded by what
// the store holds.
describe("a saved layout the Tower refused", () => {
  const BROKEN = {
    layout: { version: 1, rows: [] },
    history: [{ savedAt: "2026-09-04T12:00:00.000Z", reason: "Portfolio only", layout: SITES_ONLY.layout }],
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
    expect(drawn()).toEqual(DEFAULT_DRAWN);
    const chip = refusedChip("wall:layout");
    expect(chip?.textContent).toBe("Saved layout is invalid");
    expect(chip?.getAttribute("title")).toBe(REASON);
    expect(layoutState("On the TV")).toBeNull();
    expect(document.querySelector("[data-wall-unreadable]")).toBeNull();
    openDrawer("Versions");
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
    openDrawer("Versions");
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    const op = state.saves[0]?.ops[0];
    expect(op && op.kind === "file-json-set" ? op.expect : null).toEqual(BROKEN);
    expect(savedConfig().layout).toEqual(SITES_ONLY.layout);
  });

  it("an arranged Save is guarded the same way", () => {
    renderRefused();
    removeFromChrome("work", "Work");
    saveWith("Without the work");
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
    expect(chip?.textContent).toBe("Saved countdown is invalid");
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
      expect(drawn()).toEqual(DEFAULT_DRAWN);
      expect(warnings()).toEqual([WALL_RETIRED_WARNING]);
      expect(document.querySelector('[data-save-state="refused"]')).toBeNull();
      openDrawer("Versions");
      expect(document.querySelector("[data-wall-versions-empty]")).not.toBeNull();

      removeFromChrome("work", "Work");
      saveWith("Default without the work");
      const op = state.saves[0]?.ops[0];
      expect(op && op.kind === "file-json-set" ? op.expect : null).toEqual(PRE_D28);
      const next = savedConfig();
      expect(next).not.toHaveProperty("retired");
      expect(next.history).toEqual([
        { savedAt: expect.any(String), reason: "Default without the work", layout: DEFAULT_WALL_LAYOUT },
      ]);
    });
  }
});

describe("adding and removing", () => {
  it("adds the widget the Add drawer's button names, and shows its settings", () => {
    renderEditor(SITES_ONLY);
    openDrawer("Add a widget");
    fireEvent.click(screen.getByRole("button", { name: "Add Live feed" }));
    expect(drawn()).toContain("feed");
    expect(document.querySelector('[data-wall-widget-panel="feed"]')).not.toBeNull();
    expect(document.querySelector("[data-wall-library]")).toBeNull();
  });

  it("shows a placed one-of-a-kind widget as ON THE TV instead of an Add, and offers the two the default leaves out", () => {
    renderEditor(SAVED_COLUMNS);
    openDrawer("Add a widget");
    expect(screen.queryByRole("button", { name: "Add Work" })).toBeNull();
    const row = document.querySelector('[data-wall-library-item="work"]');
    expect(row?.querySelector('[data-wall-library-refusal="On the TV"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add Attention ticker" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Live feed" })).toBeTruthy();
    // An offered widget can be dragged onto the TV as well as added.
    expect(document.querySelector('[data-wall-library-item="feed"]')?.getAttribute("draggable")).toBe("true");
    expect(document.querySelector('[data-wall-library-item="work"]')?.getAttribute("draggable")).toBeNull();
  });

  it("removes from the widget's own chrome", () => {
    renderEditor();
    removeFromChrome("work", "Work");
    expect(drawn()).not.toContain("work");
    expect(announced()).toBe("Work removed");
  });

  it("shows one toolbar at a time, over the widget being pointed at", () => {
    renderEditor();
    // Six toolbars at full size cover the television the preview exists to
    // show, so the ring is the affordance until a widget is the subject.
    expect(document.querySelectorAll("[data-wall-edit-chrome]")).toHaveLength(0);
    fireEvent.mouseEnter(widget("strip"));
    expect(document.querySelectorAll("[data-wall-edit-chrome]")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Remove Top strip" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move Top strip" })).toBeTruthy();
    fireEvent.mouseLeave(widget("strip"));
    expect(document.querySelectorAll("[data-wall-edit-chrome]")).toHaveLength(0);
    fireEvent.click(widget("strip"));
    fireEvent.mouseLeave(widget("strip"));
    expect(document.querySelectorAll("[data-wall-edit-chrome]")).toHaveLength(1);
  });

  it("takes a row away with the last widget in it", () => {
    renderEditor(SAVED_COLUMNS);
    removeFromChrome("loop", "The loop");
    saveWith("No loop");
    expect(savedLayout().rows.map((row) => row.id)).toEqual(["strip", "body"]);
  });
});

describe("arranging", () => {
  it("keeps section dragging on the grip while tiles remain selection targets", () => {
    renderEditor();
    for (const id of DEFAULT_DRAWN) {
      fireEvent.mouseEnter(widget(id));
      expect(widget(id).getAttribute("draggable"), id).toBe("true");
    }
    expect(document.querySelector("[data-wall-preview-hint]")?.textContent).toContain("Select a tile to edit");
    expect(document.querySelector("[data-wall-preview-hint]")?.textContent).toContain("grip");
  });

  it("moves a widget with its Move menu, says where it went and gives focus back to it", () => {
    renderEditor(SAVED_COLUMNS);
    fireEvent.click(widget("work"));
    chooseMove("Work", /^Move up/u);
    expect(drawn()).toEqual(["strip", "loop", "timeline", "sites", "work", "revenue"]);
    expect(announced()).toBe("Work moved to row 3 of 3, column 2 of 2, 1 of 2 in its column");
    expect(document.activeElement).toBe(widget("work"));
  });

  it("moves a widget with Alt and an arrow, from the widget itself", () => {
    renderEditor(SAVED_COLUMNS);
    fireEvent.keyDown(widget("strip"), { key: "ArrowDown", altKey: true });
    saveWith("The loop on top");
    expect(savedLayout().rows.map((row) => row.id)).toEqual(["loop", "strip", "body"]);
  });

  it("disables a direction with nowhere to go", () => {
    renderEditor();
    fireEvent.click(widget("strip"));
    openMoveMenu("Top strip");
    const item = (name: RegExp) => screen.getByRole("menuitem", { name });
    expect(item(/^Move up/u)).toHaveProperty("disabled", true);
    expect(item(/^Move left/u)).toHaveProperty("disabled", true);
    expect(item(/^Move right/u)).toHaveProperty("disabled", true);
    expect(item(/^Into its own column/u)).toHaveProperty("disabled", true);
    expect(item(/^Move down/u)).toHaveProperty("disabled", false);
  });

  it("stacks a widget under another and saves the column it makes", () => {
    renderEditor(SAVED_COLUMNS);
    fireEvent.click(widget("work"));
    openMoveMenu("Work");
    fireEvent.click(screen.getByRole("menuitem", { name: /Stack under/u }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Under Top strip" }));
    expect(document.querySelector("[data-wall-column='column']")).not.toBeNull();
    saveWith("Work under the strip");
    expect(savedLayout().rows[0]?.widgets[0]).toMatchObject({
      id: "column",
      type: "column",
      width: 1,
      rows: [{ widgets: [{ id: "strip" }] }, { widgets: [{ id: "work" }] }],
    });
    // The side column is left with revenue alone, so it is revenue again.
    expect(savedLayout().rows[2]?.widgets.map((w) => w.id)).toEqual(["business", "revenue"]);
    expect(savedConfig().history[0]?.reason).toBe("Work under the strip");
  });

  it("splits a stacked widget into a column of its own", () => {
    renderEditor(SAVED_COLUMNS);
    fireEvent.click(widget("work"));
    chooseMove("Work", /^Into its own column/u);
    saveWith("Work on its own");
    expect(savedLayout().rows[2]?.widgets.map((w) => [w.id, w.width])).toEqual([["business", 1.4], ["revenue", 0.5], ["work", 0.5]]);
  });
});

describe("undo and redo", () => {
  it("takes back each change with the toolbar's Undo, and brings it back with Redo", () => {
    renderEditor(SAVED_COLUMNS);
    const undo = toolbarButton("Undo");
    const redo = toolbarButton("Redo");
    expect(undo).toHaveProperty("disabled", true);
    removeFromChrome("work", "Work");
    fireEvent.click(widget("strip"));
    chooseMove("Top strip", /^Move down/u);
    expect(drawn()).toEqual(["loop", "strip", "timeline", "sites", "revenue"]);
    fireEvent.click(undo);
    expect(drawn()).toEqual(["strip", "loop", "timeline", "sites", "revenue"]);
    fireEvent.click(undo);
    expect(drawn()).toEqual(SAVED_DRAWN);
    expect(undo).toHaveProperty("disabled", true);
    expect(saveButton()).toHaveProperty("disabled", true);
    fireEvent.click(redo);
    expect(drawn()).not.toContain("work");
  });

  it("answers ⌘Z and ⇧⌘Z (Ctrl elsewhere), but not inside the version note", () => {
    renderEditor();
    removeFromChrome("work", "Work");
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(drawn()).toEqual(DEFAULT_DRAWN);
    fireEvent.keyDown(window, { key: "Z", ctrlKey: true, shiftKey: true });
    expect(drawn()).not.toContain("work");
    fireEvent.keyDown(screen.getByLabelText("Version note"), { key: "z", metaKey: true });
    expect(drawn()).not.toContain("work");
  });

  it("can take a Discard back", () => {
    renderEditor();
    removeFromChrome("work", "Work");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(drawn()).toEqual(DEFAULT_DRAWN);
    fireEvent.click(toolbarButton("Undo"));
    expect(drawn()).not.toContain("work");
  });
});

describe("the selected widget's settings", () => {
  it("offers the widgets on the Wall to pick when nothing is selected, and says nothing else", () => {
    renderEditor(SAVED_COLUMNS);
    const panel = document.querySelector('[data-wall-widget-panel="none"]') as HTMLElement;
    expect(within(panel).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Top strip", "The loop", "Last 24 hours", "Portfolio", "Revenue", "Work",
    ]);
    expect(panel.querySelector("p")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Last 24 hours" }));
    expect(document.querySelector('[data-wall-widget-panel="timeline"]')).not.toBeNull();
  });

  it("gives its column a preset share of the row in one press", () => {
    renderEditor(SAVED_COLUMNS);
    fireEvent.click(widget("revenue"));
    expect(document.querySelector("[data-wall-width-share]")?.textContent).toBe("42% of the row");
    fireEvent.click(screen.getByRole("button", { name: "Half of the row" }));
    expect(document.querySelector("[data-wall-width-share]")?.textContent).toBe("½ of the row");
    saveWith("Half for the money");
    const side = savedLayout().rows[2]?.widgets[1];
    expect(side?.width).toBe(1.4);
  });

  it("gives a stacked widget a share of its column's height, and fits it to its content again", async () => {
    renderEditor(SAVED_COLUMNS);
    fireEvent.click(widget("timeline"));
    fireEvent.click(screen.getByRole("button", { name: "A third of the column" }));
    expect(screen.getByRole("button", { name: "A third of the column" })).toHaveAttribute("aria-pressed", "true");
    saveWith("A third for the last 24 hours");
    const business = savedLayout().rows[2]?.widgets[0];
    expect(business?.type === "column" ? business.rows.map((r) => r.size) : null).toEqual([1, 2]);
    await waitFor(() => expect(layoutState("On the TV")).not.toBeNull());
    fireEvent.click(within(document.querySelector("[data-wall-size]") as HTMLElement).getByRole("button", { name: "Fit content" }));
    saveWith("Back to its content");
    // The site rows keep their weight: they share what the timeline leaves.
    const again = savedLayout(1).rows[2]?.widgets[0];
    expect(again?.type === "column" ? again.rows.map((r) => [r.height, r.size]) : null).toEqual([["auto", undefined], ["fill", 2]]);
  });

  it("gives the remaining height to a widget's row and takes it from the other", () => {
    renderEditor(SAVED_COLUMNS);
    fireEvent.click(widget("strip"));
    fireEvent.click(within(document.querySelector("[data-wall-size]") as HTMLElement).getByRole("button", { name: "Fill the rest" }));
    saveWith("The strip takes the screen");
    expect(savedLayout().rows.map((row) => row.height)).toEqual(["fill", "auto", "auto"]);
  });

  it("moves the selected widget from its panel too, for a phone or a keyboard", () => {
    renderEditor(SAVED_COLUMNS);
    fireEvent.click(widget("revenue"));
    fireEvent.click(within(document.querySelector('[data-wall-widget-panel="revenue"]') as HTMLElement).getByRole("button", { name: "Move Revenue" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Move left/u }));
    expect(drawn()).toEqual(["strip", "loop", "revenue", "timeline", "sites", "work"]);
  });

  it("filters the assets a per-asset widget shows", () => {
    renderEditor();
    fireEvent.click(widget("sites"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Northwind" }));
    saveWith("Only Meadow Board on the TV");
    const sites = wallLayoutWidgets(savedLayout()).find((w) => w.id === "sites");
    expect(sites?.settings).toEqual({ assets: ["meadow.example"] });
  });

  it("draws an asset off the TV by its own setting unticked and not tickable, saying why", () => {
    renderEditor(null, { "northwind.example": { tv: false } });
    fireEvent.click(widget("sites"));
    const filter = document.querySelector("[data-wall-asset-filter]") as HTMLElement;
    const northwind = within(filter).getByRole("checkbox", { name: /Northwind/u });
    expect(northwind).not.toBeChecked();
    expect(northwind).toBeDisabled();
    expect(filter).toHaveTextContent("Off on the TV by its own setting");
    expect(within(filter).getByRole("checkbox", { name: /Meadow Board/u })).toBeChecked();
    expect(filter).toHaveTextContent("Every asset");
  });

  it("keeps an archived asset disabled in widget lists even with its TV switch on", () => {
    const retired = ASSETS.map((asset) => (asset.id === "northwind.example" ? { ...asset, status: "retired" } : asset));
    const off = renderEditor(null, undefined, retired);
    fireEvent.click(widget("sites"));
    const filter = () => document.querySelector("[data-wall-asset-filter]") as HTMLElement;
    expect(within(filter()).getByRole("checkbox", { name: /Northwind/u })).toBeDisabled();
    expect(filter()).toHaveTextContent(/Northwind\s*Retired/u);
    off.unmount();
    renderEditor(null, { "northwind.example": { tv: true } }, retired);
    fireEvent.click(widget("sites"));
    expect(within(filter()).getByRole("checkbox", { name: /Northwind/u })).toBeDisabled();
    expect(filter()).toHaveTextContent(/Northwind\s*Retired/u);
  });

  it("draws an asset off Work this week by its own setting unticked on the Work widget alone", () => {
    renderEditor(null, { "northwind.example": { work: false } });
    fireEvent.click(widget("work"));
    const work = document.querySelector("[data-wall-asset-filter]") as HTMLElement;
    expect(within(work).getByRole("checkbox", { name: /Northwind/u })).toBeDisabled();
    expect(work).toHaveTextContent("Off in Work this week by its own setting");
    fireEvent.click(widget("sites"));
    const sites = document.querySelector("[data-wall-asset-filter]") as HTMLElement;
    expect(within(sites).getByRole("checkbox", { name: /Northwind/u })).toBeEnabled();
  });

  it("offers no asset filter on a widget the renderer does not filter", () => {
    renderEditor();
    fireEvent.click(widget("revenue"));
    expect(document.querySelector("[data-wall-asset-filter]")).toBeNull();
  });

  it("previews and saves per-asset pulse choices while retaining the asset filter", () => {
    renderEditor();
    fireEvent.click(widget("sites"));
    const choices = document.querySelector('[data-wall-pulse-picker="meadow.example"]') as HTMLElement;
    expect(within(choices).getByRole("checkbox", { name: /Accounts/ })).toBeChecked();
    expect(within(choices).getByRole("checkbox", { name: /Leads/ })).not.toBeChecked();
    fireEvent.click(within(choices).getByRole("checkbox", { name: /Accounts/ }));
    fireEvent.click(within(choices).getByRole("checkbox", { name: /Leads/ }));
    expect(widget("sites").querySelector('[data-site-row="meadow.example"] [data-site-total="accounts"]')).toBeNull();
    expect(widget("sites").querySelector('[data-site-row="meadow.example"] [data-site-total="leads"]')?.textContent).toBe("0");
    fireEvent.click(screen.getByRole("checkbox", { name: "Northwind" }));
    saveWith("Leads on the Wall");
    const saved = wallLayoutWidgets(savedLayout()).find((w) => w.id === "sites");
    expect(saved?.settings).toEqual({ assets: ["meadow.example"], pulseMetrics: { "meadow.example": ["leads"] } });
  });

  it("saves an explicit empty pulse selection without changing another asset's defaults", () => {
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
    renderEditor(SAVED_COLUMNS);
    for (const [id, label] of [["strip", "Top strip"], ["loop", "The loop"], ["timeline", "Last 24 hours"], ["sites", "Portfolio"], ["revenue", "Revenue"], ["work", "Work"]] as const) {
      removeFromChrome(id, label);
    }
    expect(document.querySelector("[data-wall-refusal]")?.textContent).toBe("A layout needs at least one row.");
    expect(saveButton()).toHaveProperty("disabled", true);
  });

  it("prints a warning beside a Save that still works", () => {
    renderEditor();
    removeFromChrome("sites", "Portfolio");
    expect(document.querySelector("[data-wall-refusal]")).toBeNull();
    expect(warnings()).toContain("No assets on the TV");
    expect(saveButton()).toHaveProperty("disabled", false);
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

describe("Wall tile transparency", () => {
  it("toggles complete tile surfaces with Undo and Redo while retaining transparency", () => {
    renderEditor({ layout: { ...structuredClone(DEFAULT_WALL_LAYOUT), tileTransparency: 50 }, history: [] });
    const toggle = screen.getByRole("switch", { name: "Tile backgrounds and borders" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole("slider", { name: "Tile transparency" })).toHaveValue("50");
    fireEvent.click(toolbarButton("Undo"));
    expect(toggle).toBeChecked();
    fireEvent.click(toolbarButton("Redo"));
    expect(toggle).not.toBeChecked();
    fireEvent.click(saveButton());
    expect(savedLayout()).toMatchObject({ tileSurfaces: false, tileTransparency: 50 });
  });
  it("preserves appearance calibration while a Wall preset replaces the section arrangement", () => {
    const layout = structuredClone(DEFAULT_WALL_LAYOUT);
    layout.tileTransparency = 50;
    layout.tileSurfaces = false;
    wallLayoutWidgets(layout).find(item => item.type === "sites")!.settings = { rowBackground: false };
    renderEditor({ layout, history: [] });
    openDrawer("Add a widget");
    fireEvent.click(screen.getByRole("button", { name: "Start from" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Revenue and visitors/ }));
    fireEvent.click(saveButton());
    expect(savedLayout().tileTransparency).toBe(50);
    expect(savedLayout().tileSurfaces).toBe(false);
    expect(wallLayoutWidgets(savedLayout()).find(item => item.type === "sites")?.settings?.rowBackground).toBe(false);
  });

  it("keeps calibration when applying the full Wall composition", () => {
    renderEditor({ layout: { ...SAVED_COLUMN_LAYOUT, tileTransparency: 50, tileSurfaces: false }, history: [] });
    fireEvent.click(screen.getByRole("button", { name: "Use full Wall layout" }));
    expect(screen.getByRole("slider", { name: "Tile transparency" })).toHaveValue("50");
    fireEvent.click(saveButton());
    expect(savedLayout().tileTransparency).toBe(50);
    expect(savedLayout().tileSurfaces).toBe(false);
  });

  it("uses the same shared row appearance setting from metric and section controls", () => {
    renderEditor();
    fireEvent.click(widget("sites").querySelector('[data-wall-metric-select="today"]')!);
    const toggle = screen.getByRole("switch", { name: "Row separators" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Row settings" }));
    expect(screen.getByRole("switch", { name: "Row separators" })).not.toBeChecked();
    fireEvent.click(saveButton());
    expect(wallLayoutWidgets(savedLayout()).find(item => item.id === "sites")?.settings?.rowBackground).toBe(false);
  });

  it("groups a slider drag into one Undo and saves its final value", () => {
    renderEditor();
    const slider = screen.getByRole("slider", { name: "Tile transparency" });
    expect(slider).toHaveValue("0");
    expect(slider).toHaveAttribute("aria-valuetext", "0% transparent");
    fireEvent.pointerDown(slider);
    fireEvent.change(slider, { target: { value: "25" } });
    fireEvent.change(slider, { target: { value: "50" } });
    fireEvent.pointerUp(slider);
    fireEvent.click(toolbarButton("Undo"));
    expect(slider).toHaveValue("0");
    expect(toolbarButton("Undo")).toBeDisabled();
    fireEvent.click(toolbarButton("Redo"));
    expect(slider).toHaveValue("50");
    fireEvent.click(saveButton());
    expect(savedLayout().tileTransparency).toBe(50);
  });

  it("groups a held keyboard key until release and restores saved calibration on Discard", () => {
    renderEditor({ layout: { ...DEFAULT_WALL_LAYOUT, tileTransparency: 30 }, history: [] });
    const slider = screen.getByRole("slider", { name: "Tile transparency" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    fireEvent.change(slider, { target: { value: "31" } });
    fireEvent.keyDown(slider, { key: "ArrowRight", repeat: true });
    fireEvent.change(slider, { target: { value: "32" } });
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    fireEvent.click(toolbarButton("Undo"));
    expect(slider).toHaveValue("30");
    expect(toolbarButton("Undo")).toBeDisabled();
    fireEvent.click(toolbarButton("Redo"));
    expect(slider).toHaveValue("32");
    fireEvent.click(toolbarButton("Discard"));
    expect(slider).toHaveValue("30");
  });
});

describe("TV preview presets", () => {
  it("changes a preset resolution atomically and undoes both dimensions together", () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Resolution"), { target: { value: "4k" } });
    expect(screen.getByText(/3840 × 2160 · 100% scaling/)).toBeInTheDocument();
    fireEvent.click(toolbarButton("Undo"));
    expect(screen.getByLabelText("Resolution")).toHaveValue("1080p");
    expect(toolbarButton("Undo")).toBeDisabled();
    fireEvent.click(toolbarButton("Redo"));
    expect(screen.getByLabelText("Resolution")).toHaveValue("4k");
    fireEvent.click(saveButton());
    expect(savedLayout().tvPreview?.presets[0]).toMatchObject({ width: 3840, height: 2160 });
  });
  it("selects, undoes, redoes and saves a TV preset through the shared draft", () => {
    renderEditor();
    const select = screen.getByLabelText("TV preset");
    fireEvent.change(select, { target: { value: "4k-200" } });
    expect(select).toHaveValue("4k-200");
    fireEvent.click(toolbarButton("Undo"));
    expect(select).toHaveValue("1080p-100");
    fireEvent.click(toolbarButton("Redo"));
    expect(select).toHaveValue("4k-200");
    fireEvent.click(saveButton());
    expect(savedLayout().tvPreview?.selectedId).toBe("4k-200");
  });
  it("blocks Save for a pending invalid number and restores it on Discard", () => {
    renderEditor();
    fireEvent.click(screen.getByText("Edit presets"));
    fireEvent.change(screen.getByLabelText("Resolution"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Width", { exact: true }), { target: { value: "" } });
    expect(saveButton()).toBeDisabled();
    expect(screen.getByLabelText("Width", { exact: true })).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(screen.getByRole("slider", { name: "Tile transparency" }), { target: { value: "50" } });
    expect(screen.getByLabelText("Width", { exact: true })).toHaveValue(null);
    expect(saveButton()).toBeDisabled();
    fireEvent.click(toolbarButton("Discard"));
    expect(screen.queryByLabelText("Width", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Resolution")).toHaveValue("1080p");
    expect(state.saves).toHaveLength(0);
  });
  it("keeps saved TV presets in version history", () => {
    const preview = structuredClone(DEFAULT_WALL_LAYOUT);
    renderEditor({ layout: preview, history: [] });
    fireEvent.change(screen.getByLabelText("TV preset"), { target: { value: "4k-100" } });
    fireEvent.click(saveButton());
    expect(savedConfig().history[0]?.layout).toEqual(preview);
    expect(savedConfig().layout.tvPreview?.selectedId).toBe("4k-100");
  });
  it("retains the TV calibration when replacing the Wall arrangement", () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("TV preset"), { target: { value: "720p-100" } });
    openDrawer("Add a widget");
    fireEvent.click(screen.getByRole("button", { name: "Start from" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Revenue and visitors/ }));
    expect(screen.getByLabelText("TV preset")).toHaveValue("720p-100");
    fireEvent.click(saveButton());
    expect(savedLayout().tvPreview?.selectedId).toBe("720p-100");
  });
});

describe("save", () => {
  it("writes exactly one file op, at the pointer, guarded by what it read", () => {
    renderEditor();
    removeFromChrome("work", "Work");
    saveWith("The work moves to the desk");

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
    // The attention and Portfolio rows keep their column after Work is removed.
    expect(savedLayout().rows[1]?.widgets).toEqual([
      { id: "business", type: "column", width: 3.25, rows: [
        { id: "needs", height: "auto", widgets: [{ id: "needs", type: "needs", width: 1 }] },
        { id: "sites", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] },
      ] },
      DEFAULT_WALL_LAYOUT.rows[1]?.widgets[1],
    ]);
  });

  it("guards against the value it actually read when a layout is already saved", () => {
    renderEditor(SITES_ONLY);
    openDrawer("Add a widget");
    fireEvent.click(screen.getByRole("button", { name: "Add Live feed" }));
    saveWith("The feed too");
    const op = state.saves[0]?.ops[0];
    expect(op && op.kind === "file-json-set" ? op.expect : null).toEqual(SITES_ONLY);
  });

  it("keeps the replaced layout as a version, with the operator's own words", () => {
    renderEditor();
    removeFromChrome("work", "Work");
    saveWith("The work moves to the desk");
    const next = savedConfig();
    expect(next.history).toHaveLength(1);
    expect(next.history[0]?.reason).toBe("The work moves to the desk");
    expect(next.history[0]?.layout).toEqual(DEFAULT_WALL_LAYOUT);
  });

  it("saves on one press, and names the version by what changed when there is no note", () => {
    renderEditor();
    removeFromChrome("work", "Work");
    expect(screen.getByLabelText("Version note")).toHaveProperty("placeholder", "Removed Work");
    fireEvent.click(saveButton());
    expect(state.saves).toHaveLength(1);
    expect(savedConfig().history[0]?.reason).toBe("Removed Work");
  });

  it("saves on Enter in the note field, with the operator's words", () => {
    renderEditor();
    removeFromChrome("work", "Work");
    const field = screen.getByLabelText("Version note");
    fireEvent.change(field, { target: { value: "Work off the TV" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(savedConfig().history[0]?.reason).toBe("Work off the TV");
  });

  it("goes quiet once the write lands", async () => {
    renderEditor();
    removeFromChrome("work", "Work");
    saveWith("The work moves to the desk");
    await waitFor(() => expect(layoutState("On the TV")).not.toBeNull());
    expect(drawn()).not.toContain("work");
  });

  // The payload still holds the old document for a beat after a Save, so a
  // second Save in that beat must build on the one that just landed.
  it("builds the next Save on the one that just landed, and guards on it, before the payload catches up", async () => {
    renderEditor();
    removeFromChrome("work", "Work");
    saveWith("Work off the TV");
    await waitFor(() => expect(layoutState("On the TV")).not.toBeNull());
    expect(document.querySelector('[data-save-state="saved"] [data-status-for="wall:layout"]')).not.toBeNull();

    openDrawer("Add a widget");
    fireEvent.click(screen.getByRole("button", { name: "Add Work" }));
    expect(document.querySelector('[data-save-state="unsaved"] [data-status-for="wall:layout"]')).not.toBeNull();
    saveWith("Work back");
    await waitFor(() => expect(state.saves).toHaveLength(2));
    const second = state.saves[1]?.ops[0];
    expect(second && second.kind === "file-json-set" ? second.expect : undefined).toEqual(savedConfig(0));
    expect(savedConfig(1).history.map((version) => version.reason)).toEqual(["Work back", "Work off the TV"]);
  });

  it("keeps the operator's arrangement when the lane refuses", async () => {
    state.accept = false;
    renderEditor();
    removeFromChrome("work", "Work");
    saveWith("The work moves to the desk");
    await waitFor(() => expect(state.saves).toHaveLength(1));
    expect(drawn()).not.toContain("work");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("puts the saved layout back on Discard", () => {
    renderEditor();
    removeFromChrome("work", "Work");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(drawn()).toContain("work");
    expect(state.saves).toHaveLength(0);
  });
});

describe("versions", () => {
  const earlier = SITES_ONLY.layout;
  const saved: WallConfig = {
    layout: DEFAULT_WALL_LAYOUT,
    history: [
      { savedAt: "2026-09-04T12:00:00.000Z", reason: "Portfolio only", layout: earlier },
    ],
  };

  it("clears pending invalid TV fields after a successful version Revert", async () => {
    renderEditor(saved);
    fireEvent.click(screen.getByText("Edit presets"));
    fireEvent.change(screen.getByLabelText("Resolution"), { target: { value: "custom" } });
    fireEvent.change(screen.getByLabelText("Width", { exact: true }), { target: { value: "" } });
    expect(screen.getByLabelText("Width", { exact: true })).toHaveValue(null);
    openDrawer("Versions");
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(screen.queryByLabelText("Width", { exact: true })).not.toBeInTheDocument());
    expect(screen.getByLabelText("Resolution")).toHaveValue("1080p");
    expect(screen.queryByText("Fix the TV preset fields before saving.")).not.toBeInTheDocument();
  });

  it("lists what the Wall used to show, and how long ago, behind the toolbar's Versions", () => {
    renderEditor(saved);
    expect(document.querySelector("[data-wall-version-count]")?.textContent).toBe("1");
    openDrawer("Versions");
    const version = document.querySelector('[data-wall-version="0"]');
    expect(version?.textContent).toContain("Portfolio only");
    expect(version?.textContent).toContain("1d ago");
    expect(version?.textContent).toContain("1 row, 1 widget");
  });

  it("reverts as a SAVE — a new version, and the reverted entry still there", () => {
    renderEditor(saved);
    openDrawer("Versions");
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
    openDrawer("Versions");
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(screen.queryByLabelText("Version note")).toBeNull();
  });

  it("says plainly when there is nothing to go back to", () => {
    renderEditor();
    openDrawer("Versions");
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
    expect(toolbarButton("Add a widget")).toHaveProperty("disabled", true);
    expect(saveButton()).toHaveProperty("disabled", true);
    // Nothing on the TV can be dragged or resized while saves are paused.
    expect(widget("sites").getAttribute("draggable")).toBeNull();
    expect(document.querySelector("[data-wall-dividers]")).toBeNull();
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
    expect(toolbarButton("Add a widget")).toHaveProperty("disabled", false);
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

  it("drops the widget chrome that would be wider than its widget, and keeps every action in the panel", () => {
    renderEditor();
    expect(document.querySelectorAll("[data-wall-edit-chrome]")).toHaveLength(0);
    // A touch never fires a drag, so every action the chrome lost is in the panel.
    fireEvent.click(widget("work"));
    const panel = document.querySelector('[data-wall-widget-panel="work"]') as HTMLElement;
    expect(within(panel).getByRole("button", { name: "Move Work" })).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Remove" }));
    expect(drawn()).not.toContain("work");
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

  it("stacks the television over its side and keeps Save on the page", () => {
    renderEditor(SITES_ONLY);
    const panes = document.querySelector("[data-wall-editor]");
    expect(panes?.className).toContain("flex-col");
    expect(document.querySelector("[data-wall-side]")).not.toBeNull();
    openDrawer("Add a widget");
    fireEvent.click(screen.getByRole("button", { name: "Add Live feed" }));
    expect(saveButton()).toHaveProperty("disabled", false);
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
      "[data-wall-toolbar]",
    "[data-wall-dividers]",
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
