import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "./render";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configRegister } from "@shared/config-registers";
import { useCollectionSave } from "@/hooks/useCollectionSave";
import { useConfigSave, useInlineConfigSave, useLandmarkSave } from "@/hooks/useConfigSave";
import { useConfigWritable } from "@/hooks/useConfigWritable";
import { saveConfig } from "@/lib/api";

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

let client: QueryClient;
let readStatus: number;
let exported: boolean;
let fetchMock: ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  readStatus = 200;
  exported = false;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const writing = init?.method === "PUT";
    const status = writing ? 200 : readStatus;
    const body = writing
      ? { applied: 1, archive: exported ? "config/changesets/test.json" : null, commit: null, exported }
      : status === 200
        ? { writable: true, reason: null, sources: { "config/tower.json": "store" } }
        : { error: "store_unavailable" };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const op = {
  kind: "file-json-set" as const,
  file: "config/tower.json" as const,
  pointer: "/countdown/label",
  expect: "Launch",
  value: "Next launch",
};

describe("a confirmed save whose local export failed", () => {
  it("preserves the separate export outcome in the API result", async () => {
    expect(await saveConfig([op])).toMatchObject({ applied: 1, exported: false });
  });

  it("keeps a setting save successful and shows the recovery command without retrying it", async () => {
    const { result } = renderHook(() => useConfigSave(), { wrapper });
    await act(async () => {
      expect(await result.current({ ops: [op], label: "Countdown label" })).toBe(true);
    });
    expect(toasts.success).toHaveBeenCalledWith("Saved — Countdown label", expect.anything());
    // The state, the command itself, and a button that copies it — no
    // paragraph (bead ro-ujb9.96.6.3). It stays until dismissed.
    expect(toasts.warning).toHaveBeenCalledWith("Local files not updated", expect.objectContaining({
      description: "pnpm config:export",
      action: expect.objectContaining({ label: "Copy command" }),
      duration: Infinity,
    }));
    expect(toasts.error).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "PUT")).toHaveLength(1);
  });

  it("confirms an inline save beside the field and still flags the local files", async () => {
    const { result } = renderHook(() => useInlineConfigSave(), { wrapper });
    let saved: Awaited<ReturnType<typeof result.current>> = null;
    await act(async () => {
      saved = await result.current({ ops: [op], label: "Countdown label" });
    });
    expect(saved).not.toBeNull();
    // The field shows "Saved"; no success toast repeats it.
    expect(toasts.success).not.toHaveBeenCalled();
    // This machine's files are a different subject, so they keep their toast.
    expect(toasts.warning).toHaveBeenCalledOnce();
    // The Undo is the same write reversed.
    await act(async () => {
      expect(await saved!.undo()).toBe(true);
    });
    const puts = fetchMock.mock.calls.filter((call) => call[1]?.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(JSON.parse(String(puts[1]![1]!.body))).toMatchObject({
      ops: [{ pointer: "/countdown/label", expect: "Next launch", value: "Launch" }],
    });
  });

  it("shows the same recovery for a collection row", async () => {
    const { result } = renderHook(() => useCollectionSave(), { wrapper });
    await act(async () => {
      expect(await result.current({
        register: configRegister("task-hub-spokes"),
        change: { kind: "add", row: { asset: "example.test", prefix: "ex", database: "ex", repo: "../example" }, count: 0 },
        label: "Example task project",
      })).toBe(true);
    });
    expect(toasts.warning).toHaveBeenCalledOnce();
    expect(toasts.success).toHaveBeenCalledOnce();
  });

  it("shows the same recovery for a landmark", async () => {
    const { result } = renderHook(() => useLandmarkSave(), { wrapper });
    await act(async () => {
      expect(await result.current({
        op: { kind: "file-json-insert", file: "config/tower.json", pointer: "/countdown", value: { emoji: "🗓️", label: "Launch", targetAt: "2026-10-01T00:00:00Z" } },
        label: "Countdown", slug: "countdown",
      })).toBe(true);
    });
    expect(toasts.warning).toHaveBeenCalledOnce();
  });

  it("does not warn when the stored value and the local files agree", async () => {
    exported = true;
    const { result } = renderHook(() => useConfigSave(), { wrapper });
    await act(async () => { await result.current({ ops: [op], label: "Countdown label" }); });
    expect(toasts.success).toHaveBeenCalledOnce();
    expect(toasts.warning).not.toHaveBeenCalled();
  });
});

it("pauses controls on an outage and restores them after recovery without reloading", async () => {
  const { result } = renderHook(() => useConfigWritable(), { wrapper });
  await waitFor(() => expect(client.getQueryData(["config-writable"])).toBeDefined());
  expect(result.current.writable).toBe(true);

  readStatus = 503;
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  await waitFor(() => expect(result.current.writable).toBe(false));
  expect(result.current.reason).toBe("Config store unreachable");

  readStatus = 200;
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  await waitFor(() => expect(result.current.writable).toBe(true));
});
