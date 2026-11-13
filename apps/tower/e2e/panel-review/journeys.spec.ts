import { test, expect } from "../journey-test";
import { DESKTOP_ONLY, JOURNEY_ASSET, JOURNEY_NOW, PR_SMOKE } from "../fixtures";
import { fetchToRewrite } from "../rewritten-read.mjs";
import { planWrites, siteDraft } from "../../shared/asset-wizard";
import type { SettingsPayload } from "../../shared/settings";
import type { PanelReview } from "../../shared/wall";

test("review deadlines and completion ages fit the Activity page at TV and phone widths", {
  tag: [DESKTOP_ONLY, PR_SMOKE],
}, async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await page.clock.setFixedTime(new Date(JOURNEY_NOW));
  const settings = await request.get("/api/settings");
  const { sources, entities } = await settings.json() as SettingsPayload;
  const plan = planWrites(siteDraft({ domain: JOURNEY_ASSET, displayName: "Journey Example", prelaunch: false }),
    sources.rows, entities?.rows ?? [], new Date(JOURNEY_NOW));
  const headers = { origin: new URL(settings.url()).origin };
  expect((await request.post("/api/assets", { headers, data: plan.row })).status()).toBe(201);
  expect((await request.put("/api/config", { headers, data: { ops: plan.ops, slug: plan.slug } })).ok()).toBe(true);

  const review: PanelReview = {
    taskId: "jt-4a2", panelDate: "2026-09-01", dueAt: "2026-09-10T12:00:00.000Z",
    status: "open", closedAt: null, panel: true,
  };
  let current = { review, latest: review.panelDate };
  await page.route(`**/api/assets/${JOURNEY_ASSET}?view=activity`, async route => {
    const { response, headers: replyHeaders } = await fetchToRewrite(route);
    const actual = await response.json();
    await route.fulfill({ response, headers: replyHeaders,
      json: { ...actual, panelReview: current.review, latestPanelDate: current.latest } });
  });

  const cases = [
    { state: "pending", review, latest: review.panelDate, at: review.dueAt },
    { state: "overdue", review: { ...review, dueAt: "2026-09-03T12:00:00.000Z" }, latest: review.panelDate, at: "2026-09-03T12:00:00.000Z" },
    { state: "reviewed", review: { ...review, status: "closed" as const, closedAt: "2026-09-05T12:00:00.000Z" }, latest: review.panelDate, at: "2026-09-05T12:00:00.000Z" },
    { state: "pending", review: { ...review, status: "closed" as const, closedAt: "2026-09-05T12:00:00.000Z" }, latest: "2026-09-06", at: null },
  ];
  for (const width of [1920, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : 844 });
    for (const [index, scenario] of cases.entries()) {
      current = scenario;
      await page.goto(`/assets/${JOURNEY_ASSET}/activity`);
      await expect(page.locator("#boot-splash")).toHaveCount(0);
      const line = page.locator(`[data-panel-review-line="${scenario.state}"]`);
      const badge = line.locator("[data-panel-review]");
      await expect(badge).toBeVisible();
      await expect(badge).toHaveAccessibleName(new RegExp(scenario.latest!));
      if (scenario.at) await expect(badge.locator("time")).toHaveAttribute("datetime", scenario.at);
      else await expect(badge.locator("time")).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      await line.scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const dimensions = await badge.evaluate(element => {
        const box = element.getBoundingClientRect();
        const parent = element.parentElement!.getBoundingClientRect();
        return { left: box.left, right: box.right, parentLeft: parent.left, parentRight: parent.right,
          width: element.clientWidth, scroll: element.scrollWidth,
          pageWidth: document.documentElement.clientWidth, pageScroll: document.documentElement.scrollWidth };
      });
      expect(dimensions.left).toBeGreaterThanOrEqual(dimensions.parentLeft);
      expect(dimensions.right).toBeLessThanOrEqual(dimensions.parentRight);
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
      expect(dimensions.pageScroll).toBeLessThanOrEqual(dimensions.pageWidth + 1);
      await line.screenshot({ path: testInfo.outputPath(`review-${index}-${width}.png`), animations: "disabled" });
    }
  }
});
