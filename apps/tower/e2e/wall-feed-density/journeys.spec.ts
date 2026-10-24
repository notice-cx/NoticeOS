import { test, expect } from "../journey-test";
import { DESKTOP_ONLY, PR_SMOKE } from "../fixtures";
import { openWall, wallScene, WALL_FEED_LAYOUT } from "../wall-scene";
import { WALL_FIXTURE_NOW } from "../wall-fixture";
import { feedSentence, type WallFeedPayload } from "../../shared/wall-feed";

const TITLE = "Keep the selected restaurant and delivery address when customers return from checkout to update their order, including saved delivery instructions";
const SENTENCE = feedSentence(TITLE);

test("Live feed fits more whole entries and more task text without shrinking below readable floors", { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await wallScene(page, "four", { layout: WALL_FEED_LAYOUT });
  const feed: WallFeedPayload = { generatedAt: WALL_FIXTURE_NOW, since: "2026-09-21T00:00:00.000Z", limit: 50,
    items: Array.from({ length: 24 }, (_, index) => ({ id: `density-${index}`, at: new Date(Date.parse(WALL_FIXTURE_NOW) - index * 60_000).toISOString(), kind: "task-done", label: "Task done", asset: "example.com", site: "Example", text: SENTENCE, task: `density-${index}`, who: "codex", model: "GPT-6.1 Sol", evidence: "abcdef1234567", count: 1, tone: "healthy" })) };
  await page.route("**/api/wall/feed*", route => route.fulfill({ json: feed }));
  for (const [name, width, height] of [["tv", 1920, 1080], ["laptop", 1280, 800], ["mobile", 390, 844]] as const) {
    await openWall(page, [width, height]);
    await expect(page.locator("#boot-splash")).toHaveCount(0);
    const list = page.locator("[data-wall-feed] ol");
    await expect(list.locator("[data-feed-item]")).toHaveCount(24);
    // On a phone the last region is below the portfolio; inspect its first screenful.
    if (name === "mobile") await page.locator("[data-wall-feed]").scrollIntoViewIfNeeded();
    const measure = () => list.evaluate(element => {
      const frame = element.getBoundingClientRect();
      const rows = [...element.querySelectorAll<HTMLElement>("[data-feed-item]")];
      const drawn = rows.filter(row => getComputedStyle(row).visibility !== "hidden" && getComputedStyle(row).display !== "none");
      const shown = drawn.filter(row => { const rect = row.getBoundingClientRect(); return rect.top >= Math.max(frame.top, 0) - .5 && rect.bottom <= Math.min(frame.bottom, innerHeight) + .5; });
      const clippedByList = drawn.filter(row => row.getBoundingClientRect().bottom > frame.bottom + .5).length;
      const text = rows[0]!.querySelector<HTMLElement>("[data-feed-text]")!;
      const bounds = text.getBoundingClientRect();
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      let visibleCharacters = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let index = 0; index < (node.textContent?.length ?? 0); index++) {
          const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1);
          const rect = range.getBoundingClientRect();
          if (rect.bottom <= bounds.bottom + .5 && rect.left >= bounds.left - .5 && rect.right <= bounds.right + .5) visibleCharacters++;
        }
      }
      const physicalFont = (node: HTMLElement) => {
        let zoom = 1;
        for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) zoom *= parseFloat(getComputedStyle(ancestor).zoom) || 1;
        return parseFloat(getComputedStyle(node).fontSize) * zoom;
      };
      const label = rows[0]!.querySelector<HTMLElement>("[data-feed-label]")!;
      const time = rows[0]!.querySelector<HTMLElement>("[data-feed-time]")!;
      const labelTextRight = label.getBoundingClientRect().right - parseFloat(getComputedStyle(label).paddingInlineEnd);
      return { rows: shown.length, clippedByList, characters: visibleCharacters, body: physicalFont(text), meta: physicalFont(time), timestampOverlap: labelTextRight > time.getBoundingClientRect().left + .5, fullText: text.textContent, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    const compact = await measure();
    await expect(page.getByRole("link", { name: SENTENCE }).first()).toBeVisible();
    expect(compact.body).toBeGreaterThanOrEqual(12.9);
    expect(compact.meta).toBeGreaterThanOrEqual(11.9);
    expect(compact.timestampOverlap).toBe(false);
    expect(compact.fullText).toContain(SENTENCE);
    expect(compact.overflow).toBe(false);
    expect(compact.clippedByList).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`feed-density-${name}-compact.png`) });
    // Inline theme utilities resolve against the Wall's local tokens, whereas their
    // named custom properties can retain the root's values. Probe the real utilities.
    const oldType = await list.evaluate(element => Object.fromEntries(["text-wall-list-line", "text-wall-list-label", "text-wall-list-meta"].map(className => {
      const probe = document.createElement("span"); probe.className = className; element.append(probe);
      const style = getComputedStyle(probe), typography = `font-size:${style.fontSize};line-height:${style.lineHeight};`;
      probe.remove(); return [className, typography];
    })));
    const legacy = await page.addStyleTag({ content: `[data-wall-feed] .wall-feed-row { grid-template-columns:1.875rem minmax(0,1fr) auto; gap:.75rem; padding:.625rem; } [data-wall-feed] [data-feed-time] { position:relative; top:auto; right:auto; padding-top:.125rem; } [data-wall-feed] .wall-feed-text { ${oldType["text-wall-list-line"]} } [data-wall-feed] .wall-feed-label { ${oldType["text-wall-list-label"]} padding-inline-end:0; } [data-wall-feed] .wall-feed-meta { ${oldType["text-wall-list-meta"]} }` });
    const before = await measure();
    await testInfo.attach(`density-${name}.json`, { body: JSON.stringify({ compact, before }, null, 2), contentType: "application/json" });
    await expect.poll(async () => (await measure()).characters).toBeLessThan(compact.characters);
    expect(compact.rows).toBeGreaterThan(before.rows);
    await legacy.evaluate(element => element.parentNode?.removeChild(element));
    await expect.poll(async () => (await measure()).rows).toBe(compact.rows);
    await page.screenshot({ path: testInfo.outputPath(`feed-density-${name}.png`) });
  }
});
