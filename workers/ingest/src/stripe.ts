// Subscription and product revenue from Stripe: each completed day's net
// charges less refunds, read from the connected account's balance
// transactions and written into the revenue ledger under the `stripe` source,
// one daily total per site. The day and the hour it is complete come from the
// source's vocabulary row (`noticeos_ref.revenue_sources`), never from here.
//
// One key reads one account, so one site names it: its Subscriptions entry's
// `stripeAccountId`. A day already held is asked for again only when a later
// day is missing, and a figure equal to the one held writes nothing.

import { subscriptionSnapshot } from './stripe-subscriptions.js';
import { stripeSnapshotRecord, type SalesBreakdown } from '@noticeos/contract/stripe-report';
import type { ScheduledRunResult } from '@noticeos/contract';
import { STRIPE_REVENUE_SOURCE } from '@noticeos/contract/revenue-sources';
import { STRIPE_REVENUE_LANE, stripeRevenueAssignments } from '@noticeos/contract/configuration';
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

export interface BalanceTransaction { id: string; amount: number; fee: number; net: number; currency: string; created: number; type: string }

function balanceTransaction(value: unknown): BalanceTransaction | null {
  if (value === null || typeof value !== 'object') return null;
  const { id, amount, fee, net, currency, created, type } = value as Record<string, unknown>;
  if (typeof id !== 'string' || id === '' || typeof currency !== 'string' || !/^[a-z]{3}$/i.test(currency) || typeof type !== 'string') return null;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || typeof fee !== 'number' || !Number.isSafeInteger(fee) || amount - fee !== net) return null;
  if (typeof net !== 'number' || !Number.isSafeInteger(net) || typeof created !== 'number' || !Number.isFinite(created)) return null;
  return { id, amount, fee, net, currency: currency.toUpperCase(), created, type };
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

/** Every balance transaction created in [gte, lt), seconds since the epoch. */
async function readTransactions(apiKey: string, gte: number, lt: number, fetchImpl: typeof fetch, account: string): Promise<BalanceTransaction[]> {
  const out: BalanceTransaction[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT), 'created[gte]': String(gte), 'created[lt]': String(lt) });
    if (after !== null) query.set('starting_after', after);
    const answer = await stripeGet(apiKey, `/balance_transactions?${query}`, fetchImpl, REQUEST_TIMEOUT_MS, account);
    if (answer.kind !== 'ok') throw failureFrom(answer);
    const body = answer.body as { data?: unknown; has_more?: unknown } | null;
    if (!body || !Array.isArray(body.data) || typeof body.has_more !== 'boolean') {
      throw new StripeFailure('stripe_invalid_response', 'Stripe sent a list NoticeOS could not read.');
    }
    const rows = body.data.map(balanceTransaction);
    if (rows.some((row) => row === null)) throw new StripeFailure('stripe_invalid_response', 'Stripe sent a transaction NoticeOS could not read.');
    for (const row of rows as BalanceTransaction[]) {
      if (seen.has(row.id)) throw new StripeFailure('stripe_invalid_response', 'Stripe repeated a transaction.');
      seen.add(row.id); out.push(row);
    }
    if (!body.has_more) return out;
    after = out.at(-1)?.id ?? null;
    if (after === null) throw new StripeFailure('stripe_invalid_response', 'Stripe sent a list NoticeOS could not read.');
  }
  throw new StripeFailure('stripe_incomplete_window', 'More transactions than one run reads; nothing was saved.');
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
  const rows: unknown[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ status: 'all', limit: String(PAGE_LIMIT) });
    if (after !== null) query.set('starting_after', after);
    const answer = await stripeGet(apiKey, `/subscriptions?${query}`, fetchImpl, REQUEST_TIMEOUT_MS, account);
    if (answer.kind !== 'ok') throw failureFrom(answer);
    const body = answer.body as { data?: unknown; has_more?: unknown } | null;
    if (!body || !Array.isArray(body.data) || typeof body.has_more !== 'boolean') throw new StripeFailure('stripe_invalid_response', 'Stripe sent an unreadable subscription list.');
    if (body.has_more && body.data.length === 0) throw new StripeFailure('stripe_invalid_response', 'Stripe sent an empty subscription page with more results.');
    for (const row of body.data) {
      const id = (row as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !id || seen.has(id)) throw new StripeFailure('stripe_invalid_response', 'Stripe repeated or omitted a subscription id.');
      seen.add(id); after = id; rows.push(row);
    }
    if (!body.has_more) return rows;
  }
  throw new StripeFailure('stripe_incomplete_window', 'Too many subscriptions for one report; nothing was saved.');
}

/** Write each day whose current figure differs, one statement a day, in one
 * transaction, under the `stripe` source. Returns how many days were written. */
export async function persistStripeDays(env: Pick<IngestEnv, 'STORE'>, target: Target, days: Map<string, number>, currency: string, runId: string, at: string, breakdowns?: Map<string, SalesBreakdown>): Promise<number> {
  return env.STORE.write(async (tx) => {
    let written = 0;
    for (const [day, amountMinor] of days) {
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
  const targets = stripeTargets(options.laneRegister);
  if (resolved.source === 'demo' || targets.length === 0) {
    return { outcome: 'skipped', detail: 'No asset names a Stripe account.', connected: true, outcomes: [] };
  }
  const [clock] = await env.STORE.read((tx) => tx.query<SourceClock>(
    `SELECT time_zone AS "timeZone", ready_after_minute AS "readyAfterMinute"
       FROM noticeos_ref.revenue_sources WHERE source = $1`, [STRIPE_REVENUE_SOURCE]));
  if (!clock) throw new Error(`The store names no revenue source ${STRIPE_REVENUE_SOURCE}; apply its migration.`);
  const end = lastCompleteDay(nowMs, { timeZone: clock.timeZone, readyAfterMinute: Number(clock.readyAfterMinute) });

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
        const gte = Date.parse(`${window.start}T00:00:00Z`) / 1000 - 86_400;
        const lt = Date.parse(`${shiftDay(window.end, 1)}T00:00:00Z`) / 1000 + 86_400;
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
