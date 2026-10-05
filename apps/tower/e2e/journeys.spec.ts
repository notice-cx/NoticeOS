import { formatSeriesDate } from "../src/lib/format";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./journey-test";
import { JOURNEY_ASSET, JOURNEY_CORE_PROJECT, JOURNEY_KEY, JOURNEY_SITE, JOURNEY_TIME_ZONE } from "./fixtures";
import { measureWallFit, wallFitVerdict } from "../../../scripts/wall-fit-measure.mjs";
import { wallLayoutWidgets, type WallConfig } from "../../../scripts/wall-layout.mjs";
import { WALL_FEED_TV_ROWS, type WallFeedPayload } from "@shared/wall-feed";
import {
  WALL_FIXTURE_NOW, WALL_FIXTURE_TIME_ZONE, WALL_FIXTURE_VARIANTS, wallFixtureCalendar, wallFixtureHealth, wallFixturePayload,
  wallFixtureProviders, wallFixtureRealtime,
  type WallFixtureVariant,
} from "./wall-fixture";
import { WALL_FEED_OS } from "./wall-feed-fixture";
import { installGoogleConsent } from "./google-consent.mjs";
import { buildWorkflowHistory } from "../vite/workflow-history";
import { captureWorkflowOutput } from "../../../scripts/workflow-output.mjs";
import type { WorkflowRun, WorkflowsPayload } from "@shared/workflows";
import { READ_ONLY_DEPLOYMENT } from "@shared/tasks";
import { emptyWorkHistory } from "@shared/work";

test.beforeEach(async ({ request, baseURL }) => {
  // No real network, profile, credentials, task hub or pre-existing browser.
  // The one origin allowed is this worker's own fixture server, and no
  // redirect leaves it: journey-test.ts installs the offline guard on every
  // test's context (beads ro-ujb9.167, ro-o3hv).
  if (!baseURL) throw new Error("This worker has no fixture server");
  const reset = await request.post("/__journey/reset");
  // A refused reset says why (bead ro-ujb9.76.56).
  expect(reset.ok(), `POST /__journey/reset answered ${reset.status()}: ${reset.ok() ? "" : await reset.text()}`).toBeTruthy();
  expect((await (await request.get("/__journey/status")).json()).isolated).toBe(true);
});

/** Focus must reach the target through actual Tab traversal, not locator.focus
 * or script focus. This catches keyboard-inaccessible controls in both layouts. */
async function keyboardFocus(page: Page, target: Locator, direction: "Tab" | "Shift+Tab" = "Tab") {
  await expect(target).toBeVisible();
  const focusTrace: string[] = [];
  for (let count = 0; count < 160; count += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press(direction);
    focusTrace.push(await page.evaluate(() => {
      const element = document.activeElement;
      return `${element?.tagName}: ${element?.getAttribute("aria-label") ?? element?.textContent?.trim().slice(0, 80)}`;
    }));
  }
  throw new Error(`Keyboard never reached ${await target.textContent()}; focus path: ${focusTrace.join(" → ")}`);
}

/** Bead ro-ujb9.87: while a toast is up, Tab from the page's last control
 * enters the toast once and then leaves the page. It never hands focus back to
 * that control, which made Tab alternate between the two for as long as the
 * toast stayed. The pointer rests on the toast first, as a reader's would, so
 * its own timer waits; every focus move is a real key press. Then the toast is
 * left to close while focus is on it, and focus returns to that last control
 * rather than being dropped. */
async function tabPastToast(page: Page, toast: Locator) {
  await toast.hover();
  await keyboardFocus(page, toast);
  const describe = () => page.evaluate(() => {
    const element = document.activeElement;
    return { inToaster: Boolean(element?.closest("[data-sonner-toaster]")),
      label: `${element?.tagName}: ${element?.getAttribute("aria-label") ?? element?.textContent?.trim().slice(0, 80)}` };
  });
  // The control before the toast is the page's last one.
  await page.keyboard.press("Shift+Tab");
  const last = await describe();
  expect(last.inToaster).toBe(false);
  await page.keyboard.press("Tab");
  await expect(toast).toBeFocused();
  await page.keyboard.press("Tab");
  const after = await describe();
  expect(after.inToaster, `Tab stayed in the toaster: ${after.label}`).toBe(false);
  expect(after.label, "Tab from the toast returned to the page's last control").not.toBe(last.label);

  // Back onto the toast from the page's last control, then let it close.
  await page.keyboard.press("Shift+Tab");
  await expect(toast).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect((await describe()).label).toBe(last.label);
  await page.keyboard.press("Tab");
  await expect(toast).toBeFocused();
  await page.mouse.move(0, 0);
  await expect(toast).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => (await describe()).label, { message: "focus returns to where it came from when the toast it is on closes" }).toBe(last.label);
}

async function keyboardActivate(page: Page, target: Locator, direction: "Tab" | "Shift+Tab" = "Tab") {
  await keyboardFocus(page, target, direction);
  await page.keyboard.press("Enter");
}

async function assertNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
}

async function assertContained(locator: Locator) {
  const bounds = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const parent = element.parentElement!.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      parentLeft: parent.left, parentRight: parent.right, parentTop: parent.top, parentBottom: parent.bottom };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(bounds.parentLeft - 1);
  expect(bounds.right).toBeLessThanOrEqual(bounds.parentRight + 1);
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.parentTop - 1);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.parentBottom + 1);
}

test("state reasons open from keyboard and tap", async ({ page }, testInfo) => {
  const wall = wallFixturePayload();
  wall.assets = wall.assets.slice(0, 1).map(asset => ({ ...asset, work: null,
    activeUsers: { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] } }));
  const asset = wall.assets[0]!;
  await page.route("**/api/wall", route => route.fulfill({ json: wall }));
  await page.route("**/api/tasks/capabilities", route => route.fulfill({ json: { live: false, writable: false, reason: READ_ONLY_DEPLOYMENT } }));
  await page.route("**/api/work", route => route.fulfill({ json: {
    generatedAt: wall.generatedAt, capturedAt: wall.generatedAt, pollCadenceHours: 1 / 60,
    owner: "config/beads.json", historyDays: 0,
    projects: [{ asset: asset.id, prefix: "ex", name: asset.displayName, ok: true, error: null,
      counts: { open: 0, highPriority: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: 0, deferred: 0, waiting: 0 },
      priorities: null, epics: null, deferred: [], waiting: [], ready: [], inProgress: [], recentlyClosed: [], history: emptyWorkHistory() }],
  } }));
  for (const [route, name, evidence] of [
    ["/assets", "No task data", "No task data"],
    ["/", "About System", "fresh"],
    ["/tasks", "Why New task is unavailable", "Make changes from the local NoticeOS."],
  ]) {
    await page.goto(route!);
    const target = page.getByRole("button", { name, exact: true });
    await keyboardFocus(page, target);
    await expect(page.getByRole("tooltip")).toContainText(evidence!);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    // A phone's real tap and a desk pointer both pin the same existing panel.
    if (testInfo.project.name === "mobile") await target.tap();
    else await target.click();
    await expect(page.getByRole("tooltip")).toContainText(evidence!);
    await assertNoPageOverflow(page);
    const panel = await page.getByRole("tooltip").boundingBox();
    const viewport = page.viewportSize()!;
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.y).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(viewport.width);
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: testInfo.outputPath(`state-reason-${route!.slice(1) || "home"}.png`) });
    await expect(page).toHaveURL(new RegExp(`${route === "/" ? "/" : route}$`));
  }
  await page.goto("/assets");
  const sources = page.getByRole("button", { name: "About data source states", exact: true });
  await keyboardFocus(page, sources);
  await expect(page.getByRole("tooltip")).toContainText("Nightly report");
  await page.keyboard.press("Escape");
  if (testInfo.project.name === "mobile") await sources.tap();
  else await sources.click();
  await expect(page.getByRole("tooltip")).toContainText("Nightly report");
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath("state-reason-sources.png") });
  await expect(page).toHaveURL(/\/assets$/);
});

test("desk pages share the same content edges", async ({ page }, testInfo) => {
  await createAsset(page);
  const widths = testInfo.project.name === "mobile" ? [390] : [1440, 1920];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const frames: { route: string; left: number; width: number; titleLeft: number }[] = [];
    for (const route of ["/", "/assets", "/financials", "/integrations", "/settings"]) {
      await page.goto(route);
      const header = page.locator("main [data-page-header]");
      await expect(header).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      frames.push(await header.evaluate((element, route) => {
        const box = element.getBoundingClientRect();
        const title = element.querySelector("h1")!.getBoundingClientRect();
        return { route, left: box.left, width: box.width, titleLeft: title.left };
      }, route));
      await assertNoPageOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`desk-edges-${route.slice(1) || "home"}-${width}.png`) });
    }
    const expected = frames[0]!;
    for (const frame of frames) {
      expect(frame.left, `${frame.route} header left at ${width}`).toBeCloseTo(expected.left, 0);
      expect(frame.width, `${frame.route} header width at ${width}`).toBeCloseTo(expected.width, 0);
      expect(frame.titleLeft, `${frame.route} title left at ${width}`).toBeCloseTo(expected.titleLeft, 0);
    }
  }
});

for (const theme of ["dark", "light"] as const) {
  test(`workflow output metrics stay inside the page in ${theme} mode`, async ({ page }, testInfo) => {
    await page.addInitScript(color => localStorage.setItem("noticeos:theme", color), theme);
    const startedAt = "2026-09-06T11:40:00.000Z";
    const finishedAt = "2026-09-06T11:40:01.000Z";
    const trace: WorkflowRun = {
      id: `push-state@${startedAt}`, workflowId: "push-state", definitionVersion: 1,
      startedAt, finishedAt, state: "failed", steps: [
        { id: "execute", attempt: 1, startedAt, finishedAt, state: "failed",
          summary: "One site could not be checked.",
          output: captureWorkflowOutput({ failed: 1, checked: 3, filed: 1, closed: 0 }) },
        { id: "record", attempt: 1, startedAt: finishedAt, finishedAt, state: "succeeded" },
      ],
    };
    const payload: WorkflowsPayload = {
      overrides: null, runtime: null, runtimeFresh: false, observationsFresh: false,
      generatedAt: "2026-09-06T12:00:00.000Z", historyAvailable: true,
      ...buildWorkflowHistory([{ job: "push-state", at: startedAt, ms: 1000, outcome: "failed" }], [trace], [], Date.parse("2026-09-06T12:00:00.000Z"), trace.id),
    };
    await page.route("**/api/workflows*", route => route.fulfill({ json: payload }));
    await page.goto(`/workflows/push-state?run=${encodeURIComponent(trace.id)}`);
    if (theme === "light") await expect(page.locator("html")).toHaveClass(/light/);
    else await expect(page.locator("html")).not.toHaveClass(/light/);
    const output = page.getByRole("region", { name: "Step output", exact: true });
    const strip = output.locator("[data-kpi-strip]");
    await expect(strip.locator("[data-kpi]")).toHaveCount(4);
    await page.evaluate(() => document.fonts.ready);
    await output.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`workflow-output-${theme}.png`), fullPage: true });
    await assertNoPageOverflow(page);
    await assertContained(strip);
    if (testInfo.project.name === "mobile") {
      const before = await strip.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
      expect(before.scroll).toBeGreaterThan(before.width);
      await strip.evaluate(element => { element.scrollLeft = element.scrollWidth; });
      const last = strip.locator("[data-kpi]").last();
      await expect.poll(async () => last.evaluate(element => {
        const box = element.getBoundingClientRect();
        const row = element.parentElement!.getBoundingClientRect();
        return box.left >= row.left - 1 && box.right <= row.right + 1;
      })).toBe(true);
      await assertNoPageOverflow(page);
    }
  });
}

/** The one status on an Integrations catalog row, as the connection model
 * names it (bead ro-ujb9.96.7.3): `working`, `collecting`, `failing`… */
function tileHealth(tile: Locator) {
  return tile.locator("[data-connection]");
}

/** One site's status on its provider's own page, and the site row itself. */
function siteRow(page: Page, provider: string, site: string) {
  return page.locator(`[data-provider-sites="${provider}"] [data-site="${site}"]`);
}

test("KPI trends remain inside their cells on desk, tablet and phone", async ({ page }, testInfo) => {
  await createAsset(page);
  expect((await page.request.post("/__journey/revenue-history")).ok()).toBe(true);
  const viewports = testInfo.project.name === "mobile"
    ? [{ width: 390, height: 844 }]
    : [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const route of ["/", `/assets/${JOURNEY_ASSET}`, "/financials?period=2026-09"]) {
      await page.goto(route);
      const sparks = page.locator("[data-kpi] [data-spark]");
      await expect(sparks.first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      for (const spark of await sparks.all()) {
        const bounds = await spark.evaluate(element => {
          const line = element.getBoundingClientRect();
          const cell = element.closest("[data-kpi]")!.getBoundingClientRect();
          return { left: line.left - cell.left, right: cell.right - line.right,
            top: line.top - cell.top, bottom: cell.bottom - line.bottom };
        });
        for (const distance of Object.values(bounds)) expect(distance).toBeGreaterThanOrEqual(-1);
      }
      await assertNoPageOverflow(page);
    }
  }
});

/** A site added the way the operator adds one (bead ro-ujb9.96.7.5): Home's
 * first-run Add a site opens one question over Home, the domain; the name is
 * read off it; Enter adds; the new asset opens on its Data sources. */
async function createAsset(page: Page, failSetup = false) {
  await page.goto("/");
  await expect(page.locator("[data-first-run]")).toBeVisible();
  await assertNoPageOverflow(page);
  for (const step of await page.locator("[data-first-run-step]").all()) await assertContained(step);
  await keyboardActivate(page, page.getByRole("button", { name: "Add your first site", exact: true }));
  const sheet = page.getByRole("dialog", { name: "Add a site" });
  await expect(sheet).toBeVisible();
  // A question asked over Home, not a page of its own.
  await expect(page).toHaveURL(/\/$/);
  const domain = sheet.getByLabel("Domain", { exact: true });
  await expect(domain).toBeFocused();
  await domain.fill(JOURNEY_ASSET);
  await expect(sheet.locator("[data-add-site-name]")).toHaveText("Journey Example");
  await assertNoPageOverflow(page);
  if (failSetup) expect((await page.request.post("/__journey/fail-next-save")).ok()).toBe(true);
  await page.keyboard.press("Enter");
  if (failSetup) {
    await expect(sheet.getByText("Setup not saved", { exact: true })).toBeVisible();
    const state = await (await page.request.get("/__journey/status")).json();
    expect(state.assets).toHaveLength(1);
    expect(state.documents["config/integrations.json"].assets[JOURNEY_ASSET]).toBeUndefined();
    await keyboardActivate(page, sheet.getByRole("button", { name: "Retry setup", exact: true }));
  }
  await expect(page).toHaveURL(new RegExp(`/assets/${JOURNEY_ASSET.replace(".", "\\.")}/sources$`));
  await expect(page.getByRole("heading", { name: /^Journey Example/, level: 1 })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Add a site" })).toHaveCount(0);
  const state = await (await page.request.get("/__journey/status")).json();
  expect(state.assets).toHaveLength(1);
  expect(state.requests.filter((row: { method: string; path: string }) => row.method === "POST" && row.path === "/api/assets")).toHaveLength(1);
}

test('site order moves in the Wall editor, persists across every list, and supports guarded Undo', async ({ page, request }, testInfo) => {
  expect((await request.post('/__journey/wall-feed')).ok()).toBe(true);
  const wall = await (await request.get('/api/wall')).json();
  const initial: string[] = wall.assets.map((asset: { id: string }) => asset.id);
  const first = wall.assets[0] as { id: string; displayName: string };
  const second = wall.assets[1] as { id: string; displayName: string };
  const reordered = [second.id, first.id, ...initial.slice(2)];
  const ids = (selector: string, attribute: string) => page.locator(selector).evaluateAll((rows, name) => rows.map(row => row.getAttribute(name)), attribute);
  await page.goto('/wall/edit');
  await expect.poll(() => ids('[data-site-order]', 'data-site-order')).toEqual(initial);
  await page.getByRole('button', { name: `Move ${first.displayName} down`, exact: true }).click();
  await expect.poll(() => ids('[data-site-order]', 'data-site-order')).toEqual(reordered);
  await page.locator('[data-sonner-toast]').filter({ hasText: 'Site order saved' }).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => ids('[data-site-order]', 'data-site-order')).toEqual(initial);
  await page.getByRole('button', { name: `Move ${first.displayName} down`, exact: true }).click();
  await expect.poll(() => ids('[data-site-order]', 'data-site-order')).toEqual(reordered);
  await page.reload();
  await expect.poll(() => ids('[data-site-order]', 'data-site-order')).toEqual(reordered);
  await testInfo.attach('site ordering', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  for (const route of ['/', '/assets']) {
    await page.goto(route); await page.reload();
    await expect.poll(() => ids('main [data-asset-row]', 'data-asset-row')).toEqual(reordered);
  }
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await menu.isVisible()) await menu.click();
  const expand = page.getByRole('button', { name: 'Expand the site list', exact: true });
  if (await expand.isVisible()) await expand.click();
  await expect.poll(() => ids('[data-nav-asset]:visible', 'data-nav-asset')).toEqual(reordered);
  await page.goto('/wall'); await page.reload();
  await expect.poll(() => ids('[data-wall-sites] [data-site-row]', 'data-site-row')).toEqual(reordered);
  // A second operator changes the saved order before this operator presses Undo.
  await page.goto('/wall/edit');
  await page.getByRole('button', { name: `Move ${first.displayName} up`, exact: true }).click();
  await expect.poll(() => ids('[data-site-order]', 'data-site-order')).toEqual(initial);
  const changed = await request.patch(`/api/assets/${initial[2]}/order`, { data: { to: initial[0] } });
  expect(changed.ok()).toBe(true);
  const latest = ((await changed.json()).order as string[]).filter(id => initial.includes(id));
  await page.locator('[data-sonner-toast]').filter({ hasText: 'Site order saved' }).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('Site order changed elsewhere. Refresh before moving again.', { exact: true })).toBeVisible();
  await expect.poll(() => ids('[data-site-order]', 'data-site-order')).toEqual(latest);
  expect((await (await request.get('/api/wall')).json()).assets.map((asset: { id: string }) => asset.id)).toEqual(latest);
});

