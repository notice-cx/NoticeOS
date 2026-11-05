import { env } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { connectCredential } from '../src/credential-connect';
import { deleteCredential, putCredential, recordCredentialOutcome, resolveCredential } from '../src/credentials';
import { checkMercuryKey, readMercurySnapshot, runMercuryBanking } from '../src/mercury';
import { pgCount, pgRows, reset } from './helpers';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = () => crypto.randomUUID();
const bankAccount = (n = 1) => ({ id: id(n), type: 'mercury', kind: 'checking', name: 'Operating', nickname: null,
  status: 'active', currentBalance: 1250.29, availableBalance: 1100.01, accountNumber: 'synthetic-account-number', routingNumber: 'synthetic-routing-number' });
const bankTransaction = (n = 10) => ({ id: id(n), accountId: id(1), amount: -10.29,
  counterpartyName: 'Example vendor', counterpartyNickname: null, kind: 'debitCardTransaction', status: 'pending',
  createdAt: '2026-11-04T12:00:00Z', postedAt: null, details: { private: 'unused-provider-data' } });
function api(options: { accounts?: unknown[]; transactions?: unknown[]; status?: number; loop?: boolean } = {}) {
  const calls: URL[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    expect(url.origin).toBe('https://api.mercury.com');
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer /);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (options.status) return Response.json({ message: 'unused-private-provider-error' }, { status: options.status });
    const resource = url.pathname.endsWith('/accounts') ? 'accounts' : 'transactions';
    const all = resource === 'accounts' ? options.accounts ?? [bankAccount()] : options.transactions ?? [bankTransaction()];
    const after = url.searchParams.get('start_after');
    const from = after ? all.findIndex(row => (row as { id: string }).id === after) + 1 : 0;
    const list = all.slice(from, from + 1);
    const nextPage = options.loop ? id(999) : from + 1 < all.length ? (list.at(-1) as { id: string }).id : null;
    return Response.json({ [resource]: list, page: { nextPage } });
  });
  return { fetchImpl, calls };
}
async function connect() {
  const result = await putCredential(env, { provider: 'mercury', fields: { MERCURY_API_TOKEN: key() } });
  expect(result).toMatchObject({ ok: true });
}
const count = (table: 'mercury_readings' | 'ledger_entries' | 'revenue_observations') => pgCount(`SELECT count(*) AS n FROM noticeos.${table}`);
beforeEach(async () => { await reset(); vi.restoreAllMocks(); });

it('paginates both resources, preserves cents and signs, and drops bank identifiers and raw details', async () => {
  const remote = api({ accounts: [bankAccount(), { ...bankAccount(2), name: 'Reserve' }],
    transactions: [bankTransaction(), { ...bankTransaction(11), amount: 0.29, status: 'sent', postedAt: '2026-11-05T00:00:00Z', kind: 'internalTransfer' }] });
  const snapshot = await readMercurySnapshot(key(), NOW, remote.fetchImpl);
  expect(snapshot.accounts).toHaveLength(2);
  expect(snapshot.accounts[0]).toMatchObject({ currentMinor: 125029, availableMinor: 110001 });
  expect(snapshot.transactions.map(row => row.amountMinor)).toEqual([-1029, 29]);
  expect(snapshot.transactions[1]).toMatchObject({ kind: 'internalTransfer', status: 'sent' });
  expect(remote.calls.filter(url => url.searchParams.has('start_after'))).toHaveLength(2);
  expect(remote.calls.find(url => url.pathname.endsWith('/transactions'))?.searchParams.get('start')).toBe('2026-10-01T12:00:00.000Z');
  expect(JSON.stringify(snapshot)).not.toMatch(/accountNumber|routingNumber|unused-provider-data/);
});

it('excludes external accounts and activity from credit or treasury accounts', async () => {
  const remote = api({ accounts: [bankAccount(), { ...bankAccount(2), type: 'external', currentBalance: 99999 }],
    transactions: [bankTransaction(), { ...bankTransaction(11), accountId: id(2) }, { ...bankTransaction(12), accountId: id(3) }] });
  const snapshot = await readMercurySnapshot(key(), NOW, remote.fetchImpl);
  expect(snapshot.accounts).toHaveLength(1);
  expect(snapshot.transactions).toHaveLength(1);
});

