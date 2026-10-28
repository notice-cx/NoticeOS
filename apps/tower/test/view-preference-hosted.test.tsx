// A hosted person's view follows them: the server's copy is read once per page
// load and drawn when it arrives, the browser's copy is drawn until then and
// whenever the server holds none, and each save goes to both. A failed save
// keeps the browser's copy and says so. Standalone never asks the server.

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseViewChoice, type ViewChoice } from "@shared/views";
import type { WallPayload } from "@shared/wall";
import { createOwnerStorage } from "@/lib/browser-storage";
import { createApi } from "@/lib/api";
import { BrowserRuntimeProvider, useOwnerPreferences } from "@/lib/browser-context";
import { createBrowserRuntime } from "@/lib/browser-runtime";
import { VIEW_PREFERENCE_NAME, useView } from "@/hooks/useView";

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));

const ID = "11111111-1111-4111-8111-111111111111";
const WALL = { dashboard: { view: null } } as unknown as WallPayload;
const runtimes: ReturnType<typeof createBrowserRuntime>[] = [];

function owner(mode: "hosted" | "standalone", server: {
  fetchViewPreference?: () => Promise<ViewChoice | null>;
  saveViewPreference?: (choice: ViewChoice) => Promise<ViewChoice>;
} = {}) {
  const identity = mode === "hosted"
    ? { mode, principalId: ID, sessionId: ID, workspaceId: ID, clientGeneration: 1 }
    : { mode, clientGeneration: 0 };
  const runtime = createBrowserRuntime<(keepalive: boolean) => Promise<void>>(identity, {
    origin: window.location.origin, fetch: vi.fn(), storage: window.localStorage, sendAnswer: async () => {},
  });
  runtimes.push(runtime);
  const api = {
    ...runtime.api,
    fetchWall: vi.fn(async () => WALL),
    fetchViewPreference: vi.fn(server.fetchViewPreference ?? (async () => null)),
    saveViewPreference: vi.fn(server.saveViewPreference ?? (async (choice: ViewChoice) => choice)),
  };
  const value = { runtime: { ...runtime, api }, workspaceLabel: "Workspace" };
  function Owner({ children }: { children: ReactNode }) {
    return (
      <BrowserRuntimeProvider value={value}>
        <QueryClientProvider client={runtime.queries}>{children}</QueryClientProvider>
      </BrowserRuntimeProvider>
    );
  }
  const hook = () => renderHook(() => ({ view: useView(), preferences: useOwnerPreferences() }), { wrapper: Owner });
  return { api, hook, runtime };
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.retire();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("a hosted person's view", () => {
  it("draws the server's choice once it arrives and keeps it as the browser's copy", async () => {
    const { api, hook } = owner("hosted", { fetchViewPreference: async () => ({ view: "revenue", focus: ["money"] }) });
    const { result } = hook();
    await waitFor(() => expect(result.current.view.choice).toEqual({ view: "revenue", focus: ["money"] }));
    expect(result.current.view.source).toBe("person");
    expect(api.fetchViewPreference).toHaveBeenCalledTimes(1);
    expect(result.current.preferences.read(VIEW_PREFERENCE_NAME)).toBe(JSON.stringify({ view: "revenue", focus: ["money"] }));
  });

  it("draws the browser's copy until the server answers, and when the server holds none", async () => {
    let answer!: (choice: ViewChoice | null) => void;
    const { hook } = owner("hosted", { fetchViewPreference: () => new Promise((resolve) => { answer = resolve; }) });
    const { result } = hook();
    act(() => result.current.preferences.write(VIEW_PREFERENCE_NAME, JSON.stringify({ view: "growth", focus: [] })));
    const { result: again } = hook();
    expect(again.current.view.choice).toEqual({ view: "growth", focus: [] });
    await act(async () => answer(null));
    expect(again.current.view.choice).toEqual({ view: "growth", focus: [] });
    expect(again.current.view.source).toBe("person");
  });

  it("saves a choice to the server and to the browser, and draws it at once", async () => {
    const { api, hook } = owner("hosted");
    const { result } = hook();
    await waitFor(() => expect(api.fetchViewPreference).toHaveBeenCalled());
    act(() => result.current.view.setChoice({ view: "revenue", focus: ["costs"] }));
    expect(result.current.view.choice).toEqual({ view: "revenue", focus: ["costs"] });
    await waitFor(() => expect(api.saveViewPreference).toHaveBeenCalledExactlyOnceWith({ view: "revenue", focus: ["costs"] }));
    expect(result.current.preferences.read(VIEW_PREFERENCE_NAME)).toBe(JSON.stringify({ view: "revenue", focus: ["costs"] }));
    await waitFor(() => expect(result.current.view.choice).toEqual({ view: "revenue", focus: ["costs"] }));
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("keeps the browser's copy and says so when the server refuses the save", async () => {
    const { hook } = owner("hosted", {
      fetchViewPreference: async () => ({ view: "overview", focus: [] }),
      saveViewPreference: async () => { throw new Error("PUT /api/me/preferences/view failed: 503"); },
    });
    const { result } = hook();
    await waitFor(() => expect(result.current.view.source).toBe("person"));
    act(() => result.current.view.setChoice({ view: "growth", focus: [] }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    expect(result.current.view.choice).toEqual({ view: "growth", focus: [] });
    expect(result.current.preferences.read(VIEW_PREFERENCE_NAME)).toBe(JSON.stringify({ view: "growth", focus: [] }));
  });

  it("clears to the workspace default: forgotten here, saved as the default there", async () => {
    const { api, hook } = owner("hosted", { fetchViewPreference: async () => ({ view: "revenue", focus: [] }) });
    const { result } = hook();
    await waitFor(() => expect(result.current.view.choice.view).toBe("revenue"));
    act(() => result.current.view.clearChoice());
    expect(result.current.view.choice).toEqual({ view: "overview", focus: [] });
    expect(result.current.view.source).toBe("default");
    await waitFor(() => expect(api.saveViewPreference).toHaveBeenCalledExactlyOnceWith({ view: "overview", focus: [] }));
    expect(result.current.preferences.read(VIEW_PREFERENCE_NAME)).toBeNull();
  });

  it.each([false, true])("shows a hosted legacy purpose notice once with a cached choice: %s", async (cached) => {
    const api = createApi(async () => Response.json({ choice: parseViewChoice({ view: "product", focus: ["visitors"] }) }));
    const owned = owner("hosted", { fetchViewPreference: () => api.fetchViewPreference() });
    if (cached) createOwnerStorage({ ...owned.runtime.owner, clientGeneration: 0 }, window.localStorage)
      .write(VIEW_PREFERENCE_NAME, JSON.stringify({ view: "product", focus: ["visitors"] }));
    const first = owned.hook();
    await waitFor(() => expect(first.result.current.view.choice).toMatchObject({ view: "overview", focus: ["visitors"] }));
    await waitFor(() => expect(toasts.warning).toHaveBeenCalledTimes(1));
    expect(JSON.parse(first.result.current.preferences.read(VIEW_PREFERENCE_NAME)!)).toEqual({ view: "overview", focus: ["visitors"] });
    first.unmount();
    owned.hook();
    expect(toasts.warning).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest rapid choice while serial server saves settle", async () => {
    const replies: ((choice: ViewChoice) => void)[] = [];
    const { api, hook } = owner("hosted", {
      saveViewPreference: () => new Promise(resolve => replies.push(resolve)),
    });
    const { result } = hook();
    await waitFor(() => expect(api.fetchViewPreference).toHaveBeenCalled());
    act(() => result.current.view.setChoice({ view: "growth", focus: [] }));
    await waitFor(() => expect(replies).toHaveLength(1));
    act(() => result.current.view.setChoice({ view: "reliability", focus: ["costs"] }));
    expect(result.current.view.choice).toEqual({ view: "reliability", focus: ["costs"] });
    await act(async () => replies[0]!({ view: "growth", focus: [] }));
    await waitFor(() => expect(replies).toHaveLength(2));
    expect(result.current.view.choice).toEqual({ view: "reliability", focus: ["costs"] });
    await act(async () => replies[1]!({ view: "reliability", focus: ["costs"] }));
    expect(result.current.view.choice.view).toBe("reliability");
    expect(api.saveViewPreference.mock.calls.map(call => call[0].view)).toEqual(["growth", "reliability"]);
  });

  it("ignores an initial read that finishes after a newer choice", async () => {
    let reply!: (choice: ViewChoice | null) => void;
    const { hook, api } = owner("hosted", { fetchViewPreference: () => new Promise(resolve => { reply = resolve; }) });
    const { result } = hook();
    await waitFor(() => expect(api.fetchViewPreference).toHaveBeenCalled());
    act(() => result.current.view.setChoice({ view: "delivery", focus: [] }));
    await act(async () => reply({ view: "revenue", focus: [] }));
    expect(result.current.view.choice.view).toBe("delivery");
    expect(JSON.parse(result.current.preferences.read(VIEW_PREFERENCE_NAME)!)).toEqual({ view: "delivery", focus: [] });
  });

  it("does not apply a save completion after its browser owner retires", async () => {
    let reply!: (choice: ViewChoice) => void;
    const { hook, runtime, api } = owner("hosted", { saveViewPreference: () => new Promise(resolve => { reply = resolve; }) });
    const { result, unmount } = hook();
    await waitFor(() => expect(api.fetchViewPreference).toHaveBeenCalled());
    act(() => result.current.view.setChoice({ view: "growth", focus: [] }));
    await waitFor(() => expect(api.saveViewPreference).toHaveBeenCalled());
    unmount();
    runtime.retire();
    await act(async () => reply({ view: "revenue", focus: [] }));
    const fresh = owner("hosted");
    const { result: current } = fresh.hook();
    await waitFor(() => expect(fresh.api.fetchViewPreference).toHaveBeenCalled());
    expect(current.current.view.choice.view).toBe("growth");
  });

});

describe("a standalone browser's view", () => {
  it("is kept in this browser only and never asks the server", async () => {
    const { api, hook } = owner("standalone");
    const { result } = hook();
    act(() => result.current.view.setChoice({ view: "revenue", focus: [] }));
    expect(result.current.view.choice).toEqual({ view: "revenue", focus: [] });
    await waitFor(() => expect(api.fetchWall).toHaveBeenCalled());
    expect(api.fetchViewPreference).not.toHaveBeenCalled();
    expect(api.saveViewPreference).not.toHaveBeenCalled();
  });

  it("resolves legacy identities to Overview, retains picks, and shows the purpose notice once", async () => {
    const { hook } = owner("standalone");
    const first = hook();
    act(() => first.result.current.preferences.write(VIEW_PREFERENCE_NAME, JSON.stringify({ view: "business", focus: ["money"] })));
    first.unmount();
    const second = hook();
    expect(second.result.current.view.choice).toMatchObject({ view: "overview", focus: ["money"] });
    await waitFor(() => expect(toasts.warning).toHaveBeenCalledExactlyOnceWith("Your view is now Overview. Choose a purpose from the view bar."));
    second.unmount();
    hook();
    expect(toasts.warning).toHaveBeenCalledTimes(1);
  });

});

describe("the Tower API's view preference calls", () => {
  it("reads null or a choice, and saves the choice as the body", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let answer: unknown = { choice: null };
    const api = createApi(async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json(init?.method === "PUT" ? { choice: JSON.parse(String(init.body)) } : answer);
    });
    expect(await api.fetchViewPreference()).toBeNull();
    answer = { choice: { view: "growth", focus: ["visitors"] } };
    expect(await api.fetchViewPreference()).toEqual({ view: "growth", focus: ["visitors"] });
    expect(await api.saveViewPreference({ view: "revenue", focus: ["money"] })).toEqual({ view: "revenue", focus: ["money"] });
    expect(calls.map((call) => [call.url, call.init?.method ?? "GET"])).toEqual([
      ["/api/me/preferences/view", "GET"], ["/api/me/preferences/view", "GET"], ["/api/me/preferences/view", "PUT"],
    ]);
    expect(calls[2]!.init?.body).toBe(JSON.stringify({ view: "revenue", focus: ["money"] }));
  });

  it("preserves a legacy purpose notice through the server and browser parser chain", async () => {
    const { parseViewChoice } = await import("@shared/views");
    const serverChoice = parseViewChoice({ view: "product", focus: ["visitors"] });
    const api = createApi(async () => Response.json({ choice: serverChoice }));
    expect(await api.fetchViewPreference()).toEqual({ view: "overview", focus: ["visitors"], needsPurposeChoice: true });
  });

  it("throws on a refused save", async () => {
    const api = createApi(async () => Response.json({ error: "invalid_view_choice", reason: "x" }, { status: 400 }));
    await expect(api.saveViewPreference({ view: "revenue", focus: [] })).rejects.toThrow();
  });
});
