// DataForSEO's PREPAID CREDIT: one free read of the account, and one writer for
// what it says (beads `ro-qpas`, `ro-vu8d.26`).
//
// WHY THIS IS ITS OWN FILE. Two callers want the figure and they sit on opposite
// sides of a split this repo keeps on purpose: the Test connection probe
// (`credential-probes.ts`, which imports every provider client) and the weekly
// sweep (`dataforseo-dumps.ts`, which every collector path reaches). Putting the
// call in either would make the other import a module it has no other business
// with — the same import cycle the probes were split out of `credentials.ts` to
// avoid. So the account is read in ONE place and written in ONE place, and both
// callers hold three lines each.
//
// THE ONE CALL THIS FILE MAKES, and what keeps it honest: `appendix/user_data`
// is DataForSEO's free endpoint. It costs no money and no metered quota, so it
// is never budgeted, never retried and never counted as spend — a courtesy read
// that fails is a courtesy read that failed, and neither caller may turn that
// into its own failure. `ro-qpas` shipped only the probe's half, so the number
// that decides whether next Monday's sweep can run moved only when a human
// pressed a button; `ro-vu8d.26` gave the sweep the same one call at the end of
// a run that worked.
//
// WHAT IT IS STILL NOT: a live figure. A balance is recorded WITH the instant it
// was seen, and every surface renders it with that age, because the OS can only
// promise when it last looked.
//
// EXACT, NEVER A FLOAT (bead ro-ujb9.76.4.4). The figure is the digits the
// provider sent, taken from the JSON text itself (`ExactUsd`), stored as
// numeric(14,6) and shown from that text: a JavaScript number cannot hold most
// cents exactly.

import { type ExactUsd, type IntegrationProviderId, exactUsd } from '@noticeos/contract';
import { setCredentialBalance } from './credentials.js';

/** DataForSEO's free account endpoint — no money, no metered quota. */
const ACCOUNT_URL = 'https://api.dataforseo.com/v3/appendix/user_data';

/** The provider's own "everything is fine" code inside a 200 envelope. */
const PROVIDER_OK = 20000;

/**
 * What one read of the account came back with.
 *
 * A DISCRIMINATED UNION rather than a bag of fields, because the two callers
 * want different halves and neither should have to re-derive the other's. The
 * probe turns each failure into the sentence an operator reads under the Test
 * button; the sweep looks at `ok` and `usd` and ignores the rest, since a
 * courtesy read it could not complete is not news it can act on.
 *
 * `usd` is null on a successful read that simply did not state a figure — an
 * absent balance is NOT a zero one, and writing zero would tell an operator
 * their account is empty.
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
 * Read the account once.
 *
 * THROWS on a transport failure rather than swallowing it, because the probe's
 * caller turns a thrown fetch into "DataForSEO could not be reached" and that
 * verdict is the whole point of a Test button. The sweep, which is finishing
 * something else, catches instead — see `refreshAccountCredit` there.
 *
 * `timeoutMs` is the caller's, not this module's: a probe is a human waiting on
 * a button and a sweep is a cron finishing a job, and neither should inherit the
 * other's patience.
 *
 * The authorization header is passed in already built and is never logged,
 * echoed into a return value, or put in an error here.
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
 * Record one sighting beside the DataForSEO credential.
 *
 * THE ONE WRITER BOTH CALLERS SHARE, so a probe and a sweep cannot disagree
 * about what gets stored or when. It hands the store a number and the instant
 * the answer arrived; `setCredentialBalance` does the rest, and stays silent
 * where there is no stored credential to hang the fact on (an install still on
 * a legacy env binding has no row).
 *
 * Never throws for the caller's sake: both callers are in the middle of doing
 * something else — reporting a verdict, finishing a paid sweep — and a failure
 * to note a courtesy figure must not become their failure.
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
    // Deliberately silent, and deliberately without the error: a store write
    // that failed says nothing an operator can act on here, and the message
    // could be carrying a bound statement. The card keeps the previous
    // sighting's age, which is the honest reading of what just happened.
  }
}

/**
 * The account credit inside the answer above, or null when it carries none.
 *
 * Read defensively rather than cast, because this is the vendor's envelope: a
 * malformed one must read as "nothing seen" rather than throw inside a probe or
 * at the end of a paid sweep that has already succeeded.
 *
 * Both depths are read because the provider states the figure in a `money`
 * object and does not promise where it hangs it — `appendix/user_data` puts one
 * on the task result, and the same object appears at the envelope root wherever
 * a response reports it alongside `cost`. Neither is invented; an absent one
 * simply answers null.
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

/** `{ balance: 18.72 }` in whatever `money` object was handed over, as the
 * digits the provider sent (`keepBalanceDigits`). */
function balanceIn(value: unknown): ExactUsd | null {
  const money = asRecord(value);
  if (money === null) return null;
  return exactUsd(money.balance);
}

/**
 * JSON.parse's reviver: a `balance` number becomes its own source text, the
 * digits as the provider wrote them, before any float is made of it (the
 * reviver's source text, ES2025 "JSON.parse source text access"). Every other
 * value is left as parsed.
 */
function keepBalanceDigits(key: string, value: unknown, context?: { source?: string }): unknown {
  return key === 'balance' && typeof value === 'number' && typeof context?.source === 'string'
    ? context.source
    : value;
}
