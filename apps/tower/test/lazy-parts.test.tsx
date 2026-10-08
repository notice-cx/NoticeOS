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
import { AssetDetailRoute } from "@/routes/AssetDetailRoute";
import { everyTabPayload } from "./asset-detail-fixture";
import { stubJsonFetch } from "./stub-fetch";

// A task source connected, as this installation's is (D32, bead
// ro-ujb9.143): the task screens here render exactly as before it existed.
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

// PARTS OF A SCREEN THAT ARRIVE WHEN THEY ARE OPENED (bead `ro-ujb9.84`).
//
// The route split (`ro-82x`, `route-split.test.tsx`) gave every address its own
// screen file. This file pins the next step: the asset page's nine tabs and the
// command palette are fetched when they are opened, not with the page — and the
// four things that must survive that: a tab switch never flashes a placeholder,
// a deep link still lands on its section, the first ⌘K still opens the
// palette, and a part whose code is gone gets the same recovery a screen does.
//
// HOW "FETCHED" IS OBSERVED. Every tab module and the palette module is mocked
// with a pass-through factory. Vitest runs a factory the first time something
// imports the module, and — the page importing none of them statically, which
// the first describe checks — that first import IS the lazy fetch. Each factory
// can also be HELD, which is how a test sees the page while a part's code is
// still on its way. Nothing in this file preloads anything.

vi.hoisted(() => {
  process.env.TZ = "UTC";
});

const code = vi.hoisted(() => {
  const requested: string[] = [];
  const held = new Map<string, { gate: Promise<void>; open: () => void }>();
  /** Parts whose code the "server" no longer has. */
  const gone = new Set<string>();
  return {
    requested,
    gone,
    hold(part: string) {
      let open = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      held.set(part, { gate, open });
    },
    release(part: string) {
      held.get(part)?.open();
    },
    async arrive(part: string) {
      requested.push(part);
      await held.get(part)?.gate;
    },
  };
});

// `vi.mock` is hoisted above everything, so each call is spelled out rather
// than looped. `lazy-tabs.ts` reads each module's named export in a `.then`, so
// a module whose code is "gone" answers that read with the browser's own
// could-not-fetch error — which is what reaches `lazyPart`, exactly as a real
// failed import would.
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
// what this file is about (the same stand-ins `command-palette.test.tsx` uses).
const ASSETS = [{
  id: "meals.example", displayName: "Meal Planner", worstSeverity: null, status: "live",
  // A site that has reported, so its links open its Overview (`sitePath`).
  activeUsers: { series: [{ t: "2026-09-01", v: 12 }], provisionalFrom: null, collectedAt: null },
} as AssetCard];
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

/**
 * The classes that carry a STATE — the same list `route-split.test.tsx` holds
 * the screen frames to. A part still loading must not wear any of them.
 */
const STATE_CLASS =
  /(?:^|[\s:-])(?:text|bg|border|fill|stroke|ring)-(?:error|warn|urgent|info|healthy|connected|milestone|trend-positive|trend-negative|live-up|live-down|search-bing|financial-revenue|financial-cost|chart-[a-z-]+|primary)\b/;

function expectNothingDataLike(container: Element) {
  expect(container.textContent ?? "").not.toMatch(/\d/);
  expect(container.querySelectorAll("svg, canvas, img, table, progress, meter")).toHaveLength(0);
  for (const element of container.querySelectorAll<HTMLElement>("*")) {
    expect(element.getAttribute("class") ?? "", element.outerHTML).not.toMatch(STATE_CLASS);
  }
}

// ── the files ───────────────────────────────────────────────────────────────

