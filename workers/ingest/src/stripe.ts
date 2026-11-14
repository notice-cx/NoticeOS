// Subscription and product revenue from Stripe: each completed day's net
// charges less refunds, read from the connected account's balance
// transactions and written into the revenue ledger under the `stripe` source,
// one daily total per site. The day and the hour it is complete come from the
// source's vocabulary row (`noticeos_ref.revenue_sources`), never from here.
//
// Product mappings split the connected account's receipts by asset. The
// whole-account collector remains available for older configurations.

import { subscriptionSnapshot } from './stripe-subscriptions.js';
import { stripeSnapshotRecord, type SalesBreakdown } from '@noticeos/contract/stripe-report';
import type { Transaction } from '@noticeos/postgres';
import type { ScheduledRunResult } from '@noticeos/contract';
import { STRIPE_REVENUE_SOURCE } from '@noticeos/contract/revenue-sources';
import { readStripeProductMapping, STRIPE_ACCOUNT_ID, STRIPE_REVENUE_LANE, stripeProductId, stripeProductTargets, stripeRevenueAssignments, type StripeProductMapping } from '@noticeos/contract/configuration';
import { credentialConnected, recordCredentialOutcome, resolveCredential } from './credentials.js';
import { observeIntegration, tryHealthConnection } from './integration-health-context.js';
import { LANE_REGISTER, type LaneRegister } from './lane-mapping.js';

/** The credential field, and its legacy env binding name. */
export const STRIPE_KEY_FIELD = 'STRIPE_API_KEY';
/** The catalog lane a site names its Stripe account on. */
export const STRIPE_LANE = STRIPE_REVENUE_LANE;
/** The integration-health capability one site's daily collection is recorded under. */
export const STRIPE_REVENUE_CAPABILITY = 'stripe-revenue';

const API = 'https://api.stripe.com/v1';
const REQUEST_TIMEOUT_MS = 20_000;
/** Days a first run reads back, and the most any one run asks for. */
export const STRIPE_WINDOW_DAYS = 35;
/** Stripe's largest page. */
const PAGE_LIMIT = 100;
/** Pages one run may read; a window that needs more is not written at all. */
const MAX_PAGES = 100;
/** Balance transaction types that are a sale (positive) or a refund of one
 * (negative, as Stripe signs it), and the reversal of a refund that failed. */
const REVENUE_TYPES = new Set(['charge', 'payment', 'refund', 'payment_refund', 'refund_failure', 'payment_failure_refund']);

/** What one Stripe GET answered. Transport failures throw. */
type StripeAnswer =
  | { kind: 'ok'; body: unknown }
  | { kind: 'refused'; status: number }
  | { kind: 'rate-limited'; status: number }
  | { kind: 'failed'; status: number };

/** One GET with the key in the Authorization header, never in the URL, so no
 * error message or log line can carry it. */
