// The alert-rule replay: how often would this rule have fired in the last 30
// days with these settings?
//
// The whole value of the answer is that it is PRODUCED, not estimated — the real
// `evaluatePulse` over the real stored pulses against the same four-matching-
// weekday baseline the nightly lane uses. So these tests seed actual `pulses`
// rows and assert the count MOVES with the settings in the direction the
// detector's own mathematics says it must, rather than asserting a fixture.
//
// The fixture is deliberately flat — every day 10 signups — so the baseline for
// every judged day is exactly 10 and each anomalous day's Poisson tail is a
// number that can be reasoned about by hand:
//   0 of an expected 10  →  P(X<=0) = e^-10   ≈ 4.54e-5
//   4 of an expected 10  →  P(X<=4)          ≈ 2.93e-2

import { createExecutionContext, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RuleBacktest, RuleBacktestInput, RuleConfig } from '@noticeos/contract';
import IngestWorker from '../src/index.js';
import { insertFlag, pgCount, reset } from './helpers.js';

const ASSET = 'meals.example';
const QUIET_ASSET = 'nosh.example';
const METRIC = 'signups';
const RULE = 'flow-poisson-low';
/** The replay's last day — a fixed date, so the fixture never drifts under it. */
const THROUGH = '2026-07-05';
/** Deep enough that every day of the window has its four matching weekdays. */
const FIRST_SEEDED = '2026-05-01';

const DEFAULTS: RuleConfig = {
  alpha: 0.01,
  minBaselinePerDay: 3,
  lowVolumeWindowHours: 72,
};

/** Days that break the flat 10/day fixture, and what the asset reported instead. */
const DIPS: Record<string, number> = {
  '2026-07-01': 0,
  '2026-07-02': 0,
  '2026-07-03': 0,
  '2026-07-04': 4,
  '2026-07-05': 4,
};

function worker(): IngestWorker {
  return new IngestWorker(createExecutionContext(), env);
}

function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function envelope(asset: string, date: string, last24h: number) {
  return {
    asset,
    generatedAt: `${date}T03:00:00.000Z`,
    capabilities: [METRIC, 'plansSaved'],
    metrics: {
      // `avg7d` is deliberately WRONG here (a flat 9.3 the asset supplied). The
      // lane never reads it once a historical cohort exists, and neither may the
      // replay — if a preview ever fell back to it, these counts would move.
      [METRIC]: { last24h, avg7d: 9.3, total: 4210 },
      plansSaved: { last24h: 6, avg7d: 6, total: 1880 },
    },
  };
}

/** Seed the `pulses` rows directly: this is a READ path, and driving 66 days
 * through `POST /api/pulse` would also write the flags the replay must be shown
 * not to depend on. */
