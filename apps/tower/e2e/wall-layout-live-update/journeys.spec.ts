import { test, expect } from "../journey-test";
import { DESKTOP_ONLY, PR_SMOKE } from "../fixtures";
import { persistedMetricScene } from "../wall-metric-editor/scene";
import { openWall } from "../wall-scene";
import { installOfflineGuard, startOfflineProxy } from "../offline-guard.mjs";

function paintedAppearance(element: Element) {
  const alpha = (color: string) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3]! / 255;
  };
  const style = getComputedStyle(element);
  const pseudo = getComputedStyle(element, "::before");
  return { backgroundAlpha: alpha(style.backgroundColor), borderWidth: style.borderWidth, radius: style.borderRadius, separator: pseudo.content !== "none" && pseudo.display !== "none", separatorAlpha: alpha(pseudo.backgroundColor), separatorHeight: parseFloat(pseudo.height), separatorWidth: parseFloat(pseudo.width), rowWidth: element.clientWidth };
}

test("an open TV without Web Locks receives a layout saved from another browser context", { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page: tv, browser, request, fixtureServer }) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  let streams = 0;
  tv.on("request", request => { if (new URL(request.url()).pathname === "/api/changes") streams += 1; });
  await tv.addInitScript(() => Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }));
  await persistedMetricScene(tv);
  await tv.goto("/wall");
  await expect(tv.locator("#boot-splash")).toHaveCount(0);
  await expect(tv.locator('[data-wall-metric="today"] h3').first()).toContainText("Today");
  expect(await tv.evaluate(() => typeof navigator.locks)).toBe("undefined");
  let navigations = 0;
  tv.on("framenavigated", frame => { if (frame === tv.mainFrame()) navigations += 1; });

  let transport: Awaited<ReturnType<typeof startOfflineProxy>> | undefined;
  let editorContext: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let guard: Awaited<ReturnType<typeof installOfflineGuard>> | undefined;
  try {
    transport = await startOfflineProxy(fixtureServer.origin);
    editorContext = await browser.newContext({ baseURL: fixtureServer.origin, proxy: transport.proxy, viewport: { width: 1920, height: 1080 }, serviceWorkers: "block" });
    guard = await installOfflineGuard(editorContext, fixtureServer.origin, { transport });
    await editorContext.addInitScript(() => Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }));
    const editor = await editorContext.newPage();
    await persistedMetricScene(editor);
    await editor.goto("/wall/edit");
    await expect(editor.locator("#boot-splash")).toHaveCount(0);
    const transparency = editor.getByRole("slider", { name: "Tile transparency" });
    await transparency.press("Home");
    for (let step = 0; step < 50; step += 1) await transparency.press("ArrowRight");
    await expect(transparency).toHaveValue("50");
    await editor.locator('[data-wall-preview] [data-wall-metric-select="today"]').first().click();
    await editor.locator('[data-wall-metric-panel="sites"]').getByLabel("Title").fill("Live layout update");
    await editor.getByRole("switch", { name: "Row separators" }).click();
    const bar = editor.locator("[data-wall-save-bar]");
    await bar.getByRole("button", { name: "Save", exact: true }).click();
    await expect(bar.locator('[data-save-state="saved"] [data-status-for="wall:layout"]')).toHaveText("On the TV");

    // The fixture pushes every three seconds; the Wall's fallback poll is sixty.
    await expect(tv.locator('[data-wall-metric="today"] h3')).toContainText(["Live layout update", "Live layout update", "Live layout update", "Live layout update"], { timeout: 12_000 });
    await expect(tv.locator("[data-wall-canvas]")).toHaveCSS("--wall-tile-background-opacity", "50%");
    await expect(tv.locator("[data-wall-sites]")).toHaveAttribute("data-row-separators", "hidden");
    expect(navigations).toBe(0);
    expect(streams).toBeGreaterThan(0);
    await expect(tv).toHaveURL(/\/wall$/);
    await editor.reload();
    await expect(editor.getByRole("slider", { name: "Tile transparency" })).toHaveValue("50");
    await editor.locator('[data-wall-preview] [data-wall-metric-select="today"]').first().click();
    await expect(editor.getByRole("switch", { name: "Row separators" })).not.toBeChecked();
  } finally {
    try {
      try {
        for (const page of editorContext?.pages() ?? []) await page.unrouteAll({ behavior: "wait" });
      } finally {
        await guard?.close();
        if (guard) expect(guard.check(), "the editor attempted to leave the fixture").toBeNull();
      }
    } finally {
      try { await editorContext?.close(); }
      finally { await transport?.close(); }
    }
  }
});

