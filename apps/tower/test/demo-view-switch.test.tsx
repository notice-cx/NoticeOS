// The public demo's view switch: one press per view in the demo bar, kept in
// the visitor's browser, and on the TV the picked view's preset in place of
// the demo's saved layout. An installation's TV never follows the pick.

import { act, fireEvent, render as renderBare, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WALL_LAYOUT, WALL_PRESETS, wallLayoutWidgets, type WallLayout } from "@shared/wall-layout";
import { render as renderStandalone } from "./render";

const state = vi.hoisted(() => ({ dashboard: {} as Record<string, unknown> }));

vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({
    data: { assets: [], dashboard: state.dashboard },
    isError: false,
    isFetching: false,
    isPending: false,
    error: null,
    refetch: () => {},
  }),
}));
vi.mock("@/hooks/useConnections", () => ({ useConnections: () => ({ credentials: undefined, items: null }) }));
vi.mock("@/hooks/useGa4Realtime", () => ({ useGa4Realtime: () => ({ data: undefined, isError: false }) }));
vi.mock("@/hooks/useCalendarUpcoming", () => ({ useCalendarUpcoming: () => ({ data: undefined, isError: false, isPending: false }) }));
// The canvas is pinned by its own suite; here only the layout and the words
// handed to it matter.
vi.mock("@/components/WallCanvas", () => ({
  WallCanvas: ({ layout, wordLevel }: { layout: WallLayout; wordLevel?: string }) => (
    <pre data-testid="drawn" data-word-level={wordLevel}>{JSON.stringify(layout)}</pre>
  ),
}));

import { BrowserRuntimeProvider } from "@/lib/browser-context";
import { createBrowserRuntime } from "@/lib/browser-runtime";
import { createOwnerStorage, storageKey } from "@/lib/browser-storage";
import { DemoViewSwitch } from "@/components/DemoViewSwitch";
import { DemoViewerStatus } from "@/components/DemoViewerStatus";
import { WallRoute, demoDrawnLayout } from "@/routes/WallRoute";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const runtimes: ReturnType<typeof createBrowserRuntime>[] = [];

function demoRuntime() {
  const runtime = createBrowserRuntime<(keepalive: boolean) => Promise<void>>(
    { mode: "demo", workspaceId: WORKSPACE, clientGeneration: 1 },
    { origin: window.location.origin, fetch: vi.fn(() => new Promise<Response>(() => {})), sendAnswer: async () => {} },
  );
  runtimes.push(runtime);
  return runtime;
}

function DemoOwner({ children }: { children: ReactNode }) {
  const runtime = runtimes.at(-1) ?? demoRuntime();
  return (
    <BrowserRuntimeProvider value={{ runtime, workspaceLabel: "Demo" }}>
      <QueryClientProvider client={runtime.queries}>{children}</QueryClientProvider>
    </BrowserRuntimeProvider>
  );
}

/** The demo owner's own preference store, read the way the Tower reads it. */
const demoPreferences = () =>
  createOwnerStorage({ mode: "demo", workspaceId: WORKSPACE, clientGeneration: 0 }, window.localStorage);

/** The demo's saved TV: the default with the sites' totals chosen and agent standings in place of work. */
const SAVED: WallLayout = (() => {
  const layout = structuredClone(DEFAULT_WALL_LAYOUT) as WallLayout;
  for (const widget of wallLayoutWidgets(layout)) {
    if (widget.type === "sites") widget.settings = { pulseMetrics: { "meadow.example": ["recipe_saves"] } };
    if (widget.type === "work") Object.assign(widget, { id: "agents", type: "agents" });
  }
  return layout;
})();

function Search() {
  return <span data-testid="search">{useLocation().search}</span>;
}

function wallAt(path: string, render: typeof renderBare = renderBare) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/wall" element={<><WallRoute /><Search /></>} />
      </Routes>
    </MemoryRouter>,
    render === renderBare ? { wrapper: DemoOwner } : undefined,
  );
}