async function seedPulses(asset: string, first: string, last: string): Promise<void> {
  const days: { date: string; at: string; capabilities: string[]; envelope: string }[] = [];
  for (let date = first; date <= last; date = shift(date, 1)) {
    const body = envelope(asset, date, DIPS[date] ?? 10);
    days.push({ date, at: body.generatedAt, capabilities: body.capabilities, envelope: JSON.stringify(body) });
  }
  // One statement: each day's first report.
  await env.STORE.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, revision, generated_at, received_at, capabilities, envelope)
       SELECT $1::uuid, $2, (d->>'date')::date, 1, (d->>'at')::timestamptz, (d->>'at')::timestamptz,
              d->'capabilities', (d->>'envelope')::json
         FROM jsonb_array_elements($3::jsonb) AS d`,
      [tx.workspaceId, asset, JSON.stringify(days)],
    ),
  );
}

async function backtest(overrides: Partial<RuleBacktestInput> = {}): Promise<RuleBacktest> {
  const result = await worker().backtestRule({
    asset: ASSET,
    ruleId: RULE,
    metric: METRIC,
    config: DEFAULTS,
    through: THROUGH,
    ...overrides,
  });
  if (!result.ok) throw new Error(`expected a backtest, got ${result.error}`);
  return result.backtest;
}

async function flagCount(): Promise<number> {
  return pgCount(`SELECT count(*) AS n FROM noticeos.flags`);
}

describe('backtestRule — the window it answers over', () => {
  beforeEach(async () => {
    await reset();
    await seedPulses(ASSET, FIRST_SEEDED, THROUGH);
  });

  it('returns exactly thirty consecutive days ending on the day asked for', async () => {
    const result = await backtest();
    expect(result.windowDays).toBe(30);
    expect(result.days).toHaveLength(30);
    expect(result.firstDay).toBe('2026-06-06');
    expect(result.lastDay).toBe(THROUGH);
    expect(result.days[0]!.date).toBe('2026-06-06');
    expect(result.days[29]!.date).toBe(THROUGH);
    // Oldest first, one day apart, no gaps — the strip's slots.
    for (let i = 1; i < result.days.length; i++) {
      expect(result.days[i]!.date).toBe(shift(result.days[i - 1]!.date, 1));
    }
  });

  it('echoes the settings it replayed, so a stale strip cannot pass for a fresh one', async () => {
    const config = { ...DEFAULTS, alpha: 0.05 };
    const result = await backtest({ config });
    expect(result.config).toEqual(config);
  });
});

describe('backtestRule — the count moves with the settings', () => {
  beforeEach(async () => {
    await reset();
    await seedPulses(ASSET, FIRST_SEEDED, THROUGH);
  });

  it('fires on the days the shipped settings would have fired on', async () => {
    const result = await backtest();
    // The three zero-days clear alpha 0.01 (P ≈ 4.5e-5); the two 4-days do not
    // (P ≈ 0.029).
    expect(result.wouldFire).toBe(3);
    const fired = result.days.filter((day) => day.state === 'fired').map((day) => day.date);
    expect(fired).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);
    expect(result.days.find((day) => day.date === '2026-07-01')!.firings).toEqual([
      { metric: METRIC, severity: 'warn' },
    ]);
  });

  it('fires more often as the sensitivity is loosened', async () => {
    const looser = await backtest({ config: { ...DEFAULTS, alpha: 0.05 } });
    expect(looser.wouldFire).toBe(5);
    expect(
      looser.days.filter((day) => day.state === 'fired').map((day) => day.date),
    ).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
    ]);
  });

  it('goes silent as the sensitivity is tightened past the deepest dip', async () => {
    const tighter = await backtest({ config: { ...DEFAULTS, alpha: 0.000001 } });
    expect(tighter.wouldFire).toBe(0);
    // Silent is not blind: every day was still judged.
    expect(tighter.judged).toBe(30);
  });

  it('stands the rule down when the minimum daily volume rises above the baseline', async () => {
    // Baseline is 10/day; ask for 25 and this rule is out of its regime every
    // day. That is UNJUDGED, never a zero that reads as "it would never fire".
    const result = await backtest({ config: { ...DEFAULTS, minBaselinePerDay: 25 } });
    expect(result.wouldFire).toBe(0);
    expect(result.judged).toBe(0);
    expect(result.days.every((day) => day.state === 'unjudged')).toBe(true);
    expect(result.days[0]!.reason).toBe('out-of-regime');
  });
});

describe('backtestRule — what it will not claim', () => {
  beforeEach(reset);

  it('says nothing was reported rather than that nothing would have fired', async () => {
    const result = await backtest({ asset: QUIET_ASSET });
    expect(result.wouldFire).toBe(0);
    expect(result.reported).toBe(0);
    expect(result.judged).toBe(0);
    expect(result.days.every((day) => day.state === 'no-report')).toBe(true);
  });

  it('marks days with no same-weekday cohort unjudged, not quiet', async () => {
    // Ten days of history: the window's own days exist, the four weeks behind
    // them do not.
    await seedPulses(ASSET, shift(THROUGH, -9), THROUGH);
    const result = await backtest();
    expect(result.reported).toBe(10);
    expect(result.judged).toBe(0);
    const reported = result.days.filter((day) => day.state !== 'no-report');
    expect(reported).toHaveLength(10);
    expect(reported.every((day) => day.state === 'unjudged')).toBe(true);
    expect(reported[0]!.reason).toBe('no-baseline');
  });

  it('refuses a rule a pulse replay cannot honestly serve', async () => {
    const result = await worker().backtestRule({
      asset: ASSET,
      ruleId: 'ingest-freshness',
      config: DEFAULTS,
      through: THROUGH,
    });
    expect(result).toEqual({ ok: false, error: 'unsupported_rule', ruleId: 'ingest-freshness' });
  });

  it('refuses an asset the store does not have', async () => {
    const result = await worker().backtestRule({
      asset: 'not-a-property.test',
      ruleId: RULE,
      config: DEFAULTS,
      through: THROUGH,
    });
    expect(result).toEqual({
      ok: false,
      error: 'unknown_asset',
      asset: 'not-a-property.test',
    });
  });

  it('refuses settings that would break the detector', async () => {
    for (const config of [
      { ...DEFAULTS, alpha: 0 },
      { ...DEFAULTS, alpha: 1.5 },
      { ...DEFAULTS, minBaselinePerDay: -1 },
      { ...DEFAULTS, lowVolumeWindowHours: 0 },
    ]) {
      const result = await worker().backtestRule({
        asset: ASSET,
        ruleId: RULE,
        config,
        through: THROUGH,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toBe('validation');
    }
  });
});

describe('backtestRule — reality beside the replay', () => {
  beforeEach(async () => {
    await reset();
    await seedPulses(ASSET, FIRST_SEEDED, THROUGH);
    // What the detector ACTUALLY did on two of those days, one of them a day
    // the candidate settings would not fire on.
    await storedFlag('2026-07-01T03:00:00.000Z', RULE, METRIC);
    await storedFlag('2026-06-20T03:00:00.000Z', RULE, METRIC);
    // A different rule and a different metric on days inside the window: the
    // count is about THIS rule on THIS metric, not about the asset's noise.
    await storedFlag('2026-06-21T03:00:00.000Z', 'ingest-freshness', null);
    await storedFlag('2026-06-22T03:00:00.000Z', RULE, 'plansSaved');
  });

  it('counts the days this rule really fired on, scoped to the same metric', async () => {
    const result = await backtest();
    expect(result.firedInStore).toBe(2);
    expect(result.days.filter((day) => day.stored).map((day) => day.date)).toEqual([
      '2026-06-20',
      '2026-07-01',
    ]);
  });

  it('widens to the asset when no metric is named', async () => {
    const result = await backtest({ metric: null });
    expect(result.firedInStore).toBe(3);
  });

  it('writes nothing — no flag, no disposition, no config', async () => {
    const before = await flagCount();
    await backtest();
    await backtest({ config: { ...DEFAULTS, alpha: 0.05 } });
    expect(await flagCount()).toBe(before);
  });
});

function storedFlag(firedAt: string, ruleId: string, metric: string | null): Promise<number> {
  return insertFlag({ asset: ASSET, firedAt, severity: 'warn', kind: 'anomaly', metric, message: 'seeded', ruleId });
}
