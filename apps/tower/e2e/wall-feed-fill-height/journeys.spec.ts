import { test, expect } from "../journey-test";
import { DESKTOP_ONLY, PR_SMOKE } from "../fixtures";
import { openWall, wallScene, WALL_FEED_LAYOUT } from "../wall-scene";
import { WALL_FIXTURE_NOW } from "../wall-fixture";
import { feedSentence, WALL_FEED_TASK_MAX_WORDS, type WallFeedPayload } from "../../shared/wall-feed";

for (const dpr of [1, 2]) test.describe(`Feed pixel ratio ${dpr}`, () => {
test.use({ deviceScaleFactor: dpr });
test(`Live feed fills its frame with the maximal whole entries at DPR ${dpr}`, { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
    for (const saved of [false, true]) {
      await page.unrouteAll({ behavior: "wait" });
      await wallScene(page, "four", saved ? { layout: WALL_FEED_LAYOUT } : {});
      const feed: WallFeedPayload = { generatedAt: WALL_FIXTURE_NOW, since: "2026-09-21T00:00:00.000Z", limit: 50, items: Array.from({ length: 40 }, (_, index) => ({ id: `fill-${index}`, at: new Date(Date.parse(WALL_FIXTURE_NOW) - index * 60_000).toISOString(), kind: "task-done", label: "Task done", asset: "example.com", site: "Example", text: feedSentence("Keep the selected restaurant and delivery address when customers return from checkout to update their order", WALL_FEED_TASK_MAX_WORDS), task: `fill-${index}`, who: "codex", model: "GPT-6.1 Sol", evidence: "abcdef1234567", count: 1, tone: "healthy" })) };
      await page.route("**/api/wall/feed*", route => route.fulfill({ json: feed }));
      for (const [width, height] of [[1920, 1080], [1280, 800], [390, 844]]) {
        await openWall(page, [width!, height!]);
        await expect(page.locator("#boot-splash")).toHaveCount(0);
        await expect(page.locator("[data-feed-item]")).toHaveCount(40);
        const dimensions = await page.locator("[data-wall-feed]").evaluate(element => {
          const root = element.closest<HTMLElement>(".wall-root")!, list = element.querySelector("ol")!;
          const box = element.getBoundingClientRect(), frame = list.getBoundingClientRect(), tile = element.querySelector(".wall-feed-metric")!.getBoundingClientRect();
          const rows = [...list.querySelectorAll<HTMLElement>("[data-feed-item]")];
          const shown = rows.filter(row => getComputedStyle(row).visibility !== "hidden" && getComputedStyle(row).display !== "none");
          const last = shown.at(-1)?.getBoundingClientRect(), next = rows[shown.length]?.getBoundingClientRect();
          const scale = root.getBoundingClientRect().width / root.offsetWidth;
          return { wallBottom: root.getBoundingClientRect().bottom - parseFloat(getComputedStyle(root).paddingBottom) * scale, feedBottom: box.bottom, tileBottom: tile.bottom, listBottom: frame.bottom, lastBottom: last?.bottom, nextBottom: next?.bottom, nextHeight: next?.height, shown: shown.length, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
        });
        await testInfo.attach(`fill-${saved}-${width}.json`, { body: JSON.stringify(dimensions, null, 2), contentType: "application/json" });
        await page.screenshot({ path: testInfo.outputPath(`feed-fill-${saved}-${width}.png`) });
        expect(dimensions.overflow).toBe(false);
        if (width! >= 1280) {
          expect(Math.abs(dimensions.feedBottom - dimensions.wallBottom)).toBeLessThanOrEqual(2);
          expect(Math.abs(dimensions.tileBottom - dimensions.feedBottom)).toBeLessThanOrEqual(2);
          expect(dimensions.tileBottom - dimensions.listBottom).toBeLessThanOrEqual(2);
          expect(dimensions.nextBottom).toBeGreaterThan(dimensions.tileBottom - 1);
          expect(dimensions.lastBottom).toBeLessThanOrEqual(dimensions.listBottom + .5);
        } else expect(dimensions.shown).toBe(12);
      }
    }
});
});
