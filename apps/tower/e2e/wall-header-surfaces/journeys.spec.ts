import { test, expect } from "../journey-test";
import { DESKTOP_ONLY, PR_SMOKE } from "../fixtures";
import { WALL_FIXTURE_NOW, wallFixtureCalendar } from "../wall-fixture";
import { openWall, wallScene } from "../wall-scene";
import { persistedMetricScene } from "../wall-metric-editor/scene";
import { SAVED_COLUMN_LAYOUT } from "../../test/saved-wall-layout";

test("Wall header text shares two baselines across calendar states and TV sizes", { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await wallScene(page, "four");
  let calendar = wallFixtureCalendar();
  await page.route("**/api/calendar/upcoming", route => route.fulfill({ json: calendar }));
  for (const mode of ["empty", "cached-empty", "next", "active", "long"] as const) {
    calendar = wallFixtureCalendar();
    if (mode === "empty" || mode === "cached-empty") calendar.meetings = [];
    else if (mode === "active") {
      calendar.meetings[0]!.startsAt = new Date(Date.parse(WALL_FIXTURE_NOW) - 15 * 60_000).toISOString();
      calendar.meetings[0]!.endsAt = new Date(Date.parse(WALL_FIXTURE_NOW) + 15 * 60_000).toISOString();
    } else if (mode === "long") calendar.meetings[0]!.title = "Quarterly portfolio planning and integration review with the product team";
    if (mode === "cached-empty") {
      calendar.feedsConfigured = 2;
      calendar.fetchedAt = new Date(Date.parse(WALL_FIXTURE_NOW) - 3_600_000).toISOString();
    }
    for (const [width, height] of [[1920, 1080], [1280, 720], [3840, 2160]] as const) {
      await openWall(page, [width, height]);
      await expect(page.locator("#boot-splash")).toHaveCount(0);
      const baselines = await page.locator("[data-wall-strip]").evaluate(root => [...root.querySelectorAll<HTMLElement>("[data-strip-baseline]")].map(marker => {
        const node = marker.dataset.stripBaseline === "brand" ? marker.querySelector(".brand-wordmark")! : marker;
        const probe = document.createElement("span");
        probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline";
        node.append(probe);
        const baseline = probe.getBoundingClientRect().top;
        probe.remove();
        return { name: marker.dataset.stripBaseline, baseline };
      }));
      expect(baselines.length).toBeGreaterThanOrEqual(6);
      expect(Math.max(...baselines.map(item => item.baseline)) - Math.min(...baselines.map(item => item.baseline)), `${mode} ${width}×${height}: ${JSON.stringify(baselines)}`).toBeLessThanOrEqual(1.5);
      if (mode !== "empty") {
        const captions = await page.locator("[data-wall-strip]").evaluate(root => [...root.querySelectorAll<HTMLElement>("[data-strip-caption]")].map(node => {
          const probe = document.createElement("span");
          probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline";
          node.append(probe);
          const baseline = probe.getBoundingClientRect().top;
          probe.remove();
          return { text: node.textContent, baseline };
        }));
        expect(captions.length).toBeGreaterThanOrEqual(2);
        expect(Math.max(...captions.map(item => item.baseline)) - Math.min(...captions.map(item => item.baseline)), `${mode} captions ${width}×${height}: ${JSON.stringify(captions)}`).toBeLessThanOrEqual(.5);
      }
      if (width === 1920) await page.locator("[data-wall-strip]").screenshot({ path: testInfo.outputPath(`header-${mode}.png`) });
    }
  }
});

function surfaceAppearance(element: Element) {
  const alpha = (color: string) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3]! / 255;
  };
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return { background: alpha(style.backgroundColor), border: alpha(style.borderTopColor), width: rect.width, height: rect.height, color: style.color, opacity: style.opacity, text: element.textContent, chart: element.querySelector("svg[role=img]")?.innerHTML };
}

