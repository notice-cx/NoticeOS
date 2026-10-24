import { describe, expect, it } from "vitest";
import { render } from "./render";
import type { WeatherReading } from "@shared/weather";
import { WallWeather } from "@/components/wall/WallWeather";

const reading: WeatherReading = {
  location: { name: "Example City", latitude: 40, longitude: -75 },
  timeZone: "UTC", observedAt: "2026-10-24T12:00:00Z", fetchedAt: "2026-10-24T12:05:00Z",
  temperatureC: 0, lowC: -5, highC: 10, conditionCode: 0, isDay: true,
};

describe("WallWeather", () => {
  it("defaults to Fahrenheit and preserves true zero while converting the daily range", () => {
    const view = render(<WallWeather state={{ status: "ready", reading }} />);
    expect(view.container.querySelector("[data-weather-temperature]")!.textContent).toContain("32°");
    expect(view.container.querySelector("[data-weather-low]")!.textContent).toBe("Low 23°");
    expect(view.container.querySelector("[data-weather-high]")!.textContent).toBe("High 50°");
    expect(view.getByRole("group", { name: "Weather for Example City" }).getAttribute("title")).toContain(reading.observedAt);
    expect(view.getByRole("group").getAttribute("title")).toContain("Weather by Open-Meteo");
  });

  it("renders Celsius and a distinct night condition", () => {
    const view = render(<WallWeather unit="celsius" state={{ status: "ready", reading: { ...reading, isDay: false } }} />);
    expect(view.container.querySelector("[data-weather-temperature]")!.textContent).toContain("0°");
    expect(view.container.querySelector("svg")!.classList.contains("lucide-moon")).toBe(true);
    expect(view.container.querySelector('[data-strip-baseline="weather"]')).not.toBeNull();
  });

  it("keeps missing range and condition unknown rather than inventing zero or clear skies", () => {
    const view = render(<WallWeather state={{ status: "ready", reading: { ...reading, lowC: null, highC: null, conditionCode: null, isDay: null } }} />);
    expect(view.container.querySelector("[data-weather-low]")!.textContent).toBe("Low —");
    expect(view.container.querySelector("[data-weather-high]")!.textContent).toBe("High —");
    expect(view.getByRole("group").getAttribute("title")).toContain("Condition unavailable");
  });

  it.each([[-20, "0%"], [0, "33.33333333333333%"], [40, "100%"]])("clamps the range marker for %s Celsius", (temperatureC, expected) => {
    const view = render(<WallWeather state={{ status: "ready", reading: { ...reading, temperatureC: Number(temperatureC) } }} />);
    expect((view.container.querySelector("[data-weather-range]") as HTMLElement).style.getPropertyValue("--wall-weather-position")).toBe(expected);
  });

  it("centers an equal-bound range and omits the band when a bound is missing", () => {
    const equal = render(<WallWeather state={{ status: "ready", reading: { ...reading, lowC: 0, highC: 0 } }} />);
    expect((equal.container.querySelector("[data-weather-range]") as HTMLElement).style.getPropertyValue("--wall-weather-position")).toBe("50%");
    const missing = render(<WallWeather state={{ status: "ready", reading: { ...reading, highC: null } }} />);
    expect(missing.container.querySelector("[data-weather-range]")).toBeNull();
    expect(missing.container.querySelector("[data-weather-position]")).toBeNull();
  });

  it("identifies a cached reading visibly and exposes both real timestamps", () => {
    const view = render(<WallWeather state={{ status: "stale", reading, message: "Retrying automatically" }} />);
    expect(view.container.querySelector("[data-weather-cached]")!.textContent).toBe("Cached");
    const title = view.getByRole("group").getAttribute("title")!;
    expect(title).toContain(reading.observedAt);
    expect(title).toContain(reading.fetchedAt);
    expect(title).toContain("Retrying automatically");
  });

  it.each(["loading", "unavailable"] as const)("does not present an old reading as current while %s", status => {
    const view = render(<WallWeather state={{ status, reading }} />);
    expect(view.container.querySelector("[data-weather-temperature]")!.textContent).not.toContain("32°");
    expect(view.container.querySelector("[data-weather-low]")).toBeNull();
    expect(view.getByRole("group").getAttribute("aria-label")).toBe(status === "loading" ? "Loading weather" : "Weather unavailable");
  });

  it.each([[3, "Overcast"], [45, "Fog"], [55, "Drizzle"], [65, "Rain"], [75, "Snow"], [99, "Thunderstorm"]])("maps WMO code %s to %s", (conditionCode, label) => {
    const view = render(<WallWeather state={{ status: "ready", reading: { ...reading, conditionCode: Number(conditionCode) } }} />);
    expect(view.getByRole("group").getAttribute("title")).toContain(label);
  });
});
