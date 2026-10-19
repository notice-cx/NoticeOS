// Stripe subscription revenue: each completed UTC day's net sales less refunds
// from the connected account's balance transactions, one daily total per site
// in the revenue ledger. Stripe itself is a stub; the store is the test
// Postgres.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STRIPE_REVENUE_SOURCE } from '@noticeos/contract/revenue-sources';
import { putCredential } from '../src/credentials.js';
import { probeCredential } from '../src/credential-probes.js';
import type { LaneRegister } from '../src/lane-mapping.js';
import { STRIPE_WINDOW_DAYS, lastCompleteDay, runStripeRevenue, stripeWindow } from '../src/stripe.js';
import { credentialVerdict, pgCount, pgRows, reset, storedHealthStates } from './helpers.js';

const NOW = Date.parse('2026-09-09T13:10:00Z');
const DAY_MS = 86_400_000;
const KEY = 'rk_test_synthetic-stripe-key';
const ASSET = 'meadow.example';
const ACCOUNT = 'acct_1Synthetic';
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function register(cells: Record<string, Record<string, unknown>> = { [ASSET]: { stripeAccountId: ACCOUNT } }): LaneRegister {
  return { assets: Object.fromEntries(Object.entries(cells).map(([asset, cell]) => [asset, { subscriptions: { status: 'live', since: '2026-09-01', ...cell } }])) };
}

/** Balance transactions as Stripe lists them, newest first. */
const TRANSACTIONS = [
  { id: 'txn_08', type: 'charge', net: 990, currency: 'usd', created: at('2026-09-08T00:00:00Z') },
  { id: 'txn_07r', type: 'refund', net: -2000, currency: 'usd', created: at('2026-09-07T23:59:59Z') },
  { id: 'txn_07fee', type: 'stripe_fee', net: -500, currency: 'usd', created: at('2026-09-07T20:00:00Z') },
  { id: 'txn_07out', type: 'payout', net: -50000, currency: 'usd', created: at('2026-09-07T18:00:00Z') },
  { id: 'txn_07eur', type: 'charge', net: 7000, currency: 'eur', created: at('2026-09-07T12:00:00Z') },
  { id: 'txn_07p', type: 'payment', net: 1000, currency: 'usd', created: at('2026-09-07T11:00:00Z') },
  { id: 'txn_07c', type: 'charge', net: 4610, currency: 'usd', created: at('2026-09-07T10:00:00Z') },
  // The padded day before the window: read, then dropped by date.
  { id: 'txn_before', type: 'charge', net: 123456, currency: 'usd', created: at('2026-08-04T23:00:00Z') },
];

interface StripeCall { path: string; params: URLSearchParams; authorization: string | null }

/** Stripe, two transactions a page. */
function stripe(options: { status?: number; currencies?: string[]; transactions?: typeof TRANSACTIONS } = {}) {
  const calls: StripeCall[] = [];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.stripe.com') throw new Error(`unexpected fetch: ${url.origin}`);
    calls.push({ path: url.pathname, params: url.searchParams, authorization: new Headers(init?.headers).get('authorization') });
    if (options.status) return Response.json({ error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } }, { status: options.status });
    if (url.pathname === '/v1/balance') {
      return Response.json({ object: 'balance', available: (options.currencies ?? ['usd']).map((currency) => ({ amount: 100, currency })), pending: [] });
    }
    if (url.pathname === '/v1/balance_transactions') {
      const gte = Number(url.searchParams.get('created[gte]'));
      const lt = Number(url.searchParams.get('created[lt]'));
      const all = (options.transactions ?? TRANSACTIONS).filter((row) => row.created >= gte && row.created < lt);
      const after = url.searchParams.get('starting_after');
      const from = after === null ? 0 : all.findIndex((row) => row.id === after) + 1;
      const data = all.slice(from, from + 2);
      return Response.json({ object: 'list', data, has_more: from + 2 < all.length });
    }
    return new Response('{}', { status: 404 });
  });
  return { fetchImpl, calls };
}

async function connect(): Promise<void> {
  expect(await putCredential(env, { provider: 'stripe', fields: { STRIPE_API_KEY: KEY } })).toMatchObject({ ok: true });
}

