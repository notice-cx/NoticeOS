// The nightly rollup of open alerts: one row per asset per calendar day, plus
// the portfolio's. "Open on day D" cannot be derived backwards from `flags`
// because open-ness depends on dispositions that lapse, so it is observed once
// a night at a fixed hour, off the asset-zero pulse lane.

import { openFlagsSql } from '@noticeos/contract';
import { javascriptInstant } from '@noticeos/postgres';

/** Fixed here and in the migration comment; change them together. */
export const ALERT_DAILY_RETENTION_DAYS = 400;

/**
 * The reserved `asset` value for the portfolio row. It exists because a median
 * does not add up across assets the way counts do. `*` cannot collide with an
 * asset id.
 */
export const ALERT_DAILY_PORTFOLIO = '*';

export type AlertDailyOutcome = { assets: number; pruned: number };

interface OpenFlagRow {
  asset: string;
  severity: string;
  firedAt: string;
}

/**
 * The midpoint on an even-sized set, not a member of it; `null` for an empty
 * set, because the median of nothing is not zero.
 */
export function medianHours(ages: number[]): number | null {
  if (ages.length === 0) return null;
  const sorted = [...ages].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** One day's row: a site's, or the portfolio's where `$2` is NULL. A later
 * observation of the same day replaces it; an earlier one never does. */
const UPSERT = `INSERT INTO noticeos.alert_daily_counts AS c
       (workspace_id, asset_id, day, observed_at, open, errors, warnings, median_open_age_hours)
     VALUES ($1, $2, $3::date, $4::timestamptz, $5, $6, $7, $8)
     ON CONFLICT (workspace_id, asset_id, day) DO UPDATE SET
       observed_at           = excluded.observed_at,
       open                  = excluded.open,
       errors                = excluded.errors,
       warnings              = excluded.warnings,
       median_open_age_hours = excluded.median_open_age_hours
      WHERE excluded.observed_at >= c.observed_at`;

/**
 * One row per asset that has open flags, plus one for the portfolio, written
 * even when nothing is open: a quiet night is a measurement. `open` is the
 * Tower's own definition (`openFlagsSql`), so the line and the headline above
 * it are one answer.
 */
export async function rollUpAlertDay(
  env: Pick<IngestEnv, 'STORE'>,
  nowMs: number,
): Promise<AlertDailyOutcome> {
  const now = new Date(nowMs).toISOString();
  const day = now.slice(0, 10);
  return env.STORE.write(async (tx) => {
    const results = (
      await tx.query<{ asset: string; severity: string; firedAt: string }>(
        `SELECT asset_id AS asset, severity, fired_at AS "firedAt"
           FROM noticeos.current_flags
          WHERE ${openFlagsSql('', '$1::timestamptz')}`,
        [now],
      )
    ).map((row): OpenFlagRow => ({ ...row, firedAt: javascriptInstant(row.firedAt) }));

    const byAsset = new Map<
      string,
      { open: number; errors: number; warnings: number; ages: number[] }
    >();
    for (const row of results) {
      if (typeof row.asset !== 'string' || row.asset === '') continue;
      let cell = byAsset.get(row.asset);
      if (!cell) {
        cell = { open: 0, errors: 0, warnings: 0, ages: [] };
        byAsset.set(row.asset, cell);
      }
      cell.open += 1;
      if (row.severity === 'error') cell.errors += 1;
      else if (row.severity === 'warn') cell.warnings += 1;
      cell.ages.push((nowMs - Date.parse(row.firedAt)) / 3_600_000);
    }

    for (const [asset, cell] of byAsset) {
      await tx.execute(UPSERT, [tx.workspaceId, asset, day, now, cell.open, cell.errors, cell.warnings, medianHours(cell.ages)]);
    }

    // The portfolio row, from the whole set rather than from the rows above.
    const all = {
      open: 0,
      errors: 0,
      warnings: 0,
      ages: [] as number[],
    };
    for (const cell of byAsset.values()) {
      all.open += cell.open;
      all.errors += cell.errors;
      all.warnings += cell.warnings;
      all.ages.push(...cell.ages);
    }
    await tx.execute(UPSERT, [tx.workspaceId, null, day, now, all.open, all.errors, all.warnings, medianHours(all.ages)]);

    const cutoff = new Date(nowMs - ALERT_DAILY_RETENTION_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const pruned = await tx.execute(`DELETE FROM noticeos.alert_daily_counts WHERE day < $1::date`, [cutoff]);

    return { assets: byAsset.size, pruned };
  });
}
