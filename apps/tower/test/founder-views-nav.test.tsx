import { fireEvent, render, screen, within } from "./render";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WallPayload } from "@shared/wall";

vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));
vi.mock("@/hooks/useWall", () => ({ useWall: () => ({ data: { assets: [], dashboard: {} } as unknown as WallPayload, isPending: false, isError: false }) }));
vi.mock("@/hooks/useIntegrationProviders", () => ({ INTEGRATION_PROVIDERS_KEY: ["integration-providers"], useIntegrationProviders: () => ({ data: undefined, isPending: true }) }));
vi.mock("@/hooks/useWork", () => ({ useWork: () => ({ data: undefined, isPending: true, isError: false }) }));
vi.mock("@/hooks/useConnections", () => ({ useConnections: () => ({ credentials: undefined, items: null }) }));

import { SITE_TABS, VIEW_LIBRARY, VIEW_NAV_PATHS } from "@shared/views";
import { AppShell, Sidebar } from "@/components/AppShell";
import { NAV_ITEMS, PAGE_ITEMS, sidebarItems } from "@/components/nav-items";
import { ASSET_TABS, AssetTabs } from "@/routes/asset-detail/AssetTabs";
import { storageKey } from "@/lib/browser-storage";
import { everyTabPayload } from "./asset-detail-fixture";
import { loadCommandPalette } from "./lazy-code";
import { resetTaskSourceMock } from "./task-source-mock";

beforeAll(loadCommandPalette);
beforeEach(() => { resetTaskSourceMock(); window.localStorage.clear(); });
function store(view: string) { window.localStorage.setItem(storageKey("view"), JSON.stringify({ view, focus: [] })); }
function navEntries(nav: HTMLElement) {
  const labels = new Set(NAV_ITEMS.map(item => item.label));
  return within(nav).getAllByRole("link").map(link => link.textContent?.trim() ?? "").filter(name => labels.has(name));
}
function CurrentPage() {
  const location = useLocation();
  return <><span data-testid="path">{location.pathname}{location.search}{location.hash}</span><input aria-label="Unsaved draft" defaultValue="draft" /></>;
}
function shell(path = "/financials?period=month#costs") {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route element={<AppShell />}><Route path="*" element={<CurrentPage />} /></Route></Routes></MemoryRouter>);
}

describe("stable destinations in every purpose view", () => {
  it("matches navigation and asset tabs in their existing order", () => {
    expect(VIEW_NAV_PATHS).toEqual(NAV_ITEMS.map(item => item.to));
    expect(SITE_TABS).toEqual(ASSET_TABS);
    for (const view of VIEW_LIBRARY) {
      expect(sidebarItems(view.nav)).toEqual(NAV_ITEMS);
      expect(view.siteTabs).toEqual(ASSET_TABS);
    }
  });
  it.each(VIEW_LIBRARY)("keeps every sidebar destination in $label", view => {
    store(view.id);
    render(<MemoryRouter><Sidebar theme="dark" onToggleTheme={() => {}} /></MemoryRouter>);
    expect(navEntries(screen.getByRole("navigation", { name: "Main" }))).toEqual(NAV_ITEMS.map(item => item.label));
  });
  it.each(VIEW_LIBRARY)("keeps every asset tab in $label, including a deep link", view => {
    store(view.id);
    render(<MemoryRouter initialEntries={["/assets/meadow.example/activity"]}><Routes><Route path="/assets/:id/:tab?" element={<AssetTabs data={everyTabPayload()} assetId="meadow.example" nowMs={0} />} /></Routes></MemoryRouter>);
    expect(screen.getAllByRole("tab")).toHaveLength(ASSET_TABS.length);
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("global view controls preserve the current page", () => {
  it("changes emphasis without navigating, remounting or discarding a draft", () => {
    shell();
    const draft = screen.getByRole("textbox", { name: "Unsaved draft" });
    fireEvent.change(draft, { target: { value: "edited" } });
    fireEvent.click(within(screen.getByRole("group", { name: "View" })).getByRole("button", { name: "Delivery" }));
    expect(screen.getByTestId("path")).toHaveTextContent("/financials?period=month#costs");
    expect(screen.getByRole("textbox", { name: "Unsaved draft" })).toBe(draft);
    expect(draft).toHaveValue("edited");
    expect(navEntries(screen.getByRole("navigation", { name: "Main" }))).toEqual(NAV_ITEMS.map(item => item.label));
  });
  it("offers every other purpose and every destination in the command palette", () => {
    shell();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = screen.getByRole("dialog", { name: "Search pages and assets" });
    for (const page of PAGE_ITEMS) expect(within(dialog).getByText(page.label)).toBeInTheDocument();
    const rows = [...dialog.querySelectorAll("[cmdk-item]")].map(row => row.textContent);
    expect(rows.filter(row => row?.startsWith("Switch to · "))).toEqual(VIEW_LIBRARY.slice(1).map(view => `Switch to · ${view.label}`));
    fireEvent.click(within(dialog).getByText("Switch to · Reliability"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("path")).toHaveTextContent("/financials?period=month#costs");
    expect(JSON.parse(window.localStorage.getItem(storageKey("view")) ?? "null")).toEqual({ view: "reliability", focus: [] });
  });
  it("does not show the global bar in the TV editor", () => {
    shell("/wall/edit");
    expect(document.querySelector("[data-view-bar]")).toBeNull();
  });
});