test('Mediavine signs in in the panel, its site is matched by domain and synced on Start, and it disconnects', async ({ page }, testInfo) => {
  await createAsset(page);
  await page.goto('/integrations');
  // Mediavine connects in the panel over the list (bead ro-ujb9.96.7.6): the
  // login is shown to Mediavine before it is kept.
  await page.locator('[data-integration-tile="mediavine"]').getByRole('button', { name: 'Connect Mediavine', exact: true }).click();
  const panel = page.locator('[data-connect-panel="mediavine"]');
  await panel.getByLabel('Email', { exact: true }).fill('journey@example.test');
  await panel.getByLabel('Password', { exact: true }).fill('not-the-password');
  await keyboardActivate(page, panel.getByRole('button', { name: 'Connect', exact: true }));
  // A refused login is never kept, and its password is not left on screen.
  await expect(panel.locator('[data-connect-state="refused"]')).toHaveText('Mediavine refused these details');
  await expect(panel.getByLabel('Password', { exact: true })).toHaveValue('');
  let state = await (await page.request.get('/__journey/status')).json();
  expect(state.requests.filter((row: { path: string }) => row.path === '/api/integrations/mediavine/connect')).toHaveLength(1);
  await panel.getByLabel('Password', { exact: true }).fill(JOURNEY_KEY);
  await keyboardActivate(page, panel.getByRole('button', { name: 'Connect', exact: true }));
  await expect(panel.locator('[data-connect-state="accepted"]')).toBeVisible();
  // The account's site, found once and matched to this site by its domain:
  // ticked, nothing written before Start.
  const row = panel.locator(`[data-site-row="${JOURNEY_ASSET}"]`);
  await expect(row).toHaveAttribute('data-site-state', 'matched');
  await expect(row).toHaveAttribute('data-site-checked', '');
  await expect(row.locator('[data-site-detail]')).toHaveText(JOURNEY_ASSET);
  state = await (await page.request.get('/__journey/status')).json();
  expect(state.documents['config/integrations.json'].assets[JOURNEY_ASSET]['ad-network'].mediavineSiteId).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('mediavine-panel-matched.png'), fullPage: true });
  // Start saves the site on its Data sources entry and runs the sync now.
  await keyboardActivate(page, panel.locator('[data-sites-start]'));
  await expect(row.locator('[data-connection]')).toHaveAttribute('data-connection', 'working', { timeout: 60_000 });
  state = await (await page.request.get('/__journey/status')).json();
  expect(state.documents['config/integrations.json'].assets[JOURNEY_ASSET]['ad-network'].mediavineSiteId).toBe('journey-mediavine-site');
  await page.keyboard.press('Escape');
  await page.goto(`/assets/${JOURNEY_ASSET}/sources`);
  // Ad revenue is a row of More sources, open on arrival (bead ro-ujb9.164).
  await page.getByRole('region', { name: 'More sources', exact: true }).getByRole('button', { name: /^Ad revenue/ }).click();
  await expect(page.getByRole('button', { name: /^Ad revenue/ })).toContainText('Working');
  const revenue = page.getByRole('region', { name: 'Mediavine revenue', exact: true });
  // No site picker, no Load my sites and no on/off switch are left on the row:
  // the panel picks the site, and Not using stops it.
  await expect(revenue.getByRole('button', { name: 'Load my sites' })).toHaveCount(0);
  await expect(revenue.getByRole('button', { name: /automatic sync/ })).toHaveCount(0);
  await expect(revenue).toContainText('2026-09-04');
  // Mediavine's two totals for the same days, as one labelled figure (bead
  // ro-ujb9.96.6.4) rather than a sentence.
  await expect(revenue.locator('[data-mediavine-difference]')).toContainText('off by $0.02');
  await revenue.getByLabel('Forecast holiday calendar').selectOption('US');
  await revenue.getByRole('button', { name: 'Save forecast calendar' }).click();
  await expect(revenue.getByRole('button', { name: 'Save forecast calendar' })).toBeDisabled();
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('mediavine-sources-after.png'), fullPage: true });
  await page.goto('/financials?period=2026-09');
  await expect(page.getByRole('main')).toContainText('$5.00');
  await expect(page.getByRole('main')).not.toContainText('$5.02');
  await assertNoPageOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('mediavine-financials-after.png'), fullPage: true });
  await page.goto(`/assets/${JOURNEY_ASSET}`);
  await expect(page.getByRole('main')).toContainText('$5.00');
  await page.goto('/integrations');
  // A saved connection's row shows its collection health, read by the ingest
  // from what the sync recorded (bead ro-ujb9.86): the revenue report worked.
  const tile = page.locator('[data-integration-tile="mediavine"]');
  await expect(tileHealth(tile)).toHaveAttribute('data-connection', 'working');
  // Removal is on the connection itself (bead ro-ujb9.96.7.10): Manage opens
  // it in the panel; Disconnect, then one confirmation naming the sites that
  // stop and what is deleted.
  await tile.getByRole('button', { name: 'Manage Mediavine', exact: true }).click();
  await panel.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(panel.locator('[data-disconnect-stops]')).toContainText('Journey Example');
  await expect(panel.locator('[data-disconnect-effects]')).toContainText('Login deleted · no undo');
  await panel.getByRole('button', { name: 'Disconnect Mediavine', exact: true }).click();
  await expect(tileHealth(tile)).toHaveAttribute('data-connection', 'not-connected');
  // Its toast can be tabbed past and closes without dropping focus (bead
  // ro-ujb9.87).
  await tabPastToast(page, page.locator('[data-sonner-toast]', { hasText: 'Disconnected — Mediavine' }));
  // The site keeps its mapping: connecting again lists it as already mapped,
  // not as Not using.
  state = await (await page.request.get('/__journey/status')).json();
  expect(state.documents['config/integrations.json'].assets[JOURNEY_ASSET]['ad-network']).toMatchObject({ mediavineSiteId: 'journey-mediavine-site' });
  expect(state.documents['config/integrations.json'].assets[JOURNEY_ASSET]['ad-network'].status).not.toBe('skipped');
  await page.goto('/financials?period=2026-09');
  await expect(page.getByRole('main')).toContainText('$5.00');
});

/** The fixture's money, with separate saved operator and provider clocks:
 * the zones and dates, the last day a provider report is due,
 * and every day's synthetic amount for last month and this one. */
interface SeededRevenue { timeZone: string; today: string; reportingTimeZone: string; reportingToday: string; through: string; days: { date: string; amountMinor: number }[] }

/** What the Wall's projection must say about that money, derived from it. The
 * synthetic history is exactly periodic (weekday, weekend and holiday traffic
 * at one rate), so a correct projection of a day not yet reported is that
 * day's own synthetic amount, and the month's projection is the month's sum. */
function expectedProjection(seed: SeededRevenue) {
  const month = seed.today.slice(0, 7);
  const previous = seed.days[0]!.date.slice(0, 7);
  const total = (keep: (date: string) => boolean) =>
    seed.days.filter((day) => keep(day.date)).reduce((sum, day) => sum + day.amountMinor, 0);
  const projected = total((date) => date.startsWith(month));
  const earned = total((date) => date.startsWith(month) && date <= seed.through);
  const previousMonth = total((date) => date.startsWith(previous));
  const usd = (minor: number, digits: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(minor / 100);
  const ratio = projected / previousMonth - 1;
  const change = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 }).format(Math.abs(ratio));
  const previousLabel = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(new Date(`${previous}-15T12:00:00Z`));
  return { headline: usd(projected, 0), reported: `${usd(earned, 2)} reported through ${seed.through}`, versus: `${change} ${ratio > 0 ? 'above' : ratio < 0 ? 'below' : 'level with'} ${previousLabel}` };
}