async function stripeGet(apiKey: string, path: string, fetchImpl: typeof fetch, timeoutMs = REQUEST_TIMEOUT_MS, account?: string): Promise<StripeAnswer> {
  const response = await fetchImpl(`${API}${path}`, {
    headers: { authorization: `Bearer ${apiKey}`, 'Stripe-Version': '2026-10-28.endive', ...(account ? { 'Stripe-Account': account } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return { kind: 'refused', status: response.status };
  }
  if (response.status === 429) {
    await response.body?.cancel();
    return { kind: 'rate-limited', status: response.status };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { kind: 'failed', status: response.status };
  }
  return { kind: 'ok', body: await response.json().catch(() => null) };
}

/**
 * Whether Stripe accepts a key: one read of the account balance, which moves
 * no money and writes nothing. Never throws.
 */
export async function checkStripeKey(
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<'accepted' | 'refused' | 'rate-limited' | 'unreachable'> {
  try {
    const answer = await stripeGet(apiKey, '/balance', fetchImpl, timeoutMs);
    if (answer.kind === 'ok') return 'accepted';
    if (answer.kind === 'refused') return 'refused';
    return answer.kind === 'rate-limited' ? 'rate-limited' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** The currencies a balance holds money in, upper case. */
function balanceCurrencies(body: unknown): Set<string> {
  const currencies = new Set<string>();
  if (body === null || typeof body !== 'object') return currencies;
  for (const side of ['available', 'pending'] as const) {
    const list = (body as Record<string, unknown>)[side];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const currency = (entry as { currency?: unknown } | null)?.currency;
      if (typeof currency === 'string' && /^[a-z]{3}$/i.test(currency)) currencies.add(currency.toUpperCase());
    }
  }
  return currencies;
}

export interface BalanceTransaction { id: string; amount: number; fee: number; net: number; currency: string; created: number; type: string; source?: unknown }

function balanceTransaction(value: unknown): BalanceTransaction | null {
  if (value === null || typeof value !== 'object') return null;
  const { id, amount, fee, net, currency, created, type, source } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id === '' || typeof currency !== 'string' || !/^[a-z]{3}$/i.test(currency) || typeof type !== 'string') return null;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || typeof fee !== 'number' || !Number.isSafeInteger(fee) || amount - fee !== net) return null;
  if (typeof net !== 'number' || !Number.isSafeInteger(net) || typeof created !== 'number' || !Number.isFinite(created)) return null;
  return { id, amount, fee, net, currency: currency.toUpperCase(), created, type, source };
}

// --- days on the source's clock ---------------------------------------------

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function dayRange(start: string, end: string): string[] {
  const days: string[] = [];
  for (let day = start; day <= end; day = shiftDay(day, 1)) days.push(day);
  return days;
}

/** The calendar day and minute after midnight of `instantMs` in `timeZone`. */
function clockAt(instantMs: number, timeZone: string): { date: string; minute: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

type SourceClock = { timeZone: string; readyAfterMinute: number };

/** The newest day complete at `nowMs` on the source's clock. */
export function lastCompleteDay(nowMs: number, clock: SourceClock): string {
  const here = clockAt(nowMs, clock.timeZone);
  return shiftDay(here.date, here.minute >= clock.readyAfterMinute ? -1 : -2);
}

/** Days to ask for: after the newest day held, else a first run's window,
 * never more than one window back from `end`. Null when nothing is due. */
export function stripeWindow(end: string, lastHeld: string | null): { start: string; end: string } | null {
  const earliest = shiftDay(end, -(STRIPE_WINDOW_DAYS - 1));
  const after = lastHeld === null ? earliest : shiftDay(lastHeld, 1);
  const start = after < earliest ? earliest : after;
  return start > end ? null : { start, end };
}

// --- the job ----------------------------------------------------------------

export interface StripeOutcome {
  asset: string;
  account: string;
  /** `collected`: every day of the window written or already held;
   * `failed`: nothing written. */
  status: 'collected' | 'failed';
  /** Days in the window. */
  days: number;
  /** Days whose figure was new or changed. */
  written: number;
  errorCode: string | null;
  subscriptionStatus?: 'collected' | 'failed';
  subscriptionErrorCode?: string | null;
}

export interface StripeRunResult extends ScheduledRunResult {
  /** False when no key is connected: the run asked nothing and wrote nothing. */
  connected: boolean;
  outcomes: StripeOutcome[];
  unattributedTransactions?: number;
  monitoringAvailable?: false;
}

export interface StripeOptions {
  nowMs?: number;
  fetchImpl?: typeof fetch;
  /** `config/integrations.json` as this fire read it; the compiled copy when absent. */
  laneRegister?: LaneRegister;
}

/** One site and the Stripe account its income is read from. */
export interface StripeTarget { asset: string; account: string }
type Target = StripeTarget;

/** Every site whose Subscriptions entry names a Stripe account and is not
 * declined there. */
export function stripeTargets(register: LaneRegister = LANE_REGISTER): Target[] {
  return stripeRevenueAssignments(register).sort((a, b) => a.asset.localeCompare(b.asset));
}

class StripeFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'StripeFailure'; }
}

function failureFrom(answer: Exclude<StripeAnswer, { kind: 'ok' }>): StripeFailure {
  if (answer.kind === 'rate-limited') return new StripeFailure('stripe_rate_limit', 'Stripe asked NoticeOS to slow down.');
  if (answer.kind === 'refused') return new StripeFailure(`stripe_http_${answer.status}`, `Stripe refused the key (HTTP ${answer.status}).`);
  return new StripeFailure(`stripe_http_${answer.status}`, `Stripe answered HTTP ${answer.status}.`);
}

function stripeRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stripeId(value: unknown, prefix: string): string | null {
  const id = typeof value === 'string' ? value : stripeRecord(value)?.id;
  return typeof id === 'string' && id.startsWith(prefix) && /^[a-zA-Z0-9_]+$/.test(id) ? id : null;
}

async function getStripeBody(apiKey: string, path: string, fetchImpl: typeof fetch): Promise<unknown> {
  const answer = await stripeGet(apiKey, path, fetchImpl);
  if (answer.kind !== 'ok') throw failureFrom(answer);
  return answer.body;
}

async function stripeAccount(apiKey: string, fetchImpl: typeof fetch) {
  const account = stripeRecord(await getStripeBody(apiKey, '/account', fetchImpl));
  const id = account?.id;
  if (typeof id !== 'string' || !STRIPE_ACCOUNT_ID.test(id)) {
    throw new StripeFailure('stripe_invalid_response', 'Stripe sent an unreadable account ID.');
  }
  const currency = account?.default_currency;
  return { id, currency: typeof currency === 'string' && /^[a-z]{3}$/i.test(currency) ? currency.toUpperCase() : null };
}

async function liveStripeBalance(apiKey: string, fetchImpl: typeof fetch): Promise<unknown> {
  const balance = await getStripeBody(apiKey, '/balance', fetchImpl);
  if (stripeRecord(balance)?.livemode !== true) {
    throw new StripeFailure('stripe_live_key_required', 'Use a live Stripe key to collect revenue.');
  }
  return balance;
}

/** A complete list, or an error before any of its rows are used. */
async function readStripeList(apiKey: string, path: string, params: Record<string, string>, fetchImpl: typeof fetch, account?: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const query = new URLSearchParams({ ...params, limit: String(PAGE_LIMIT) });
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await stripeGet(apiKey, `${path}?${query}`, fetchImpl, REQUEST_TIMEOUT_MS, account);
    if (answer.kind !== 'ok') throw failureFrom(answer);
    const body = stripeRecord(answer.body);
    if (!body || !Array.isArray(body.data) || typeof body.has_more !== 'boolean' || (body.has_more && body.data.length === 0)) {
      throw new StripeFailure('stripe_invalid_response', 'Stripe sent a list NoticeOS could not read.');
    }
    for (const value of body.data) {
      const row = stripeRecord(value);
      const id = row?.id;
      if (!row || typeof id !== 'string' || id === '' || seen.has(id)) {
        throw new StripeFailure('stripe_invalid_response', 'Stripe repeated or omitted a list item ID.');
      }
      seen.add(id);
      rows.push(row);
      query.set('starting_after', id);
    }
    if (!body.has_more) return rows;
  }
  throw new StripeFailure('stripe_incomplete_window', 'Stripe returned more pages than one run can read.');
}

/** Every balance transaction created in [gte, lt), seconds since the epoch. */
async function readTransactions(apiKey: string, gte: number, lt: number, fetchImpl: typeof fetch, account?: string): Promise<BalanceTransaction[]> {
  const rows = await readStripeList(apiKey, '/balance_transactions', {
    'created[gte]': String(gte), 'created[lt]': String(lt),
  }, fetchImpl, account);
  return rows.map((value) => {
    const row = balanceTransaction(value);
    if (!row) throw new StripeFailure('stripe_invalid_response', 'Stripe sent a transaction NoticeOS could not read.');
    return row;
  });
}

export async function discoverStripeProducts(apiKey: string, fetchImpl: typeof fetch) {
  try {
    await liveStripeBalance(apiKey, fetchImpl);
    const account = await stripeAccount(apiKey, fetchImpl);
    const products = await readStripeList(apiKey, '/products', {}, fetchImpl);
    const sites = products.map(({ id, name, active }) => {
      if (!stripeProductId(id) || typeof name !== 'string' || typeof active !== 'boolean') {
        throw new StripeFailure('stripe_invalid_response', 'Stripe sent a product NoticeOS could not read.');
      }
      return { lane: STRIPE_LANE, ref: id, label: name, host: null, mapping: {}, ready: active };
    });
    return { ok: true, kind: 'account', stripeAccountId: account.id, sites } as const;
  } catch (error) {
    return { ok: false, reason: error instanceof StripeFailure && error.code === 'stripe_live_key_required' ? 'test-mode'
      : stripeRefused(error) ? 'refused' : 'unreachable' } as const;
  }
}

function stripeRefused(error: unknown): error is StripeFailure {
  return error instanceof StripeFailure && (error.code === 'stripe_http_401' || error.code === 'stripe_http_403');
}

/** Each day's net revenue in `currency`, minor units, every day of the window
 * present (a day with no sale is 0). */
export function dailyNet(rows: readonly BalanceTransaction[], window: { start: string; end: string }, currency: string, timeZone: string): Map<string, number> {
  const days = new Map(dayRange(window.start, window.end).map((day) => [day, 0]));
  for (const row of rows) {
    if (!REVENUE_TYPES.has(row.type) || row.currency !== currency) continue;
    const day = clockAt(row.created * 1000, timeZone).date;
    if (days.has(day)) days.set(day, days.get(day)! + row.net);
  }
  return days;
}

/** Daily sale composition reconciled to the same transactions as net receipts. */
export function dailySales(rows: readonly BalanceTransaction[], window: { start: string; end: string }, currency: string, timeZone: string): Map<string, SalesBreakdown> {
  const days = new Map(dayRange(window.start, window.end).map((day) => [day, { salesMinor: 0, refundsMinor: 0, feesMinor: 0, payments: 0, refunds: 0 }]));
  for (const row of rows) {
    if (!REVENUE_TYPES.has(row.type) || row.currency !== currency) continue;
    const day = days.get(clockAt(row.created * 1000, timeZone).date);
    if (!day) continue;
    if (row.type === 'charge' || row.type === 'payment') { day.salesMinor += row.amount; day.payments++; }
    else { day.refundsMinor -= row.amount; if (row.amount < 0) day.refunds++; }
    day.feesMinor += row.fee;
  }
  return days;
}

async function readSubscriptions(apiKey: string, fetchImpl: typeof fetch, account: string): Promise<unknown[]> {
  return readStripeList(apiKey, '/subscriptions', { status: 'all' }, fetchImpl, account);
}

function isSale(row: BalanceTransaction): boolean {
  return row.type === 'charge' || row.type === 'payment';
}

async function chargeFor(apiKey: string, row: BalanceTransaction, fetchImpl: typeof fetch) {
  const source = stripeRecord(row.source);
  const refundId = stripeId(row.source, 're_') ?? stripeId(row.source, 'pyr_');
  const refund = !isSale(row) && refundId
    ? source ?? stripeRecord(await getStripeBody(apiKey, `/refunds/${refundId}`, fetchImpl))
    : null;
  const charge = refund ? refund.charge : row.source;
  const id = stripeId(charge, 'ch_') ?? stripeId(charge, 'py_');
  if (!id) return null;
  return stripeRecord(charge) ?? stripeRecord(await getStripeBody(apiKey, `/charges/${id}`, fetchImpl));
}

function mappedAsset(products: StripeProductMapping['products'], ids: unknown[]): string | null {
  const first = ids[0];
  const asset = stripeProductId(first) && Object.hasOwn(products, first) ? products[first] : null;
  return asset && ids.every((id) => stripeProductId(id) && Object.hasOwn(products, id) && products[id] === asset) ? asset : null;
}

async function paymentAsset(apiKey: string, intent: string, products: StripeProductMapping['products'], fetchImpl: typeof fetch): Promise<string | null> {
  const sessions = await readStripeList(apiKey, '/checkout/sessions', { payment_intent: intent }, fetchImpl);
  if (sessions.length > 0) {
    if (sessions.length !== 1) return null;
    const id = stripeId(sessions[0], 'cs_');
    if (!id) throw new StripeFailure('stripe_invalid_response', 'Stripe sent an unreadable Checkout Session ID.');
    const lines = await readStripeList(apiKey, `/checkout/sessions/${id}/line_items`, {}, fetchImpl);
    return mappedAsset(products, lines.filter((line) => line.amount_total !== 0).map((line) => stripeRecord(line.price)?.product));
  }

  const payments = await readStripeList(apiKey, '/invoice_payments', {
    'payment[type]': 'payment_intent', 'payment[payment_intent]': intent, status: 'paid',
  }, fetchImpl);
  const invoices = [...new Set(payments.map((payment) => stripeId(payment.invoice, 'in_')))];
  if (invoices.length !== 1 || !invoices[0]) return null;
  const lines = await readStripeList(apiKey, `/invoices/${invoices[0]}/lines`, {}, fetchImpl);
  return mappedAsset(products, lines.filter((line) => line.amount !== 0)
    .map((line) => stripeRecord(stripeRecord(line.pricing)?.price_details)?.product));
}

function transactionBounds(window: { start: string; end: string }) {
  return {
    gte: Date.parse(`${window.start}T00:00:00Z`) / 1000 - 86_400,
    lt: Date.parse(`${shiftDay(window.end, 1)}T00:00:00Z`) / 1000 + 86_400,
  };
}

type ProductReceipt = {
  row: BalanceTransaction;
  day: string;
  asset: string | null;
  original: { id: string; day: string; currency: string } | null;
};

type ProductObservation = {
  asset: string;
  day: string;
  item: string;
  currency: string;
  net: number;
  sales: number;
  refunds: number;
  fees: number;
  payments: number;
  refundCount: number;
};

const STRIPE_PRODUCT_DAY = 'products:daily';

async function stripeLedgerLock(tx: Transaction, account: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`noticeos.stripe-revenue:${tx.workspaceId}:${account}`]);
}