test("shared Portfolio separators leave metric surfaces and layout intact", { tag: DESKTOP_ONLY }, async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await persistedMetricScene(page);
  await openWall(page, [1920, 1080]);
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const wallRows = page.locator("[data-site-row]");
  await expect(wallRows).toHaveCount(4);
  for (let index = 0; index < 4; index += 1) {
    const row = wallRows.nth(index);
    const painted = await row.evaluate(paintedAppearance);
    expect(painted.backgroundAlpha).toBe(0);
    expect(painted.borderWidth).toBe("0px");
    expect(painted.radius).toBe("0px");
    expect(painted.separator).toBe(index > 0);
    if (index > 0) {
      expect(painted.separatorAlpha).toBeGreaterThan(0);
      expect(painted.separatorAlpha).toBeLessThan(1);
      expect(painted.separatorHeight).toBe(1);
      expect(painted.separatorWidth).toBeCloseTo(painted.rowWidth, 0);
    }
    const bounds = (await row.boundingBox())!;
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(1080);
  }
  await page.screenshot({ path: testInfo.outputPath("portfolio-separators-1920.png") });
  await page.goto("/wall/edit");
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const preview = page.locator("[data-wall-preview]");
  await preview.locator('[data-wall-metric-select="today"]').first().click();
  await page.locator('[data-wall-metric-panel="sites"]').getByLabel("Title").fill("Shared row");
  const row = preview.locator("[data-site-row]").nth(1);
  const tile = row.locator(".wall-metric").first();
  const before = await tile.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderColor }));
  expect((await row.evaluate(paintedAppearance)).separator).toBe(true);
  const bounds = (await row.boundingBox())!;
  const toggle = page.getByRole("switch", { name: "Row separators" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(preview.locator("[data-wall-sites]")).toHaveAttribute("data-row-separators", "hidden");
  await expect(preview.locator("[data-site-row]")).toHaveCount(4);
  const hidden = await row.evaluate(paintedAppearance);
  expect(hidden.backgroundAlpha).toBe(0);
  expect(hidden.separator).toBe(false);
  expect(await tile.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, border: getComputedStyle(element).borderColor }))).toEqual(before);
  const after = (await row.boundingBox())!;
  expect(after.width).toBeCloseTo(bounds.width, 0);
  expect(after.height).toBeCloseTo(bounds.height, 0);
  await page.locator('[data-wall-metric-panel="sites"]').getByRole("button", { name: "Focus on row" }).click();
  await expect(page.locator("[data-wall-focus-preview] [data-wall-sites]")).toHaveAttribute("data-row-separators", "hidden");
  await page.getByRole("switch", { name: "Row separators" }).click();
  await expect(page.locator("[data-wall-focus-preview] [data-wall-sites]")).not.toHaveAttribute("data-row-separators", "hidden");
});

test("tile transparency previews its bounds without fading figures or charts", { tag: DESKTOP_ONLY }, async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await persistedMetricScene(page);
  await page.goto("/wall/edit");
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const slider = page.getByRole("slider", { name: "Tile transparency" });
  const preview = page.locator("[data-wall-preview]");
  await expect(slider).toHaveValue("0");
  const tile = preview.locator('[data-wall-metric="today"]').first();
  const chart = tile.locator("svg[role=img]");
  await expect(chart).toBeAttached();
  const before = await tile.evaluate(element => ({ color: getComputedStyle(element).color, text: element.querySelector("h3")!.textContent, chart: element.querySelector("svg[role=img]")!.innerHTML }));
  const chartColor = await chart.evaluate(element => getComputedStyle(element).color);
  for (const value of [0, 50, 100]) {
    if (value === 0) await slider.press("Home");
    else if (value === 100) await slider.press("End");
    else {
      const box = (await slider.boundingBox())!;
      await slider.click({ position: { x: box.width / 2, y: box.height / 2 } });
    }
    await expect(slider).toHaveValue(String(value));
    await expect(preview.locator("[data-wall-canvas]")).toHaveCSS("--wall-tile-background-opacity", `${100 - value}%`);
    await expect(tile).toHaveCSS("opacity", "1");
    await expect(tile.locator("h3")).toHaveCSS("opacity", "1");
    expect((await tile.evaluate(paintedAppearance)).backgroundAlpha).toBeCloseTo((100 - value) / 100, 2);
    await expect(chart).toHaveCSS("opacity", "1");
    await expect(chart).toHaveCSS("color", chartColor);
    expect(await tile.evaluate(element => ({ color: getComputedStyle(element).color, text: element.querySelector("h3")!.textContent, chart: element.querySelector("svg[role=img]")!.innerHTML }))).toEqual(before);
    await page.screenshot({ path: testInfo.outputPath(`wall-transparency-${value}.png`), fullPage: true });
  }
  await tile.locator("[data-wall-metric-select]").click();
  await page.locator('[data-wall-metric-panel="sites"]').getByRole("button", { name: "Focus on row" }).click();
  await expect(page.locator("[data-wall-focus-preview] [data-wall-canvas]")).toHaveCSS("--wall-tile-background-opacity", "0%");
  const bar = page.locator("[data-wall-save-bar]");
  await bar.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(slider).toHaveValue("50");
  await bar.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(slider).toHaveValue("100");
  await bar.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(slider).toHaveValue("0");
});
