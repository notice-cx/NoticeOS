import type { Locator, Page, TestInfo } from "@playwright/test";
import { BUILT_APP, test, expect } from "./journey-test";
import { everyTabPayload, viewOf } from "../test/asset-detail-fixture";
import { isAssetDetailView } from "../shared/asset-detail-views";
import { shiftLabel } from "../shared/surface";
import { fetchToRewrite } from "./rewritten-read.mjs";

const PAUSED = "Config store unreachable";
const STATEMENTS = "[data-saves-paused], [data-ga4-config-read-only], [data-collection-read-only], [data-knob-read-only], [data-funnel-editor-read-only]";

async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  if (name.includes("light")) await expect(page.locator("html")).toHaveClass(/light/);
  else await expect(page.locator("html")).not.toHaveClass(/light/);
  await info.attach(name, { path, contentType: "image/png" });
  if (name.startsWith("sources-paused")) {
    const full = info.outputPath(`${name}-full.png`);
    await page.screenshot({ path: full, fullPage: true });
    await info.attach(`${name} full page`, { path: full, contentType: "image/png" });
  }
}

async function theme(page: Page, mode: "light" | "dark") {
  await page.emulateMedia({ colorScheme: mode });
  await page.addInitScript((value) => localStorage.setItem("noticeos:theme", value), mode);
}

async function fits(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

async function bannerGeometry(banner: Locator) {
  await expect(banner).toBeVisible();
  const proof = await banner.evaluate((element) => {
    const mark = element.querySelector('[role="img"]')!.getBoundingClientRect();
    const lead = element.querySelector(".font-semibold")!;
    const range = document.createRange();
    range.selectNodeContents(lead);
    const firstLine = range.getClientRects()[0]!;
    const content = lead.parentElement!;
    const lines: DOMRect[] = [];
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const line = document.createRange();
      line.selectNodeContents(walker.currentNode);
      lines.push(...line.getClientRects());
    }
    const bounds = element.getBoundingClientRect();
    return {
      mark: { left: mark.left, right: mark.right, top: mark.top, bottom: mark.bottom },
      firstLine: { left: firstLine.left, right: firstLine.right, top: firstLine.top, bottom: firstLine.bottom },
      centerDifference: Math.abs((mark.top + mark.bottom - firstLine.top - firstLine.bottom) / 2),
      lines: lines.map((box) => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom })),
      bounds: { left: bounds.left, right: bounds.right },
    };
  });
  expect(proof.centerDifference).toBeLessThanOrEqual(2);
  expect(proof.mark.right).toBeLessThan(proof.firstLine.left);
  for (const line of proof.lines) {
    expect(line.left).toBeGreaterThanOrEqual(proof.firstLine.left - 1);
    expect(line.right).toBeLessThanOrEqual(proof.bounds.right + 1);
  }
  return proof;
}

async function syntheticSite(page: Page) {
  const body = everyTabPayload();
  const base = body.integrations.lanes[0]!;
  body.integrations.lanes = [
    { ...base, catalog: { ...base.catalog, id: "ga4", label: "Google Analytics 4" }, cell: { ...base.cell, laneId: "ga4" } },
    { ...base, catalog: { ...base.catalog, id: "posthog", label: "PostHog" }, cell: { ...base.cell, laneId: "posthog" },
      mappingLists: [{ name: "funnels", value: [{ id: "signup", name: "Signup", steps: [{ event: "visit" }, { event: "sign_up" }] }] }] },
    { ...base, catalog: { ...base.catalog, id: "bing-webmaster", label: "Bing Webmaster Tools" }, cell: { ...base.cell, laneId: "bing-webmaster" } },
  ];
  body.ga4Config = { valueEvents: ["sign_up"], eventParams: ["message"] };
  body.flags.open = body.flags.open.slice(0, 1).map((flag) => ({ ...flag, ruleId: "flow-poisson-low", metric: "signups" }));
  // The change and the watch start on the same calendar day in the CURRENT chart.
  body.performance.activeUsers.series = Array.from({ length: 28 }, (_, index) => ({ t: shiftLabel("2026-07-05", index - 27), v: 80 + index }));
  body.annotations.items = [{ id: 41, at: "2026-07-02T09:00:00.000Z", kind: "deploy", ref: null, note: "Title update" }];
  body.watches.open = [{ id: "watch-1", metricIntegration: "ga4", metric: "active_users", scope: null, refKind: "annotation", ref: "41",
    registeredAt: "2026-07-02T09:00:00.000Z", nextCheckDate: "2026-07-10", readings: 0, checks: 3, status: "open",
    outcome: null, outcomeNote: null, closedAt: null, note: "Title update" }];
  await page.clock.install({ time: new Date("2026-07-06T12:00:00.000Z") });
  await page.route("**/api/assets/meadow.example?*", async (route) => {
    const view = new URL(route.request().url()).searchParams.get("view");
    await route.fulfill({ json: isAssetDetailView(view) ? viewOf(body, view) : body });
  });
  return body;
}

