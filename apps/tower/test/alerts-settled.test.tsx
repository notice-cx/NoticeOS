import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem, WallPayload } from "@shared/wall";
import { wallFixturePayload } from "../e2e/wall-fixture";
import { handleAlertHistoryRequest } from "../worker/alert-history";
import { handleFlagRequest } from "../worker/flag-route";
import { readAlert, storeAlert, storeAlerts } from "./alert-rows";
import { createTestStore, type TestStore } from "./postgres-store";
import { addSites } from "./sites";

// "Settled · 7d" over the real archive. `alerts-route.test.tsx` hands the
// strip whatever page of history a test writes, which cannot tell whether the
// Worker files a snooze as settled. Here the page's own reads reach the
// Worker's own handlers over a real store, through `fetch`, as the browser
// calls them. Only the Wall payload is a stand-in.

const wall = vi.hoisted(() => ({ data: null as WallPayload | null }));

vi.mock("@/hooks/useWall", () => ({
  useWall: () => ({ data: wall.data, isPending: false, isError: false }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/useTaskSource", () => import("./task-source-mock"));

import { AlertsRoute } from "@/routes/AlertsRoute";

const HOUR = 3_600_000;

let store: TestStore;
let calls: string[];
/** Every answer the Worker gave, as `METHOD /path STATUS`: recorded when its
 * handler returned, so after the write it made committed. */
let answers: string[];

/** A site in both of the test's stores (test/sites.ts). */
async function insertAsset(id: string, displayName: string): Promise<void> {
  await addSites(store, [{ id, displayName, status: "live", senseOnly: 0 }]);
}

/** One open warning, fired `hoursAgo` before the real clock: the Worker and
 * the snooze menu both read the real clock, so the fixture does too. Returns
 * its number. */
async function insertOpenWarning(message: string, hoursAgo: number): Promise<number> {
  return storeAlert(store.call, {
    asset: "meadow.example",
    firedAt: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
    severity: "warn",
    kind: "anomaly",
    metric: null,
    message,
    ruleId: "rule-the-translator-does-not-know",
  });
}

function openItem(id: number, message: string): AttentionItem {
  const firedAt = new Date(Date.now() - 2 * HOUR).toISOString();
  return {
    id,
    asset: "meadow.example",
    assetDisplayName: "Meadow Board",
    severity: "warn",
    kind: "anomaly",
    message,
    firedAt,
    metric: null,
    ruleId: "rule-the-translator-does-not-know",
    ruleInputs: null,
    correlatedChanges: [],
    occurrences: 1,
    firstFiredAt: firedAt,
  };
}

/** The Worker's own route handlers over the test store. */
async function route(request: Request, url: URL): Promise<Response> {
  const now = new Date();
  if (url.pathname === "/api/alerts/history") {
    return handleAlertHistoryRequest(request, url, store.call, { now });
  }
  const flag = /^\/api\/flags\/(\d+)$/.exec(url.pathname);
  if (flag) return handleFlagRequest(request, url, store.call, Number(flag[1]), now.toISOString());
  return new Response("not served here", { status: 404 });
}

/** The browser's `fetch`, answered by the Worker's own route handlers over the
 * test store. Every call is recorded as `METHOD /path` when it is made, and
 * again in `answers` when it is answered. */
function serveTheWorker(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://tower.test");
      // Rebuilt without the caller's AbortSignal: jsdom's and Node's are not
      // the same class, and the handlers never read it.
      const request = new Request(url, {
        method: init?.method ?? "GET",
        headers: init?.headers,
        body: init?.body ?? null,
      });
      calls.push(`${request.method} ${url.pathname}`);
      const response = await route(request, url);
      answers.push(`${request.method} ${url.pathname} ${response.status}`);
      return response;
    }),
  );
}

/** A fresh page load: a new query cache, so nothing is remembered from before. */
function loadAlerts(url = "/alerts") {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/alerts" element={<AlertsRoute />} />
          <Route path="/alerts/:tab" element={<AlertsRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The strip's settled figure — the value printed right after its label. */
function settledThisWeek(container: HTMLElement): string {
  // Absent while the archive has not answered.
  return container.querySelector<HTMLElement>("[data-alerts-settled] dd")?.textContent ?? "—";
}

/** Act on a row, and return once the Worker has answered the action: its
 * write has committed, so a page loaded next reads it. Waiting only for the
 * call lets a reload's history read reach the store before the write does. */
async function act(rowText: string, verb: "snooze" | "resolve") {
  const row = screen.getByRole("button", { name: new RegExp(rowText) }).closest("li") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: new RegExp(rowText) }));
  const answered = () => answers.filter((answer) => answer.startsWith("PATCH"));
  const before = answered().length;
  if (verb === "snooze") {
    fireEvent.click(within(row).getByRole("button", { name: "Snooze alert" }));
    fireEvent.click(within(row).getByRole("button", { name: "3 days" }));
  } else {
    fireEvent.click(within(row).getByRole("button", { name: "Resolve alert" }));
  }
  await waitFor(() => expect(answered()).toHaveLength(before + 1));
  expect(answered().at(-1)).toMatch(/ 200$/);
}

