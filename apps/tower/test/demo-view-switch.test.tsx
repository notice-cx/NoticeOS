// The TV keeps its own composition for demo and installation viewers.

import { render as renderBare, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WALL_LAYOUT, wallLayoutWidgets, type WallLayout } from "@shared/wall-layout";
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
vi.mock("@/hooks/useWallWeather", () => ({ useWallWeather: () => undefined }));
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
import { WallRoute } from "@/routes/WallRoute";

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
beforeEach(() => {
  state.dashboard = { wall: { layout: SAVED, history: [] } };
  window.localStorage.clear();
});
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.retire();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe.each(["overview", "growth", "revenue", "delivery", "reliability", "business", "product", "everything"])("TV independent of %s", (view) => {
  it("keeps the demo saved composition, settings and wording", () => {
    demoPreferences().write("view", JSON.stringify({ view, focus: [] }));
    state.dashboard.view = { default: view };
    wallAt(`/wall?view=${view}`);
    expect(drawn()).toEqual(SAVED);
    expect(screen.getByTestId("drawn")).not.toHaveAttribute("data-word-level");
    expect(document.querySelector("[data-demo-view-switch], [data-view-bar]")).toBeNull();
    expect(screen.getByTestId("search")).toHaveTextContent(`?view=${view}`);
  });

  it("uses the independent default for an unsaved demo Wall", () => {
    state.dashboard = { view: { default: view } };
    demoPreferences().write("view", JSON.stringify({ view, focus: [] }));
    wallAt(`/wall?view=${view}`);
    expect(drawn()).toEqual(DEFAULT_WALL_LAYOUT);
  });

  it("keeps an installation's saved layout and settings", () => {
    state.dashboard.view = { default: view };
    window.localStorage.setItem(storageKey("view"), JSON.stringify({ view, focus: [] }));
    wallAt(`/wall?view=${view}`, renderStandalone);
    expect(drawn()).toEqual(SAVED);
    expect(screen.getByTestId("drawn")).not.toHaveAttribute("data-word-level");
    expect(document.querySelector("[data-demo-viewer]")).toBeNull();
  });

  it("uses the independent default for an unsaved installation Wall", () => {
    state.dashboard = { view: { default: view } };
    window.localStorage.setItem(storageKey("view"), JSON.stringify({ view, focus: [] }));
    wallAt("/wall", renderStandalone);
    expect(drawn()).toEqual(DEFAULT_WALL_LAYOUT);
  });
});