it('refuses a window that exceeds the page bound instead of presenting partial activity', async () => {
  const remote = api({ transactions: Array.from({ length: 11 }, (_, index) => bankTransaction(index + 10)) });
  await expect(readMercurySnapshot(key(), NOW, remote.fetchImpl)).rejects.toThrow('mercury_incomplete_report');
});

it.each([401, 403, 429, 500])('classifies HTTP %s without exposing provider prose', async status => {
  const remote = api({ status });
  expect(await checkMercuryKey(key(), remote.fetchImpl, 20)).toBe(status === 429 ? 'rate-limited' : status < 429 ? 'refused' : 'unreachable');
});

it('stores a candidate only after Mercury accepts it', async () => {
  const refused = await connectCredential(env, { provider: 'mercury', fields: { MERCURY_API_TOKEN: key() } }, api({ status: 401 }));
  expect(refused).toMatchObject({ ok: true, verdict: 'refused' });
  expect(await pgCount("SELECT count(*) AS n FROM noticeos.integration_connections WHERE provider = 'mercury'")).toBe(0);
  const accepted = await connectCredential(env, { provider: 'mercury', fields: { MERCURY_API_TOKEN: key() } }, api());
  expect(accepted).toMatchObject({ ok: true, verdict: 'accepted' });
});

it('makes no requests without a connected token', async () => {
  const remote = api();
  expect(await runMercuryBanking(env, { ...remote, nowMs: NOW })).toMatchObject({ outcome: 'skipped' });
  expect(remote.calls).toHaveLength(0);
});

it('keeps snapshots append-only and never books payouts, transfers or card activity as revenue or cost', async () => {
  await connect();
  const remote = api();
  expect(await runMercuryBanking(env, { ...remote, nowMs: NOW })).toMatchObject({ outcome: 'ran' });
  const changed = api({ transactions: [{ ...bankTransaction(), status: 'reversed' }] });
  expect(await runMercuryBanking(env, { ...changed, nowMs: NOW + 3_600_000 })).toMatchObject({ outcome: 'ran' });
  const rows = await pgRows<{ payload: string }>('SELECT payload FROM noticeos.mercury_readings ORDER BY observed_at');
  expect(rows.map(row => (JSON.parse(row.payload) as { transactions: { status: string }[] }).transactions[0]?.status)).toEqual(['pending', 'reversed']);
  expect(await count('ledger_entries')).toBe(0);
  expect(await count('revenue_observations')).toBe(0);
});

it.each(['loop', 'malformed', 'http', 'network', 'unsafe'] as const)('retains the complete observation on a %s failure', async failure => {
  await connect();
  await runMercuryBanking(env, { ...api(), nowMs: NOW });
  const remote = failure === 'network' ? { fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('private-provider-error')) }
    : failure === 'http' ? api({ status: 503 })
      : failure === 'malformed' ? api({ transactions: [{ ...bankTransaction(), amount: null }] })
        : failure === 'unsafe' ? api({ accounts: [{ ...bankAccount(), availableBalance: Number.MAX_SAFE_INTEGER }] })
          : api({ loop: true, transactions: [bankTransaction(), bankTransaction(11), bankTransaction(12)] });
  const result = await runMercuryBanking(env, { ...remote, nowMs: NOW + 3_600_000 });
  expect(result).toMatchObject({ outcome: 'failed' });
  expect(JSON.stringify(result)).not.toMatch(/private-provider-error|unused-private-provider-error/);
  expect(await count('mercury_readings')).toBe(1);
});

it('refuses to publish a read after its connection is replaced', async () => {
  await connect();
  const remote = api();
  let replaced = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (!replaced) { replaced = true; await deleteCredential(env, 'mercury'); await connect(); }
    return remote.fetchImpl(input, init);
  };
  expect(await runMercuryBanking(env, { fetchImpl, nowMs: NOW })).toMatchObject({ outcome: 'failed' });
  expect(await count('mercury_readings')).toBe(0);
});

it('does not stamp an old credential verdict onto a replacement connection', async () => {
  await connect();
  const old = await resolveCredential(env, 'mercury');
  await deleteCredential(env, 'mercury');
  await connect();
  await recordCredentialOutcome(env, 'mercury', { ok: false, error: 'Mercury refused the token.',
    connection: { id: old.connectionId!, updatedAt: old.revision!.updatedAt } });
  const rows = await pgRows<{ last_error: string | null }>("SELECT last_error FROM noticeos.integration_connections WHERE provider = 'mercury'");
  expect(rows[0]?.last_error).toBeNull();
});
