import { fireEvent, render, screen, within } from "./render";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCard, WallPayload } from "@shared/wall";

// What a view changes in the shell, the palette and a site's tab bar. The
// wall and the provider reads are mocked: these cases are about which entries
// are drawn, and the stored choice is the one input that varies.
const state = vi.hoisted(() => ({ assets: [] as AssetCard[] }));

vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({
    data: { assets: state.assets, dashboard: {} } as unknown as WallPayload,
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/useIntegrationProviders", () => ({
  INTEGRATION_PROVIDERS_KEY: ["integration-providers"],
  useIntegrationProviders: () => ({ data: undefined, isPending: true, isError: false }),
}));

vi.mock("@/hooks/useWork", () => ({
  useWork: () => ({ data: undefined, isPending: true, isError: false }),
}));

vi.mock("@/hooks/useConnections", () => ({
  useConnections: () => ({ credentials: undefined, items: null }),
}));

import { SITE_TABS, VIEW_LIBRARY, VIEW_NAV_PATHS, viewSpec } from "@shared/views";
import { AppShell, Sidebar } from "@/components/AppShell";
import { NAV_ITEMS, PAGE_ITEMS, sidebarItems } from "@/components/nav-items";
import { ASSET_TABS, AssetTabs } from "@/routes/asset-detail/AssetTabs";
import { storageKey } from "@/lib/browser-storage";
import { everyTabPayload } from "./asset-detail-fixture";
import { loadCommandPalette } from "./lazy-code";
import { resetTaskSourceMock } from "./task-source-mock";

beforeAll(loadCommandPalette);