// D28 (bead ro-trai.11, docs/25-the-wall.md § Revenue): the store's
// projection is the month's pace beside the revenue figure, and the change
// against last month's total; the 30-day daily bars and the card's projection
// block left the Wall. The journey's one site is shown in depth (§ Density).
test('the Wall states the month on pace from the store\'s projection, and draws no asset card', async ({ page }, testInfo) => {
  await createAsset(page);
  const seeded = await page.request.post('/__journey/revenue-history');
  expect(seeded.ok()).toBe(true);
  const seed = (await seeded.json()) as SeededRevenue;
  // The fixture's zone, from its own config store, not the checkout's.
  expect(seed.timeZone).toBe(JOURNEY_TIME_ZONE);
  expect(seed.reportingTimeZone).toBe('America/Los_Angeles');
  expect(seed.reportingToday).toBe('2026-09-06');
  expect(seed.through).toBe('2026-09-04');
  const expected = expectedProjection(seed);
  await page.goto('/wall');
  // This site is the only one with money, so its projection is the month's pace.
  const revenue = page.locator('[data-wall-revenue]');
  await expect(revenue).toHaveAttribute('data-wall-revenue', 'pace');
  await expect(revenue.locator('[data-revenue-pace]')).toContainText(`on pace for ${expected.headline}`);
  await expect(revenue.locator('[data-revenue-change]')).toContainText(expected.versus);
  await expect(revenue.locator('[data-revenue-change] [data-tone]')).toHaveAttribute('data-tone', 'neutral');
  // At 05:00 Pacific the 06:10 reporting cutoff has not passed. Yesterday
  // stays unknown; a retained Sep4 estimate cannot masquerade as Sep5.
  const yesterday = new Date(Date.parse(`${seed.reportingToday}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  expect(seed.through).not.toBe(yesterday);
  await expect(revenue.locator('[data-revenue-yesterday="none"]')).toHaveText(`${formatSeriesDate(yesterday)} · Pacific not reported yet`);
  await expect(revenue.locator('[data-revenue-yesterday-figure]')).toHaveCount(0);
  await expect(revenue).not.toContainText(' a day');
  await expect(page.locator(`[data-wall-sites] [data-site-row="${JOURNEY_ASSET}"]`)).toBeVisible();
  // The daily bars, their legend and the asset card live on the desk now.
  await expect(page.locator('[aria-label*="daily active users from"]')).toHaveCount(0);
  await expect(page.locator('[data-property-card]')).toHaveCount(0);
  await revenue.screenshot({ path: testInfo.outputPath('revenue-projection-hero.png') });
  await page.screenshot({ path: testInfo.outputPath('revenue-projection-wall-after.png'), fullPage: true });
});

/** Every element on the page drawn in warn or error ink, fill, border or ring,
 * with what it says: what a room reads as an alarm. Runs in the page. */
function attentionTones() {
  const tone = /\b(?:text|bg|border|fill|stroke|ring|outline)-(?:warn|error)(?:\/\d+)?\b/;
  return [...document.querySelectorAll("[class]")]
    .filter((node) => tone.test(node.getAttribute("class") ?? ""))
    .map((node) => `${(node.getAttribute("class") ?? "").match(tone)?.[0]}: ${(node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || node.getAttribute("aria-label") || "(mark)"}`);
}

// A TV has no controls, so a stranger's first Wall must not be alarms for
// things nobody set up: no OS report lane, no task source, no connected source
// (bead ro-ujb9.132; D30; doc 14: warn and error mean something broke).
test("an empty installation's Wall is calm: the clock, no alarms, and a quiet line where sites will be", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "a Wall size check: the TV and a laptop");
  for (const [width, height] of [[1920, 1080], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/wall");
    await expect(page.locator("[data-wall-strip]")).toBeVisible();
    await expect(page.locator("[data-system-state]")).toHaveCount(0);
    await expect(page.locator('[data-wall-sites="none"]')).toHaveText("No sites yet");
    await expect(page.locator("[data-wall-needs]")).toContainText("Tasks unknown");
    await expect(page.locator("[data-wall-needs]")).toContainText("Nothing broken");
    expect(await page.evaluate(attentionTones), `the empty Wall at ${width}×${height}`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`wall-empty-${width}.png`) });
  }
  // One site added, nothing connected yet: still nothing broke.
  await createAsset(page);
  for (const [width, height] of [[1920, 1080], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/wall");
    await expect(page.locator(`[data-wall-sites] [data-site-row="${JOURNEY_ASSET}"]`)).toBeVisible();
    await expect(page.locator("[data-system-state]")).toHaveCount(0);
    expect(await page.evaluate(attentionTones), `the one-site Wall at ${width}×${height}`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`wall-one-site-${width}.png`) });
  }
});

/**
 * What a Wall card cuts off or squeezes, measured in the page (beads ro-n5ya,
 * ro-yo4h). `wall:fit` looks for content spilling past the TV; a card that
 * CLIPS its own text never spills, so it passed while "AUG ↑$128 VS JUL" read
 * "AUG ↑$12…" and the first site's totals label stood one word per line.
 *
 * - `clipped`: a text run an ancestor's overflow cuts off sideways. Designed
 *   truncation (`text-overflow: ellipsis`) is a choice and is not counted.
 * - `wrapped`: a label under `scope` that must stay on its one line and
 *   either broke onto a second line or overflowed its own box.
 */
function wallLegibility(scope: string) {
  const root = document.querySelector(".wall-root") ?? document.body;
  const clipped: { text: string; cut: number }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? "").trim();
    const parent = node.parentElement;
    if (!text || !parent || parent.closest("svg, script, style, .sr-only")) continue;
    // Responsive utility selectors can make a wordmark screen-reader-only
    // without adding the literal sr-only class to that element.
    let accessibleOnly = false;
    for (let el: Element | null = parent; el && el !== root; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.clip === "rect(0px, 0px, 0px, 0px)" || style.clipPath === "inset(50%)") accessibleOnly = true;
    }
    if (accessibleOnly) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width === 0) continue;
      let left = rect.left;
      let right = rect.right;
      let designedTruncation = false;
      for (let el: Element | null = parent; el && el !== root; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.textOverflow === "ellipsis") designedTruncation = true;
        if (style.overflowX === "visible") continue;
        const box = el.getBoundingClientRect();
        left = Math.max(left, box.left + parseFloat(style.borderLeftWidth || "0"));
        right = Math.min(right, box.right - parseFloat(style.borderRightWidth || "0"));
      }
      const cut = Math.max(rect.right - right, left - rect.left);
      if (cut > 1 && !designedTruncation) clipped.push({ text: text.slice(0, 40), cut: Math.round(cut) });
    }
  }
  const wrapped = [...document.querySelectorAll(scope)].flatMap((label) => {
    // A line is a run of text boxes that overlap vertically: the chart key sets
    // 16px words beside an 18px chip, whose tops differ on one line.
    const r = document.createRange();
    r.selectNodeContents(label);
    const rects = [...r.getClientRects()].filter((rect) => rect.width > 0).sort((a, b) => a.top - b.top);
    let lines = 0;
    let bottom = -Infinity;
    for (const rect of rects) {
      if (rect.top >= bottom - 1) lines += 1;
      bottom = Math.max(bottom, rect.bottom);
    }
    const overflows = label.scrollWidth - label.clientWidth > 1;
    return lines > 1 || overflows ? [{ text: (label.textContent ?? "").trim(), lines, overflows }] : [];
  });
  return { clipped, wrapped };
}

/** The header's four widgets and shared type as drawn. */
function stripGroups() {
  const strip = document.querySelector("[data-wall-strip]")!;
  const box = strip.getBoundingClientRect();
  const rect = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  };
  const groups = ["[data-strip-home]", "[data-strip-clock-group]", "[data-strip-agenda]", "[data-strip-countdown]"]
    .map((selector) => ({ selector, ...rect(strip.querySelector(selector)!) }));
  const labels = ["[data-strip-version]", "[data-strip-date]", "[data-strip-day-period]", "[data-strip-meeting-cue]", "[data-strip-countdown-unit]"]
    .flatMap((selector) => {
      const el = strip.querySelector(selector);
      if (!el) return [];
      const style = getComputedStyle(el);
      return [{ selector, size: parseFloat(style.fontSize), family: style.fontFamily }];
    });
  const marks = ["[data-strip-home] .brand-mark", "[data-strip-countdown-emoji]"]
    .map((selector) => ({ selector, ...rect(strip.querySelector(selector)!) }));
  return { height: box.height, box: rect(strip), groups, labels, marks,
    date: rect(strip.querySelector("[data-strip-date]")!),
    time: rect(strip.querySelector("[data-strip-time]")!),
    valueSize: parseFloat(getComputedStyle(strip.querySelector("[data-strip-countdown-value]")!).fontSize) };
}

/**
 * Where the Wall's five regions sit (beads ro-trai.24, ro-trai.29): each
 * region's box, the canvas's, whether the strip's meeting sits below its time
 * (the strip wrapped) and how the feed's rows fill it.
 */
function wallStack() {
  const box = (selector: string) => {
    const rect = document.querySelector(selector)!.getBoundingClientRect();
    return { top: Math.round(rect.top), left: Math.round(rect.left), right: Math.round(rect.right), bottom: Math.round(rect.bottom) };
  };
  const regions = (
    [
      ["strip", "[data-wall-strip]"],
      ["revenue", "[data-wall-revenue]"],
      ["sites", "[data-wall-sites]"],
      ["needs", "[data-wall-needs]"],
      ["feed", "[data-wall-feed]"],
    ] as const
  ).map(([name, selector]) => ({ name, ...box(selector) }));
  const strip = document.querySelector("[data-wall-strip]")!;
  const time = strip.querySelector("[data-strip-time]")!.getBoundingClientRect();
  const meeting = strip.querySelector("[data-strip-meeting]")!.getBoundingClientRect();
  const groups = [...strip.children].map((el) => el.getBoundingClientRect()).filter((rect) => rect.width > 0);
  const list = document.querySelector("[data-wall-feed] ol")!;
  // The rows drawn: in one column the feed lists the TV's rows at most and
  // hides the rest (bead ro-trai.31).
  const items = [...list.children].filter((item) => getComputedStyle(item).display !== "none");
  return {
    canvas: box("[data-wall-canvas]"),
    regions,
    strip: { wrapped: meeting.top >= time.bottom - 1, right: Math.round(Math.max(...groups.map((rect) => rect.right))) },
    feed: {
      cut: items.filter((item) => item.hasAttribute("data-feed-cut")).length,
      spare: Math.round(list.getBoundingClientRect().bottom - (items.at(-1)?.getBoundingClientRect().bottom ?? 0)),
      shown: items.length,
      fetched: list.children.length,
      newestFirst: items.every((item, i) => i === 0 || Date.parse(item.querySelector("time")!.dateTime) <= Date.parse(items[i - 1]!.querySelector("time")!.dateTime)),
    },
  };
}

/** On a portrait tablet or a phone the Wall is one column, full width, in the
 * operator's order, and its feed lists the TV's rows at most, newest first. */
function expectStackedInOrder(stack: ReturnType<typeof wallStack>, at: string) {
  expect(stack.feed.shown, `${at}: the feed lists at most the TV's rows`).toBe(Math.min(stack.feed.fetched, WALL_FEED_TV_ROWS));
  expect(stack.feed.newestFirst, `${at}: the feed newest first`).toBe(true);
  const order = [...stack.regions].sort((a, b) => a.top - b.top).map((region) => region.name);
  expect(order, `${at}: strip, revenue, sites, Needs you, feed`).toEqual(["strip", "revenue", "sites", "needs", "feed"]);
  for (const region of stack.regions) {
    expect(Math.abs(region.left - stack.canvas.left), `${at}: ${region.name} starts at the column's edge`).toBeLessThanOrEqual(1);
    expect(Math.abs(region.right - stack.canvas.right), `${at}: ${region.name} spans the column`).toBeLessThanOrEqual(1);
  }
  for (let i = 1; i < stack.regions.length; i++) {
    const [above, below] = [stack.regions.find((r) => r.name === order[i - 1])!, stack.regions.find((r) => r.name === order[i])!];
    expect(below.top, `${at}: ${below.name} below ${above.name}, not over it`).toBeGreaterThanOrEqual(above.bottom);
  }
}

test.describe(() => {
  // The fixture's own zone: its clock below reads 12:30 PM PT (bead ro-r49j).
  test.use({ timezoneId: WALL_FIXTURE_TIME_ZONE });
  // D28 (bead ro-trai.11): the Wall the fixture draws with nothing saved is the
  // strip, revenue beside Needs you over the site rows, and the feed. The old
  // cards' totals, projection headings and chart keys left with them; what is
  // checked now is every region's text and the site rows' one-line headings.
  test("the Wall cuts off no text in any region, and marks only the first site's out-of-date live users", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "a TV and a desk-width Wall; the phone Wall stacks one region per row");
    await page.clock.setFixedTime(new Date(WALL_FIXTURE_NOW));
    await page.route("**/api/wall", (route) => route.fulfill({ json: wallFixturePayload() }));
    await page.route("**/api/ga4/realtime", (route) => route.fulfill({ json: wallFixtureRealtime(20) }));
    await page.route("**/api/calendar/upcoming", (route) => route.fulfill({ json: wallFixtureCalendar() }));
    for (const [width, height] of [[1920, 1080], [1440, 900]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/wall");
      // The Wall runs on the fixture's time, not the journey server's Sep 6: the
      // server's pinned Date used to win over page.clock (bead ro-r49j).
      const time = page.locator("[data-wall-strip] [data-strip-time]");
      await expect(time).toHaveAttribute("datetime", WALL_FIXTURE_NOW);
      await expect(time).toHaveText("12:30PM");
      // The locale's day period, drawn apart from the numerals (bead ro-trai.3).
      await expect(time.locator("[data-strip-day-period]")).toHaveText("PM");
      // No header row above the strip: identity and time are the strip's.
      await expect(page.locator("[data-wall-header]")).toHaveCount(0);
      // So only the first site's reading is old, as the fixture means: every other
      // site's live users are fresh, beside the one out-of-date row.
      await expect(page.locator('[data-site-row] [data-live="stale"]')).toHaveCount(1);
      await expect(page.locator('[data-site-row="plate.example"] [data-live="stale"]')).toBeVisible();
      await expect(page.locator('[data-site-row="menus.example"] [data-live="stale"]')).toHaveCount(0);
      // Each live figure over its minute pulse (bead ro-trai.27): thirty bars
      // on a fresh reading, the old one dimmed.
      await expect(page.locator('[data-site-row="menus.example"] [data-minute-pulse="live"] [data-minute-bar]')).toHaveCount(30);
      await expect(page.locator('[data-site-row="plate.example"] [data-minute-pulse="dimmed"]')).toBeVisible();
      // Measure the type the TV shows: Inter swaps in, and a fallback face is wider.
      await page.evaluate(() => document.fonts.ready);
      const found = await page.evaluate(wallLegibility, "[data-wall-sites] [role='columnheader']:not(.sr-only)");
      expect(found.clipped, `text cut off at ${width}×${height}`).toEqual([]);
      expect(found.wrapped, `site headings off their line at ${width}×${height}`).toEqual([]);
      // A site that has sent nothing says so IN FULL (bead ro-vtqf): that line
      // is the one fact its row exists to say, so not even a designed
      // ellipsis may shorten it — the old card's "Waiting for first re…" did.
      const waiting = await page.evaluate(() => [...document.querySelectorAll("[data-site-waiting]")].map((cell) => ({
        text: (cell.textContent ?? "").trim(), cut: cell.scrollWidth - cell.clientWidth,
      })));
      expect(waiting, `the waiting site's line at ${width}×${height}`).toEqual([{ text: "No data yet", cut: 0 }]);
      await page.locator('[data-site-state="waiting"]').screenshot({ path: testInfo.outputPath(`wall-waiting-site-${width}.png`) });
      await page.locator('[data-site-row="plate.example"]').screenshot({ path: testInfo.outputPath(`wall-first-site-stale-${width}.png`) });
      await page.screenshot({ path: testInfo.outputPath(`wall-${width}.png`) });
    }
  });

  // The Wall on a phone and a portrait tablet (beads ro-trai.24, ro-trai.31,
  // docs/25-the-wall.md § Laptop, tablet and phone): the strip wraps instead
  // of cutting anything off, each site is a card whose charts span it with the
  // live figure at its right edge, the feed is as tall as its rows — the TV's
  // twelve at most, newest first — and nothing scrolls sideways.
  test("the Wall reads on a phone and a tablet: the strip wraps, each site's charts span its card, the feed grows", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "walks the phone and tablet widths itself");
    test.setTimeout(90_000);
    await page.clock.setFixedTime(new Date(WALL_FIXTURE_NOW));
    expect((await page.request.post("/__journey/wall-feed")).ok()).toBe(true);
    await page.route("**/api/wall", (route) => route.fulfill({ json: wallFixturePayload("fire") }));
    await page.route("**/api/ga4/realtime", (route) => route.fulfill({ json: wallFixtureRealtime(20, "fire") }));
    await page.route("**/api/calendar/upcoming", (route) => route.fulfill({ json: wallFixtureCalendar() }));
    await page.route("**/api/integrations/health", (route) => route.fulfill({ json: wallFixtureHealth("fire") }));
    await page.route("**/api/integrations/providers", (route) => route.fulfill({ json: wallFixtureProviders() }));
    for (const [width, height] of [[390, 844], [430, 932], [768, 1024]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/wall");
      // A portrait screen keeps the one column (bead ro-trai.31).
      await expect(page.locator(".wall-root")).toHaveAttribute("data-wall-layout", "stack");
      await expect(page.locator('[data-site-row] [data-live]:not([data-live="none"])')).toHaveCount(wallFixtureRealtime(20, "fire").assets.length);
      await expect(page.locator("[data-wall-feed]")).toHaveAttribute("data-feed-state", "live");
      // The feed reads live before its first answer: its rows are measured
      // below, so wait for them.
      await expect(page.locator("[data-wall-feed] [data-feed-item]").first()).toBeAttached();
      await page.evaluate(() => document.fonts.ready);
      await assertNoPageOverflow(page);
      const found = await page.evaluate(() => {
        const box = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
        const strip = document.querySelector("[data-wall-strip]")!;
        const stripBox = strip.getBoundingClientRect();
        const inside = (el: Element | null) => {
          const r = box(el);
          return r !== null && r.width > 0 && r.left >= stripBox.left - 1 && r.right <= stripBox.right + 1 && r.bottom <= stripBox.bottom + 1;
        };
        const rows = [...document.querySelectorAll("[data-site-row]")].filter((row) => row.querySelector("[data-site-today]"));
        const feed = document.querySelector("[data-wall-feed] ol")!;
        const items = [...feed.children].filter((item) => getComputedStyle(item).display !== "none");
        return {
          strip: {
            time: inside(strip.querySelector("[data-strip-time]")),
            date: inside(strip.querySelector("[data-strip-date]")),
            meeting: inside(strip.querySelector("[data-strip-meeting]")),
            countdown: inside(strip.querySelector("[data-strip-countdown]")),
            dateBelowTime: box(strip.querySelector("[data-strip-date]"))!.top >= box(strip.querySelector("[data-strip-time]"))!.bottom - 1,
            meetingBelow: box(strip.querySelector("[data-strip-meeting]"))!.top > box(strip.querySelector("[data-strip-time]"))!.bottom - 1,
          },
          cards: rows.map((row) => {
            const card = row.getBoundingClientRect();
            const chart = (cell: string) => box(row.querySelector(`[${cell}] [data-site-chart]`))!.width / card.width;
            return {
              live: Math.round(box(row.querySelector("[data-live]"))!.right),
              right: Math.round(card.right),
              today: chart("data-site-today"),
              trend: chart("data-site-trend"),
            };
          }),
          feed: {
            cut: items.filter((item) => item.hasAttribute("data-feed-cut")).length,
            spare: Math.round(feed.getBoundingClientRect().bottom - (items.at(-1)?.getBoundingClientRect().bottom ?? 0)),
          },
        };
      });
      expect(found.strip, `${width}: strip groups whole, time and date first`).toEqual({
        time: true, date: true, meeting: true, countdown: true, dateBelowTime: true, meetingBelow: true,
      });
      expect(found.cards.length).toBeGreaterThan(3);
      for (const card of found.cards) {
        // The live figure at the card's right edge (the row's own padding in).
        expect(card.right - card.live, `${width}: live figure off the card's edge`).toBeLessThanOrEqual(24);
        expect(card.today, `${width}: today's chart spans the card`).toBeGreaterThan(0.6);
        expect(card.trend, `${width}: the 4-week line spans the card`).toBeGreaterThan(0.6);
      }
      expect(new Set(found.cards.map((card) => card.live)).size, `${width}: one right edge for every live figure`).toBe(1);
      expect(found.feed, `${width}: the feed as tall as its rows`).toEqual({ cut: 0, spare: 0 });
      expectStackedInOrder(await page.evaluate(wallStack), `${width}`);
      await page.screenshot({ path: testInfo.outputPath(`wall-phone-${width}.png`), fullPage: true });
    }
  });

  // The Wall on a laptop and a landscape tablet (bead ro-trai.31, operator
  // 2026-09-23, docs/25-the-wall.md § Laptop, tablet and phone): a landscape
  // screen at least 1024 px wide draws the TV's layout, zoomed by one scale —
  // a 13-inch MacBook Air's 1470 × 830 is the TV at 77 % — so the feed is a
  // bounded column to the right of the site rows, never the half of the screen
  // it once took, the small type stays on its floors, and the Wall fits the
  // screen exactly as the TV fits 1920 × 1080, measured by `pnpm wall:fit`'s
  // own function.
  test("the Wall on a laptop is the TV's layout scaled to the screen: the feed a bounded column right of the site rows, the small type on its floors, nothing cut off", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "walks the laptop widths itself");
    test.setTimeout(90_000);
    await page.clock.setFixedTime(new Date(WALL_FIXTURE_NOW));
    expect((await page.request.post("/__journey/wall-feed")).ok()).toBe(true);
    await page.route("**/api/wall", (route) => route.fulfill({ json: wallFixturePayload("fire") }));
    await page.route("**/api/ga4/realtime", (route) => route.fulfill({ json: wallFixtureRealtime(20, "fire") }));
    await page.route("**/api/calendar/upcoming", (route) => route.fulfill({ json: wallFixtureCalendar() }));
    await page.route("**/api/integrations/health", (route) => route.fulfill({ json: wallFixtureHealth("fire") }));
    await page.route("**/api/integrations/providers", (route) => route.fulfill({ json: wallFixtureProviders() }));
    for (const [width, height] of [[1470, 830], [1024, 768]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/wall");
      await expect(page.locator('[data-site-row] [data-live]:not([data-live="none"])')).toHaveCount(wallFixtureRealtime(20, "fire").assets.length);
      await expect(page.locator("[data-wall-feed]")).toHaveAttribute("data-feed-state", "live");
      // The feed reads live before its first answer: its rows are measured
      // below, so wait for them.
      await expect(page.locator("[data-wall-feed] [data-feed-item]").first()).toBeAttached();
      await expect(page.locator(".wall-root")).toHaveAttribute("data-wall-layout", "tv");
      await page.evaluate(() => document.fonts.ready);
      await assertNoPageOverflow(page);
      const at = `${width}×${height}`;
      const found = await page.evaluate(() => {
        const root = document.querySelector(".wall-root") as HTMLElement & { currentCSSZoom?: number };
        const zoom = root.currentCSSZoom ?? 1;
        const box = (selector: string) => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width };
        };
        // The size the eye gets: an element's own font size, zoomed.
        const drawn = (selector: string) => parseFloat(getComputedStyle(document.querySelector(selector)!).fontSize) * zoom;
        return {
          zoom,
          strip: box("[data-wall-strip]"),
          revenue: box("[data-wall-revenue]"),
          needs: box("[data-wall-needs]"),
          sites: box("[data-wall-sites]"),
          feed: box("[data-wall-feed]"),
          type: {
            axis: drawn("[data-site-weeks-axis]"),
            listLabel: drawn("[data-feed-label]"),
            listMeta: drawn("[data-feed-time]"),
            listLine: drawn("[data-feed-text]"),
            eyebrow: drawn("[data-wall-sites] [role='columnheader']:not(.sr-only)"),
          },
        };
      });
      // One scale for the whole Wall: the TV's 1920 × 1080 fitted to the screen.
      expect(found.zoom, `${at}: the TV's box fitted to the screen`).toBeCloseTo(Math.min(width / 1920, height / 1080), 3);
      // The TV's arrangement: the strip on top; revenue beside Needs you over
      // the site rows; the feed to the right of all three, the body's height.
      expect(found.revenue.top, `${at}: revenue under the strip`).toBeGreaterThanOrEqual(found.strip.bottom);
      expect(found.needs.left, `${at}: Needs you beside revenue`).toBeGreaterThanOrEqual(found.revenue.right);
      expect(found.sites.top, `${at}: the site rows under revenue`).toBeGreaterThanOrEqual(found.revenue.bottom);
      expect(found.feed.left, `${at}: the feed right of the site rows`).toBeGreaterThanOrEqual(found.sites.right);
      expect(found.feed.left, `${at}: the feed right of Needs you`).toBeGreaterThanOrEqual(found.needs.right);
      expect(Math.abs(found.feed.top - found.revenue.top), `${at}: the feed from the body's top`).toBeLessThanOrEqual(1);
      // Bounded: its share of the row between 21 and 30 rem of the TV's box —
      // about a quarter of the screen — and the site rows take the rest.
      expect(found.feed.width, `${at}: the feed at least 21 rem`).toBeGreaterThanOrEqual(21 * 16 * found.zoom - 1);
      expect(found.feed.width, `${at}: the feed at most 30 rem`).toBeLessThanOrEqual(30 * 16 * found.zoom + 1);
      expect(found.feed.width / width, `${at}: the feed about a quarter of the screen`).toBeLessThan(0.3);
      expect(found.sites.width, `${at}: the site rows take the rest`).toBeGreaterThan(found.feed.width * 2.5);
      // The small type on its floors (docs/25 § Type): 11 px for the axis
      // words and a list's label and meta, 12 for the headings, 13 for a
      // list's line.
      const floors = { axis: 11, listLabel: 11, listMeta: 11, eyebrow: 12, listLine: 13 } as const;
      for (const [step, floor] of Object.entries(floors)) {
        expect(found.type[step as keyof typeof floors], `${at}: ${step} on its ${floor} px floor`).toBeGreaterThanOrEqual(floor - 0.05);
      }
      // It fits the screen as the TV fits 1920 × 1080: nothing past the edge,
      // nothing painting outside its box, no text cut off, whole feed rows.
      const measured = await page.evaluate(measureWallFit);
      if ("error" in measured) throw new Error(`${at}: ${measured.error}`);
      const verdict = wallFitVerdict(measured);
      expect(verdict.fits, `${at}: past the screen by ${verdict.overWidth}×${verdict.overHeight} px: ${JSON.stringify(measured.worst)}`).toBe(true);
      expect(measured.ink, `${at}: painting outside its own box`).toEqual([]);
      expect(measured.clipped, `${at}: text cut off`).toEqual([]);
      expect(measured.feed.lastRowWhole, `${at}: the feed's lowest row cut`).not.toBe(false);
      expect(measured.sites.rows.length, `${at}: every site a row`).toBe(wallFixturePayload("fire").assets.length);
      const health = page.locator("[data-site-row] [data-site-health]");
      await expect(health).toHaveCount(wallFixturePayload("fire").assets.length);
      await expect(page.locator("[data-site-mark]")).toHaveCount(0);
      for (const icon of await health.all()) {
        await expect(icon).toHaveAttribute("role", "img");
        await expect(icon).toHaveAttribute("aria-label", /.+/);
        const size = await icon.boundingBox();
        expect(size?.width, `${at}: visible health icon`).toBeGreaterThan(8);
        expect(size?.height, `${at}: visible health icon`).toBeGreaterThan(8);
      }
      // Charts use the width and height left by their figure and axis.
      const charts = await page.evaluate(() => [...document.querySelectorAll("[data-site-row]")]
        .flatMap((row) => [...row.querySelectorAll("[data-site-chart]")].map((chart) => {
          const r = chart.getBoundingClientRect();
          const svg = chart.querySelector("svg")!.getBoundingClientRect();
          return { width: r.width, height: r.height, widthSpare: r.width - svg.width, heightSpare: r.height - svg.height };
        })));
      expect(charts.length, `${at}: rows draw charts`).toBeGreaterThan(0);
      for (const chart of charts) {
        expect(chart.width, `${at}: chart has readable width`).toBeGreaterThan(32);
        expect(chart.height, `${at}: chart has readable height`).toBeGreaterThan(20);
        expect(Math.abs(chart.widthSpare), `${at}: plot fills chart width`).toBeLessThan(2);
        expect(Math.abs(chart.heightSpare), `${at}: plot fills chart height`).toBeLessThan(2);
      }
      await page.screenshot({ path: testInfo.outputPath(`wall-laptop-${width}.png`) });
    }
  });

  test("the Wall's header groups stay readable without overlap or aggregate status", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "walks the phone and tablet widths itself");
    await page.clock.setFixedTime(new Date(WALL_FIXTURE_NOW));
    await page.route("**/api/wall", (route) => route.fulfill({ json: wallFixturePayload("six") }));
    await page.route("**/api/ga4/realtime", (route) => route.fulfill({ json: wallFixtureRealtime(20, "six") }));
    await page.route("**/api/calendar/upcoming", (route) => route.fulfill({ json: wallFixtureCalendar() }));
    await page.route("**/api/integrations/health", (route) => route.fulfill({ json: wallFixtureHealth("six") }));
    await page.route("**/api/integrations/providers", (route) => route.fulfill({ json: wallFixtureProviders() }));
    for (const [width, height] of [[1920, 1080], [1440, 900], [1024, 768], [768, 1024], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/wall");
      const strip = page.locator("[data-wall-strip]");
      await expect(strip.locator("[data-strip-countdown-emoji]")).toBeVisible();
      await expect(strip.locator("[data-strip-meeting]")).toBeVisible();
      await expect(strip.locator("[data-strip-countdown-unit]")).toHaveText("days remaining");
      await expect(strip.locator("[data-strip-countdown-value]")).toHaveText(/^\d+$/);
      await expect(strip.locator("[data-system-state], [data-strip-glyph]")).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      const found = await page.evaluate(stripGroups);
      const at = `${width}×${height}`;
      for (const group of [...found.groups, ...found.marks]) {
        expect(group.width, `${at}: ${group.selector} drawn`).toBeGreaterThan(0);
        expect(group.left, `${at}: ${group.selector} inside left`).toBeGreaterThanOrEqual(found.box.left - 1);
        expect(group.right, `${at}: ${group.selector} inside right`).toBeLessThanOrEqual(found.box.right + 1);
        expect(group.top, `${at}: ${group.selector} inside top`).toBeGreaterThanOrEqual(found.box.top - 1);
        expect(group.bottom, `${at}: ${group.selector} inside bottom`).toBeLessThanOrEqual(found.box.bottom + 1);
      }
      for (let i = 0; i < found.groups.length; i += 1) for (const other of found.groups.slice(i + 1)) {
        const group = found.groups[i]!;
        const overlap = Math.min(group.right, other.right) - Math.max(group.left, other.left) > 1
          && Math.min(group.bottom, other.bottom) - Math.max(group.top, other.top) > 1;
        expect(overlap, `${at}: ${group.selector} overlaps ${other.selector}`).toBe(false);
      }
      expect(found.date.top, `${at}: the date follows the clock`).toBeGreaterThanOrEqual(found.time.bottom - 1);
      expect(new Set(found.labels.map((label) => label.family)).size, `${at}: one font family`).toBe(1);
      expect(new Set(found.labels.map((label) => label.size)).size, `${at}: secondary labels share a type step`).toBe(1);
      expect(found.valueSize, `${at}: the countdown figure reads larger than its unit`).toBeGreaterThan(found.labels[0]!.size);
      if (width > height) {
        const scale = Math.min(1, width / 1920, height / 1080);
        expect(found.height, `${at}: at least the TV's 96px header, scaled`).toBeGreaterThanOrEqual(96 * scale - 1);
        const expectedHeight = Math.max(96 * scale, Math.max(...found.groups.map((group) => group.height)) + 32 * scale);
        expect(Math.abs(found.height - expectedHeight), `${at}: readable groups plus real padding determine height`).toBeLessThanOrEqual(1);
        for (const label of found.labels) expect(label.size * scale, `${at}: ${label.selector} meets the 11px physical floor`).toBeGreaterThanOrEqual(10.95);
        for (const group of found.groups) {
          expect(group.top - found.box.top, `${at}: ${group.selector} has real top padding`).toBeGreaterThanOrEqual(16 * scale - 1);
          expect(found.box.bottom - group.bottom, `${at}: ${group.selector} has real bottom padding`).toBeGreaterThanOrEqual(16 * scale - 1);
        }
      }
      const legibility = await page.evaluate(wallLegibility, "[data-strip-date], [data-strip-countdown-unit]");
      expect(legibility.clipped, `${at}: no text clipped`).toEqual([]);
      expect(legibility.wrapped, `${at}: short header labels whole`).toEqual([]);
      await strip.screenshot({ path: testInfo.outputPath(`wall-strip-${width}.png`) });
      if (width === 1920) await page.screenshot({ path: testInfo.outputPath("wall-header-full-preview.png") });
    }
  });

  // D28's budget (bead ro-trai.12, docs/25-the-wall.md § Budget): the TV fits
  // 1920×1080 at every site count the contract names, measured by the same
  // function `pnpm wall:fit` runs (scripts/wall-fit-measure.mts). Nothing
  // reaches past the screen, nothing paints outside its own box, no text is cut
  // off, the feed draws only whole rows, and rows and plots use the region
  // while remaining readable at each supported density.
  test("the Wall fits the TV with one, two, three, six, seven or eight sites and on fire, cutting off no text", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "the TV's budget; the phone Wall stacks one region per row");
    test.setTimeout(120_000);
    await page.clock.setFixedTime(new Date(WALL_FIXTURE_NOW));
    let variant: WallFixtureVariant = "six";
    await page.route("**/api/wall", (route) => route.fulfill({ json: wallFixturePayload(variant) }));
    await page.route("**/api/ga4/realtime", (route) => route.fulfill({ json: wallFixtureRealtime(20, variant) }));
    await page.route("**/api/calendar/upcoming", (route) => route.fulfill({ json: wallFixtureCalendar() }));
    // The source-health reads a failing source is read from (`fire`).
    await page.route("**/api/integrations/health", (route) => route.fulfill({ json: wallFixtureHealth(variant) }));
    await page.route("**/api/integrations/providers", (route) => route.fulfill({ json: wallFixtureProviders() }));
    const tvCharts = new Map<string, { width: number; height: number; availableHeight: number }>();
    const tvType = new Map<string, { font: number; region: number }>();
    for (const [width, height] of [[1920, 1080], [1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      const variants = width === 1920 ? WALL_FIXTURE_VARIANTS : ["one", "three", "six", "seven"] as const;
      for (const next of variants) {
        variant = next;
        const sites = wallFixturePayload(variant).assets;
        await page.goto("/wall");
        // Every site's live users landed: the heights are the finished Wall's.
        const region = page.locator("[data-wall-sites]");
        if (sites.length === 1) await expect(region.locator('[data-focus-tile="today"]')).toBeVisible();
        else await expect(region.locator('[data-site-row] [data-live]:not([data-live="none"])')).toHaveCount(wallFixtureRealtime(20, variant).assets.length);
        await expect(page.locator("[data-wall-feed]")).toHaveAttribute("data-feed-state", "live");
        if (variant === "six") {
          // Specific warnings stay in Needs you, with no aggregate badge.
          await expect(page.locator("[data-wall-strip] [data-system-state]")).toHaveCount(0);
          await expect(page.locator("[data-wall-needs] [data-needs-row]")).toHaveCount(1);
        }
        if (variant === "fire") {
          // Needs you names the failure, errors before warnings; the site's
          // health bar carries its state without an aggregate strip badge.
          const [, , , down, silent] = sites;
          await expect(page.locator("[data-wall-strip] [data-system-state]")).toHaveCount(0);
          await expect(page.locator("[data-wall-needs] [data-needs-row]").first()).toHaveAttribute("data-needs-row", "error");
          await expect(page.locator("[data-wall-needs] [data-needs-row]").first()).toContainText(down!.displayName);
          await expect(page.locator(`[data-site-row="${down!.id}"] [data-site-health]`)).toHaveAttribute("data-site-health", "error");
          await expect(page.locator(`[data-site-row="${silent!.id}"] [data-site-health]`)).toHaveAttribute("data-site-health", "warn");
        }
        await page.evaluate(() => document.fonts.ready);
        const measured = await page.evaluate(measureWallFit);
        if ("error" in measured) throw new Error(`${variant}: ${measured.error}`);
        const verdict = wallFitVerdict(measured);
        if (width > height) expect(verdict.fits, `${variant}: past the TV by ${verdict.overWidth}×${verdict.overHeight} px: ${JSON.stringify(measured.worst)}`).toBe(true);
        expect(measured.ink, `${variant}: painting outside its own box`).toEqual([]);
        expect(measured.clipped, `${variant}: text cut off`).toEqual([]);
        expect(measured.feed.lastRowWhole, `${variant}: the feed's lowest row cut`).not.toBe(false);
        const heights = measured.sites.rows.map((row) => row.height);
        if (variant === "one") expect(measured.sites.density).toBe("focus");
        else if (width > height) {
          expect(measured.sites.density).toBe(variant === "two" || variant === "three" ? "comfortable" : "compact");
          expect(heights).toHaveLength(sites.length);
          for (const rowHeight of heights) expect(rowHeight).toBeGreaterThan(0);
          if (variant === "eight") {
            // Beyond the visible budget, preserve readable content floors
            // and scroll inside the site region, leaving the page bounded.
            const table = region.getByRole("table");
            await expect(table).toHaveCSS("overflow-y", "auto");
            const frame = await table.boundingBox();
            for (const asset of sites) {
              const row = region.locator(`[data-site-row="${asset.id}"]`);
              await row.scrollIntoViewIfNeeded();
              const bounds = await row.boundingBox();
              expect(bounds!.y, `${asset.id}: reachable inside its region`).toBeGreaterThanOrEqual(frame!.y - 1);
              expect(bounds!.y + bounds!.height, `${asset.id}: fully visible after scrolling`).toBeLessThanOrEqual(frame!.y + frame!.height + 1);
            }
          } else {
            expect(Math.abs(measured.sites.spare!), `${variant}: rows fill their region`).toBeLessThan(2);
            const hidden = await region.evaluate((el) => {
              const box = el.getBoundingClientRect();
              return [...el.querySelectorAll("[data-site-row]")].filter((row) => {
                const r = row.getBoundingClientRect();
                return r.top < box.top - 1 || r.bottom > box.bottom + 1;
              }).map((row) => row.getAttribute("data-site-row"));
            });
            expect(hidden, `${variant}: every row fully visible, including its totals`).toEqual([]);
          }
        }
        const totals = page.locator('[data-site-total="accounts"] dd');
        await expect(totals).toHaveText("6,267");
        if (variant !== "one") await expect(page.locator('[data-site-total="itemsRated"] dd')).toHaveText("13,904");
        if (width === 1920 && (variant === "three" || variant === "six" || variant === "seven")) {
          const figure = await totals.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
          expect(figure, `${variant}: totals meet the documented TV type floor`).toBeGreaterThanOrEqual(18);
        }
        await assertNoPageOverflow(page);
        const plot = region.locator("[data-site-chart], [data-focus-chart]").first();
        const plotBox = await plot.boundingBox();
        const availableHeight = await plot.evaluate((el) => {
          const parent = el.parentElement!;
          const style = getComputedStyle(parent);
          const zoom = (parent as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom ?? 1;
          const px = (value: string) => (parseFloat(value) || 0) * zoom;
          const siblings = [...parent.children].filter((child) => child !== el);
          const beside = style.display === "flex" && (style.flexDirection === "row" || style.flexDirection === "row-reverse");
          return parent.getBoundingClientRect().height
            - px(style.paddingTop) - px(style.paddingBottom) - px(style.borderTopWidth) - px(style.borderBottomWidth)
            - (beside ? 0 : siblings.reduce((height, sibling) => height + sibling.getBoundingClientRect().height, 0))
            - (beside ? 0 : px(style.rowGap) * siblings.length);
        });
        expect(plotBox?.width, `${width}/${variant}: a visible chart`).toBeGreaterThan(32);
        expect(plotBox?.height, `${width}/${variant}: a readable chart`).toBeGreaterThan(20);
        if (width > height && (variant === "one" || variant === "three")) {
          expect(Math.abs(plotBox!.height - availableHeight), `${variant}: plot fills height after figures, labels and padding`).toBeLessThan(2);
        }
        if (width === 1920) tvCharts.set(variant, { ...plotBox!, availableHeight });
        if (variant === "six" || variant === "seven") {
          const font = await totals.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
          const regionHeight = measured.regions.sites!.height / measured.scale;
          if (width === 1920) tvType.set(variant, { font, region: regionHeight });
          if (width === 1440) {
            const previous = tvType.get(variant)!;
            expect(Math.abs(regionHeight - previous.region), `${variant}: fixture changes the region height`).toBeGreaterThan(10);
            expect(Math.abs(font - previous.font), `${variant}: type responds to its region, not the viewport`).toBeGreaterThan(0.5);
            expect((font - previous.font) * (regionHeight - previous.region), `${variant}: more room gives larger type`).toBeGreaterThan(0);
          }
        }
        if (width === 1440) {
          const previous = tvCharts.get(variant)!;
          expect(plotBox!.width, `${variant}: charts respond to narrower region`).toBeLessThan(previous.width);
          if (variant === "one" || variant === "three") {
            // Figure wrapping and padding also change; compare the room the
            // plot actually has, after those siblings, not viewport height.
            expect(Math.abs(plotBox!.height - previous.height), `${variant}: charts respond to changed region height`).toBeGreaterThan(2);
            expect((plotBox!.height - previous.height) * (availableHeight - previous.availableHeight), `${variant}: plot height follows its available room`).toBeGreaterThan(0);
          }
        }
        await page.screenshot({ path: testInfo.outputPath(`wall-budget-${width}-${variant}.png`), fullPage: width === 390 });
      }
    }
  });
});

