import { SAVED_COLUMN_LAYOUT } from "../../test/saved-wall-layout";
import { BUILT_APP, test, expect } from "../journey-test";
import { openWall, wallScene } from "../wall-scene";
import { WALL_FIXTURE_VARIANTS } from "../wall-fixture";
import { DESKTOP_ONLY, DEV_SERVER, PR_SMOKE } from "../fixtures";
import type { WallLayout } from "../../shared/wall-layout";
import { WALL_WIDGET_MIN_PX } from "../../src/lib/wall-editor";
import { measureWallFit, wallFitVerdict } from "../../../../scripts/wall-fit-measure.mjs";

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/__journey/reset");
  expect(reset.ok()).toBe(true);
  expect((await (await request.get("/__journey/status")).json()).isolated).toBe(true);
});

for (const variant of WALL_FIXTURE_VARIANTS) {
  test(`Wall default fills both columns with whole asset rows: ${variant}`, { tag: DESKTOP_ONLY }, async ({ page }, testInfo) => {
    await wallScene(page, variant);
    await openWall(page, [1920, 1080]);
    const rows = page.locator('[data-site-row]');
    await expect(rows.first().locator('[data-site-name]')).toBeVisible();
    await expect(page.locator('[data-wall-column]')).toHaveCount(2);
    await expect(page.locator('#boot-splash')).toHaveCount(0);
    const count = await rows.count();
    await page.screenshot({ path: testInfo.outputPath(`wall-${variant}.png`) });
    const measured = await page.evaluate(measureWallFit);
    if ('error' in measured) throw new Error(measured.error);
    await testInfo.attach(`fit-${variant}`, { body: JSON.stringify(measured, null, 2), contentType: 'application/json' });
    expect(wallFitVerdict(measured).fits).toBe(true);
    expect(measured.ink).toEqual([]);
    expect(measured.clipped).toEqual([]);
    const list = page.locator('.wall-portfolio-list');
    const frame = (await list.boundingBox())!;
    for (let index = 0; index < Math.min(count, 4); index++) {
      const bounds = (await rows.nth(index).boundingBox())!;
      expect(bounds.y).toBeGreaterThanOrEqual(frame.y - 1);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
      const tiles = rows.nth(index).locator('.wall-metric');
      for (const tile of await tiles.all()) {
        expect((await tile.boundingBox())!.height).toBeCloseTo(132, 0);
        await expect(tile.locator('h3 svg')).toBeAttached();
      }
    }
    const scroll = await list.evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight }));
    if (count > 4) expect(scroll.content).toBeGreaterThan(scroll.height);
    else expect(scroll.content).toBeLessThanOrEqual(scroll.height + 1);
    if (count > 4) {
      await rows.last().scrollIntoViewIfNeeded();
      const end = (await rows.last().boundingBox())!;
      expect(end.y).toBeGreaterThanOrEqual(frame.y - 1);
      expect(end.y + end.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
    }
  });
}

test("Wall default editor has no undersized widgets", { tag: DESKTOP_ONLY }, async ({ page }, testInfo) => {
  await wallScene(page, "four");
  await page.goto("/wall/edit");
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  const preview = page.locator("[data-wall-preview]");
  const scale = Number(await preview.getAttribute("data-wall-preview-scale"));
  const measurements = [];
  for (const content of await page.locator("[data-wall-widget-content]").all()) {
    measurements.push(await page.evaluate(measureWallFit, { root: (await content.elementHandle())!, scale }));
  }
  await testInfo.attach("widget-fit", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("wall-editor-brand-fit.png"), fullPage: true });
  for (const measurement of measurements) {
    if ("error" in measurement) throw new Error(measurement.error);
    expect(measurement.ink).toEqual([]);
    expect(measurement.clipped).toEqual([]);
  }
  await expect(page.locator("[data-wall-too-small-note]")).toHaveCount(0);
});

const TWO_ROWS: WallLayout = {
  version: 1,
  rows: [
    { id: "site-row", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] },
    { id: "money-row", height: "auto", widgets: [{ id: "revenue", type: "revenue", width: 1 }] },
  ],
};

