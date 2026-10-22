import { test, expect } from "../journey-test";
import { openWall, wallScene } from "../wall-scene";
import { WALL_FIXTURE_VARIANTS } from "../wall-fixture";
import { DESKTOP_ONLY } from "../fixtures";
import type { WallLayout } from "../../shared/wall-layout";
import { WALL_WIDGET_MIN_PX } from "../../src/lib/wall-editor";
import { measureWallFit, wallFitVerdict } from "../../../../scripts/wall-fit-measure.mjs";

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/__journey/reset");
  expect(reset.ok()).toBe(true);
  expect((await (await request.get("/__journey/status")).json()).isolated).toBe(true);
});

test("Wall default fills both columns with whole site rows", { tag: DESKTOP_ONLY }, async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const scene = await wallScene(page);
  for (const variant of WALL_FIXTURE_VARIANTS) {
    scene.variant = variant;
    await openWall(page, [1920, 1080]);
    await expect(page.locator("[data-wall-sites] [data-site-name]").first()).toBeVisible();
    await expect(page.locator("[data-wall-column]")).toHaveCount(2);
    await expect(page.locator("#boot-splash")).toHaveCount(0);
    const measured = await page.evaluate(measureWallFit);
    if ("error" in measured) throw new Error(measured.error);
    const gaps = await page.locator("[data-wall-column]").evaluateAll(columns => columns.map(column => {
      const box = column.getBoundingClientRect();
      const intervals: [number, number][] = [];
      const walker = document.createTreeWalker(column, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue?.trim() || node.parentElement?.closest("svg, .sr-only") || getComputedStyle(node.parentElement!).visibility === "hidden") continue;
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) if (rect.width && rect.height) intervals.push([rect.top, rect.bottom]);
      }
      for (const svg of column.querySelectorAll("svg")) {
        const rect = svg.getBoundingClientRect();
        if (rect.width && rect.height) intervals.push([rect.top, rect.bottom]);
      }
      let end = box.top, largest = 0;
      for (const [top, bottom] of intervals.sort((a, b) => a[0] - b[0])) {
        largest = Math.max(largest, Math.min(top, box.bottom) - end);
        end = Math.max(end, Math.min(bottom, box.bottom));
      }
      return { column: column.getAttribute("data-wall-column"), gap: Math.max(largest, box.bottom - end) };
    }));
    await testInfo.attach(`fit-${variant}`, { body: JSON.stringify({ measured, gaps }, null, 2), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath(`wall-${variant}.png`) });
    expect(wallFitVerdict(measured).fits).toBe(true);
    expect(measured.ink).toEqual([]);
    expect(measured.clipped).toEqual([]);
    for (const gap of gaps) expect(gap.gap, `${variant} ${gap.column}: empty block`).toBeLessThanOrEqual(100);
    if (variant !== "one") {
      const table = page.locator('[data-wall-sites] [role="table"]');
      for (const row of await page.locator("[data-site-row]").all()) {
        await row.scrollIntoViewIfNeeded();
        const bounds = (await row.boundingBox())!;
        const frame = (await table.boundingBox())!;
        expect(bounds.y).toBeGreaterThanOrEqual(frame.y - 1);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
      }
    }
  }
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
  await handle.focus();
  await page.keyboard.press("PageDown");
  await expect(handle).toHaveAttribute("aria-valuenow", "67");
  await page.keyboard.press("Tab");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(handle).toHaveAttribute("aria-valuenow", "50");
  await preview.screenshot({ path: testInfo.outputPath("wall-top-level-resized.png") });
});

test("Wall fit warnings follow one and eight sites at the same size", async ({ page }, testInfo) => {
  const resizeErrors: string[] = [];
  page.on("pageerror", error => { if (error.message.includes("ResizeObserver")) resizeErrors.push(error.message); });
  const layout = structuredClone(TWO_ROWS);
  layout.rows.forEach(row => { row.size = 1; });
  const scene = await wallScene(page, "one", { layout });
  await page.goto("/wall/edit");
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const sites = page.locator('[data-wall-edit-widget="sites"]');
  await expect(sites.locator("[data-focus-tile]").first()).toBeVisible();
  await expect(sites).not.toHaveAttribute("data-too-small");
  await page.locator("[data-wall-preview]").screenshot({ path: testInfo.outputPath("wall-fit-one.png") });
  const oneHeight = await sites.evaluate(el => el.clientHeight);

  scene.variant = "eight";
  await page.reload();
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  await expect(sites.locator("[data-site-row]")).toHaveCount(8);
  expect(await sites.evaluate(el => el.clientHeight)).toBe(oneHeight);
  await expect(sites).toHaveAttribute("data-too-small", "short");
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
  await expect(sites.locator("[data-wall-too-small-note]")).toContainText("Too short for Sites");
  await page.locator("[data-wall-preview]").screenshot({ path: testInfo.outputPath("wall-fit-eight.png") });

  // Narrow the content without changing the row's geometry.
  await page.locator('[data-wall-widget-pick="sites"]').click();
  const checkboxes = page.locator('[data-wall-asset-filter] li > label input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(8);
  for (let index = 7; index > 0; index--) await checkboxes.nth(index).uncheck();
  await expect(sites.locator("[data-focus-tile]").first()).toBeVisible();
  await expect(sites).not.toHaveAttribute("data-too-small");
  expect(await sites.evaluate(el => el.clientHeight)).toBe(oneHeight);
  await page.screenshot({ path: testInfo.outputPath(`wall-editor-${testInfo.project.name}.png`), fullPage: true });
});

test("Wall default remains readable on desktop and phone", async ({ page }, testInfo) => {
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

test("Wall gallery specimens use TV tokens in light and dark themes", async ({ page }, testInfo) => {
  await wallScene(page);
  const readings: unknown[] = [];
  for (const theme of ["light", "dark"]) {
    await page.addInitScript(value => localStorage.setItem("noticeos:theme", value), theme);
    await page.goto("/dev/kitchen-sink");
    await expect(page.locator("#boot-splash")).toHaveCount(0);
    const specimens = page.locator(".wall-root");
    await expect(specimens.first()).toBeAttached();
    const drawn = await specimens.evaluateAll(roots => roots.map(root => {
      const style = getComputedStyle(root);
      return { theme: root.closest("[data-theme]")?.getAttribute("data-theme"), color: style.color,
        tokens: ["--background", "--foreground", "--muted-foreground", "--border", "--traffic", "--warn"].map(token => style.getPropertyValue(token).trim()) };
    }));
    expect(drawn.length).toBeGreaterThan(20);
    expect(drawn.every(root => root.theme === "dark")).toBe(true);
    expect(new Set(drawn.map(root => root.color)).size).toBe(1);
    readings.push(drawn);
    const sample = page.locator(".wall-root:has(> [data-wall-strip])").first();
    await sample.scrollIntoViewIfNeeded();
    await sample.screenshot({ path: testInfo.outputPath(`wall-specimen-${theme}-${testInfo.project.name}.png`) });
  }
  expect(readings[0]).toEqual(readings[1]);
  await testInfo.attach("specimen-tokens", { body: JSON.stringify(readings), contentType: "application/json" });
});
