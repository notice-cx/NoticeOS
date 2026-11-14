import { test, expect } from '../journey-test';
import { JOURNEY_ASSET, JOURNEY_KEY, JOURNEY_STRIPE_ACCOUNT, PR_SMOKE } from '../fixtures';
import { everyTabPayload, viewOf } from '../../test/asset-detail-fixture';
import { isAssetDetailView } from '../../shared/asset-detail-views';
import { compareStripe, summarizeStripe } from '@noticeos/contract/stripe-report';
import { demoStripeSales, demoStripeSnapshot, shiftDemoDay } from '../../../../scripts/demo-scenario.mjs';

test(`Assign Stripe revenue to an existing asset with no Stripe source ${PR_SMOKE}`, async ({ page, request, baseURL }) => {
  expect((await request.post('/__journey/reset')).ok()).toBe(true);
  const headers = { origin: new URL(baseURL!).origin };
  expect((await request.post('/api/assets', {
    headers, data: { id: JOURNEY_ASSET, domain: JOURNEY_ASSET, displayName: 'Journey Example' },
  })).status()).toBe(201);
  expect((await request.put('/api/config', { headers, data: { ops: [{
    kind: 'file-json-insert', file: 'config/integrations.json', pointer: `/assets/${JOURNEY_ASSET}`,
    value: { 'ad-network': { status: 'needs-setup', since: '2026-09-06' } },
  }] } })).ok()).toBe(true);

  await page.goto('/integrations');
  const stripe = page.locator('[data-integration-tile="stripe"]');
  await stripe.getByRole('button', { name: 'Connect Stripe revenue' }).click();
  const panel = page.getByRole('dialog', { name: 'Stripe revenue' });
  await panel.getByLabel('Restricted API key', { exact: true }).fill(JOURNEY_KEY);
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: /Asset/ })).toBeEnabled();
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await stripe.getByRole('button', { name: 'Assign Stripe revenue' }).click();
  await panel.getByRole('combobox', { name: /Asset/ }).selectOption(JOURNEY_ASSET);
  await panel.getByLabel(/Stripe account ID/).fill(JOURNEY_STRIPE_ACCOUNT);
  await panel.getByRole('button', { name: 'Assign revenue', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.reload();
  await stripe.getByRole('button', { name: 'Manage Stripe revenue' }).click();
  await expect(panel.getByText('Journey Example', { exact: true })).toBeVisible();
  await expect(panel).toContainText(JOURNEY_STRIPE_ACCOUNT);
  await panel.getByRole('button', { name: 'Edit account ID' }).click();
  const account = panel.getByLabel(/Stripe account ID/);
  await expect(account).toHaveValue(JOURNEY_STRIPE_ACCOUNT);
  await account.fill('acct_updated');
  await panel.getByRole('button', { name: 'Save account ID' }).click();
  await expect(panel).toHaveCount(0);
  await page.goto(`/assets/${JOURNEY_ASSET}/sources`);
  const source = page.locator(`[data-subject="source:${JOURNEY_ASSET}:subscriptions"]`).first();
  await source.getByRole('link', { name: 'Manage Stripe' }).click();
  await expect(panel).toContainText('acct_updated');
  await panel.getByRole('button', { name: 'Remove Stripe assignment for Journey Example' }).click();
  await expect(panel).toHaveCount(0);
  await page.reload();
  await expect(stripe.getByRole('button', { name: 'Assign Stripe revenue' })).toBeVisible();
});

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
  const figure = (label: string) => report.locator(`[data-stat="${label}"] [data-stat-figure]`);
  await expect(figure('Monthly recurring revenue')).toHaveText('$3,079.00');
  await expect(figure('Gross sales')).toHaveText('$1,955.49');
  await expect(figure('Net receipts')).toHaveText('$1,778.00');
  await expect(figure('Opening customer churn')).toHaveText('9.5%');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await report.scrollIntoViewIfNeeded();
  await info.attach('stripe-money', { body: await report.screenshot(), contentType: 'image/png' });
  await page.goto('/assets/meadow.example/growth?range=7');
  await expect(figure('Monthly recurring revenue')).toHaveText('$3,079.00');
  await expect(figure('MRR change')).toHaveText('$39.00');
  await expect(figure('Customers lost')).toHaveText('0');
  await expect(report.locator('[data-stat="Gross sales"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await info.attach('stripe-growth', { body: await report.screenshot(), contentType: 'image/png' });
});
