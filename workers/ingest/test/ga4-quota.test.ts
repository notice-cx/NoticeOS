import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { quotaPressure, recordGa4Quota } from '../src/ga4-quota.js';
import { pgRows, reset } from './helpers.js';

beforeEach(reset);
const at = '2026-07-29T12:00:00Z';
const bucket = (remaining: number | null, consumed: number | null = 10) => ({ remaining, consumed });
const input = { asset: 'meadow.example', propertyRef: '123456', at };

describe('GA4 quota reserves', () => {
  it('does not treat this request cost as cumulative daily usage or capacity', () => {
    expect(quotaPressure({ tokensPerDay: bucket(10_000), tokensPerHour: bucket(39_990) }))
      .toEqual([{ bucket: 'tokensPerDay', consumed: 10, remaining: 10_000, threshold: 40_000 }]);
    expect(quotaPressure({ tokensPerDay: bucket(1_900_000), tokensPerHour: null })).toEqual([]);
    expect(quotaPressure({ tokensPerDay: bucket(10_000, null), tokensPerHour: null })).toHaveLength(1);
    expect(quotaPressure({ tokensPerDay: bucket(null), tokensPerHour: null })).toEqual([]);
  });

  it('keeps Core and Realtime alerts independent, including their recoveries', async () => {
    const quota = { tokensPerDay: bucket(10_000), tokensPerHour: null };
    await recordGa4Quota(env, { ...input, lane: 'google-signals', quota });
    await recordGa4Quota(env, { ...input, lane: 'ga4-realtime', quota });
    const active = () => pgRows<{ rule_id: string }>("SELECT rule_id FROM noticeos.current_flags WHERE resolved_at IS NULL ORDER BY rule_id");
    expect((await active()).map(row => row.rule_id)).toEqual(['ga4-quota-pressure', 'ga4-realtime-quota-pressure']);
    await recordGa4Quota(env, { ...input, lane: 'ga4-realtime', quota: { tokensPerDay: bucket(199_000), tokensPerHour: null } });
    expect((await active()).map(row => row.rule_id)).toEqual(['ga4-quota-pressure']);
  });

  it('does not infer a daily refill when only the hourly bucket was measured', async () => {
    await recordGa4Quota(env, { ...input, lane: 'google-signals', quota: { tokensPerDay: bucket(10_000), tokensPerHour: null } });
    const partial = await recordGa4Quota(env, { ...input, lane: 'google-signals', quota: { tokensPerDay: null, tokensPerHour: bucket(39_990) } });
    expect(partial.resolved).toBe(0);
    const missing = await recordGa4Quota(env, { ...input, lane: 'google-signals', quota: { tokensPerDay: bucket(null), tokensPerHour: bucket(39_990) } });
    expect(missing.resolved).toBe(0);
    const refilled = await recordGa4Quota(env, { ...input, lane: 'google-signals', quota: { tokensPerDay: bucket(199_000), tokensPerHour: null } });
    expect(refilled.resolved).toBe(1);
  });
  it('keeps Funnel quota and recovery separate from Core', async () => {
    const quota = { tokensPerDay: bucket(10_000), tokensPerHour: null };
    await recordGa4Quota(env, { ...input, lane: 'google-signals', quota });
    await recordGa4Quota(env, { ...input, lane: 'ga4-journeys', quota });
    const funnel = await pgRows<{ pool: string }>("SELECT rule_inputs->>'pool' AS pool FROM noticeos.current_flags WHERE rule_id = 'ga4-funnel-quota-pressure' AND resolved_at IS NULL");
    expect(funnel).toHaveLength(1);
    expect(funnel[0]!.pool).toBe('funnel');
    await recordGa4Quota(env, { ...input, lane: 'ga4-journeys', quota: { tokensPerDay: bucket(199_000), tokensPerHour: null } });
    const active = await pgRows<{ rule_id: string }>("SELECT rule_id FROM noticeos.current_flags WHERE resolved_at IS NULL ORDER BY rule_id");
    expect(active.map((row) => row.rule_id)).toEqual(['ga4-quota-pressure']);
  });
});