async function stored(): Promise<{ day: string; amount: number; currency: string; account: string }[]> {
  const rows = await pgRows<{ day: string; amount: string; currency: string; account: string }>(
    `SELECT revenue_date::text AS day, amount_minor::text AS amount, currency, account_ref AS account
       FROM noticeos.current_revenue WHERE source = $1 ORDER BY revenue_date`, [STRIPE_REVENUE_SOURCE]);
  return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
}

beforeEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

describe('the Stripe window', () => {
  it('counts a day complete from the minute its vocabulary row names, on that row’s clock', () => {
    const clock = { timeZone: 'UTC', readyAfterMinute: 60 };
    expect(lastCompleteDay(Date.parse('2026-09-09T00:59:00Z'), clock)).toBe('2026-09-07');
    expect(lastCompleteDay(Date.parse('2026-09-09T01:00:00Z'), clock)).toBe('2026-09-08');
  });

  it('reads one window back on a first run, from the day after the newest held day after that, and never more than one window', () => {
    expect(stripeWindow('2026-09-08', null)).toEqual({ start: '2026-08-05', end: '2026-09-08' });
    expect(stripeWindow('2026-09-08', '2026-09-05')).toEqual({ start: '2026-09-06', end: '2026-09-08' });
    expect(stripeWindow('2026-09-08', '2026-09-08')).toBeNull();
    expect(stripeWindow('2026-09-08', '2026-01-01')).toEqual({ start: '2026-08-05', end: '2026-09-08' });
  });
});

