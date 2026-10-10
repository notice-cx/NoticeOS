// DataForSEO's prepaid credit: one free read of the account, and one writer
// for what it says. Its own file because the two callers (the connection
// probe, which imports every provider client, and the weekly sweep, which
// every collector path reaches) sit on opposite sides of an import split.
// `appendix/user_data` costs no money and no metered quota, so it is never
// budgeted, retried or counted as spend, and a courtesy read that fails is
// never either caller's failure. A balance is recorded with the instant it was
// seen and rendered with that age. Exact, never a float: the figure is the
// digits the provider sent (`ExactUsd`), stored as numeric(14,6).

import { type ExactUsd, type IntegrationProviderId, exactUsd } from '@noticeos/contract';
import { setCredentialBalance } from './credentials.js';

/** DataForSEO's free account endpoint — no money, no metered quota. */
const ACCOUNT_URL = 'https://api.dataforseo.com/v3/appendix/user_data';

/** The provider's own "everything is fine" code inside a 200 envelope. */
const PROVIDER_OK = 20000;

/**
 * What one read of the account came back with. `usd` is null on a successful
 * read that stated no figure: an absent balance is not a zero one.
 */
export type DataForSeoAccountRead =
  | { readonly ok: true; readonly usd: ExactUsd | null }
  /** The login and password were rejected. */
  | { readonly ok: false; readonly reason: 'unauthorized' }
  /** The transport answered, but not with a 2xx. */
  | { readonly ok: false; readonly reason: 'http'; readonly status: number }
  /** A 200 whose envelope refused; `statusCode` is the provider's own code. */
  | { readonly ok: false; readonly reason: 'refused'; readonly statusCode: number | null };

/**
 * Read the account once. Throws on a transport failure, because the probe's
 * caller turns a thrown fetch into "could not be reached"; the sweep catches
 * instead. `timeoutMs` is the caller's: a probe is a human waiting on a button
 * and a sweep is a cron finishing a job. The authorization header is never
 * logged, echoed or put in an error here.
 */
export async function readDataForSeoAccount(
  authorization: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<DataForSeoAccountRead> {
  const response = await fetchImpl(ACCOUNT_URL, {
    headers: { authorization, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401) {
    await response.body?.cancel();
    return { ok: false, reason: 'unauthorized' };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, reason: 'http', status: response.status };
  }
  const body: unknown = JSON.parse(await response.text(), keepBalanceDigits);
  const statusCode = asRecord(body)?.status_code;
  if (statusCode !== PROVIDER_OK) {
    return {
      ok: false,
      reason: 'refused',
      statusCode: typeof statusCode === 'number' ? statusCode : null,
    };
  }
  return { ok: true, usd: readBalance(body) };
}

/**
 * Record one sighting beside the DataForSEO credential: the one writer both
 * callers share. `setCredentialBalance` stays silent where there is no stored
 * credential to hang the fact on. Never throws: a failure to note a courtesy
 * figure must not become the caller's failure.
 */
export async function recordDataForSeoBalance(
  env: IngestEnv,
  usd: ExactUsd,
  seenAt: string,
): Promise<void> {
  const provider: IntegrationProviderId = 'dataforseo';
  try {
    await setCredentialBalance(env, provider, { usd, seenAt });
  } catch {
    // Silent, and without the error: the message could be carrying a bound
    // statement, and the card keeps the previous sighting's age.
  }
}

/**
 * The account credit inside the answer, or null. Read defensively, because a
 * malformed envelope must read as "nothing seen" rather than throw. Both
 * depths are read because the provider does not promise where it hangs the
 * `money` object.
 */
function readBalance(body: unknown): ExactUsd | null {
  const root = asRecord(body);
  if (root === null) return null;
  const fromRoot = balanceIn(root.money);
  if (fromRoot !== null) return fromRoot;
  const tasks = Array.isArray(root.tasks) ? root.tasks : [];
  for (const entry of tasks) {
    const task = asRecord(entry);
    if (task === null) continue;
    const fromTask = balanceIn(task.money);
    if (fromTask !== null) return fromTask;
    const results = Array.isArray(task.result) ? task.result : [];
    for (const item of results) {
      const fromResult = balanceIn(asRecord(item)?.money);
      if (fromResult !== null) return fromResult;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The `balance` of a `money` object, as the digits the provider sent. */
function balanceIn(value: unknown): ExactUsd | null {
  const money = asRecord(value);
  if (money === null) return null;
  return exactUsd(money.balance);
}

/**
 * JSON.parse's reviver: a `balance` number becomes its own source text before
 * any float is made of it (ES2025 "JSON.parse source text access").
 */
function keepBalanceDigits(key: string, value: unknown, context?: { source?: string }): unknown {
  return key === 'balance' && typeof value === 'number' && typeof context?.source === 'string'
    ? context.source
    : value;
}
