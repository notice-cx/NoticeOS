// One source, one status, on every screen: Integrations, the asset's Data
// sources tab, its header and its Home row agree, and the Wall shows site
// health and specific Needs you concerns. The payloads are built by the
// Worker's own functions over the suite's frozen register (`fixture-config/`).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "./render";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTEGRATION_MONITORS,
  INTEGRATION_PROVIDERS,
  type CredentialSummary,
  type IntegrationCredentialsPayload,
  type IntegrationHealthItem,
  type IntegrationHealthPayload,
  type IntegrationProviderId,
} from "@noticeos/contract";
import { integrationStatus } from "@shared/integration-status";
import type { IntegrationsConfig } from "@shared/integrations";
import type { WallPayload } from "@shared/wall";
import { buildAssetIntegrations, buildCardDataSources, type LatestSignalRun } from "../worker/integrations-payload";
import registerJson from "./fixture-config/integrations.json";
import { wallFixturePayload } from "../e2e/wall-fixture";
import { everyTabPayload } from "./asset-detail-fixture";
import { loadAssetTabs } from "./lazy-code";

const NOW = Date.parse("2026-09-23T15:00:00.000Z");
const ASSET = "meals.example";
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const register = registerJson as unknown as IntegrationsConfig;

let sequence = 0;
function item(provider: IntegrationProviderId, capability: string, over: Partial<IntegrationHealthItem>): IntegrationHealthItem {
  const monitor = INTEGRATION_MONITORS[provider as keyof typeof INTEGRATION_MONITORS].find((entry) => entry.id === capability)!;
  sequence += 1;
  return {
    id: `item-${sequence}`, provider, capability, label: monitor.label, asset: ASSET, detail: null, report: null, reportDate: null,
    state: "healthy", lastAttemptAt: ago(10 * MIN), lastSuccessAt: ago(10 * MIN), nextAttemptAt: null, failure: null, code: null,
    action: monitor.action, coverage: "monitored", ...over,
  };
}
const refused = { state: "failing" as const, lastSuccessAt: null, failure: "access" as const, code: "access" };

/** Every pull works on the 15-minute run; what the monitoring items say
 * differs: Search Console's report archive and Bing's daily pull are refused. */
const HEALTH: IntegrationHealthPayload = {
  generatedAt: new Date(NOW).toISOString(), available: true, events: [],
  items: [
    item("google", "ga4-daily", {}),
    item("google", "ga4-archive", { detail: "pages-screens · 2026-09-22", report: "pages-screens", reportDate: "2026-09-22" }),
    item("google", "gsc-daily", {}),
    item("google", "gsc-archive", { detail: "page · 2026-09-22", report: "page", reportDate: "2026-09-22" }),
    item("google", "gsc-archive", { detail: "query · 2026-09-22", report: "query", reportDate: "2026-09-22", ...refused }),
    item("bing-webmaster", "bing-daily", { detail: "https://meals.example/", ...refused }),
    item("bing-webmaster", "bing-daily", { asset: "nosh.example", detail: "https://nosh.example/" }),
    item("clarity", "clarity-export", { detail: "url-3d · 2026-09-22", report: "url-3d", reportDate: "2026-09-22" }),
    item("dataforseo", "dataforseo-research", { detail: "ranked-keywords · 2026-09-21", report: "ranked-keywords", reportDate: "2026-09-21" }),
  ],
};

function credential(provider: IntegrationProviderId, connected: boolean): CredentialSummary {
  const at = ago(10 * MIN);
  return {
    provider, source: connected ? "store" : "none", fields: [], assetsHeld: [], missingFields: [], auth: provider === "google" && connected ? "oauth" : null,
    metadata: null, keyVersion: connected ? 1 : null, createdAt: connected ? at : null, updatedAt: connected ? at : null,
    lastUsedAt: connected ? at : null, lastOkAt: connected ? at : null, lastError: null,
  };
}
const CONNECTED = new Set(["google", "google-oauth-app", "bing-webmaster", "clarity", "dataforseo"]);
const PROVIDERS: IntegrationCredentialsPayload = {
  generatedAt: new Date(NOW).toISOString(), keyPresent: true, keyReason: null,
  blockers: [],
  providers: INTEGRATION_PROVIDERS.map((provider) => ({
    provider, credential: credential(provider.id, CONNECTED.has(provider.id)),
    assets: [{ id: ASSET, lanes: [...provider.lanes] }],
  })),
};

