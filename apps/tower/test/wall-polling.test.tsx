import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "./render";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWall } from "@/hooks/useWall";

// The Wall read stops polling while the page is hidden and never because the
// window lacks focus: the TV is on screen and never clicked, and it has to
// keep refreshing. Driven through the real hook, TanStack's real focus
// manager and fake timers, so the assertion is on requests made.

const fetchWall = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...await original<typeof import('@/lib/api')>(), fetchWall }));

let visibility: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
}

function renderWall() {
  // The desk's own defaults (src/main.tsx): no focus refetch unless a hook
  // asks for one, one retry.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useWall(), { wrapper });
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  // The TV's browser window is never the focused one.
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  fetchWall.mockReset();
  fetchWall.mockResolvedValue({ generatedAt: "2026-09-22T12:00:00.000Z", assets: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useWall polling", () => {
  it("keeps refreshing every minute while visible, focused or not", async () => {
    renderWall();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchWall).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchWall).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchWall).toHaveBeenCalledTimes(3);
  });

  it("asks the store nothing while the tab is hidden", async () => {
    renderWall();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchWall).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchWall).toHaveBeenCalledTimes(1);
  });

  it("refreshes at once on return when the held payload is stale, then resumes the minute", async () => {
    renderWall();
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(fetchWall).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchWall).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchWall).toHaveBeenCalledTimes(3);
  });

  it("does not refetch on a quick glance away inside the fresh window", async () => {
    renderWall();
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(10_000);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchWall).toHaveBeenCalledTimes(1);
  });
});
