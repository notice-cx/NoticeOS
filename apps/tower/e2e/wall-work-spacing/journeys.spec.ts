import { test, expect } from "../journey-test";
import { openWall, wallScene } from "../wall-scene";
import { wallFixturePayload, wallFixtureRealtime } from "../wall-fixture";
import { DESKTOP_ONLY } from "../fixtures";
import { DEFAULT_WALL_LAYOUT, type WallLayout } from "../../shared/wall-layout";

test.beforeEach(async ({ request }) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  expect((await (await request.get("/__journey/status")).json()).isolated).toBe(true);
});

test("Portfolio Work counts keep clear spacing at narrow, standard and wide widths", { tag: DESKTOP_ONLY }, async ({ page }, testInfo) => {
  const layout: WallLayout = { version: 1, rows: [{ id: "sites", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1, settings: { metrics: [
    { id: "work", source: "asset-work", display: "multi", size: "standard" },
  ] } }] }] };
  await wallScene(page, "one", { layout });
  const payload = wallFixturePayload("one");
  await page.route("**/api/wall", route => route.fulfill({ json: { ...payload, dashboard: { ...payload.dashboard, wall: { layout, history: [] } } } }));
  for (const [closed, open, blocked] of [[103, 163, 7], [1103, 1163, 117]] as const) {
    const work = payload.assets[0]!.work!;
    work.open = open;
    work.inProgress = 0;
    work.blocked = blocked;
    work.weeks!.done.now = closed;
    for (const size of ["narrow", "standard", "wide"] as const) {
    const widget = layout.rows[0]!.widgets[0]!;
    if (widget.type !== "sites") throw new Error("Expected fixture Portfolio widget");
    widget.settings!.metrics![0]!.size = size;
    await openWall(page, [1920, 1080]);
    await expect(page.locator("#boot-splash")).toHaveCount(0);
    await page.evaluate(async size => {
      await document.fonts.ready;
      const row = document.querySelector<HTMLElement>("[data-site-row]")!;
      row.style.gridTemplateColumns = `8.75rem ${size === "narrow" ? "9.75rem" : size === "standard" ? "15rem" : "27rem"}`;
      row.style.width = "fit-content";
    }, size);
    const tiles = page.locator("[data-site-work] .wall-metric");
    await expect(tiles).toHaveCount(1);
    const geometry = await tiles.evaluateAll(elements => elements.map(element => {
      const box = (node: Pick<Element, "getBoundingClientRect">) => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }; };
      const closed = element.querySelector("[data-site-work-closed]")!;
      const open = element.querySelector("[data-site-work-open]")!;
      const blocked = element.querySelector("[data-site-work-blocked]")!;
      const ink = (node: Element) => { const range = document.createRange(); range.selectNodeContents(node); return box(range); };
      return { size: element.getAttribute("data-metric-size"), tile: box(element), closed: box(closed), open: box(open), blocked: box(blocked), facts: [...element.querySelectorAll("dt, dd")].map(ink), closedColor: getComputedStyle(closed).color, openColor: getComputedStyle(open).color, blockedColor: getComputedStyle(blocked).color, warning: blocked.closest("dd")!.classList.contains("text-warn") };
    }));
    for (const found of geometry) {
      expect(found.tile.height).toBeCloseTo(156, 0);
      expect(found.tile.width).toBeCloseTo(found.size === "narrow" ? 156 : found.size === "standard" ? 240 : 432, 0);
      if (found.size === "narrow") expect(found.open.top - found.closed.bottom).toBeGreaterThanOrEqual(4);
      else expect(found.open.left - found.closed.right).toBeGreaterThanOrEqual(16);
      expect(found.blocked.top - found.open.bottom).toBeGreaterThanOrEqual(found.size === "narrow" ? 4 : 10);
      for (const fact of found.facts) {
        expect(fact.left).toBeGreaterThanOrEqual(found.tile.left);
        expect(fact.right).toBeLessThanOrEqual(found.tile.right);
        expect(fact.top).toBeGreaterThanOrEqual(found.tile.top);
        expect(fact.bottom).toBeLessThanOrEqual(found.tile.bottom);
      }
      expect(found.warning).toBe(true);
      expect(found.blockedColor).not.toBe(found.closedColor);
      expect(found.blockedColor).not.toBe(found.openColor);
    }
    await testInfo.attach(`work-spacing-${closed}-${size}`, { body: JSON.stringify(geometry, null, 2), contentType: "application/json" });
    await page.locator("[data-site-row]").screenshot({ path: testInfo.outputPath(`work-spacing-${closed}-${size}.png`) });
    }
  }
  layout.rows = structuredClone(DEFAULT_WALL_LAYOUT.rows);
  payload.assets = wallFixturePayload("four").assets;
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
