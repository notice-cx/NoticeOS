import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StrictMode, isValidElement, type ComponentType, type ReactElement } from "react";
import { act, fireEvent, render, screen } from "./render";
import type { RouteObject } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each screen is fetched only when its address is opened, a screen still
// loading never looks like data, and a screen whose file has gone away
// recovers instead of going blank; the route table itself is pinned so a
// later static import cannot put every screen back into the first download.

import { deskRoutes, routes } from "@/App";
import { RouteLoadFailure, RouteLoading } from "@/components/RouteLoading";
import { isChunkLoadError } from "@/lib/chunk-recovery";
import { lazyPage, prefetchRoute } from "@/lib/lazy-route";
import { AliasRedirect } from "@/routes/AliasRedirect";
import { componentAt } from "./route-table";

/** What each browser actually rejects a missing module with. */
const CHROMIUM = new TypeError(
  "Failed to fetch dynamically imported module: http://office-mac.local:5173/assets/TasksRoute-Dx1.js",
);
const FIREFOX = new TypeError("error loading dynamically imported module: http://office-mac.local/x.js");
const WEBKIT = new TypeError("Importing a module script failed.");
const VITE_CSS = new Error("Unable to preload CSS for /assets/TasksRoute-Dx1.css");

describe("each screen is its own file", () => {
  // `path.join` over the file path rather than `new URL(…, import.meta.url)`:
  // jsdom replaces the URL class, and its URLs are not `file:` ones.
  const appSource = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/App.tsx"),
    "utf8",
  );

  it("App.tsx imports no screen statically — only the redirects, which answer without a fetch", () => {
    const staticImports = [...appSource.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gms)].map(
      (match) => match[1] ?? "",
    );
    const screens = staticImports.filter(
      (specifier) => specifier.startsWith("@/routes/") || specifier === "@/components/AppShell",
    );
    // A static import here is how every screen ends up in the first download
    // again; `lazyPage(() => import(...))` is the way to add one.
    expect(screens).toEqual(["@/routes/AliasRedirect", "@/routes/PropertyRedirect"]);
  });

  it("every desk screen, the desk shell and the TV load through the router's lazy", () => {
    const redirects = new Set(["/properties", "/properties/:id/:tab?", "/work"]);
    const screens = deskRoutes.filter((route) => !redirects.has(route.path ?? ""));
    expect(screens.length).toBeGreaterThan(12);
    for (const route of [...screens, routes[0]!, routes.find((r) => r.path === "/wall")!]) {
      expect(typeof route.lazy, route.path ?? "(desk shell)").toBe("function");
      expect(route.element, route.path ?? "(desk shell)").toBeUndefined();
      expect(route.Component, route.path ?? "(desk shell)").toBeUndefined();
    }
  });

  it("keeps the aliases as plain redirects", () => {
    const alias = (path: string) =>
      deskRoutes.find((route) => route.path === path)?.element as ReactElement<{ to: string }>;
    expect(alias("/work").type).toBe(AliasRedirect);
    expect(alias("/work").props).toEqual({ to: "/tasks" });
    expect(alias("/properties").type).toBe(AliasRedirect);
    expect(alias("/properties").props).toEqual({ to: "/assets" });
    expect(deskRoutes.find((route) => route.path === "/properties/:id/:tab?")?.element).toBeDefined();
    const fallthrough = routes.find((route) => route.path === "*")?.element as ReactElement<{
      to: string;
    }>;
    expect(fallthrough.props.to).toBe("/");
  });

  const SCREENS: [string, () => Promise<{ default: ComponentType }>][] = [
    ["/", () => import("@/routes/HomeRoute")],
    ["/assets", () => import("@/routes/AssetsRoute")],
    ["/assets/new", () => import("@/routes/AssetNewRoute")],
    ["/assets/:id/:tab?", () => import("@/routes/AssetDetailRoute")],
    ["/alerts/:tab?", () => import("@/routes/AlertsRoute")],
    ["/tasks", () => import("@/routes/TasksRoute")],
    ["/tasks/:id", () => import("@/routes/TaskRoute")],
    ["/financials", () => import("@/routes/FinancialsRoute")],
    ["/health", () => import("@/routes/HealthRoute")],
    ["/integrations", () => import("@/routes/IntegrationsRoute")],
    ["/settings", () => import("@/routes/SettingsRoute")],
    ["/wall/edit", () => import("@/routes/WallEditRoute")],
    ["/workflows/:id?", () => import("@/routes/WorkflowsRoute")],
  ];

  it.each(SCREENS)("%s resolves to the screen it always drew", async (path, load) => {
    expect(await componentAt(deskRoutes, path)).toBe((await load()).default);
  });

  it("the TV resolves to the Wall, outside the shell", async () => {
    const { default: WallRoute } = await import("@/routes/WallRoute");
    expect(await componentAt(routes, "/wall")).toBe(WallRoute);
  });

  it("the System operations list is the workflow page with its System surface", async () => {
    const { default: WorkflowsRoute } = await import("@/routes/WorkflowsRoute");
    const Bound = (await componentAt(deskRoutes, "/health/operations/:id?")) as () => ReactElement<{
      surface: string;
    }>;
    const drawn = Bound();
    expect(drawn.type).toBe(WorkflowsRoute);
    expect(drawn.props.surface).toBe("system");
  });

  it("the desk shell is handed the prefetcher", async () => {
    const { AppShell } = await import("@/components/AppShell");
    const shell = routes[0]!;
    const Bound = (await (shell.lazy as () => Promise<RouteObject>)()).Component as () => ReactElement<{
      onPrefetch: unknown;
    }>;
    const drawn = Bound();
    expect(drawn.type).toBe(AppShell);
    expect(typeof drawn.props.onPrefetch).toBe("function");
  });

  it("draws the TV's true-black frame while the Wall loads, and the desk frame everywhere else", () => {
    const fallback = (route: RouteObject | undefined) =>
      route?.hydrateFallbackElement as ReactElement<{ surface: string }> | undefined;
    expect(fallback(routes.find((route) => route.path === "/wall"))?.props.surface).toBe("wall");
    expect(fallback(routes[0])?.props.surface).toBe("desk");
    for (const route of deskRoutes.filter((r) => typeof r.lazy === "function")) {
      const element = fallback(route);
      expect(isValidElement(element), route.path).toBe(true);
      expect(element?.type).toBe(RouteLoading);
      expect(element?.props.surface).toBe("desk");
    }
  });
});

