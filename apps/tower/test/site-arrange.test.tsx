// Arrange on the Sites page: every site in your order, hidden ones included,
// each with its three switches. A move saves through the one site-order
// write and a switch through the one config write, each with Undo in its
// toast; Done returns to the list with the hidden sites counted. The
// arithmetic a drag turns into a move is pinned beside it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCard, WallPayload } from "@shared/wall";
import { shownOnChange, type SiteDisplay } from "@shared/site-display";
import { validateSchemaAndSafety } from "../../../scripts/config-documents.mjs";
import { formatOrdinal } from "@/lib/format";
import { movedOrder, rowDropEdge, shownOnLabel, siteDropTarget } from "@/lib/site-arrange";
import { configSaveReply } from "./config-save-reply";

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const state = vi.hoisted(() => ({
  wall: null as WallPayload | null,
  writable: { writable: true, reason: null as string | null, sources: {} },
}));
vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({ data: state.wall, isPending: state.wall === null, isError: false }),
}));
vi.mock("@/hooks/useConfigWritable", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useConfigWritable")>("@/hooks/useConfigWritable");
  return { ...actual, useConfigWritable: () => state.writable };
});
vi.mock("@/hooks/useNow", () => ({ useNow: () => Date.parse("2026-08-01T12:00:00.000Z") }));
vi.mock("@/hooks/useConnections", () => ({ useConnections: () => ({ credentials: undefined, items: null }) }));

import { AssetsRoute } from "@/routes/AssetsRoute";
import { WhereItShowsCard } from "@/routes/asset-detail/WhereItShows";

function card(id: string, displayName: string, status = "live"): AssetCard {
  return {
    netByMonthCurrency: "USD", id, displayName, status, senseOnly: false, worstSeverity: null, openError: 0, openWarn: 0,
    booked: { currency: "USD", revenue: 0, cost: 0, net: 0 }, forecast: { currency: "USD", revenue: 0, cost: 0, net: 0 },
    netPeriod: "2026-08", pulseReceivedAt: "2026-08-01T11:00:00.000Z", firstReportAt: null, dataSources: [],
    searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
    netByMonth: [], netByMonthProvisionalFrom: null,
    activeUsers: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
    work: null, panelReview: null, latestPanelDate: null,
  };
}

/** Three sites: one listed, one switched off the list by hand, one retired. */
const SITES = [card("meadow.example", "Meadow Board"), card("northwind.example", "Northwind"), card("ferns.example", "Fern Index", "retired")];
const DISPLAY: SiteDisplay = { "northwind.example": { list: false } };

function payload(sites: AssetCard[] = SITES, display: SiteDisplay | undefined = DISPLAY): WallPayload {
  return {
    generatedAt: "2026-08-01T12:00:00.000Z",
    portfolio: {
      netTrendCurrency: "USD", netTrendAllCurrency: "USD", period: "2026-08", periodIsCurrent: true,
      booked: { currency: "USD", revenue: 0, cost: 0, net: 0 }, forecast: { currency: "USD", revenue: 0, cost: 0, net: 0 },
      netTrend: [], netTrendAll: [], trendGranularity: "monthly", bookedDelta: null,
      residue: { booked: { currency: "USD", revenue: 0, cost: 0, net: 0 }, forecast: { currency: "USD", revenue: 0, cost: 0, net: 0 } },
      firstRun: true, daysIn: 1,
    },
    system: { assetId: "root-os", hasPulse: true, spendTodayUsd: 1, dailyCapUsd: 2, ingest: { fresh: 2, stale: 0, notExpected: 0, expected: 2 }, scheduledLanes: [] },
    dashboard: display === undefined ? {} : { sites: display },
    assets: sites,
    attention: [],
    snoozed: [],
    operator: { waiting: 0, urgent: 0, measuredProjects: 1, urgentMeasuredProjects: 1, projectCount: 1, capturedAt: "2026-08-01T11:59:30.000Z" },
    ledgerRecordedAt: null,
  };
}

type Call = { url: string; method: string; body: Record<string, unknown> | null };

