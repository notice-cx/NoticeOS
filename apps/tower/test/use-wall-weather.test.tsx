import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WALL_LAYOUT, wallWeatherSettings, type WallLayout } from "@shared/wall-layout";
import type { WeatherLocation, WeatherReading } from "@shared/weather";
import { BrowserRuntimeProvider } from "@/lib/browser-context";
import { createBrowserRuntime } from "@/lib/browser-runtime";
import { useWallWeather } from "@/hooks/useWallWeather";
import * as viewer from "@shared/demo-viewer";

const provider = vi.hoisted(() => ({
  locate: vi.fn<(signal?: AbortSignal) => Promise<WeatherLocation>>(),
  searchLocations: vi.fn<(query: string, signal?: AbortSignal) => Promise<WeatherLocation[]>>(),
  readForecast: vi.fn<(location: WeatherLocation, signal?: AbortSignal) => Promise<WeatherReading>>(),
}));
vi.mock("@/lib/weather", () => ({ weatherClient: provider }));
const now = Date.parse("2026-10-24T12:00:00Z");
const city = { name: "Example City", latitude: 52, longitude: 13 };
const otherCity = { name: "Other City", latitude: 40, longitude: -3 };
const reading = (location = city): WeatherReading => ({ location, timeZone: "UTC", observedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString(), temperatureC: 12, lowC: 8, highC: 15, conditionCode: 0, isDay: true });
const runtimes: ReturnType<typeof createBrowserRuntime>[] = [];
const id = "11111111-1111-4111-8111-111111111111";
function owned(mode: "standalone" | "hosted" | "demo" = "standalone", clientGeneration = 1) {
  const identity = mode === "standalone" ? { mode, clientGeneration } : mode === "demo" ? { mode, workspaceId: id, clientGeneration } : { mode, principalId: id, sessionId: id, workspaceId: id, clientGeneration };
  const runtime = createBrowserRuntime(identity, { origin: window.location.origin, fetch: vi.fn(), sendAnswer: async () => {} });
  runtimes.push(runtime);
  return runtime;
}
function wrapper(runtime: ReturnType<typeof owned>) {
  return function Owner({ children }: { children: ReactNode }) {
    return <BrowserRuntimeProvider value={{ runtime, workspaceLabel: null }}><QueryClientProvider client={runtime.queries}>{children}</QueryClientProvider></BrowserRuntimeProvider>;
  };
}
function fixed(location = city): WallLayout {
  return { ...structuredClone(DEFAULT_WALL_LAYOUT), weather: { enabled: true, unit: "fahrenheit", location: { mode: "fixed", ...location } } };
}
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => {
  provider.locate.mockResolvedValue(city);
  provider.readForecast.mockImplementation(async location => reading(location));
});
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.retire();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("Wall browser weather queries", () => {
  it("defaults to automatic Fahrenheit and shares one locate and forecast across the owner", async () => {
    const layout = structuredClone(DEFAULT_WALL_LAYOUT);
    expect(wallWeatherSettings(layout)).toEqual({ enabled: true, unit: "fahrenheit", location: { mode: "automatic" } });
    const owner = owned();
    const first = renderHook(() => useWallWeather(layout, now), { wrapper: wrapper(owner) });
    const second = renderHook(() => useWallWeather(layout, now), { wrapper: wrapper(owner) });
    await waitFor(() => expect(first.result.current?.status).toBe("ready"));
    await waitFor(() => expect(second.result.current?.reading?.location).toEqual(city));
    expect(provider.locate).toHaveBeenCalledTimes(1);
    expect(provider.readForecast).toHaveBeenCalledTimes(1);
    expect(provider.readForecast.mock.calls[0]![0]).toEqual(city);
    expect(provider.locate.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
    expect(provider.searchLocations).not.toHaveBeenCalled();
    expect(layout).not.toHaveProperty("weather");
  });

  it("uses fixed coordinates without locating and changes display units without refetching", async () => {
    const owner = owned();
    const hook = renderHook(({ layout }) => useWallWeather(layout, now), { initialProps: { layout: fixed() }, wrapper: wrapper(owner) });
    await waitFor(() => expect(hook.result.current?.status).toBe("ready"));
    hook.rerender({ layout: { ...fixed(), weather: { ...fixed().weather!, unit: "celsius" } } });
    expect(hook.result.current?.reading?.temperatureC).toBe(12);
    expect(provider.locate).not.toHaveBeenCalled();
    expect(provider.readForecast).toHaveBeenCalledTimes(1);
  });

  it.each(["disabled", "no-strip", "no-layout"] as const)("does not request public weather when %s", async mode => {
    let layout: WallLayout | null = structuredClone(DEFAULT_WALL_LAYOUT);
    if (mode === "disabled") layout.weather = { ...wallWeatherSettings(layout), enabled: false };
    else if (mode === "no-strip") layout.rows = layout.rows.filter(row => row.id !== "strip");
    else layout = null;
    const hook = renderHook(() => useWallWeather(layout, now), { wrapper: wrapper(owned()) });
    await act(async () => {});
    expect(hook.result.current).toBeUndefined();
    expect(provider.locate).not.toHaveBeenCalled();
    expect(provider.readForecast).not.toHaveBeenCalled();
  });

  it.each(["hosted", "demo"] as const)("does not contact external providers in a verified %s workspace", async mode => {
    const hook = renderHook(() => useWallWeather(DEFAULT_WALL_LAYOUT, now), { wrapper: wrapper(owned(mode)) });
    await act(async () => {});
    expect(hook.result.current).toBeUndefined();
    expect(provider.locate).not.toHaveBeenCalled();
    expect(provider.readForecast).not.toHaveBeenCalled();
  });

  it("does not contact providers from the immutable standalone demo viewer", async () => {
    vi.spyOn(viewer, "demoViewer").mockReturnValue({ version: 1, synthetic: true, release: "a".repeat(40), scenarioHash: "b".repeat(64), workspaceId: id, cutoff: new Date(now).toISOString(), generatedAt: null });
    const hook = renderHook(() => useWallWeather(DEFAULT_WALL_LAYOUT, now), { wrapper: wrapper(owned()) });
    await act(async () => {});
    expect(hook.result.current).toBeUndefined();
    expect(provider.locate).not.toHaveBeenCalled();
    expect(provider.readForecast).not.toHaveBeenCalled();
  });

  it("removes the previous city's reading immediately while another city's forecast is pending", async () => {
    const next = deferred<WeatherReading>();
    const hook = renderHook(({ layout }) => useWallWeather(layout, now), { initialProps: { layout: fixed() }, wrapper: wrapper(owned()) });
    await waitFor(() => expect(hook.result.current?.reading?.location).toMatchObject(city));
    provider.readForecast.mockReturnValueOnce(next.promise);
    hook.rerender({ layout: fixed(otherCity) });
    expect(hook.result.current).toEqual({ status: "loading" });
    await waitFor(() => expect(provider.readForecast).toHaveBeenCalledTimes(2));
    await act(async () => { next.resolve(reading(otherCity)); });
    await waitFor(() => expect(hook.result.current?.reading?.location).toEqual(otherCity));
  });

  it.each(["locate", "forecast"] as const)("retirement aborts a pending %s and discards its late completion", async phase => {
    const pendingLocation = deferred<WeatherLocation>();
    const pendingForecast = deferred<WeatherReading>();
    if (phase === "locate") provider.locate.mockReturnValueOnce(pendingLocation.promise);
    else provider.readForecast.mockReturnValueOnce(pendingForecast.promise);
    const owner = owned();
    const hook = renderHook(() => useWallWeather(phase === "locate" ? DEFAULT_WALL_LAYOUT : fixed(), now), { wrapper: wrapper(owner) });
    const method = phase === "locate" ? provider.locate : provider.readForecast;
    await waitFor(() => expect(method).toHaveBeenCalledTimes(1));
    const signal = phase === "locate" ? provider.locate.mock.calls[0]![0]! : provider.readForecast.mock.calls[0]![1]!;
    act(() => owner.retire());
    expect(signal.aborted).toBe(true);
    await act(async () => { pendingLocation.resolve(city); pendingForecast.resolve(reading()); });
    expect(owner.queries.getQueryCache().getAll()).toHaveLength(0);
    expect(hook.result.current?.reading).toBeUndefined();
    if (phase === "locate") expect(provider.readForecast).not.toHaveBeenCalled();
  });

  it("keeps different owner generations' cached locations and readings separate", async () => {
    const first = owned();
    const a = renderHook(() => useWallWeather(DEFAULT_WALL_LAYOUT, now), { wrapper: wrapper(first) });
    await waitFor(() => expect(a.result.current?.reading?.location).toEqual(city));
    provider.locate.mockResolvedValueOnce(otherCity);
    const b = renderHook(() => useWallWeather(DEFAULT_WALL_LAYOUT, now), { wrapper: wrapper(owned("standalone", 2)) });
    await waitFor(() => expect(b.result.current?.reading?.location).toEqual(otherCity));
    expect(a.result.current?.reading?.location).toEqual(city);
    expect(provider.locate).toHaveBeenCalledTimes(2);
    expect(provider.readForecast).toHaveBeenCalledTimes(2);
  });
});