describe("lazyPage", () => {
  function Page() {
    return <p>page</p>;
  }
  /** A page module whose fetch fails with `error`. */
  const failingLoad = (error: unknown) => (): Promise<{ default: ComponentType }> =>
    Promise.reject(error);

  it("hands the router the module's own component", async () => {
    const route = lazyPage(async () => ({ default: Page }));
    expect((await (route.lazy as () => Promise<RouteObject>)()).Component).toBe(Page);
  });

  it.each([CHROMIUM, FIREFOX, WEBKIT, VITE_CSS])(
    "resolves a file that cannot be fetched to the recovery screen: %s",
    async (error) => {
      const route = lazyPage(failingLoad(error), { surface: "wall" });
      const Resolved = (await (route.lazy as () => Promise<RouteObject>)()).Component as () => ReactElement<{
        surface: string;
      }>;
      const drawn = Resolved();
      expect(drawn.type).toBe(RouteLoadFailure);
      expect(drawn.props.surface).toBe("wall");
    },
  );

  it("lets every other failure throw, exactly as it did before the split", async () => {
    const bug = new ReferenceError("somethingUndefined is not defined");
    const route = lazyPage(failingLoad(bug));
    await expect((route.lazy as () => Promise<RouteObject>)()).rejects.toBe(bug);
  });
});

