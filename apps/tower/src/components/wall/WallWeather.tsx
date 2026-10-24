import type { CSSProperties } from "react";
import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, CircleHelp, Moon, Sun } from "lucide-react";
import type { WeatherReading } from "@shared/weather";
import "./WallWeather.css";

export interface WallWeatherState {
  status: "loading" | "ready" | "stale" | "unavailable";
  reading?: WeatherReading;
  message?: string;
}

export interface WallWeatherProps {
  state: WallWeatherState;
  unit?: "fahrenheit" | "celsius";
}

function condition(code: number | null, isDay: boolean | null) {
  if (code === 0) return { Icon: isDay === false ? Moon : Sun, label: "Clear" };
  if (code === 1 || code === 2) return { Icon: isDay === false ? CloudMoon : CloudSun, label: "Partly cloudy" };
  if (code === 3) return { Icon: Cloud, label: "Overcast" };
  if (code === 45 || code === 48) return { Icon: CloudFog, label: "Fog" };
  if (code !== null && [51, 53, 55, 56, 57].includes(code)) return { Icon: CloudDrizzle, label: "Drizzle" };
  if (code !== null && [61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return { Icon: CloudRain, label: "Rain" };
  if (code !== null && [71, 73, 75, 77, 85, 86].includes(code)) return { Icon: CloudSnow, label: "Snow" };
  if (code !== null && [95, 96, 99].includes(code)) return { Icon: CloudLightning, label: "Thunderstorm" };
  return { Icon: CircleHelp, label: "Condition unavailable" };
}

/** A supplied reading only; fetching and deciding freshness belong to the caller. */
export function WallWeather({ state, unit = "fahrenheit" }: WallWeatherProps) {
  const reading = state.status === "ready" || state.status === "stale" ? state.reading : undefined;
  const degrees = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : `${Math.round(unit === "fahrenheit" ? value * 9 / 5 + 32 : value)}°`;
  const { Icon, label } = condition(reading?.conditionCode ?? null, reading?.isDay ?? null);
  const range = reading && reading.lowC !== null && reading.highC !== null && Number.isFinite(reading.lowC) && Number.isFinite(reading.highC) && reading.lowC <= reading.highC
    ? { low: reading.lowC, high: reading.highC } : null;
  const position = range && reading ? range.high === range.low ? 50 : Math.max(0, Math.min(100, (reading.temperatureC - range.low) / (range.high - range.low) * 100)) : null;
  const cached = state.status === "stale" && reading !== undefined;
  const status = state.status === "loading" ? "Loading weather" : "Weather unavailable";
  const unitLabel = unit === "fahrenheit" ? "Fahrenheit" : "Celsius";
  const description = reading
    ? `Weather by Open-Meteo · ${reading.location.name} · ${label} · ${unitLabel} · ${cached ? "Cached · " : ""}Observed ${reading.observedAt} · Fetched ${reading.fetchedAt}${state.message ? ` · ${state.message}` : ""}`
    : `Weather by Open-Meteo · ${status}${state.message ? ` · ${state.message}` : ""}`;
  return <div className="wall-strip-weather" data-wall-weather={state.status} role="group" aria-label={reading ? `Weather for ${reading.location.name}` : status} title={description}>
    <div className="wall-weather-primary text-wall-strip-time font-medium tabular-nums" data-strip-primary>
      <Icon className="wall-weather-icon" aria-hidden data-weather-condition={reading ? reading.conditionCode ?? "unknown" : "unknown"} />
      <span className="whitespace-nowrap" data-strip-baseline="weather" data-weather-temperature>{reading ? degrees(reading.temperatureC) : "—"}<span className="sr-only"> {unitLabel}</span></span>
      <span className="sr-only">{description}</span>
    </div>
    <div className="wall-weather-caption text-wall-strip-label text-muted-foreground tabular-nums" data-strip-meta>
      {reading ? <>
        <span data-strip-caption="weather" data-weather-low><span className="sr-only">Low </span>{degrees(reading.lowC)}</span>
        {position !== null ? <span className="wall-weather-range" aria-hidden data-weather-range style={{ "--wall-weather-position": `${position}%` } as CSSProperties}><span className="wall-weather-position" data-weather-position /></span> : <span className="wall-weather-range-missing" aria-hidden>–</span>}
        <span data-strip-caption="weather" data-weather-high><span className="sr-only">High </span>{degrees(reading.highC)}</span>
        {cached ? <span data-strip-caption="weather" data-weather-cached>Cached</span> : null}
      </> : <span data-strip-caption="weather">{state.status === "loading" ? "Loading…" : "Unavailable"}</span>}
    </div>
  </div>;
}
