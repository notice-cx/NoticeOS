export interface WeatherLocation {
  name: string;
  latitude: number;
  longitude: number;
}

/** Temperatures use Celsius regardless of the display's chosen unit. */
export interface WeatherReading {
  location: WeatherLocation;
  timeZone: string;
  observedAt: string;
  fetchedAt: string;
  temperatureC: number;
  lowC: number | null;
  highC: number | null;
  conditionCode: number | null;
  isDay: boolean | null;
}

export const WEATHER_CONDITION_CODES = new Set([0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]);

export function isWeatherLocation(value: unknown): value is WeatherLocation {
  if (typeof value !== "object" || value === null) return false;
  const location = value as Record<string, unknown>;
  return typeof location.name === "string" && location.name.trim().length > 0 && location.name.length <= 160
    && typeof location.latitude === "number" && Number.isFinite(location.latitude) && Math.abs(location.latitude) <= 90
    && typeof location.longitude === "number" && Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180;
}

export function isWeatherTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}

export function isWeatherReading(value: unknown): value is WeatherReading {
  if (typeof value !== "object" || value === null) return false;
  const reading = value as Record<string, unknown>;
  const temperature = (item: unknown) => item === null || typeof item === "number" && Number.isFinite(item);
  const instant = (item: unknown) => {
    if (typeof item !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(item)) return false;
    const date = item.slice(0, 10);
    const midnight = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === date && Number.isFinite(Date.parse(item));
  };
  return isWeatherLocation(reading.location) && isWeatherTimeZone(reading.timeZone)
    && instant(reading.observedAt) && instant(reading.fetchedAt)
    && typeof reading.temperatureC === "number" && Number.isFinite(reading.temperatureC)
    && temperature(reading.lowC) && temperature(reading.highC)
    && !(typeof reading.lowC === "number" && typeof reading.highC === "number" && reading.lowC > reading.highC)
    && (reading.conditionCode === null || typeof reading.conditionCode === "number" && WEATHER_CONDITION_CODES.has(reading.conditionCode))
    && (reading.isDay === null || typeof reading.isDay === "boolean");
}