/** The 15-minute runs the Worker reads: every one succeeded. */
const RUNS: LatestSignalRun[] = (["ga4", "gsc", "bing-webmaster", "clarity", "posthog", "dataforseo"] as const).map((integration) => ({
  asset: ASSET, integration, status: "success", finishedAt: ago(8 * MIN), windowStart: "2026-09-16", windowEnd: "2026-09-22",
  dataState: "final", provisionalFrom: null, providerRows: 120, observationCount: 7, errorCode: null, errorMessage: null,
}));
const SOURCES = buildCardDataSources({
  assetId: ASSET, integrations: register, latestReportAt: ago(17 * 60 * MIN), pull: null, now: new Date(NOW),
  signalRuns: RUNS,
});

function assetPayload() {
  const payload = everyTabPayload();
  payload.asset = { ...payload.asset, id: ASSET, status: "live" };
  payload.integrations = buildAssetIntegrations(ASSET, register,
    { revenueRows: [], signalRuns: RUNS, archiveRuns: [], nowMs: NOW }, SOURCES);
  payload.freshness = { ...payload.freshness, pulseReceivedAt: ago(17 * 60 * MIN) };
  return payload;
}

function wallPayload(): WallPayload {
  const payload = wallFixturePayload();
  return { ...payload, assets: payload.assets.map((card, index) => index === 0 ? { ...card, id: ASSET, dataSources: SOURCES } : card) };
}

