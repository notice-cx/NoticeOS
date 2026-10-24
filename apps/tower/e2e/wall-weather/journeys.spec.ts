import { test, expect } from "../journey-test";
import { DESKTOP_ONLY, PR_SMOKE } from "../fixtures";
import { openWall, wallScene } from "../wall-scene";
import { persistedMetricScene } from "../wall-metric-editor/scene";
import { weatherForecastFixture } from "../wall-weather-fixture";
import { measureWallFit } from "../../../../scripts/wall-fit-measure.mjs";

// Provider routes return fixtures; the browser's offline proxy still refuses every external connection.
test.use({ bypassCSP: true });

test("Weather joins the header baselines and keeps four assets visible", { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await wallScene(page, "four");
  await openWall(page, [1920, 1080]);
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const weather = page.locator("[data-wall-weather]");
  await expect(weather).toHaveAttribute("data-wall-weather", "ready");
  await expect(weather.locator("[data-weather-temperature]")).toContainText("70°");
  await expect(weather.locator("[data-weather-low]")).toContainText("54°");
  await expect(weather.locator("[data-weather-high]")).toContainText("75°");
  const geometry = await page.locator("[data-wall-strip]").evaluate(root => {
    const baseline = (element: Element) => {
      const node = element.getAttribute("data-strip-baseline") === "brand" ? element.querySelector(".brand-wordmark")! : element;
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline";
      node.append(probe);
      const y = probe.getBoundingClientRect().top;
      probe.remove(); return y;
    };
    return {
      primary: [...root.querySelectorAll("[data-strip-baseline]")].map(baseline),
      captions: [...root.querySelectorAll("[data-strip-caption]")].map(baseline),
      weather: root.querySelector("[data-wall-weather]")!.getBoundingClientRect().right,
      date: root.querySelector("[data-strip-date]")!.getBoundingClientRect().left,
      beforeWeather: root.querySelector(".wall-weather-icon")!.getBoundingClientRect().left - root.querySelector(".wall-strip-countdown")!.getBoundingClientRect().right,
      afterWeather: root.querySelector("[data-strip-date]")!.getBoundingClientRect().left - root.querySelector("[data-weather-temperature]")!.getBoundingClientRect().right,
      rows: [...document.querySelectorAll("[data-site-row]")].map(row => row.getBoundingClientRect().bottom),
    };
  });
  expect(Math.max(...geometry.primary) - Math.min(...geometry.primary)).toBeLessThanOrEqual(1.5);
  expect(Math.max(...geometry.captions) - Math.min(...geometry.captions)).toBeLessThanOrEqual(.5);
  expect(geometry.weather).toBeLessThan(geometry.date);
  expect(Math.abs(geometry.beforeWeather - geometry.afterWeather)).toBeLessThanOrEqual(1.5);
  expect(geometry.rows).toHaveLength(4);
  expect(Math.max(...geometry.rows)).toBeLessThanOrEqual(1080);
  await page.screenshot({ path: testInfo.outputPath("weather-wall-1080.png") });
  for (const size of [[1280, 720], [768, 1024], [390, 844]] as const) {
    await page.setViewportSize({ width: size[0], height: size[1] });
    await expect(weather).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("Weather city and units preview, undo, save and reload with the Wall", { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await persistedMetricScene(page);
  const forecasts: URL[] = [];
  await page.route("https://api.open-meteo.com/**", async route => {
    forecasts.push(new URL(route.request().url()));
    await route.fulfill({ json: weatherForecastFixture() });
  });
  await page.goto("/wall/edit");
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  await page.getByRole("button", { name: "Top strip", exact: true }).click();
  const editor = page.locator("[data-wall-weather-editor]");
  await expect(editor.getByRole("radio", { name: "°F", exact: true })).toBeChecked();
  const weather = page.locator("[data-wall-preview] [data-wall-weather]");
  await expect(weather.locator("[data-weather-temperature]")).toContainText("70°");
  await editor.getByRole("radio", { name: "°C", exact: true }).check();
  await expect(weather.locator("[data-weather-temperature]")).toContainText("21°");
  await editor.getByRole("button", { name: "Search city", exact: true }).click();
  await editor.getByLabel("City", { exact: true }).fill("Example Bay");
  await editor.getByRole("button", { name: "Search", exact: true }).click();
  await editor.getByRole("button", { name: /Example Bay,/ }).click();
  await expect(weather).toHaveAttribute("aria-label", /Example Bay/);
  expect(forecasts.some(url => url.searchParams.get("latitude") === "42")).toBe(true);
  await editor.getByRole("radio", { name: "Off", exact: true }).check();
  await expect(weather).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(weather).toBeVisible();
  const save = page.locator("[data-wall-save-bar]").getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect(save).toBeDisabled();
  const stripContent = await page.locator('[data-wall-edit-widget="strip"] [data-wall-widget-content]').elementHandle();
  if (!stripContent) throw new Error("Top strip preview is missing");
  const scale = await stripContent.evaluate(element => element.getBoundingClientRect().width / element.clientWidth);
  const fit = await page.evaluate(measureWallFit, { root: stripContent, scale });
  if ("error" in fit) throw new Error(fit.error);
  expect({ overX: fit.counts.overX, overY: fit.counts.overY, ink: fit.ink, clipped: fit.clipped }, JSON.stringify(fit.worst)).toEqual({ overX: 0, overY: 0, ink: [], clipped: [] });
  await page.screenshot({ path: testInfo.outputPath("weather-editor.png") });
  await page.goto("/wall");
  await expect(page.locator("[data-wall-weather]")).toHaveAttribute("aria-label", /Example Bay/);
  await expect(page.locator("[data-weather-temperature]")).toContainText("21°");
});

test("A failed weather read is unavailable instead of zero", { tag: DESKTOP_ONLY }, async ({ page, request }) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await wallScene(page, "four");
  await page.route("https://api.open-meteo.com/**", route => route.fulfill({ status: 503, json: {} }));
  await openWall(page, [1920, 1080]);
  await expect(page.locator("[data-wall-weather]")).toHaveAttribute("data-wall-weather", "unavailable");
  await expect(page.locator("[data-weather-temperature]")).toContainText("—");
  await expect(page.locator("[data-wall-weather]")).toContainText("Unavailable");
});
