import type { Locator, Page, TestInfo } from '@playwright/test';
import type { FinancialsPayload } from '../../shared/financials';
import { test, expect } from '../journey-test';

const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const PERIODS = ['2026-07', '2026-08'];

function figures(period = '2026-08'): FinancialsPayload {
  const total = { currency: 'USD', revenue: 441, cost: 200, net: 241 };
  const zero = { currency: 'USD', revenue: 0, cost: 0, net: 0 };
  return {
    generatedAt: '2026-09-01T08:00:00.000Z', period, periods: PERIODS,
    periodIsCurrent: false, currentPeriod: '2026-09',
    months: PERIODS.map(month => ({ period: month, booked: zero, estimated: total, total })),
    properties: [{ asset: 'meadow.example', displayName: 'Meadow', isOs: false,
      revenueReported: true, figure: total, months: PERIODS.map(month => ({ period: month, figure: total })) }],
    overhead: zero, costLines: [], domains: [], recurringCosts: [], domainOrders: [], empty: false,
  };
}

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

async function setup(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript(value => localStorage.setItem('noticeos:theme', value), theme);
  await page.emulateMedia({ colorScheme: theme });
  await page.clock.install({ time: new Date(NOW) });
  await page.clock.setFixedTime(new Date(NOW));
}

async function capture(page: Page, status: Locator, info: TestInfo, theme: string) {
  await expect(status).toBeInViewport();
  const retry = status.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  const geometry = await status.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const button = element.querySelector('button')!.getBoundingClientRect();
    const lines: DOMRect[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      lines.push(...range.getClientRects());
    }
    return {
      overflow: document.documentElement.scrollWidth - innerWidth,
      clipped: lines.some(line => line.left < bounds.left || line.right > bounds.right + 1),
      buttonFits: button.left >= bounds.left && button.right <= bounds.right && button.bottom <= bounds.bottom,
      touchHeight: button.height,
    };
  });
  expect(geometry).toMatchObject({ overflow: 0, clipped: false, buttonFits: true });
  if (info.project.name === 'mobile') expect(geometry.touchHeight).toBeGreaterThanOrEqual(44);
  await info.attach(`status-${theme}-geometry`, { body: JSON.stringify(geometry), contentType: 'application/json' });
  await info.attach(`status-${theme}`, { body: await page.screenshot(), contentType: 'image/png' });
}

