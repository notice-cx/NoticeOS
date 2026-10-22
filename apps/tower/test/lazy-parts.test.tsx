import { deferred } from "./deferred";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Component, StrictMode, Suspense, type ComponentType, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCard, WallPayload } from "@shared/wall";
import { AppShell } from "@/components/AppShell";
import { RouteLoadFailure, RouteLoading } from "@/components/RouteLoading";
import { lazyPart } from "@/lib/lazy-route";
import { preloadCommandPalette } from "@/lib/palette-launch";
import { preloadAssetTab } from "@/routes/asset-detail/lazy-tabs";
import { AssetDetailRoute } from "@/routes/AssetDetailRoute";
import { everyTabPayload } from "./asset-detail-fixture";
import { stubJsonFetch } from "./stub-fetch";

vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

// Every tab module and the palette module is mocked with a pass-through factory.
// Vitest runs a factory the first time something imports the module, and the
// page imports none of them statically (the first describe checks), so that
// first import is the lazy fetch. Each factory can be held to see the page while
// a part's code is on its way; preload promises acknowledge its actual readiness.

vi.hoisted(() => {
  process.env.TZ = "UTC";
});

const code = vi.hoisted(() => {
  const requested: string[] = [];
  const held = new Map<string, { gate: Promise<void>; open: () => void }>();
  const requestEvent = () => {
    let resolve = () => {};
    const promise = new Promise<void>(ready => { resolve = ready; });
    return { promise, resolve };
  };
  const requests = new Map<string, ReturnType<typeof requestEvent>>();
  const request = (part: string) => {
    if (!requests.has(part)) requests.set(part, requestEvent());
    return requests.get(part)!;
  };
  /** Parts whose code the "server" no longer has. */
  const gone = new Set<string>();
  return {
    requested,
    gone,
    whenRequested(part: string) {
      return request(part).promise;
    },
    hold(part: string) {
      let open = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      held.set(part, { gate, open });
    },
    releaseAll() {
      for (const item of held.values()) item.open();
    },
    release(part: string) {
      held.get(part)?.open();
    },
    async arrive(part: string) {
      requested.push(part);
      request(part).resolve();
      await held.get(part)?.gate;
    },
  };
});

// `vi.mock` is hoisted above everything, so each call is spelled out rather
// than looped. `lazy-tabs.ts` reads each module's named export in a `.then`,
// so a module whose code is "gone" answers that read with the browser's own
// could-not-fetch error, exactly as a real failed import would.
function goneModule(exportName: string, file: string) {
  return {
    get [exportName]() {
      throw new TypeError(`Failed to fetch dynamically imported module: http://office-mac.local:5173/src/routes/asset-detail/${file}`);
    },
  };
}
vi.mock("@/routes/asset-detail/OverviewTab", async (importOriginal) => {
  await code.arrive("overview");
  return importOriginal();
});
vi.mock("@/routes/asset-detail/GrowthTab", async (importOriginal) => {
  await code.arrive("growth");
  return importOriginal();
});
vi.mock("@/routes/asset-detail/FinancialsTab", async (importOriginal) => {
  await code.arrive("financials");
  return importOriginal();
});
vi.mock("@/routes/asset-detail/SearchTab", async (importOriginal) => {
  await code.arrive("search");
  return importOriginal();
});
vi.mock("@/routes/asset-detail/CodebaseTab", async (importOriginal) => {
  await code.arrive("codebase");
  return importOriginal();
});
vi.mock("@/routes/asset-detail/HealthTab", async (importOriginal) => {
  await code.arrive("health");
  return importOriginal();
});
vi.mock("@/routes/asset-detail/AlertsTab", async (importOriginal) => {
  await code.arrive("alerts");
  return code.gone.has("alerts") ? goneModule("AlertsTab", "AlertsTab.tsx") : importOriginal();
});
vi.mock("@/routes/asset-detail/TasksTab", async (importOriginal) => {
  await code.arrive("tasks");
  return importOriginal();
});
vi.mock("@/routes/asset-detail/ActivityTab", async (importOriginal) => {
  await code.arrive("activity");
  return importOriginal();
});
vi.mock("@/routes/asset-detail/SourcesTab", async (importOriginal) => {
  await code.arrive("sources");
  return importOriginal();
});
vi.mock("@/routes/asset-detail/SettingsTab", async (importOriginal) => {
  await code.arrive("settings");
  return importOriginal();
});
vi.mock("@/components/CommandPalette", async (importOriginal) => {
  await code.arrive("palette");
  return importOriginal();
});