/** The two writes Arrange makes, answered as the Worker answers them. */
function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method: init?.method ?? "GET", body });
    const moving = /\/api\/assets\/([^/]+)\/order$/u.exec(url);
    if (moving) {
      const asset = decodeURIComponent(moving[1]!);
      const before = SITES.map((site) => site.id);
      const order = movedOrder(before, asset, String(body?.to));
      const undoTo = order[before.indexOf(asset)]!;
      return Response.json({ ok: true, asset, order, revision: "b".repeat(64), undoTo });
    }
    return Response.json(configSaveReply(init));
  }));
  return calls;
}

function renderSites(url = "/assets?arrange=1") {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/assets" element={<AssetsRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rows = (root: ParentNode) => [...root.querySelectorAll("[data-site-arrange-row]")].map((row) => row.getAttribute("data-site-arrange-row"));
const lastToast = () => toasts.success.mock.calls.at(-1) as [string, { action?: { label: string; onClick: () => void } }?] | undefined;

beforeEach(() => {
  state.wall = payload();
  state.writable = { writable: true, reason: null, sources: {} };
  toasts.success.mockReset();
  toasts.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("Arrange on the Sites page", () => {
  it("lists every site in your order, hidden ones included, each with its three switches", () => {
    stubFetch();
    const { container } = renderSites();
    expect(screen.getByRole("heading", { name: "Arrange" })).toBeInTheDocument();
    expect(rows(container)).toEqual(["meadow.example", "northwind.example", "ferns.example"]);
    const checked = (name: string) => screen.getByRole("switch", { name }).getAttribute("aria-checked");
    expect(checked("Home and Sites list for Meadow Board")).toBe("true");
    expect(checked("Home and Sites list for Northwind")).toBe("false");
    expect(checked("TV for Northwind")).toBe("true");
    for (const label of ["Home and Sites list", "TV", "Work this week"]) expect(checked(`${label} for Fern Index`)).toBe("false");
    // A retired site reads Retired beside its name; the others carry no stage.
    expect(container.querySelector('[data-site-arrange-row="ferns.example"]')).toHaveTextContent("Retired");
    expect(container.querySelector('[data-site-arrange-row="meadow.example"]')).not.toHaveTextContent("Retired");
  });

  it("opens from the Sites page's Arrange and from its hidden count, and keeps the order and the stage", () => {
    stubFetch();
    // Two listed sites, so the page draws its controls.
    state.wall = payload([...SITES, card("acorn.example", "Acorn Atlas")]);
    const { container } = renderSites("/assets?sort=name");
    expect(within(container.querySelector("[data-assets-controls]")!).getByRole("link", { name: /Arrange/u })).toHaveAttribute("href", "/assets?sort=name&arrange=1");
    expect(container.querySelector("[data-assets-hidden]")).toHaveAttribute("href", "/assets?sort=name&arrange=1");
  });

  it("moves a site up through the one site-order write, with Undo sending the order it left", async () => {
    const calls = stubFetch();
    renderSites();
    fireEvent.click(screen.getByRole("button", { name: "Move Northwind up" }));
    await waitFor(() => expect(lastToast()?.[0]).toBe("Site order saved"));
    expect(calls[0]).toMatchObject({ url: "/api/assets/northwind.example/order", method: "PATCH", body: { to: "meadow.example" } });
    // Drawn in its new place before the read that follows lands.
    expect(rows(document)).toEqual(["northwind.example", "meadow.example", "ferns.example"]);
    lastToast()![1]!.action!.onClick();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.body).toEqual({ to: "meadow.example", expectRevision: "b".repeat(64) });
  });

  it("switches a site off the TV through the one config write, with Undo writing the exact reverse", async () => {
    const calls = stubFetch();
    renderSites();
    fireEvent.click(screen.getByRole("switch", { name: "TV for Meadow Board" }));
    await waitFor(() => expect(lastToast()?.[0]).toBe("Saved — Meadow Board hidden on the TV"));
    const change = shownOnChange(DISPLAY, "meadow.example", "tv", false);
    expect(calls[0]).toMatchObject({ url: "/api/config", method: "PUT", body: { slug: "meadow-example-shown-tv", ops: change.ops } });
    expect(() => validateSchemaAndSafety({ version: 1, createdAt: "2026-08-01T12:00:00Z", ...calls[0]!.body })).not.toThrow();
    // Drawn off, and held until the read that follows lands.
    const tv = screen.getByRole("switch", { name: "TV for Meadow Board" });
    expect(tv).toHaveAttribute("aria-checked", "false");
    expect(tv).toBeDisabled();
    lastToast()![1]!.action!.onClick();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.body).toMatchObject({ ops: change.undo });
    await waitFor(() => expect(lastToast()?.[0]).toBe("Reverted — Meadow Board hidden on the TV"));
  });

  it("returns on Done to the list in the chosen order, the hidden sites gone and counted", () => {
    stubFetch();
    const { container } = renderSites("/assets?sort=name&arrange=1");
    fireEvent.click(screen.getByRole("link", { name: "Done" }));
    expect(screen.queryByRole("heading", { name: "Arrange" })).toBeNull();
    expect([...container.querySelectorAll("[data-portfolio-row]")].map((row) => row.getAttribute("data-portfolio-row"))).toEqual(["meadow.example"]);
    expect(container.querySelector("[data-assets-hidden]")).toHaveTextContent("2 hidden");
  });

  it("draws a read-only snapshot's controls dark, with the reason above them", () => {
    stubFetch();
    state.writable = { writable: false, reason: "This snapshot is read-only.", sources: {} };
    const { container } = renderSites();
    expect(container.querySelector("[data-site-arrange-locked]")).toHaveTextContent("This snapshot is read-only.");
    for (const control of [...screen.getAllByRole("switch"), screen.getByRole("button", { name: "Move Northwind up" })]) {
      expect(control).toBeDisabled();
    }
  });
});

describe("Where it shows, on a site's Settings tab", () => {
  it("shows the site's place and its switches as Arrange does, and moves it with the same write", async () => {
    const calls = stubFetch();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <WhereItShowsCard assetId="northwind.example" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText("2nd of 3")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Home and Sites list for Northwind" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "TV for Northwind" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("link", { name: /Arrange the sites/u })).toHaveAttribute("href", "/assets?arrange=1");
    fireEvent.click(screen.getByRole("button", { name: "Move Northwind down" }));
    await waitFor(() => expect(calls[0]).toMatchObject({ url: "/api/assets/northwind.example/order", body: { to: "ferns.example" } }));
    expect(document.querySelector("[data-where-it-shows-retired]")).toBeNull();
  });

  it("says of a retired site that it shows nowhere until a switch is on", () => {
    stubFetch();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <WhereItShowsCard assetId="ferns.example" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText("3rd of 3")).toBeInTheDocument();
    expect(document.querySelector("[data-where-it-shows-retired]")).toHaveTextContent("A retired site shows nowhere until you turn a switch on.");
    for (const switchEl of screen.getAllByRole("switch")) expect(switchEl).toHaveAttribute("aria-checked", "false");
  });
});

