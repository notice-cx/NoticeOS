import type { PortfolioBriefRead } from '@noticeos/contract/portfolio-brief';
import { test, expect } from '../journey-test';
import { wallScene } from '../wall-scene';
import { WALL_FIXTURE_NOW } from '../wall-fixture';

const ready: PortfolioBriefRead = { state: 'ready', error: null, stale: false, lastAttemptAt: WALL_FIXTURE_NOW, nextAttemptAt: null, briefing: {
  generatedAt: WALL_FIXTURE_NOW, evidenceAsOf: '2026-09-22T18:30:00Z', model: 'example-local-model', limitations: ['One asset has no revenue report.'],
  result: { headline: 'Fix checkout before increasing acquisition spend.', assessment: 'Revenue depends on recovering existing demand while checkout failures persist.', insights: [
    { observation: 'Checkout losses rose while visits stayed level.', why: 'More acquisition would send visitors into the same failure.', action: 'Review the checkout errors before increasing spend.', evidenceIds: ['checkout'], confidence: 'high' },
    { observation: 'Search growth is concentrated in one asset.', why: 'The portfolio depends more heavily on that asset.', action: 'Compare its landing pages with the other assets.', evidenceIds: ['search'], confidence: 'medium' },
    { observation: 'Completed changes still lack outcome readings.', why: 'More completed work does not establish a return.', action: 'Read the completed measurement windows before extending the approach.', evidenceIds: ['tasks'], confidence: 'low' },
  ] }, sources: [
    { id: 'checkout', label: 'Checkout errors', href: '/alerts', observedAt: WALL_FIXTURE_NOW, period: null },
    { id: 'search', label: 'Search readings', href: '/sites', observedAt: WALL_FIXTURE_NOW, period: null },
    { id: 'tasks', label: 'Outcome reviews', href: '/tasks/all', observedAt: WALL_FIXTURE_NOW, period: null },
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
  await expect(brief.getByRole('listitem')).toHaveCount(3);
  await expect(brief.getByRole('link', { name: 'Checkout errors' })).toHaveAttribute('href', '/alerts');
  await expect(brief).toContainText('Model-generated · example-local-model');
  await expect(brief.getByText('One asset has no revenue report.')).not.toBeVisible();
  await brief.getByText('Evidence and coverage').click();
  await expect(brief.getByText('One asset has no revenue report.')).toBeVisible();
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
  await expect(page.getByRole('link', { name: 'Connect a local model' })).toHaveAttribute('href', '/integrations?connect=local-model');
  await expect(page.locator('[data-home-answer]')).toBeVisible();
});
