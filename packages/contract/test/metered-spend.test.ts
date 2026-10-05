import { expect, it } from 'vitest';
import { loadMeteredDataSpend, type MeteredSpendStore } from '../src/metered-spend';

it('keeps unknown costs visible in the same window and excludes collector research twice', async () => {
  const calls: { sql: string; params: readonly (string | number)[] | undefined }[] = [];
  const store: MeteredSpendStore = {
    read: (work) => work({
      async query<R extends Record<string, unknown>>(sql: string, params?: readonly (string | number)[]) {
        calls.push({ sql, params });
        const rows: Record<string, unknown>[] = sql.includes('archive_runs')
          ? [{ asset: 'example.com', spent: '1.250000', unknown: 2 }, { asset: 'unpriced.example', spent: '0', unknown: 1 }]
          : [{ asset: 'example.com', spent: '0.500000', unknown: 1 }, { asset: null, spent: '0.250000', unknown: 3 }];
        return rows as R[];
      },
    }),
  };
  expect(await loadMeteredDataSpend(store, '2026-09-30T12:00:00.000Z')).toEqual({
    spentUsd: 2, unknownPrices: 7,
    byAsset: [
      { asset: 'example.com', spentUsd: 1.75, unknownPrices: 3 },
      { asset: 'unpriced.example', spentUsd: 0, unknownPrices: 1 },
    ],
    unattributedUsd: 0.25, unattributedUnknownPrices: 3,
  });
  expect(calls.map((call) => call.params)).toEqual([
    ['dataforseo', '2026-09-01T00:00:00.000Z'],
    ['dataforseo', '2026-09-01T00:00:00.000Z', 'collector'],
  ]);
});
