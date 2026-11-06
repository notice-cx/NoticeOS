import { integrationProvider } from '@noticeos/contract/integrations';
import type { PortfolioBriefRead } from '@noticeos/contract/portfolio-brief';
import { test, expect } from '../journey-test';
import { wallScene } from '../wall-scene';
import { WALL_FIXTURE_NOW } from '../wall-fixture';

const ready: PortfolioBriefRead = { state: 'ready', error: null, stale: false, lastAttemptAt: WALL_FIXTURE_NOW, nextAttemptAt: null, briefing: {
  generatedAt: WALL_FIXTURE_NOW, evidenceAsOf: '2026-09-22T18:30:00Z', model: 'example-local-model', limitations: ['One asset has no revenue report.'],
  result: { headline: 'Fix checkout before increasing acquisition spend.', assessment: 'Revenue depends on recovering existing demand while checkout failures persist.', insights: [
    { observation: 'Over the latest 28 days, checkout losses rose versus the previous 28 while visits stayed level.', why: 'More acquisition would send visitors into the same failure.', action: 'Review the checkout errors before increasing spend.', evidenceIds: ['checkout'], confidence: 'high' },
    { observation: 'Over the latest 28 days, one asset gained search visits versus the previous 28 while the others declined.', why: 'The portfolio is becoming more dependent on that asset.', action: 'Compare the changed landing pages across the assets.', evidenceIds: ['search'], confidence: 'medium' },
  ] }, sources: [
    { id: 'checkout', label: 'Checkout errors', href: '/alerts', observedAt: WALL_FIXTURE_NOW, period: null, comparison: { current: { start: '2026-08-25', end: '2026-09-21' }, previous: { start: '2026-07-28', end: '2026-08-24' }, timeZone: 'America/Los_Angeles' } },
    { id: 'search', label: 'Search readings', href: '/sites', observedAt: WALL_FIXTURE_NOW, period: null, comparison: { current: { start: '2026-08-25', end: '2026-09-21' }, previous: { start: '2026-07-28', end: '2026-08-24' }, timeZone: 'America/Los_Angeles' } },
  ],
} };

test('Home executive briefing keeps evidence, attribution and retained-result warning readable', async ({ page, request }, info) => {
  expect((await request.post('/__journey/reset')).ok()).toBe(true);
  expect((await (await request.get('/__journey/status')).json()).isolated).toBe(true);
  await wallScene(page, 'six');
  let read = ready;
  await page.route('**/api/portfolio-brief', route => route.fulfill({ json: read }));
  await page.goto('/');
  const brief = page.locator('[data-executive-brief]');
  await expect(brief).toBeVisible();
  await expect(brief.getByRole('heading', { level: 2 })).toHaveText(ready.briefing!.result.headline);
  await expect(brief.getByRole('listitem')).toHaveCount(2);
  await expect(brief.locator('[data-brief-comparison]')).toHaveCount(2);
  await expect(brief.locator('[data-brief-comparison]').first()).not.toBeVisible();
  await expect(brief.locator('[data-brief-comparison]').first()).toHaveText('Current Aug 25–Sep 21, 2026 vs previous Jul 28–Aug 24, 2026 · America/Los_Angeles');
  await expect(brief.getByRole('link', { name: 'Checkout errors' })).toHaveAttribute('href', '/alerts');
  await expect(brief).toContainText('Model-generated · example-local-model');
  await expect(brief.getByText('One asset has no revenue report.')).not.toBeVisible();
  await brief.getByText('Evidence and coverage').click();
  await expect(brief.getByText('One asset has no revenue report.')).toBeVisible();
  await expect(brief.locator('[data-brief-comparison]').first()).toBeVisible();
  await brief.getByText('Evidence and coverage').click();
  await page.evaluate(() => document.fonts.ready);
  const fit = await brief.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const clipped: string[] = [];
    while (walker.nextNode()) {
      const range = document.createRange(); range.selectNodeContents(walker.currentNode);
      for (const line of range.getClientRects()) if (line.left < bounds.left - 1 || line.right > bounds.right + 1) clipped.push(walker.currentNode.textContent ?? '');
    }
    return { overflow: document.documentElement.scrollWidth - innerWidth, clipped };
  });
  expect(fit).toEqual({ overflow: 0, clipped: [] });
  await page.screenshot({ path: info.outputPath('briefing-ready.png'), fullPage: true });
  read = { ...ready, state: 'unavailable', error: 'generation unavailable', stale: true };
  await page.reload();
  await expect(brief.getByRole('status')).toContainText('Showing the last successful briefing.');
  await expect(brief.getByRole('heading', { level: 2 })).toHaveText(ready.briefing!.result.headline);
  await expect(brief.locator('time').first()).toHaveAttribute('datetime', WALL_FIXTURE_NOW);
  await page.screenshot({ path: info.outputPath('briefing-retained.png'), fullPage: true });
  read = { ...ready, briefing: { ...ready.briefing!, result: { ...ready.briefing!.result, insights: [] } } };
  await page.reload();
  await expect(brief).toBeVisible();
  await expect(brief.getByRole('list')).toHaveCount(0);
  read = { ...ready, state: 'disconnected', briefing: null };
  await page.reload();
  await expect(page.getByRole('link', { name: 'Connect a model' })).toHaveAttribute('href', '/integrations?connect=local-model');
  await expect(page.locator('[data-home-answer]')).toBeVisible();
});


test('model connection chooses an available server model before saving', { tag: '@pull-request' }, async ({ page, request }, info) => {
  expect((await request.post('/__journey/reset')).ok()).toBe(true);
  expect((await (await request.get('/__journey/status')).json()).isolated).toBe(true);
  await wallScene(page, 'six');
  await page.route('**/api/integrations/providers', route => route.fulfill({ json: {
    generatedAt: WALL_FIXTURE_NOW, keyPresent: true, blockers: [], keyReason: null,
    providers: [{ provider: integrationProvider('local-model'), assets: [], credential: {
      provider: 'local-model', source: 'none', fields: [], assetsHeld: [], missingFields: ['LOCAL_MODEL_BASE_URL', 'LOCAL_MODEL_ID'],
      auth: null, metadata: null, keyVersion: null, createdAt: null, updatedAt: null, lastUsedAt: null, lastOkAt: null, lastError: null,
    } }],
  } }));
  await page.route('**/api/integrations/local-model/models', route => route.fulfill({ json: { ok: true, models: ['example-small', 'example-large'] } }));
  let saved: unknown;
  await page.route('**/api/integrations/local-model/connect', route => {
    saved = route.request().postDataJSON();
    return route.fulfill({ json: { verdict: 'accepted', facts: {} } });
  });
  await page.goto('/integrations?connect=local-model');
  const panel = page.locator('[data-connect-panel="local-model"]');
  await panel.getByLabel(/^API base URL/).fill('https://model.example.com/v1');
  await panel.getByRole('button', { name: 'Load models', exact: true }).click();
  await expect(panel.getByRole('combobox')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
  await panel.getByRole('combobox').selectOption('example-large');
  await panel.getByLabel(/^API base URL/).fill('https://other.example.com/v1');
  await expect(panel.getByRole('combobox')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Connect', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: 'Load models', exact: true }).click();
  await panel.getByRole('combobox').selectOption('example-small');
  await page.screenshot({ path: info.outputPath('model-selection.png'), fullPage: true });
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  expect(saved).toEqual({ fields: { LOCAL_MODEL_BASE_URL: 'https://other.example.com/v1', LOCAL_MODEL_ID: 'example-small' } });
});
