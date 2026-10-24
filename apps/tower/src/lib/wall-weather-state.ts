import type { WeatherReading } from "@shared/weather";
import type { WallWeatherState } from "@/components/wall/WallWeather";

const STALE_AFTER_MS = 45 * 60_000;

function localDay(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Cached temperatures can remain useful; yesterday's forecast is never today's range. */
export function wallWeatherState(reading: WeatherReading | undefined, failed: boolean, nowMs: number): WallWeatherState {
  if (!reading) return { status: failed ? "unavailable" : "loading" };
  const observed = Date.parse(reading.observedAt);
  const sameDay = localDay(observed, reading.timeZone) === localDay(nowMs, reading.timeZone);
  const stale = failed || !sameDay || nowMs - observed > STALE_AFTER_MS;
  return { status: stale ? "stale" : "ready", reading: sameDay ? reading : { ...reading, lowC: null, highC: null } };
}