beforeEach(() => {
  state.assets = [
    {
      id: "meadow.example",
      displayName: "Meadow Board",
      status: "live",
      worstSeverity: null,
      activeUsers: { series: [{ t: "2026-09-01", v: 12 }], provisionalFrom: null, collectedAt: null },
    } as AssetCard,
  ];
  resetTaskSourceMock();
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

function storeView(view: string) {
  window.localStorage.setItem(storageKey("view"), JSON.stringify({ view, focus: [] }));
}

/** The sidebar's page entries, by label, leaving out the site rows under Sites. */
function navEntries(nav: HTMLElement): string[] {
  const labels = new Set(NAV_ITEMS.map((item) => item.label));
  return within(nav)
    .getAllByRole("link")
    .map((link) => link.textContent?.trim() ?? "")
    .filter((name) => labels.has(name));
}

function CurrentPath() {
  const { pathname } = useLocation();
  return <span data-testid="path">{pathname}</span>;
}

function renderShell(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="*" element={<CurrentPath />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("the view registry matches the screens it filters", () => {
  it("names only sidebar paths and site tabs that exist", () => {
    const paths = NAV_ITEMS.map((item) => item.to);
    for (const view of VIEW_LIBRARY) {
      for (const path of view.nav) expect(paths).toContain(path);
      for (const tab of view.siteTabs) expect(ASSET_TABS).toContain(tab);
    }
    // Everything is today's screens: the same entries in the same order.
    expect([...VIEW_NAV_PATHS]).toEqual(paths);
    expect([...SITE_TABS]).toEqual([...ASSET_TABS]);
    expect(sidebarItems(viewSpec("everything").nav)).toEqual(NAV_ITEMS);
  });
});

describe("the sidebar follows the view", () => {
  it("shows all ten entries when no view is stored", () => {
    render(
      <MemoryRouter>
        <Sidebar theme="dark" onToggleTheme={() => {}} />
      </MemoryRouter>,
    );
    const entries = navEntries(screen.getByRole("navigation", { name: "Main" }));
    expect(entries).toHaveLength(10);
    expect(entries).toEqual(NAV_ITEMS.map((item) => item.label));
  });

  it("shows the business view's five entries, in the sidebar's order", () => {
    storeView("business");
    render(
      <MemoryRouter>
        <Sidebar theme="dark" onToggleTheme={() => {}} />
      </MemoryRouter>,
    );
    expect(navEntries(screen.getByRole("navigation", { name: "Main" }))).toEqual([
      "Home",
      "Sites",
      "Tasks",
      "Money",
      "Settings",
    ]);
    // The site rows under Sites and the footer stay.
    expect(screen.getByRole("link", { name: /Meadow Board/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "TV dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Search/ })).toBeInTheDocument();
  });
});

describe("the palette lists every page and switches the view", () => {
  function openPalette() {
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    return screen.getByRole("dialog", { name: "Search pages and sites" });
  }

  function rows(dialog: HTMLElement): string[] {
    return [...dialog.querySelectorAll("[cmdk-item]")].map((el) => el.textContent ?? "");
  }

  it("keeps every page under a narrow view and offers the two other views", () => {
    storeView("business");
    renderShell("/financials");
    const dialog = openPalette();
    const shown = rows(dialog);
    for (const page of PAGE_ITEMS) expect(shown).toContain(page.label);
    const switches = shown.filter((row) => row.startsWith("Switch to · "));
    expect(switches).toEqual([
      `Switch to · ${viewSpec("product").label}`,
      `Switch to · ${viewSpec("everything").label}`,
    ]);
  });

  it("switching closes the palette, stays on the page and changes the sidebar", () => {
    renderShell("/financials");
    const [nav] = screen.getAllByRole("navigation", { name: "Main" });
    expect(navEntries(nav!)).toHaveLength(10);

    const dialog = openPalette();
    expect(rows(dialog).filter((row) => row.startsWith("Switch to · "))).toEqual([
      `Switch to · ${viewSpec("business").label}`,
      `Switch to · ${viewSpec("product").label}`,
    ]);
    fireEvent.click(within(dialog).getByText(`Switch to · ${viewSpec("business").label}`));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("path")).toHaveTextContent("/financials");
    const [after] = screen.getAllByRole("navigation", { name: "Main" });
    expect(navEntries(after!)).toEqual(["Home", "Sites", "Tasks", "Money", "Settings"]);
    expect(JSON.parse(window.localStorage.getItem(storageKey("view")) ?? "null")).toEqual({
      view: "business",
      focus: [],
    });
  });

  it("finds a view by the word view", () => {
    renderShell("/");
    const dialog = openPalette();
    fireEvent.change(within(dialog).getByPlaceholderText("Search pages and sites…"), {
      target: { value: "view" },
    });
    expect(rows(dialog).filter((row) => row.startsWith("Switch to · "))).toHaveLength(2);
  });
});

describe("a site's tabs follow the view", () => {
  function renderTabs(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/assets/:id/:tab?"
            element={<AssetTabs data={everyTabPayload()} assetId="meadow.example" nowMs={0} />}
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  function tabNames(): string[] {
    return screen.getAllByRole("tab").map((tab) => tab.textContent?.replace(/\d+$/, "").trim() ?? "");
  }

  it("shows every tab when no view is stored", () => {
    renderTabs("/assets/meadow.example");
    expect(screen.getAllByRole("tab")).toHaveLength(ASSET_TABS.length);
  });

  it("shows the business view's tabs in the bar's order", () => {
    storeView("business");
    renderTabs("/assets/meadow.example");
    expect(tabNames()).toEqual(["Overview", "Money", "Search", "Health", "Tasks", "Settings"]);
  });

  it("shows the product view's tabs, Health after Codebase", () => {
    storeView("product");
    renderTabs("/assets/meadow.example");
    expect(tabNames()).toEqual(["Overview", "Growth", "Money", "Search", "Codebase", "Health", "Tasks", "Data sources", "Settings"]);
  });

  it("keeps a deep-linked tab the view leaves out, last", () => {
    storeView("business");
    renderTabs("/assets/meadow.example/activity");
    expect(tabNames()).toEqual(["Overview", "Money", "Search", "Health", "Tasks", "Settings", "Activity"]);
  });
});