test("Wall full-width divider snaps, keeps minimums and records one Undo", { tag: DESKTOP_ONLY }, async ({ page }, testInfo) => {
  await wallScene(page, "one", { layout: TWO_ROWS });
  await page.goto("/wall/edit");
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const preview = page.locator("[data-wall-preview]");
  const handle = preview.locator('[data-wall-divider="y:site-row:money-row"]');
  const rows = preview.locator("[data-wall-canvas] > [data-wall-row]");
  await expect(handle).toBeVisible();
  const initial = await rows.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height));
  const drag = async (targetY: number) => {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, targetY, { steps: 12 });
    await expect(preview.locator("[data-wall-divider-readout]")).toBeVisible();
    await page.mouse.up();
  };
  const first = (await rows.nth(0).boundingBox())!;
  const last = (await rows.nth(1).boundingBox())!;
  await drag((first.y + last.y + last.height) / 2 + 2);
  await expect(handle).toHaveAttribute("aria-valuenow", "50");
  await expect(rows.nth(0)).toHaveAttribute("data-wall-row-size", "1");
  await expect(rows.nth(1)).toHaveAttribute("data-wall-row-size", "1");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(preview.locator("[data-wall-row-size]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  const undone = await rows.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height));
  undone.forEach((height, i) => expect(height).toBeCloseTo(initial[i]!, 0));
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await drag(first.y + 1);
  const scale = Number(await preview.getAttribute("data-wall-preview-scale"));
  expect((await rows.nth(0).boundingBox())!.height / scale).toBeGreaterThanOrEqual(WALL_WIDGET_MIN_PX.sites.height);
  expect((await rows.nth(1).boundingBox())!.height / scale).toBeGreaterThanOrEqual(WALL_WIDGET_MIN_PX.revenue.height);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  // The expanded comparison's minimum can stop the next two-thirds preset.
  // The pointer and keyboard must reach the same protected boundary.
  await drag(last.y + last.height - 1);
  const maximumShare = Number(await handle.getAttribute("aria-valuenow"));
  expect((await rows.nth(1).boundingBox())!.height / scale).toBeGreaterThanOrEqual(WALL_WIDGET_MIN_PX.revenue.height);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(handle).toHaveAttribute("aria-valuenow", "50");
  await handle.focus();
  await page.keyboard.press("PageDown");
  await expect(handle).toHaveAttribute("aria-valuenow", String(Math.min(Math.round(200 / 3), maximumShare)));
  await page.keyboard.press("Tab");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(handle).toHaveAttribute("aria-valuenow", "50");
  await preview.screenshot({ path: testInfo.outputPath("wall-top-level-resized.png") });
});

test("Wall short full-width rows resize without jumping above a large fill row", { tag: DESKTOP_ONLY }, async ({ page }, testInfo) => {
  await wallScene(page, "one", { layout: SAVED_COLUMN_LAYOUT });
  await page.goto("/wall/edit");
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const preview = page.locator("[data-wall-preview]");
  const rows = preview.locator("[data-wall-canvas] > [data-wall-row]");
  await expect(rows).toHaveCount(3);
  const before = await rows.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height));
  const handle = preview.locator('[data-wall-divider="y:strip:loop"]');
  const box = (await handle.boundingBox())!;
  const scale = Number(await preview.getAttribute("data-wall-preview-scale"));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 4 * scale, { steps: 6 });
  await page.mouse.up();
  await expect(rows.nth(2)).toHaveAttribute("data-wall-row-size", "12");
  const after = await rows.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height));
  expect(Math.abs(after[2]! - before[2]!) / scale).toBeLessThan(3);
  expect(Math.abs(after[0]! - before[0]!) / scale).toBeLessThan(8);
  expect(Math.abs(after[1]! - before[1]!) / scale).toBeLessThan(8);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(preview.locator("[data-wall-row-size]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  const undone = await rows.evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height));
  undone.forEach((height, index) => expect(height).toBeCloseTo(before[index]!, 0));
  await preview.screenshot({ path: testInfo.outputPath("wall-short-rows-undo.png") });
});