test("hidden Loop frames remove the absent hatch while retaining state ink", { tag: DESKTOP_ONLY }, async ({ page, request }) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await persistedMetricScene(page, SAVED_COLUMN_LAYOUT);
  await page.goto("/wall/edit");
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const frame = page.locator('[data-wall-preview] [data-wall-loop] [data-flow-node="attribute"][data-state="absent"]');
  await expect(frame).toBeVisible();
  const before = await frame.evaluate(element => ({ image: getComputedStyle(element).backgroundImage, ink: element.querySelector("[data-flow-state-word]")!.innerHTML }));
  expect(before.image).toContain("gradient");
  const dimensions = await frame.evaluate(surfaceAppearance);
  await page.getByRole("switch", { name: "Tile backgrounds and borders" }).click();
  expect(await frame.evaluate(element => getComputedStyle(element).backgroundImage)).toBe("none");
  const hidden = await frame.evaluate(surfaceAppearance);
  expect(hidden.background).toBe(0);
  expect(hidden.border).toBe(0);
  expect(hidden.width).toBe(dimensions.width);
  expect(hidden.height).toBe(dimensions.height);
  expect(await frame.locator("[data-flow-state-word]").innerHTML()).toBe(before.ink);
  await expect(frame).toContainText("Not measured");
  await page.getByRole("switch", { name: "Tile backgrounds and borders" }).click();
  expect(await frame.evaluate(element => getComputedStyle(element).backgroundImage)).toBe(before.image);
});

test("tile backgrounds and borders toggle without fading content or losing calibration", { tag: DESKTOP_ONLY }, async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await persistedMetricScene(page);
  await page.goto("/wall/edit");
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const slider = page.getByRole("slider", { name: "Tile transparency" });
  await slider.press("Home");
  for (let step = 0; step < 50; step++) await slider.press("ArrowRight");
  const preview = page.locator("[data-wall-preview]");
  const tile = preview.locator('[data-wall-metric="today"]').first();
  const before = await tile.evaluate(surfaceAppearance);
  expect(before.background).toBeCloseTo(.5, 2);
  expect(before.border).toBeCloseTo(.58, 2);
  const toggle = page.getByRole("switch", { name: "Tile backgrounds and borders" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  for (const metric of await preview.locator(".wall-metric").all()) {
    const hidden = await metric.evaluate(surfaceAppearance);
    expect(hidden.background).toBe(0);
    expect(hidden.border).toBe(0);
    expect(hidden.opacity).toBe("1");
  }
  const hidden = await tile.evaluate(surfaceAppearance);
  expect({ ...hidden, background: before.background, border: before.border }).toEqual(before);
  const separator = await preview.locator("[data-site-row]").nth(1).evaluate(row => getComputedStyle(row, "::before").backgroundColor);
  expect(separator).not.toBe("rgba(0, 0, 0, 0)");
  await tile.locator("[data-wall-metric-select]").click();
  const panel = page.locator('[data-wall-metric-panel="sites"]');
  await panel.getByRole("button", { name: "Focus on row" }).click();
  expect((await page.locator('[data-wall-focus-preview] .wall-metric').first().evaluate(surfaceAppearance)).border).toBe(0);
  await panel.getByRole("button", { name: "Back to Wall" }).click();
  const bar = page.locator("[data-wall-save-bar]");
  await bar.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(toggle).toBeChecked();
  expect((await tile.evaluate(surfaceAppearance)).background).toBeCloseTo(.5, 2);
  await bar.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await bar.getByRole("button", { name: "Save", exact: true }).click();
  await expect(bar.locator('[data-save-state="saved"] [data-status-for="wall:layout"]')).toHaveText("On the TV");
  await page.reload();
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  await expect(toggle).not.toBeChecked();
  await expect(slider).toHaveValue("50");
  expect((await tile.evaluate(surfaceAppearance)).border).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("tiles-without-backgrounds-and-borders.png"), fullPage: true });
  await toggle.click();
  expect((await tile.evaluate(surfaceAppearance)).background).toBeCloseTo(.5, 2);
  expect((await tile.evaluate(surfaceAppearance)).border).toBeCloseTo(.58, 2);
});
