import { test, expect } from "../journey-test";
import { DESKTOP_ONLY, PR_SMOKE } from "../fixtures";
import { openWall, wallScene } from "../wall-scene";
import { wallFixturePayload } from "../wall-fixture";

for (const deviceScaleFactor of [1, 2]) test.describe(`asset identity at DPR ${deviceScaleFactor}`, () => {
  test.use({ deviceScaleFactor });
  test("four assets have slim aligned identity headers above full-width metric tracks", { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page, request }, testInfo) => {
    expect((await request.post("/__journey/reset")).ok()).toBe(true);
    await wallScene(page, "four");
    const payload = structuredClone(wallFixturePayload("four"));
    payload.assets[2]!.displayName = "Example product with a longer asset name";
    await page.route("**/api/wall", route => route.fulfill({ json: payload }));
    await openWall(page, [1920, 1080]);
    await expect(page.locator("#boot-splash")).toHaveCount(0);
    const geometry = await page.locator(".wall-portfolio-list").evaluate(list => {
      const frame = list.getBoundingClientRect();
      return [...list.querySelectorAll<HTMLElement>("[data-site-row]")].map(row => {
        const header = row.querySelector("[data-site-name]")!.getBoundingClientRect();
        const name = row.querySelector("[data-site-label]")!.getBoundingClientRect();
        const metrics = row.querySelector(".wall-portfolio-metrics")!.getBoundingClientRect();
        const tiles = [...row.querySelectorAll(".wall-metric")].map(tile => { const r = tile.getBoundingClientRect(); return { top: r.top, height: r.height }; });
        return { header: { left: header.left, bottom: header.bottom, height: header.height }, nameHeight: name.height, metrics: { left: metrics.left, top: metrics.top, bottom: metrics.bottom }, tiles, visible: header.top >= frame.top - 1 && metrics.bottom <= frame.bottom + 1 };
      });
    });
    expect(geometry).toHaveLength(4);
    for (const row of geometry) {
      expect(row.visible).toBe(true);
      expect(row.header.height).toBeLessThanOrEqual(25);
      expect(row.nameHeight).toBeLessThanOrEqual(25);
      expect(row.header.bottom).toBeLessThanOrEqual(row.metrics.top);
      expect(Math.abs(row.header.left - row.metrics.left)).toBeLessThanOrEqual(1);
      expect(new Set(row.tiles.map(tile => tile.top)).size).toBe(1);
      for (const tile of row.tiles) expect(tile.height).toBeCloseTo(132, 0);
    }
    await expect(page.locator('[data-site-name] [data-site-health] rect')).toHaveCount(0);
    await expect(page.locator('[data-site-name] [data-site-source="live"]')).toHaveCount(4);
    await expect(page.locator('[data-site-label]', { hasText: "Example product with a longer asset name" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`asset-headers-1920-dpr${deviceScaleFactor}.png`) });
  });
});