describe("the arithmetic of a drag", () => {
  const order = ["a", "b", "c", "d"];

  it("reads the nearer edge of a row", () => {
    expect(rowDropEdge({ top: 100, height: 40 }, 110)).toBe("top");
    expect(rowDropEdge({ top: 100, height: 40 }, 130)).toBe("bottom");
  });

  it("turns a drop above or below a row into the one site the move takes the place of", () => {
    expect(siteDropTarget(order, "d", "a", "top")).toBe("a");
    expect(siteDropTarget(order, "d", "a", "bottom")).toBe("b");
    expect(siteDropTarget(order, "a", "d", "bottom")).toBe("d");
    expect(siteDropTarget(order, "a", "d", "top")).toBe("c");
    expect(movedOrder(order, "d", siteDropTarget(order, "d", "b", "top")!)).toEqual(["a", "d", "b", "c"]);
    expect(movedOrder(order, "a", siteDropTarget(order, "a", "c", "bottom")!)).toEqual(["b", "c", "a", "d"]);
  });

  it("makes no move where the drop leaves the site where it is", () => {
    expect(siteDropTarget(order, "b", "b", "top")).toBeNull();
    expect(siteDropTarget(order, "b", "a", "bottom")).toBeNull();
    expect(siteDropTarget(order, "b", "c", "top")).toBeNull();
    expect(siteDropTarget(order, "x", "a", "top")).toBeNull();
  });

  it("names a change and a place in words", () => {
    expect(shownOnLabel("Meadow Board", "work", true)).toBe("Meadow Board shown in Work this week");
    expect(shownOnLabel("Meadow Board", "list", false)).toBe("Meadow Board hidden on Home and the Sites list");
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(formatOrdinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd"]);
  });
});