async function latestStripeDay(tx: Transaction, account: string): Promise<string | null> {
  const [held] = await tx.query<{ day: string | null }>(
    `SELECT MAX(revenue_date)::text AS day FROM noticeos.current_revenue
      WHERE source = $1 AND account_ref = $2`, [STRIPE_REVENUE_SOURCE, account]);
  return held?.day ?? null;
}

async function resolveProductReceipts(
  apiKey: string, window: { start: string; end: string }, clock: SourceClock, products: StripeProductMapping['products'], fetchImpl: typeof fetch,
): Promise<ProductReceipt[]> {
  const { gte, lt } = transactionBounds(window);
  const rows = await readTransactions(apiKey, gte, lt, fetchImpl);
  const receipts: ProductReceipt[] = [];
  const payments = new Map<string, string | null>();
  const hasMappings = Object.keys(products).length > 0;
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (!REVENUE_TYPES.has(row.type)) continue;
    const day = clockAt(row.created * 1000, clock.timeZone).date;
    if (day < window.start || day > window.end) continue;
    if (!stripeId(row.id, 'txn_')) throw new StripeFailure('stripe_invalid_response', 'Stripe sent an unreadable balance transaction ID.');
    if (isSale(row) && !hasMappings) continue;
    const charge = await chargeFor(apiKey, row, fetchImpl);
    if (isSale(row)) {
      const intent = stripeId(charge?.payment_intent, 'pi_');
      if (intent && !payments.has(intent)) payments.set(intent, await paymentAsset(apiKey, intent, products, fetchImpl));
      receipts.push({ row, day, asset: intent ? payments.get(intent) ?? null : null, original: null });
    } else {
      const id = stripeId(charge?.balance_transaction, 'txn_');
      let original = null;
      if (id) {
        const payment = byId.get(id) ?? balanceTransaction(await getStripeBody(apiKey, `/balance_transactions/${id}`, fetchImpl));
        if (!payment || payment.id !== id || !isSale(payment)) {
          throw new StripeFailure('stripe_invalid_response', 'Stripe did not identify the original balance transaction for a refund.');
        }
        original = { id, day: clockAt(payment.created * 1000, clock.timeZone).date, currency: payment.currency };
      }
      receipts.push({ row, day, asset: null, original });
    }
  }
  return receipts;
}