test("Wall portfolio scrolling stays stable with one and eight assets at the same size", async ({ page }, testInfo) => {
  const resizeErrors: string[] = [];
  page.on("pageerror", error => { if (error.message.includes("ResizeObserver")) resizeErrors.push(error.message); });
  const layout = structuredClone(TWO_ROWS);
  layout.rows.forEach(row => { row.size = 1; });
  const scene = await wallScene(page, "one", { layout });
  await page.goto("/wall/edit");
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const sites = page.locator('[data-wall-edit-widget="sites"]');
  await expect(sites.locator("[data-site-row]").first()).toBeVisible();
  await expect(sites).not.toHaveAttribute("data-too-small");
  await page.locator("[data-wall-preview]").screenshot({ path: testInfo.outputPath("wall-fit-one.png") });
  const oneHeight = await sites.evaluate(el => el.clientHeight);

  scene.variant = "eight";
  await page.reload();
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  await expect(sites.locator("[data-site-row]")).toHaveCount(8);
  expect(await sites.evaluate(el => el.clientHeight)).toBe(oneHeight);
  const scroll = sites.locator(".wall-portfolio-list");
  expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await sites.locator("[data-site-row]").last().scrollIntoViewIfNeeded();
  const noteChanges = await sites.evaluate(async element => {
    let changes = 0;
    const observer = new MutationObserver(records => { changes += records.length; });
    observer.observe(element, { attributes: true, attributeFilter: ["data-too-small"] });
    for (let frame = 0; frame < 6; frame++) await new Promise(requestAnimationFrame);
    observer.disconnect();
    return changes;
  });
  expect(noteChanges).toBe(0);
  expect(resizeErrors).toEqual([]);
  await page.locator("[data-wall-preview]").screenshot({ path: testInfo.outputPath("wall-fit-eight.png") });

  // Narrow the content without changing the row's geometry.
  await page.locator('[data-wall-widget-pick="sites"]').click();
  const checkboxes = page.locator('[data-wall-asset-filter] li > label input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(8);
  for (let index = 7; index > 0; index--) await checkboxes.nth(index).uncheck();
  await expect(sites.locator("[data-site-row]").first()).toBeVisible();
  await expect(sites).not.toHaveAttribute("data-too-small");
  expect(await sites.evaluate(el => el.clientHeight)).toBe(oneHeight);
  await page.screenshot({ path: testInfo.outputPath(`wall-editor-${testInfo.project.name}.png`), fullPage: true });
});

test("Wall default remains readable on desktop and phone", { tag: PR_SMOKE }, async ({ page }, testInfo) => {
  await wallScene(page, "three");
  await page.goto("/wall");
  await expect(page.locator("[data-site-row]")).toHaveCount(3);
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const measured = await page.evaluate(measureWallFit);
  if ("error" in measured) throw new Error(measured.error);
  expect(measured.layout).toBe(testInfo.project.name === "mobile" ? "stack" : "tv");
  expect(measured.ink).toEqual([]);
  expect(measured.clipped).toEqual([]);
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
  await page.screenshot({ path: testInfo.outputPath(`wall-default-${testInfo.project.name}.png`), fullPage: true });
});

test("Wall gallery specimens use TV tokens in light and dark themes", { tag: DEV_SERVER }, async ({ page }, testInfo) => {
  test.skip(BUILT_APP, "/dev/kitchen-sink is a dev-server page; a built app has none");
  await wallScene(page);
  const readings: unknown[] = [];
  for (const theme of ["light", "dark"]) {
    await page.addInitScript(value => localStorage.setItem("noticeos:theme", value), theme);
    await page.goto("/dev/kitchen-sink");
    const specimens = page.locator(".wall-root");
    // Cold Vite compilation precedes the gallery mount; splash release starts after it.
    await expect(specimens.first()).toBeAttached({ timeout: 30_000 });
    await expect(page.locator("#boot-splash")).toHaveCount(0);
    const drawn = await specimens.evaluateAll(roots => roots.map(root => {
      const style = getComputedStyle(root);
      return { theme: root.closest("[data-theme]")?.getAttribute("data-theme"), color: style.color,
        tokens: ["--background", "--foreground", "--muted-foreground", "--border", "--traffic", "--warn"].map(token => style.getPropertyValue(token).trim()) };
    }));
    expect(drawn.length).toBeGreaterThan(20);
    expect(drawn.every(root => root.theme === "dark")).toBe(true);
    expect(new Set(drawn.map(root => root.color)).size).toBe(1);
    readings.push(drawn);
    const sample = page.locator(".wall-root > [data-wall-strip]").first();
    await sample.scrollIntoViewIfNeeded();
    await sample.screenshot({ path: testInfo.outputPath(`wall-specimen-${theme}-${testInfo.project.name}.png`) });
  }
  expect(readings[0]).toEqual(readings[1]);
  await testInfo.attach("specimen-tokens", { body: JSON.stringify(readings), contentType: "application/json" });
});
