import type { Locator, Page } from "@playwright/test";
import type { AlertHistoryPayload } from "../../shared/alert-history";
import type { AlertDailyPayload } from "../../shared/alert-daily";
import type { AttentionItem } from "../../shared/wall";
import { test, expect } from "../journey-test";
import { DESKTOP_ONLY } from "../fixtures";
import { WALL_FIXTURE_NOW, wallFixturePayload } from "../wall-fixture";

const longCondition = "The complete condition includes a long explanation of the affected request path and the final qualifier operators need to read. ".repeat(4) + "End of condition.";
const note = "Stored operator evidence remains available in the expanded row.";

test("Alerts combine settled repeats and distinguish daily counts from now", async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  expect((await (await request.get("/__journey/status")).json()).isolated).toBe(true);
  await page.clock.setFixedTime(new Date(WALL_FIXTURE_NOW));
  const wall = wallFixturePayload("one");
  const asset = wall.assets[0]!;
  const base: AttentionItem = {
    id: 901, asset: asset.id, assetDisplayName: asset.displayName, severity: "warn", kind: "anomaly",
    message: "API requests well below normal", firedAt: WALL_FIXTURE_NOW, firstFiredAt: WALL_FIXTURE_NOW,
    metric: "apiRequests", ruleId: "asset-declared", ruleInputs: null, occurrences: 1, correlatedChanges: [],
  };
  wall.attention = [{ ...base, ruleId: "hygiene-sitemap", metric: "sitemap",
    ruleInputs: { reason: "count-collapse", urls: 900, previous_urls: 3000 } }];
  wall.snoozed = [];
  const history: AlertHistoryPayload = {
    generatedAt: WALL_FIXTURE_NOW, total: 30, offset: 0, limit: 100, hasMore: false,
    rows: Array.from({ length: 30 }, (_, i) => ({ asset: { id: asset.id, displayName: asset.displayName, domain: asset.id },
      flag: { ...base, id: 902 + i,
        firedAt: new Date(Date.parse(WALL_FIXTURE_NOW) - (i + 1) * 86_400_000).toISOString(),
        firstFiredAt: new Date(Date.parse(WALL_FIXTURE_NOW) - (i + 1) * 86_400_000).toISOString(),
        disposition: null, dispositionAt: null, dispositionNote: null, snoozeUntil: null,
        ackExpiry: null, resolvedAt: WALL_FIXTURE_NOW, liveness: { state: "historical" },
      } })),
  };
  const day = WALL_FIXTURE_NOW.slice(0, 10);
  const daily: AlertDailyPayload = { generatedAt: WALL_FIXTURE_NOW,
    days: [{ day, open: 12, errors: 1, warnings: 1, observedAt: `${day}T03:00:00Z` }] };
  await page.route("**/api/wall", (route) => route.fulfill({ json: wall }));
  await page.route("**/api/alerts/history**", (route) => route.fulfill({ json: history }));
  await page.route("**/api/alerts/daily", (route) => route.fulfill({ json: daily }));
  await page.goto("/alerts");
  await expect(page.locator("[data-alerts-answer]")).toContainText("1 open alert, a warning");
  await expect(page.locator('[data-alert-week] [data-span^="settled:"]')).toHaveCount(1);
  await expect(page.locator('[data-alert-week] [data-span^="settled:"]')).toContainText("30 alerts");
  await expect(page.locator("[data-alerts-settled] dd")).toHaveText("1");
  const snapshots = page.getByRole("region", { name: "Daily open-alert snapshots", exact: true });
  await expect(snapshots.locator("[data-alert-daily-current]")).toContainText("Now: 1 open alert, a warning");
  await snapshots.getByText(/^View data/).click();
  await expect(snapshots.getByRole("cell", { name: "2", exact: true })).toBeVisible();
  await expect(snapshots.getByRole("cell", { name: "12", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await testInfo.attach("alerts-counts", { body: await page.screenshot({ fullPage: true, path: testInfo.outputPath("alerts-counts.png") }), contentType: "image/png" });
});

async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 100; i += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Keyboard did not reach the alert disclosure");
}

async function fits(locator: Locator) {
  expect(await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1
      && style.textOverflow !== "ellipsis" && style.webkitLineClamp === "none";
  })).toBe(true);
}