// The shell reads the wall and the provider list for its sidebar; neither is
// what this file is about.
const ASSETS: AssetCard[] = [{
  id: "meadow.example", displayName: "Meadow Board", worstSeverity: null, status: "live",
  // A site that has reported, so its links open its Overview (`sitePath`).
  senseOnly: false, openError: 0, openWarn: 0,
  booked: { currency: "USD", revenue: 0, cost: 0, net: 0 },
  forecast: { currency: "USD", revenue: 0, cost: 0, net: 0 },
  netPeriod: "2026-07", netByMonthCurrency: "USD", netByMonth: [], netByMonthProvisionalFrom: null,
  pulseReceivedAt: null, firstReportAt: null, work: null, panelReview: null, latestPanelDate: null,
  product: null, codebase: null,
  dataSources: [],
  searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
  activeUsers: { series: [{ t: "2026-09-01", v: 12 }], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
}];
vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({
    data: { assets: ASSETS } as unknown as WallPayload,
    isPending: false,
    isError: false,
  }),
}));
vi.mock("@/hooks/useIntegrationProviders", () => ({
  INTEGRATION_PROVIDERS_KEY: ["integration-providers"],
  useIntegrationProviders: () => ({ data: undefined, isPending: true, isError: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** The moment the shared fixture's dates are read against. */
const NOW = Date.parse("2026-07-05T14:00:00.000Z");

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

const mountObservers = new Set<MutationObserver>();

/** A DOM commit can follow import readiness (React may schedule a Suspense
 * retry). Observe that commit within the unchanged test budget. */
function whenMounted<T extends Element>(query: () => T | null): Promise<T> {
  const ready = deferred<T>();
  const check = () => {
    const element = query();
    if (!element) return;
    observer.disconnect();
    mountObservers.delete(observer);
    ready.resolve(element);
  };
  const observer = new MutationObserver(check);
  mountObservers.add(observer);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  check();
  return ready.promise;
}

afterEach(() => {
  for (const observer of mountObservers) observer.disconnect();
  mountObservers.clear();
  code.releaseAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

/** The classes that carry a state, the same list `route-split.test.tsx`
 * holds the screen frames to. A part still loading must not wear any of them. */
const STATE_CLASS =
  /(?:^|[\s:-])(?:text|bg|border|fill|stroke|ring)-(?:error|warn|urgent|info|healthy|connected|milestone|trend-positive|trend-negative|live-up|live-down|search-bing|financial-revenue|financial-cost|chart-[a-z-]+|primary)\b/;

function expectNothingDataLike(container: Element) {
  expect(container.textContent ?? "").not.toMatch(/\d/);
  expect(container.querySelectorAll("svg, canvas, img, table, progress, meter")).toHaveLength(0);
  for (const element of container.querySelectorAll<HTMLElement>("*")) {
    expect(element.getAttribute("class") ?? "", element.outerHTML).not.toMatch(STATE_CLASS);
  }
}

describe("what the page and the shell import", () => {
  const src = (file: string) =>
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src", file), "utf8");
  /** Every module a file imports statically, with `import type` left out:
   * the build erases those, so they fetch nothing. */
  const staticImports = (text: string) =>
    [...text.matchAll(/^import\s(?!type\s)[^;]*?from\s+"([^"]+)";/gms)].map((match) => match[1] ?? "");

  it("the asset page imports no tab module — each arrives through lazy-tabs", () => {
    const imports = staticImports(src("routes/AssetDetailRoute.tsx"));
    // The reading works: the tab bar, which every tab shares, is imported.
    expect(imports).toContain("@/routes/asset-detail/AssetTabs");
    expect(imports).toContain("@/routes/asset-detail/lazy-tabs");
    const TAB_MODULES = ["Overview", "Growth", "Financials", "Search", "Codebase", "Health", "Alerts", "Tasks", "Activity", "Sources", "Settings"];
    expect(imports.filter((specifier) => TAB_MODULES.some((name) => specifier.endsWith(`/${name}Tab`)))).toEqual([]);
  });

  it("the desk shell imports neither the palette nor cmdk", () => {
    const shell = staticImports(src("components/AppShell.tsx"));
    expect(shell).not.toContain("@/components/CommandPalette");
    expect(shell).not.toContain("@/components/ui/command");
    expect(shell).not.toContain("cmdk");
    // …and neither does the one module the shell reaches the palette through,
    // which names it only as a type and in a dynamic import.
    const launch = staticImports(src("lib/palette-launch.tsx"));
    expect(launch).not.toContain("@/components/CommandPalette");
    expect(launch).not.toContain("cmdk");
  });
});

/** The smallest error boundary: says what it caught. */
class ErrorCatcher extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? <p>caught: {this.state.error.message}</p> : this.props.children;
  }
}

describe("lazyPart", () => {
  function Part({ label }: { label: string }) {
    return <p>{label}</p>;
  }
  const draw = (Component: ComponentType<{ label: string }>) =>
    render(
      <Suspense fallback={<RouteLoading surface="panel" />}>
        <Component label="the part" />
      </Suspense>,
    );

  it("draws code that has already arrived on the very first render — no loading frame", async () => {
    const part = lazyPart(async () => Part);
    expect(await part.preload()).toBe(true);
    draw(part.Component);
    // Synchronously: no `await` between the render and this line.
    expect(screen.getByText("the part")).toBeInTheDocument();
    expect(document.querySelector("[data-route-loading]")).toBeNull();
  });

  it("stands the panel frame in for code still on its way, then draws the part", async () => {
    let arrive = (_: ComponentType<{ label: string }>) => {};
    const part = lazyPart(() => new Promise<ComponentType<{ label: string }>>((resolve) => (arrive = resolve)));
    const { container } = draw(part.Component);
    expect(screen.getByRole("status")).toHaveAttribute("data-route-loading", "panel");
    expectNothingDataLike(container);
    await act(async () => arrive(Part));
    expect(await screen.findByText("the part")).toBeInTheDocument();
  });

  it("fetches once however many times it is asked, and forgets a failed fetch", async () => {
    const load = vi.fn(async () => Part);
    const part = lazyPart(load);
    await Promise.all([part.preload(), part.preload(), part.preload()]);
    expect(load).toHaveBeenCalledTimes(1);

    const flaky = vi
      .fn<() => Promise<ComponentType<{ label: string }>>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module: x.js"))
      .mockResolvedValueOnce(Part);
    const retried = lazyPart(flaky);
    expect(await retried.preload()).toBe(false);
    expect(await retried.preload()).toBe(true);
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it("resolves code that cannot be fetched to the shared recovery, in the panel's frame", async () => {
    const part = lazyPart<{ label: string }>(() =>
      Promise.reject(new TypeError("Failed to fetch dynamically imported module: x.js")),
    );
    draw(part.Component);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-route-load-failure", "panel");
    expect(alert).toHaveTextContent("This section didn't load");
    expect(within(alert).getByRole("button", { name: "Open app in new tab" })).toBeInTheDocument();
  });

  it("lets every other failure throw to whatever handles errors, as a screen's does", async () => {
    const bug = new ReferenceError("somethingUndefined is not defined");
    const part = lazyPart<{ label: string }>(() => Promise.reject(bug));
    // React reports a caught render error on the console; that is not this test.
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorCatcher>
        <Suspense fallback={<RouteLoading surface="panel" />}>
          <part.Component label="the part" />
        </Suspense>
      </ErrorCatcher>,
    );
    expect(await screen.findByText("caught: somethingUndefined is not defined")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("RouteLoading / RouteLoadFailure for a part of a page", () => {
  it("panel: says loading, politely, in the panel's width, and nothing that could be read as data", () => {
    const { container } = render(<RouteLoading surface="panel" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Loading this section…");
    expect(status.className).not.toContain("max-w-");
    expect(status.className).not.toMatch(/\bp-\d/);
    expectNothingDataLike(container);
  });

  it("palette: draws nothing at all while its code arrives", () => {
    const { container } = render(<RouteLoading surface="palette" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("palette failure: says so where the palette would be, and Close, Escape or the backdrop put it away", () => {
    const onDismiss = vi.fn();
    render(<RouteLoadFailure surface="palette" openUpdated={vi.fn()} onDismiss={onDismiss} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Search didn't load");
    expect(alert.textContent ?? "").not.toMatch(/\d/);
    fireEvent.click(within(alert).getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    expect(onDismiss).toHaveBeenCalledTimes(3);
  });
});

function PathProbe() {
  const { pathname, hash } = useLocation();
  return <span data-testid="path">{`${pathname}${hash}`}</span>;
}

function renderAssetPage(url: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/assets/:id/:tab?"
            element={
              <>
                <AssetDetailRoute />
                <PathProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the asset page's tabs", () => {
  it("fetch each tab's code when it is opened — a deep link's tab first, then each tab in turn", async () => {
    const scrolled: string[] = [];
    const scroll = deferred<void>();
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      expect(this.isConnected).toBe(true);
      expect(this.closest('[role="tabpanel"]')).not.toBeNull();
      scrolled.push(this.id);
      scroll.resolve();
    });
    stubJsonFetch(everyTabPayload());
    code.gone.add("alerts");
    for (const part of ["activity", "overview", "growth", "financials", "search", "codebase", "health", "sources", "settings", "tasks", "alerts"]) {
      code.hold(part);
    }

    // 1. A deep link into a tab whose code is still on its way.
    renderAssetPage("/assets/meadow.example#timeline");
    await act(() => code.whenRequested("activity"));
    const panel = await screen.findByRole("tabpanel");
    expect(screen.getByTestId("path")).toHaveTextContent("/assets/meadow.example/activity#timeline");
    expect(code.requested).toEqual(["activity"]);
    const frame = within(panel).getByRole("status");
    expect(frame).toHaveAttribute("data-route-loading", "panel");
    expectNothingDataLike(frame);
    expect(scrolled).toEqual([]);

    await act(async () => {
      code.release("activity");
      expect(await preloadAssetTab("activity")).toBe(true);
    });
    expect(within(panel).getByText("Timeline")).toBeInTheDocument();
    await scroll.promise;
    expect(scrolled).toEqual(["timeline"]);

    const flashes: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches("[data-route-loading]") || node.querySelector("[data-route-loading]"))) {
            flashes.push(screen.getByTestId("path").textContent ?? "");
          }
        }
      }
    });
    mountObservers.add(observer);
    observer.observe(document.body, { childList: true, subtree: true });

    const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });
    const showing = () => panel.getAttribute("aria-labelledby");

    // 2. A switch while the next tab's code is on its way keeps the tab being
    // left on screen until it arrives.
    fireEvent.click(tab("Overview"));
    await code.whenRequested("overview");
    expect(showing()).toBe("asset-tab-activity");
    expect(within(panel).getByText("Timeline")).toBeInTheDocument();
    await act(async () => {
      code.release("overview");
      expect(await preloadAssetTab("overview")).toBe(true);
    });
    expect(showing()).toBe("asset-tab-overview");
    expect(within(panel).getAllByText("What matters").length).toBeGreaterThan(0);

    // 3. Every other tab: not asked for until it is opened.
    for (const [key, label] of [
      ["growth", "Growth"],
      ["financials", "Money"],
      ["search", "Search"],
      ["codebase", "Codebase"],
      ["health", "Health"],
      ["sources", "Data sources"],
    ] as const) {
      expect(code.requested, `${key} before it was opened`).not.toContain(key);
      const previous = showing();
      fireEvent.click(tab(label));
      await code.whenRequested(key);
      expect(showing()).toBe(previous);
      await act(async () => {
        code.release(key);
        expect(await preloadAssetTab(key)).toBe(true);
      });
      expect(showing()).toBe(`asset-tab-${key}`);
      expect(code.requested, `${key} once opened`).toContain(key);
    }

    // 4. A pointer resting on a tab, or the keyboard focusing it, fetches its
    // code before the click.
    expect(code.requested).not.toContain("settings");
    fireEvent.pointerEnter(tab("Settings"));
    await code.whenRequested("settings");
    expect(showing()).toBe("asset-tab-sources");
    expect(code.requested).not.toContain("tasks");
    fireEvent.focus(tab("Tasks"));
    await code.whenRequested("tasks");
    // The deep link promises the first request. Independent preloads promise
    // readiness, not completion order; resolve these in the opposite order.
    await act(async () => {
      code.release("tasks");
      expect(await preloadAssetTab("tasks")).toBe(true);
      code.release("settings");
      expect(await preloadAssetTab("settings")).toBe(true);
    });
    expect(showing()).toBe("asset-tab-sources");
    fireEvent.click(tab("Settings"));
    expect(showing()).toBe("asset-tab-settings");
    fireEvent.click(tab("Tasks"));
    expect(showing()).toBe("asset-tab-tasks");

    observer.disconnect();
    mountObservers.delete(observer);
    expect(flashes).toEqual([]);

    // 5. A tab whose code is gone gets the shared recovery in its panel: the
    // header and the tab bar that did load stay.
    fireEvent.click(tab("Alerts"));
    await code.whenRequested("alerts");
    await act(async () => {
      code.release("alerts");
      expect(await preloadAssetTab("alerts")).toBe(false);
    });
    const alert = within(panel).getByRole("alert");
    expect(alert).toHaveAttribute("data-route-load-failure", "panel");
    expect(alert).toHaveTextContent("This section didn't load");
    expect(within(alert).getByRole("heading", { level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Meadow Board");
    expect(tab("Alerts")).toHaveAttribute("aria-selected", "true");

    expect([...code.requested].sort()).toEqual(
      ["activity", "alerts", "codebase", "financials", "growth", "health", "overview", "search", "settings", "sources", "tasks"],
    );
  });
});

function renderShell(pathname = "/financials") {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="*" element={<p>the page</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("the command palette", () => {
  it("opens on the very first ⌘K, as soon as its code arrives, drawing nothing meanwhile", async () => {
    code.hold("palette");
    renderShell();
    expect(code.requested).not.toContain("palette");

    // The modifier alone starts the fetch, the moment before a possible K.
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    await code.whenRequested("palette");
    expect(screen.queryByRole("dialog")).toBeNull();

    const before = document.body.innerHTML;
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("[data-route-loading]")).toBeNull();
    expect(document.body.innerHTML).toBe(before);

    const mounted = whenMounted(() => screen.queryByRole("dialog", { name: "Search pages and assets" }));
    await act(async () => {
      code.release("palette");
      expect(await preloadCommandPalette()).toBe(true);
    });
    const dialog = await mounted;
    expect(document.activeElement).toBe(within(dialog).getByPlaceholderText("Search pages and assets…"));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Search pages and assets" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps focus on its field when it MOUNTS open under StrictMode, and gives it back on close", async () => {
    // Development runs StrictMode, which rehearses an unmount of every effect
    // on mount. The palette mounts open, and that rehearsal must not hand
    // focus back to the element that had it.
    render(
      <StrictMode>
        <MemoryRouter initialEntries={["/alerts"]}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="*" element={<a href="/alerts/history">History</a>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
    const link = screen.getByRole("link", { name: "History" });
    link.focus();
    expect(document.activeElement).toBe(link);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Search pages and assets" });
    const field = within(dialog).getByPlaceholderText("Search pages and assets…");
    await waitFor(() => expect(document.activeElement).toBe(field));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(link);
  });
});
