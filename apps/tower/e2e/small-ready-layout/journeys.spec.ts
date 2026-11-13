import { test, expect, BUILT_APP } from "../journey-test";
import { DESKTOP_ONLY, DEV_SERVER, PR_SMOKE } from "../fixtures";
import { wallFixturePayload } from "../wall-fixture";
import { everyTabPayload, viewOf } from "../../test/asset-detail-fixture";
import { isAssetDetailView } from "../../shared/asset-detail-views";

for (const width of [390, 1440]) {
  test(`One-site Home shares Overview's figures at ${width}px`, { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page, request }, info) => {
    expect((await request.post("/__journey/reset")).ok()).toBe(true);
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.setFixedTime(new Date("2026-07-05T14:00:00Z"));
    const body = everyTabPayload();
    const wall = structuredClone(wallFixturePayload("one"));
    wall.assets[0]!.id = body.asset.id;
    wall.assets[0]!.displayName = body.asset.displayName;
    await page.route("**/api/wall", route => route.fulfill({ json: wall }));
    await page.route(`**/api/assets/${body.asset.id}?*`, route => {
      const view = new URL(route.request().url()).searchParams.get("view");
      return route.fulfill({ json: isAssetDetailView(view) ? viewOf(body, view) : body });
    });
    const numbers = page.locator("[data-overview-numbers]");
    await page.goto("/");
    await expect(page.locator("#boot-splash")).toHaveCount(0);
    await expect(numbers.locator('[data-measure="people"]')).toBeVisible();
    const figures = await numbers.locator("[data-stat]").evaluateAll(elements => elements.map(element => ({
      label: element.getAttribute("data-stat"), figure: element.querySelector("[data-stat-figure]")?.textContent,
    })));
    await numbers.locator('[data-measure="people"]').click();
    await expect(numbers.locator('[data-overview-chart="people"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await info.attach(`home-numbers-${width}`, { body: await numbers.screenshot({ path: info.outputPath(`home-numbers-${width}.png`), animations: "disabled" }), contentType: "image/png" });
    await page.goto(`/assets/${body.asset.id}`);
    await expect(page.locator("#boot-splash")).toHaveCount(0);
    await expect(numbers.locator('[data-measure="people"]')).toBeVisible();
    expect(await numbers.locator("[data-stat]").evaluateAll(elements => elements.map(element => ({
      label: element.getAttribute("data-stat"), figure: element.querySelector("[data-stat-figure]")?.textContent,
    })))).toEqual(figures);
    await numbers.locator('[data-measure="people"]').click();
    await expect(numbers.locator('[data-overview-chart="people"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await info.attach(`overview-numbers-${width}`, { body: await numbers.screenshot({ path: info.outputPath(`overview-numbers-${width}.png`), animations: "disabled" }), contentType: "image/png" });
  });
}

for (const width of [390, 900, 1440]) {
  test(`Grouped list headings wrap completely at ${width}px`, { tag: [DESKTOP_ONLY, DEV_SERVER] }, async ({ page, request }, info) => {
    test.skip(BUILT_APP, "The component gallery runs on the development server");
    expect((await request.post("/__journey/reset")).ok()).toBe(true);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/dev/kitchen-sink");
    await expect(page.locator("#boot-splash")).toHaveCount(0);
    const gallery = page.getByRole("heading", { name: "ListPanel — three rows, an expander for the rest, evidence in place", exact: true }).locator("..");
    const panel = gallery.getByRole("region", { name: "Where it breaks", exact: true });
    const heading = panel.locator("[data-list-group] h3 > span").first();
    await heading.scrollIntoViewIfNeeded();
    expect(await heading.evaluate(element => {
      const style = getComputedStyle(element);
      return element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1
        && style.textOverflow !== "ellipsis" && style.webkitLineClamp === "none";
    })).toBe(true);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await panel.screenshot({ path: info.outputPath(`grouped-heading-${width}.png`), animations: "disabled" });
  });
}
