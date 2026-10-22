// A desk screen that holds a site's id rather than its card draws the icon
// the site's card carries for the theme (`useSiteIcons` over the cached Wall
// read), and never reads the Wall to find it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { integrationProvider } from "@noticeos/contract";
import type { SiteIcons } from "@noticeos/contract/site-icons";
import type { FlagRecord } from "@shared/asset-detail";
import type { FinancialProperty } from "@shared/financials";
import type { AssetCard, WallPayload } from "@shared/wall";
import { AlertList, AlertRow } from "@/components/AlertRow";
import { SiteTokens } from "@/components/SiteTokens";
import { useSiteIcons } from "@/hooks/useSiteIcons";
import { Header } from "@/routes/asset-detail/AssetHeader";
import { SiteMoneyRows } from "@/routes/financials/SiteMoneyRows";
import { everyTabPayload } from "./asset-detail-fixture";
import { act, render, renderHook } from "./render";

// The header's source marks read the two connection reads; neither is this
// file's subject, so both stay unanswered.
vi.mock("@/hooks/useConnections", () => ({
  useConnections: () => ({ credentials: undefined, items: null }),
}));

const SITE = "meadow.example";
const OTHER = "northwind.example";
const LIGHT = "https://www.meadow.example/brand/icon-32.png";
const DARK = "https://www.meadow.example/brand/icon-32-dark.png";
const FAVICON = `https://${SITE}/favicon.ico`;
const ICONS: SiteIcons = { light: LIGHT, dark: DARK, readAt: "2026-07-05T04:00:00.000Z", outcome: "read" };
const NOW = Date.parse("2026-07-05T14:00:00.000Z");

function wallWith(icons: SiteIcons | null): WallPayload {
  const card = (id: string, displayName: string, carried: SiteIcons | null) => ({ id, displayName, icons: carried }) as AssetCard;
  return { assets: [card(SITE, "Meadow Board", icons), card(OTHER, "Northwind", null)] } as WallPayload;
}

/** The desk's query client, holding the Wall read the shell made, or none. */
function deskClient(wall: WallPayload | null): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (wall) client.setQueryData(["wall"], wall);
  return client;
}

function draw(ui: ReactNode, client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function drawn(container: HTMLElement): string | null {
  return container.querySelector(`[data-property-favicon="${SITE}"] img`)?.getAttribute("src") ?? null;
}

/** Every request a screen makes, answered with nothing. */
function recordRequests() {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const wallRequests = (fetchMock: ReturnType<typeof recordRequests>) =>
  fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/wall"));

afterEach(() => {
  document.documentElement.classList.remove("light");
  vi.unstubAllGlobals();
});

const settled: FlagRecord = {
  id: 12,
  firedAt: "2026-07-03T03:30:00.000Z",
  firstFiredAt: "2026-07-03T03:30:00.000Z",
  occurrences: 1,
  severity: "warn",
  kind: "anomaly",
  metric: "sessions",
  message: "sessions fell",
  ruleId: "flow-poisson-low",
  ruleInputs: null,
  correlatedChanges: [],
  disposition: "ack",
  dispositionAt: "2026-07-04T09:00:00.000Z",
  dispositionNote: null,
  snoozeUntil: null,
  ackExpiry: null,
  resolvedAt: "2026-07-04T09:00:00.000Z",
  liveness: { state: "live" },
};

function property(asset: string, displayName: string, revenue: number): FinancialProperty {
  const figure = { currency: "USD", revenue, cost: 0, net: revenue };
  return { asset, displayName, isOs: false, figure, months: [{ period: "2026-07", figure }], revenueReported: true };
}

const detail = everyTabPayload();
const CLARITY = integrationProvider("clarity")!;

/** Each desk surface that holds a site id, drawn as its screen draws it. */
const SURFACES: readonly [string, () => ReactNode][] = [
  ["the asset page header", () => (
    <Header asset={detail.asset} integrations={detail.integrations} pulseReceivedAt={null} nowMs={NOW} lastGood={false} />
  )],
  ["an Alerts row", () => (
    <AlertList label="Alerts">
      <AlertRow flag={settled} nowMs={NOW} assetId={SITE} history asset={{ id: SITE, domain: SITE, displayName: "Meadow Board" }} />
    </AlertList>
  )],
  ["a Money row", () => (
    <SiteMoneyRows
      rows={[
        { property: property(SITE, "Meadow Board", 120), share: 0.6, change: null },
        { property: property(OTHER, "Northwind", 80), share: 0.4, change: null },
      ]}
      overhead={{ currency: "USD", revenue: 0, cost: 0, net: 0 }}
      period="2026-07"
      openPeriod="2026-07"
      sites={2}
    />
  )],
  ["an Integrations asset row", () => (
    <SiteTokens
      provider={CLARITY}
      sites={[{ id: SITE, label: "Meadow Board", domain: SITE, held: false }]}
      cap={10}
      statusOf={() => null}
      remaining={() => 10}
      onSave={async () => {}}
      onRun={async () => null}
    />
  )],
];

describe("a desk screen that holds an asset's id draws the icon its card carries", () => {
  it.each(SURFACES)("%s draws the dark icon on the dark desk and the light icon on the light desk", (_name, surface) => {
    const dark = draw(surface(), deskClient(wallWith(ICONS)));
    expect(drawn(dark.container)).toBe(DARK);
    dark.unmount();

    document.documentElement.classList.add("light");
    const light = draw(surface(), deskClient(wallWith(ICONS)));
    expect(drawn(light.container)).toBe(LIGHT);
  });

  it.each(SURFACES)("%s draws /favicon.ico for a card that carries no icons", (_name, surface) => {
    const { container } = draw(surface(), deskClient(wallWith(null)));
    expect(drawn(container)).toBe(FAVICON);
  });

  it.each(SURFACES.slice(1))("%s reads no Wall of its own before the desk has one", (_name, surface) => {
    const requests = recordRequests();
    const { container } = draw(surface(), deskClient(null));
    expect(drawn(container)).toBe(FAVICON);
    expect(wallRequests(requests)).toEqual([]);
  });
});

describe("useSiteIcons", () => {
  function inClient(client: QueryClient) {
    return function Desk({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    };
  }

  it("never reads the Wall and adds no query for it, then answers once the desk's read lands", () => {
    const requests = recordRequests();
    const client = deskClient(null);
    const { result } = renderHook(() => useSiteIcons(), { wrapper: inClient(client) });
    expect(result.current(SITE)).toBeNull();
    expect(requests).not.toHaveBeenCalled();
    expect(client.getQueryCache().find({ queryKey: ["wall"] })).toBeUndefined();

    act(() => {
      client.setQueryData(["wall"], wallWith(ICONS));
    });
    expect(result.current(SITE)).toEqual(ICONS);
    expect(result.current(OTHER)).toBeNull();
    expect(result.current("unknown.example")).toBeNull();
    expect(requests).not.toHaveBeenCalled();
  });

  it("answers null outside a query client", () => {
    const { result } = renderHook(() => useSiteIcons());
    expect(result.current(SITE)).toBeNull();
  });
});