let signupsId: number;
let clicksId: number;

beforeEach(async () => {
  store = await createTestStore();
  calls = [];
  answers = [];
  await insertAsset("meadow.example", "Meadow Board");
  signupsId = await insertOpenWarning("Signups well below normal", 3);
  clicksId = await insertOpenWarning("Clicks fell off a cliff", 2);
  wall.data = {
    ...wallFixturePayload("one"),
    attention: [openItem(signupsId, "Signups well below normal"), openItem(clicksId, "Clicks fell off a cliff")],
    snoozed: [],
  };
  serveTheWorker();
});

afterEach(() => {
  vi.unstubAllGlobals();
  store.close();
});

describe("Settled · 7d and History count what is finished, never what is parked", () => {
  it("leaves a snoozed alert out of Settled · 7d and out of History", async () => {
    const first = loadAlerts();
    await waitFor(() => expect(settledThisWeek(first.container)).toBe("0"));

    await act("Signups well below normal", "snooze");
    const parked = (await readAlert(store.call, signupsId))!;
    expect(parked.disposition).toBe("snooze");
    first.unmount();

    const reloaded = loadAlerts();
    await waitFor(() => expect(calls.filter((call) => call === "GET /api/alerts/history").length).toBeGreaterThan(1));
    await waitFor(() => expect(settledThisWeek(reloaded.container)).toBe("0"));
    reloaded.unmount();

    const history = loadAlerts("/alerts/history");
    expect(await within(history.container).findByText("No settled alerts yet")).toBeInTheDocument();
  });

  it("counts a resolved alert, and still not the snoozed one beside it", async () => {
    const first = loadAlerts();
    await waitFor(() => expect(settledThisWeek(first.container)).toBe("0"));
    await act("Signups well below normal", "snooze");
    await act("Clicks fell off a cliff", "resolve");
    first.unmount();

    const reloaded = loadAlerts();
    await waitFor(() => expect(settledThisWeek(reloaded.container)).toBe("1"));
    reloaded.unmount();

    const history = loadAlerts("/alerts/history");
    const list = await within(history.container).findByRole("list", { name: "Settled alerts" });
    expect(within(list).getByText(/Clicks fell off a cliff/)).toBeInTheDocument();
    expect(within(list).queryByText(/Signups well below normal/)).toBeNull();
  });
});

/** History keeps the last page on screen while the next one loads; the range
 * badge must not mix the new offset with the old count and total. */
describe("History's range badge while the next page loads", () => {
  it("never pairs the new offset with the old page's rows or total", async () => {
    const resolved = new Date(Date.now() - HOUR).toISOString();
    await storeAlerts(store.call, Array.from({ length: 30 }, (_, n) => ({
      asset: "meadow.example",
      firedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
      severity: "warn",
      kind: "anomaly",
      metric: null,
      message: `Settled number ${n}`,
      ruleId: "rule-the-translator-does-not-know",
      resolvedAt: resolved,
    })));
    const answer = vi.mocked(fetch).getMockImplementation()!;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes("offset=25")) await held;
      return answer(input, init);
    });

    const page = loadAlerts("/alerts/history");
    const badge = () => page.container.querySelector("[data-history-range]")?.textContent ?? "";
    await waitFor(() => expect(badge()).toBe("1–25 of 30 settled"));

    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("offset=25"))).toBe(true));
    expect(badge()).toBe("1–25 of 30 settled");

    release();
    await waitFor(() => expect(badge()).toBe("26–30 of 30 settled"));
  });
});

/** The archive is not polled, so the actions must refresh it: no reload below. */
describe("Settled · 7d and History move the moment an alert is acted on", () => {
  const historyReads = () => calls.filter((call) => call === "GET /api/alerts/history").length;

  it("counts a Resolve on the strip without a reload", async () => {
    const page = loadAlerts();
    await waitFor(() => expect(settledThisWeek(page.container)).toBe("0"));

    await act("Clicks fell off a cliff", "resolve");
    await waitFor(() => expect(settledThisWeek(page.container)).toBe("1"));
  });

  it("re-reads the archive after a Snooze, and the figure stays where it was", async () => {
    const page = loadAlerts();
    await waitFor(() => expect(settledThisWeek(page.container)).toBe("0"));
    const before = historyReads();

    await act("Signups well below normal", "snooze");
    await waitFor(() => expect(historyReads()).toBeGreaterThan(before));
    expect(settledThisWeek(page.container)).toBe("0");
  });

  it("lists a resolved row on History when the tab is opened next, no reload", async () => {
    const page = loadAlerts("/alerts/history");
    expect(await within(page.container).findByText("No settled alerts yet")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Open" }));
    await act("Clicks fell off a cliff", "resolve");
    fireEvent.click(screen.getByRole("tab", { name: "History" }));

    const list = await within(page.container).findByRole("list", { name: "Settled alerts" });
    expect(within(list).getByText(/Clicks fell off a cliff/)).toBeInTheDocument();
  });
});
