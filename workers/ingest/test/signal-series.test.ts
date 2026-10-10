// What "unchanged" means to the change-only signal store.
//
// `recordSignalSuccess` stores a value only when it differs from the stored
// one. The contract pinned here: a series is asset + integration +
// property_ref + metric, measured under one reporting-day definition
// (time_zone, NULL matching only NULL). credential_ref is not part of it, so
// an asset repointed at a different provider property starts a new series even
// where a value happens to equal the old property's.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  recordSignalSuccess,
  type SignalDateWindow,
  type SignalTarget,
} from '../src/signal-store.js';
import { aggregateMetric } from '../src/watch-windows.js';
import { reset, storedCount } from './helpers.js';

beforeEach(reset);

const WINDOW: SignalDateWindow = { start: '2026-09-01', end: '2026-09-03' };

function target(overrides: Partial<SignalTarget> = {}): SignalTarget {
  return {
    asset: 'meals.example',
    integration: 'ga4',
    credentialRef: 'account-a',
    propertyRef: 'properties/111',
    ...overrides,
  };
}

/** One successful run of daily values (`sessions`, or the metric named: Bing
 * reports no sessions); returns the new run's id. */
async function record(
  values: Record<string, number>,
  {
    to = target(),
    timeZone = 'America/New_York',
    metric = 'sessions',
  }: { to?: SignalTarget; timeZone?: string | null; metric?: string } = {},
): Promise<string> {
  await recordSignalSuccess(env, to, WINDOW, new Date().toISOString(), {
    providerRows: Object.keys(values).length,
    observations: Object.entries(values).map(([date, value]) => ({
      date,
      metric,
      value,
    })),
    dataState: 'final',
    provisionalFrom: null,
    ...(timeZone === null ? {} : { timeZone }),
  });
  const [run] = await env.STORE.read((tx) =>
    tx.query<{ id: string }>(`SELECT run_id AS id FROM noticeos.signal_runs ORDER BY finished_at DESC, run_seq DESC LIMIT 1`),
  );
  return run!.id;
}

/** What one run wrote, keyed by date. */
async function written(runId: string): Promise<Record<string, number>> {
  const rows = await env.STORE.read((tx) =>
    tx.query<{ date: string; value: number }>(
      `SELECT o.observed_date AS date, o.value
         FROM noticeos.signal_observations o
         JOIN noticeos.signal_runs r ON r.workspace_id = o.workspace_id AND r.run_seq = o.run_seq
        WHERE r.run_id = $1
        ORDER BY o.observed_date`,
      [runId],
    ),
  );
  return Object.fromEntries(rows.map((row) => [row.date, row.value]));
}

async function observationCount(runId: string): Promise<number> {
  return storedCount(`SELECT observation_count AS n FROM noticeos.signal_runs WHERE run_id = $1`, [runId]);
}

