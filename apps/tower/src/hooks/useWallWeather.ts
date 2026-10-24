import { useQuery } from "@tanstack/react-query";
import { wallLayoutWidgets, wallWeatherSettings, type WallLayout } from "@shared/wall-layout";
import type { WeatherLocation, WeatherReading } from "@shared/weather";
import { useBrowserRuntime, useDemoReadonly } from "@/lib/browser-context";
import { BrowserRetiredError } from "@/lib/browser-runtime";
import { weatherClient } from "@/lib/weather";
import { wallWeatherState } from "@/lib/wall-weather-state";

const FORECAST_INTERVAL = 15 * 60_000;
const LOCATION_INTERVAL = 6 * 60 * 60_000;

/** Public providers receive no Tower credentials. Queries belong to the active browser owner. */
export function useWallWeather(layout: WallLayout | null, nowMs: number) {
  const runtime = useBrowserRuntime();
  const demo = useDemoReadonly();
  const settings = wallWeatherSettings(layout ?? {});
  // The free provider is for private/home installations, never a hosted commercial workspace.
  const enabled = !!layout && settings.enabled && runtime.owner.mode === "standalone" && !demo
    && wallLayoutWidgets(layout).some(widget => widget.type === "strip");
  const assertActive = () => {
    runtime.assertReadable();
    if (runtime.guard(() => true)() !== true) throw new BrowserRetiredError();
  };
  const automatic = useQuery<WeatherLocation>({
    queryKey: ["wall-weather-location"],
    enabled: enabled && settings.location.mode === "automatic",
    queryFn: async ({ signal }) => {
      assertActive();
      const location = await weatherClient.locate(signal);
      signal.throwIfAborted();
      assertActive();
      return location;
    },
    staleTime: LOCATION_INTERVAL,
    gcTime: 24 * 60 * 60_000,
    refetchInterval: query => query.state.status === "error" ? FORECAST_INTERVAL : LOCATION_INTERVAL,
    retry: false,
  });
  const location = settings.location.mode === "fixed" ? settings.location : automatic.data;
  const forecast = useQuery<WeatherReading>({
    queryKey: ["wall-weather-forecast", location?.latitude, location?.longitude, location?.name],
    enabled: enabled && !!location,
    queryFn: async ({ signal }) => {
      assertActive();
      if (!location) throw new Error("Weather location is unavailable.");
      const reading = await weatherClient.readForecast(location, signal);
      signal.throwIfAborted();
      assertActive();
      return reading;
    },
    staleTime: FORECAST_INTERVAL,
    gcTime: 24 * 60 * 60_000,
    refetchInterval: FORECAST_INTERVAL,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return enabled ? wallWeatherState(forecast.data, forecast.isError || (!location && automatic.isError), nowMs) : undefined;
}
