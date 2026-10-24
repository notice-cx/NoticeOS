import { test, expect } from "../journey-test";
import { DESKTOP_ONLY, PR_SMOKE } from "../fixtures";
import { persistedMetricScene } from "../wall-metric-editor/scene";
import { installOfflineGuard, startOfflineProxy } from "../offline-guard.mjs";

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
    await editor.locator('[data-wall-preview] [data-wall-metric-select="today"]').first().click();
    await editor.locator('[data-wall-metric-panel="sites"]').getByLabel("Title").fill("Live layout update");
    const bar = editor.locator("[data-wall-save-bar]");
    await bar.getByRole("button", { name: "Save", exact: true }).click();
    await expect(bar.locator('[data-save-state="saved"] [data-status-for="wall:layout"]')).toHaveText("On the TV");

    // The fixture pushes every three seconds; the Wall's fallback poll is sixty.
    await expect(tv.locator('[data-wall-metric="today"] h3')).toContainText(["Live layout update", "Live layout update", "Live layout update", "Live layout update"], { timeout: 12_000 });
    expect(navigations).toBe(0);
    expect(streams).toBeGreaterThan(0);
    await expect(tv).toHaveURL(/\/wall$/);
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