async function writeProductReceipts(
  env: IngestEnv, mapping: StripeProductMapping, targets: Target[], refundAnchor: string | null, receipts: ProductReceipt[],
  window: { start: string; end: string }, defaultCurrency: string, runId: string, at: string,
) {
  return env.STORE.write(async (tx) => {
    await stripeLedgerLock(tx, mapping.accountId);
    // A competing collection can finish while Stripe is being read.
    const held = await latestStripeDay(tx, mapping.accountId);
    const days = dayRange(window.start, window.end).filter((day) => !held || day > held);
    if (days.length === 0) return null;

    const due = new Set(days);
    const assetIds = new Set(targets.map(({ asset }) => asset));
    const originalIds = receipts.flatMap(({ original }) => original ? [original.id] : []);
    const originalSales = await tx.query<{ item: string; asset: string }>(
      `SELECT item_ref AS item, asset_id AS asset FROM noticeos.current_revenue
        WHERE source = $1 AND account_ref = $2 AND item_ref = ANY($3::text[]) AND payment_count > 0`,
      [STRIPE_REVENUE_SOURCE, mapping.accountId, originalIds]);
    const assetsBySale = new Map(originalSales.map(({ item, asset }) => [item, asset]));
    for (const { row, day, asset } of receipts) {
      if (due.has(day) && asset && assetIds.has(asset) && isSale(row)) assetsBySale.set(row.id, asset);
    }

    // A legacy observation covered the entire day. Match refunds to a recorded
    // sale day in the same account and currency when there is no item history.
    const legacyDays = [...new Set(receipts.flatMap(({ original }) => original && !assetsBySale.has(original.id) ? [original.day] : []))];
    const legacySales = await tx.query<{ day: string; currency: string; asset: string }>(
      `SELECT revenue_date::text AS day, currency, MIN(asset_id) AS asset
         FROM noticeos.current_revenue
        WHERE source = $1 AND account_ref = $2 AND item_ref IS NULL AND payment_count > 0
          AND revenue_date = ANY($3::date[])
        GROUP BY revenue_date, currency HAVING COUNT(*) = 1`,
      [STRIPE_REVENUE_SOURCE, mapping.accountId, legacyDays]);
    const assetsByLegacyDay = new Map(legacySales.map(({ day, currency, asset }) => [`${day}/${currency}`, asset]));
    const observations: ProductObservation[] = [];
    let unattributedTransactions = 0;
    for (const { row, day, asset, original } of receipts) {
      if (!due.has(day)) continue;
      const sale = isSale(row);
      const earnedBy = sale ? (asset && assetIds.has(asset) ? asset : null)
        : original && (assetsBySale.get(original.id) ?? assetsByLegacyDay.get(`${original.day}/${original.currency}`));
      if (!earnedBy) {
        unattributedTransactions++;
        continue;
      }
      observations.push({
        asset: earnedBy, day, item: row.id, currency: row.currency, net: row.net,
        sales: sale ? row.amount : 0, refunds: sale ? 0 : -row.amount, fees: row.fee,
        payments: sale ? 1 : 0, refundCount: !sale && row.amount < 0 ? 1 : 0,
      });
    }

    const knownCurrencies = await tx.query<{ asset: string; currency: string }>(
      `SELECT DISTINCT asset_id AS asset, currency FROM noticeos.current_revenue
        WHERE source = $1 AND account_ref = $2 AND asset_id = ANY($3::text[])`,
      [STRIPE_REVENUE_SOURCE, mapping.accountId, [...assetIds]]);
    const currencies = new Map(targets.map(({ asset }) => [asset, new Set<string>()]));
    if (refundAnchor) currencies.set(refundAnchor, new Set());
    for (const { asset, currency } of [...knownCurrencies, ...observations]) currencies.get(asset)?.add(currency);
    for (const [asset, collected] of currencies) {
      if (collected.size === 0) collected.add(defaultCurrency);
      for (const currency of collected) {
        for (const day of days) observations.push({
          asset, day, item: `${STRIPE_PRODUCT_DAY}:${currency}`, currency, net: 0,
          sales: 0, refunds: 0, fees: 0, payments: 0, refundCount: 0,
        });
      }
    }
    await tx.execute(
      `INSERT INTO noticeos.revenue_observations (workspace_id, asset_id, source, account_ref, revenue_date, item_ref,
                                                 amount_minor, currency, run_ref, recorded_at, sales_minor, refunds_minor,
                                                 fees_minor, payment_count, refund_count)
       SELECT $1::uuid, asset, $2, $3, day, item, net, currency, $4, $5::timestamptz,
              sales, refunds, fees, payments, "refundCount"
         FROM jsonb_to_recordset($6::jsonb) AS x(asset text, day date, item text, net bigint, currency char(3),
                sales bigint, refunds bigint, fees bigint, payments int, "refundCount" int)`,
      [tx.workspaceId, STRIPE_REVENUE_SOURCE, mapping.accountId, runId, at, JSON.stringify(observations)]);
    return { days: days.length, unattributedTransactions };
  });
}

