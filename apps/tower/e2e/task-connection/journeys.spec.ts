import { test, expect } from '../journey-test';
import { JOURNEY_ASSET, JOURNEY_FINDING_KEY, PR_SMOKE, journeyFindingSnapshot } from '../fixtures';
import { fetchToRewrite } from '../rewritten-read.mjs';
import { TASK_SERVICE_STATUS_PATH } from '../../shared/tasks';

test('disconnected task actions expose setup to keyboard and touch', { tag: PR_SMOKE }, async ({ page, request, baseURL, isMobile }, info) => {
  expect((await request.post('/__journey/reset')).ok()).toBe(true);
  expect((await request.post('/api/assets', { headers: { origin: baseURL! },
    data: { id: JOURNEY_ASSET, domain: JOURNEY_ASSET, displayName: 'Journey Example' } })).status()).toBe(201);
  await page.route(`**/api/assets/${JOURNEY_ASSET}?*`, async route => {
    const { response, headers } = await fetchToRewrite(route);
    const payload = await response.json();
    const finding = journeyFindingSnapshot();
    payload.executive = { ...finding, items: finding.items.map(item => ({ ...item, kind: 'recommendation' })) };
    await route.fulfill({ response, headers, json: payload });
  });
  await page.route('**/api/tasks/capabilities', route => route.fulfill({ json: { live: true, writable: true, reason: null } }));
  await page.route(`**${TASK_SERVICE_STATUS_PATH}`, route => route.fulfill({ json: { connected: false, origin: null, projects: null, required: true } }));
  await page.goto(`/assets/${JOURNEY_ASSET}`);
  await expect(page.locator('#boot-splash')).toHaveCount(0);
  const row = page.locator(`[data-finding-row="${JOURNEY_FINDING_KEY}"]`);
  await expect(row.locator('[data-file-task]')).toBeDisabled();
  const setup = row.getByRole('link', { name: 'Connect Ntasks', exact: true });
  await expect(setup).toBeVisible();
  await setup.scrollIntoViewIfNeeded();
  const size = await setup.boundingBox();
  expect(size).not.toBeNull();
  if (isMobile) expect(size!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await row.screenshot({ path: info.outputPath('disconnected-task-action.png'), animations: 'disabled' });
  if (isMobile) await setup.tap();
  else {
    await setup.focus();
    await expect(setup).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await expect(page).toHaveURL(/\/settings\/task-projects$/);
});
