import { test, expect } from "../journey-test";
import { DESKTOP_ONLY, PR_SMOKE } from "../fixtures";
import { openWall, wallAt, wallScene } from "../wall-scene";

test.use({
  deviceScaleFactor: 2,
  launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});

test("the TV has no scrollbar gutters and additional rows remain reachable", { tag: [DESKTOP_ONLY, PR_SMOKE] }, async ({ page, request }) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await wallScene(page, "six");
  await openWall(page, [1920, 1080]);
  const list = page.locator(".wall-portfolio-list");
  // Reserve native gutters even on systems that default to overlay scrollbars.
  await page.addStyleTag({ content: ".wall-portfolio-list::-webkit-scrollbar { width: 16px; height: 16px; }" });
  const dimensions = () => list.evaluate((element: HTMLDivElement) => ({
    verticalOverflow: element.scrollHeight - element.clientHeight,
    horizontalOverflow: element.scrollWidth - element.clientWidth,
    scrollbarGutter: element.offsetWidth - element.clientWidth,
  }));
  const tv = await dimensions();
  expect(tv.verticalOverflow).toBeGreaterThan(0);
  expect(tv.horizontalOverflow).toBe(0);
  expect(tv.scrollbarGutter).toBe(0);
  await expect(list).toHaveCSS("scrollbar-width", "none");
  await list.hover();
  await page.mouse.wheel(0, tv.verticalOverflow + 100);
  await expect(page.locator("[data-site-row]").last()).toBeInViewport({ ratio: 0.99 });

  await wallAt(page, [1799, 1000]);
  const desktop = await dimensions();
  expect(desktop.verticalOverflow).toBeGreaterThan(0);
  expect(desktop.scrollbarGutter).toBeGreaterThan(0);
  expect(desktop.horizontalOverflow).toBe(0);
});