for (const theme of ['dark', 'light'] as const) {
  test(`Money refresh status: retained read, retry and recovery in ${theme}`, async ({ page, request, baseURL }, info) => {
    expect((await request.post('/__journey/reset')).ok()).toBe(true);
    expect((await (await request.get('/__journey/status')).json()).isolated).toBe(true);
    await setup(page, theme);
    const refresh = gate(), retry = gate();
    let phase: 'success' | 'refresh' | 'retry' = 'success';
    let reads = 0, navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations += 1; });
    await page.route(url => url.origin === baseURL && url.pathname === '/api/financials', async route => {
      reads += 1;
      if (phase === 'success') await route.fulfill({ json: figures() });
      else if (phase === 'refresh') {
        await refresh.promise;
        await route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
      } else {
        await retry.promise;
        // A successful HTTP read can still contain the same unconfirmed inputs.
        await route.fulfill({ json: figures() });
      }
    });
    try {
      await page.goto('/financials?period=2026-08');
      const main = page.getByRole('main');
      const answer = main.locator('[data-money-answer]');
      const picker = main.getByRole('combobox', { name: 'Accounting period' });
      await expect(answer).toContainText('$441');
      const retained = await answer.textContent();
      const lastRead = new Date(await page.evaluate(() => Date.now())).toISOString();
      expect(lastRead).not.toBe(figures().generatedAt);
      await expect(main.getByText('Refresh failed', { exact: true })).toHaveCount(0);
      const initialNavigations = navigations;
      phase = 'refresh';
      await page.clock.setFixedTime(new Date(NOW + 300_000));
      await page.clock.runFor(300_001);
      await expect.poll(() => reads).toBe(2);
      await expect(answer).toHaveText(retained!);
      await expect(main.getByText('Refresh failed', { exact: true })).toHaveCount(0);
      refresh.release();
      const status = main.getByRole('status');
      // Let response processing finish between clock steps; the real hook
      // still performs its three retries with exponential backoff.
      await expect.poll(async () => {
        await page.clock.runFor(1_000);
        return status.count();
      }).toBe(1);
      await expect(status).toHaveCount(1);
      await expect(status).toContainText('Refresh failed');
      await expect(status).toContainText('Showing August 2026');
      await expect(status).toContainText('Last successful read');
      await expect(status.locator('time')).toHaveAttribute('datetime', lastRead);
      expect(await page.evaluate(() => Date.now())).toBeGreaterThan(Date.parse(lastRead));
      await expect(answer).toHaveText(retained!);
      await expect(picker).toHaveValue('2026-08');
      await expect(page).toHaveURL(/period=2026-08$/);
      await capture(page, status, info, theme);
      phase = 'retry';
      await page.clock.setFixedTime(new Date(NOW + 600_000));
      const button = status.getByRole('button', { name: 'Try again' });
      for (let step = 0; step < 80 && !await button.evaluate(el => el === document.activeElement); step += 1) {
        await page.keyboard.press('Tab');
      }
      await expect(button).toBeFocused();
      await page.keyboard.press('Enter');
      const pending = status.getByRole('button', { name: 'Retrying…' });
      await expect(pending).toBeDisabled();
      const retryReads = reads;
      await pending.evaluate((el: HTMLButtonElement) => { el.click(); el.click(); });
      expect(reads).toBe(retryReads);
      await expect(status.locator('time')).toHaveAttribute('datetime', lastRead);
      await expect(answer).toHaveText(retained!);
      retry.release();
      await expect(status).toHaveCount(0);
      await expect(answer).toHaveText(retained!);
      await expect(main.locator('[data-money-confirmed]')).toHaveText('none confirmed yet');
      await expect(picker).toHaveValue('2026-08');
      expect(reads).toBe(6);
      expect(navigations).toBe(initialNavigations);
      // A second failure must show the recovery's successful read time.
      phase = 'refresh';
      const recoveredAt = new Date(await page.evaluate(() => Date.now())).toISOString();
      await page.clock.setFixedTime(new Date(NOW + 900_000));
      await page.clock.runFor(300_001);
      await expect.poll(async () => {
        await page.clock.runFor(1_000);
        return status.count();
      }).toBe(1);
      await expect(status.locator('time')).toHaveAttribute('datetime', recoveredAt);
    } finally {
      refresh.release(); retry.release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

test('Money refresh status: month switching, missing period and initial failure stay distinct', async ({ page, request, baseURL }) => {
  expect((await request.post('/__journey/reset')).ok()).toBe(true);
  await setup(page, 'dark');
  const month = gate();
  let missing = false, initialFailure = false;
  await page.route(url => url.origin === baseURL && url.pathname === '/api/financials', async route => {
    const period = new URL(route.request().url()).searchParams.get('period');
    if (initialFailure) await route.fulfill({ status: 503, json: { error: 'fixture_unavailable' } });
    else if (period === '2026-07') {
      await month.promise;
      await route.fulfill(missing
        ? { status: 404, json: { error: 'period_not_found', periods: ['2026-08'] } }
        : { json: figures('2026-07') });
    } else await route.fulfill({ json: figures() });
  });
  try {
    await page.goto('/financials?period=2026-08');
    const main = page.getByRole('main');
    const picker = main.getByRole('combobox', { name: 'Accounting period' });
    await expect(main.locator('[data-money-answer]')).toContainText('August 2026');
    await picker.selectOption('2026-07');
    await expect(main.getByRole('status')).toHaveText('Loading July 2026');
    await expect(picker).toHaveValue('2026-08');
    await expect(main.locator('[data-money-answer]')).toContainText('August 2026');
    await expect(main.getByText('Refresh failed', { exact: true })).toHaveCount(0);
    await expect(main.getByText(/Last successful read/)).toHaveCount(0);
    missing = true;
    month.release();
    await expect(main.getByText('Nothing recorded for July 2026')).toBeVisible();
    await expect(main.locator('[data-money-answer]')).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await main.getByRole('link', { name: 'August 2026' }).click();
    await expect(main.locator('[data-money-answer]')).toContainText('August 2026');
    initialFailure = true;
    await page.goto('/financials?period=2026-08');
    await expect.poll(async () => {
      await page.clock.runFor(1_000);
      return main.locator('[data-read-failed]').count();
    }).toBe(1);
    await expect(main.locator('[data-read-failed]')).toContainText('The ledger could not be read');
    await expect(main.getByText(/Last successful read/)).toHaveCount(0);
    initialFailure = false;
    await main.getByRole('button', { name: 'Try again' }).click();
    await expect(main.locator('[data-money-answer]')).toContainText('August 2026');
    await expect(main.locator('[data-read-failed]')).toHaveCount(0);
  } finally {
    month.release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