async function runStripeProducts(
  env: IngestEnv, mapping: StripeProductMapping, apiKey: string | undefined,
  resolved: Awaited<ReturnType<typeof resolveCredential>>, clock: SourceClock, end: string, at: string, fetchImpl: typeof fetch,
): Promise<StripeRunResult> {
  const skipped = (detail: string): StripeRunResult => ({ outcome: 'skipped', detail, connected: true, outcomes: [] });
  const eligible = await env.STORE.read((tx) => tx.query<{ asset: string }>(
    `SELECT asset_id AS asset FROM noticeos.assets WHERE status <> 'retired' AND is_os = false`));
  const ids = new Set(eligible.map(({ asset }) => asset));
  const targets = stripeProductTargets(mapping).filter(({ asset }) => ids.has(asset));
  // With every mapping cleared, still reconcile refunds for sales already
  // recorded. One previously credited asset anchors the completed days.
  const refundAnchor = targets.length > 0 ? null : await env.STORE.read(async (tx) => {
    const [row] = await tx.query<{ asset: string }>(
      `SELECT asset_id AS asset FROM noticeos.current_revenue
        WHERE source = $1 AND account_ref = $2 AND payment_count > 0
        ORDER BY revenue_date DESC, observation_id DESC LIMIT 1`,
      [STRIPE_REVENUE_SOURCE, mapping.accountId]);
    return row?.asset ?? null;
  });
  if (targets.length === 0 && refundAnchor === null) return skipped('No Stripe products or collected sales.');

  const held = await env.STORE.read((tx) => latestStripeDay(tx, mapping.accountId));
  const window = stripeWindow(end, held);
  if (!window) return skipped('No Stripe day is due.');

  const health = await tryHealthConnection(env, 'stripe', resolved);
  const runId = crypto.randomUUID();
  let monitoringAvailable = health !== null;
  let failure: StripeFailure | null = null;
  let written = 0;
  let unattributedTransactions = 0;
  let keyAnswered = false;
  try {
    if (!apiKey) throw new StripeFailure('credential_unavailable', 'The saved Stripe key could not be read.');
    const account = await stripeAccount(apiKey, fetchImpl);
    keyAnswered = true;
    if (account.id !== mapping.accountId) {
      throw new StripeFailure('stripe_account_changed', 'The key belongs to a different Stripe account. Update product mappings in Integrations.');
    }
    const currencies = balanceCurrencies(await liveStripeBalance(apiKey, fetchImpl));
    const currency = account.currency ?? [...currencies].sort()[0];
    if (!currency) throw new StripeFailure('stripe_currency_config', 'Stripe sent no settlement currency.');

    const products = Object.fromEntries(Object.entries(mapping.products).filter(([, asset]) => ids.has(asset)));
    const receipts = await resolveProductReceipts(apiKey, window, clock, products, fetchImpl);
    const saved = await writeProductReceipts(env, mapping, targets, refundAnchor, receipts, window, currency, runId, at);
    if (!saved) return skipped('No Stripe day is due.');
    written = saved.days;
    unattributedTransactions = saved.unattributedTransactions;
  } catch (error) {
    failure = error instanceof StripeFailure ? error : new StripeFailure('request_failed', 'Stripe revenue could not be collected.');
  }

  if (resolved.source === 'store' && (stripeRefused(failure) || keyAnswered)) {
    await recordCredentialOutcome(env, 'stripe', stripeRefused(failure)
      ? { ok: false, error: failure.message, at } : { ok: true, at });
  }
  const outcomes: StripeOutcome[] = [];
  for (const { asset, account } of targets) {
    if (!(await observeIntegration(env, health, {
      capability: STRIPE_REVENUE_CAPABILITY, asset, target: account, observedAt: at, attemptId: runId,
      ok: failure === null, ...(failure ? { code: failure.code } : {}),
    }))) monitoringAvailable = false;
    outcomes.push({ asset, account, status: failure ? 'failed' : 'collected',
      days: dayRange(window.start, window.end).length, written, errorCode: failure?.code ?? null });
  }

  return {
    outcome: failure ? 'failed' : 'ran',
    detail: failure?.message ?? (unattributedTransactions > 0
      ? `Stripe revenue collected. ${unattributedTransactions} transactions could not be assigned.`
      : 'Stripe revenue collected.'),
    connected: true,
    outcomes,
    unattributedTransactions,
    ...(monitoringAvailable ? {} : { monitoringAvailable: false as const }),
  };
}