const drawn = (): WallLayout => JSON.parse(screen.getByTestId("drawn").textContent ?? "null") as WallLayout;
const sitesSettings = (layout: WallLayout) => wallLayoutWidgets(layout).find((widget) => widget.type === "sites")?.settings;

beforeEach(() => {
  state.dashboard = { wall: { layout: SAVED, history: [] } };
  window.localStorage.clear();
});
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.retire();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("the demo's view switch", () => {
  it("offers the three views by their labels, Everything pressed before a pick", () => {
    renderBare(<DemoViewSwitch />, { wrapper: DemoOwner });
    const group = screen.getByRole("group", { name: "Your view" });
    expect(group).toHaveAttribute("data-demo-view-switch");
    const options = within(group).getAllByRole("button");
    expect(options.map((option) => option.textContent)).toEqual(["I run the business", "I build the product", "Everything"]);
    expect(options.map((option) => option.getAttribute("data-demo-view-option"))).toEqual(["business", "product", "everything"]);
    expect(options.map((option) => option.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
  });

  it("stores a press under the demo owner's preference key and marks it pressed", () => {
    renderBare(<DemoViewSwitch />, { wrapper: DemoOwner });
    fireEvent.click(screen.getByRole("button", { name: "I build the product" }));
    expect(JSON.parse(demoPreferences().read("view") ?? "null")).toEqual({ view: "product", focus: [] });
    // Never the standalone desk's own key.
    expect(window.localStorage.getItem(storageKey("view"))).toBeNull();
    expect(screen.getByRole("button", { name: "I build the product" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Everything" })).toHaveAttribute("aria-pressed", "false");
  });

  it("sits at the end of the demo bar, after the facts", () => {
    renderBare(<DemoViewerStatus viewSwitch={<DemoViewSwitch />} />, { wrapper: DemoOwner });
    const bar = screen.getByRole("status");
    expect(bar.lastElementChild?.querySelector("[data-demo-view-switch]")).not.toBeNull();
    expect(bar.firstElementChild).toHaveTextContent("Synthetic demo · Read only");
  });
});

describe("the demo's TV", () => {
  it("draws the saved layout before a pick", () => {
    wallAt("/wall");
    expect(drawn()).toEqual(SAVED);
    expect(screen.getByRole("button", { name: "Everything" })).toHaveAttribute("aria-pressed", "true");
  });

  it("draws the business preset after a stored business pick", () => {
    demoPreferences().write("view", JSON.stringify({ view: "business", focus: [] }));
    wallAt("/wall");
    expect(drawn()).toEqual(WALL_PRESETS.business);
    expect(screen.getByRole("button", { name: "I run the business" })).toHaveAttribute("aria-pressed", "true");
  });

  it("draws in each picked view's words", () => {
    wallAt("/wall");
    expect(screen.getByTestId("drawn")).toHaveAttribute("data-word-level", "technical");
    act(() => { fireEvent.click(screen.getByRole("button", { name: "I run the business" })); });
    expect(screen.getByTestId("drawn")).toHaveAttribute("data-word-level", "business");
    act(() => { fireEvent.click(screen.getByRole("button", { name: "I build the product" })); });
    expect(screen.getByTestId("drawn")).toHaveAttribute("data-word-level", "operational");
  });

  it("keeps the saved layout for Everything", () => {
    demoPreferences().write("view", JSON.stringify({ view: "everything", focus: [] }));
    wallAt("/wall");
    expect(drawn()).toEqual(SAVED);
  });

  it("carries the saved assets' totals onto the picked preset", () => {
    demoPreferences().write("view", JSON.stringify({ view: "product", focus: [] }));
    wallAt("/wall");
    expect(sitesSettings(drawn())).toEqual({ pulseMetrics: { "meadow.example": ["recipe_saves"] } });
    // The preset itself is left as it was.
    expect(sitesSettings(WALL_PRESETS.product)).toBeUndefined();
  });

  it("follows a press in the bar above it", () => {
    wallAt("/wall");
    act(() => { fireEvent.click(screen.getByRole("button", { name: "I run the business" })); });
    expect(drawn()).toEqual(WALL_PRESETS.business);
  });

  it("honours ?view=product, and a press replaces the link's view", () => {
    demoPreferences().write("view", JSON.stringify({ view: "business", focus: [] }));
    wallAt("/wall?view=product");
    expect(wallLayoutWidgets(drawn()).map((widget) => widget.type)).toEqual(
      wallLayoutWidgets(WALL_PRESETS.product).map((widget) => widget.type),
    );
    expect(screen.getByRole("button", { name: "I build the product" })).toHaveAttribute("aria-pressed", "true");
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Everything" })); });
    expect(screen.getByTestId("search")).toHaveTextContent(/^$/u);
    expect(drawn()).toEqual(SAVED);
  });

  it("ignores an unknown ?view=", () => {
    wallAt("/wall?view=nonsense");
    expect(drawn()).toEqual(SAVED);
  });
});

describe("an installation's TV", () => {
  it("keeps its saved layout whatever the person picked, and ignores ?view=", () => {
    window.localStorage.setItem(storageKey("view"), JSON.stringify({ view: "business", focus: [] }));
    wallAt("/wall?view=product", renderStandalone);
    expect(drawn()).toEqual(SAVED);
    expect(document.querySelector("[data-demo-view-switch]")).toBeNull();
    expect(document.querySelector("[data-demo-viewer]")).toBeNull();
  });

  it("draws the workspace view's preset with nothing saved, whatever the person picked", () => {
    state.dashboard = { view: { default: "product" } };
    window.localStorage.setItem(storageKey("view"), JSON.stringify({ view: "business", focus: [] }));
    wallAt("/wall", renderStandalone);
    expect(drawn()).toEqual(WALL_PRESETS.product);
  });

  it("draws in the workspace view's words, whatever the person picked", () => {
    state.dashboard = { wall: { layout: SAVED, history: [] }, view: { default: "business" } };
    window.localStorage.setItem(storageKey("view"), JSON.stringify({ view: "product", focus: [] }));
    wallAt("/wall", renderStandalone);
    expect(screen.getByTestId("drawn")).toHaveAttribute("data-word-level", "business");
  });
});

describe("demoDrawnLayout", () => {
  it.each([false, true])("carries the shared Portfolio row separator choice %s into demo presets", rowBackground => {
    const saved = structuredClone(SAVED);
    const sites = wallLayoutWidgets(saved).find(widget => widget.type === "sites")!;
    sites.settings = { ...sites.settings, rowBackground };
    const drawn = demoDrawnLayout({ wall: { layout: saved, history: [] } }, "product");
    expect(sitesSettings(drawn)).toMatchObject({ rowBackground, pulseMetrics: sites.settings.pulseMetrics });
    expect(sitesSettings(WALL_PRESETS.product)).toBeUndefined();
  });
  it.each([0, 50, 100])("carries %s percent tile transparency through each demo preset without changing the preset", tileTransparency => {
    const saved = { ...structuredClone(SAVED), tileTransparency };
    for (const view of ["business", "product", "everything"] as const) {
      expect(demoDrawnLayout({ wall: { layout: saved, history: [] } }, view).tileTransparency).toBe(tileTransparency);
      expect(WALL_PRESETS[view].tileTransparency).toBeUndefined();
    }
  });
  it("draws Everything's preset when nothing is saved", () => {
    expect(demoDrawnLayout({}, "everything")).toBe(DEFAULT_WALL_LAYOUT);
    expect(demoDrawnLayout({}, null)).toBe(DEFAULT_WALL_LAYOUT);
    expect(demoDrawnLayout({ wall: { layout: SAVED, history: [] } }, "business")).toBe(WALL_PRESETS.business);
  });
});
