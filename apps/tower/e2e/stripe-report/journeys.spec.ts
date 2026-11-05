import { test, expect } from '../journey-test';
import { PR_SMOKE } from '../fixtures';
import { everyTabPayload, viewOf } from '../../test/asset-detail-fixture';
import { isAssetDetailView } from '../../shared/asset-detail-views';
import { compareStripe, summarizeStripe } from '@noticeos/contract/stripe-report';
import { demoStripeSales, demoStripeSnapshot, shiftDemoDay } from '../../../../scripts/demo-scenario.mjs';

test(`Stripe reports show cash and subscription growth across ranges ${PR_SMOKE}`, async ({ page, request }, info) => {
  expect((await request.post('/__journey/reset')).ok()).toBe(true);
  const body = everyTabPayload();
  body.osTimeZone = 'UTC';
  const anchor = '2026-07-05';
  const history = Array.from({ length: 91 }, (_, index) => {
    const date = shiftDemoDay(anchor, index - 90);
    return { date, at: `${date}T01:00:00.000Z`, snapshot: demoStripeSnapshot(date, anchor) };
  });
  const last = history.at(-1)!;
  body.stripeSubscriptions = {
    latest: summarizeStripe(last.snapshot, last.at),
    history: history.map(row => summarizeStripe(row.snapshot, row.at)),
    comparisons: [7, 28, 90].map(days => {
      const first = history[90 - days]!;
      return { days, growth: compareStripe(first.snapshot, last.snapshot, first.at, last.at) };
    }),
  };
  const days = Array.from({ length: 28 }, (_, index) => ({ date: shiftDemoDay('2026-07-04', index - 27), amountMinor: 5000 + index * 100 }));
  body.dailyRevenue = { from: days[0]!.date, to: days.at(-1)!.date, days, reportedThrough: days.at(-1)!.date,
    bySource: [{ source: 'stripe', provider: 'stripe', family: 'subs', displayName: 'Stripe subscriptions', currency: 'USD',
      clock: { timeZone: 'UTC', label: 'UTC', readyAfterMinute: 60 }, since: days[0]!.date, reportedThrough: days.at(-1)!.date,
      days: days.map(day => ({ ...day, sales: demoStripeSales(day.amountMinor, day.date) })) }] };
  await page.clock.install({ time: new Date('2026-07-05T12:00:00Z') });
  await page.route('**/api/assets/meadow.example?*', async route => {
    const view = new URL(route.request().url()).searchParams.get('view');
    await route.fulfill({ json: isAssetDetailView(view) ? viewOf(body, view) : body });
  });
  await page.goto('/assets/meadow.example/financials?range=28');
  const report = page.locator('[data-stripe-report]');
  await expect(report.getByText('Monthly recurring revenue', { exact: true })).toBeVisible();
  await expect(report.getByText('Gross sales', { exact: true })).toBeVisible();
  await expect(report.getByText('Net receipts', { exact: true })).toBeVisible();
  await expect(report.getByText('Opening customer churn', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await report.scrollIntoViewIfNeeded();
  await info.attach('stripe-money', { body: await report.screenshot(), contentType: 'image/png' });
  await page.goto('/assets/meadow.example/growth?range=7');
  await expect(report.getByText('Monthly recurring revenue', { exact: true })).toBeVisible();
  await expect(report.getByText('Customers lost', { exact: true })).toBeVisible();
  await expect(report.getByText('Gross sales', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await info.attach('stripe-growth', { body: await report.screenshot(), contentType: 'image/png' });
});
