import { test, expect } from "../journey-test";
import { DESKTOP_ONLY, PR_SMOKE } from "../fixtures";
import { persistedMetricScene } from "../wall-metric-editor/scene";
import { openWall } from "../wall-scene";

test("TV preset previews match the Wall at the corresponding effective viewport", { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page, context, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await persistedMetricScene(page);
  const actual = await context.newPage();
  try {
    await persistedMetricScene(actual);
    for (const [preset, width, height, portrait] of [["1080p-100", 1920, 1080, false], ["4k-200", 1920, 1080, false], ["4k-100", 3840, 2160, false], ["720p-100", 1280, 720, false], ["720p-100", 720, 1280, true]] as const) {
      await page.goto("/wall/edit");
      await expect(page.locator("#boot-splash")).toHaveCount(0);
      await page.getByLabel("TV preset", { exact: true }).selectOption(preset);
      if (portrait) {
        await page.getByText("Edit presets", { exact: true }).click();
        await page.getByLabel("Resolution", { exact: true }).selectOption("custom");
        await page.getByLabel("Width", { exact: true }).fill(String(width));
        await page.getByLabel("Height", { exact: true }).fill(String(height));
      }
      const preview = page.locator("[data-wall-preview]");
      await expect(preview).toHaveAttribute("data-wall-preview-width", String(width));
      await expect(preview).toHaveAttribute("data-wall-preview-height", String(height));
      await openWall(actual, [width, height]);
      await expect(actual.locator("#boot-splash")).toHaveCount(0);
      const painted = await preview.evaluate(async root => {
        await document.fonts.ready;
        await new Promise(requestAnimationFrame);
        const scale = Number(root.getAttribute("data-wall-preview-fit-scale"));
        const origin = root.querySelector(".wall-root")!.getBoundingClientRect();
        return [...root.querySelectorAll(".wall-metric")].map(tile => {
          const box = tile.getBoundingClientRect();
          return { x: (box.x - origin.x) / scale, y: (box.y - origin.y) / scale, width: box.width / scale, height: box.height / scale, title: tile.querySelector("h3")?.textContent };
        });
      });
      const target = await actual.locator(".wall-root").evaluate(root => {
        const origin = root.getBoundingClientRect();
        return [...root.querySelectorAll(".wall-metric")].map(tile => {
          const box = tile.getBoundingClientRect();
          return { x: box.x - origin.x, y: box.y - origin.y, width: box.width, height: box.height, title: tile.querySelector("h3")?.textContent };
        });
      });
      expect(painted.length).toBeGreaterThan(10);
      expect(painted).toHaveLength(target.length);
      for (const [index, tile] of painted.entries()) {
        expect(tile.title).toBe(target[index]!.title);
        for (const dimension of ["x", "y", "width", "height"] as const) expect(Math.abs(tile[dimension] - target[index]![dimension]), `${preset} tile ${index} ${dimension}`).toBeLessThan(2);
      }
      if (portrait) {
        expect(await preview.evaluate(root => root.scrollHeight > root.clientHeight)).toBe(true);
        await preview.evaluate(root => { root.scrollTop = root.scrollHeight; });
        const reachable = await preview.locator(".wall-metric").last().evaluate(tile => {
          const bounds = tile.getBoundingClientRect();
          const viewport = tile.closest("[data-wall-preview]")!.getBoundingClientRect();
          return bounds.top < viewport.bottom && bounds.bottom > viewport.top;
        });
        expect(reachable).toBe(true);
      }
      await testInfo.attach(`geometry-${preset}`, { body: JSON.stringify({ preview: painted, actual: target }), contentType: "application/json" });
      await page.screenshot({ path: testInfo.outputPath(`tv-preview-${preset}${portrait ? "-portrait" : ""}.png`), fullPage: true });
    }
  } finally { await actual.close(); }
});

test("custom TV presets preview immediately, validate, undo and save across reloads", { tag: DESKTOP_ONLY }, async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await persistedMetricScene(page);
  await page.goto("/wall/edit");
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const preset = page.getByLabel("TV preset", { exact: true });
  const preview = page.locator("[data-wall-preview]");
  await page.getByLabel("Resolution", { exact: true }).selectOption("4k");
  await page.getByLabel("Display scaling", { exact: true }).selectOption("200");
  await expect(preview).toHaveAttribute("data-wall-preview-width", "1920");
  await expect(page.getByLabel("Width", { exact: true })).toHaveCount(0);
  await page.getByLabel("Display scaling", { exact: true }).selectOption("100");
  await expect(preview).toHaveAttribute("data-wall-preview-width", "3840");
  await page.getByLabel("Resolution", { exact: true }).selectOption("1440p");
  await expect(preview).toHaveAttribute("data-wall-preview-width", "2560");
  await preset.selectOption("4k-200");
  await expect(preview).toHaveAttribute("data-wall-preview-width", "1920");
  await page.getByText("Edit presets", { exact: true }).click();
  await page.getByRole("button", { name: "Add preset", exact: true }).click();
  await page.getByLabel("Preset name", { exact: true }).fill("Living room TV");
  await page.getByLabel("Display scaling", { exact: true }).selectOption("150");
  await expect(preview).toHaveAttribute("data-wall-preview-width", "2560");
  await expect(preview).toHaveAttribute("data-wall-preview-height", "1440");
  const bar = page.locator("[data-wall-save-bar]");
  await bar.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(preview).toHaveAttribute("data-wall-preview-width", "1920");
  await bar.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(preview).toHaveAttribute("data-wall-preview-width", "2560");
  await page.getByLabel("Resolution", { exact: true }).selectOption("custom");
  await page.getByLabel("Width", { exact: true }).fill("");
  await expect(page.getByLabel("Width", { exact: true })).toHaveAttribute("aria-invalid", "true");
  await expect(bar.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.getByLabel("Width", { exact: true }).fill("3840");
  await bar.getByRole("button", { name: "Save", exact: true }).click();
  await expect(bar.locator('[data-save-state="saved"] [data-status-for="wall:layout"]')).toHaveText("On the TV");
  await page.reload();
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  await expect(preset.locator("option:checked")).toHaveText("Living room TV");
  await expect(preview).toHaveAttribute("data-wall-preview-width", "2560");
  await expect(preview).toHaveAttribute("data-wall-preview-height", "1440");
  await preview.locator('[data-wall-metric-select="today"]').first().click();
  const panel = page.locator('[data-wall-metric-panel="sites"]');
  await panel.getByRole("button", { name: "Focus on row" }).click();
  await expect(page.locator("[data-wall-focus-preview]")).toBeVisible();
  await panel.getByLabel("Title", { exact: true }).fill("Living room visitors");
  await panel.getByRole("button", { name: "Back to Wall" }).click();
  await expect(preview.locator('[data-wall-metric="today"] h3').first()).toContainText("Living room visitors");
  await page.getByText("Edit presets", { exact: true }).click();
  await page.getByRole("button", { name: "Remove preset", exact: true }).click();
  await expect(preset.locator("option")).not.toContainText(["Living room TV"]);
  await bar.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(preset.locator("option:checked")).toHaveText("Living room TV");
  await page.screenshot({ path: testInfo.outputPath("custom-tv-preset-editor.png"), fullPage: true });
});