test.beforeEach(async ({ request, page }, info) => {
  expect((await request.post("/__journey/reset")).ok()).toBe(true);
  await page.setViewportSize({ width: info.project.name === "mobile" ? 390 : 1440, height: info.project.name === "mobile" ? 844 : 900 });
});

for (const mode of ["dark", "light"] as const) {
  test(`setup polish: status marks stay beside their lead in ${mode}`, async ({ page }, info) => {
    await theme(page, mode);
    await syntheticSite(page);
    await page.route("**/api/integrations/providers", async (route) => {
      const { response, headers } = await fetchToRewrite(route);
      const body = await response.json();
      await route.fulfill({ response, headers, json: { ...body, keyPresent: false, blockers: ["key-missing"] } });
    });
    await page.goto("/integrations");
    const blocker = page.locator("[data-connect-blocked] [role=status]");
    const integrations = await bannerGeometry(blocker);
    await capture(page, info, `integrations-${mode}`);
    await page.goto("/assets/meadow.example/sources");
    await page.locator('[data-source-connect="bing-webmaster"]').click();
    const panel = page.locator('[data-connect-panel="bing-webmaster"]');
    await expect(panel).toBeVisible();
    const connect = await bannerGeometry(panel.locator("[data-connect-blocked] [role=status]"));
    await capture(page, info, `site-connect-${mode}`);
    await fits(page);
    await info.attach("banner geometry", { body: JSON.stringify({ integrations, connect }, null, 2), contentType: "application/json" });
  });

  test(`setup polish: the gallery's status banners keep their mark beside their lead in ${mode}`, async ({ page }, info) => {
    test.skip(BUILT_APP, "/dev/kitchen-sink is a dev-server page; a built app has none");
    await theme(page, mode);
    await syntheticSite(page);
    // Ring + link, warning + button, neutral dot without action, and closed.
    await page.goto("/dev/kitchen-sink");
    const gallery = page.getByRole("heading", { name: "StatusBanner — only while its state is open", exact: true }).locator("..");
    const variants = gallery.locator("[role=status]");
    await expect(variants).toHaveCount(3);
    const others = [];
    for (const banner of await variants.all()) others.push(await bannerGeometry(banner));
    const variantsPath = info.outputPath(`status-variants-${mode}.png`);
    await gallery.screenshot({ path: variantsPath });
    await info.attach(`status variants ${mode}`, { path: variantsPath, contentType: "image/png" });
    await info.attach("banner geometry", { body: JSON.stringify({ others }, null, 2), contentType: "application/json" });
  });

  test(`setup polish: paused Sources and Tune state their reason once in ${mode}`, async ({ page }, info) => {
    await theme(page, mode);
    const scene = await syntheticSite(page);
    const settled = scene.flags.history[0]!;
    scene.flags.history = Array.from({ length: 6 }, (_, index) => ({ ...settled, id: settled.id + 100 + index }));
    await page.route("**/api/settings", async (route) => {
      const { response, headers } = await fetchToRewrite(route);
      const body = await response.json();
      body.alertRules.knobs = [
        { key: "alpha", label: "Anomaly sensitivity", raw: 0.01, pointer: "/flag_defaults/alpha" },
        { key: "max_window_days", label: "Longest window", raw: 14, pointer: "/flag_defaults/max_window_days" },
      ].map((knob) => ({ ...knob, jargon: knob.key, value: String(knob.raw), owner: "config/constants.json", explain: "" }));
      await route.fulfill({ response, headers, json: body });
    });
    await page.route("**/api/config", (route) => route.fulfill({ json: { writable: false, reason: PAUSED, sources: {} } }));
    await page.goto("/assets/meadow.example/sources");
    await expect(page.locator("[data-saves-paused]")).toContainText(PAUSED);
    for (const label of ["Google Analytics", "PostHog"]) await page.getByRole("button", { name: label, exact: true }).click();
    for (const summary of await page.locator("#integrations details:not([open]) > summary").all()) await summary.click();
    await expect(page.locator("[data-collection-editor]")).toHaveCount(3);
    await expect(page.locator("[data-funnel-editor]")).toContainText("Signup");
    await expect(page.locator(STATEMENTS)).toHaveCount(1);
    await fits(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator("[data-saves-paused]")).toBeInViewport({ ratio: 1 });
    await capture(page, info, `sources-paused-${mode}`);
    await page.goto("/assets/meadow.example/alerts");
    const row = page.locator('[data-material-condition~="open-flags"]').first();
    await expect(row).toBeVisible();
    // Expand through the alert's existing disclosure before opening Tune.
    const collapsed = row.locator('button[aria-expanded="false"]').first();
    if (await collapsed.count()) await collapsed.click();
    // Open settled history to leave room to scroll the trigger above its panel.
    await page.getByRole("region", { name: "History", exact: true }).getByRole("button", { name: "Show 6 more", exact: true }).click();
    const trigger = page.getByRole("button", { name: "Tune rule", exact: true }).first();
    await trigger.evaluate((element) => window.scrollBy(0, element.getBoundingClientRect().top - 120));
    await trigger.click();
    const tune = page.getByRole("dialog", { name: /^Tune rule/ });
    await expect(tune.locator(STATEMENTS)).toHaveCount(1);
    await expect(tune.locator("[data-saves-paused]")).toContainText(PAUSED);
    await expect(tune).toBeInViewport({ ratio: 1 });
    await expect(tune.locator("[data-saves-paused]")).toBeInViewport({ ratio: 1 });
    await expect(tune.locator("input")).toHaveCount(2);
    for (const input of await tune.locator("input").all()) await expect(input).toBeDisabled();
    await fits(page);
    await capture(page, info, `tune-paused-${mode}`);
  });

  test(`setup polish: current chart keeps coincident watch text uncovered in ${mode}`, async ({ page }, info) => {
    await theme(page, mode);
    const body = await syntheticSite(page);
    expect(body.annotations.items[0]!.at).toBe(body.watches.open[0]!.registeredAt);
    await page.goto("/assets/meadow.example");
    const people = page.locator('[data-measure="people"]');
    await people.click();
    const chart = page.locator('[data-overview-chart="people"]');
    await expect(chart).toBeVisible();
    const label = chart.locator('[data-overview-lane="watch"] [data-fit-label]');
    await expect(label).toContainText("Watching Title update · verdict Jul 10");
    await chart.scrollIntoViewIfNeeded();
    const proof = await label.evaluate((element) => {
      const text = element.lastElementChild!;
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      let first: Text | null = null;
      while (walker.nextNode()) if (walker.currentNode.textContent?.startsWith("Watching")) { first = walker.currentNode as Text; break; }
      if (!first) throw new Error("Watch text is absent");
      const range = document.createRange();
      range.setStart(first, 0); range.setEnd(first, 1);
      const character = range.getBoundingClientRect();
      const label = text.getBoundingClientRect();
      const clip = element.getBoundingClientRect();
      const chart = element.closest("[data-overview-chart]")!;
      const marks = [...chart.querySelectorAll("[data-chart-events] > *, [data-overview-change-label]")].map((mark) => {
        const rect = mark.getBoundingClientRect();
        return { tag: mark.tagName, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      const rect = (box: DOMRect) => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height });
      const hit = document.elementFromPoint(character.left + character.width / 2, character.top + character.height / 2);
      return { first: rect(character), label: rect(label), clip: rect(clip), marks, hit: !!hit && element.contains(hit),
        color: getComputedStyle(text).color, background: getComputedStyle(chart).backgroundColor };
    });
    expect(proof.first.width).toBeGreaterThan(0);
    expect(proof.hit, "the W must be the visible hit target").toBe(true);
    expect(proof.label.left).toBeGreaterThanOrEqual(proof.clip.left - 1);
    expect(proof.label.right).toBeLessThanOrEqual(proof.clip.right + 1);
    expect(proof.label.top).toBeGreaterThanOrEqual(proof.clip.top - 1);
    expect(proof.label.bottom).toBeLessThanOrEqual(proof.clip.bottom + 1);
    for (const mark of proof.marks) {
      expect(mark.bottom <= proof.label.top || mark.top >= proof.label.bottom || mark.right <= proof.label.left || mark.left >= proof.label.right,
        "change glyph, label, and full line hit targets must not cover any watch text").toBe(true);
    }
    await info.attach("watch bounding boxes", { body: JSON.stringify(proof, null, 2), contentType: "application/json" });
    await capture(page, info, `coincident-watch-${mode}`);
    await fits(page);
  });
}
