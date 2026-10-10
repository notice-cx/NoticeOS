import { env } from 'cloudflare:test';
import { javascriptInstant } from '@noticeos/postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALERT_DAILY_PORTFOLIO,
  ALERT_DAILY_RETENTION_DAYS,
  medianHours,
  rollUpAlertDay,
} from '../src/alert-daily.js';
import { emptyTables, insertFlag, pgRows, reset } from './helpers.js';

// The nightly rollup that gives /alerts' Open and Median-age figures a series.
//
// The writer is driven directly rather than through `runAssetZeroPulse`,
// because what is being asserted is the arithmetic; that the nightly lane calls
// it is one line in `db.ts` and is asserted there by the pulse suite continuing
// to pass. The portfolio's row is the one with no site, read here as `*`.

beforeEach(reset);

type DailyRow = {
  asset: string;
  day: string;
  observed_at: string;
  open: number;
  errors: number;
  warnings: number;
  median_open_age_hours: number | null;
};

const NOW_MS = Date.parse('2026-09-05T03:00:00.000Z');
const TODAY = '2026-09-05';

/** One flag, open unless a disposition says otherwise. */
async function flag(overrides: {
  asset?: string;
  severity?: string;
  firedAt?: string;
  resolvedAt?: string | null;
  disposition?: string | null;
  snoozeUntil?: string | null;
}): Promise<void> {
  await insertFlag({
    asset: overrides.asset ?? 'meadow.example',
    firedAt: overrides.firedAt ?? '2026-09-04T03:00:00.000Z',
    severity: overrides.severity ?? 'error',
    kind: 'anomaly',
    ruleId: 'test-rule',
    disposition: overrides.disposition ?? null,
    snoozeUntil: overrides.snoozeUntil ?? null,
    resolvedAt: overrides.resolvedAt ?? null,
  });
}

/** The stored days, the portfolio's row as `*`. */
const DAILY_SQL = `SELECT coalesce(asset_id, '${ALERT_DAILY_PORTFOLIO}') AS asset, day::text AS day, observed_at,
                          open, errors, warnings, median_open_age_hours
                     FROM noticeos.alert_daily_counts`;

async function rows(): Promise<DailyRow[]> {
  const found = await pgRows<DailyRow>(`${DAILY_SQL} ORDER BY day ASC, coalesce(asset_id, '${ALERT_DAILY_PORTFOLIO}') COLLATE "C" ASC`);
  return found.map((row) => ({ ...row, observed_at: javascriptInstant(row.observed_at) }));
}

async function portfolio(): Promise<DailyRow | null> {
  const [row] = await pgRows<DailyRow>(`${DAILY_SQL} WHERE asset_id IS NULL AND day = $1::date`, [TODAY]);
  return row ? { ...row, observed_at: javascriptInstant(row.observed_at) } : null;
}

describe('the nightly alert rollup', () => {
  it('counts tonight per asset and once for the portfolio', async () => {
    await flag({ asset: 'meadow.example', severity: 'error' });
    await flag({ asset: 'meadow.example', severity: 'warn' });
    await flag({ asset: 'northwind.example', severity: 'error' });

    const outcome = await rollUpAlertDay(env, NOW_MS);

    expect(outcome).toEqual({ assets: 2, pruned: 0 });
    const stored = await rows();
    // Two assets plus the portfolio row.
    expect(stored.map((row) => row.asset)).toEqual(['*', 'meadow.example', 'northwind.example']);
    expect(await portfolio()).toMatchObject({ open: 3, errors: 2, warnings: 1 });
  });

  it('counts open the way the Tower counts open, disposition and all', async () => {
    // Resolved: closed. Acked: closed. Tuned: still open — tuning the detector
    // is not answering the firing. A lapsed snooze: open again.
    await flag({ resolvedAt: '2026-09-05T01:00:00.000Z' });
    await flag({ disposition: 'ack' });
    await flag({ disposition: 'tune' });
    await flag({ disposition: 'snooze', snoozeUntil: '2026-09-01T00:00:00.000Z' });
    // A snooze with time still on the clock is not open.
    await flag({ disposition: 'snooze', snoozeUntil: '2026-12-01T00:00:00.000Z' });

    await rollUpAlertDay(env, NOW_MS);

    expect(await portfolio()).toMatchObject({ open: 2 });
  });

  it('writes a portfolio row on a night with nothing open at all', async () => {
    const outcome = await rollUpAlertDay(env, NOW_MS);

    // The calm night IS a measurement, and it is what a flat line is made of.
    expect(outcome).toEqual({ assets: 0, pruned: 0 });
    expect(await portfolio()).toMatchObject({ open: 0, errors: 0, warnings: 0 });
    // …but the median of an empty set is not zero.
    expect((await portfolio())?.median_open_age_hours).toBeNull();
  });

  it('measures the portfolio median over the whole set, not over the assets', async () => {
    // Three on one property and one on another. The median of all four ages is
    // 3h; the median of the two per-asset medians would be 3.5h — which is why
    // the portfolio is observed rather than summed.
    const at = (hoursAgo: number) => new Date(NOW_MS - hoursAgo * 3_600_000).toISOString();
    await flag({ asset: 'meadow.example', firedAt: at(1) });
    await flag({ asset: 'meadow.example', firedAt: at(2) });
    await flag({ asset: 'meadow.example', firedAt: at(4) });
    await flag({ asset: 'northwind.example', firedAt: at(6) });

    await rollUpAlertDay(env, NOW_MS);

    expect((await portfolio())?.median_open_age_hours).toBeCloseTo(3, 6);
  });

  it('keeps the latest observation of a day rather than appending to it', async () => {
    await flag({});
    await rollUpAlertDay(env, NOW_MS);
    await flag({});
    await rollUpAlertDay(env, NOW_MS + 3_600_000);

    const stored = await rows();
    expect(stored.filter((row) => row.asset === ALERT_DAILY_PORTFOLIO)).toHaveLength(1);
    expect(await portfolio()).toMatchObject({ open: 2 });
  });

  it('refuses to walk a day backwards on an out-of-order observation', async () => {
    await flag({});
    await flag({});
    await rollUpAlertDay(env, NOW_MS + 3_600_000);
    await emptyTables(['flag_evidence', 'flag_tunes', 'flags']);
    await rollUpAlertDay(env, NOW_MS);

    expect(await portfolio()).toMatchObject({ open: 2 });
  });

  it('drops a day older than the retention window', async () => {
    await env.STORE.write((tx) =>
      tx.execute(
        `INSERT INTO noticeos.alert_daily_counts (workspace_id, asset_id, day, observed_at, open, errors, warnings)
         VALUES ($1, 'meadow.example', '2020-01-01', '2020-01-01T03:00:00.000Z', 4, 4, 0)`,
        [tx.workspaceId],
      ),
    );

    const outcome = await rollUpAlertDay(env, NOW_MS);

    expect(outcome).toMatchObject({ pruned: 1 });
    expect((await rows()).map((row) => row.day)).not.toContain('2020-01-01');
    expect(ALERT_DAILY_RETENTION_DAYS).toBe(400);
  });
});

describe('the median of a set of ages', () => {
  it('is the midpoint on an even set, not a member of it', () => {
    expect(medianHours([1, 2, 3, 4])).toBe(2.5);
    expect(medianHours([2, 1])).toBe(1.5);
  });

  it('is the middle member on an odd set, however the set arrived', () => {
    expect(medianHours([9, 1, 5])).toBe(5);
  });

  it('is null on an empty set, because the median of nothing is not zero', () => {
    expect(medianHours([])).toBeNull();
  });
});
