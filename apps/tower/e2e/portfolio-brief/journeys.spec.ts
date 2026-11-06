import { integrationProvider } from '@noticeos/contract/integrations';
import type { PortfolioBriefRead } from '@noticeos/contract/portfolio-brief';
import { test, expect } from '../journey-test';
import { wallScene } from '../wall-scene';
import { WALL_FIXTURE_NOW } from '../wall-fixture';

const ready: PortfolioBriefRead = { state: 'ready', error: null, stale: false, lastAttemptAt: WALL_FIXTURE_NOW, nextAttemptAt: null, briefing: {
  generatedAt: WALL_FIXTURE_NOW, evidenceAsOf: '2026-09-22T18:30:00Z', model: 'example-local-model', limitations: ['One asset has no revenue report.'],
  result: { headline: 'Investigate checkout before increasing spend.', assessment: 'Resolve checkout uncertainty before increasing acquisition.', insights: [
    { title: 'Check checkout before buying traffic', observation: 'Over the latest 28 days versus the previous 28, checkout completion fell. Visits stayed level.', why: 'More acquisition may not produce more purchases.', action: 'Compare completion by device.', evidenceIds: ['checkout'], confidence: 'high' },
    { title: 'Find what drove search growth', observation: 'Over the latest 28 days, search visits rose for one asset. Other assets declined.', why: 'Growth is concentrated in one asset.', action: 'Inspect the growing pages.', evidenceIds: ['search'], confidence: 'medium' },
    { title: 'Review the release blocker', observation: 'Currently, the release task depends on an unfinished review.', why: 'The release cannot proceed until that review is complete.', action: 'Review the blocking task.', evidenceIds: ['tasks'], confidence: 'high' },
  ] }, sources: [
    { id: 'checkout', label: 'Checkout completion', href: '/alerts', observedAt: WALL_FIXTURE_NOW, period: null, comparison: { current: { start: '2026-08-25', end: '2026-09-21' }, previous: { start: '2026-07-28', end: '2026-08-24' }, timeZone: 'America/Los_Angeles' } },
    { id: 'search', label: 'Search readings', href: '/assets/example.com/search', observedAt: WALL_FIXTURE_NOW, period: null, comparison: { current: { start: '2026-08-25', end: '2026-09-21' }, previous: { start: '2026-07-28', end: '2026-08-24' }, timeZone: 'America/Los_Angeles' } },
    { id: 'tasks', label: 'Release dependency', href: '/tasks?project=example.com', observedAt: null, period: null },
  ],
} };

const generousInsights: NonNullable<PortfolioBriefRead['briefing']>['result']['insights'] = [
  {
    "title": "Investigate checkout completion",
    "observation": "Over the latest 28 days versus the previous 28, checkout completion declined while visits remained broadly steady. The decline is visible across the full reporting window, but the aggregate figures do not establish whether visitor mix, device behavior, product changes or an issue during checkout explains the difference.",
    "why": "Increasing acquisition before understanding that relationship could increase spending without a corresponding improvement in completed purchases. The figures support investigation rather than a conclusion about the cause.",
    "action": "Compare completion by device and acquisition source, then inspect the largest affected segment before changing the spending plan.",
    "evidenceIds": [
      "checkout"
    ],
    "confidence": "medium"
  },
  {
    "title": "Inspect the source of search growth",
    "observation": "Over the latest 28 days versus the previous 28, one asset gained search visits while the others declined. That makes the growing asset a useful comparison, but its stronger result alone does not establish that the same changes would work elsewhere in the portfolio.",
    "why": "Understanding which queries and landing pages contributed to the difference would make a targeted review more useful than copying a broad publishing or acquisition strategy.",
    "action": "Compare the growing landing pages with their own earlier performance and inspect the queries responsible for the change.",
    "evidenceIds": [
      "search"
    ],
    "confidence": "medium"
  },
  {
    "title": "Resolve the release dependency",
    "observation": "Currently, the release task depends on a separate review that has not been completed. The dependency records a concrete reason the release cannot proceed; it does not establish that every other task in the project should stop.",
    "why": "Completing unrelated implementation work will not remove that dependency. Focusing the next review on the blocking task can clarify whether a release decision is ready.",
    "action": "Review the blocking task and its acceptance conditions, then confirm which remaining work can proceed independently.",
    "evidenceIds": [
      "tasks"
    ],
    "confidence": "high"
  }
];