// The TV layout on a fresh install (bead ro-nuz9): the fixture's store holds no
// `/wall`, as a store seeded without the key does, and the first Save was
// refused with "Changed elsewhere — reload to see the current value". Now it
// saves, and the next Save — straight after, before the payload catches up —
// saves on top of it: created, then updated, both in the store.
test("the TV layout saves on a fresh install, then saves again on top of it", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the layout's save is the same on a phone; the arrange-wall walk covers the phone");
  await createAsset(page);
  await page.clock.setFixedTime(new Date(WALL_FIXTURE_NOW));
  let missingSelectedMetric = false;
  await page.route("**/api/wall", async (route) => {
    // Keep the actual persisted layout and its write guard, substituting only
    // the synthetic site's readings. Reloads must read what Save wrote.
    const response = await route.fetch();
    const actual = await response.json();
    const fixture = structuredClone(wallFixturePayload("three"));
    const cards = fixture.assets[0]!.counters!.cards;
    cards.find((card) => card.metric === "leads")!.value = 0;
    if (missingSelectedMetric) fixture.assets[0]!.counters!.cards = cards.filter((card) => card.metric !== "plansSaved");
    await route.fulfill({ response, json: { ...fixture, dashboard: { ...actual.dashboard, countdown: fixture.dashboard.countdown } } });
  });
  await page.route("**/api/ga4/realtime", (route) => route.fulfill({ json: wallFixtureRealtime(20, "three") }));
  const wall = async (): Promise<WallConfig | undefined> => (await (await request.get("/__journey/status")).json()).documents["config/tower.json"].wall;
  const settings = (config: WallConfig) => wallLayoutWidgets(config.layout).find((widget) => widget.id === "sites")!.settings;
  expect(await wall()).toBeUndefined();

  await page.goto("/wall/edit");
  const bar = page.locator("[data-wall-save-bar]");
  const layoutState = (state: "saved" | "unsaved") => bar.locator(`[data-save-state="${state}"] [data-status-for="wall:layout"]`);
  const refusal = page.locator('[data-sonner-toast][data-type="error"]');
  const saved = page.locator('[data-sonner-toast][data-type="success"]', { hasText: "Saved — TV layout" });
  await expect(layoutState("saved")).toHaveText("On the TV");

  await page.locator('[data-wall-edit-widget="sites"]').click();
  const panel = page.locator('[data-wall-widget-panel="sites"]');
  const plate = panel.locator('[data-wall-pulse-picker="plate.example"]');
  const menu = panel.locator('[data-wall-pulse-picker="menus.example"]');
  await plate.getByRole("checkbox", { name: /Accounts/ }).uncheck();
  await plate.getByRole("checkbox", { name: /Plans saved/ }).check();
  await menu.getByRole("checkbox", { name: /Restaurants/ }).uncheck();
  await panel.getByRole("checkbox", { name: "Fitness Test", exact: true }).uncheck();
  const chosen = { assets: ["plate.example", "menus.example"], pulseMetrics: { "plate.example": ["leads", "plansSaved"], "menus.example": ["itemsRated"] } };
  const preview = page.locator('[data-wall-preview]');
  await expect(preview.locator('[data-site-total="accounts"]')).toHaveCount(0);
  await expect(preview.locator('[data-site-total="plansSaved"] dd')).toHaveText("41,280");
  await expect(preview.locator('[data-site-total="leads"] dd')).toHaveText("0");
  await expect(preview.locator('[data-site-total="itemsRated"] dd')).toHaveText("13,904");
  await expect(preview.locator('[data-site-row="fitness.example"]')).toHaveCount(0);

  // Create: the first Save of a layout nobody has saved.
  await page.getByRole("button", { name: "Move row 1 down", exact: true }).click();
  await expect(layoutState("unsaved")).toHaveText("Unsaved changes");
  await bar.getByRole("button", { name: "Save", exact: true }).click();
  await expect(saved).toBeVisible();
  await expect(layoutState("saved")).toHaveText("On the TV");
  await expect(refusal).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("wall-layout-created.png") });
  const created = (await wall())!;
  expect(settings(created)).toEqual(chosen);
  expect(created.layout.rows.map((row: { id: string }) => row.id)).toEqual(["body", "strip"]);
  expect(created.history).toHaveLength(1);
  await expect(page.locator("[data-wall-version]")).toHaveCount(1);

  // Update: the next Save, guarded by the layout the first one wrote.
  await menu.getByRole("checkbox", { name: /Items rated/ }).uncheck();
  // Hiding and restoring an asset retains its pulse choices.
  await panel.getByRole("checkbox", { name: "Menu Finder", exact: true }).uncheck();
  await panel.getByRole("checkbox", { name: "Menu Finder", exact: true }).check();
  await expect(menu.getByRole("checkbox", { name: /Items rated/ })).not.toBeChecked();
  await expect(menu.getByRole("checkbox", { name: /Restaurants/ })).not.toBeChecked();
  await expect(preview.locator('[data-site-totals="menus.example"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Move row 1 down", exact: true }).click();
  await expect(layoutState("unsaved")).toHaveText("Unsaved changes");
  await bar.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await wall())!.history.length, { message: "the second Save reaches the store" }).toBe(2);
  await expect(layoutState("saved")).toHaveText("On the TV");
  await expect(refusal).toHaveCount(0);
  const updated = (await wall())!;
  expect(settings(updated)).toEqual({ ...chosen, pulseMetrics: { ...chosen.pulseMetrics, "menus.example": [] } });
  expect(updated.layout.rows.map((row: { id: string }) => row.id)).toEqual(["strip", "body"]);
  expect(updated.history.map((version: { layout: { rows: { id: string }[] } }) => version.layout.rows.map((row) => row.id)))
    .toEqual([["body", "strip"], ["strip", "body"]]);
  await expect(page.locator("[data-wall-version]")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("wall-layout-updated.png") });

  // And a reload reads both back from the store.
  await page.reload();
  await expect(layoutState("saved")).toHaveText("On the TV");
  await expect(page.locator("[data-wall-version]")).toHaveCount(2);
  await expect(preview.locator('[data-site-total="plansSaved"] dd')).toHaveText("41,280");
  await expect(preview.locator('[data-site-totals="menus.example"]')).toHaveCount(0);

  // The newest history entry is the previous saved layout, including choices.
  await page.locator('[data-wall-version]').first().getByRole("button", { name: "Revert", exact: true }).click();
  await expect.poll(async () => settings((await wall())!), { message: "Revert restores saved pulse choices and filter" }).toEqual(chosen);
  await expect(layoutState("saved")).toHaveText("On the TV");
  await expect(preview.locator('[data-site-total="itemsRated"] dd')).toHaveText("13,904");
  await page.reload();
  await expect(preview.locator('[data-site-total="itemsRated"] dd')).toHaveText("13,904");
  await page.screenshot({ path: testInfo.outputPath("wall-layout-pulse-reverted.png") });
  // A selected metric that no longer arrives remains editable; no reading
  // disappears from the TV rather than being invented as zero.
  missingSelectedMetric = true;
  await page.reload();
  await page.locator('[data-wall-edit-widget="sites"]').click();
  await expect(plate.getByRole("checkbox", { name: /plansSaved.*No reading/ })).toBeChecked();
  await expect(preview.locator('[data-site-total="plansSaved"]')).toHaveCount(0);
  await expect(preview.locator('[data-site-total="leads"] dd')).toHaveText("0");
  // Clicking removes the now-unselected placeholder itself; an uncheck()
  // verification cannot reread a control deliberately removed by the action.
  await plate.getByRole("checkbox", { name: /plansSaved.*No reading/ }).click();
  await expect(plate.getByRole("checkbox", { name: /plansSaved.*No reading/ })).toHaveCount(0);
  await expect(layoutState("unsaved")).toHaveText("Unsaved changes");
  await page.screenshot({ path: testInfo.outputPath("wall-layout-missing-total-editable.png") });
});

// The TV layout editor's preview is the TV, and the TV is dark (bead ro-c0l3).
// On a light desk the preview used to take some of the desk's light tokens —
// the strip and the feed pale grey, the clock and the site's name dark ink on
// black. Every token and ink the preview draws with must equal the TV's own.
test("the TV layout's preview draws the TV dark on a light desk, exactly as the TV draws itself", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the preview's tokens do not depend on the screen's width");
  await page.addInitScript(() => window.localStorage.setItem("noticeos:theme", "light"));
  await createAsset(page);

  /** What the TV box draws with: its tokens, the clock's and a site name's
   * ink, and the strip's panel behind the clock. */
  const drawn = (root: string) => page.evaluate((scope) => {
    const box = document.querySelector<HTMLElement>(scope)!;
    const style = getComputedStyle(box);
    const tokens = Object.fromEntries(["--background", "--foreground", "--card", "--muted", "--muted-foreground", "--border", "--warn", "--error", "--healthy", "--traffic"]
      .map((name) => [name, style.getPropertyValue(name).trim()]));
    const clock = box.querySelector<HTMLElement>("[data-strip-time]")!;
    let panel: HTMLElement | null = clock;
    while (panel && panel !== box && getComputedStyle(panel).backgroundColor === "rgba(0, 0, 0, 0)") panel = panel.parentElement;
    return {
      tokens,
      clock: getComputedStyle(clock).color,
      site: getComputedStyle(box.querySelector<HTMLElement>("[data-site-name]")!).color,
      strip: panel ? getComputedStyle(panel).backgroundColor : null,
    };
  }, root);

  await page.goto("/wall/edit");
  await expect(page.locator("html")).toHaveClass(/\blight\b/);
  await expect(page.locator("[data-wall-preview] [data-site-name]")).toBeVisible();
  const preview = await drawn("[data-wall-preview] .wall-root");

  await page.goto("/wall");
  await expect(page.locator("[data-site-name]").first()).toBeVisible();
  const tv = await drawn(".wall-root");

  expect(preview).toEqual(tv);
  // And the TV's are the dark set, not merely equal to each other.
  expect(tv.tokens["--background"]).toBe("oklch(0 0 0)");
  await page.goto("/wall/edit");
  await page.locator("[data-wall-preview]").screenshot({ path: testInfo.outputPath("preview-light-desk.png") });
});

// A saved TV layout the Tower cannot read (bead ro-trai.45): the store holds a
// layout with no rows beside one version that still reads. The TV draws the
// default; the editor names the save as refused instead of calling the default
// "On the TV", and a Save and a Revert from that state both land, guarded by
// what the store really holds.
test("a saved TV layout the Tower cannot read is named as refused, and a Save or a Revert replaces it", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the layout's save is the same on a phone");
  await createAsset(page);
  expect((await request.post("/__journey/refused-tower?part=wall")).ok()).toBe(true);
  const wall = async () => (await (await request.get("/__journey/status")).json()).documents["config/tower.json"].wall;

  await page.goto("/wall");
  await expect(page.locator("[data-wall-slot]")).toHaveCount(5); // D28's default, in its place

  await page.goto("/wall/edit");
  const bar = page.locator("[data-wall-save-bar]");
  const layoutState = (state: "saved" | "refused") => bar.locator(`[data-save-state="${state}"] [data-status-for="wall:layout"]`);
  const refusal = page.locator('[data-sonner-toast][data-type="error"]');
  const saved = page.locator('[data-sonner-toast][data-type="success"]', { hasText: "Saved — TV layout" });
  await expect(layoutState("refused")).toHaveText("Saved layout refused");
  await expect(layoutState("refused")).toHaveAttribute("title", /at least one row/);
  await expect(page.locator("[data-wall-unreadable]")).toHaveCount(0);
  await expect(page.locator("[data-wall-version]")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("wall-layout-refused.png") });

  // Save the default as drawn: live without a change, and it lands.
  await bar.getByRole("button", { name: "Save", exact: true }).click();
  await expect(saved).toBeVisible();
  await expect(layoutState("saved")).toHaveText("On the TV");
  await expect(refusal).toHaveCount(0);
  expect((await wall()).layout.rows.map((row: { id: string }) => row.id)).toEqual(["strip", "body"]);

  // And the version that still read is offered back, and a Revert lands too.
  await expect(page.locator("[data-wall-version]")).toHaveCount(1);
  await page.getByRole("button", { name: "Revert", exact: true }).click();
  await expect.poll(async () => (await wall()).layout.rows.map((row: { id: string }) => row.id), { message: "the Revert reaches the store" })
    .toEqual(["strip", "sites"]);
  await expect(refusal).toHaveCount(0);
  await expect(layoutState("saved")).toHaveText("On the TV");
});

// A countdown the Tower cannot read beside a valid saved layout (bead
// ro-trai.45): the layout stays standing, the countdown is named as refused,
// and its form saves over the stored value.
test("a saved countdown the Tower cannot read leaves the layout standing, and its form saves over it", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the countdown's form is the same on a phone");
  await createAsset(page);
  expect((await request.post("/__journey/refused-tower?part=countdown")).ok()).toBe(true);
  const tower = async () => (await (await request.get("/__journey/status")).json()).documents["config/tower.json"];

  await page.goto("/wall/edit");
  const bar = page.locator("[data-wall-save-bar]");
  await expect(page.locator("[data-wall-edit-widget]")).toHaveCount(2); // the saved strip and sites, not the default
  await expect(bar.locator('[data-save-state="saved"] [data-status-for="wall:layout"]')).toHaveText("On the TV");
  const countdown = bar.locator('[data-wall-countdown-refused] [data-status-for="wall:countdown"]');
  await expect(countdown).toHaveText("Saved countdown refused");
  await page.screenshot({ path: testInfo.outputPath("wall-countdown-refused.png") });

  // The chip opens the strip's form, which starts from what still reads.
  await bar.locator("[data-wall-countdown-refused]").click();
  const panel = page.locator('[data-wall-widget-panel="strip"]');
  await expect(panel.getByLabel("Countdown label")).toHaveValue("Launch");
  await panel.getByLabel("Countdown emoji").fill("🚀");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator('[data-sonner-toast][data-type="success"]', { hasText: "Saved — Countdown" })).toBeVisible();
  await expect.poll(async () => (await tower()).countdown?.emoji, { message: "the countdown reaches the store" }).toBe("🚀");
  expect((await tower()).countdown.label).toBe("Launch");
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
  await expect(countdown).toHaveCount(0);
});

// A setting shown from the built-in copy (bead ro-dk4u): the fixture's stored
// settings lack the monthly cap, as a store seeded by older code does, so
// Settings shows the compiled value — and its Save was refused as "Changed
// elsewhere". Now the first Save creates the key, and the next is guarded by it.
test("a setting the saved settings lack saves from the value shown, then saves on top of it", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the write lane's rule is the same on a phone; this pins the lane, not the layout");
  expect((await request.post("/__journey/older-settings")).ok()).toBe(true);
  const constants = async () => (await (await request.get("/__journey/status")).json()).documents["config/constants.json"];
  expect((await constants()).monthly_caps).toBeUndefined();

  await page.goto("/settings");
  const cap = page.getByLabel("Monthly data cap", { exact: true });
  const row = page.locator("div", { has: cap }).filter({ has: page.getByRole("button", { name: "Save", exact: true }) }).last();
  const saved = page.locator('[data-status-for="field:portfolio:Monthly data cap"][data-save-state="saved"]');
  const refused = page.locator('[data-status-for="field:portfolio:Monthly data cap"][data-save-state="refused"]');
  await expect(cap).toHaveValue("25");

  // Create: the first Save, guarded by the built-in value the page showed.
  await cap.fill("40");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(saved).toBeVisible();
  await expect(refused).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("setting-created.png") });
  expect((await constants()).monthly_caps).toEqual({ data_usd: 40 });

  // Update: read back from the store, and guarded by what the first Save wrote.
  await page.reload();
  await expect(cap).toHaveValue("40");
  await cap.fill("50");
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(saved).toBeVisible();
  await expect(refused).toHaveCount(0);
  expect((await constants()).monthly_caps).toEqual({ data_usd: 50 });
});

