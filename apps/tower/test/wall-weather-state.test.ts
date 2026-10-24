import { describe, expect, it } from "vitest";
import type { WeatherReading } from "../shared/weather";
import { wallWeatherState } from "../src/lib/wall-weather-state";

const reading: WeatherReading = {
  location: { name: "Example city", latitude: 40, longitude: -75 },
  timeZone: "America/New_York",
  observedAt: "2026-10-24T18:00:00Z", fetchedAt: "2026-10-24T18:05:00Z",
  temperatureC: 21, lowC: 12, highC: 24, conditionCode: 2, isDay: true,
};

describe("Wall weather freshness", () => {
  it("distinguishes waiting and failed reads from a zero temperature", () => {
    expect(wallWeatherState(undefined, false, 0)).toEqual({ status: "loading" });
    expect(wallWeatherState(undefined, true, 0)).toEqual({ status: "unavailable" });
    expect(wallWeatherState({ ...reading, temperatureC: 0 }, false, Date.parse(reading.fetchedAt))).toMatchObject({ status: "ready", reading: { temperatureC: 0 } });
  });
  it("retains current-day values as cached after a failure or old observation", () => {
    expect(wallWeatherState(reading, true, Date.parse(reading.fetchedAt))).toEqual({ status: "stale", reading });
    expect(wallWeatherState(reading, false, Date.parse("2026-10-24T19:00:00Z"))).toEqual({ status: "stale", reading });
  });
  it("does not present yesterday's range as today's in the forecast's time zone", () => {
    const result = wallWeatherState(reading, false, Date.parse("2026-10-25T04:01:00Z"));
    expect(result).toMatchObject({ status: "stale", reading: { temperatureC: 21, lowC: null, highC: null } });
    expect(reading.lowC).toBe(12);
  });
  it("does not discard today's range at UTC midnight before local midnight", () => {
    expect(wallWeatherState(reading, true, Date.parse("2026-10-25T00:01:00Z"))).toEqual({ status: "stale", reading });
  });
});
