import type { Page } from "@playwright/test";
import { WALL_FIXTURE_NOW } from "./wall-fixture";

export function weatherForecastFixture() {
  return {
    timezone: "UTC", utc_offset_seconds: 0,
    current: { time: WALL_FIXTURE_NOW.slice(0, 16), temperature_2m: 21, weather_code: 2, is_day: 1 },
    current_units: { temperature_2m: "°C" },
    daily: { time: [WALL_FIXTURE_NOW.slice(0, 10)], temperature_2m_min: [12], temperature_2m_max: [24] },
    daily_units: { temperature_2m_min: "°C", temperature_2m_max: "°C" },
  };
}

/** Public weather calls are fulfilled locally, before the fixture's offline guard. */
export async function weatherScene(page: Page) {
  await page.route("https://free.freeipapi.com/**", route => route.fulfill({ json: { cityName: "Example city", regionName: "Example region", countryCode: "US", latitude: 40, longitude: -75 } }));
  await page.route("https://geocoding-api.open-meteo.com/**", route => route.fulfill({ json: { results: [{ name: "Example Bay", admin1: "Example region", country: "Example country", latitude: 42, longitude: -72 }] } }));
  await page.route("https://api.open-meteo.com/**", route => route.fulfill({ json: weatherForecastFixture() }));
}