// The live feed (beads ro-trai.6, ro-trai.9): stored events read by the real
// Worker over the fixture store, and one new stored event arriving at the top
// within one 30-second poll. The fixture's clock is the journey server's own.
test("Wall feedback keeps the brand large, pace compact and each stored task named", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "walks the commented screen, TV and phone in one fixture");
  await page.clock.setFixedTime(new Date(WALL_FIXTURE_NOW));
  expect((await request.post("/__journey/wall-feed")).ok()).toBe(true);
  await page.route("**/api/wall", (route) => route.fulfill({ json: wallFixturePayload("six") }));
  await page.route("**/api/ga4/realtime", (route) => route.fulfill({ json: wallFixtureRealtime(20, "six") }));
  await page.route("**/api/calendar/upcoming", (route) => route.fulfill({ json: wallFixtureCalendar() }));
  await page.route("**/api/integrations/health", (route) => route.fulfill({ json: wallFixtureHealth("six") }));
  await page.route("**/api/integrations/providers", (route) => route.fulfill({ json: wallFixtureProviders() }));
  const stored = await (await request.get("/api/wall/feed")).json() as WallFeedPayload;
  const tasks = stored.items.filter((item) => item.kind === "task-done" || item.kind === "task-filed");
  expect(tasks.map((item) => item.text)).toEqual([
    "Recipe cards load faster", "Menu import skips closed restaurants", "Lookup page shows the local time",
    "Pantry list keeps its order", "Map loads on phones", "Delivery zones show on the map",
  ]);
  expect(tasks.every((item) => item.count === 1)).toBe(true);
  for (const [width, height] of [[1507, 1237], [1920, 1080], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/wall");
    await expect(page.locator('[data-site-row="menus.example"] [data-pace-window]')).toHaveText("to 12 PM");
    await expect(page.locator('[data-wall-feed] [data-feed-item]').first()).toContainText("Recipe cards load faster");
    await page.evaluate(() => document.fonts.ready);
    const found = await page.evaluate(() => {
      const brand = document.querySelector('[data-strip-home] .brand-mark')!.getBoundingClientRect();
      const clock = document.querySelector('[data-strip-clock-group]')!.getBoundingClientRect();
      const today = document.querySelector('[data-site-row="menus.example"] [data-site-today]')!;
      const cutoff = today.querySelector('[data-pace-window]')!;
      const chip = today.querySelector('[aria-label*="completed hours"]')!;
      const cell = today.getBoundingClientRect();
      const chart = today.querySelector('[data-site-chart]')!.getBoundingClientRect();
      const caption = cutoff.getBoundingClientRect();
      return {
        brandHeight: brand.height, clockHeight: clock.height,
        pace: chip.textContent, meaning: chip.getAttribute('aria-label'),
        cutoffPosition: getComputedStyle(cutoff).position,
        cutoffRight: cell.right - caption.right, cutoffBottom: cell.bottom - caption.bottom,
        cutoffBelowChart: caption.top >= chart.bottom - 1,
        cellWidth: cell.width, chartWidth: chart.width,
      };
    });
    expect(found.brandHeight).toBeGreaterThan(found.clockHeight * 0.55);
    expect(found.pace).toBe("6.9%");
    expect(found.meaning).toContain("6.9% ahead; completed hours today vs last Tue");
    expect(found.cutoffPosition).toBe("absolute");
    expect(Math.abs(found.cutoffRight)).toBeLessThan(1);
    expect(Math.abs(found.cutoffBottom)).toBeLessThan(1);
    expect(found.cutoffBelowChart).toBe(true);
    expect(found.chartWidth).toBeGreaterThan(found.cellWidth * 0.5);
    const measured = await page.evaluate(measureWallFit);
    if ("error" in measured) throw new Error(measured.error);
    expect(wallFitVerdict(measured).overWidth).toBeLessThanOrEqual(1);
    if (width > height) expect(wallFitVerdict(measured).fits).toBe(true);
    expect(measured.ink).toEqual([]);
    expect(measured.clipped).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`wall-feedback-${width}.png`), fullPage: width < height });
  }
});

test("the Wall's live feed shows the stored events newest first, and a new one arrives at the top within one poll", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the feed's arrival is a TV behaviour; the phone Wall stacks the same column");
  test.setTimeout(90_000);
  expect((await request.post("/__journey/wall-feed")).ok()).toBe(true);
  // No saved layout: D28's default places the feed (bead ro-trai.11).
  await page.route("**/api/wall", (route) => route.fulfill({ json: wallFixturePayload() }));
  await page.route("**/api/ga4/realtime", (route) => route.fulfill({ json: wallFixtureRealtime(20) }));
  await page.route("**/api/calendar/upcoming", (route) => route.fulfill({ json: wallFixtureCalendar() }));
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/wall");
  const feed = page.locator("[data-wall-feed]");
  const rows = feed.locator("li:not([data-feed-cut])");
  await expect(rows.first()).toContainText("Recipe cards load faster");
  await expect(feed).toHaveAttribute("data-feed-state", "live");
  // What the room walked in on arrives with no animation.
  await expect(feed.locator("li[data-feed-arrived]")).toHaveCount(0);
  // Every line draws at the Wall's body step, not a size it inherited: the
  // class combiner once dropped the step beside the line's ink (bead ro-trai.23).
  const lineSizes = await feed.locator("[data-feed-text]").evaluateAll((lines) =>
    lines.map((line) => {
      const style = getComputedStyle(line);
      const step = style.getPropertyValue("--wall-body-size").trim();
      const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
      return { drawn: parseFloat(style.fontSize), step: step.endsWith("rem") ? parseFloat(step) * rootPx : parseFloat(step) };
    }),
  );
  expect(lineSizes.length).toBeGreaterThan(0);
  for (const { drawn, step } of lineSizes) expect(drawn).toBe(step);
  // One list ramp (bead ro-trai.23, docs/25 § Type): a Needs you row and a
  // feed row draw their label, main line and meta at the same sizes, so
  // neither list reads louder than the other.
  await expect(page.locator("[data-wall-needs] [data-needs-row]")).toHaveCount(1);
  const ramp = await page.evaluate(() => {
    const size = (selector: string) => {
      const found = document.querySelector(selector);
      return found ? parseFloat(getComputedStyle(found).fontSize) : null;
    };
    return {
      needs: [size("[data-needs-site]"), size("[data-needs-line]"), size("[data-needs-age]")],
      feed: [size("[data-feed-label]"), size("[data-feed-text]"), size("[data-feed-time]")],
    };
  });
  expect(ramp.needs, "Needs you and the feed share one list ramp").toEqual(ramp.feed);
  expect(ramp.feed, "label, main line and meta at 1920").toEqual([14, 18, 14]);
  await feed.screenshot({ path: testInfo.outputPath("wall-feed-before.png") });

  const injected = await request.post("/__journey/wall-feed-event");
  expect(injected.ok()).toBe(true);
  const { text } = (await injected.json()) as { text: string };
  await expect(rows.first()).toContainText(text, { timeout: 40_000 });
  await expect(rows.first()).toHaveAttribute("data-feed-arrived", "");
  await expect(rows.first().locator("[data-feed-tint]")).toHaveCount(1);
  await expect(rows.nth(1)).toContainText("Recipe cards load faster");
  // Only whole rows: nothing drawn runs past the column.
  const cut = await feed.evaluate((section) => {
    const bottom = section.querySelector("ol")!.getBoundingClientRect().bottom;
    return [...section.querySelectorAll("li:not([data-feed-cut])")].filter((li) => li.getBoundingClientRect().bottom > bottom + 1).length;
  });
  expect(cut).toBe(0);
  await feed.screenshot({ path: testInfo.outputPath("wall-feed-after.png") });

  // The OS's own deploy reads NoticeOS, though its row stores another name
  // (bead ro-ujb9.77.10). It is the window's oldest line, so a taller TV shows it.
  await page.setViewportSize({ width: 1920, height: 1600 });
  const deployed = rows.filter({ hasText: "The OS moved to a newer version" });
  await expect(deployed).toBeVisible();
  await expect(deployed.locator("[data-feed-label]")).toHaveText("Deployed · NoticeOS");
  await expect(feed).not.toContainText(WALL_FEED_OS[1]);
  await feed.screenshot({ path: testInfo.outputPath("wall-feed-os-deploy.png") });
});

test("empty install → saved asset → fake connection and mapping → real metric reads → exact task and approval", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await createAsset(page);
  await page.goto("/integrations");
  // Bing connects in one panel over the list (bead ro-ujb9.96.7.1): paste,
  // Connect, the provider's answer. The ingest's real save-and-test runs; only
  // Bing's network answer is the fixture's (harness.ts journeyProviderNetwork).
  const row = page.locator('[data-integration-tile="bing-webmaster"]');
  await expect(row).toHaveAttribute("data-integration-status", "not-connected");
  await keyboardActivate(page, row.getByRole("button", { name: "Connect Bing Webmaster Tools", exact: true }));
  await expect(page).toHaveURL(/\/integrations$/);
  const panel = page.getByRole("dialog", { name: "Bing Webmaster Tools" });
  const key = panel.getByLabel("API key", { exact: true });
  await expect(key).toBeFocused();
  // A refused key is answered as a refusal, in plain words, and kept nowhere:
  // no green state, no stored credential.
  await key.fill("journey-wrong-key");
  await keyboardActivate(page, panel.getByRole("button", { name: "Connect", exact: true }));
  await expect(panel.locator('[data-connect-state="refused"]')).toHaveText("Bing Webmaster Tools refused this key");
  await expect(key).toHaveValue("");
  await expect(panel.getByText("Key accepted")).toHaveCount(0);
  expect((await (await page.request.get("/__journey/status")).json()).connected).toBe(false);
  // The right key: Checking, then Key accepted, and the account's sites in the
  // same panel (bead ro-ujb9.96.7.2): the journey's own site matched to the
  // asset by domain and ticked; the subdomain Bing never verified listed under
  // it, matched to nothing, never ticked. Nothing is saved yet.
  await key.fill(JOURNEY_KEY);
  await keyboardActivate(page, panel.getByRole("button", { name: "Connect", exact: true }));
  await expect(panel.getByText("Key accepted", { exact: true })).toBeVisible();
  const matched = panel.locator(`[data-site-row="${JOURNEY_ASSET}"]`);
  await expect(matched).toHaveAttribute("data-site-state", "matched");
  await expect(matched.getByRole("checkbox")).toBeChecked();
  await expect(matched.locator("[data-site-detail]")).toHaveText(JOURNEY_SITE);
  await expect(panel.locator('[data-other-site="https://blog.journey.example/"]')).toContainText("Not verified");
  const startButton = panel.getByRole("button", { name: /^Start collecting/ });
  await expect(startButton).toHaveText("Start collecting · 1 site");
  await expect(startButton).toBeFocused();
  const connected = await (await page.request.get("/__journey/status")).json();
  expect(connected.connected).toBe(true);
  expect(connected.tested).toBe(true);
  expect(connected.documents["config/integrations.json"].assets[JOURNEY_ASSET]["bing-webmaster"].siteUrl).toBeUndefined();
  // One press stored and proved the key: no separate save, no separate test.
  expect(connected.requests.filter((row: { path: string }) => /\/api\/integrations\/bing-webmaster\/(credential|test)$/.test(row.path))).toEqual([]);
  expect(connected.requests.filter((row: { method: string; path: string }) => row.method === "POST" && row.path === "/api/integrations/bing-webmaster/connect")).toHaveLength(2);
  await assertNoPageOverflow(page);
  // Start: the match is saved with the asset Data sources tab's own write, and
  // the first collection runs now through the nightly job's Bing step — the
  // real collector, answered by the fixture's Bing. The site reads Collecting,
  // then Working once its result is stored; never Working before.
  await page.keyboard.press("Enter");
  await expect(panel.locator('[data-sites-phase="started"]')).toBeVisible();
  await expect(matched.locator("[data-connection]")).toHaveAttribute("data-connection", "working");
  await expect(panel.getByRole("link", { name: "Open Journey Example", exact: true })).toBeFocused();
  const collected = await (await page.request.get("/__journey/status")).json();
  expect(collected.documents["config/integrations.json"].assets[JOURNEY_ASSET]["bing-webmaster"].siteUrl).toBe(JOURNEY_SITE);
  // The list was read once, and the press collected once.
  expect(collected.requests.filter((row: { method: string; path: string }) => row.method === "GET" && row.path === "/api/integrations/bing-webmaster/sites")).toHaveLength(1);
  expect(collected.requests.filter((row: { method: string; path: string }) => row.method === "POST" && row.path === "/api/integrations/bing-webmaster/collect")).toHaveLength(1);
  await assertNoPageOverflow(page);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(row).toHaveAttribute("data-integration-status", "working");
  // Connect the beads task source (D32, bead ro-ujb9.143): its project saved
  // and the runner's first snapshot filed. The task screens below appear.
  expect((await page.request.post("/__journey/task-source")).ok()).toBe(true);

  // The asset's Data sources row holds the saved site as its mapping, and
  // reads Working from the stored collection — its one status, with no setup
  // checklist restating it (bead ro-ujb9.96.7.4).
  await page.goto(`/assets/${JOURNEY_ASSET}/sources`);
  const bingRow = page.locator("#integrations li").filter({ has: page.getByRole("button", { name: /Bing Webmaster/ }) }).first();
  await expect(bingRow.locator("[data-connection]").first()).toHaveAttribute("data-connection", "working");
  await keyboardActivate(page, page.getByRole("button", { name: /Bing Webmaster/ }).first());
  const lane = page.locator('[data-lane-config="bing-webmaster"]');
  await expect(lane).toBeVisible();
  await expect(lane.getByLabel("Site", { exact: true })).toHaveValue(JOURNEY_SITE);
  await expect(page.locator("[data-lane-step]")).toHaveCount(0);
  await assertNoPageOverflow(page);

  // The collection recorded its monitoring result beside its run: the mapped
  // site's daily reports now work, while the report archive has still never
  // run. The site states it once: Working, and opened, the archive Collecting.
  await page.goto("/integrations?provider=bing-webmaster");
  const site = siteRow(page, "bing-webmaster", JOURNEY_ASSET);
  await expect(site.locator("[data-connection]").first()).toHaveAttribute("data-connection", "working");
  await keyboardActivate(page, site.locator("summary"));
  await expect(site.locator('[data-work="bing-archive"] [data-connection]')).toHaveAttribute("data-connection", "collecting");
  await page.goto("/integrations");
  await expect(tileHealth(page.locator('[data-integration-tile="bing-webmaster"]'))).toHaveAttribute("data-connection", "working");
  await assertNoPageOverflow(page);

  // Replacing the key happens on the connection itself (bead ro-ujb9.96.7.10):
  // the row's Manage opens it in the panel; Replace API key, paste, Connect.
  // The new key is shown to Bing before it is kept, and the panel ends on
  // Bing's answer — the rotation reads the account's sites no second time.
  await keyboardActivate(page, row.getByRole("button", { name: "Manage Bing Webmaster Tools", exact: true }));
  const connection = page.getByRole("dialog", { name: "Bing Webmaster Tools" });
  await expect(connection.locator('[data-status-for="integration:bing-webmaster"][data-connection]')).toHaveAttribute("data-connection", "working");
  await keyboardActivate(page, connection.getByRole("button", { name: "Replace API key", exact: true }));
  const replacement = connection.getByLabel("API key", { exact: true });
  await expect(replacement).toBeFocused();
  await replacement.fill(JOURNEY_KEY);
  await keyboardActivate(page, connection.getByRole("button", { name: "Connect", exact: true }));
  await expect(connection.getByText("Key accepted", { exact: true })).toBeVisible();
  await expect(connection.locator("[data-sites-start]")).toHaveCount(0);
  const rotated = await (await page.request.get("/__journey/status")).json();
  expect(rotated.requests.filter((row: { method: string; path: string }) => row.method === "POST" && row.path === "/api/integrations/bing-webmaster/connect")).toHaveLength(3);
  expect(rotated.requests.filter((row: { method: string; path: string }) => row.method === "GET" && row.path === "/api/integrations/bing-webmaster/sites")).toHaveLength(2);
  await assertNoPageOverflow(page);
  await keyboardActivate(page, connection.getByRole("button", { name: "Done", exact: true }));
  await expect(connection).toHaveCount(0);

  await page.goto(`/assets/${JOURNEY_ASSET}/growth?range=28`);
  const clicks = page.locator('[data-growth-chart="Clicks"]');
  await expect(page.getByRole("heading", { name: "Clicks", exact: true })).toBeVisible();
  await expect(page.locator("#search-performance")).toContainText("602");
  await keyboardActivate(page, page.getByRole("button", { name: "7d", exact: true }).first());
  await expect(page).toHaveURL(/range=7/);
  await expect(page.locator("#search-performance")).toContainText("224");
  await expect(clicks.locator("[data-growth-headline-period]")).toHaveAttribute("data-window-start", "2026-08-30");
  await expect(clicks.locator("[data-growth-headline-period]")).toHaveAttribute("data-window-end", "2026-09-05");
  await assertNoPageOverflow(page);
  for (const chart of await page.locator("[data-growth-chart]").all()) await assertContained(chart);
  await expect(page.locator("[data-hero-x-axis]")).toHaveCount(2);
  for (const axis of await page.locator("[data-hero-x-axis]").all()) {
    // Check the actual visible glyph boxes, not evenly spaced candidate slots.
    // This must catch the mobile Aug30/Aug31 and Sep4/Sep5 collisions.
    await expect.poll(async () => axis.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const labels = [...element.querySelectorAll<HTMLElement>("[data-hero-x-label]")];
      const issues: string[] = [];
      if (labels[0]?.dataset.heroXLabel !== "2026-08-30") issues.push("first date missing");
      if (labels.at(-1)?.dataset.heroXLabel !== "2026-09-05") issues.push("last date missing");
      for (let index = 0; index < labels.length; index += 1) {
        const label = labels[index]!;
        const rect = label.getBoundingClientRect();
        if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) issues.push(`${label.dataset.heroXLabel} outside axis`);
        const previous = labels[index - 1]?.getBoundingClientRect();
        if (previous && rect.left < previous.right + 3) issues.push(`${label.dataset.heroXLabel} overlaps previous label`);
      }
      return issues;
    })).toEqual([]);
  }
  const rangeSize = await page.getByRole("button", { name: "7d", exact: true }).first().boundingBox();
  expect(rangeSize).not.toBeNull();
  if (testInfo.project.name === "mobile") {
    expect(rangeSize!.width).toBeGreaterThanOrEqual(44);
    expect(rangeSize!.height).toBeGreaterThanOrEqual(44);
  }
  await keyboardActivate(page, clicks.getByRole("button", { name: "About Journey Example clicks over the last 7 days", exact: true }));
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  // How many of the headline days each provider reported, as counts (bead
  // `ro-ujb9.96.6.5`); the headline period itself is printed above the chart.
  await expect(tooltip).toContainText("Bing · 7 of 7 days");
  const tooltipSize = await tooltip.boundingBox();
  const viewport = page.viewportSize()!;
  expect(tooltipSize).not.toBeNull();
  expect(tooltipSize!.x).toBeGreaterThanOrEqual(0);
  expect(tooltipSize!.y).toBeGreaterThanOrEqual(0);
  expect(tooltipSize!.x + tooltipSize!.width).toBeLessThanOrEqual(viewport.width);
  expect(tooltipSize!.y + tooltipSize!.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press("Escape");
  await expect(tooltip).not.toBeVisible();
  // A selected visual artifact plus geometry assertions protects layout without
  // pretending a locally generated macOS PNG is an approved Linux golden.
  await testInfo.attach("growth-seven-completed-days", { body: await page.screenshot({ fullPage: true, animations: "disabled" }), contentType: "image/png" });
  // ARIA tabs have one tab stop. Arrow keys move within the bar; Enter opens.
  await keyboardFocus(page, page.getByRole("tab", { name: "Growth", exact: true }));
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/range=7/);
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Growth", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/growth\?range=7/);
  await expect(page.locator("#search-performance")).toContainText("224");

  await page.goto("/?range=7");
  await keyboardActivate(page, page.getByRole("link", { name: /Review the synthetic launch copy/ }));
  await expect(page).toHaveURL(/\/tasks\/jt-review$/);
  await expect(page.getByRole("heading", { name: /Review the synthetic launch copy/ })).toBeVisible();
  await keyboardActivate(page, page.getByRole("link", { name: "Back to overview", exact: true }));
  await expect(page).toHaveURL(/\/\?range=7$/);
  await keyboardActivate(page, page.getByRole("link", { name: /Approve the synthetic launch/ }));
  await expect(page).toHaveURL(/\/tasks\/jt-approve$/);
  await expect(page.getByRole("heading", { name: /Approve the synthetic launch/ })).toBeVisible();
  // Bead ro-ujb9.96.7.11: each decision is answered on its row. Approve is one
  // press; Answer opens a box, Enter sends. Each reaches `bd` through the real
  // task lane once its Undo window closes.
  await page.goto(`/tasks?project=${JOURNEY_ASSET}`);
  const status = async () => (await (await page.request.get("/__journey/status")).json()) as {
    tasks: { id: string; status: string }[]; taskCommands: string[][];
  };
  const gateRow = page.locator('[data-inbox-row="jt-approve"]');
  await keyboardActivate(page, gateRow.getByRole("button", { name: "Approve", exact: true }));
  await expect(gateRow).toHaveCount(0);
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Approved" })).toBeVisible();
  const askRow = page.locator('[data-inbox-row="jt-review"]');
  await keyboardActivate(page, askRow.getByRole("button", { name: "Answer", exact: true }));
  await expect(askRow.getByLabel("Your answer to jt-review")).toBeFocused();
  await page.keyboard.type("Approved wording: Plan meals in minutes");
  await page.keyboard.press("Enter");
  await expect(askRow).toHaveCount(0);
  // Neither answer is written inside its Undo window.
  expect((await status()).tasks.every((row) => row.status === "open")).toBe(true);
  await expect.poll(async () => (await status()).tasks.map((row) => `${row.id}:${row.status}`).sort(), { timeout: 20_000 })
    .toEqual(["jt-approve:closed", "jt-review:closed"]);
  const commands = (await status()).taskCommands.map((argv) => argv.slice(2).join(" "));
  expect(commands.some((line) => line.startsWith("gate resolve jt-approve --json --actor"))).toBe(true);
  expect(commands.some((line) => line.startsWith("human respond jt-review --response Approved wording: Plan meals in minutes --json --actor"))).toBe(true);
  await expect(page.locator("[data-waiting-list]")).toContainText("Nothing is waiting on you.");
  await assertNoPageOverflow(page);

  // A finding's File task: prefilled from the finding's own fields, filed
  // through the same lane in two presses on the page it is read on.
  expect((await page.request.post("/__journey/finding")).ok()).toBe(true);
  await page.goto(`/assets/${JOURNEY_ASSET}`);
  const finding = page.locator('[data-finding-row="journey-sitemap-drop"]');
  await keyboardActivate(page, finding.getByRole("button", { name: /^File task for Sitemap URLs fell/ }));
  const composer = page.getByRole("dialog", { name: "File a task" });
  await expect(composer.getByLabel("Title")).toHaveValue("Sitemap URLs fell from 120 to 80");
  await expect(composer.getByLabel("Description")).toHaveValue(/Sitemap URLs: -40\. Before: 120\. After: 80\. Evidence: http:\/\/127\.0\.0\.1:\d+\/assets\/journey\.example /);
  await expect(composer.locator('[data-composer-linked="finding"]')).toBeVisible();
  await composer.locator("[data-composer-submit]").click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: /^Filed jt-f/ })).toBeVisible();
  const created = (await status()).taskCommands.find((argv) => argv[2] === "create")!;
  expect(created[3]).toBe("Sitemap URLs fell from 120 to 80");
  expect(JSON.parse(created[created.indexOf("--metadata") + 1]!)).toMatchObject({ noticeos_kind: "finding", noticeos_key: "journey-sitemap-drop" });
  await assertNoPageOverflow(page);
  expect(pageErrors).toEqual([]);
});