for (const width of [390, 900, 1440]) {
  test(`Alerts evidence is readable at ${width}px`, {
    tag: DESKTOP_ONLY,
    annotation: { type: "desktop only", description: "Walks its own phone, tablet and desktop viewport sizes" },
  }, async ({ page, request }, testInfo) => {
    const reset = await request.post("/__journey/reset");
    expect(reset.ok()).toBe(true);
    expect((await (await request.get("/__journey/status")).json()).isolated).toBe(true);
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.setFixedTime(new Date(WALL_FIXTURE_NOW));
    const wall = wallFixturePayload("one");
    const asset = wall.assets[0]!;
    const base: AttentionItem = {
      id: 801, asset: asset.id, assetDisplayName: asset.displayName, severity: "warn", kind: "anomaly",
      message: longCondition, firedAt: WALL_FIXTURE_NOW, firstFiredAt: WALL_FIXTURE_NOW,
      metric: null, ruleId: "synthetic-condition", ruleInputs: null, occurrences: 1, correlatedChanges: [],
    };
    wall.attention = [base,
      { ...base, id: 802, ruleId: "flow-pct-drop", metric: "signups", ruleInputs: { observed: 19, baselinePerDay: 100, dropFraction: 0.81, minDropFraction: 0.3 } },
      { ...base, id: 803, ruleId: "hygiene-html-depth", ruleInputs: { words: 80, baseline_median: 800, threshold_ratio: 0.5 } },
    ];
    wall.snoozed = [];
    const history: AlertHistoryPayload = {
      generatedAt: WALL_FIXTURE_NOW, total: 1, offset: 0, limit: 100, hasMore: false,
      rows: [{ asset: { id: asset.id, displayName: asset.displayName, domain: asset.id }, flag: {
        ...base, id: 804, disposition: "ack", dispositionAt: WALL_FIXTURE_NOW, dispositionNote: note,
        snoozeUntil: null, ackExpiry: null, resolvedAt: WALL_FIXTURE_NOW, liveness: { state: "historical" },
      } }],
    };
    const daily: AlertDailyPayload = { generatedAt: WALL_FIXTURE_NOW, days: [7, 12, null, 3, 0].map((open, index) => ({
      day: `2026-09-${18 + index}`, open, errors: open === null ? null : 0, warnings: open,
      observedAt: open === null ? null : `2026-09-${18 + index}T06:00:00Z`,
    })) };
    await page.route("**/api/wall", (route) => route.fulfill({ json: wall }));
    await page.route("**/api/alerts/history**", (route) => route.fulfill({ json: history }));
    await page.route("**/api/alerts/daily", (route) => route.fulfill({ json: daily }));
    await page.goto("/alerts");
    const first = page.locator('[data-alert-row="801"] > div > button');
    await expect(first).toHaveAttribute("aria-expanded", "false");
    await expect(first).toContainText("End of condition.");
    await fits(first.locator(".text-sm.font-medium").first());
    for (const id of [802, 803]) {
      const band = page.locator(`[data-alert-row="${id}"] [data-normal-band]`);
      await expect(band.locator("[data-normal-limit]")).toHaveCount(1);
      await expect(band.locator("[data-normal-range]")).toHaveCount(0);
      await expect(band.getByRole("img")).toHaveAccessibleName(id === 802
        ? /19 in 24h, below limit; limit 70 in 24h; problematic below/
        : /80 words, below limit; limit 400 words; problematic below/);
      await fits(band);
    }
    await tabTo(page, first);
    const firstText = await first.textContent();
    await expect(first).toHaveAccessibleName(/End of condition/);
    await page.keyboard.press("Enter");
    await expect(first).toHaveAttribute("aria-expanded", "true");
    expect(await first.textContent()).toBe(firstText);
    await expect(first).toHaveAccessibleName(/End of condition/);
    await page.keyboard.press("Space");
    await expect(first).toHaveAttribute("aria-expanded", "false");
    const snapshots = page.getByRole("region", { name: "Daily open-alert snapshots", exact: true });
    await snapshots.getByText(/^View data/).click();
    await expect(snapshots.getByRole("table")).toContainText("Not reported");
    await expect(snapshots.locator('time[datetime="2026-09-22"]').locator("..").locator("..")).toContainText("0");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await testInfo.attach(`alerts-open-${width}`, { body: await page.screenshot({ fullPage: true, path: testInfo.outputPath(`alerts-open-${width}.png`) }), contentType: "image/png" });

    await page.goto("/alerts/history");
    const closed = page.getByRole("button", { name: /End of condition/ });
    await expect(closed).toHaveAttribute("aria-expanded", "false");
    await fits(closed.locator(".text-sm.text-foreground"));
    await fits(closed.locator(".text-xs.text-muted-foreground").first());
    const accessibleName = await closed.textContent();
    await tabTo(page, closed);
    await page.keyboard.press("Enter");
    await expect(closed).toHaveAttribute("aria-expanded", "true");
    expect(await closed.textContent()).toBe(accessibleName);
    await expect(page.getByText(note, { exact: false })).toBeVisible();
    await fits(closed.locator(".text-sm.text-foreground"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await testInfo.attach(`alerts-history-${width}`, { body: await page.screenshot({ fullPage: true, path: testInfo.outputPath(`alerts-history-${width}.png`) }), contentType: "image/png" });
  });
}
