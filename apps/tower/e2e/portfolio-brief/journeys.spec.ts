import { captureWorkflowOutput } from '../../../../scripts/workflow-output.mjs';
import { MODEL_GENERATION_TIMEOUT_MS, portfolioBriefFailure } from '../../../../scripts/portfolio-brief-failure.mjs';
import { buildWorkflowHistory } from '../../vite/workflow-history';
import type { WorkflowsPayload, WorkflowRun } from '../../shared/workflows';
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
    { id: 'checkout', label: 'Checkout completion', href: '/assets/acorn.example/product', observedAt: WALL_FIXTURE_NOW, period: null, comparison: { current: { start: '2026-08-25', end: '2026-09-21' }, previous: { start: '2026-07-28', end: '2026-08-24' }, timeZone: 'America/Los_Angeles' } },
    { id: 'search', label: 'Search readings', href: '/assets/plume.example/search', observedAt: WALL_FIXTURE_NOW, period: null, comparison: { current: { start: '2026-08-25', end: '2026-09-21' }, previous: { start: '2026-07-28', end: '2026-08-24' }, timeZone: 'America/Los_Angeles' } },
    { id: 'tasks', label: 'Release dependency', href: '/tasks?project=acorn.example', observedAt: null, period: null },
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

test('Home briefing rotates one full-width finding without repeated summaries', { tag: '@pull-request' }, async ({ page, request }, info) => {
  expect((await request.post('/__journey/reset')).ok()).toBe(true);
  expect((await (await request.get('/__journey/status')).json()).isolated).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install({ time: new Date(WALL_FIXTURE_NOW) });
  await wallScene(page, 'six');
  let read = ready;
  await page.route('**/api/portfolio-brief', route => route.fulfill({ json: read }));
  await page.goto('/');
  const brief = page.locator('[data-executive-brief]');
  const heading = brief.getByRole('heading', { level: 2 });
  const dots = brief.getByRole('group', { name: 'Choose a finding' }).getByRole('button');
  await expect(brief).toBeVisible();
  await expect(heading).toHaveText(ready.briefing!.result.insights[0]!.title);
  await expect(brief.getByRole('heading')).toHaveCount(1);
  await expect(brief.getByRole('img', { name: 'About Acorn Atlas' })).toBeVisible();
  await expect(brief.locator('[data-brief-finding]')).toHaveCount(1);
  await expect(brief).not.toContainText(ready.briefing!.result.headline!);
  await expect(brief).not.toContainText(ready.briefing!.result.assessment!);
  await expect(brief.getByText(ready.briefing!.result.insights[0]!.action)).toBeVisible();
  await expect(brief.getByText(ready.briefing!.result.insights[0]!.observation)).not.toBeVisible();
  await expect(brief.locator('time, [data-brief-comparison]')).toHaveCount(0);
  await expect(brief).not.toContainText('example-local-model');
  await expect(brief).not.toContainText('One asset has no revenue report.');
  await expect(dots).toHaveCount(3);
  const positions = await dots.evaluateAll(elements => elements.map(element => ({ x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y })));
  expect(new Set(positions.map(position => position.x)).size).toBe(1);
  expect(positions[0]!.y).toBeLessThan(positions[1]!.y);
  expect(positions[1]!.y).toBeLessThan(positions[2]!.y);
  const size = await brief.evaluate(element => ({ width: element.getBoundingClientRect().width, available: element.parentElement!.getBoundingClientRect().width }));
  expect(Math.abs(size.width - size.available)).toBeLessThan(2);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await brief.screenshot({ path: info.outputPath('single-finding-collapsed.png'), animations: 'disabled' });
  await expect(brief).toHaveAttribute('data-brief-cycle', 'running');
  await page.clock.fastForward(7_000);
  await expect(heading).toHaveText(ready.briefing!.result.insights[1]!.title);
  await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(brief.getByRole('img', { name: 'About Plume Studio' })).toBeVisible();
  await brief.getByRole('button', { name: 'Pause finding rotation' }).click();
  await page.clock.fastForward(14_000);
  await expect(heading).toHaveText(ready.briefing!.result.insights[1]!.title);
  await brief.getByRole('button', { name: 'Resume finding rotation' }).click();
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.mouse.move(0, 0);
  await expect(brief).toHaveAttribute('data-brief-cycle', 'running');
  await page.clock.fastForward(7_000);
  await expect(heading).toHaveText(ready.briefing!.result.insights[2]!.title);
  await dots.nth(0).click();
  await expect(heading).toHaveText(ready.briefing!.result.insights[0]!.title);
  await expect(brief).toHaveAttribute('data-brief-cycle', 'paused');
  const details = brief.locator('summary');
  await details.focus();
  await page.keyboard.press('Enter');
  await expect(brief.getByText(ready.briefing!.result.insights[0]!.observation)).toBeVisible();
  await expect(brief.getByText(ready.briefing!.result.insights[0]!.why)).toBeVisible();
  await expect(brief.getByText(ready.briefing!.result.insights[0]!.action)).toHaveCount(1);
  await expect(brief.getByRole('link', { name: 'Review asset' })).toHaveAttribute('href', '/assets/acorn.example/product');
  await page.clock.fastForward(14_000);
  await expect(heading).toHaveText(ready.briefing!.result.insights[0]!.title);
  await brief.screenshot({ path: info.outputPath('single-finding-expanded.png'), animations: 'disabled' });
  await dots.nth(1).click();
  await expect(heading).toHaveText(ready.briefing!.result.insights[1]!.title);
  await expect(brief.locator('details[open]')).toHaveCount(0);
  read = { ...ready, briefing: { ...ready.briefing!, result: { insights: generousInsights } } };
  await page.reload();
  await expect(heading).toHaveText(generousInsights[0]!.title);
  await expect(brief.getByRole('heading')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await brief.screenshot({ path: info.outputPath('single-finding-generous.png'), animations: 'disabled' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await expect(brief.getByRole('button', { name: /finding rotation/ })).toHaveCount(0);
  await page.clock.fastForward(14_000);
  await expect(heading).toHaveText(generousInsights[0]!.title);
  await dots.nth(2).click();
  await expect(heading).toHaveText(generousInsights[2]!.title);
  await page.clock.fastForward(14_000);
  await expect(heading).toHaveText(generousInsights[2]!.title);
  read = { ...ready, state: 'unavailable', error: 'generation unavailable', stale: true };
  await page.reload();
  await expect(brief.getByRole('status')).toContainText('Refresh failed. Showing the previous briefing.');
  await expect(heading).toHaveText(ready.briefing!.result.insights[0]!.title);
  read = { ...ready, briefing: { ...ready.briefing!, result: { insights: [] } } };
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

test('Settings AI saves a portfolio asset subset and Undo restores all assets', { tag: '@pull-request' }, async ({ page, request }, info) => {
  expect((await request.post('/__journey/reset')).ok()).toBe(true);
  expect((await request.post('/__journey/wall-feed')).ok()).toBe(true);
  expect((await (await request.get('/__journey/status')).json()).isolated).toBe(true);
  const initial = await (await request.get('/api/settings')).json();
  const assets = initial.portfolioReview.assets as { id: string; displayName: string }[];
  expect(assets.length).toBeGreaterThan(1);
  expect(assets.find(asset => asset.id === 'os.example.com')?.displayName).toBe('System');
  expect(initial.portfolioReview.assetIds).toBeNull();
  await page.goto('/settings/ai');
  const panel = page.locator('#portfolio-review');
  await expect(panel.getByRole('heading', { name: 'AI portfolio review' })).toBeVisible();
  await expect(panel).not.toContainText('Stored name, never shown');
  await expect(panel.getByRole('radio', { name: 'All assets', exact: true })).toBeChecked();
  await panel.getByRole('radio', { name: 'Choose assets', exact: true }).check();
  const choices = panel.getByRole('checkbox');
  await expect(choices).toHaveCount(assets.length);
  for (let index = 1; index < assets.length; index++) await choices.nth(index).uncheck();
  await panel.getByRole('button', { name: 'Save asset selection', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Saved');
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).portfolioReview.assetIds).toEqual([assets[0]!.id]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await page.screenshot({ path: info.outputPath('settings-ai-asset-subset.png'), fullPage: true });
  await panel.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(panel.getByRole('radio', { name: 'All assets', exact: true })).toBeChecked();
  await expect.poll(async () => (await (await request.get('/api/settings')).json()).portfolioReview.assetIds).toBeNull();
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
});


test('failed briefing leads with its saved reason and next step', { tag: '@pull-request' }, async ({ page, request }, info) => {
  expect((await request.post('/__journey/reset')).ok()).toBe(true);
  expect((await (await request.get('/__journey/status')).json()).isolated).toBe(true);
  await page.clock.setFixedTime(new Date(WALL_FIXTURE_NOW));
  const { summary: reason, action } = portfolioBriefFailure({ kind: 'timeout' });
  const startedAt = new Date(Date.parse(WALL_FIXTURE_NOW) - MODEL_GENERATION_TIMEOUT_MS).toISOString();
  const run: WorkflowRun = { id: `portfolio-brief@manual/${startedAt}`, workflowId: 'portfolio-brief', definitionVersion: 1,
    state: 'failed', startedAt, finishedAt: WALL_FIXTURE_NOW, trigger: { kind: 'manual' }, steps: [
      { id: 'portfolio-brief', attempt: 1, state: 'failed', startedAt, finishedAt: WALL_FIXTURE_NOW, summary: reason,
        diagnostics: { input: { text: 'Write a portfolio briefing from Sources S1 and S2.', truncated: false, redacted: false }, output: { text: JSON.stringify({ status: 200, body: '{"choices":[{"message":{"content":"Headline: Review the release blocker' }), truncated: true, redacted: false } },
        output: captureWorkflowOutput({ operation: 'portfolio-brief', ok: false, failure: { kind: 'timeout' } }) },
    ] };
  const payload: WorkflowsPayload = { overrides: null, runtimeFresh: false, observationsFresh: true, generatedAt: WALL_FIXTURE_NOW, historyAvailable: true,
    runtime: { updatedAt: WALL_FIXTURE_NOW, error: null, manualJobs: ['portfolio-brief'], jobs: [{ id: 'portfolio-brief', enabled: true, cron: '35 * * * *', nextRun: null }] },
    ...buildWorkflowHistory([], [run], [], Date.parse(WALL_FIXTURE_NOW), run.id), selectedRun: run };
  await page.route('**/api/workflows*', route => route.fulfill({ json: payload }));
  await page.goto(`/health/operations/portfolio-brief?run=${encodeURIComponent(run.id)}`);
  await expect(page.locator('#boot-splash')).toHaveCount(0);
  const failure = page.getByRole('region', { name: 'Run failure' });
  await expect(failure.getByText(reason)).toBeVisible();
  await expect(failure.getByText(action)).toBeVisible();
  await expect(page.getByText(reason, { exact: true })).toHaveCount(1);
  await expect(page.getByText('Schedule · Local time')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Execution stages' })).not.toBeVisible();
  await expect(page.getByText('Output was not captured for this execution.')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await page.screenshot({ path: info.outputPath('synthetic-briefing-failure.png'), fullPage: true });
  await page.locator('main').screenshot({ path: info.outputPath('synthetic-briefing-failure-crop.png') });
  await expect(page.getByText('Run diagnostics', { exact: true })).toHaveCount(0);
  await page.getByText('Execution details', { exact: true }).click();
  const diagnostics = page.getByRole('complementary', { name: 'Stage details' });
  await expect(diagnostics.getByRole('heading', { name: 'Refresh portfolio briefing' })).toBeVisible();
  await diagnostics.locator('summary').filter({ hasText: /^Inputs$/ }).click();
  await expect(diagnostics.locator('pre').filter({ hasText: 'Write a portfolio briefing from Sources S1 and S2.' })).toBeVisible();
  await diagnostics.locator('summary').filter({ hasText: /^Output$/ }).click();
  await expect(diagnostics.locator('pre').filter({ hasText: 'Headline: Review the release blocker' })).toBeVisible();
  await expect(diagnostics.getByText('Truncated', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Execution stages' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  await page.screenshot({ path: info.outputPath('synthetic-briefing-diagnostics.png'), fullPage: true });
  await expect(page.getByText(reason, { exact: true })).toHaveCount(1);
});