// Everything inside a Sources row that is drawn past the row's own right edge.
// Named, so a failure says WHICH element pushed the page wider.
async function rowEscapes(page: Page) {
  return page.locator("#integrations").evaluate((section) => {
    const escapes: string[] = [];
    for (const row of section.querySelectorAll("li")) {
      const edge = row.getBoundingClientRect().right;
      for (const element of row.querySelectorAll<HTMLElement>("*")) {
        const box = element.getBoundingClientRect();
        if (box.width > 0 && box.right > edge + 1) {
          escapes.push(`${element.tagName.toLowerCase()} +${Math.round(box.right - edge)}px: ${(element.textContent ?? "").trim().slice(0, 60)}`);
        } else if (!["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName) && getComputedStyle(element).overflowX === "visible"
          && element.clientWidth > 0 && box.left + element.scrollWidth > edge + 1) {
          // Text drawn past its own box (an unbreakable word) moves no box edge.
          escapes.push(`${element.tagName.toLowerCase()} text +${Math.round(box.left + element.scrollWidth - edge)}px: ${(element.textContent ?? "").trim().slice(0, 60)}`);
        }
      }
    }
    return escapes;
  });
}

async function assertSourcesFit(page: Page, context: string) {
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  const escapes = size.scroll > size.width + 1 ? (await rowEscapes(page)).slice(0, 5).join(" | ") : "";
  expect(size.scroll, `page wider than the viewport ${context}: ${escapes}`).toBeLessThanOrEqual(size.width + 1);
}

// Bead ro-ujb9.79: opening a Sources row on a phone made the whole page scroll
// sideways. A doc reference that could not wrap stretched every open row, and a
// Google picker was as wide as its longest option.
// Bead ro-ujb9.121 (D29 amended): a site expects a nightly report once it has
// sent one. Right after the one-screen add on an empty install, no screen warns
// about a report the operator never set up, and the System fraction does not
// count the site: the header, the Overview's Data setup, Home's first-run
// guide, the Wall and Health's list of things to set up; Settings still offers
// No report. Once the first number turns Home into the dashboard (bead
// ro-ujb9.123), Home's System does not count the site either.
test("a new site raises no nightly-report warning anywhere, and the System fraction does not count it", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await createAsset(page);

  // The site's header: the neutral No report mark, never an amber "never".
  const header = page.locator("header").filter({ has: page.getByRole("heading", { name: /^Journey Example/, level: 1 }) });
  await expect(header.locator('[data-nightly-report="none"]')).toHaveText("No report");
  await expect(header.locator("[data-nightly-report-age]")).toHaveCount(0);
  await expect(header.locator('[data-age-state="never"]')).toHaveCount(0);
  // The setup list offers the report as an uncounted, optional step.
  await expect(page.locator('[data-setup-item="first-report"]')).toHaveAttribute("data-setup-state", "optional");
  await assertNoPageOverflow(page);

  await page.goto(`/assets/${JOURNEY_ASSET}`);
  const setup = page.getByRole("status").filter({ hasText: "Data setup" });
  await expect(setup).toBeVisible();
  await expect(setup).not.toContainText(/nightly report/i);

  // Home is still the first-run guide (bead ro-ujb9.123): the next step is a
  // source to connect, and nothing on it mentions a nightly report.
  await page.goto("/");
  const guide = page.locator("[data-first-run]");
  await expect(guide.locator('[data-first-run-state="current"]')).toContainText("Connect Bing Webmaster Tools");
  await expect(guide).not.toContainText(/nightly report/i);
  await expect(page.locator('[data-kpi="System"]')).toHaveCount(0);

  await page.goto("/wall");
  await expect(page.getByText("Journey Example").first()).toBeVisible();
  await expect(page.getByText("nightly reports fresh")).toHaveCount(0);
  await expect(page.getByText("Waiting for first report")).toHaveCount(0);

  await page.goto("/health");
  await expect(page.getByText("Source history").first()).toBeVisible();
  await expect(page.getByText("Finish setup on Journey Example")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Other sources", exact: true })).not.toContainText(/nightly report/i);

  await page.goto(`/assets/${JOURNEY_ASSET}/settings`);
  await expect(page.getByRole("button", { name: "Not set up", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "No report", exact: true })).toBeEnabled();

  // The first number arrives — Bing collected through its connect panel, still
  // no nightly report — so Home is the dashboard, and its System fraction does
  // not count the site.
  await page.goto(`/integrations?connect=bing-webmaster&asset=${JOURNEY_ASSET}`);
  const panel = page.locator('[data-connect-panel="bing-webmaster"]');
  await panel.getByLabel("API key", { exact: true }).fill(JOURNEY_KEY);
  await panel.getByRole("button", { name: "Connect", exact: true }).click();
  await panel.locator("[data-sites-start]").click();
  await expect(panel.locator('[data-site-row] [data-connection="working"]').first()).toBeVisible({ timeout: 60_000 });
  await page.goto("/");
  await expect(page.locator("[data-first-run]")).toHaveCount(0);
  const system = page.locator('[data-kpi="System"]');
  await expect(system).toContainText("nothing expected to report");
  await expect(system).not.toContainText("fresh");
  await expect(system.locator("[data-coverage-split]")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

// Archive is the one way out of the site list (bead ro-ujb9.76.4.5), so adding
// an archived site's domain again is the way back: "Already added" opens the
// site that holds the domain, never a page for the id just typed (bead
// ro-ujb9.76.4.6), on its Settings tab at Restore, and nothing offers Delete.
for (const status of ['retired', 'live'] as const) {
  test(status === 'retired'
    ? "adding an archived site's domain again opens that site at Restore, and nothing offers Delete"
    : "adding an active site's domain again opens that site before the wall loads", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const seeded = await page.request.post(`/__journey/archived-site?status=${status}`);
    expect(seeded.ok()).toBe(true);
    const { id, domain } = (await seeded.json()) as { id: string; domain: string };
    expect(id).not.toBe(domain);

    // The duplicate refusal can beat the unrelated Wall read. Keep that read
    // pending until the link has been followed, reproducing ro-p190 deterministically.
    let releaseWall!: () => void;
    let wallStarted!: () => void;
    const pendingWall = new Promise<void>(resolve => { releaseWall = resolve; });
    const requestedWall = new Promise<void>(resolve => { wallStarted = resolve; });
    await page.route('**/api/wall', async route => { wallStarted(); await pendingWall; await route.fallback(); });
    try {
      await page.goto("/assets/new");
      await requestedWall;
      const sheet = page.getByRole("dialog", { name: "Add a site" });
      await sheet.getByLabel("Domain", { exact: true }).fill(domain);
      await sheet.getByRole("button", { name: "Add site", exact: true }).click();
      const issue = sheet.locator('[data-add-site-issue="exists"]');
      await expect(issue).toContainText("Already added");
      await expect(issue.getByRole("link")).toHaveText(`Open ${id}`);
      await assertNoPageOverflow(page);

      const destination = `/assets/${id}${status === 'retired' ? '/settings#restore' : ''}`;
      await expect(issue.getByRole('link')).toHaveAttribute('href', destination);
      await issue.getByRole("link").click();
      await expect(page).toHaveURL(new RegExp(`${destination}$`));
      releaseWall();
      if (status === 'retired') {
        const restore = page.locator("#restore");
        await expect(restore.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
        await expect(restore).toBeInViewport();
      }
      await expect(page.getByRole("button", { name: /Delete/ })).toHaveCount(0);
      await assertNoPageOverflow(page);

      // The refusal wrote nothing: the one site retains its stored lifecycle.
      const state = await (await page.request.get("/__journey/status")).json();
      expect(state.assets).toEqual([{ id, display_name: "Archived Example", status }]);
      expect(state.requests.filter((row: { method: string; path: string }) => row.method === "POST" && row.path === "/api/assets")).toHaveLength(1);
      expect(pageErrors).toEqual([]);
    } finally { releaseWall(); }
  });
}

test("PostHog connects with one key: the region found, the project matched by domain, its saved funnels picked up and collected", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  expect((await page.request.post("/__journey/every-source")).ok()).toBe(true);
  await createAsset(page);
  await page.goto("/integrations");
  // Bead ro-ujb9.96.7.8: one field, the access it needs as chips, no region
  // or project to type.
  await page.locator('[data-integration-tile="posthog"]').getByRole("button", { name: "Connect PostHog", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "PostHog" });
  await expect(panel.locator("input")).toHaveCount(1);
  await expect(panel.getByRole("list", { name: "Personal API key access" })).toContainText("Insight: read");
  await panel.getByLabel("Personal API key", { exact: true }).fill(JOURNEY_KEY);
  await keyboardActivate(page, panel.getByRole("button", { name: "Connect", exact: true }));
  // The US cloud accepted the synthetic key; the EU one refused it.
  await expect(panel.locator('[data-connect-state="accepted"]')).toHaveText("Key accepted · US");
  const row = panel.locator(`[data-site-row="${JOURNEY_ASSET}"]`);
  await expect(row).toHaveAttribute("data-site-state", "matched");
  await expect(row.locator("[data-site-detail]")).toHaveText("Journey Example · 596607");
  await expect(row).toContainText("2 funnels");
  await expect(panel.locator('[data-other-site="us:596608"]')).toContainText("Staging");
  await assertNoPageOverflow(page);
  await panel.locator("[data-sites-start]").click();
  await expect(row.locator("[data-connection]")).toHaveAttribute("data-connection", "working", { timeout: 60_000 });
  // Start wrote what the Data sources row would: region, project and the
  // project's saved funnels — never typed.
  const state = await (await page.request.get("/__journey/status")).json();
  const saved = state.documents["config/integrations.json"].assets[JOURNEY_ASSET].posthog;
  expect(saved).toMatchObject({ host: "us", projectId: "596607" });
  expect(saved.funnels.map((funnel: { id: string }) => funnel.id)).toEqual(["signup", "checkout"]);
  expect(saved.funnels[1].steps[0]).toEqual({ event: "$pageview", path: "/pricing" });
  expect(state.requests.filter((request: { method: string; path: string }) => request.method === "GET" && request.path === "/api/integrations/posthog/sites")).toHaveLength(1);
  expect(pageErrors).toEqual([]);
});

/** Google's client_secret.json as the Cloud console downloads it for a web
 * client (the fixture's synthetic client, harness.ts). */
function googleClientFile(redirectUris: string[], type: "web" | "installed" = "web") {
  const json = JSON.stringify({ [type]: { client_id: "journey-client.apps.googleusercontent.com", client_secret: JOURNEY_KEY, redirect_uris: redirectUris } });
  return { name: "client_secret_journey.json", mimeType: "application/json", buffer: Buffer.from(json) };
}

test("Google connects in the panel: the client file dropped, signed in, GA4 and Search Console matched on one row and collected", async ({ page, baseURL }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installGoogleConsent(page.context(), baseURL!);
  expect((await page.request.post("/__journey/every-source")).ok()).toBe(true);
  await createAsset(page);
  await page.goto("/integrations");
  // Bead ro-ujb9.96.7.7: self-hosted, the one-time setup is the panel itself —
  // two deep links into the Cloud console, the redirect address with Copy,
  // and the client file.
  await page.locator('[data-integration-tile="google"]').getByRole("button", { name: "Connect Google", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Google" });
  await expect(panel.locator('[data-google-setup="self-hosted"]')).toBeVisible();
  const redirect = `${baseURL}/api/integrations/google/oauth/callback`;
  await expect(panel.locator("[data-google-redirect-uri]")).toHaveText(redirect);
  await expect(panel.locator('[data-google-step="1"] a')).toHaveAttribute("href", /flows\/enableapi\?apiid=analyticsdata\.googleapis\.com,analyticsadmin\.googleapis\.com,searchconsole\.googleapis\.com/);
  await expect(panel.locator("[data-google-testing]")).toContainText("7 days");
  // Nothing to sign in with yet.
  await expect(panel.locator("[data-google-continue]")).toBeDisabled();
  // A desktop client's file is not a web client: refused, nothing stored.
  await panel.getByLabel("client_secret.json", { exact: true }).setInputFiles(googleClientFile([redirect], "installed"));
  await expect(panel.locator("[data-google-client-refused]")).toHaveText("Not a web client");
  // The web client's file, downloaded before this Tower's address was added:
  // stored, and the missing address said.
  await panel.getByLabel("client_secret.json", { exact: true }).setInputFiles(googleClientFile(["http://127.0.0.1:1/elsewhere"]));
  await expect(panel.locator('[data-google-client-file="stored"]')).toBeVisible();
  await expect(panel).toContainText("Redirect address not in the client");
  await assertNoPageOverflow(page);
  // Continue with Google: consent (answered as Allow), back on the panel with
  // the account's sites — GA4 by its web stream's address and Search Console
  // by its domain property, both on the site's one row.
  await panel.locator("[data-google-continue]").click();
  const back = page.getByRole("dialog", { name: "Google" });
  const row = back.locator(`[data-site-row="${JOURNEY_ASSET}"]`);
  await expect(row).toHaveAttribute("data-site-state", "matched matched", { timeout: 15_000 });
  await expect(row.locator("[data-site-detail]")).toHaveText(`GA4 313598867 · sc-domain:${JOURNEY_ASSET}`);
  await expect(back.locator('[data-other-site="402211876"]')).toContainText("Another site");
  await expect(back.locator('[data-status-for="integration:google"]').first()).toContainText("Signed in");
  await back.locator("[data-sites-start]").click();
  await expect(row.locator("[data-connection]")).toHaveAttribute("data-connection", "working", { timeout: 60_000 });
  // Start wrote what the Data sources rows would, on both lanes.
  const state = await (await page.request.get("/__journey/status")).json();
  const assets = state.documents["config/integrations.json"].assets[JOURNEY_ASSET];
  expect(assets.ga4).toMatchObject({ propertyId: "313598867" });
  expect(assets.gsc).toMatchObject({ siteUrl: `sc-domain:${JOURNEY_ASSET}` });
  expect(pageErrors).toEqual([]);
});

test("Google, hosted: the installation's own client makes the panel one button", async ({ page, baseURL }) => {
  await installGoogleConsent(page.context(), baseURL!);
  expect((await page.request.post("/__journey/every-source")).ok()).toBe(true);
  expect((await page.request.post("/__journey/google-hosted")).ok()).toBe(true);
  await createAsset(page);
  await page.goto("/integrations");
  await page.locator('[data-integration-tile="google"]').getByRole("button", { name: "Connect Google", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Google" });
  await expect(panel.locator('[data-google-setup="hosted"]')).toBeVisible();
  await expect(panel.getByRole("list", { name: "Google access" })).toContainText("Search Console · read only");
  // No console step, no file, no Testing warning: the host's client is verified.
  await expect(panel.locator("[data-google-step]")).toHaveCount(0);
  await expect(panel.locator("[data-google-testing]")).toHaveCount(0);
  await panel.locator("[data-google-continue]").click();
  const row = page.getByRole("dialog", { name: "Google" }).locator(`[data-site-row="${JOURNEY_ASSET}"]`);
  await expect(row).toHaveAttribute("data-site-checked", "", { timeout: 15_000 });
  await page.getByRole("dialog", { name: "Google" }).locator("[data-sites-start]").click();
  await expect(row.locator("[data-connection]")).toHaveAttribute("data-connection", "working", { timeout: 60_000 });
});

test("a press the Tower answers with a redirect to another site never leaves the fixture, and the test names the URL (bead ro-o3hv)", async ({ page, offlineGuard }) => {
  const failed = await page.goto("/__journey/redirect-away").then(() => null, (error: Error) => error);
  expect(failed, "the proxy refused the foreign redirect before returning it").toBeInstanceOf(Error);
  expect(page.url()).not.toContain("example.com");
  expect(offlineGuard.escapes()).toEqual(["https://example.com/"]);
  expect(offlineGuard.check()).toContain("attempted to leave the fixture for https://example.com/");
  // Provoked on purpose: the guard's own teardown would fail this test on it.
  offlineGuard.clear();
});

test("a revoked Google sign-in says so on Integrations in one short line, the ingest's own words (bead ro-ujb9.96.6.24)", async ({ page, baseURL }, testInfo) => {
  await installGoogleConsent(page.context(), baseURL!);
  expect((await page.request.post("/__journey/every-source")).ok()).toBe(true);
  expect((await page.request.post("/__journey/google-hosted")).ok()).toBe(true);
  await createAsset(page);
  await page.goto("/integrations");
  await page.locator('[data-integration-tile="google"]').getByRole("button", { name: "Connect Google", exact: true }).click();
  await page.getByRole("dialog", { name: "Google" }).locator("[data-google-continue]").click();
  await expect(page.getByRole("dialog", { name: "Google" }).locator(`[data-site-row="${JOURNEY_ASSET}"]`))
    .toHaveAttribute("data-site-checked", "", { timeout: 15_000 });
  const revoked = await (await page.request.post("/__journey/google-revoked")).json() as { lastError: string };
  await page.goto("/integrations?provider=google");
  const verdict = page.locator('[data-verdict="stored-verdict"]');
  await expect(verdict).toHaveText(new RegExp(revoked.lastError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await expect(verdict).toHaveAttribute("data-verdict-ok", "false");
  // A failure's budget (docs/21 principle 3a): what happened, in the words the
  // ingest stamped; the ways out are the card's presses, not the sentence.
  const words = revoked.lastError.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  expect(words).toBeLessThanOrEqual(18);
  await verdict.scrollIntoViewIfNeeded();
  await testInfo.attach("google-revoked-verdict", { body: await page.screenshot(), contentType: "image/png" });
});

test("a refused property id shows the format to enter", async ({ page }, testInfo) => {
  expect((await page.request.post("/__journey/every-source")).ok()).toBe(true);
  await createAsset(page);
  const sources = page.getByRole("region", { name: "Data sources", exact: true });
  await sources.getByRole("button", { name: /^Google Analytics/ }).click();
  const mapping = page.locator('[data-lane-config="ga4"]');
  const input = mapping.getByLabel("GA4 property id", { exact: true });
  await input.fill("G-123");
  await mapping.getByRole("button", { name: "Save", exact: true }).click();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await input.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("refused-property-id.png") });
  await expect(mapping.getByText("GA4 property id: digits only, e.g. 313598867", { exact: true })).toBeVisible();
  await assertNoPageOverflow(page);
  const state = await (await page.request.get("/__journey/status")).json();
  expect(state.documents["config/integrations.json"].assets[JOURNEY_ASSET].ga4.propertyId).not.toBe("G-123");
});

test("every Sources row opens on a phone without widening the page, and long references wrap", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  expect((await page.request.post("/__journey/every-source")).ok()).toBe(true);
  await createAsset(page);
  // External boundary: what a connected Google account lists. Synthetic, and as
  // long as real property names get.
  await page.route("**/api/integrations/google/properties", (route) => route.fulfill({ json: {
    ok: true, message: "The synthetic account listed its properties.", checkedAt: "2026-09-06T12:00:00.000Z",
    account: "journey-operator@example.test", auth: "oauth",
    properties: [
      { lane: "ga4", ref: "313598867", label: "Journey Example — production web stream (all traffic)", detail: "Journey Example Holdings International" },
      { lane: "gsc", ref: "sc-domain:journey-example-with-a-long-subdomain.example", label: "sc-domain:journey-example-with-a-long-subdomain.example", detail: "siteFullUser" },
    ],
  } }));
  await page.goto(`/assets/${JOURNEY_ASSET}/sources`);
  const sources = page.getByRole("region", { name: "Data sources", exact: true });
  await expect(sources).toBeVisible();
  // A reason naming a long identifier: no space, slash or hyphen to break at.
  // Written through the real config lane as the operator's own words on Not
  // using (bead ro-ujb9.96.7.13), and shown once — as the row's caption, never
  // as a paragraph under the row (bead ro-ujb9.96.6.4).
  const longId = "BING_WEBMASTER_API_KEY_JOURNEY_EXAMPLE_WITH_A_LONG_SUBDOMAIN_PRODUCTION";
  await sources.getByRole("button", { name: /^Bing Webmaster Tools/ }).click();
  await page.locator('[data-lane-decline="bing-webmaster"]').click();
  const reasons = page.locator("[data-decline-reasons]");
  await reasons.locator('[data-decline-reason="other"]').click();
  await reasons.getByLabel("Your reason", { exact: true }).fill(longId);
  await reasons.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
  await expect(sources.locator("[data-lane-reason]", { hasText: longId })).toHaveCount(1);
  await expect(sources.locator("p", { hasText: longId })).toHaveCount(0);
  await assertSourcesFit(page, "after declining with a reason that names a long identifier");
  const more = sources.getByRole("button", { name: /^Show \d+ more$/ });
  if (await more.count()) await more.click();
  // More sources is open on arrival (bead ro-ujb9.164); only its own rows past three are behind a press.
  const othersMore = page.getByRole("region", { name: "More sources", exact: true }).getByRole("button", { name: /^Show \d+ more$/ });
  if (await othersMore.count()) await othersMore.click();
  // One row at a time, so a regression names the row that widened the page.
  const collapsed = page.locator("#integrations li > button[aria-expanded='false'], #integrations li > div > div > button[aria-expanded='false']");
  while (await collapsed.count()) {
    const row = collapsed.first();
    const label = (await row.textContent())?.trim().slice(0, 40);
    await row.click();
    await assertSourcesFit(page, `after opening ${label}`);
  }
  const closedDetails = page.locator("#integrations details:not([open]) > summary");
  while (await closedDetails.count()) await closedDetails.first().click();
  // A source with something to map opens on it; one with nothing to map
  // (Clarity) has no settings to open (bead ro-ujb9.96.7.4).
  for (const lane of ["gsc", "bing-webmaster", "ga4", "posthog", "dataforseo"]) {
    await expect(page.locator(`[data-lane-config="${lane}"]`)).toBeVisible();
  }
  await expect(page.locator('[data-lane-config="clarity"]')).toHaveCount(0);
  // Uptime has no card on Integrations to connect it: no row at all, so no
  // dead Connect (bead ro-ujb9.133).
  await expect(page.locator("#integrations").getByText("Uptime monitoring")).toHaveCount(0);
  await expect(page.locator('[data-lane-config="uptime"], [data-source-connect="uptime"]')).toHaveCount(0);
  // Ad revenue, not connected: its Connect is the row's one action, and no
  // revenue section is drawn under it (bead ro-ujb9.96.7.6).
  await expect(page.locator('[data-source-connect="ad-network"]')).toBeVisible();
  await expect(page.getByRole("region", { name: "Mediavine revenue", exact: true })).toHaveCount(0);
  await expect(page.locator('[data-lane-picker="ga4"][data-lane-picker-state="ready"]')).toBeVisible();
  await page.locator('[data-lane-config="posthog"]').getByRole("button", { name: "Add funnel", exact: true }).click();
  await expect(page.locator('[data-lane-config="posthog"] [data-funnel-step]')).toHaveCount(2);

  await assertSourcesFit(page, "with every row, disclosure and a new funnel open");
  expect(await rowEscapes(page)).toEqual([]);

  const mobile = testInfo.project.name === "mobile";
  // No row carries a documentation path or a setup checklist: its one action
  // is how it gets set up (bead ro-ujb9.96.7.4).
  await expect(page.locator("#integrations [data-lane-doc-ref]")).toHaveCount(0);
  await expect(page.locator("#integrations [data-lane-step]")).toHaveCount(0);
  if (mobile) {
    for (const toggle of await page.locator("#integrations li > button[aria-expanded='true'], #integrations li > div > div > button[aria-expanded='true']").all()) {
      expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  }
  await testInfo.attach("sources-every-row-open", { body: await page.screenshot({ fullPage: true, animations: "disabled" }), contentType: "image/png" });
  expect(pageErrors).toEqual([]);
});

// Real stored counters, their read age and absent values (ro-ujb9.76.58).
for (const minutesAgo of [10, 40]) {
  test(`stored counters show all-time totals and their ${minutesAgo}-minute age`, async ({ page }, testInfo) => {
    await createAsset(page);
    const seeded = await page.request.post(`/__journey/counters?minutesAgo=${minutesAgo}`);
    expect(seeded.ok()).toBe(true);
    await page.goto(`/assets/${JOURNEY_ASSET}`);
    const totals = page.getByRole("region", { name: "All-time totals" });
    await expect(totals).toBeVisible();
    await expect(totals.locator(".bg-card")).toHaveCount(2);
    for (const [label, value] of [["Accounts", "1,284"], ["Leads", "312"]] as const) {
      const card = totals.locator(".bg-card").filter({ has: page.getByText(label, { exact: true }) });
      await expect(card).toContainText(value);
      const age = card.locator("[data-age-state]");
      await expect(age).toHaveText(minutesAgo === 40 ? "40m · stale" : "10m");
      await expect(age.locator("[data-age-glyph]")).toHaveAttribute("data-age-glyph", minutesAgo === 40 ? "stale" : "aged");
      if (minutesAgo === 40) await expect(age).toHaveClass(/\btext-warn\b/);
      else await expect(age).not.toHaveClass(/\btext-warn\b/);
    }
    await expect(totals.getByText("Plans saved", { exact: true })).toHaveCount(0);
    await assertNoPageOverflow(page);
    await testInfo.attach(`stored-counters-${minutesAgo}m`, {
      body: await totals.screenshot({ animations: "disabled" }), contentType: "image/png",
    });
  });
}

// Bead ro-ujb9.165: uptime needs no account and no connect step. The OS checks
// each site's home page itself every hour (the production ingest lane, over
// the fixture store; only the site's answer is the fixture's). The Data
// sources row reads Up with when it was checked, then Down with what the page
// answered, and a site that is down is an error alert.
test("a site's uptime row reads Up, stays Up after one failed try, then Down with an error alert when the retry fails too", async ({ page }) => {
  expect((await page.request.post("/__journey/every-source")).ok()).toBe(true);
  await createAsset(page);
  // Before its first check a site has no uptime row: nothing to set up.
  await expect(page.locator('[data-status-for="source:journey.example:uptime"]')).toHaveCount(0);

  expect((await page.request.post("/__journey/uptime?status=200&minutesAgo=100")).ok()).toBe(true);
  await page.reload();
  const row = () => page.locator("#integrations li").filter({ hasText: "Uptime monitoring" });
  await expect(row().locator('[data-connection="working"]')).toHaveText("Up");
  await expect(row().locator("[data-uptime-check]")).toHaveText("checked 1h ago");
  await expect(row().locator("[data-source-connect]")).toHaveCount(0);

  // Bead ro-ujb9.180: one failed GET that the retry answers is not Down. The
  // row stays Up and says so; no alert is filed.
  const blip = await page.request.post("/__journey/uptime?status=503&transient=1&minutesAgo=50");
  expect(await blip.json()).toMatchObject({ checked: 1, retried: 1, fired: 0 });
  await page.reload();
  await expect(row().locator('[data-connection="working"]')).toHaveText("Up");
  await expect(row().locator("[data-uptime-check]")).toHaveText("checked 50m ago · 1 failed try");

  // Two failures in a row are.
  expect((await page.request.post("/__journey/uptime?status=503&minutesAgo=5")).ok()).toBe(true);
  await page.reload();
  await expect(row().locator('[data-connection="failing"]')).toHaveText("Down");
  await expect(row().locator("[data-uptime-check]")).toHaveText("HTTP 503 · checked 5m ago");
  // The header's source mark says the same word.
  await expect(page.getByRole("img", { name: "Uptime monitoring: Down" })).toBeVisible();
  // …and the site's Alerts carry it, as the existing home-page alert.
  await page.goto(`/assets/${JOURNEY_ASSET}/alerts`);
  await expect(page.getByText("Home page check failed — HTTP 503").first()).toBeVisible();
});

// Bead ro-ujb9.220: every failed nightly fetch keeps its own record. The
// production pull lane runs three nights over the fixture store (only the
// site's answer is the fixture's): 503 "unconfigured", then 401 twice. The
// alert speaks for last night; the site's Data sources tab and the alert's
// Evidence list every night, so the first night's 503 is still readable.
test("a site whose nightly fetch fails lists each failed night on Data sources and in the alert's Evidence", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await createAsset(page);
  const run = await page.request.post("/__journey/fetch-failures?nights=3");
  expect(run.ok()).toBe(true);
  expect((await run.json()).outcomes).toMatchObject([
    { ok: false, status: 503, evidence: "recorded" },
    { ok: false, status: 401, evidence: "recorded" },
    { ok: false, status: 401, evidence: "recorded" },
  ]);

  await page.goto(`/assets/${JOURNEY_ASSET}/sources`);
  const rows = page.locator("[data-fetch-failure]");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("401 unauthorized");
  await expect(rows.nth(0)).toContainText("22h ago");
  await expect(rows.nth(2)).toContainText("503 unconfigured");
  await expect(rows.nth(2)).toContainText("2d ago");
  await expect(rows.nth(0)).toHaveAttribute("data-fetch-failure", "ongoing");

  await page.goto(`/assets/${JOURNEY_ASSET}/alerts`);
  const alert = page.locator("li").filter({ hasText: "Nightly report fetch failing 3 nights — latest: 401 unauthorized" }).first();
  await expect(alert).toBeVisible();
  await alert.locator("button[aria-expanded='false']").first().click();
  await alert.locator("[data-evidence-trigger]").click();
  const panel = page.locator("[data-evidence-panel]");
  await expect(panel).toContainText("503 unconfigured — Overview unavailable: set CF_ACCOUNT_ID");
  // One row per night; the count row ("Failed fetches · 3 since the first") is its own.
  await expect(panel.locator("li").filter({ hasText: /Failed fetch(?!es)/ })).toHaveCount(3);
  expect(pageErrors).toEqual([]);
});

// Bead ro-ujb9.166: a new site's Settings scrolled 24px sideways at 768 wide,
// because its report's auth row printed the environment binding
// (`ASSET_TOKENS['journey.example']`) as one unbreakable line. It is a state
// now — "Site token", locked, "Never shown" — and the page fits at every width.
test("a new site's Settings fits a tablet, a laptop and a phone, and names its token without the binding", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "walks the tablet, laptop and phone widths itself");
  await createAsset(page);
  for (const [width, height] of [[768, 1024], [1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`/assets/${JOURNEY_ASSET}/settings`);
    const auth = page.locator("[data-secret-pointer]");
    await expect(auth).toContainText("Site token");
    await expect(auth).toContainText("Never shown");
    await expect(page.locator("main")).not.toContainText("ASSET_TOKENS");
    const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(size.scroll, `Settings wider than a ${width}px screen`).toBe(size.width);
    // Bead ro-ujb9.169: the Panel refresh table fits its own box too. At 768
    // its card is ~450px wide, so its rows reflow into labelled cards rather
    // than hiding Since and the row's actions behind a sideways scroll.
    const panel = page.locator("table[data-stacked]").filter({ has: page.locator('td[data-label="Since"]') });
    const fit = await panel.evaluate((table) => ({
      table: [table.scrollWidth, table.clientWidth],
      box: [table.parentElement!.scrollWidth, table.parentElement!.clientWidth],
    }));
    expect(fit.table[0], `the Panel refresh table scrolls sideways at ${width}px`).toBe(fit.table[1]);
    expect(fit.box[0], `the Panel refresh box scrolls sideways at ${width}px`).toBe(fit.box[1]);
    const since = await panel.locator('td[data-label="Since"]').boundingBox();
    expect(since && since.x + since.width, `Since is off the right edge at ${width}px`).toBeLessThanOrEqual(width);
  }
});

test("a failed setup save is recoverable without duplicate creation or false success", async ({ page }, testInfo) => {
  await createAsset(page, true);
  await assertNoPageOverflow(page);
  const state = await (await page.request.get("/__journey/status")).json();
  expect(state.requests.filter((row: { path: string; status: number }) => row.path === "/api/config" && row.status === 503)).toHaveLength(1);
  expect(state.documents["config/integrations.json"].assets[JOURNEY_ASSET]).toBeDefined();
  await testInfo.attach("recovered-asset", { body: await page.screenshot({ fullPage: true, animations: "disabled" }), contentType: "image/png" });
});

// Beads ro-ujb9.123 and ro-ujb9.124: Home keeps the three steps until the
// first number, each step opens this site's own next screen, and the number
// lands on a chart of itself.
test("Home first-run actions keep their destinations and phone touch targets in every state", async ({ page }, testInfo) => {
  const guide = page.locator("[data-first-run]");
  const phone = (page.viewportSize()?.width ?? 0) < 640;
  const checkActions = async (state: string) => {
    for (const action of await guide.locator("a, button").all()) {
      const box = await action.boundingBox();
      expect(box, `${state}: ${await action.textContent()} has a target`).not.toBeNull();
      if (phone) {
        expect(box!.width, `${state}: target width`).toBeGreaterThanOrEqual(44);
        expect(box!.height, `${state}: target height`).toBeGreaterThanOrEqual(44);
      }
      await assertContained(action);
    }
    await assertNoPageOverflow(page);
  };
  const capture = async (state: string) => testInfo.attach(`first-run-${state}`, {
    body: await page.screenshot({ fullPage: true, animations: "disabled" }), contentType: "image/png",
  });

  await page.goto("/");
  await expect(guide).toBeVisible();
  await expect(guide.locator('[data-first-run-state="current"]')).toContainText("Add your first site");
  await expect(guide.getByRole("link", { name: "See your first number" })).toHaveCount(0);
  const connect = guide.getByRole("link", { name: "Connect a source", exact: true });
  await expect(connect).toHaveAttribute("href", "/integrations");
  await checkActions("empty");
  await keyboardFocus(page, connect);
  await expect(connect).toBeFocused();
  expect(await connect.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
  await capture("empty");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/integrations$/);

  await createAsset(page);
  await page.goto("/");
  await expect(guide.locator('[data-first-run-state="current"]')).toContainText("Connect Bing Webmaster Tools");
  await expect(guide.getByRole("link", { name: "Connect Bing Webmaster Tools", exact: true }))
    .toHaveAttribute("href", `/integrations?connect=bing-webmaster&asset=${JOURNEY_ASSET}`);
  const number = guide.getByRole("link", { name: "See your first number", exact: true });
  await expect(number).toHaveAttribute("href", `/assets/${JOURNEY_ASSET}`);
  await checkActions("added");
  await keyboardFocus(page, number);
  await expect(number).toBeFocused();
  expect(await number.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
  await capture("added");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/assets/${JOURNEY_ASSET.replaceAll(".", "\\.")}$`));

  // Saved read responses model collection before its first result. No Connect,
  // Start or provider request is issued to make this presentation state.
  await page.route("**/api/integrations/providers", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const provider = data.providers.find((entry: { provider: { id: string } }) => entry.provider.id === "bing-webmaster");
    expect(provider).toBeDefined();
    const at = new Date().toISOString();
    provider.credential = { provider: "bing-webmaster", source: "store", fields: [], assetsHeld: [], missingFields: [], auth: null,
      metadata: null, keyVersion: 1, createdAt: at, updatedAt: at, lastUsedAt: at, lastOkAt: at, lastError: null };
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/integrations/health", (route) => route.fulfill({ json: {
    generatedAt: new Date().toISOString(), available: true, events: [], items: [{
      id: "bing-daily", provider: "bing-webmaster", capability: "bing-daily", label: "Bing daily reports", asset: JOURNEY_ASSET,
      detail: null, report: null, reportDate: null, state: "never-run", lastAttemptAt: null, lastSuccessAt: null,
      nextAttemptAt: null, failure: null, code: null, action: "Review the verified site and Bing connection.", coverage: "monitored",
    }],
  } }));
  await page.goto("/");
  await expect(guide.locator('[data-first-run-state="done"]')).toHaveCount(2);
  await expect(guide.locator('[data-first-run-state="current"]')).toContainText("See your first number");
  await expect(guide.getByRole("link", { name: "Connect Bing Webmaster Tools", exact: true })).toHaveCount(0);
  await expect(number).toHaveAttribute("href", `/assets/${JOURNEY_ASSET}`);
  await checkActions("collecting");
  await keyboardFocus(page, number);
  await expect(number).toBeFocused();
  await capture("collecting");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/assets/${JOURNEY_ASSET.replaceAll(".", "\\.")}$`));
});

test("Home guides a new site to its first number, then becomes the dashboard", async ({ page }) => {
  await createAsset(page);
  await page.goto("/");
  const guide = page.locator("[data-first-run]");
  await expect(guide.locator('[data-first-run-state="done"]')).toHaveText("Step 1Journey Example added");
  await expect(page.locator("[data-kpi-strip]")).toHaveCount(0);
  // Step 2 opens this site's first source in the connect panel.
  await keyboardActivate(page, guide.getByRole("link", { name: "Connect Bing Webmaster Tools", exact: true }));
  const panel = page.locator('[data-connect-panel="bing-webmaster"]');
  await panel.getByLabel("API key", { exact: true }).fill(JOURNEY_KEY);
  await panel.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(panel.locator("[data-sites-start]")).toBeVisible({ timeout: 15_000 });
  await panel.locator("[data-sites-start]").click();
  await expect(panel.locator('[data-site-row] [data-connection="working"]').first()).toBeVisible({ timeout: 60_000 });
  // Collected: the guide gives way to the dashboard, and the site's Overview
  // opens on the chart of what was collected.
  await page.goto("/");
  await expect(page.locator("[data-first-run]")).toHaveCount(0);
  await expect(page.locator("[data-kpi-strip]").first()).toBeVisible();
  await page.goto(`/assets/${JOURNEY_ASSET}`);
  await expect(page.locator("[data-hero-chart]").filter({ hasText: "Search clicks · daily" })).toBeVisible();
  await assertNoPageOverflow(page);
});

/** Words that describe a portfolio of several sites, or the code's word for
 * one (D31). The one-site walk below must meet none of them (bead
 * ro-ujb9.130); the Financials by-site table, which has no row to compare with
 * one site, is checked by its own heading below (bead ro-ujb9.129). */
const MANY_SITE_WORDS =
  /\bportfolio\b|\bassets?\b|\bevery site\b|\ball sites\b|\beach site\b|\bacross (?:all |your )?sites\b|\b1 sites\b|\bsite by site\b/gi;

test("a one-site install reads as one site: no portfolio words, and no filter with one choice", async ({ page }) => {
  await createAsset(page);
  await page.goto(`/integrations?connect=bing-webmaster&asset=${JOURNEY_ASSET}`);
  const panel = page.locator('[data-connect-panel="bing-webmaster"]');
  await panel.getByLabel("API key", { exact: true }).fill(JOURNEY_KEY);
  await panel.getByRole("button", { name: "Connect", exact: true }).click();
  await panel.locator("[data-sites-start]").click();
  await expect(panel.locator('[data-site-row] [data-connection="working"]').first()).toBeVisible({ timeout: 60_000 });
  for (const route of ["/__journey/revenue-history", "/__journey/finding", "/__journey/tasks-snapshot"]) {
    expect((await page.request.post(route)).ok()).toBe(true);
  }

  // Each page is read once its own data has drawn, named by what only data draws.
  const main = page.locator("main");
  const screens: [string, Locator][] = [
    ["/", page.locator("[data-portfolio-census]")],
    ["/assets", main.locator('[data-asset-row="journey.example"]').first()],
    ["/health", main.getByText("Source history").first()],
    ["/financials", main.getByRole("region", { name: "Daily revenue" })],
    ["/alerts", main.locator("[data-alert-filters]")],
    ["/tasks", main.locator("[data-tasks-filters]")],
  ];
  const found: string[] = [];
  for (const [path, drawn] of screens) {
    // Tasks draws only once a task source is connected (D32, bead ro-ujb9.143),
    // and its project filter is what this walk checks, so Beads connects here.
    if (path === "/tasks") expect((await page.request.post("/__journey/task-source")).ok()).toBe(true);
    await page.goto(path);
    await expect(drawn).toBeVisible();
    await expect(page.locator("[data-route-loading]")).toHaveCount(0);
    for (const word of (await main.innerText()).match(MANY_SITE_WORDS) ?? []) found.push(`${path}: ${word}`);
  }
  expect(found).toEqual([]);

  // Home leads with the one site's own strip and chart, never a comparison
  // table of one row (bead ro-ujb9.127).
  await page.goto("/");
  await expect(main.locator("[data-one-site-lead] [data-hero-chart]")).toBeVisible();
  await expect(main.locator("table")).toHaveCount(0);
  // Sites is that site's row: nothing to filter, sort or add up (bead
  // ro-ujb9.128).
  await page.goto("/assets");
  await expect(main.locator('[data-asset-row="journey.example"]').first()).toBeVisible();
  await expect(main.locator("[data-assets-filters], [data-kpi-strip], [data-assets-summary]")).toHaveCount(0);
  await expect(main.getByRole("group", { name: "Traffic period" })).toHaveCount(0);
  // Financials states the one site's money without a by-site table repeating
  // it: nothing is shared, so there is nothing to allocate (bead ro-ujb9.129).
  await page.goto("/financials");
  await expect(main.getByRole("region", { name: "Daily revenue" })).toBeVisible();
  await expect(main.getByRole("heading", { name: "By site" })).toHaveCount(0);
  // The site's Search tab opens on its Bing numbers and the one step to
  // tracking terms, never a blank page (bead ro-ujb9.136).
  await page.goto(`/assets/${JOURNEY_ASSET}/search`);
  await expect(main.locator('[data-search-start="numbers"] [data-growth-chart="Clicks"]')).toBeVisible();
  await expect(main.locator("[data-search-next]").getByRole("link")).toHaveCount(1);

  // A filter with one answer is not drawn.
  await page.goto("/alerts");
  await expect(page.locator("[data-alert-filters]")).toBeVisible();
  await expect(page.locator("#alerts-asset")).toHaveCount(0);
  await page.goto("/tasks");
  await expect(page.locator("[data-tasks-filters]")).toBeVisible();
  await expect(page.locator("#tasks-project")).toHaveCount(0);
});

// Bead ro-ujb9.146: a site whose first source is ad revenue or PostHog opens
// its Overview on that number — the first KPI drawn under the header — never on
// a row of traffic dashes.
test("a revenue-first and a PostHog-first site each open on their own number", async ({ page, request, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const main = page.locator("main");
  const firstKpi = main.locator('[role="tabpanel"] [data-kpi]').first();
  for (const [seed, lead, number] of [
    ["/__journey/revenue-history?traffic=none", "Daily revenue", "Reported earnings"],
    ["/__journey/posthog", "Traffic · last 28 days", "People a day"],
  ] as const) {
    expect((await request.post("/__journey/reset")).ok()).toBe(true);
    expect((await request.post("/api/assets", { headers: { origin },
      data: { id: JOURNEY_ASSET, domain: JOURNEY_ASSET, displayName: "Journey Example" } })).status()).toBe(201);
    expect((await request.put("/api/config", { headers: { origin }, data: { ops: [{ kind: "file-json-insert", file: "config/integrations.json",
      pointer: `/assets/${JOURNEY_ASSET}`, value: { "ad-network": { status: "needs-setup", since: "2026-09-06" } } }] } })).ok()).toBe(true);
    expect((await request.post(seed)).ok()).toBe(true);
    await page.goto(`/assets/${JOURNEY_ASSET}`);
    await expect(main.getByRole("region", { name: lead })).toBeVisible();
    await expect(firstKpi).toHaveAttribute("data-kpi", number);
    await expect(firstKpi).not.toContainText("—");
    await expect(main.getByText("Avg. daily users")).toHaveCount(0);
    await assertNoPageOverflow(page);
  }
});

// ── the route split (bead ro-82x) ────────────────────────────────────────────
//
// Each address downloads the desk shell plus its own screen; the rest arrive
// when somebody goes there. This server is Vite's dev server, where every source
// file is its own request, so "which screens did this address fetch" is directly
// observable: a screen is a top-level `src/routes/*Route.tsx` module, and the
// desk shell is `src/components/AppShell.tsx`.
const SCREEN_MODULE = /\/src\/(routes\/[A-Za-z]+Route|components\/AppShell)\.tsx$/;

/** Every path the address requested until its landmark drew — on this server,
 * every module in its static import graph. */
async function openAndListModules(page: Page, path: string, landmark: (page: Page) => Promise<void>) {
  const fetched = new Set<string>();
  const onRequest = (request: { url(): string }) => {
    fetched.add(new URL(request.url()).pathname);
  };
  page.on("request", onRequest);
  await page.goto(path);
  await landmark(page);
  page.off("request", onRequest);
  return [...fetched].sort();
}

async function openAndListScreens(page: Page, path: string, landmark: (page: Page) => Promise<void>) {
  const modules = await openAndListModules(page, path, landmark);
  const screens = modules.map((pathname) => pathname.match(SCREEN_MODULE)?.[1]);
  return [...new Set(screens.filter((screen): screen is string => screen !== undefined))].sort();
}

// What loads on demand INSIDE a screen since bead ro-ujb9.84: each asset tab's
// module, the command palette's module, and cmdk (a pre-bundled dependency on
// this server, served from the dep cache as `cmdk.js`).
const PART_MODULE = /\/src\/(routes\/asset-detail\/[A-Za-z]+Tab|components\/CommandPalette)\.tsx$|\/deps\/(cmdk)\.js$/;

function partOf(pathname: string): string | null {
  const match = pathname.match(PART_MODULE);
  if (!match) return null;
  return match[1] ?? `npm:${match[2]}`;
}

/** The screens and the on-demand parts an address fetched until its landmark. */
async function openAndList(page: Page, path: string, landmark: (page: Page) => Promise<void>) {
  const modules = await openAndListModules(page, path, landmark);
  const screens = new Set<string>();
  const parts = new Set<string>();
  for (const pathname of modules) {
    const screen = pathname.match(SCREEN_MODULE)?.[1];
    if (screen) screens.add(screen);
    const part = partOf(pathname);
    if (part) parts.add(part);
  }
  return { screens: [...screens].sort(), parts: [...parts].sort() };
}

test("each main address loads its own screen and no other", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  expect(await openAndListScreens(page, "/", async (p) => {
    await expect(p.locator("[data-first-run]")).toBeVisible();
  })).toEqual(["components/AppShell", "routes/HomeRoute"]);

  // The TV renders outside the desk shell, so it does not download it either.
  expect(await openAndListScreens(page, "/wall", async (p) => {
    await expect(p.locator("[data-wall-strip]")).toBeVisible();
  })).toEqual(["routes/WallRoute"]);

  // `/work` is the Tasks board's older address and still redirects to it.
  expect(await openAndListScreens(page, "/work", async (p) => {
    await expect(p).toHaveURL(/\/tasks$/);
    await expect(p.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  })).toEqual(["components/AppShell", "routes/TasksRoute"]);

  expect(await openAndListScreens(page, "/integrations", async (p) => {
    await expect(p.getByRole("heading", { name: "Integrations", level: 1 })).toBeVisible();
  })).toEqual(["components/AppShell", "routes/IntegrationsRoute"]);

  // The synthetic store is empty, so the asset page answers with its own
  // not-found state — which is the asset page's code, loaded and drawing.
  const asset = await openAndList(page, "/assets/plate.example", async (p) => {
    await expect(p.getByText("No such site", { exact: true })).toBeVisible();
  });
  expect(asset.screens).toEqual(["components/AppShell", "routes/AssetDetailRoute"]);
  // …and none of its tabs' code but the one it was about to show, and no
  // palette (bead ro-ujb9.84). The page starts fetching the tab it will show
  // while the asset's report is on its way, so Overview's code may arrive
  // before the store says there is no such asset; no other tab's may, and cmdk
  // waits for the first ⌘K.
  expect(asset.parts.filter((part) => part !== "routes/asset-detail/OverviewTab")).toEqual([]);

  expect(pageErrors).toEqual([]);
});

// The TV draws its widgets from read-only modules (bead ro-ujb9.82). Until then
// the Wall reached the desk's editing and action code through the components it
// shares with the desk — the attention table's flag actions and rule tuning, the
// countdown's settings form, the task composer — and downloaded it on every cold
// start. Each is named by the module that pulls the rest in behind it. The desk
// Timeline and its task badge joined the list with bead ro-ujb9.85: the alert
// rail's change chip reached them for one constant, the annotation kinds'
// glyphs and words, which now live in their own module.
const DESK_ONLY_MODULE =
  /\/(src\/components\/(RuleTune|KnobEditor|TaskComposer|Timeline|HandoffBeadBadge)\.tsx|src\/hooks\/useTasks\.ts|(scripts|shared)\/config-registers\.(mjs|ts))$/;

// D28 (bead ro-trai.11, docs/25-the-wall.md § What leaves the Wall): the old
// Wall's widgets left the TV, and so did their modules — the alert rail, the
// portfolio and System cards, the time faces and the meetings panel. The D28
// widgets read the pure answers those modules used to hold from `lib/` instead
// (operator posture, the portfolio headline, the meetings view). Since bead
// ro-trai.14 the old asset card is off it too — the site rows read today's pace
// from `lib/intraday-pace` — and with it the source icon row, the task strip and
// the card's daily bars. Bead ro-trai.20 took those modules out of the Tower
// altogether; what this still guards are the desk's own relatives of them —
// the alert rows (the desk table left too, bead ro-trai.25), the countdown's
// face and form, the source mark row — which the TV must never download again.
const RETIRED_WALL_MODULE =
  /\/src\/components\/(AlertRow|TimeFaces|DashboardWidgets|DataSourceIcons)\.tsx$/;

test("the TV downloads no desk editing or task code, and none of the widgets D28 retired", async ({ page }) => {
  const modules = await openAndListModules(page, "/wall", async (p) => {
    await expect(p.locator("[data-wall-strip]")).toBeVisible();
  });
  // A guard that sees nothing passes forever: the Wall's own read-only widgets
  // must be in the list it checks.
  expect(
    modules.filter((path) => /\/src\/components\/wall\/(WallStrip|RevenueHero|NeedsYou|SiteRows|WallFeed)\.tsx$/.test(path)),
  ).toHaveLength(5);
  expect(modules.filter((path) => DESK_ONLY_MODULE.test(path))).toEqual([]);
  expect(modules.filter((path) => RETIRED_WALL_MODULE.test(path))).toEqual([]);
});

// ── the asset page's tabs and the command palette (bead ro-ujb9.84) ─────────

test("an asset's tabs fetch their code when opened, and the palette on its first ⌘K", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await createAsset(page);

  const first = await openAndList(page, `/assets/${JOURNEY_ASSET}`, async (p) => {
    await expect(p.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(p.getByRole("tabpanel").locator("[data-route-loading]")).toHaveCount(0);
    await p.waitForLoadState("networkidle");
  });
  expect(first.screens).toEqual(["components/AppShell", "routes/AssetDetailRoute"]);
  // The tab on screen, and nothing else: no other tab, no palette, no cmdk.
  expect(first.parts).toEqual(["routes/asset-detail/OverviewTab"]);

  const parts = new Set<string>();
  page.on("request", (request) => {
    const part = partOf(new URL(request.url()).pathname);
    if (part) parts.add(part);
  });

  // Opening a tab fetches that tab's code, and only that tab's.
  const growth = page.getByRole("tab", { name: "Growth", exact: true });
  await growth.click();
  await expect(growth).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "asset-tab-growth");
  expect([...parts]).toEqual(["routes/asset-detail/GrowthTab"]);

  // The very first ⌘K opens the palette; its code arrives then.
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Search pages and sites" });
  await expect(palette).toBeVisible();
  await expect(palette.getByPlaceholder("Search pages and sites…")).toBeFocused();
  expect([...parts].sort()).toEqual(["components/CommandPalette", "npm:cmdk", "routes/asset-detail/GrowthTab"]);
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);

  // A deep link into a tab whose code this page has not fetched still lands on
  // its section once that code has arrived.
  await page.goto(`/assets/${JOURNEY_ASSET}#timeline`);
  await expect(page).toHaveURL(new RegExp(`/assets/${JOURNEY_ASSET.replace(".", "\\.")}/activity#timeline$`));
  await expect(page.getByRole("tab", { name: "Activity", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#timeline")).toBeInViewport();
  expect([...parts]).toContain("routes/asset-detail/ActivityTab");

  expect(pageErrors).toEqual([]);
});

test("an asset tab whose code cannot be fetched preserves its panel and recovers explicitly in a new tab", async ({ page }) => {
  await createAsset(page);
  // A tab opened before a rebuild asks for a file the server no longer has.
  let refused = 0;
  const missing = "**/src/routes/asset-detail/GrowthTab.tsx*";
  await page.route(missing, (route) => {
    refused += 1;
    return route.abort("failed");
  });
  let documents = 0;
  page.on("load", () => { documents += 1; });

  await page.goto(`/assets/${JOURNEY_ASSET}/growth`);
  const panel = page.getByRole("tabpanel");
  const alert = panel.getByRole("alert");
  await expect(alert).toContainText("This section didn't load");
  // D41: missing code must not reload a document or discard another editor.
  expect(documents).toBe(1);
  expect(refused).toBeGreaterThanOrEqual(1);
  const originalUrl = page.url();
  await page.evaluate(() => document.documentElement.setAttribute("data-journey-recovery-document", "retained"));
  // Only the section is missing: the page heading and the tab bar that did
  // load stay, with the tab the operator asked for still selected.
  await expect(page.getByRole("heading", { name: /^Journey Example/, level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Growth", exact: true })).toHaveAttribute("aria-selected", "true");
  expect((await alert.textContent()) ?? "").not.toMatch(/\d/);

  // Restored code loads only after explicit keyboard activation, in a new tab.
  await page.unroute(missing);
  const [updated] = await Promise.all([
    page.waitForEvent("popup"),
    keyboardActivate(page, alert.getByRole("button", { name: "Open app in new tab" })),
  ]);
  try {
    await expect(updated).toHaveURL(originalUrl);
    await expect(updated.getByRole("tab", { name: "Growth", exact: true })).toHaveAttribute("aria-selected", "true");
    const updatedPanel = updated.getByRole("tabpanel");
    await expect(updatedPanel.getByRole("alert")).toHaveCount(0);
    await expect(updatedPanel.locator("[data-route-loading]")).toHaveCount(0);
    await expect(updatedPanel.locator("#growth-evidence")).toBeVisible();
    expect(await updated.evaluate(() => window.opener)).toBeNull();
    await expect(page).toHaveURL(originalUrl);
    await expect(alert).toContainText("This section didn't load");
    await expect(page.locator("html")).toHaveAttribute("data-journey-recovery-document", "retained");
    expect(documents).toBe(1);
  } finally {
    await updated.close();
  }
});

test("a screen whose code cannot be fetched preserves its document and recovers explicitly in a new tab", async ({ page }) => {
  // A tab opened before a rebuild asks for a file the server no longer has.
  let refused = 0;
  const missing = "**/src/routes/TasksRoute.tsx*";
  await page.route(missing, (route) => {
    refused += 1;
    return route.abort("failed");
  });
  let documents = 0;
  page.on("load", () => { documents += 1; });

  await page.goto("/tasks");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("This page didn't load");
  // D41: no automatic reload; the failed document stays available to its owner.
  expect(documents).toBe(1);
  expect(refused).toBe(1);
  const originalUrl = page.url();
  await page.evaluate(() => document.documentElement.setAttribute("data-journey-recovery-document", "retained"));
  await expect(page).toHaveURL(/\/tasks$/);
  // Nothing on it reads as a figure about the portfolio.
  expect((await alert.textContent()) ?? "").not.toMatch(/\d/);

  // The explicit action opens restored code without replacing this document.
  await page.unroute(missing);
  const [updated] = await Promise.all([
    page.waitForEvent("popup"),
    keyboardActivate(page, alert.getByRole("button", { name: "Open app in new tab" })),
  ]);
  try {
    await expect(updated).toHaveURL(originalUrl);
    await expect(updated.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
    await expect(updated.getByRole("alert")).toHaveCount(0);
    expect(await updated.evaluate(() => window.opener)).toBeNull();
    await expect(page).toHaveURL(originalUrl);
    await expect(alert).toContainText("This page didn't load");
    await expect(page.locator("html")).toHaveAttribute("data-journey-recovery-document", "retained");
    expect(documents).toBe(1);
  } finally {
    await updated.close();
  }
});

test("the nav fetches a screen's code when the pointer rests on its link", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "the phone's nav is a drawer opened by a tap, which is the click");
  await page.goto("/");
  await expect(page.locator("[data-first-run]")).toBeVisible();
  const settings = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith("/src/routes/SettingsRoute.tsx"));
  await page.locator("[data-app-sidebar]").getByRole("link", { name: "Settings" }).hover();
  await settings;
  await expect(page).toHaveURL(/\/$/);
});

// D32: core work is usable before the first managed site and independent of a
// delayed snapshot-health request. External providers are separate integrations.
test("core Tasks creates, opens and completes work before any user site", async ({ page, request }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  await expect(page.getByText("No task projects available", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Manage task projects/ })).toHaveAttribute("href", "/settings#task-hub");
  await expect(page.getByRole("button", { name: "New task", exact: true })).toBeVisible();

  expect((await request.post("/__journey/core-tasks")).ok()).toBe(true);
  expect((await (await request.get("/api/wall")).json()).assets).toEqual([]);
  const projects = (await (await request.get("/api/work")).json()).projects;
  expect(projects).toEqual([expect.objectContaining({ asset: JOURNEY_CORE_PROJECT.asset, name: "NoticeOS", ok: true })]);
  // Keep the independent snapshot connection unanswered; the live lane and
  // its real stored project still own whether filing/reading is available.
  await page.route("**/api/task-source", (route) => route.fulfill({ json: {
    connected: null, sources: [{ id: "beads", connected: false, projects: 1, readAt: null, failing: 0 }],
  } }));
  await page.goto("/tasks");
  await expect(page.getByText("Nothing is queued.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const composer = page.getByRole("dialog", { name: "File a task" });
  await expect(composer.locator("[data-composer-project]")).toHaveValue(JOURNEY_CORE_PROJECT.asset);
  await expect(composer.getByRole("option", { name: "NoticeOS (no-)" })).toHaveCount(1);
  await composer.locator("[data-composer-title]").fill("Verify the synthetic core task");
  await composer.locator("[data-composer-submit]").click();
  await expect(composer).toHaveCount(0);
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Filed no-f1" })).toBeVisible();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\/no-f1$/u);
  await expect(page.getByRole("heading", { name: /Verify the synthetic core task/ })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("textbox", { name: "Close reason" }).fill("Synthetic proof passed in fixture commit 1a2b3c4");
  await page.getByRole("button", { name: "Close task", exact: true }).click();
  await expect(page.locator('[data-page-header]').getByText('Closed', { exact: true })).toBeVisible();
  const state = await (await request.get("/__journey/status")).json();
  expect(state.tasks).toEqual([expect.objectContaining({ id: "no-f1", status: "closed", close_reason: "Synthetic proof passed in fixture commit 1a2b3c4" })]);
  expect(state.taskCommands.some((argv: string[]) => argv[2] === "create")).toBe(true);
  expect(state.taskCommands.some((argv: string[]) => argv[2] === "show" && argv[3] === "no-f1")).toBe(true);
  expect(state.taskCommands.some((argv: string[]) => argv[2] === "close" && argv[3] === "no-f1")).toBe(true);
  expect((await (await request.get("/api/wall")).json()).assets).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("core-tasks-before-sites.png"), fullPage: true });
  await page.goto("/settings#task-hub");
  await expect(page.locator("#task-hub")).toBeVisible();
  await expect(page.getByText("Waiting for first read", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Beads", exact: true })).toHaveCount(0);
  await page.goto("/integrations");
  await expect(page.locator('[data-integration-tile="beads"]')).toHaveCount(0);
  await assertNoPageOverflow(page);
  expect(pageErrors).toEqual([]);
});
