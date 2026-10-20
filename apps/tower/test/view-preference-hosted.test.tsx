// A hosted person's view follows them: the server's copy is read once per page
// load and drawn when it arrives, the browser's copy is drawn until then and
// whenever the server holds none, and each save goes to both. A failed save
// keeps the browser's copy and says so. Standalone never asks the server.

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewChoice } from "@shared/views";
import type { WallPayload } from "@shared/wall";
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
  return { api, hook };
}

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.retire();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("a hosted person's view", () => {
  it("draws the server's choice once it arrives and keeps it as the browser's copy", async () => {
    const { api, hook } = owner("hosted", { fetchViewPreference: async () => ({ view: "business", focus: ["money"] }) });
    const { result } = hook();
    await waitFor(() => expect(result.current.view.choice).toEqual({ view: "business", focus: ["money"] }));
    expect(result.current.view.source).toBe("person");
    expect(api.fetchViewPreference).toHaveBeenCalledTimes(1);
    expect(result.current.preferences.read(VIEW_PREFERENCE_NAME)).toBe(JSON.stringify({ view: "business", focus: ["money"] }));
  });

  it("draws the browser's copy until the server answers, and when the server holds none", async () => {
    let answer!: (choice: ViewChoice | null) => void;
    const { hook } = owner("hosted", { fetchViewPreference: () => new Promise((resolve) => { answer = resolve; }) });
    const { result } = hook();
    act(() => result.current.preferences.write(VIEW_PREFERENCE_NAME, JSON.stringify({ view: "product", focus: [] })));
    const { result: again } = hook();
    expect(again.current.view.choice).toEqual({ view: "product", focus: [] });
    await act(async () => answer(null));
    expect(again.current.view.choice).toEqual({ view: "product", focus: [] });
    expect(again.current.view.source).toBe("person");
  });

  it("saves a choice to the server and to the browser, and draws it at once", async () => {
    const { api, hook } = owner("hosted");
    const { result } = hook();
    await waitFor(() => expect(api.fetchViewPreference).toHaveBeenCalled());
    act(() => result.current.view.setChoice({ view: "business", focus: ["costs"] }));
    expect(result.current.view.choice).toEqual({ view: "business", focus: ["costs"] });
    expect(api.saveViewPreference).toHaveBeenCalledExactlyOnceWith({ view: "business", focus: ["costs"] });
    expect(result.current.preferences.read(VIEW_PREFERENCE_NAME)).toBe(JSON.stringify({ view: "business", focus: ["costs"] }));
    await waitFor(() => expect(result.current.view.choice).toEqual({ view: "business", focus: ["costs"] }));
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("keeps the browser's copy and says so when the server refuses the save", async () => {
    const { hook } = owner("hosted", {
      fetchViewPreference: async () => ({ view: "everything", focus: [] }),
      saveViewPreference: async () => { throw new Error("PUT /api/me/preferences/view failed: 503"); },
    });
    const { result } = hook();
    await waitFor(() => expect(result.current.view.source).toBe("person"));
    act(() => result.current.view.setChoice({ view: "product", focus: [] }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1));
    expect(result.current.view.choice).toEqual({ view: "product", focus: [] });
    expect(result.current.preferences.read(VIEW_PREFERENCE_NAME)).toBe(JSON.stringify({ view: "product", focus: [] }));
  });

  it("clears to the workspace default: forgotten here, saved as the default there", async () => {
    const { api, hook } = owner("hosted", { fetchViewPreference: async () => ({ view: "business", focus: [] }) });
    const { result } = hook();
    await waitFor(() => expect(result.current.view.choice.view).toBe("business"));
    act(() => result.current.view.clearChoice());
    expect(result.current.view.choice).toEqual({ view: "everything", focus: [] });
    expect(result.current.view.source).toBe("default");
    expect(api.saveViewPreference).toHaveBeenCalledExactlyOnceWith({ view: "everything", focus: [] });
    expect(result.current.preferences.read(VIEW_PREFERENCE_NAME)).toBeNull();
  });
});

describe("a standalone browser's view", () => {
  it("is kept in this browser only and never asks the server", async () => {
    const { api, hook } = owner("standalone");
    const { result } = hook();
    act(() => result.current.view.setChoice({ view: "business", focus: [] }));
    expect(result.current.view.choice).toEqual({ view: "business", focus: [] });
    await waitFor(() => expect(api.fetchWall).toHaveBeenCalled());
    expect(api.fetchViewPreference).not.toHaveBeenCalled();
    expect(api.saveViewPreference).not.toHaveBeenCalled();
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
    answer = { choice: { view: "product", focus: ["visitors"] } };
    expect(await api.fetchViewPreference()).toEqual({ view: "product", focus: ["visitors"] });
    expect(await api.saveViewPreference({ view: "business", focus: ["money"] })).toEqual({ view: "business", focus: ["money"] });
    expect(calls.map((call) => [call.url, call.init?.method ?? "GET"])).toEqual([
      ["/api/me/preferences/view", "GET"], ["/api/me/preferences/view", "GET"], ["/api/me/preferences/view", "PUT"],
    ]);
    expect(calls[2]!.init?.body).toBe(JSON.stringify({ view: "business", focus: ["money"] }));
  });

  it("throws on a refused save", async () => {
    const api = createApi(async () => Response.json({ error: "invalid_view_choice", reason: "x" }, { status: 400 }));
    await expect(api.saveViewPreference({ view: "business", focus: [] })).rejects.toThrow();
  });
});
