import { isWeatherLocation, isWeatherReading, isWeatherTimeZone, WEATHER_CONDITION_CODES, type WeatherLocation, type WeatherReading } from "@shared/weather";

export interface WeatherClient {
  locate(signal?: AbortSignal): Promise<WeatherLocation>;
  searchLocations(query: string, signal?: AbortSignal): Promise<WeatherLocation[]>;
  readForecast(location: WeatherLocation, signal?: AbortSignal): Promise<WeatherReading>;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() && !/^(unknown|n\/a)$/i.test(value.trim()) ? value.trim() : null;
function locationOf(value: JsonObject, cityKey: string, regionKey: string, countryKey: string): WeatherLocation | null {
  const parts = [text(value[cityKey]), text(value[regionKey]), text(value[countryKey])].filter((part): part is string => part !== null);
  const location = { name: [...new Set(parts)].join(", "), latitude: value.latitude, longitude: value.longitude };
  return isWeatherLocation(location) ? location : null;
}

/** Open-Meteo's local timestamps use its returned fixed offset, including near DST. */
function observedInstant(value: unknown, offset: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)
    || typeof offset !== "number" || !Number.isInteger(offset) || Math.abs(offset) > 14 * 3600) return null;
  const local = value.length === 16 ? `${value}:00` : value;
  const milliseconds = Date.parse(`${local}Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== local) return null;
  return new Date(milliseconds - offset * 1000).toISOString();
}

export function createWeatherClient(options: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {}): WeatherClient {
  const read = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.min(30_000, Math.max(1, options.timeoutMs!)) : 8_000;
  async function json(url: URL, signal?: AbortSignal): Promise<JsonObject> {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("Weather request timed out", "TimeoutError")), timeoutMs);
    try {
      controller.signal.throwIfAborted();
      const response = await read(url, { signal: controller.signal, credentials: "omit", mode: "cors", referrerPolicy: "no-referrer" });
      if (!response.ok) throw new Error("Weather service unavailable");
      const value: unknown = await response.json();
      controller.signal.throwIfAborted();
      const result = object(value);
      if (Array.isArray(value) || value === null || typeof value !== "object" || result.error === true) throw new Error("Invalid weather response");
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }
  return {
    async locate(signal) {
      const value = await json(new URL("https://free.freeipapi.com/api/v1/json"), signal);
      const location = locationOf(value, "cityName", "regionName", "countryName");
      if (!location) throw new Error("Location unavailable");
      return location;
    },
    async searchLocations(query, signal) {
      const name = query.trim();
      if (name.length < 2) return [];
      if (name.length > 240) throw new Error("Location search is too long");
      const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
      url.search = new URLSearchParams({ name, count: "8", language: "en", format: "json" }).toString();
      const value = await json(url, signal);
      if (value.results === undefined) return [];
      if (!Array.isArray(value.results)) throw new Error("Invalid location results");
      return value.results.flatMap(item => {
        const location = locationOf(object(item), "name", "admin1", "country");
        return location ? [location] : [];
      });
    },
    async readForecast(location, signal) {
      if (!isWeatherLocation(location)) throw new Error("Invalid weather location");
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.search = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude), current: "temperature_2m,weather_code,is_day", daily: "temperature_2m_min,temperature_2m_max", temperature_unit: "celsius", timezone: "auto", forecast_days: "1" }).toString();
      const value = await json(url, signal);
      const current = object(value.current);
      const observedAt = observedInstant(current.time, value.utc_offset_seconds);
      const temperatureC = finite(current.temperature_2m);
      if (!observedAt || temperatureC === null || !isWeatherTimeZone(value.timezone)
        || object(value.current_units).temperature_2m !== "°C") throw new Error("Current weather unavailable");
      const daily = object(value.daily);
      const localDate = (current.time as string).slice(0, 10);
      const dayIndex = Array.isArray(daily.time) ? daily.time.indexOf(localDate) : -1;
      const bound = (key: string) => dayIndex >= 0 && object(value.daily_units)[key] === "°C" && Array.isArray(daily[key]) ? finite(daily[key][dayIndex]) : null;
      let lowC = bound("temperature_2m_min");
      let highC = bound("temperature_2m_max");
      if (lowC !== null && highC !== null && lowC > highC) { lowC = null; highC = null; }
      const code = finite(current.weather_code);
      const reading: WeatherReading = { location: { ...location }, timeZone: value.timezone, observedAt, fetchedAt: new Date(now()).toISOString(), temperatureC, lowC, highC,
        conditionCode: code !== null && WEATHER_CONDITION_CODES.has(code) ? code : null,
        isDay: current.is_day === 1 ? true : current.is_day === 0 ? false : null };
      if (!isWeatherReading(reading)) throw new Error("Invalid weather reading");
      return reading;
    },
  };
}

export const weatherClient = createWeatherClient();
