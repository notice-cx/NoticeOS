// A site's icons on its Identity card: the light and the dark icon every
// screen draws, each on a white and a black square; when the home page was
// last read and what it declared; Read again, which runs the ingest's own read
// for this one site; and the two addresses that replace what was read, saved
// to the site's row of config/tower.json `/sites` with Undo.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteIcons } from "@noticeos/contract/site-icons";
import type { AssetCard, WallPayload } from "@shared/wall";
import { siteDisplayChange, type SiteDisplay } from "@shared/site-display";
import { validateSchemaAndSafety } from "../../../scripts/config-documents.mjs";
import { configSaveReply } from "./config-save-reply";

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const state = vi.hoisted(() => ({
  wall: null as WallPayload | null,
  writable: { writable: true, reason: null as string | null, sources: {} },
}));
vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({ data: state.wall ?? undefined, isPending: state.wall === null, isError: false }),
}));
vi.mock("@/hooks/useConfigWritable", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useConfigWritable")>("@/hooks/useConfigWritable");
  return { ...actual, useConfigWritable: () => state.writable };
});

import { SiteIconsSection } from "@/routes/asset-detail/SiteIcons";

const NOW = Date.parse("2026-10-17T06:00:00.000Z");
const LIGHT = "https://meadow.example/brand/icon-32.png";
const DARK = "https://meadow.example/brand/icon-32-dark.png";

const READ: SiteIcons = {
  light: LIGHT,
  dark: DARK,
  readAt: "2026-10-17T04:00:00.000Z",
  outcome: "read",
  read: { light: LIGHT, dark: DARK },
};

function card(icons: SiteIcons | null): AssetCard {
  return {
    netByMonthCurrency: "USD", id: "meadow.example", displayName: "Meadow Board", status: "live", senseOnly: false,
    worstSeverity: null, openError: 0, openWarn: 0,
    booked: { currency: "USD", revenue: 0, cost: 0, net: 0 }, forecast: { currency: "USD", revenue: 0, cost: 0, net: 0 },
    netPeriod: "2026-10", pulseReceivedAt: null, firstReportAt: null, dataSources: [],
    searchClicks: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
    netByMonth: [], netByMonthProvisionalFrom: null,
    activeUsers: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] },
    work: null, panelReview: null, latestPanelDate: null, icons,
  };
}

function payload(icons: SiteIcons | null, display?: SiteDisplay): WallPayload {
  return {
    generatedAt: "2026-10-17T06:00:00.000Z",
    portfolio: {
      netTrendCurrency: "USD", netTrendAllCurrency: "USD", period: "2026-10", periodIsCurrent: true,
      booked: { currency: "USD", revenue: 0, cost: 0, net: 0 }, forecast: { currency: "USD", revenue: 0, cost: 0, net: 0 },
      netTrend: [], netTrendAll: [], trendGranularity: "monthly", bookedDelta: null,
      residue: { booked: { currency: "USD", revenue: 0, cost: 0, net: 0 }, forecast: { currency: "USD", revenue: 0, cost: 0, net: 0 } },
      firstRun: true, daysIn: 17,
    },
    system: { assetId: "root-os", hasPulse: true, spendTodayUsd: 0, dailyCapUsd: 1, ingest: { fresh: 1, stale: 0, notExpected: 0, expected: 1 }, scheduledLanes: [] },
    dashboard: display === undefined ? {} : { sites: display },
    assets: [card(icons)],
    attention: [],
    snoozed: [],
    operator: { waiting: 0, urgent: 0, measuredProjects: 0, urgentMeasuredProjects: 0, projectCount: 0, capturedAt: "2026-10-17T06:00:00.000Z" },
    ledgerRecordedAt: null,
  };
}

type Call = { url: string; method: string; body: Record<string, unknown> | null };

