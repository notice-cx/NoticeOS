import { test, expect } from "../journey-test";
import { DESKTOP_ONLY, PR_SMOKE } from "../fixtures";
import { openWall, wallScene, WALL_FEED_LAYOUT } from "../wall-scene";
import { WALL_FIXTURE_NOW } from "../wall-fixture";
import { feedSentence, WALL_FEED_TASK_MAX_WORDS, type WallFeedPayload } from "../../shared/wall-feed";

const SENTENCE = feedSentence("Keep the selected restaurant and delivery address when customers return from checkout to update their order, including saved delivery instructions and the contact details required for an accurate delivery estimate", WALL_FEED_TASK_MAX_WORDS);

test("Live feed shows three readable task lines with asset and agent identity and evidence", { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await wallScene(page, "four", { layout: WALL_FEED_LAYOUT });
  const feed: WallFeedPayload = { generatedAt: WALL_FIXTURE_NOW, since: "2026-09-21T00:00:00.000Z", limit: 50,
    items: Array.from({ length: 24 }, (_, index) => ({ id: `density-${index}`, at: new Date(Date.parse(WALL_FIXTURE_NOW) - index * 60_000).toISOString(), kind: "task-done", label: "Task done", asset: "example.com", site: "Example", text: SENTENCE, task: `density-${index}`, who: "codex", model: "GPT-6.1 Sol", evidence: index ? null : "abcdef1234567", count: 1, tone: "healthy" })) };
  await page.route("**/api/wall/feed*", route => route.fulfill({ json: feed }));
  for (const [name, width, height] of [["tv", 1920, 1080], ["laptop", 1280, 800], ["mobile", 390, 844]] as const) {
    await openWall(page, [width, height]);
    await expect(page.locator("#boot-splash")).toHaveCount(0);
    const rows = page.locator("[data-wall-feed] [data-feed-item]");
    await expect(rows).toHaveCount(24);
    const first = rows.first();
    if (name === "mobile") await first.scrollIntoViewIfNeeded();
    await expect(first.getByRole("link", { name: SENTENCE })).toBeVisible();
    await expect(first.getByRole("img", { name: "Example" })).toHaveAttribute("title", "Example");
    await expect(first.locator("[data-feed-asset] [data-property-favicon]")).toHaveAttribute("data-property-favicon", "example.com");
    await expect(first.locator("[data-feed-label] [data-feed-agent]")).toHaveAttribute("data-feed-agent", "openai");
    await expect(first.locator("[data-feed-label] [data-feed-model]")).toContainText("GPT-6.1 Sol");
    await expect(first.locator("[data-feed-evidence]")).toHaveText("abcdef1");
    await expect(rows.nth(1).locator("[data-feed-evidence]")).toHaveCount(0);
    const dimensions = await first.evaluate(element => {
      const text = element.querySelector<HTMLElement>("[data-feed-text]")!, time = element.querySelector<HTMLElement>("[data-feed-time]")!, label = element.querySelector<HTMLElement>("[data-feed-label]")!;
      let zoom = 1;
      for (let ancestor: HTMLElement | null = text; ancestor; ancestor = ancestor.parentElement) zoom *= parseFloat(getComputedStyle(ancestor).zoom) || 1;
      const style = getComputedStyle(text), line = parseFloat(style.lineHeight) * zoom;
      return { body: parseFloat(style.fontSize) * zoom, meta: parseFloat(getComputedStyle(time).fontSize) * zoom, lines: text.getBoundingClientRect().height / line, clamp: style.webkitLineClamp,
        overlap: label.getBoundingClientRect().right - parseFloat(getComputedStyle(label).paddingInlineEnd) * zoom > time.getBoundingClientRect().left + .5,
        overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    expect(dimensions.body).toBeGreaterThanOrEqual(12.9);
    expect(dimensions.meta).toBeGreaterThanOrEqual(11.9);
    expect(dimensions.clamp).toBe("3");
    expect(dimensions.lines).toBeGreaterThan(2.9);
    expect(dimensions.lines).toBeLessThanOrEqual(3.1);
    expect(dimensions.overlap).toBe(false);
    expect(dimensions.overflow).toBe(false);
    await testInfo.attach(`density-${name}.json`, { body: JSON.stringify(dimensions), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath(`feed-density-${name}.png`) });
  }
});