/** Write each day whose current figure differs, one statement a day, in one
 * transaction, under the `stripe` source. Returns how many days were written. */
export async function persistStripeDays(env: Pick<IngestEnv, 'STORE'>, target: Target, days: Map<string, number>, currency: string, runId: string, at: string, breakdowns?: Map<string, SalesBreakdown>): Promise<number> {
  return env.STORE.write(async (tx) => {
    await stripeLedgerLock(tx, target.account);
    const [products] = await tx.query<{ day: string | null }>(
      `SELECT MAX(revenue_date)::text AS day FROM noticeos.current_revenue
        WHERE source = $1 AND account_ref = $2 AND item_ref LIKE $3`,
      [STRIPE_REVENUE_SOURCE, target.account, `${STRIPE_PRODUCT_DAY}:%`]);
    let written = 0;
    for (const [day, amountMinor] of days) {
      if (products?.day && day <= products.day) continue;
      const breakdown = breakdowns?.get(day);
      const rows = await tx.query<{ observation_id: string }>(
        `INSERT INTO noticeos.revenue_observations (workspace_id, asset_id, source, account_ref, revenue_date, amount_minor,
                                                    currency, run_ref, recorded_at, sales_minor, refunds_minor, fees_minor, payment_count, refund_count)
         SELECT $1::uuid, $2::text, $3::text, $4::text, $5::date, $6::bigint, $7::char(3), $8::text, $9::timestamptz, $10::bigint, $11::bigint, $12::bigint, $13::int, $14::int
          WHERE NOT EXISTS (SELECT 1 FROM noticeos.current_revenue
                             WHERE asset_id = $2::text AND source = $3::text AND account_ref = $4::text
                               AND revenue_date = $5::date AND item_ref IS NULL
                               AND amount_minor = $6::bigint AND currency = $7::char(3)
                               AND sales_minor IS NOT DISTINCT FROM $10::bigint AND refunds_minor IS NOT DISTINCT FROM $11::bigint
                               AND fees_minor IS NOT DISTINCT FROM $12::bigint AND payment_count IS NOT DISTINCT FROM $13::int
                               AND refund_count IS NOT DISTINCT FROM $14::int)
         RETURNING observation_id`,
        [tx.workspaceId, target.asset, STRIPE_REVENUE_SOURCE, target.account, day, amountMinor, currency, runId, at, breakdown?.salesMinor ?? null, breakdown?.refundsMinor ?? null, breakdown?.feesMinor ?? null, breakdown?.payments ?? null, breakdown?.refunds ?? null]);
      written += rows.length;
    }
    return written;
  });
}

