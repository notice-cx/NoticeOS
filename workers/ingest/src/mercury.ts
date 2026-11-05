import type { ScheduledRunResult } from '@noticeos/contract';
import { majorToMinorUnits } from '@noticeos/contract/money';
import { MERCURY_WINDOW_DAYS, bankAccountSchema, bankTransactionSchema, mercurySnapshotSchema, type BankAccount, type BankTransaction, type MercurySnapshot } from '@noticeos/contract/banking';
import { credentialConnected, recordCredentialOutcome, resolveCredential } from './credentials.js';
import { observeIntegration, tryHealthConnection } from './integration-health-context.js';
import { asRecord } from './shared.js';

export const MERCURY_KEY_FIELD = 'MERCURY_API_TOKEN';
export const MERCURY_CAPABILITY = 'mercury-banking';
const API = 'https://api.mercury.com/api/v1';
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;
const TIMEOUT_MS = 20_000;

class MercuryFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
function invalid(): never { throw new MercuryFailure('mercury_invalid_response'); }

async function get(token: string, path: string, fetchImpl: typeof fetch, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method: 'GET', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { throw new MercuryFailure('request_failed'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new MercuryFailure(`mercury_http_${response.status}`);
  }
  try { return await response.json(); }
  catch { return invalid(); }
}

/** The cursor is an exclusive start_after, never a URL supplied by Mercury. */
async function pages(token: string, resource: 'accounts' | 'transactions', query: URLSearchParams, fetchImpl: typeof fetch): Promise<unknown[]> {
  const rows: unknown[] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  query.set('limit', String(PAGE_SIZE));
  query.set('order', 'asc');
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = asRecord(await get(token, `/${resource}?${query}`, fetchImpl));
    const list = body?.[resource];
    const pagination = asRecord(body?.page);
    if (!Array.isArray(list) || list.length > PAGE_SIZE || !pagination) invalid();
    for (const row of list) {
      const id = asRecord(row)?.id;
      if (typeof id !== 'string' || !bankAccountSchema.shape.id.safeParse(id).success || ids.has(id)) invalid();
      ids.add(id);
      rows.push(row);
    }
    const next = pagination.nextPage;
    if (next === null || next === undefined) return rows;
    if (typeof next !== 'string' || !bankAccountSchema.shape.id.safeParse(next).success || cursors.has(next) || list.length === 0) invalid();
    cursors.add(next);
    // The last delivered id works with the documented exclusive cursor even
    // when nextPage identifies the first item of the following page.
    query.set('start_after', String(asRecord(list.at(-1))?.id));
  }
  throw new MercuryFailure('mercury_incomplete_report');
}

