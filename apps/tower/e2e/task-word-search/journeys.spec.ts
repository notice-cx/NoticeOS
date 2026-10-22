import type { Page } from '@playwright/test';
import { test, expect } from '../journey-test';
import { searchBoard, searchSnapshot, SEARCH_PROJECT, SEARCH_TARGET } from '../../test/task-word-search-fixture';

// journey-test owns the server, browser profile and same-origin offline guards.
test.beforeEach(async ({ request, baseURL }) => {
  if (!baseURL) throw new Error('The search journeys require an isolated fixture server');
  expect((await request.post('/__journey/reset')).ok()).toBe(true);
  expect((await (await request.get('/__journey/status')).json()).isolated).toBe(true);
});

async function fixture(page: Page) {
  await page.route('**/api/work', route => route.fulfill({ json: searchSnapshot() }));
  await page.route('**/api/tasks/capabilities', route => route.fulfill({ json: { live: true, reason: null } }));
  await page.route(/\/api\/tasks\?/, route => route.fulfill({ json: searchBoard() }));
  await page.route(`**/api/tasks/${SEARCH_TARGET}`, route => route.fulfill({ json: {
    project: SEARCH_PROJECT, prefix: 'ex', repo: '.', readAt: searchBoard().readAt,
    task: searchBoard().tasks.at(-1), comments: [],
  } }));
}

async function filters(page: Page) {
  const search = page.getByRole('searchbox', { name: 'Search task titles or ids' });
  if (!await search.isVisible()) await page.getByRole('button', { name: /^Filters/ }).click();
  return search;
}

test('task word search finds row 250, composes filters and survives refresh and detail return', async ({ page }) => {
  await fixture(page);
  await page.goto('/tasks/all');
  const rows = page.locator('tr[data-task-row]');
  await expect(rows).toHaveCount(25);
  await expect(page.locator(`[data-task-row="${SEARCH_TARGET}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: /Load 25 more/ }).click();
  await expect(rows).toHaveCount(50);
  let search = await filters(page);
  await search.fill('routine');
  await expect(rows).toHaveCount(25);
  await search.fill('  (V2)  API:  ');
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAttribute('data-task-row', SEARCH_TARGET);
  expect(new URL(page.url()).searchParams.get('q')).toBe('  (V2)  API:  ');

  const picks = new URLSearchParams({ q: 'API: retry', project: SEARCH_PROJECT, status: 'open', priority: 'normal', label: 'review', assignee: 'Ada' });
  await page.goto(`/tasks/all?${picks}`);
  await expect(rows).toHaveCount(1);
  await page.reload();
  await expect(rows).toHaveCount(1);
  search = await filters(page);
  await expect(search).toHaveValue('API: retry');
  await expect(search).toHaveAccessibleDescription(/live closes: last 7 days/);
  await page.getByRole('button', { name: 'Repair API: retry (v2)', exact: true }).click();
  await expect(page.locator(`[data-task-detail="${SEARCH_TARGET}"]`).getByRole('button', { name: 'Claim', exact: true })).toBeEnabled();
  await page.locator(`[data-task-open="${SEARCH_TARGET}"]`).click();
  await expect(page.getByRole('heading', { name: 'Repair API: retry (v2)', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Tasks', exact: true }).last().click();
  await expect(page).toHaveURL(new RegExp(`/tasks/all\\?${picks.toString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  await expect(rows).toHaveCount(1);
  search = await filters(page);
  await search.fill(SEARCH_TARGET.toUpperCase());
  await expect(rows).toHaveCount(1);
  await page.getByRole('link', { name: 'Clear filters' }).click();
  await expect(rows).toHaveCount(25);
  expect(new URL(page.url()).search).toBe('');
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
});

test('task word search palette opens the searched board without task reads on initial open or typing', async ({ page }) => {
  await fixture(page);
  await page.goto('/assets');
  await expect(page.getByRole('heading', { name: 'Sites', exact: true })).toBeVisible();
  const apiReads: string[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) apiReads.push(url.pathname); });
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Search pages and sites' });
  const input = palette.getByRole('combobox');
  await expect(input).toBeFocused();
  expect(apiReads).toEqual([]);
  await input.fill('API: retry');
  await expect(palette.getByRole('option', { name: 'Search tasks for “API: retry”' })).toBeVisible();
  expect(apiReads).toEqual([]);
  await palette.getByRole('option', { name: 'Search tasks for “API: retry”' }).click();
  await expect(page).toHaveURL(/\/tasks\/all\?q=API%3A\+retry$/);
  await expect(page.locator('tr[data-task-row]')).toHaveCount(1);
  await expect(page.locator('tr[data-task-row]')).toHaveAttribute('data-task-row', SEARCH_TARGET);
  await expect(palette).toHaveCount(0);
});

test('task word search distinguishes no matches from snapshot and unavailable reads', async ({ page }) => {
  await fixture(page);
  await page.goto('/tasks/all?q=absent');
  await expect(page.getByText('No task matches these filters.', { exact: true })).toBeVisible();
  await page.route('**/api/tasks/capabilities', route => route.fulfill({ json: { live: false, reason: 'read_only_deployment' } }));
  await page.reload();
  await expect(page.getByText('No matches in available records. The search is limited to the tasks read.', { exact: true })).toBeVisible();
  await expect(page.getByText(/snapshots: listed tasks only/)).toBeVisible();
  await page.route('**/api/tasks/capabilities', route => route.fulfill({ json: { live: true, reason: null } }));
  await page.route(/\/api\/tasks\?/, route => route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } }));
  await page.reload();
  await expect(page.getByText('Search is incomplete: some projects could not be read.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry →', exact: true })).toBeVisible();
});