describe("prefetchRoute", () => {
  function table() {
    const shell = vi.fn(async () => ({ Component: () => null }));
    const tasks = vi.fn(async () => ({ Component: () => null }));
    const settings = vi.fn(async () => ({ Component: () => null }));
    const routeTable: RouteObject[] = [
      {
        lazy: shell,
        children: [
          { path: "/tasks", lazy: tasks },
          { path: "/settings", lazy: settings },
        ],
      },
      { path: "*", element: <p>fallthrough</p> },
    ];
    return { routeTable, shell, tasks, settings };
  }

  it("fetches what one address needs and nothing else", async () => {
    const { routeTable, shell, tasks, settings } = table();
    prefetchRoute(routeTable, "/tasks?status=open#board");
    expect(shell).toHaveBeenCalledTimes(1);
    expect(tasks).toHaveBeenCalledTimes(1);
    expect(settings).not.toHaveBeenCalled();
  });

  it("fetches each file once however often a pointer passes over the link", () => {
    const { routeTable, tasks } = table();
    prefetchRoute(routeTable, "/tasks");
    prefetchRoute(routeTable, "/tasks");
    prefetchRoute(routeTable, "/tasks");
    expect(tasks).toHaveBeenCalledTimes(1);
  });

  it("forgets a failed fetch silently, so the real navigation tries again", async () => {
    const failing = vi.fn(async () => Promise.reject(new Error("offline")));
    const routeTable: RouteObject[] = [{ path: "/alerts", lazy: failing }];
    prefetchRoute(routeTable, "/alerts");
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();
    prefetchRoute(routeTable, "/alerts");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("does nothing for an address no screen answers", () => {
    const { routeTable, shell, tasks, settings } = table();
    prefetchRoute([routeTable[0]!], "/nowhere");
    expect(shell).not.toHaveBeenCalled();
    expect(tasks).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
  });
});

describe("isChunkLoadError", () => {
  it.each([CHROMIUM, FIREFOX, WEBKIT, VITE_CSS])("recognizes %s", (error) => {
    expect(isChunkLoadError(error)).toBe(true);
  });

  it.each([
    new TypeError("Cannot read properties of undefined (reading 'assets')"),
    new Error("Request failed with status 500"),
    "Failed to fetch dynamically imported module",
    null,
    undefined,
    { message: 42 },
  ])("leaves %s alone", (error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });
});

/** The classes that carry a state: severity, health, trend, live movement,
 * provider and series identity. A loading frame wearing any of them would be
 * claiming something about the portfolio it has not read. */
const STATE_CLASS =
  /(?:^|[\s:-])(?:text|bg|border|fill|stroke|ring)-(?:error|warn|urgent|info|healthy|connected|milestone|trend-positive|trend-negative|live-up|live-down|search-bing|financial-revenue|financial-cost|chart-[a-z-]+|primary)\b/;

function expectNothingDataLike(container: HTMLElement) {
  expect(container.textContent ?? "").not.toMatch(/\d/);
  expect(container.querySelectorAll("svg, canvas, img, table, progress, meter")).toHaveLength(0);
  for (const element of container.querySelectorAll<HTMLElement>("*")) {
    expect(element.getAttribute("class") ?? "", element.outerHTML).not.toMatch(STATE_CLASS);
  }
}

describe("RouteLoading", () => {
  it("on the desk: says loading, politely, and nothing that could be read as data", () => {
    const { container } = render(<RouteLoading />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Loading this page…");
    expect(status).toHaveAttribute("data-route-loading", "desk");
    expect(status.className).toContain("max-w-[1400px]");
    expect(status.className).toContain("md:min-h-screen");
    expectNothingDataLike(container);
  });

  it("on the TV: the Wall's own true black, full screen, and nothing that could be read as data", () => {
    const { container } = render(<RouteLoading surface="wall" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Loading the Wall…");
    // `.wall-root` is what sets `--background` to oklch(0 0 0); `bg-background`
    // is what paints it. Without either the TV shows the desk's canvas.
    expect(status).toHaveClass("wall-root", "bg-background", "min-h-screen");
    expectNothingDataLike(container);
  });

  it("delays the visible word rather than flashing it on every load", () => {
    render(<RouteLoading />);
    expect(screen.getByText("Loading this page…")).toHaveClass("route-loading-label");
  });
});

describe("RouteLoadFailure", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(['desk', 'wall', 'panel'] as const)('keeps %s mounted and only opens the app after an explicit press', (surface) => {
    const openUpdated = vi.fn();
    render(<StrictMode><input aria-label="Unsaved draft" defaultValue="Keep this" />
      <RouteLoadFailure surface={surface} openUpdated={openUpdated} /></StrictMode>);
    expect(openUpdated).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(600_000); });
    expect(openUpdated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open app in new tab' }));
    expect(openUpdated).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Unsaved draft' })).toHaveValue('Keep this');
  });
});
