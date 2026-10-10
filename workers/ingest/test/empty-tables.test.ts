import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { emptyTablesHoldingRows } from './helpers.js';

// reset()'s Postgres half (test/helpers.ts): the tables a unit's tests write
// are emptied as the owner once any of them holds a row. Postgres truncates a
// table only with every table whose foreign key references it, even an empty
// one, so a row in the referenced table alone must still leave both empty.

async function rows(table: 'mediavine_runs' | 'mediavine_daily'): Promise<number> {
  const [row] = await env.STORE.read((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM noticeos.${table}`));
  return row?.n ?? 0;
}

describe('emptyTablesHoldingRows', () => {
  it('empties a referenced table whose referencing table holds nothing', async () => {
    // A Mediavine run with no daily facts: mediavine_daily references
    // mediavine_runs by its foreign key and holds no row.
    await env.STORE.write((tx) =>
      tx.execute(
        `INSERT INTO noticeos.mediavine_runs (workspace_id, run_id, asset_id, site_id, start_date, end_date, attempted_at, outcome)
         VALUES ($1::uuid, 'run-1', 'meadow.example', 'site-1', '2026-09-01', '2026-09-01', '2026-09-02T00:00:00Z', 'failed')`,
        [tx.workspaceId],
      ),
    );
    expect(await rows('mediavine_runs')).toBe(1);
    await emptyTablesHoldingRows(['mediavine_daily', 'mediavine_runs']);
    expect(await rows('mediavine_runs')).toBe(0);
    expect(await rows('mediavine_daily')).toBe(0);
  });

  it('leaves the tables alone when none holds a row', async () => {
    await emptyTablesHoldingRows(['mediavine_daily', 'mediavine_runs']);
    expect(await rows('mediavine_runs')).toBe(0);
  });
});
