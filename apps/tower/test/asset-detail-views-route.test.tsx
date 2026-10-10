import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "./render";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetDetailView } from "@shared/asset-detail-views";
import { useAssetDetail } from "@/hooks/useAssetDetail";
import { ASSET_TABS, AssetDetailRoute, type AssetTab } from "@/routes/AssetDetailRoute";
import { everyTabPayload, viewOf } from "./asset-detail-fixture";
import { loadAssetTabs } from "./lazy-code";

// One read per tab, through the real route. These cases drive
// `AssetDetailRoute` with a store stub that answers each `?view=` the way the
// Worker does (`viewOf`): the same DOM on every tab, no loading flash when the
// read on screen already carries the next tab, the header kept while a tab's
// own read is on its way, a failure said in the panel, the read of a tab left
// behind cancelled, and only the tab on screen polling.

vi.hoisted(() => {
  process.env.TZ = "UTC";
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const NOW = Date.parse("2026-07-05T14:00:00.000Z");

interface Held {
  release: () => void;
  signal: AbortSignal | undefined;
}

/** A store stub that answers by URL: the whole page, one view, or a hold the
 * test releases (or a failure) for the views it names. */
function storeStub({
  hold = [],
  fail = [],
  wholePage = false,
}: { hold?: AssetDetailView[]; fail?: AssetDetailView[]; wholePage?: boolean } = {}) {
  const requests: string[] = [];
  const held = new Map<AssetDetailView, Held>();
  const payload = everyTabPayload();
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://tower.test");
    requests.push(`${url.pathname}${url.search}`);
    const view = url.searchParams.get("view") as AssetDetailView | null;
    if (view && fail.includes(view)) return answer({ error: "asset_detail_failed" }, 500);
    if (view && hold.includes(view) && !held.has(view)) {
      await new Promise<void>((resolve, reject) => {
        held.set(view, { release: resolve, signal: init?.signal ?? undefined });
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return answer(wholePage || !view ? payload : viewOf(payload, view));
  });
  vi.stubGlobal("fetch", fetchMock);
  // Only the asset reads: the tab bar also asks the task snapshot.
  const assetReads = () => requests.filter((r) => r.startsWith("/api/assets/"));
  return {
    requests: assetReads,
    held,
    views: () => assetReads().map((r) => new URL(r, "http://tower.test").searchParams.get("view")),
  };
}

function testClient() {
  return new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
}

function renderAt(tab: AssetTab, client = testClient()) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/assets/meadow.example${tab === "overview" ? "" : `/${tab}`}`]}>
          <Routes>
            <Route path="/assets/:id/:tab?" element={<AssetDetailRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

/** Identity React and Radix mint per mount; content is everything else. */
function normalise(html: string): string {
  return html
    .replaceAll(/«r[0-9a-z]+»/g, "«rID»")
    .replaceAll(/:r[0-9a-z]+:/g, ":rID:")
    .replaceAll(/_r_[0-9a-z]+_/g, "_rID_")
    .replaceAll(/radix-[0-9a-z-]+/g, "radix-ID");
}

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });
const panel = () => screen.getByRole("tabpanel");
const showing = () => panel().getAttribute("aria-labelledby");
/** The panel's neutral frame (`RouteLoading`), never a tab's own status line. */
const loadingFrame = () => panel().querySelector("[data-route-loading]");

beforeAll(loadAssetTabs);

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("the asset page reads one view per tab", () => {
  for (const key of ASSET_TABS) {
    it(`draws the ${key} tab from its own view exactly as from the whole page`, async () => {
      storeStub({ wholePage: true });
      const whole = renderAt(key);
      await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
      await waitFor(() => expect(loadingFrame()).toBeNull());
      // Every read settled, not only the tab's own: a tab's other reads (the
      // save check, the task snapshot) change controls when they answer.
      await waitFor(() => expect(whole.client.isFetching()).toBe(0));
      const expected = normalise(whole.container.innerHTML);
      whole.unmount();

      const stub = storeStub();
      const viewed = renderAt(key);
      await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
      await waitFor(() => expect(loadingFrame()).toBeNull());
      await waitFor(() => expect(viewed.client.isFetching()).toBe(0));
      expect(stub.views()).toEqual([key]);
      expect(normalise(viewed.container.innerHTML)).toBe(expected);
    });
  }

  it("switches at once to a tab the read on screen already carries, then reads that tab", async () => {
    // The Alerts read is held forever: anything the Alerts tab shows came from
    // the Overview read, which carries every fact Alerts draws.
    const stub = storeStub({ hold: ["alerts", "tasks", "settings"] });
    renderAt("overview");
    await waitFor(() => expect(showing()).toBe("asset-tab-overview"));
    await waitFor(() => expect(loadingFrame()).toBeNull());

    for (const [key, label] of [["alerts", "Alerts"], ["tasks", "Tasks"], ["settings", "Settings"]] as const) {
      fireEvent.click(tab(label));
      await waitFor(() => expect(showing()).toBe(`asset-tab-${key}`));
      expect(loadingFrame(), key).toBeNull();
      await waitFor(() => expect(stub.views()).toContain(key));
    }
    expect(within(panel()).getByRole("heading", { name: /Settings|Identity|Configuration/i, level: 2 })).toBeInTheDocument();
  });

  it("keeps the header and tab bar while a tab's own read is on its way, then draws it", async () => {
    const stub = storeStub({ hold: ["financials"] });
    renderAt("overview");
    await waitFor(() => expect(showing()).toBe("asset-tab-overview"));

    fireEvent.click(tab("Money"));
    await waitFor(() => expect(showing()).toBe("asset-tab-financials"));
    expect(loadingFrame()).toHaveAttribute("data-route-loading", "panel");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Meadow Board");
    expect(tab("Alerts")).toBeInTheDocument();

    await waitFor(() => expect(stub.held.has("financials")).toBe(true));
    act(() => stub.held.get("financials")!.release());
    await waitFor(() => expect(loadingFrame()).toBeNull());
    expect(within(panel()).getAllByText(/revenue/i).length).toBeGreaterThan(0);
  });

  it("says in the panel when a tab's own read fails, keeping the header", async () => {
    storeStub({ fail: ["financials"] });
    renderAt("overview");
    await waitFor(() => expect(showing()).toBe("asset-tab-overview"));

    fireEvent.click(tab("Money"));
    expect(await within(panel()).findByText("Couldn't load this site")).toBeInTheDocument();
    expect(within(panel()).getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Meadow Board");
  });

  it("cancels the read of a tab the operator has already left", async () => {
    const stub = storeStub({ hold: ["financials"] });
    renderAt("overview");
    await waitFor(() => expect(showing()).toBe("asset-tab-overview"));

    fireEvent.click(tab("Money"));
    await waitFor(() => expect(stub.held.has("financials")).toBe(true));
    const signal = stub.held.get("financials")!.signal;
    expect(signal?.aborted).toBe(false);

    fireEvent.click(tab("Alerts"));
    await waitFor(() => expect(showing()).toBe("asset-tab-alerts"));
    await waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it("polls only the tab on screen", async () => {
    storeStub();
    const { client } = renderAt("overview");
    await waitFor(() => expect(showing()).toBe("asset-tab-overview"));
    fireEvent.click(tab("Settings"));
    await waitFor(() => expect(showing()).toBe("asset-tab-settings"));
    await waitFor(() => expect(loadingFrame()).toBeNull());

    const observed = client
      .getQueryCache()
      .findAll({ queryKey: ["asset-detail", "meadow.example"] })
      .filter((query) => query.getObserversCount() > 0)
      .map((query) => query.queryKey);
    expect(observed).toEqual([["asset-detail", "meadow.example", "settings"]]);
  });

  it("starts a tab's read when a pointer rests on it", async () => {
    const stub = storeStub();
    renderAt("overview");
    await waitFor(() => expect(showing()).toBe("asset-tab-overview"));
    expect(stub.views()).not.toContain("activity");

    fireEvent.pointerEnter(tab("Activity"));
    await waitFor(() => expect(stub.views()).toContain("activity"));
    expect(showing()).toBe("asset-tab-overview");

    fireEvent.click(tab("Activity"));
    await waitFor(() => expect(showing()).toBe("asset-tab-activity"));
    expect(loadingFrame()).toBeNull();
  });
});

describe("useAssetDetail — one poll, one tab, one asset", () => {
  function wrapper(client: QueryClient) {
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }

  it("polls every minute for the tab on screen and stops polling the tab left behind", async () => {
    vi.useFakeTimers();
    try {
      const stub = storeStub();
      const client = new QueryClient();
      const { rerender } = renderHook(({ view }: { view: AssetDetailView }) => useAssetDetail("meadow.example", view), {
        wrapper: wrapper(client),
        initialProps: { view: "overview" as AssetDetailView },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stub.views()).toEqual(["overview"]);

      rerender({ view: "sources" });
      await vi.advanceTimersByTimeAsync(0);
      expect(stub.views()).toEqual(["overview", "sources"]);

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stub.views()).toEqual(["overview", "sources", "sources", "sources"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never holds another asset's read as a placeholder", async () => {
    const stub = storeStub({ hold: ["overview"] });
    const client = new QueryClient();
    const { result, rerender } = renderHook(({ id }: { id: string }) => useAssetDetail(id, "alerts"), {
      wrapper: wrapper(client),
      initialProps: { id: "meadow.example" },
    });
    await waitFor(() => expect(result.current.data?.asset.id).toBe("meadow.example"));

    rerender({ id: "northwind.example" });
    await waitFor(() => expect(stub.requests().some((r) => r.startsWith("/api/assets/northwind.example"))).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("holds the same asset's previous tab while the next tab's read arrives", async () => {
    const stub = storeStub({ hold: ["financials"] });
    const client = new QueryClient();
    const { result, rerender } = renderHook(({ view }: { view: AssetDetailView }) => useAssetDetail("meadow.example", view), {
      wrapper: wrapper(client),
      initialProps: { view: "alerts" as AssetDetailView },
    });
    await waitFor(() => expect(result.current.data?.view).toBe("alerts"));

    rerender({ view: "financials" });
    await waitFor(() => expect(stub.held.has("financials")).toBe(true));
    expect(result.current.isPending).toBe(true);
    expect(result.current.data?.view).toBe("alerts");
  });

  it("keeps holding the previous tab when the next tab's read fails", async () => {
    storeStub({ fail: ["financials"] });
    const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
    const { result, rerender } = renderHook(({ view }: { view: AssetDetailView }) => useAssetDetail("meadow.example", view), {
      wrapper: wrapper(client),
      initialProps: { view: "alerts" as AssetDetailView },
    });
    await waitFor(() => expect(result.current.data?.view).toBe("alerts"));

    rerender({ view: "financials" });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data?.view).toBe("alerts");
  });
});