/** One free account read proves access without retaining account details. */
export async function checkMercuryKey(token: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<'accepted' | 'refused' | 'rate-limited' | 'unreachable'> {
  try {
    const body = asRecord(await get(token, '/accounts?limit=1&order=asc', fetchImpl, timeoutMs));
    return Array.isArray(body?.accounts) && asRecord(body?.page) !== null ? 'accepted' : 'unreachable';
  } catch (error) {
    const code = error instanceof MercuryFailure ? error.code : '';
    return /_http_(401|403)$/.test(code) ? 'refused' : code === 'mercury_http_429' ? 'rate-limited' : 'unreachable';
  }
}

function minor(value: unknown): number {
  if (typeof value !== 'number') invalid();
  const amount = majorToMinorUnits(value, 'USD');
  if (!Number.isSafeInteger(amount)) invalid();
  return amount;
}

/** Only the depository endpoint's owned accounts contribute to cash. */
function account(value: unknown): BankAccount | null {
  const row = asRecord(value);
  if (!row || !['mercury', 'external', 'recipient'].includes(String(row.type))) invalid();
  if (row.type !== 'mercury') return null;
  if (row.currency !== undefined && row.currency !== 'USD') invalid();
  const result = bankAccountSchema.safeParse({ id: row.id, name: row.nickname || row.name,
    kind: row.kind, status: row.status, currentMinor: minor(row.currentBalance), availableMinor: minor(row.availableBalance) });
  if (!result.success) invalid();
  return result.data;
}

function transaction(value: unknown): BankTransaction {
  const row = asRecord(value);
  if (!row) invalid();
  const result = bankTransactionSchema.safeParse({ id: row.id, accountId: row.accountId,
    amountMinor: minor(row.amount), counterparty: row.counterpartyNickname || row.counterpartyName,
    kind: row.kind, status: row.status, createdAt: row.createdAt, postedAt: row.postedAt });
  if (!result.success) invalid();
  return result.data;
}

/** Re-read the bounded window so pending, failed and reversed entries can change. */
export async function readMercurySnapshot(token: string, nowMs: number, fetchImpl: typeof fetch): Promise<MercurySnapshot> {
  const windowEnd = new Date(nowMs).toISOString();
  const windowStart = new Date(nowMs - MERCURY_WINDOW_DAYS * 86_400_000).toISOString();
  const accounts = (await pages(token, 'accounts', new URLSearchParams(), fetchImpl)).map(account).filter((row): row is BankAccount => row !== null);
  const owned = new Set(accounts.map(row => row.id));
  if (accounts.length > 1000) invalid();
  const transactions = (await pages(token, 'transactions', new URLSearchParams({ start: windowStart, end: windowEnd }), fetchImpl))
    .map(transaction).filter(row => owned.has(row.accountId));
  if (transactions.some(row => Date.parse(row.createdAt) < Date.parse(windowStart) || Date.parse(row.createdAt) > nowMs)) invalid();
  return mercurySnapshotSchema.parse({ currency: 'USD', windowStart, windowEnd, accounts, transactions });
}

export async function runMercuryBanking(env: IngestEnv, options: { nowMs?: number; fetchImpl?: typeof fetch } = {}): Promise<ScheduledRunResult> {
  const nowMs = options.nowMs ?? Date.now();
  const at = new Date(nowMs).toISOString();
  const resolved = await resolveCredential(env, 'mercury');
  if (!(await credentialConnected(env, 'mercury', resolved)) || resolved.source === 'demo') {
    return { outcome: 'skipped', detail: 'Mercury is not connected.' };
  }
  const health = await tryHealthConnection(env, 'mercury', resolved);
  const attemptId = crypto.randomUUID();
  let code: string | undefined;
  try {
    const token = resolved.fields[MERCURY_KEY_FIELD];
    if (!token || !resolved.connectionId || !resolved.revision) throw new MercuryFailure('credential_unavailable');
    const connectionId = resolved.connectionId;
    const revision = resolved.revision;
    const snapshot = await readMercurySnapshot(token, nowMs, options.fetchImpl ?? fetch);
    // Replacing or disconnecting the connection during collection invalidates it.
    const saved = await env.STORE.write(tx => tx.query<{ reading_id: string }>(
      `INSERT INTO noticeos.mercury_readings
         (workspace_id, reading_id, connection_id, connection_updated_at, observed_at, payload)
       SELECT $1::uuid, $2::uuid, connection_id, updated_at, $5::timestamptz, $6::jsonb
         FROM noticeos.integration_connections
        WHERE provider = 'mercury' AND connection_id = $3::uuid AND updated_at = $4::timestamptz
       RETURNING reading_id`,
      [tx.workspaceId, attemptId, connectionId, revision.updatedAt, at, JSON.stringify(snapshot)]));
    if (!saved.length) throw new MercuryFailure('credential_changed');
  } catch (error) { code = error instanceof MercuryFailure ? error.code : 'mercury_collection_failed'; }
  const monitored = await observeIntegration(env, health, { capability: MERCURY_CAPABILITY, observedAt: at, attemptId, ok: !code, code });
  // An old attempt must not stamp a replacement credential's verdict.
  if (resolved.connectionId && resolved.revision && (!code || /_http_(401|403)$/.test(code))) {
    await recordCredentialOutcome(env, 'mercury', { ok: !code, at,
      connection: { id: resolved.connectionId, updatedAt: resolved.revision.updatedAt },
      ...(code ? { error: 'Mercury refused the token.' } : {}) });
  }
  return { outcome: code ? 'failed' : 'ran',
    detail: code ? 'Mercury collection failed; saved bank data was retained.' : 'Mercury balances and recent transactions collected.',
    ...(!monitored ? { monitoringAvailable: false } : {}) };
}
