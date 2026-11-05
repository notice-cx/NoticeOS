import type { FinancialsPayload } from '../../shared/financials';
import { test, expect } from '../journey-test';
import { demoBankingReading } from '../../../../scripts/demo-banking.mjs';
import { generateDemoScenario } from '../../../../scripts/demo-scenario.mjs';

test('Mercury banking shows dated cash and pending activity independently of an empty revenue ledger @pull-request', async ({ page, request, baseURL }, info) => {
  expect((await request.post('/__journey/reset')).ok()).toBe(true);
  const payload: FinancialsPayload = {
    generatedAt: '2026-11-05T12:00:00Z', period: '2026-11', currentPeriod: '2026-11', periodIsCurrent: true,
    periods: [], months: [], properties: [], costLines: [], domains: [], recurringCosts: [], domainOrders: [],
    overhead: { currency: 'USD', revenue: 0, cost: 0, net: 0 }, empty: true,
    banking: { state: 'recorded', observedAt: '2026-11-05T12:00:00Z', snapshot: {
      currency: 'USD', windowStart: '2026-10-01T12:00:00Z', windowEnd: '2026-11-05T12:00:00Z',
      accounts: [{ id: '10000000-0000-4000-8000-000000000001', name: 'Operating', kind: 'checking', status: 'active', currentMinor: 125029, availableMinor: 110001 }],
      transactions: [{ id: '10000000-0000-4000-8000-000000000010', accountId: '10000000-0000-4000-8000-000000000001',
        createdAt: '2026-11-04T12:00:00Z', postedAt: null, amountMinor: -1029, kind: 'debitCardTransaction', status: 'pending', counterparty: 'Example vendor' }],
    } },
  };
  await page.route(url => url.origin === baseURL && url.pathname === '/api/financials', route => route.fulfill({ json: payload }));
  await page.goto('/financials');
  await expect(page.getByText('No revenue or costs recorded yet')).toBeVisible();
  const banking = page.getByRole('region', { name: 'Mercury banking' });
  await expect(banking.getByText('$1,100.01', { exact: true })).toHaveCount(2);
  await expect(banking.locator('time').first()).toHaveAttribute('datetime', '2026-11-05T12:00:00Z');
  await banking.getByText('Recent bank activity', { exact: true }).click();
  await expect(banking.getByText('pending', { exact: true })).toBeVisible();
  await expect(banking.getByText('-$10.29', { exact: true })).toBeVisible();
  await expect(banking.getByText('Example vendor')).toBeVisible();
  expect(await banking.evaluate(element => [...element.querySelectorAll('[data-table-box]')].every(box => box.scrollWidth <= box.clientWidth))).toBe(true);
  await info.attach('Mercury banking', { body: await banking.screenshot(), contentType: 'image/png' });
  await banking.getByRole('link', { name: 'Manage connection' }).click();
  await expect(page).toHaveURL(/\/integrations$/);
  await expect(page.getByText('Mercury', { exact: true }).first()).toBeVisible();
});

test('Mercury demo accounts and varied recent activity fit both viewports @pull-request', async ({ page, request, baseURL }, info) => {
  expect((await request.post('/__journey/reset')).ok()).toBe(true);
  const at = '2026-11-21T12:00:00.000Z';
  const scenario = generateDemoScenario({ seed: 'banking-browser-demo', cutoff: at, release: 'a'.repeat(40) });
  const { snapshot } = demoBankingReading(scenario, at);
  snapshot.transactions = snapshot.transactions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 25);
  const payload: FinancialsPayload = {
    generatedAt: at, period: '2026-11', currentPeriod: '2026-11', periodIsCurrent: true,
    periods: [], months: [], properties: [], costLines: [], domains: [], recurringCosts: [], domainOrders: [],
    overhead: { currency: 'USD', revenue: 0, cost: 0, net: 0 }, empty: true,
    banking: { state: 'recorded', observedAt: at, snapshot },
  };
  await page.route(url => url.origin === baseURL && url.pathname === '/api/financials', route => route.fulfill({ json: payload }));
  await page.goto('/financials');
  const banking = page.getByRole('region', { name: 'Mercury banking' });
  await expect(banking.getByText('Operating', { exact: true }).first()).toBeVisible();
  await expect(banking.getByText('Tax reserve', { exact: true }).first()).toBeVisible();
  await banking.getByText('Recent bank activity', { exact: true }).click();
  await expect(banking.locator('details tbody tr')).toHaveCount(25);
  await expect(banking.getByText('pending', { exact: true }).first()).toBeVisible();
  await expect(banking.getByText('failed', { exact: true }).first()).toBeVisible();
  await expect(banking.getByText(/^Stripe ·/).first()).toBeVisible();
  await expect(banking.getByText('Design tools refund', { exact: true })).toBeVisible();
  expect(await banking.evaluate(element => [...element.querySelectorAll('[data-table-box]')].every(box => box.scrollWidth <= box.clientWidth))).toBe(true);
  await info.attach('Mercury demo financials', { body: await banking.screenshot(), contentType: 'image/png' });
  await page.route(url => url.origin === baseURL && url.pathname === '/api/financials' && url.searchParams.get('period') === '2020-01',
    route => route.fulfill({ status: 404, json: { error: 'period_not_found', periods: ['2026-11'], banking: payload.banking } }));
  await page.goto('/financials?period=2020-01');
  await expect(page.getByText('Nothing recorded for January 2020')).toBeVisible();
  await expect(banking).toBeVisible();
  await expect(banking.getByText('Tax reserve', { exact: true }).first()).toBeVisible();
});
