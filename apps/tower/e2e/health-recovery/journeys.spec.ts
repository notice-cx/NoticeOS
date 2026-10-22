import type { Page } from '@playwright/test';
import { test, expect } from '../journey-test';
import { WALL_FIXTURE_NOW, wallFixturePayload, wallFixtureRealtime, wallFixtureCalendar, wallFixtureHealth, wallFixtureProviders } from '../wall-fixture';
import { buildWorkflowHistory } from '../../../../scripts/workflow-history-view.mjs';
import { jobRunName } from '../../../../scripts/scheduled-jobs.mjs';
import { WORKFLOW_DEFINITIONS } from '../../../../scripts/workflow-definitions.mjs';
import { APP_RELEASE_HEADER } from '../../shared/app-release';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const NOW = Date.parse(WALL_FIXTURE_NOW);

async function scene(page: Page) {
  const control = { release: A as string | null, session: A as string | null, wallReads: 0, recovered: false };
  await page.clock.install({ time: new Date(NOW) });
  await page.addInitScript(release => { Object.assign(globalThis, { __NOTICEOS_RELEASE__: release }); }, A);
  const definition = WORKFLOW_DEFINITIONS.find(workflow => workflow.id === 'counters')!;
  const records = Array.from({ length: 168 }, (_, index) => ({ job: jobRunName(definition), at: new Date(NOW - index * 3_600_000).toISOString(), ms: 1, outcome: index === 120 ? 'failed' : 'ran' }));
  const history = buildWorkflowHistory(records, [], [], NOW);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/changes') return route.abort();
    const headers: Record<string, string> = control.release ? { [APP_RELEASE_HEADER]: control.release } : {};
    if (path === '/api/app-release') return route.fulfill({ json: { release: control.release }, headers });
    if (path === '/api/session') return route.fulfill({ json: { mode: 'standalone' }, headers: control.session ? { [APP_RELEASE_HEADER]: control.session } : {} });
    const wall = wallFixturePayload('six');
    if (control.recovered) wall.assets = wall.assets.map((asset, index) => index === 0 ? { ...asset, displayName: 'Recovered Example' } : asset);
    const replies: Record<string, unknown> = {
      '/api/wall': wall, '/api/ga4/realtime': wallFixtureRealtime(20, 'six'),
      '/api/calendar/upcoming': wallFixtureCalendar(), '/api/integrations/health': wallFixtureHealth('six'),
      '/api/integrations/providers': wallFixtureProviders(),
      '/api/workflows': { ...history, generatedAt: WALL_FIXTURE_NOW, runtimeFresh: true, historyAvailable: true, observationsFresh: true, overrides: null,
        runtime: { updatedAt: WALL_FIXTURE_NOW, error: null, onlyListedJobs: true, registeredJobs: ['counters'], jobs: [{ id: 'counters', enabled: true, cron: '0 * * * *', nextRun: null }] } },
    };
    if (path === '/api/wall') control.wallReads++;
    if (Object.hasOwn(replies, path)) return route.fulfill({ json: replies[path], headers });
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), ...headers } });
  });
  return control;
}

test.beforeEach(async ({ request }) => { expect((await request.post('/__journey/reset')).ok()).toBe(true); });

test('System health shows an hourly job failure five days ago at 1440px', async ({ page }, info) => {
  await scene(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/health');
  const date = new Date(NOW - 120 * 3_600_000).toISOString().slice(0, 10);
  const cell = page.locator(`[data-job-day="counters:${date}"]`);
  await expect(cell).toHaveAttribute('data-state', 'failed');
  await expect(cell.getByRole('link')).toHaveAttribute('href', /run=counters/);
  await expect(page.locator('[data-job-runs]')).toContainText('UTC');
  await expect(page.locator('[data-job-runs]')).not.toContainText('older runs not kept');
  await page.clock.runFor(3_000);
  await expect(page.locator('#boot-splash')).toHaveCount(0);
  const screenshot = info.outputPath('system-health-1440.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach('system-health-1440', { path: screenshot, contentType: 'image/png' });
});

test('same-release Wall recovery resumes reads in place after a headerless outage', async ({ page }, info) => {
  const control = await scene(page);
  let documents = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) documents++; });
  await page.goto('/wall');
  await expect(page.locator('.wall-root')).toBeVisible();
  const initialDocuments = documents;
  control.release = null;
  await page.clock.runFor(60_000);
  await expect(page.locator('[data-app-update]')).toContainText('App version unavailable');
  const stoppedAt = control.wallReads;
  control.release = A;
  control.session = null;
  await page.clock.runFor(30_000);
  await expect(page.locator('[data-app-update]')).toBeVisible();
  expect(control.wallReads).toBe(stoppedAt);
  control.session = A;
  control.recovered = true;
  await page.clock.runFor(30_000);
  await expect(page.locator('[data-app-update]')).toHaveCount(0);
  await expect.poll(() => control.wallReads).toBeGreaterThan(stoppedAt);
  expect(documents).toBe(initialDocuments);
  await expect(page.locator('.wall-root')).toContainText('Recovered Example');
  const resumedAt = control.wallReads;
  await page.clock.runFor(60_000);
  await expect.poll(() => control.wallReads).toBeGreaterThan(resumedAt);
  expect(documents).toBe(initialDocuments);
  const screenshot = info.outputPath('wall-recovered-without-reload.png');
  await page.screenshot({ path: screenshot });
  await info.attach('wall-recovered-without-reload', { path: screenshot, contentType: 'image/png' });
});

for (const pathname of ['/health', '/wall/edit']) {
  test(`same-release recovery leaves the update prompt on ${pathname}`, async ({ page }) => {
    const control = await scene(page);
    await page.goto(pathname);
    await expect.poll(() => control.wallReads).toBeGreaterThan(0);
    control.release = null;
    await page.clock.runFor(60_000);
    await expect(page.locator('[data-app-update]')).toBeVisible();
    control.release = A;
    await page.clock.runFor(60_000);
    await expect(page.locator('[data-app-update]')).toBeVisible();
  });
}

test('a different-release Wall recovery reloads once', async ({ page }) => {
  const control = await scene(page);
  let documents = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) documents++; });
  await page.goto('/wall');
  await expect(page.locator('.wall-root')).toBeVisible();
  control.release = B; control.session = B;
  await page.clock.runFor(60_000);
  await expect.poll(() => documents).toBe(2);
  await page.clock.runFor(30_000);
  expect(documents).toBe(2);
});
