import { test, expect } from '../journey-test';
import { JOURNEY_ASSET, JOURNEY_NOW } from '../fixtures';
import { fetchToRewrite } from '../rewritten-read.mjs';
import { buildWorkflowHistory } from '../../vite/workflow-history';
import { captureWorkflowOutput } from '../../../../scripts/workflow-output.mjs';
import type { AssetDetailPayload } from '@shared/asset-detail';
import type { WorkflowRun, WorkflowsPayload } from '@shared/workflows';
import type { NewTask } from '@/lib/api';

const query = 'Meal plan, weekly';

test.beforeEach(async ({ request }) => {
  const reset = await request.post('/__journey/reset');
  expect(reset.ok()).toBe(true);
  expect((await (await request.get('/__journey/status')).json()).isolated).toBe(true);
});

async function noOverflow(page: import('@playwright/test').Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test('workflow handoff copies supported task instructions and files the same evidence', async ({ page, context, request, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  expect((await request.post('/api/assets', { headers: { origin: baseURL! },
    data: { id: JOURNEY_ASSET, domain: JOURNEY_ASSET, displayName: 'Journey Example' } })).status()).toBe(201);
  await page.route(`**/api/assets/${JOURNEY_ASSET}?*`, async route => {
    const { response, headers } = await fetchToRewrite(route);
    const payload = await response.json() as AssetDetailPayload;
    payload.executive = { schemaVersion: 1, asset: JOURNEY_ASSET, generatedAt: JOURNEY_NOW,
      windowStart: '2026-08-30', windowEnd: '2026-09-05', sourceArchiveCount: 1, methodology: [], suppressedItems: [], items: [], searchPages: null, productUse: null, searchIntelligence: null, serpPanel: null,
      searchQueries: { google: { provider: 'google', currentStart: '2026-08-30', currentEnd: '2026-09-05',
        previousStart: '2026-08-23', previousEnd: '2026-08-29', daysPerWindow: 7,
        movers: [{ query, currentImpressions: 200, previousImpressions: 2000, impressionDelta: -1800,
          impressionDeltaPercent: -90, currentPosition: 12, previousPosition: 3, positionImprovement: -9 }],
        evidence: [], source: 'gsc/search-analytics', caveat: 'Synthetic completed reporting windows.' }, bing: null, dataforseo: null } };
    await route.fulfill({ response, headers, json: payload });
  });
  await page.route('**/api/tasks/capabilities', route => route.fulfill({ json: {
    live: true, writable: true, projectSelection: true, operations: ['create', 'update', 'comment', 'close'], reason: null,
  } }));
  await page.route('**/api/tasks/projects', route => route.fulfill({ json: { projects: [{
    projectId: '33333333-1111-4111-8111-111111111111', logicalKey: JOURNEY_ASSET, displayName: 'Journey Example', prefix: 'jt',
  }] } }));
  const filed: NewTask[] = [];
  await page.route('**/api/tasks', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    filed.push(route.request().postDataJSON() as NewTask);
    await route.fulfill({ status: 201, json: { id: 'jt-handoff', project: JOURNEY_ASSET } });
  });
  await page.goto(`/assets/${JOURNEY_ASSET}/search`);
  await page.locator('#query-visibility summary').filter({ hasText: query }).click();
  await page.getByRole('button', { name: `Copy Markdown for ${query}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `Copied for ${query}`, exact: true })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  for (const name of ['list_workspaces', 'get_task_guide', 'list_projects', 'create_task', 'claim_task', 'close_task']) expect(copied).toContain('`' + name + '`');
  expect(copied).not.toMatch(/bd (?:create|close)|config\/beads\.json/);
  expect(copied).toContain('`projectId` as `project`');
  const task = JSON.parse(copied.match(/`{3,}json\n([\s\S]*?)\n`{3,}/)![1]!) as Omit<NewTask, 'project'>;
  expect(task.metadata?.noticeos_key).toBe('meal plan, weekly');
  expect(task.description).toContain(`${baseURL}/assets/${JOURNEY_ASSET}`);
  expect(task.description).toContain('Recheck the latest reports');
  await noOverflow(page);
  await page.getByRole('button', { name: `File task for ${query}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'File a task' });
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue(task.title);
  await expect(dialog.getByLabel('Project', { exact: true })).toHaveValue(JOURNEY_ASSET);
  await expect(dialog.getByLabel('Description', { exact: true })).toHaveValue(task.description!);
  await noOverflow(page);
  await dialog.getByRole('button', { name: 'File task', exact: true }).click();
  await expect.poll(() => filed.length).toBe(1);
  expect(filed[0]).toEqual({ ...task, project: JOURNEY_ASSET });
});

test('workflow site copy and readable outcomes retain captured verdict codes', async ({ page }) => {
  const startedAt = '2026-09-06T11:40:00.000Z', finishedAt = '2026-09-06T11:40:01.000Z';
  const trace: WorkflowRun = { id: `watch-windows@${startedAt}`, workflowId: 'watch-windows', definitionVersion: 1,
    startedAt, finishedAt, state: 'succeeded', steps: [{ id: 'outcomes', attempt: 1, startedAt, finishedAt, state: 'succeeded',
      output: captureWorkflowOutput({ closed: ['ship_confirmed', 'kill_confirmed', 'inconclusive', 'unmeasurable'].map((outcome, index) => ({ id: `window-${index}`, outcome })) }) }] };
  const payload: WorkflowsPayload = { overrides: null, runtime: null, runtimeFresh: false, observationsFresh: false,
    generatedAt: JOURNEY_NOW, historyAvailable: true,
    ...buildWorkflowHistory([{ job: 'watch-windows', at: startedAt, ms: 1000, outcome: 'ran' }], [trace], [], Date.parse(JOURNEY_NOW), trace.id) };
  await page.route('**/api/workflows*', route => route.fulfill({ json: payload }));
  await page.goto('/workflows/pull');
  await expect(page.getByRole('button', { name: /Collect site reports/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Collect asset reports/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Collect site reports/ }).click();
  await expect(page.getByLabel('Stage details')).toContainText('reports from sites configured');
  await noOverflow(page);
  await page.goto(`/workflows/watch-windows?run=${encodeURIComponent(trace.id)}`);
  await page.getByRole('button', { name: /Evaluate outcome windows/ }).click();
  const output = page.getByRole('region', { name: 'Step output', exact: true });
  const results = output.getByRole('table', { name: 'Output results' });
  for (const words of ['Worked', 'Did not help', 'Changed nothing', 'Could not be measured']) await expect(results).toContainText(words);
  await expect(results).not.toContainText('ship_confirmed');
  await noOverflow(page);
  await output.getByText('Captured data', { exact: true }).click();
  for (const code of ['ship_confirmed', 'kill_confirmed', 'inconclusive', 'unmeasurable']) await expect(output.locator('details')).toContainText(code);
  await noOverflow(page);
});