const state = vi.hoisted(() => ({ wall: undefined as unknown }));
vi.mock("@/hooks/useIntegrationProviders", () => ({
  INTEGRATION_PROVIDERS_KEY: ["integration-providers"],
  useIntegrationProviders: () => ({ data: PROVIDERS, isPending: false, isError: false, error: null }),
}));
vi.mock("@/hooks/useIntegrationHealth", () => ({
  INTEGRATION_HEALTH_KEY: ["integration-health"],
  useIntegrationHealth: () => ({ data: HEALTH, isError: false, status: integrationStatus(HEALTH, false, NOW) }),
}));
vi.mock("@/hooks/useWall", () => ({ useWall: () => ({ data: state.wall, isError: false, isPending: false }) }));
vi.mock("@/hooks/useWork", () => ({ useWork: () => ({ data: undefined, isError: false, isPending: true }) }));
vi.mock("@/hooks/useNow", () => ({ useNow: () => NOW }));
vi.mock("@/hooks/useGa4Realtime", () => ({ useGa4Realtime: () => ({ data: undefined, isError: false, isPending: true }) }));
vi.mock("@/hooks/useCalendarUpcoming", () => ({ useCalendarUpcoming: () => ({ data: undefined, isError: false, isPending: true }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AssetDetailRoute } from "@/routes/AssetDetailRoute";
import { HomeRoute } from "@/routes/HomeRoute";
import { IntegrationsRoute } from "@/routes/IntegrationsRoute";
import { WallRoute } from "@/routes/WallRoute";

beforeAll(loadAssetTabs);
beforeEach(() => {
  state.wall = wallPayload();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return url.startsWith("/api/assets/")
      ? new Response(JSON.stringify(assetPayload()), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ error: "not in this fixture" }), { status: 404, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function renderAt(path: string, element: ReactNode, pattern = "*") {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={pattern} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** lane → status, from the compact marks inside `root`. */
function marks(root: Element): Record<string, string> {
  return Object.fromEntries([...root.querySelectorAll("[data-source]")].map((mark) => [mark.getAttribute("data-source"), mark.getAttribute("data-connection")]));
}

const LANES = SOURCES.map((source) => source.id);
const PROVIDER_OF: Record<string, string> = { gsc: "google", ga4: "google", "bing-webmaster": "bing-webmaster", clarity: "clarity", posthog: "posthog", dataforseo: "dataforseo" };

describe("one source, one status, on every screen", () => {
  it("is seeded with the disagreement: every 15-minute run succeeded", () => {
    expect(SOURCES.filter((source) => source.id in PROVIDER_OF).every((source) => source.state === "live")).toBe(true);
  });

  it("shows each source's same status on its Data sources row, the asset header, Home and Integrations, and the Wall marks the failing ones", async () => {
    const asset = renderAt(`/assets/${ASSET}/sources`, <AssetDetailRoute />, "/assets/:id/:tab?");
    await waitFor(() => expect(document.querySelector("#integrations [data-connection]")).not.toBeNull());
    const more = screen.queryByRole("button", { name: /^Show \d+ more$/u });
    if (more) fireEvent.click(more);
    const rows = Object.fromEntries(LANES.map((lane) => [lane,
      document.querySelector(`#integrations [data-status-for="source:${ASSET}:${lane}"][data-connection]`)?.getAttribute("data-connection") ?? null]));
    const header = marks(document.querySelector("[data-page-header]")!);
    asset.unmount();

    // Home: no source marks. A failing source is one of the brief's Stopped
    // cards, and the site's one health word says Off track.
    const home = renderAt("/", <HomeRoute />);
    await waitFor(() => expect(home.container.querySelector("[data-home-brief]")).not.toBeNull());
    const homeMarks = marks(home.container);
    const brief = home.container.querySelector("[data-brief-cards]")!;
    const homeCell = home.container.querySelector(`[data-status-for="asset:${ASSET}"]`);
    const homeBriefText = brief.textContent ?? "";
    home.unmount();

    // The Wall: no source icons; a source Failing everywhere else is
    // represented by site health and a specific concern.
    const wall = renderAt("/wall", <WallRoute />);
    const wallIcons = marks(wall.container);
    const siteHealth = wall.container.querySelector(`[data-site-row="${ASSET}"] [data-site-health]`);
    expect(siteHealth).toHaveAttribute("data-site-health", "error");
    expect(siteHealth).toHaveAttribute("role", "img");
    expect(siteHealth?.getAttribute("aria-label")).toMatch(/^Site health: (Search Console|Bing) failing; 1 more issue$/u);
    const concerns = wall.container.querySelector("[data-wall-needs]")!;
    expect(concerns).toHaveTextContent("Search Console collection failing");
    expect(concerns).toHaveTextContent("Bing collection failing");
    expect(wall.container.querySelector("[data-system-state]")).toBeNull();
    wall.unmount();

    const sites: Record<string, string | null> = {};
    for (const provider of ["google", "bing-webmaster", "clarity", "dataforseo"]) {
      const page = renderAt(`/integrations?provider=${provider}`, <IntegrationsRoute />);
      await waitFor(() => expect(page.container.querySelector(`[data-provider-sites="${provider}"]`)).not.toBeNull());
      sites[provider] = page.container.querySelector(`[data-status-for="site:${provider}:${ASSET}"][data-connection]`)?.getAttribute("data-connection") ?? null;
      page.unmount();
    }
    const list = renderAt("/integrations", <IntegrationsRoute />);
    const posthogRow = list.container.querySelector('[data-integration-tile="posthog"]')?.getAttribute("data-integration-status") ?? null;
    list.unmount();

    // The refusals read Failing everywhere, though every 15-minute run succeeded.
    expect(header).toEqual({
      "nightly-report": "working", gsc: "failing", "bing-webmaster": "failing", ga4: "working",
      clarity: "working", posthog: "not-connected", dataforseo: "working", uptime: rows.uptime,
    });
    // The nightly report is the one slot with no Data sources row: that tab
    // states it as its Daily metrics' age.
    expect(Object.entries(rows).filter(([, row]) => row === null).map(([lane]) => lane)).toEqual(["nightly-report"]);
    for (const lane of LANES) {
      expect({ lane, row: rows[lane] ?? header[lane] }).toEqual({ lane, row: header[lane] });
    }
    expect(homeMarks).toEqual({});
    expect(homeBriefText).toContain("Search Console collection failing");
    expect(homeBriefText).toContain("Bing collection failing");
    if (homeCell) expect(homeCell).toHaveTextContent("Off track");
    expect(wallIcons).toEqual({});
    // Google's site row joins its two sources, so it fails with Search
    // Console; an unconnected provider reads Not connected.
    expect(sites["bing-webmaster"]).toBe(header["bing-webmaster"]);
    expect(sites.clarity).toBe(header.clarity);
    expect(sites.dataforseo).toBe(header.dataforseo);
    expect(sites.google).toBe("failing");
    expect(posthogRow).toBe(header.posthog);
  });
});
