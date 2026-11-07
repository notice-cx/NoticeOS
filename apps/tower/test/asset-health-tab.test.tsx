import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AssetDetailPayload, HygieneHistory } from "@shared/asset-detail";
import type { AssetDetailFor } from "@shared/asset-detail-views";
import type { AssetCard, CardProduct, WallPayload } from "@shared/wall";

// Each status owns the readings expanded inside its own card.

const ZERO = { currency: "USD", revenue: 0, cost: 0, net: 0 };
const NO_TREND = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };

const state = vi.hoisted(() => ({ assets: [] as unknown[] }));

vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({ data: { assets: state.assets, attention: [], dashboard: {} } as unknown as WallPayload, isPending: false, isError: false }),
}));
vi.mock("@/hooks/useConnections", () => ({ useConnections: () => ({ credentials: undefined, items: null }) }));
vi.mock("@/hooks/useWork", () => ({ useWork: () => ({ data: undefined, isPending: true, isError: false }) }));
vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AssetDetailRoute } from "@/routes/AssetDetailRoute";
import { HealthTab } from "@/routes/asset-detail/HealthTab";
import { storageKey } from "@/lib/browser-storage";
import { everyTabPayload, viewOf } from "./asset-detail-fixture";
import { loadAssetTabs } from "./lazy-code";

beforeAll(loadAssetTabs);