/**
 * Collect every completed day each mapped site is missing. No key connected
 * is no work, not a failure; a refused key stops the run, since every site
 * shares it. The answer is the scheduled job's, recorded with its run.
 */
export async function runStripeRevenue(env: IngestEnv, options: StripeOptions = {}): Promise<StripeRunResult> {
  const nowMs = options.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolved = await resolveCredential(env, 'stripe');
  const apiKey = resolved.fields[STRIPE_KEY_FIELD];
  if (!apiKey && !(await credentialConnected(env, 'stripe', resolved))) {
    console.log(JSON.stringify({ event: 'stripe_not_connected' }));
    return { outcome: 'skipped', detail: 'Stripe is not connected.', connected: false, outcomes: [] };
  }
  const register = options.laneRegister ?? LANE_REGISTER;
  const mapping = readStripeProductMapping(register.stripeProducts);
  if (register.stripeProducts != null && !mapping) {
    return { outcome: 'failed', detail: 'Stripe product mappings could not be read.', connected: true, outcomes: [] };
  }
  const targets = mapping ? stripeProductTargets(mapping) : stripeTargets(register);
  if (resolved.source === 'demo' || (!mapping && targets.length === 0)) {
    return { outcome: 'skipped', detail: 'No assets are assigned to Stripe.', connected: true, outcomes: [] };
  }
  const [clock] = await env.STORE.read((tx) => tx.query<SourceClock>(
    `SELECT time_zone AS "timeZone", ready_after_minute AS "readyAfterMinute"
       FROM noticeos_ref.revenue_sources WHERE source = $1`, [STRIPE_REVENUE_SOURCE]));
  if (!clock) throw new Error(`The store names no revenue source ${STRIPE_REVENUE_SOURCE}; apply its migration.`);
  const end = lastCompleteDay(nowMs, { timeZone: clock.timeZone, readyAfterMinute: Number(clock.readyAfterMinute) });

  if (mapping) return runStripeProducts(env, mapping, apiKey, resolved, clock, end, at, fetchImpl);

  const health = await tryHealthConnection(env, 'stripe', resolved);
  let monitoringAvailable = health !== null;
  const outcomes: StripeOutcome[] = [];
  const observe = async (target: Target, ok: boolean, attemptId: string, code?: string) => {
    const recorded = await observeIntegration(env, health, {
      capability: STRIPE_REVENUE_CAPABILITY, asset: target.asset, target: target.account, observedAt: at, attemptId, ok, code,
    });
    if (!recorded) monitoringAvailable = false;
  };
  const fail = async (target: Target, failure: StripeFailure, days = 0) => {
    outcomes.push({ asset: target.asset, account: target.account, status: 'failed', days, written: 0, errorCode: failure.code });
    await observe(target, false, crypto.randomUUID(), failure.code);
  };

  let refused: StripeFailure | null = null;
  let keyAnswered = false;
  if (targets.length > 1) {
    // One key reads one account: two sites naming it would each be credited
    // with the other's sales.
    for (const target of targets) await fail(target, new StripeFailure('stripe_mapping_shared', 'More than one asset names a Stripe account; one key reads one account.'));
  } else {
    const target = targets[0]!;
    // Receipts already filed under this account stay with their original asset.
    // Changing the assignment must not collect those days a second time.
    const [held] = await env.STORE.read((tx) => tx.query<{ day: string | null }>(
      `SELECT MAX(revenue_date)::text AS day FROM noticeos.current_revenue
        WHERE source = $1 AND account_ref = $2
          AND (asset_id <> $3 OR sales_minor IS NOT NULL)`, [STRIPE_REVENUE_SOURCE, target.account, target.asset]));
    const window = stripeWindow(end, held?.day ?? null);
    const [lastSnapshot] = await env.STORE.read((tx) => tx.query<{ at: string | null }>(
      `SELECT MAX(observed_at AT TIME ZONE 'UTC')::date::text AS at FROM noticeos.stripe_subscription_snapshots WHERE asset_id = $1 AND account_ref = $2`, [target.asset, target.account]));
    const subscriptionsDue = !lastSnapshot?.at || lastSnapshot.at.slice(0, 10) < at.slice(0, 10);
    if (window === null && !subscriptionsDue) return { outcome: 'skipped', detail: 'No Stripe day is due.', connected: true, outcomes: [] };
    const days = window ? dayRange(window.start, window.end).length : 0;
    try {
      // Connected, but the stored key could not be opened.
      if (!apiKey) throw new StripeFailure('credential_unavailable', 'The saved Stripe key could not be read.');
      const balance = await stripeGet(apiKey, '/balance', fetchImpl, REQUEST_TIMEOUT_MS, target.account);
      if (balance.kind !== 'ok') throw failureFrom(balance);
      keyAnswered = true;
      const currencies = [...balanceCurrencies(balance.body)];
      if (currencies.length !== 1) {
        throw new StripeFailure('stripe_currency_config', 'This Stripe account does not hold exactly one currency; NoticeOS records one.');
      }
      const currency = currencies[0]!;
      let written = 0;
      const runId = crypto.randomUUID();
      if (window) {
        const { gte, lt } = transactionBounds(window);
        const rows = await readTransactions(apiKey, gte, lt, fetchImpl, target.account);
        written = await persistStripeDays(env, target, dailyNet(rows, window, currency, clock.timeZone), currency, runId, at, dailySales(rows, window, currency, clock.timeZone));
        await observe(target, true, runId);
      }
      const outcome: StripeOutcome = { asset: target.asset, account: target.account, status: 'collected', days, written, errorCode: null };
      outcomes.push(outcome);
      if (subscriptionsDue) {
        let errorCode: string | undefined;
        try {
          const rows = await readSubscriptions(apiKey, fetchImpl, target.account);
          let snapshot: ReturnType<typeof subscriptionSnapshot>;
          try { snapshot = subscriptionSnapshot(rows, currency); }
          catch { throw new StripeFailure('stripe_invalid_response', 'Stripe sent an unreadable subscription.'); }
          await env.STORE.write((tx) => tx.execute(
            `INSERT INTO noticeos.stripe_subscription_snapshots (workspace_id, asset_id, account_ref, observed_at, snapshot)
             VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::jsonb)`,
            [tx.workspaceId, target.asset, target.account, at, JSON.stringify(stripeSnapshotRecord(snapshot, at))]));
          outcome.subscriptionStatus = 'collected';
        } catch (error) {
          const failure = error instanceof StripeFailure ? error : new StripeFailure('request_failed', 'The Stripe subscription report could not be collected.');
          errorCode = failure.code;
          outcome.subscriptionStatus = 'failed'; outcome.subscriptionErrorCode = errorCode;
        }
        if (!(await observeIntegration(env, health, { capability: 'stripe-subscriptions', asset: target.asset, target: target.account,
          observedAt: at, attemptId: crypto.randomUUID(), ok: errorCode === undefined, ...(errorCode ? { code: errorCode } : {}) }))) monitoringAvailable = false;
      }
    } catch (error) {
      const failure = error instanceof StripeFailure ? error : new StripeFailure('request_failed', 'Stripe could not be reached.');
      if (failure.code === 'stripe_http_401' || failure.code === 'stripe_http_403') refused = failure;
      else if (failure.code.startsWith('stripe_')) keyAnswered = true;
      await fail(target, failure, days);
    }
  }

  // The key's own verdict: refused, or answered at least once.
  if (resolved.source === 'store' && (refused !== null || keyAnswered)) {
    await recordCredentialOutcome(env, 'stripe', refused !== null ? { ok: false, error: refused.message, at } : { ok: true, at });
  }
  const collected = outcomes.filter((outcome) => outcome.status === 'collected' && outcome.subscriptionStatus !== 'failed').length;
  const failed = outcomes.length - collected;
  console.log(JSON.stringify({
    event: 'stripe_complete',
    attempted: outcomes.length,
    collected,
    failed,
    errors: outcomes.filter((outcome) => outcome.status === 'failed' || outcome.subscriptionStatus === 'failed').map(({ asset, errorCode, subscriptionErrorCode }) => ({ asset, errorCode: subscriptionErrorCode ?? errorCode })),
  }));
  return {
    outcome: failed > 0 ? 'failed' : 'ran',
    detail: failed > 0 ? `${failed} Stripe collections failed; ${collected} completed.` : `${collected} Stripe collections completed.`,
    connected: true,
    outcomes,
    ...(monitoringAvailable ? {} : { monitoringAvailable: false as const }),
  };
}
