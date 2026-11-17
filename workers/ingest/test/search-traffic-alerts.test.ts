import { env } from 'cloudflare:test';
import { DEFAULT_RULE_CONFIG } from '@noticeos/contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkSearchTraffic } from '../src/search-traffic-alerts.js';
import { recordSignalSuccess, type SignalIntegration, type SignalObservation } from '../src/signal-store.js';
import { shiftUtcDay } from '../src/shared.js';
import { pgCount, pgRows, reset } from './helpers.js';

const DROP = '2026-09-21';
const NOW = Date.parse('2026-09-24T12:00:00Z');
const ASSET = 'acorn.example';
const BING_RULE = 'search-traffic-bing-webmaster-impressions';
const GOOGLE_RULE = 'search-traffic-gsc-clicks';

function typical(date: string, metric: string, weekdayCount: number): SignalObservation {
  const dayOfWeek = new Date(date).getUTCDay();
  return { date, metric, value: dayOfWeek >= 1 && dayOfWeek <= 5 ? weekdayCount : 0 };
}

function history(metric: string, weekdayCount: number): SignalObservation[] {
  return Array.from({ length: 63 }, (_, index) => typical(shiftUtcDay(DROP, index - 63), metric, weekdayCount));
}

async function save(integration: SignalIntegration, rows: SignalObservation[], provisionalFrom: string | null = null) {
  await recordSignalSuccess(env, {
    asset: ASSET, integration, credentialRef: 'synthetic', propertyRef: 'synthetic-property',
  }, { start: rows[0]!.date, end: rows.at(-1)!.date }, '2026-09-24T12:00:00Z', {
    observations: rows, providerRows: rows.length, provisionalFrom,
    dataState: provisionalFrom ? 'includes-provisional' : 'final',
  });
}

function sweep(now = NOW) {
  return checkSearchTraffic(env, DEFAULT_RULE_CONFIG, now);
}

function alerts(rule: string) {
  return pgRows<{ severity: string; kind: string; metric: string; message: string; inputs: string; resolved: string | null }>(
    `SELECT severity, kind, metric, message, rule_inputs::text AS inputs, resolved_at AS resolved
       FROM noticeos.current_flags WHERE rule_id = $1`, [rule]);
}

beforeEach(reset);

describe('search traffic alerts from stored provider counts', () => {
  it('leaves a lagged series alone, raises on reported Bing zeroes, and resolves after recovery', async () => {
    const previous = history('impressions', 5_000);
    await save('bing-webmaster', previous);
    expect(await pgCount('SELECT count(*) AS n FROM noticeos.pulses WHERE asset_id = $1', [ASSET])).toBe(0);
    expect(await sweep()).toMatchObject({ assets: 1, raised: 0 });
    expect(await alerts(BING_RULE)).toEqual([]);

    const zero = (date: string) => ({ date, metric: 'impressions', value: 0 });
    await save('bing-webmaster', [zero(DROP)]);
    expect(await sweep()).toMatchObject({ raised: 1 });
    expect(await sweep()).toMatchObject({ raised: 0 });
    const [raised] = await alerts(BING_RULE);
    expect(raised).toMatchObject({ severity: 'warn', kind: 'anomaly', metric: 'Bing impressions', resolved: null });
    expect(JSON.parse(raised!.inputs)).toMatchObject({ observationEnd: DROP, observed: 0, baselineSampleSize: 8,
      prediction: { model: 'weekday-log-predictive-v1' } });

    const nextDay = shiftUtcDay(DROP, 1);
    await save('bing-webmaster', [zero(nextDay), zero(shiftUtcDay(DROP, 2))]);
    expect(await sweep(NOW + 60_000)).toMatchObject({ raised: 0, resolved: 0 });
    await sweep(NOW + 120_000);
    const [updated] = await alerts(BING_RULE);
    expect(JSON.parse(updated!.inputs).observationEnd).toBe(shiftUtcDay(DROP, 2));
    expect(await pgCount('SELECT count(*) AS n FROM noticeos.flag_evidence')).toBe(1);

    const recovered = Array.from({ length: 7 }, (_, index) => typical(shiftUtcDay(DROP, index + 3), 'impressions', 5_000));
    await save('bing-webmaster', recovered);
    expect(await sweep(Date.parse('2026-10-01T12:00:00Z'))).toMatchObject({ raised: 0, resolved: 1 });
    expect((await alerts(BING_RULE))[0]?.resolved).toBeTruthy();
  });

  it('skips provisional Google counts until a later run confirms the same values', async () => {
    const zero = { date: DROP, metric: 'clicks', value: 0 };
    await save('gsc', [...history('clicks', 200), zero], DROP);
    expect(await sweep()).toMatchObject({ raised: 0 });
    expect(await alerts(GOOGLE_RULE)).toEqual([]);

    await save('gsc', [zero]);
    expect(await sweep(NOW + 60_000)).toMatchObject({ raised: 1 });
    const [raised] = await alerts(GOOGLE_RULE);
    expect(raised).toMatchObject({ severity: 'warn', kind: 'anomaly', metric: 'Google Search Console clicks' });
    expect(JSON.parse(raised!.inputs)).toMatchObject({ observationEnd: DROP, observed: 0 });
    expect(await pgCount("SELECT count(*) AS n FROM noticeos.signal_observations WHERE observed_date = $1::date", [DROP])).toBe(1);
  });
});