describe("what the page and the shell import", () => {
  const src = (file: string) =>
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src", file), "utf8");
  /** Every module a file imports statically, with `import type` left out:
   * the build erases those, so they fetch nothing. */
  const staticImports = (text: string) =>
    [...text.matchAll(/^import\s(?!type\s)[^;]*?from\s+"([^"]+)";/gms)].map((match) => match[1] ?? "");

  it("the asset page imports no tab module — each arrives through lazy-tabs", () => {
    const imports = staticImports(src("routes/AssetDetailRoute.tsx"));
    // The reading works: the tab BAR, which every tab shares, is imported.
    expect(imports).toContain("@/routes/asset-detail/AssetTabs");
    expect(imports).toContain("@/routes/asset-detail/lazy-tabs");
    const TAB_MODULES = ["Overview", "Growth", "Money", "Search", "Alerts", "Tasks", "Activity", "Sources", "Settings"];
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

// ── lazyPart ────────────────────────────────────────────────────────────────

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
    // It reloaded a moment ago, so the guard stops at the message.
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

// ── the frames a part stands in with ────────────────────────────────────────

describe("RouteLoading / RouteLoadFailure for a part of a page", () => {
  it("panel: says loading, politely, in the panel's width, and nothing that could be read as data", () => {
    const { container } = render(<RouteLoading surface="panel" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Loading this section…");
    // No page padding or column width: the header and tab bar already drew them.
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

// ── the asset page's tabs ───────────────────────────────────────────────────

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
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value(this: Element) {
        scrolled.push(this.id);
      },
    });
    stubJsonFetch(everyTabPayload());
    code.gone.add("alerts");
    code.hold("activity");

    // 1 · A DEEP LINK INTO A TAB WHOSE CODE IS STILL ON ITS WAY. An alert's
    // change chip links at `#timeline`, which lives on Activity.
    renderAssetPage("/assets/meals.example#timeline");
    const panel = await screen.findByRole("tabpanel");
    expect(screen.getByTestId("path")).toHaveTextContent("/assets/meals.example/activity#timeline");
    // Only the tab the link is going to was asked for — never the Overview the
    // bare URL would have shown.
    expect(code.requested).toEqual(["activity"]);
    // The report is here, the tab's code is not: the neutral frame holds its
    // place, and there is no section yet to scroll to.
    const frame = within(panel).getByRole("status");
    expect(frame).toHaveAttribute("data-route-loading", "panel");
    expectNothingDataLike(frame);
    expect(scrolled).toEqual([]);

    code.release("activity");
    expect(await within(panel).findByText("Timeline")).toBeInTheDocument();
    // The section came into view once the code had drawn it.
    await waitFor(() => expect(scrolled).toEqual(["timeline"]));

    // From here on, no switch may show a loading frame.
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
    observer.observe(document.body, { childList: true, subtree: true });

    const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });
    const showing = () => panel.getAttribute("aria-labelledby");

    // 2 · A SWITCH WHILE THE NEXT TAB'S CODE IS ON ITS WAY keeps the tab being
    // left on screen — no placeholder — until it arrives.
    code.hold("overview");
    fireEvent.click(tab("Overview"));
    await waitFor(() => expect(code.requested).toContain("overview"));
    expect(showing()).toBe("asset-tab-activity");
    expect(within(panel).getByText("Timeline")).toBeInTheDocument();
    code.release("overview");
    await waitFor(() => expect(showing()).toBe("asset-tab-overview"));
    expect(within(panel).getAllByText("What matters").length).toBeGreaterThan(0);

    // 3 · EVERY OTHER TAB: not asked for until it is opened.
    for (const [key, label] of [
      ["growth", "Growth"],
      ["financials", "Money"],
      ["search", "Search"],
      ["sources", "Data sources"],
    ] as const) {
      expect(code.requested, `${key} before it was opened`).not.toContain(key);
      fireEvent.click(tab(label));
      await waitFor(() => expect(showing()).toBe(`asset-tab-${key}`));
      expect(code.requested, `${key} once opened`).toContain(key);
    }

    // 4 · A POINTER RESTING ON A TAB, or the keyboard focusing it, fetches its
    // code before the click.
    expect(code.requested).not.toContain("settings");
    fireEvent.pointerEnter(tab("Settings"));
    await waitFor(() => expect(code.requested).toContain("settings"));
    expect(showing()).toBe("asset-tab-sources");
    expect(code.requested).not.toContain("tasks");
    fireEvent.focus(tab("Tasks"));
    await waitFor(() => expect(code.requested).toContain("tasks"));
    fireEvent.click(tab("Settings"));
    await waitFor(() => expect(showing()).toBe("asset-tab-settings"));
    fireEvent.click(tab("Tasks"));
    await waitFor(() => expect(showing()).toBe("asset-tab-tasks"));

    observer.disconnect();
    expect(flashes).toEqual([]);

    // 5 · A TAB WHOSE CODE IS GONE (a tab opened before a rebuild) gets the
    // shared recovery IN ITS PANEL: the header and the tab bar that did load
    // stay. It reloaded moments ago, so the guard stops at the message.
    fireEvent.click(tab("Alerts"));
    const alert = await within(panel).findByRole("alert");
    expect(alert).toHaveAttribute("data-route-load-failure", "panel");
    expect(alert).toHaveTextContent("This section didn't load");
    expect(within(alert).getByRole("heading", { level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Meal Planner");
    expect(tab("Alerts")).toHaveAttribute("aria-selected", "true");

    // Every tab was asked for exactly once.
    expect([...code.requested].sort()).toEqual(
      ["activity", "alerts", "financials", "growth", "overview", "search", "settings", "sources", "tasks"],
    );
  });
});

// ── the command palette ─────────────────────────────────────────────────────

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
    // The desk page drew without the palette's code.
    expect(code.requested).not.toContain("palette");

    // The modifier alone starts the fetch — the moment before a possible K.
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    await waitFor(() => expect(code.requested).toContain("palette"));
    expect(screen.queryByRole("dialog")).toBeNull();

    // The K arrives before the code: the open is kept, and nothing stands in —
    // no empty box, no list-shaped placeholder.
    const before = document.body.innerHTML;
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("[data-route-loading]")).toBeNull();
    expect(document.body.innerHTML).toBe(before);

    code.release("palette");
    const dialog = await screen.findByRole("dialog", { name: "Search pages and sites" });
    expect(document.activeElement).toBe(within(dialog).getByPlaceholderText("Search pages and sites…"));

    // And from then on it is the palette it always was: Escape closes it, ⌘K
    // toggles it, Ctrl+K is the same shortcut.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Search pages and sites" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps focus on its field when it MOUNTS open under StrictMode, and gives it back on close", async () => {
    // Development — what `os:up` serves — runs StrictMode, which rehearses an
    // unmount of every effect on mount. Since the palette is drawn from its
    // first open onward it mounts OPEN, and that rehearsal used to hand focus
    // straight back to the element that had it: here, a tab link the operator
    // had just clicked.
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
    const dialog = await screen.findByRole("dialog", { name: "Search pages and sites" });
    const field = within(dialog).getByPlaceholderText("Search pages and sites…");
    await waitFor(() => expect(document.activeElement).toBe(field));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(link);
  });
});
