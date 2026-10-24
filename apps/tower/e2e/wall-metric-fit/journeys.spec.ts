import { writeFile } from "node:fs/promises";
import { SAVED_COLUMN_LAYOUT } from "../../test/saved-wall-layout";
import { test, expect } from "../journey-test";
import { DESKTOP_ONLY } from "../fixtures";
import { openWall, wallScene } from "../wall-scene";
import { persistedMetricScene } from "../wall-metric-editor/scene";

for (const deviceScaleFactor of [1, 2]) {
  test.describe(`1920 × 1080 at ${deviceScaleFactor}×`, () => {
    test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor });
    for (const saved of [false, true]) {
      test(`four synthetic assets: ${saved ? "saved columns" : "default"}`, { tag: DESKTOP_ONLY }, async ({ page, request }, testInfo) => {
        expect((await request.post("/__journey/reset")).ok()).toBe(true);
        await wallScene(page, "four", saved ? { layout: SAVED_COLUMN_LAYOUT } : {});
        await openWall(page, [1920, 1080]);
        await expect(page.locator("#boot-splash")).toHaveCount(0);
        const measurements = await page.locator(".wall-portfolio-list").evaluate(list => {
          const frame = list.getBoundingClientRect();
          return {
            viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
            frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
            contentHeight: list.scrollHeight,
            rows: [...list.querySelectorAll("[data-site-row]")].map(row => {
              const box = row.getBoundingClientRect();
              return { id: row.getAttribute("data-site-row"), y: box.y, height: box.height, fullyVisible: box.y >= frame.y - 1 && box.bottom <= frame.bottom + 1, tiles: [...row.querySelectorAll(".wall-metric")].map(tile => ({ height: tile.getBoundingClientRect().height, y: tile.getBoundingClientRect().y })) };
            }),
          };
        });
        const measurementPath = testInfo.outputPath("portfolio-fit.json");
        await writeFile(measurementPath, JSON.stringify(measurements, null, 2));
        await testInfo.attach("portfolio-fit", { path: measurementPath, contentType: "application/json" });
        await page.screenshot({ path: testInfo.outputPath(`wall-${saved ? "saved" : "default"}-${deviceScaleFactor}x.png`) });
        expect(measurements.rows).toHaveLength(4);
        expect(measurements.viewport).toEqual({ width: 1920, height: 1080, dpr: deviceScaleFactor });
        for (const row of measurements.rows) for (const tile of row.tiles) expect(tile.height).toBeCloseTo(156, 0);
        if (!saved) expect(measurements.rows.every(row => row.fullyVisible)).toBe(true);
        else {
          await page.locator("[data-site-row]").last().scrollIntoViewIfNeeded();
          const last = await page.locator("[data-site-row]").last().boundingBox();
          expect(last).not.toBeNull();
          expect(last!.y).toBeGreaterThanOrEqual(measurements.frame.y - 1);
          expect(last!.y + last!.height).toBeLessThanOrEqual(measurements.frame.y + measurements.frame.height + 1);
        }
      });
    }
  });
}

test.describe("explicit full composition", () => {
  test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  test("saved columns remain until the full Wall layout is selected and saved", { tag: DESKTOP_ONLY }, async ({ page, request }, testInfo) => {
    expect((await request.post("/__journey/reset")).ok()).toBe(true);
    await persistedMetricScene(page, SAVED_COLUMN_LAYOUT);
    const storedLayout = async () => (await (await request.get("/__journey/status")).json()).documents["config/tower.json"].wall.layout;
    await page.goto("/wall/edit");
    await expect(page.locator("#boot-splash")).toHaveCount(0);
    expect(await storedLayout()).toEqual(SAVED_COLUMN_LAYOUT);
    const preview = page.locator("[data-wall-preview]");
    await expect(preview.locator('[data-wall-row="loop"]')).toHaveCount(1);
    await page.getByRole("button", { name: "Use full Wall layout", exact: true }).click();
    await expect(preview.locator('[data-wall-row="loop"]')).toHaveCount(0);
    expect(await storedLayout()).toEqual(SAVED_COLUMN_LAYOUT);
    const bar = page.locator("[data-wall-save-bar]");
    await bar.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(preview.locator('[data-wall-row="loop"]')).toHaveCount(1);
    await bar.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(preview.locator('[data-wall-row="loop"]')).toHaveCount(0);
    await bar.getByRole("button", { name: "Save", exact: true }).click();
    await expect(bar.locator('[data-save-state="saved"] [data-status-for="wall:layout"]')).toHaveText("On the TV");
    await openWall(page, [1920, 1080]);
    const list = page.locator(".wall-portfolio-list");
    const frame = (await list.boundingBox())!;
    await expect(page.locator("[data-site-row]")).toHaveCount(4);
    for (const row of await page.locator("[data-site-row]").all()) {
      const bounds = (await row.boundingBox())!;
      expect(bounds.y).toBeGreaterThanOrEqual(frame.y - 1);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
      for (const tile of await row.locator(".wall-metric").all()) expect((await tile.boundingBox())!.height).toBeCloseTo(156, 0);
    }
    await expect(page.locator("#boot-splash")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("wall-full-layout-after-explicit-save-2x.png") });
  });
});