/** The ingest's read answers `read`; a config save answers as the Worker does. */
function stubFetch(read: unknown = {
  ok: true, asset: "meadow.example", readAt: "2026-10-17T05:59:00.000Z", outcome: "read",
  light: "https://meadow.example/icon.svg", dark: DARK,
}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method: init?.method ?? "GET", body });
    if (url.endsWith("/icons")) return Response.json(read);
    return Response.json(configSaveReply(init));
  }));
  return calls;
}

function renderSection() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <SiteIconsSection assetId="meadow.example" siteName="Meadow Board" nowMs={NOW} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const row = (scheme: "light" | "dark") => document.querySelector(`[data-site-icon="${scheme}"]`) as HTMLElement;
const swatches = (scheme: "light" | "dark") =>
  [...row(scheme).querySelectorAll("[data-site-icon-swatch]")].map((swatch) => [
    swatch.getAttribute("data-site-icon-swatch"),
    swatch.querySelector("img")?.getAttribute("src"),
  ]);
const lastToast = () => toasts.success.mock.calls.at(-1) as [string, { action?: { label: string; onClick: () => void } }?] | undefined;

beforeEach(() => {
  state.wall = payload(READ);
  state.writable = { writable: true, reason: null, sources: {} };
  toasts.success.mockReset();
  toasts.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("the Identity card's icons", () => {
  it("draws both icons on a white and a black square, with when the page was read and what it declared", () => {
    stubFetch();
    renderSection();
    const read = document.querySelector("[data-site-icons-read]") as HTMLElement;
    expect(read).toHaveTextContent("Icons declared");
    expect(read).toHaveTextContent("Read 2h ago");
    expect(swatches("light")).toEqual([["light", LIGHT], ["dark", LIGHT]]);
    expect(swatches("dark")).toEqual([["light", DARK], ["dark", DARK]]);
    expect(row("light")).toHaveTextContent(LIGHT);
    expect(row("dark")).toHaveTextContent(DARK);
    expect(screen.getByLabelText("Light icon")).toHaveValue("");
    expect(screen.getByLabelText("Dark icon")).toHaveValue("");
  });

  it("names each other outcome in words", () => {
    stubFetch();
    state.wall = payload({ light: null, dark: null, readAt: "2026-10-16T04:00:00.000Z", outcome: "no-icon", read: { light: null, dark: null } });
    const first = renderSection();
    expect(document.querySelector("[data-site-icons-read]")).toHaveTextContent("Nothing declared");
    expect(document.querySelector("[data-site-icons-read]")).toHaveTextContent("Read 1d ago");
    expect(row("light")).toHaveTextContent("None");
    expect(row("light").querySelector("[data-site-icon-swatches]")).toBeNull();
    first.unmount();

    // An unreachable morning names its own time and keeps the icons read before.
    state.wall = payload({ ...READ, unreachableAt: "2026-10-17T05:00:00.000Z" });
    const second = renderSection();
    expect(document.querySelector("[data-site-icons-read]")).toHaveTextContent("Page unreachable");
    expect(document.querySelector("[data-site-icons-read]")).toHaveTextContent("Read 1h ago");
    expect(swatches("dark")).toEqual([["light", DARK], ["dark", DARK]]);
    second.unmount();

    state.wall = payload(null);
    renderSection();
    expect(document.querySelector("[data-site-icons-read]")).toHaveTextContent("Not read yet");
    expect(document.querySelector("[data-site-icons-read-at]")).toBeNull();
  });

  it("reads the page again through the ingest's own read, and shows the new read", async () => {
    const calls = stubFetch();
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Read again" }));
    await waitFor(() => expect(document.querySelector("[data-site-icons-read]")).toHaveTextContent("Read 1m ago"));
    expect(calls).toEqual([{ url: "/api/assets/meadow.example/icons", method: "POST", body: {} }]);
    expect(swatches("light")).toEqual([["light", "https://meadow.example/icon.svg"], ["dark", "https://meadow.example/icon.svg"]]);
    expect(document.querySelector("[data-site-icons-refusal]")).toBeNull();
  });

  it("says why a press read nothing", async () => {
    stubFetch({ ok: false, asset: "meadow.example", error: "paused" });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Read again" }));
    await waitFor(() => expect(document.querySelector("[data-site-icons-refusal]")).toHaveTextContent("Schedule paused"));
    // The read the card holds stands.
    expect(document.querySelector("[data-site-icons-read]")).toHaveTextContent("Read 2h ago");
  });

  it("saves an address in place of the one read, with Undo writing the exact reverse", async () => {
    const calls = stubFetch();
    const display: SiteDisplay = { "meadow.example": { tv: false } };
    state.wall = payload(READ, display);
    renderSection();
    const SET = "https://cdn.example.com/meadow-white.svg";
    fireEvent.change(screen.getByLabelText("Dark icon"), { target: { value: SET } });
    fireEvent.click(within(row("dark")).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(lastToast()?.[0]).toBe("Saved — Dark icon for Meadow Board"));
    const change = siteDisplayChange(display, "meadow.example", "darkIcon", SET);
    expect(calls[0]).toMatchObject({ url: "/api/config", method: "PUT", body: { slug: "meadow-example-icon-dark", ops: change.ops } });
    expect(() => validateSchemaAndSafety({ version: 1, createdAt: "2026-10-17T06:00:00Z", ...calls[0]!.body })).not.toThrow();
    // Drawn at once, marked as set here, the page's own address under it.
    expect(swatches("dark")).toEqual([["light", SET], ["dark", SET]]);
    expect(row("dark")).toHaveTextContent("Set here");
    expect(row("dark").querySelector("[data-site-icon-read-address]")).toHaveTextContent(DARK);

    lastToast()![1]!.action!.onClick();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.body).toMatchObject({ ops: change.undo });
    await waitFor(() => expect(lastToast()?.[0]).toBe("Reverted — Dark icon for Meadow Board"));
  });

  it("draws the address the card carries as set here, and clears it back to the one read", async () => {
    const calls = stubFetch();
    const SET = "https://cdn.example.com/meadow.svg";
    const display: SiteDisplay = { "meadow.example": { lightIcon: SET } };
    state.wall = payload({ ...READ, light: SET }, display);
    renderSection();
    expect(swatches("light")).toEqual([["light", SET], ["dark", SET]]);
    expect(screen.getByLabelText("Light icon")).toHaveValue(SET);

    fireEvent.change(screen.getByLabelText("Light icon"), { target: { value: "" } });
    fireEvent.click(within(row("light")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(lastToast()?.[0]).toBe("Saved — Light icon for Meadow Board"));
    expect(calls[0]?.body).toMatchObject({ ops: siteDisplayChange(display, "meadow.example", "lightIcon", null).ops });
    expect(swatches("light")).toEqual([["light", LIGHT], ["dark", LIGHT]]);
    expect(row("light")).not.toHaveTextContent("Set here");
  });

  it("refuses an address that is not a web address, beside the field, and writes nothing", () => {
    const calls = stubFetch();
    renderSection();
    fireEvent.change(screen.getByLabelText("Light icon"), { target: { value: "icon.png" } });
    fireEvent.click(within(row("light")).getByRole("button", { name: "Save" }));
    expect(within(row("light")).getByRole("alert")).toHaveTextContent("Light icon must be an http or https URL");
    expect(calls).toEqual([]);
  });

  it("shows a read-only snapshot's icons without the fields", () => {
    stubFetch();
    state.writable = { writable: false, reason: "This snapshot is read-only.", sources: {} };
    renderSection();
    expect(swatches("light")).toEqual([["light", LIGHT], ["dark", LIGHT]]);
    expect(document.querySelector("[data-site-icons-read]")).toHaveTextContent("Icons declared");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelectorAll("input")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
