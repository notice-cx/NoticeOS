import { test, expect } from "../journey-test";
import { DESKTOP_ONLY, PR_SMOKE } from "../fixtures";
import { wallFixturePayload, WALL_FIXTURE_NOW } from "../wall-fixture";
import { openWall, wallScene } from "../wall-scene";
import { DEFAULT_WALL_LAYOUT, isWallColumn } from "../../shared/wall-layout";
import { measureWallFit } from "../../../../scripts/wall-fit-measure.mjs";

// Public weather routes are fixtures; the offline proxy still refuses external connections.
test.use({ bypassCSP: true });

test("The attention strip fits between Work and Portfolio while Live feed fills the side", { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  const old = structuredClone(DEFAULT_WALL_LAYOUT);
  const [business, side] = old.rows.find(row => row.id === "body")!.widgets;
  if (!business || !side || !isWallColumn(business) || !isWallColumn(side)) throw new Error("Missing standard columns");
  side.rows.splice(1, 0, business.rows.splice(1, 1)[0]!);
  old.tileTransparency = 35;
  await wallScene(page, "four", { layout: old });
  await openWall(page, [1920, 1080]);
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const boxes = await page.evaluate(() => {
    const rect = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    };
    const list = document.querySelector(".wall-portfolio-list")!;
    const frame = list.getBoundingClientRect();
    return { work: rect("[data-wall-work]"), ticker: rect("[data-wall-attention-ticker]"), portfolio: rect("[data-wall-sites]"), feed: rect("[data-wall-feed]"), rows: [...list.querySelectorAll("[data-site-row]")].map(row => { const r = row.getBoundingClientRect(); return { visible: r.top >= frame.top - 1 && r.bottom <= frame.bottom + 1, tileHeight: row.querySelector(".wall-metric")!.getBoundingClientRect().height }; }) };
  });
  expect(boxes.work.bottom).toBeLessThanOrEqual(boxes.ticker.top);
  expect(boxes.ticker.bottom).toBeLessThanOrEqual(boxes.portfolio.top);
  expect(boxes.ticker.height).toBe(40);
  expect(boxes.feed.height).toBeGreaterThan(500);
  expect(boxes.rows).toHaveLength(4);
  for (const row of boxes.rows) { expect(row.visible).toBe(true); expect(row.tileHeight).toBeCloseTo(132, 0); }
  const fit = await page.evaluate(measureWallFit);
  if ("error" in fit) throw new Error(fit.error);
  expect(fit.ink).toEqual([]);
  expect(fit.clipped).toEqual([]);
  expect(fit.counts.overY).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("attention-wall-1080.png") });
});

test("The crawl includes hidden-asset problems and urgent tasks, pauses, and supports reduced motion", { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page, request }, testInfo) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await wallScene(page, "four");
  const payload = wallFixturePayload("four");
  const hidden = payload.assets[0]!;
  payload.dashboard.sites = { [hidden.id]: { tv: false } };
  payload.attention.push({ id: 91001, asset: hidden.id, assetDisplayName: hidden.displayName, severity: "error", kind: "anomaly", message: "Hidden asset needs review", firedAt: WALL_FIXTURE_NOW, firstFiredAt: WALL_FIXTURE_NOW, occurrences: 1, ruleId: "fixture-review", metric: null, ruleInputs: {}, correlatedChanges: [] });
  payload.attentionTasks = { capturedAt: WALL_FIXTURE_NOW, measuredProjects: 1, projectCount: 1, items: Array.from({ length: 8 }, (_, index) => ({ id: `fixture-urgent-${index}`, title: `Review release decision ${index} and its verification evidence`, asset: hidden.id, priority: index === 0 ? 0 : 1, ask: index === 0 ? "choose" as const : null, updatedAt: WALL_FIXTURE_NOW })) };
  await page.route("**/api/wall", route => route.fulfill({ json: payload }));
  await openWall(page, [1920, 1080]);
  await expect(page.locator("#boot-splash")).toHaveCount(0);
  const ticker = page.locator("[data-wall-attention-ticker]");
  const original = ticker.locator('[data-attention-copy="original"]');
  await expect(page.locator(`[data-site-row="${hidden.id}"]`)).toHaveCount(0);
  await expect(original).toContainText(hidden.displayName);
  await expect(original.locator('[data-attention-item^="task:"]')).toHaveCount(8);
  await expect(original.locator('[data-attention-item="problem:alert-91001"]')).toHaveCount(1);
  await expect(ticker).toHaveAttribute("data-attention-moving", "true");
  const track = ticker.locator(".attention-ticker-track");
  const x = () => track.evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41);
  const start = await x();
  await expect.poll(async () => Math.abs(await x() - start)).toBeGreaterThan(5);
  await ticker.getByRole("button", { name: "Pause attention ticker" }).click();
  await page.mouse.move(0, 0);
  await page.locator("[data-strip-home]").focus();
  await expect(track).toHaveCSS("animation-play-state", "paused");
  await ticker.getByRole("button", { name: "Resume attention ticker" }).click();
  await page.mouse.move(0, 0);
  await page.locator("[data-strip-home]").focus();
  await expect(track).toHaveCSS("animation-play-state", "running");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(track).toHaveCSS("animation-name", "none");
  await expect(ticker.locator('[data-attention-copy="duplicate"]')).toBeHidden();
  const viewport = ticker.locator("[data-wall-crawl-viewport]");
  await expect(viewport).toHaveCSS("overflow-x", "auto");
  expect(await viewport.evaluate(element => { element.scrollLeft = element.scrollWidth; return element.scrollLeft; })).toBeGreaterThan(0);
  await expect(original.locator('[data-attention-item="task:fixture-urgent-7"]')).toBeVisible();
  await ticker.screenshot({ path: testInfo.outputPath("attention-ticker-reduced-motion.png") });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await viewport.evaluate(element => { element.scrollLeft = 0; });
  await track.evaluate(element => {
    const animation = element.getAnimations()[0]!;
    animation.pause();
    animation.currentTime = (element.querySelector("ul")!.offsetWidth - 40) / 36 * 1000;
  });
  const duplicateLink = ticker.locator('[data-attention-copy="duplicate"] a').first();
  const destination = await duplicateLink.getAttribute("href");
  await ticker.evaluate(element => element.addEventListener("click", event => {
    const link = (event.target as Element).closest("a");
    if (link) { event.preventDefault(); element.setAttribute("data-clicked-href", link.getAttribute("href")!); }
  }));
  await duplicateLink.click();
  await expect(ticker).toHaveAttribute("data-clicked-href", destination!);
});