describe('recordSignalSuccess — one series per provider resource and day definition', () => {
  it('records a switched-to property in full, even where its value equals the old one', async () => {
    await record({ '2026-09-01': 25, '2026-09-02': 30 });

    const switched = await record(
      { '2026-09-01': 25, '2026-09-02': 31 },
      { to: target({ propertyRef: 'properties/222' }) },
    );

    // 25 = 25 is still the NEW property's measurement, and must say so.
    expect(await written(switched)).toEqual({ '2026-09-01': 25, '2026-09-02': 31 });
    expect(await observationCount(switched)).toBe(2);
  });

  it('continues the series across a credential rotation on the same property', async () => {
    await record({ '2026-09-01': 25, '2026-09-02': 30 });

    const rotated = await record(
      { '2026-09-01': 25, '2026-09-02': 30 },
      { to: target({ credentialRef: 'account-b' }) },
    );

    // A new key reading the same resource measured nothing new.
    expect(await written(rotated)).toEqual({});
    expect(await observationCount(rotated)).toBe(0);
  });

  it('records a reporting-timezone change on the same property under the new zone', async () => {
    await record({ '2026-09-01': 25 }, { timeZone: 'America/Los_Angeles' });

    const moved = await record({ '2026-09-01': 25, '2026-09-02': 30 });
    // Bucketed by a different midnight, so a different unit — even at 25.
    expect(await written(moved)).toEqual({ '2026-09-01': 25, '2026-09-02': 30 });

    // …and the new zone is then a series of its own that change-only applies to.
    const again = await record({ '2026-09-01': 25, '2026-09-02': 30 });
    expect(await written(again)).toEqual({});
  });

  it('matches a provider that states no zone only against runs that stated none', async () => {
    // Bing reports no timezone (NULL). `=` would never match NULL and re-record
    // the whole window every run; `IS` keeps the series change-only.
    const bing = target({ integration: 'bing-webmaster', propertyRef: 'https://meals.example/' });
    await record({ '2026-09-01': 25 }, { to: bing, timeZone: null, metric: 'clicks' });
    const unchanged = await record({ '2026-09-01': 25 }, { to: bing, timeZone: null, metric: 'clicks' });
    expect(await written(unchanged)).toEqual({});

    // A run that DID state a zone is a different day definition from "unknown".
    const stated = await record({ '2026-09-01': 25 }, { to: bing, timeZone: 'America/Los_Angeles', metric: 'clicks' });
    expect(await written(stated)).toEqual({ '2026-09-01': 25 });
  });

  it('compares a provider revision against the latest value in the series', async () => {
    await record({ '2026-09-01': 25 });
    const revised = await record({ '2026-09-01': 27 });
    expect(await written(revised)).toEqual({ '2026-09-01': 27 });

    // Back to the ORIGINAL figure: unchanged against the first run, but a
    // revision against the latest one, so it is recorded.
    const reverted = await record({ '2026-09-01': 25 });
    expect(await written(reverted)).toEqual({ '2026-09-01': 25 });

    const aggregate = await aggregateMetric(
      env.STORE, 'meals.example', 'ga4', 'sessions', '2026-09-01', '2026-09-01',
    );
    expect(aggregate).toMatchObject({ days: 1, total: 25, properties: ['properties/111'] });
  });

  it('leaves a missing date missing — never written, never filled', async () => {
    const first = await record({ '2026-09-01': 25, '2026-09-03': 30 });
    expect(await written(first)).toEqual({ '2026-09-01': 25, '2026-09-03': 30 });

    // The provider omits 09-03 this time: that is not a zero and not a deletion.
    const second = await record({ '2026-09-01': 25 });
    expect(await written(second)).toEqual({});

    const stored = await storedCount(
      `SELECT count(*)::int AS n FROM noticeos.signal_observations WHERE observed_date = '2026-09-02'`,
    );
    expect(stored).toBe(0);

    const aggregate = await aggregateMetric(
      env.STORE, 'meals.example', 'ga4', 'sessions', WINDOW.start, WINDOW.end,
    );
    expect(aggregate).toMatchObject({ days: 2, span_days: 3, total: 55 });
  });

  it('stores zero as a value and aggregates it as zero', async () => {
    const first = await record({ '2026-09-01': 0, '2026-09-02': 0, '2026-09-03': 0 });
    expect(await written(first)).toEqual({ '2026-09-01': 0, '2026-09-02': 0, '2026-09-03': 0 });

    // An unchanged zero is unchanged…
    const unchanged = await record({ '2026-09-01': 0 });
    expect(await written(unchanged)).toEqual({});

    // …and a new property's zero is still that property's measurement.
    const switched = await record(
      { '2026-09-01': 0 },
      { to: target({ propertyRef: 'properties/222' }) },
    );
    expect(await written(switched)).toEqual({ '2026-09-01': 0 });

    const aggregate = await aggregateMetric(
      env.STORE, 'meals.example', 'ga4', 'sessions', '2026-09-02', WINDOW.end,
    );
    expect(aggregate).toMatchObject({ days: 2, span_days: 2, total: 0, per_day: 0 });
  });

  // On Postgres the series is a row of its own, named once by the values that
  // first need it.
  it('names one series per site, provider, property, zone and metric; a rotated credential keeps it', async () => {
    await record({ '2026-09-01': 25 });
    await record({ '2026-09-01': 26 }, { to: target({ credentialRef: 'account-b' }) });
    await record({ '2026-09-01': 25 }, { to: target({ propertyRef: 'properties/222' }) });
    await record({ '2026-09-01': 25 }, { timeZone: 'America/Los_Angeles' });
    const series = await env.STORE.read((tx) =>
      tx.query<{ property_ref: string; time_zone: string | null; metric: string }>(
        `SELECT property_ref, time_zone, metric FROM noticeos.measurement_series ORDER BY series_id`,
      ),
    );
    expect(series).toEqual([
      { property_ref: 'properties/111', time_zone: 'America/New_York', metric: 'sessions' },
      { property_ref: 'properties/222', time_zone: 'America/New_York', metric: 'sessions' },
      { property_ref: 'properties/111', time_zone: 'America/Los_Angeles', metric: 'sessions' },
    ]);
  });
});