test('Home briefing shows useful guidance without an evidence inventory or empty hero', { tag: '@pull-request' }, async ({ page, request }, info) => {
  expect((await request.post('/__journey/reset')).ok()).toBe(true);
  expect((await (await request.get('/__journey/status')).json()).isolated).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install({ time: new Date(WALL_FIXTURE_NOW) });
  await wallScene(page, 'six');
  let read = ready;
  await page.route('**/api/portfolio-brief', route => route.fulfill({ json: read }));
  await page.goto('/');
  const brief = page.locator('[data-executive-brief]');
  await expect(brief).toBeVisible();
  await expect(brief.getByRole('heading', { level: 2 })).toHaveText(ready.briefing!.result.headline);
  await expect(brief.getByRole('listitem')).toHaveCount(3);
  await expect(brief.locator('time, [data-brief-comparison]')).toHaveCount(0);
  await expect(brief.getByRole('link')).toHaveCount(0);
  await expect(brief.getByText(ready.briefing!.result.insights[0]!.observation)).not.toBeVisible();
  await expect(brief.getByRole('heading', { level: 3 })).toHaveText(['Check checkout before buying traffic', 'Find what drove search growth', 'Review the release blocker']);
  await expect(brief).not.toContainText('example-local-model');
  await expect(brief).not.toContainText('One asset has no revenue report.');
  await expect(brief).not.toContainText('Search readings');
  await expect(brief).toHaveAttribute('data-brief-cycle', 'running');
  const highlighted = () => brief.locator('[data-brief-highlight="active"]').getByRole('heading', { level: 3 });
  await expect(highlighted()).toHaveText('Check checkout before buying traffic');
  await page.clock.fastForward(9_000);
  await expect(highlighted()).toHaveText('Find what drove search growth');
  await brief.getByRole('button', { name: 'Pause card highlights' }).click();
  await expect(brief).toHaveAttribute('data-brief-cycle', 'paused');
  await page.clock.fastForward(18_000);
  await expect(highlighted()).toHaveText('Find what drove search growth');
  await brief.getByRole('button', { name: 'Resume card highlights' }).click();
  await page.clock.fastForward(9_000);
  await expect(highlighted()).toHaveText('Review the release blocker');
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
  await brief.screenshot({ path: info.outputPath('synthetic-briefing-collapsed.png') });
  const cards = brief.getByRole('listitem');
  const closedHeights = await cards.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(closedHeights.every(height => height < 130)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  const firstDetails = brief.locator('summary').first();
  for (let index = 0; index < 100 && !await firstDetails.evaluate(element => element === document.activeElement); index++) await page.keyboard.press('Tab');
  await expect(firstDetails).toBeFocused();
  await expect(brief).toHaveAttribute('data-brief-cycle', 'paused');
  await page.keyboard.press('Enter');
  await expect(brief.getByText(ready.briefing!.result.insights[0]!.observation)).toBeVisible();
  await firstDetails.evaluate(element => (element as HTMLElement).blur());
  await page.clock.fastForward(18_000);
  await expect(brief).toHaveAttribute('data-brief-cycle', 'paused');
  await firstDetails.focus();
  await expect(brief.getByText(ready.briefing!.result.insights[1]!.observation)).not.toBeVisible();
  await expect(brief.getByRole('link', { name: 'Review alerts' })).toHaveAttribute('href', '/alerts');
  const openHeights = await cards.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(openHeights[0]).toBeGreaterThan(closedHeights[0]!);
  expect(openHeights.slice(1)).toEqual(closedHeights.slice(1));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await page.screenshot({ path: info.outputPath('briefing-expanded.png'), fullPage: true });
  await brief.screenshot({ path: info.outputPath('synthetic-briefing-expanded.png') });
  await page.keyboard.press('Enter');
  await expect(brief.getByText(ready.briefing!.result.insights[0]!.observation)).not.toBeVisible();
  read = { ...ready, briefing: { ...ready.briefing!, result: { ...ready.briefing!.result, insights: generousInsights }, sources: ready.briefing!.sources } };
  await page.reload();
  await expect(brief.getByRole('heading', { level: 3 })).toHaveText(generousInsights.map(insight => insight.title));
  await expect(brief.getByRole('link')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await page.screenshot({ path: info.outputPath('briefing-generous-collapsed.png'), fullPage: true });
  read = { ...ready, state: 'unavailable', error: 'generation unavailable', stale: true };
  await page.reload();
  await expect(brief.getByRole('status')).toContainText('Refresh failed. Showing the previous briefing.');
  await expect(brief.getByRole('heading', { level: 2 })).toHaveText(ready.briefing!.result.headline);
  await expect(brief.locator('time')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('briefing-retained.png'), fullPage: true });
  read = { ...ready, briefing: { ...ready.briefing!, result: { ...ready.briefing!.result, insights: [] } } };
  await page.reload();
  await expect(brief).toHaveCount(0);
  await expect(page.locator('[data-home-answer]')).toBeVisible();
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
