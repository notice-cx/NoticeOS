import { test, expect } from "../journey-test";
import { openWall, wallScene } from "../wall-scene";
import { wallFixturePayload, wallFixtureRealtime } from "../wall-fixture";
import { DESKTOP_ONLY, PR_SMOKE } from "../fixtures";
import { DEFAULT_WALL_LAYOUT, type WallLayout } from "../../shared/wall-layout";

test.beforeEach(async ({ request }) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  expect((await (await request.get("/__journey/status")).json()).isolated).toBe(true);
});

test.use({ deviceScaleFactor: 2 });

test("Portfolio Work fits large counts and shows how blocked tasks fit inside Open", { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page }, testInfo) => {
  const layout: WallLayout = { version: 1, rows: [{ id: "sites", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1, settings: { metrics: [
    { id: "work", source: "asset-work", display: "multi", size: "standard" },
  ] } }] }] };
  await wallScene(page, "one", { layout });
  const payload = structuredClone(wallFixturePayload("one"));
  await page.route("**/api/wall", route => route.fulfill({ json: { ...payload, dashboard: { ...payload.dashboard, wall: { layout, history: [] } } } }));
  const work = payload.assets[0]!.work!;
  work.open = 1163;
  work.inProgress = 230;
  work.blocked = 117;
  work.weeks!.done.now = 1103;
  for (const size of ["narrow", "standard", "wide"] as const) {
    const widget = layout.rows[0]!.widgets[0]!;
    if (widget.type !== "sites") throw new Error("Expected fixture Portfolio widget");
    widget.settings!.metrics![0]!.size = size;
    await openWall(page, [1920, 1080]);
    await expect(page.locator("#boot-splash")).toHaveCount(0);
    await page.evaluate(async size => {
      await document.fonts.ready;
      const row = document.querySelector<HTMLElement>("[data-site-row]")!;
      const metrics = row.querySelector<HTMLElement>(".wall-portfolio-metrics")!;
      const width = size === "narrow" ? "9.75rem" : size === "standard" ? "15rem" : "27rem";
      metrics.style.gridTemplateColumns = width;
      metrics.style.width = width;
      row.style.width = "fit-content";
    }, size);
    const tile = page.getByRole("region", { name: "Work", exact: true });
    await expect(tile.locator('[data-task-status="open"]')).toHaveText("1,163");
    await expect(tile.locator('[data-task-status="in-progress"]')).toHaveText("230");
    await expect(tile.locator('[data-task-status="blocked"]')).toHaveText("117");
    await expect(tile.locator("[data-site-work-closed]")).toHaveText("1,103");
    const bar = tile.getByRole("img");
    await expect(bar).toHaveAccessibleName("1,163 open, including 117 blocked. 230 in progress.");
    const geometry = await tile.evaluate(element => {
      const frame = element.getBoundingClientRect();
      const contents = [...element.querySelectorAll("dt, dd, .wall-asset-work-week, .wall-task-status-track")];
      const fits = contents.every(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const bounds = range.getBoundingClientRect();
        return bounds.left >= frame.left && bounds.right <= frame.right && bounds.top >= frame.top && bounds.bottom <= frame.bottom;
      });
      return { height: frame.height, width: frame.width, fits };
    });
    expect(geometry.height).toBeCloseTo(132, 0);
    expect(geometry.width).toBeCloseTo(size === "narrow" ? 156 : size === "standard" ? 240 : 432, 0);
    expect(geometry.fits).toBe(true);
    const segments = await bar.locator("[data-task-status-part]").evaluateAll(parts => parts.map(part => part.getBoundingClientRect().width));
    const total = segments.reduce((sum, width) => sum + width, 0);
    for (const [index, count] of [1046, 117, 230].entries()) {
      expect(Math.abs(segments[index]! - total * count / 1393)).toBeLessThan(1);
    }
    await tile.screenshot({ path: testInfo.outputPath(`wall-work-${size}.png`) });
  }
  layout.rows = structuredClone(DEFAULT_WALL_LAYOUT.rows);
  payload.assets = structuredClone(wallFixturePayload("four").assets);
  const contextualWork = payload.assets[0]!.work!;
  contextualWork.open = 163;
  contextualWork.inProgress = 0;
  contextualWork.blocked = 7;
  contextualWork.weeks!.done.now = 103;
  await page.route("**/api/ga4/realtime", route => route.fulfill({ json: wallFixtureRealtime(20, "four") }));
  await openWall(page, [1920, 1080]);
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath("wall-work-spacing-1920.png"), fullPage: true });
});