afterEach(() => {
  state.assets = [];
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function product(over: Partial<CardProduct> = {}): CardProduct {
  return {
    observedAt: "2026-07-04T06:00:00.000Z", speed: "fired", worstSpeed: "poor", errors: "clear",
    errorPeople: 0, jsErrorFinding: false, funnel: null, ...over,
  };
}

function siteCard(over: Partial<AssetCard> = {}): AssetCard {
  return {
    id: "meadow.example", displayName: "Meadow Board", status: "live", senseOnly: false, worstSeverity: null, openError: 0, openWarn: 0,
    booked: ZERO, forecast: ZERO, netPeriod: "2026-07", netByMonthCurrency: "USD",
    pulseReceivedAt: "2026-07-05T02:00:00.000Z", firstReportAt: null,
    dataSources: [{ id: "uptime", label: "Uptime", state: "live" }],
    activeUsers: NO_TREND, searchClicks: NO_TREND, netByMonth: [], netByMonthProvisionalFrom: null,
    work: null, panelReview: null, latestPanelDate: null,
    product: product(),
    codebase: null,
    ...over,
  };
}

const reading = (date: string, status: "ok" | "warn" | "error" | "unreachable", value: number | null) => ({ date, observedAt: `${date}T03:00:00.000Z`, status, value });

const HYGIENE: HygieneHistory = {
  htmlDepth: { check: "html-depth", readings: [reading("2026-07-04", "ok", 900)], latest: reading("2026-07-04", "ok", 900) },
  robots: { check: "robots-ai-access", readings: [], latest: null },
  sitemap: { check: "sitemap", readings: [reading("2026-07-04", "ok", 42)], latest: reading("2026-07-04", "ok", 42) },
  bots: [{ bot: "GPTBot", allowed: false }, { bot: "ClaudeBot", allowed: true }],
  windowDays: 30,
  headers: { observedAt: "2026-07-04T03:00:00.000Z", headers: [{ name: "strict-transport-security", present: true }, { name: "x-frame-options", present: false }] },
};

function healthData(): AssetDetailFor<"health"> {
  const whole: AssetDetailPayload = { ...everyTabPayload(), hygiene: HYGIENE };
  return viewOf(whole, "health") as unknown as AssetDetailFor<"health">;
}

function renderTab() {
  return render(
    <MemoryRouter>
      <HealthTab data={healthData()} nowMs={Date.parse("2026-07-05T12:00:00.000Z")} />
    </MemoryRouter>,
  );
}

function openEvidence(container: HTMLElement, key: string): HTMLElement {
  if (!container.querySelector(`[data-health-evidence="${key}"]`)) fireEvent.click(container.querySelector(`[data-health-fact="${key}"]`)!);
  return container.querySelector<HTMLElement>(`[data-health-evidence="${key}"]`)!;
}

describe("the Health tab", () => {
  it("draws the five facts as words, a problem in its colour", () => {
    state.assets = [siteCard()];
    const { container } = renderTab();

    const facts = [...container.querySelectorAll("[data-health-fact]")];
    expect(facts.map((fact) => fact.getAttribute("data-health-fact"))).toEqual(["reachable", "speed", "errors", "search", "code"]);
    const speed = container.querySelector('[data-health-fact="speed"]')!;
    expect(speed).toHaveAttribute("data-fact-state", "warn");
    expect(speed.querySelector(".text-warn")).not.toBeNull();
    expect(container.querySelectorAll("[data-health-card]")).toHaveLength(5);
    expect(container.querySelector('[data-health-fact="code"]')).toHaveAttribute("data-fact-state", "unknown");
  });

  it("expands readings inside their status card and closes only the chosen card", () => {
    state.assets = [siteCard()];
    const { container } = renderTab();
    expect(container.querySelectorAll('[data-health-evidence]')).toHaveLength(0);
    const reachable = container.querySelector('[data-health-fact="reachable"]')!;
    const evidence = openEvidence(container, 'reachable');
    expect(reachable).toHaveAttribute('aria-expanded', 'true');
    expect(reachable).toHaveAttribute('aria-controls', evidence.id);
    expect(evidence.closest('[data-health-card]')).toHaveAttribute('data-health-card', 'reachable');
    openEvidence(container, 'search');
    expect(container.querySelectorAll('[data-health-evidence]')).toHaveLength(2);
    fireEvent.click(reachable);
    expect(reachable).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('[data-health-evidence="reachable"]')).toBeNull();
    expect(container.querySelectorAll('[data-health-evidence]')).toHaveLength(1);
  });

  it("draws four weeks of visits from search as bars before the words", () => {
    const start = Date.parse("2026-06-07T00:00:00.000Z");
    const series = Array.from({ length: 28 }, (_, index) => ({ t: new Date(start + index * 86_400_000).toISOString().slice(0, 10), v: 10 + index }));
    state.assets = [siteCard({ searchClicks: { ...NO_TREND, series } })];
    const { container } = renderTab();

    const search = openEvidence(container, 'search')!;
    const chart = within(search as HTMLElement).getByRole("img", { name: /Visits from search a day, last 4 weeks/ });
    expect(chart.compareDocumentPosition(within(search as HTMLElement).getByText(/visits from search in the last 4 weeks/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws the code's size as one line through weekly reports", () => {
    // The fixture's history is thirteen weekly reports ending on the clock's day.
    state.assets = [siteCard({ codebase: { date: "2026-07-05", commit: "abc1234", codeLines: 48_210, growthPercent30d: 2, comparedDays: 30 } })];
    const { container } = renderTab();

    const code = openEvidence(container, 'code') as HTMLElement;
    const chart = within(code).getByRole("img", { name: /Lines of code over the last 90 days/ });
    const paths = [...chart.querySelectorAll("path[d]")].map((path) => path.getAttribute("d")!);
    expect(paths.length).toBeGreaterThan(0);
    // One run: a single move, then segments through every day, never a
    // move per reading with nothing joining them.
    const line = paths.find((d) => /[LC]/.test(d) && !/Z$/.test(d));
    expect(line).toBeDefined();
    expect(line!.match(/M/g)).toHaveLength(1);
    expect(line!.match(/[LC]/g)!.length).toBeGreaterThanOrEqual(12 * 7);
    for (const d of paths) expect(d.match(/M/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("says a fact is not measured yet, with the way to connect it", () => {
    state.assets = [siteCard({ codebase: null })];
    const { container } = renderTab();

    const evidence = openEvidence(container, 'code')!;
    expect(within(evidence as HTMLElement).getByRole("link", { name: "Set up the code report →" })).toHaveAttribute(
      "href",
      "/assets/meadow.example/codebase#codebase-setup",
    );
  });

  it("waits for the asset's card rather than guessing", () => {
    state.assets = [];
    const { container } = renderTab();
    expect(container.querySelector('[data-health-tab="reading"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-health-card]")).toHaveLength(0);
  });
});

describe("the Health tab on the asset page", () => {
  function stubStore() {
    const payload: AssetDetailPayload = { ...everyTabPayload(), hygiene: HYGIENE };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://tower.test");
      const view = url.searchParams.get("view");
      const body = url.pathname.startsWith("/api/assets/") ? (view ? viewOf(payload, view as "health") : payload) : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
  }

  function renderAt(path: string) {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/assets/:id/:tab?" element={<AssetDetailRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it.each(["overview", "growth", "revenue", "delivery", "reliability"])("keeps Health and every technical tab accessible in %s", async (view) => {
    window.localStorage.setItem(storageKey("view"), JSON.stringify({ view, focus: [] }));
    state.assets = [siteCard()];
    stubStore();
    const { container } = renderAt("/assets/meadow.example/health");

    await waitFor(() => expect(container.querySelector('[data-health-tab="watch"]')).not.toBeNull());
    expect(screen.getByRole("tab", { name: /^Health/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent?.replace(/\d+$/, "").trim())).toEqual([
      "Overview", "Growth", "Journeys", "Money", "Search", "Codebase", "Health", "Alerts", "Tasks", "Activity", "Data sources", "Settings",
    ]);
  });
});