describe('runStripeRevenue', () => {
  it('sums each completed day’s sales less refunds, in minor units, one row a day', async () => {
    await connect();
    const { fetchImpl, calls } = stripe();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await runStripeRevenue(env, { fetchImpl, nowMs: NOW, laneRegister: register() });

    expect(result).toMatchObject({ outcome: 'ran', connected: true });
    expect(result.outcomes).toEqual([{ asset: ASSET, account: ACCOUNT, status: 'collected', days: STRIPE_WINDOW_DAYS, written: STRIPE_WINDOW_DAYS, errorCode: null }]);
    const days = await stored();
    expect(days).toHaveLength(STRIPE_WINDOW_DAYS);
    expect(days[0]).toEqual({ day: '2026-08-05', amount: 0, currency: 'USD', account: ACCOUNT });
    // Charges and payments less the refund; fees, payouts and another
    // currency's sale are not revenue in this account's currency.
    expect(days.find((day) => day.day === '2026-09-07')).toMatchObject({ amount: 4610 + 1000 - 2000 });
    expect(days.at(-1)).toMatchObject({ day: '2026-09-08', amount: 990 });
    expect(days.reduce((sum, day) => sum + day.amount, 0)).toBe(3610 + 990);
    // The key travels in the header only, pages follow Stripe's cursor, and
    // the window is read a day wider on each side.
    expect(calls.every((call) => call.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(calls.some((call) => call.params.toString().includes(KEY))).toBe(false);
    const lists = calls.filter((call) => call.path === '/v1/balance_transactions');
    expect(lists.length).toBeGreaterThan(1);
    expect(lists[0]!.params.get('created[gte]')).toBe(String(at('2026-08-04T00:00:00Z')));
    expect(lists[0]!.params.get('created[lt]')).toBe(String(at('2026-09-10T00:00:00Z')));
    // Evidence: the site's collection, and the key's verdict.
    expect((await storedHealthStates()).find((row) => row.capability === 'stripe-revenue')).toMatchObject({ asset: ASSET, outcome: 'success' });
    expect((await credentialVerdict('stripe'))?.lastError).toBeNull();
    // No key and no amount reaches the log.
    const lines = JSON.stringify(log.mock.calls);
    expect(lines).not.toContain(KEY);
    expect(lines).not.toContain('3610');
    expect(lines).not.toContain('990');
  });

  it('asks Stripe nothing and writes nothing again once every completed day is held', async () => {
    await connect();
    const first = stripe();
    await runStripeRevenue(env, { fetchImpl: first.fetchImpl, nowMs: NOW, laneRegister: register() });
    const before = await pgCount('SELECT count(*) AS n FROM noticeos.revenue_observations');

    const again = stripe();
    const result = await runStripeRevenue(env, { fetchImpl: again.fetchImpl, nowMs: NOW + 3_600_000, laneRegister: register() });

    expect(result).toMatchObject({ outcome: 'skipped', detail: 'No Stripe day is due.' });
    expect(again.calls).toHaveLength(0);
    expect(await pgCount('SELECT count(*) AS n FROM noticeos.revenue_observations')).toBe(before);

    // The next day reads that day alone and writes one row.
    const next = stripe();
    const tomorrow = await runStripeRevenue(env, { fetchImpl: next.fetchImpl, nowMs: NOW + DAY_MS, laneRegister: register() });
    expect(tomorrow.outcomes[0]).toMatchObject({ status: 'collected', days: 1, written: 1 });
    expect(await pgCount('SELECT count(*) AS n FROM noticeos.revenue_observations')).toBe(before + 1);
  });

  it('records "not connected" and asks nothing when no key is connected', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { fetchImpl, calls } = stripe();

    const result = await runStripeRevenue(env, { fetchImpl, nowMs: NOW, laneRegister: register() });

    expect(result).toEqual({ outcome: 'skipped', detail: 'Stripe is not connected.', connected: false, outcomes: [] });
    expect(calls).toHaveLength(0);
    expect(await stored()).toEqual([]);
    expect(log.mock.calls.map(([line]) => String(line))).toContain(JSON.stringify({ event: 'stripe_not_connected' }));
  });

  it('stops at a refused key: nothing is stored, the card shows why, and the key is not shown', async () => {
    await connect();
    const { fetchImpl, calls } = stripe({ status: 401 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await runStripeRevenue(env, { fetchImpl, nowMs: NOW, laneRegister: register() });

    expect(calls).toHaveLength(1);
    expect(result.outcome).toBe('failed');
    expect(result.outcomes.map((outcome) => outcome.errorCode)).toEqual(['stripe_http_401']);
    expect(await stored()).toEqual([]);
    expect((await credentialVerdict('stripe'))?.lastError).toBe('Stripe refused the key (HTTP 401).');
    expect((await storedHealthStates()).find((row) => row.capability === 'stripe-revenue')).toMatchObject({ outcome: 'failure', failure_kind: 'access' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('collects for no site while two name a Stripe account, since one key reads one account', async () => {
    await connect();
    const { fetchImpl, calls } = stripe();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await runStripeRevenue(env, {
      fetchImpl, nowMs: NOW,
      laneRegister: register({ [ASSET]: { stripeAccountId: ACCOUNT }, 'northwind.example': { stripeAccountId: 'acct_2Synthetic' } }),
    });

    expect(calls).toHaveLength(0);
    expect(result.outcomes.map((outcome) => [outcome.asset, outcome.errorCode])).toEqual([
      [ASSET, 'stripe_mapping_shared'], ['northwind.example', 'stripe_mapping_shared'],
    ]);
    expect(await stored()).toEqual([]);
  });

  it('skips a site whose Subscriptions entry is declined, and records one currency only', async () => {
    await connect();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const declined = stripe();
    const skipped = await runStripeRevenue(env, { fetchImpl: declined.fetchImpl, nowMs: NOW, laneRegister: register({ [ASSET]: { stripeAccountId: ACCOUNT, status: 'skipped', note: 'REASON: not used' } }) });
    expect(skipped).toMatchObject({ outcome: 'skipped', outcomes: [] });
    expect(declined.calls).toHaveLength(0);

    const mixed = stripe({ currencies: ['usd', 'eur'] });
    const result = await runStripeRevenue(env, { fetchImpl: mixed.fetchImpl, nowMs: NOW, laneRegister: register() });
    expect(result.outcomes.map((outcome) => outcome.errorCode)).toEqual(['stripe_currency_config']);
    expect(await stored()).toEqual([]);
  });

  it('tests a key with one read of the balance', async () => {
    await connect();
    const { fetchImpl, calls } = stripe();
    const probe = await probeCredential(env, 'stripe', { fetchImpl });
    expect(probe.ok).toBe(true);
    expect(calls.map((call) => call.path)).toEqual(['/v1/balance']);
  });
});
