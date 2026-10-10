import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { asOwner, bookEntry, emptyTables, reset, storedCount } from './helpers.js';

// The ledger's correction rules, for entries that never pass through POST
// /api/revenue: imports, restores, fixtures, hand-written SQL. They are the
// store's own (0001_baseline.sql `ledger_correction_matches_target`,
// `ledger_entries_one_successor`, `ledger_entries_are_immutable`). Every
// statement here is direct SQL against the store.

beforeEach(reset);

interface Row {
  id?: number;
  kind?: 'revenue' | 'cost';
  asset?: string;
  period?: string;
  family?: string;
  currency?: string;
  supersedes_id?: bigint | number | null;
}

/** Book one entry; defaults describe a May ads estimate for meals.example. */
function insert(row: Row = {}) {
  return bookEntry({
    ...(row.id === undefined ? {} : { entryId: row.id }),
    kind: row.kind ?? 'revenue',
    asset: row.asset ?? 'meals.example',
    period: row.period ?? '2026-05',
    family: row.family ?? 'ads',
    amountMinor: 100,
    currency: row.currency ?? 'USD',
    bookingState: row.supersedes_id == null ? 'estimated' : 'reconciled',
    supersedesId: row.supersedes_id ?? null,
  });
}

const entries = (where = 'true', params: (string | bigint)[] = []) =>
  storedCount(`SELECT count(*)::int AS n FROM noticeos.ledger_entries WHERE ${where}`, params);

/** `sql` run as the owner in this test's workspace (row security binds the
 * owner too), for what the application role has no privilege to try. */
async function asOwnerInWorkspace(sql: string): Promise<void> {
  const workspace = await env.STORE.workspaceId();
  await asOwner(`SELECT set_config('noticeos.workspace_id', '${workspace}', false);\n${sql}`);
}

describe('ledger chain guards', () => {
  it('accepts a correction of the same entry, written after it', async () => {
    const estimate = await insert();
    await insert({ supersedes_id: estimate.entryId });
    expect(await entries('supersedes_id = $1::bigint', [estimate.entryId])).toBe(1);
  });

  it('refuses a second successor of one entry', async () => {
    const estimate = await insert();
    await insert({ supersedes_id: estimate.entryId });
    await expect(insert({ supersedes_id: estimate.entryId })).rejects.toThrow(/ledger_entries_one_successor/);
    expect(await entries()).toBe(2);
  });

  it('refuses a row that supersedes itself', async () => {
    await expect(insert({ id: 50, supersedes_id: 50 })).rejects.toThrow(/must name an earlier entry/);
    expect(await entries()).toBe(0);
  });

  it('refuses a forward reference to a row written later', async () => {
    await insert({ id: 20 });
    await expect(insert({ id: 10, supersedes_id: 20 })).rejects.toThrow(/must name an earlier entry/);
    expect(await entries()).toBe(1);
  });

  it.each([
    ['asset', { asset: 'nosh.example' }],
    ['period', { period: '2026-06' }],
    ['kind (and so family)', { kind: 'cost' as const, family: 'infra' }],
    ['family', { family: 'affiliate' }],
    ['currency', { currency: 'EUR' }],
  ])('refuses a correction with a different %s', async (_field, over) => {
    const estimate = await insert();
    await expect(insert({ supersedes_id: estimate.entryId, ...over })).rejects.toThrow(
      /same site, month, kind, family and currency/,
    );
    expect(await entries()).toBe(1);
  });

  it('refuses re-pointing a correction by UPDATE', async () => {
    const first = await insert();
    await insert({ period: '2026-06' });
    const correction = await insert({ supersedes_id: first.entryId });
    // The application may not change an entry at all; the owner is refused by
    // the store itself.
    await expect(
      env.STORE.write((tx) =>
        tx.execute('UPDATE noticeos.ledger_entries SET supersedes_id = NULL WHERE entry_id = $1', [correction.entryId]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asOwnerInWorkspace(`UPDATE noticeos.ledger_entries SET supersedes_id = NULL WHERE entry_id = ${correction.entryId};`),
    ).rejects.toThrow(/entries are immutable/);
    expect(await entries('entry_id = $1::bigint AND supersedes_id = $2::bigint', [correction.entryId, first.entryId])).toBe(1);
  });

  it('refuses closing a cycle by UPDATE', async () => {
    const first = await insert();
    const second = await insert({ supersedes_id: first.entryId });
    await expect(
      asOwnerInWorkspace(
        `UPDATE noticeos.ledger_entries SET supersedes_id = ${second.entryId} WHERE entry_id = ${first.entryId};`,
      ),
    ).rejects.toThrow(/entries are immutable/);
  });

  it('refuses changing the identity of a row in a chain, on either end', async () => {
    const first = await insert();
    const second = await insert({ supersedes_id: first.entryId });
    await expect(
      asOwnerInWorkspace(`UPDATE noticeos.ledger_entries SET asset_id = 'nosh.example' WHERE entry_id = ${first.entryId};`),
    ).rejects.toThrow(/entries are immutable/);
    await expect(
      asOwnerInWorkspace(`UPDATE noticeos.ledger_entries SET period_month = '2026-06-01' WHERE entry_id = ${second.entryId};`),
    ).rejects.toThrow(/entries are immutable/);
  });

  it('refuses removing an entry, and still lets the whole table be emptied (the test reset depends on it)', async () => {
    const first = await insert();
    await insert({ supersedes_id: first.entryId });
    await expect(
      asOwnerInWorkspace(`DELETE FROM noticeos.ledger_entries WHERE entry_id = ${first.entryId};`),
    ).rejects.toThrow(/entries are immutable/);
    await emptyTables(['ledger_entries']);
    expect(await entries()).toBe(0);
  });
});
