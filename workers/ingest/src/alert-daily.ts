// The nightly rollup of open alerts — one row per asset per calendar day
// (db/migrations/0033_health_and_alert_dailies.sql, bead `ro-78qo.36`).
//
// WHY IT EXISTS. `flags` records when a condition FIRED and when it was
// resolved. Nothing recorded how many stood OPEN on a given day, so /alerts'
// headline counts are point-in-time totals with no series behind them.
//
// WHY IT CANNOT BE DERIVED BACKWARDS, which is the thing that makes this a
// table rather than a query. "Open on day D" looks like "fired on or before D
// and resolved after it" — but open-ness also depends on the DISPOSITION, and a
// snooze that has since lapsed or an ack that has since expired make a row that
// is open today and was not last week. Reading today's disposition backwards
// onto last Tuesday is guesswork; observing it once a night is a measurement.
//
// ONE OBSERVATION A DAY, AT A FIXED HOUR — it hangs off `runAssetZeroPulse`
// (`./db.ts`, the `0 3 * * *` lane), whose whole job is already to count what
// the store holds tonight. A fixed hour is what makes the points comparable to
// each other: a count taken at 03:00 and one taken at 19:00 are not the same
// measurement of "how much was open that day".
//
// ON POSTGRES (bead ro-ujb9.76.5.2): the rows are `noticeos.alert_daily_counts`,
// the portfolio's row is the one whose site is NULL (D1's `*`), and the open
// alerts are counted from `noticeos.current_flags`, as each reads now. A
// migrated store has the table, so the rollup always runs.

import { openFlagsSql } from '@noticeos/contract';
import { javascriptInstant } from '@noticeos/postgres';

/** How long the rollup keeps a day. Fixed here AND in the migration comment;
 * change them together. Same 400 days as the other two dailies: it is the only
 * record there will ever be of a past day, because `flags` holds the rows and
 * not the shape of the queue they made. */
export const ALERT_DAILY_RETENTION_DAYS = 400;

/**
 * The reserved `asset` value for the portfolio row — every asset at once.
 *
 * It exists because of the MEDIAN. Counts add up across assets and a median
 * does not: the median of a set of per-asset medians is not the median of the
 * portfolio, and /alerts' "Median age" is a portfolio figure. The alternative
 * was storing every open flag's age, which is a second copy of `flags`. `*`
 * cannot collide with an asset id — those are domains and slugs.
 */
export const ALERT_DAILY_PORTFOLIO = '*';

export type AlertDailyOutcome = { assets: number; pruned: number };

interface OpenFlagRow {
  asset: string;
  severity: string;
  firedAt: string;
}

/**
 * Half of a sorted list of ages, in hours.
 *
 * The MIDPOINT on an even-sized set, not the lower of the two: "half of them
 * have been open longer than this" is a statement about the middle of the set,
 * and picking a member of it would make a two-alert portfolio report the age of
 * whichever one happened to sort first.
 *
 * `null` for an EMPTY set. The median of nothing is not zero, and a chart that
 * drew it as zero would show the portfolio at its calmest exactly where it had
 * nothing to say.
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
 * Roll tonight's open alerts into today's rows.
 *
 * ONE ROW PER ASSET THAT HAS OPEN FLAGS, plus one for the portfolio. An asset
 * with a quiet night gets no row at all, which is right for a per-asset series:
 * this measures the shape of a queue, and an asset with no queue has no shape.
 * The portfolio row is written unconditionally, because "nothing was open
 * anywhere tonight" IS the measurement a calm line is made of.
 *
 * `open` is counted with the TOWER'S OWN definition of open
 * (`openFlagsSql`, `@noticeos/contract`) rather than a second one written
 * here: a line drawn from a different predicate than the headline above it would
 * be two answers to one question.
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
      // An unreadable `fired_at` is left OUT of the median rather than counted
      // as age zero: a defective timestamp must not drag the middle of the set
      // toward "just fired".
      const firedMs = Date.parse(row.firedAt ?? '');
      if (Number.isFinite(firedMs)) cell.ages.push((nowMs - firedMs) / 3_600_000);
    }

    for (const [asset, cell] of byAsset) {
      await tx.execute(UPSERT, [tx.workspaceId, asset, day, now, cell.open, cell.errors, cell.warnings, medianHours(cell.ages)]);
    }

    // THE PORTFOLIO ROW, from the whole set rather than from the rows above —
    // see `ALERT_DAILY_PORTFOLIO`. It is written even when nothing is open, and
    // that zero is a real measurement: the OS looked tonight and found the
    // portfolio quiet, which is exactly the point a calm line is made of. Its
    // median is null, because the median of an empty set is not zero.
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
