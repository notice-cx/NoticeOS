// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { isWeatherLocation, isWeatherReading } from "@shared/weather";
import { createWeatherClient } from "@/lib/weather";

const location = { name: "Example City", latitude: 52.5, longitude: 13.4 };
const now = () => Date.parse("2026-10-24T12:00:00Z");
const forecast = () => ({ timezone: "Europe/Berlin", utc_offset_seconds: 7200,
  current: { time: "2026-10-24T14:00", temperature_2m: 0, weather_code: 0, is_day: 1 },
  current_units: { temperature_2m: "°C" }, daily_units: { temperature_2m_min: "°C", temperature_2m_max: "°C" },
  daily: { time: ["2026-10-24"], temperature_2m_min: [-3], temperature_2m_max: [7] } });
function client(value: unknown, options: { status?: number } = {}) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value), { status: options.status ?? 200 }));
  return { api: createWeatherClient({ fetch: fetcher, now }), fetcher };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("public browser weather client", () => {
  it("resolves default fetch at request time while retaining an explicitly injected fetch", async () => {
    const first = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ cityName: "First City", latitude: 0, longitude: 0 }));
    const second = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ cityName: "Second City", latitude: 1, longitude: 1 }));
    vi.stubGlobal("fetch", first);
    const dynamic = createWeatherClient();
    const injected = createWeatherClient({ fetch: first });
    vi.stubGlobal("fetch", second);
    expect(await dynamic.locate()).toEqual({ name: "Second City", latitude: 1, longitude: 1 });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(await injected.locate()).toEqual({ name: "First City", latitude: 0, longitude: 0 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
  it("locates the caller using the documented free endpoint without credentials or country timezone guesses", async () => {
    const { api, fetcher } = client({ cityName: "Example City", regionName: "Example Region", countryName: "Example Country", latitude: 0, longitude: 0, timeZones: ["Pacific/Auckland", "Europe/London"] });
    expect(await api.locate()).toEqual({ name: "Example City, Example Region, Example Country", latitude: 0, longitude: 0 });
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://free.freeipapi.com/api/v1/json");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: "omit", mode: "cors", referrerPolicy: "no-referrer" });
    expect(fetcher.mock.calls[0]![1]).not.toHaveProperty("headers");
  });

  it("searches encoded city names and returns disambiguated valid locations only", async () => {
    const { api, fetcher } = client({ results: [{ name: "Example City", admin1: "Example City", country: "Example Country", latitude: 52, longitude: 13 }, { name: "Broken", latitude: 91, longitude: 0 }] });
    expect(await api.searchLocations("  Example & City  ")).toEqual([{ name: "Example City, Example Country", latitude: 52, longitude: 13 }]);
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://geocoding-api.open-meteo.com/v1/search");
    expect(url.searchParams.get("name")).toBe("Example & City");
    expect(url.searchParams.get("count")).toBe("8");
    expect(await api.searchLocations("x")).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await client({}).api.searchLocations("Nowhere")).toEqual([]);
  });

  it("reads Celsius current and daily values, keeping real zero and location coordinates", async () => {
    const { api, fetcher } = client(forecast());
    const reading = await api.readForecast(location);
    expect(reading).toEqual({ location, timeZone: "Europe/Berlin", observedAt: "2026-10-24T12:00:00.000Z", fetchedAt: "2026-10-24T12:00:00.000Z", temperatureC: 0, lowC: -3, highC: 7, conditionCode: 0, isDay: true });
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(url.searchParams.get("timezone")).toBe("auto");
    expect(url.searchParams.get("temperature_unit")).toBe("celsius");
    expect(url.searchParams.get("current")).toBe("temperature_2m,weather_code,is_day");
    expect(url.searchParams.get("daily")).toBe("temperature_2m_min,temperature_2m_max");
    expect(isWeatherReading(reading)).toBe(true);
  });

  it("rejects joined city names that cannot fit the saved weather configuration", async () => {
    const name = "x".repeat(150);
    const { api } = client({ results: [{ name, country: "Example Country", latitude: 0, longitude: 0 }, { name: "Example City", latitude: 0, longitude: 0 }] });
    expect(await api.searchLocations("Example")).toEqual([{ name: "Example City", latitude: 0, longitude: 0 }]);
    expect(isWeatherLocation({ ...location, name: "x".repeat(160) })).toBe(true);
    expect(isWeatherLocation({ ...location, name: "x".repeat(161) })).toBe(false);
  });

  it.each([
    ["2026-10-25T02:15", 7200, "2026-10-25T00:15:00.000Z"],
    ["2026-10-25T02:15", 3600, "2026-10-25T01:15:00.000Z"],
    ["2026-10-25T00:15", 19800, "2026-10-24T18:45:00.000Z"],
    ["2026-10-24T23:45", -12600, "2026-10-25T03:15:00.000Z"],
  ])("uses the returned offset for %s without the browser's clock zone", async (time, offset, instant) => {
    const value = forecast();
    value.current.time = time;
    value.utc_offset_seconds = offset;
    value.daily.time = ["2026-10-24", time.slice(0, 10)];
    value.daily.temperature_2m_min = [99, -5];
    value.daily.temperature_2m_max = [100, 5];
    const reading = await client(value).api.readForecast(location);
    expect(reading.observedAt).toBe(instant);
    // The daily values belong to the observation's local date, not its UTC date.
    expect(reading.lowC).toBe(time.startsWith("2026-10-24") ? 99 : -5);
  });

  it("keeps unknown optional conditions and missing or wrong-day daily values unknown", async () => {
    const value = forecast();
    value.current.weather_code = 1000;
    value.current.is_day = 9;
    value.daily.time = ["2026-10-23"];
    expect(await client(value).api.readForecast(location)).toMatchObject({ lowC: null, highC: null, conditionCode: null, isDay: null });
    const broken = { ...forecast(), daily: { time: ["2026-10-24"], temperature_2m_min: [null], temperature_2m_max: [0] } };
    expect(await client(broken).api.readForecast(location)).toMatchObject({ lowC: null, highC: 0 });
    expect(await client({ ...forecast(), daily_units: {} }).api.readForecast(location)).toMatchObject({ lowC: null, highC: null });
    expect(await client({ ...forecast(), daily: { time: ["2026-10-24"], temperature_2m_min: [10], temperature_2m_max: [5] } }).api.readForecast(location)).toMatchObject({ lowC: null, highC: null });
  });

  it.each([
    { current: {} }, { current: { time: "2026-10-24T12:00", temperature_2m: null } },
    { timezone: "Not/AZone" }, { utc_offset_seconds: null }, { utc_offset_seconds: 999999 },
    { current: { time: "2026-02-30T12:00", temperature_2m: 1 } },
    { current: { time: "2026-10-24T24:00", temperature_2m: 1 } }, { current_units: { temperature_2m: "°F" } },
  ])("rejects malformed required forecast data %j", async patch => {
    await expect(client({ ...forecast(), ...patch }).api.readForecast(location)).rejects.toThrow();
  });

  it("rejects failed, malformed and missing-location responses without retrying providers", async () => {
    await expect(client({}, { status: 429 }).api.locate()).rejects.toThrow("unavailable");
    await expect(client({ latitude: 0, longitude: 0 }).api.locate()).rejects.toThrow("Location unavailable");
    await expect(client({ error: true }).api.searchLocations("Example")).rejects.toThrow();
    await expect(client({ results: "bad" }).api.searchLocations("Example")).rejects.toThrow();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("CORS blocked"));
    await expect(createWeatherClient({ fetch: fetcher }).locate()).rejects.toThrow("CORS blocked");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const invalidJson = vi.fn<typeof fetch>().mockResolvedValue(new Response("not json"));
    await expect(createWeatherClient({ fetch: invalidJson }).locate()).rejects.toThrow();
  });

  it("propagates cancellation and bounds slow requests with cleanup", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    }));
    const api = createWeatherClient({ fetch: fetcher, timeoutMs: 200 });
    const pending = expect(api.locate()).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    const controller = new AbortController();
    const aborted = expect(api.locate(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await aborted;
    expect(vi.getTimerCount()).toBe(0);
    await expect(api.locate(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("weather DTO validation", () => {
  it.each([{ name: "", latitude: 0, longitude: 0 }, { ...location, latitude: NaN }, { ...location, longitude: 181 }, { ...location, latitude: "52" }])("rejects invalid saved coordinates %j", value => expect(isWeatherLocation(value)).toBe(false));
  it("rejects malformed cache readings without accepting unknown values as zero", async () => {
    const reading = await client(forecast()).api.readForecast(location);
    for (const patch of [{ temperatureC: null }, { temperatureC: NaN }, { observedAt: "2026-10-24T14:00" }, { observedAt: "2026-02-30T12:00:00Z" }, { fetchedAt: "bad" }, { timeZone: "Unknown" }, { lowC: undefined }, { lowC: 10, highC: 5 }, { conditionCode: 999 }, { isDay: 1 }]) {
      expect(isWeatherReading({ ...reading, ...patch }), JSON.stringify(patch)).toBe(false);
    }
    expect(isWeatherReading({ ...reading, lowC: 0, highC: 0, conditionCode: null, isDay: false })).toBe(true);
  });
});
