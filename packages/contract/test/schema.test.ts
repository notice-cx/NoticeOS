import { describe, expect, it } from 'vitest';
import {
  Annotation,
  InTransitFlag,
  LedgerInputRow,
  PulseEnvelope,
  amountToMinorUnits,
  deriveExternalId,
} from '../src/schema.js';

const validEnvelope = {
  asset: 'meadow.example',
  generatedAt: '2026-07-05T03:00:00.000Z',
  capabilities: ['signups', 'plansSaved', 'foodLog'],
  metrics: {
    signups: { last24h: 12, avg7d: 9.3, total: 4210 },
    plansSaved: { last24h: 0, avg7d: 6.2, total: 1880 },
  },
  negativeByPage: [{ page: '/calculator', count: 3 }],
  flags: [
    { severity: 'warn', kind: 'anomaly', metric: 'plansSaved', msg: '0 in last24h' },
  ],
};

describe('PulseEnvelope', () => {
  it('parses a well-formed envelope', () => {
    const parsed = PulseEnvelope.safeParse(validEnvelope);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.asset).toBe('meadow.example');
      expect(parsed.data.metrics.plansSaved?.avg7d).toBe(6.2);
    }
  });

  it('accepts the minimal shape (no optional negativeByPage/flags)', () => {
    const parsed = PulseEnvelope.safeParse({
      asset: 'northwind.example',
      generatedAt: '2026-07-05T03:00:00Z',
      capabilities: ['items'],
      metrics: { items: { last24h: 5, avg7d: 4.0, total: 900 } },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a missing generatedAt', () => {
    const { generatedAt: _omit, ...rest } = validEnvelope;
    expect(PulseEnvelope.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-ISO generatedAt', () => {
    expect(
      PulseEnvelope.safeParse({ ...validEnvelope, generatedAt: '2026-07-05' }).success,
    ).toBe(false);
  });

  it('rejects negative and non-integer counts', () => {
    expect(
      PulseEnvelope.safeParse({
        ...validEnvelope,
        metrics: { signups: { last24h: -1, avg7d: 1, total: 1 } },
      }).success,
    ).toBe(false);
    expect(
      PulseEnvelope.safeParse({
        ...validEnvelope,
        metrics: { signups: { last24h: 1.5, avg7d: 1, total: 1 } },
      }).success,
    ).toBe(false);
  });

  it('rejects an empty asset id', () => {
    expect(PulseEnvelope.safeParse({ ...validEnvelope, asset: '' }).success).toBe(false);
  });
});

describe('InTransitFlag milestone-is-info invariant', () => {
  it('accepts anomaly/error and milestone/info', () => {
    expect(InTransitFlag.safeParse({ severity: 'error', kind: 'anomaly' }).success).toBe(true);
    expect(
      InTransitFlag.safeParse({ severity: 'info', kind: 'milestone', msg: '10k signups' }).success,
    ).toBe(true);
  });

  it('rejects a milestone flag that is not info-severity', () => {
    expect(InTransitFlag.safeParse({ severity: 'warn', kind: 'milestone' }).success).toBe(false);
    expect(InTransitFlag.safeParse({ severity: 'error', kind: 'milestone' }).success).toBe(false);
  });
});

describe('Annotation', () => {
  it('parses a deploy annotation', () => {
    const parsed = Annotation.safeParse({
      asset: 'meadow.example',
      at: '2026-07-04T12:00:00Z',
      kind: 'deploy',
      ref: 'abc1234',
      note: 'ship recipe cards',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown annotation kind', () => {
    expect(
      Annotation.safeParse({ asset: 'x', at: '2026-07-04T12:00:00Z', kind: 'launch' }).success,
    ).toBe(false);
  });
});

describe('LedgerInputRow (CHECK-constraint mirror)', () => {
  it('accepts revenue/ads and cost/inference', () => {
    expect(
      LedgerInputRow.safeParse({
        kind: 'revenue',
        asset: 'meadow.example',
        period: '2026-06',
        family: 'ads',
        amount: '412.50',
        source: 'raptive-report',
        booking_state: 'reconciled',
      }).success,
    ).toBe(true);
    expect(
      LedgerInputRow.safeParse({
        kind: 'cost',
        asset: 'root-os',
        period: '2026-06',
        family: 'inference',
        amount: 18.2,
        ref: 'os-overhead',
        booking_state: 'estimated',
      }).success,
    ).toBe(true);
  });

  it('coerces a CSV string amount to a number', () => {
    const parsed = LedgerInputRow.safeParse({
      kind: 'revenue',
      asset: 'northwind.example',
      period: '2026-06',
      family: 'affiliate',
      amount: '37.00',
      booking_state: 'estimated',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.amount).toBe(37);
  });

  it('rejects a family that does not belong to the kind', () => {
    // inference is a cost family, not a revenue family
    expect(
      LedgerInputRow.safeParse({
        kind: 'revenue',
        asset: 'x',
        period: '2026-06',
        family: 'inference',
        amount: 1,
        booking_state: 'estimated',
      }).success,
    ).toBe(false);
    // ads is a revenue family, not a cost family
    expect(
      LedgerInputRow.safeParse({
        kind: 'cost',
        asset: 'x',
        period: '2026-06',
        family: 'ads',
        amount: 1,
        booking_state: 'estimated',
      }).success,
    ).toBe(false);
  });

  it('rejects malformed periods and non-numeric amounts', () => {
    const base = {
      kind: 'revenue' as const,
      asset: 'x',
      family: 'ads',
      booking_state: 'estimated' as const,
    };
    expect(LedgerInputRow.safeParse({ ...base, period: '2026-13', amount: 1 }).success).toBe(false);
    expect(LedgerInputRow.safeParse({ ...base, period: '2026-6', amount: 1 }).success).toBe(false);
    expect(LedgerInputRow.safeParse({ ...base, period: '2026-06', amount: 'abc' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown booking_state', () => {
    expect(
      LedgerInputRow.safeParse({
        kind: 'revenue',
        asset: 'x',
        period: '2026-06',
        family: 'ads',
        amount: 1,
        booking_state: 'projected',
      }).success,
    ).toBe(false);
  });
});

describe('amountToMinorUnits (money is exact or it is not money)', () => {
  it('converts through the decimal string, not the float product', () => {
    // 168.2 * 100 is 16820.000000000002 in binary floating point. A ledger that
    // rounds that away by luck is a ledger whose sum cannot be proven.
    expect(amountToMinorUnits(168.2)).toBe(16820);
    expect(amountToMinorUnits(412.5)).toBe(41250);
    expect(amountToMinorUnits(0.07)).toBe(7);
    expect(amountToMinorUnits(1.1 + 2.2)).toBe(330);
  });

  it('keeps whole dollars, zero, and negatives exact', () => {
    expect(amountToMinorUnits(0)).toBe(0);
    expect(amountToMinorUnits(560)).toBe(56000);
    expect(amountToMinorUnits(-61.3)).toBe(-6130);
  });

  it('rounds a third decimal half away from zero, never toward it', () => {
    // Truncating a provider that reports mills would bias every total downward.
    expect(amountToMinorUnits(1.005)).toBe(101);
    expect(amountToMinorUnits(1.004)).toBe(100);
    expect(amountToMinorUnits(-1.005)).toBe(-101);
  });

  it('sums cents exactly where summing dollars does not', () => {
    // Four real figures from the dev ledger fixture. Their float sum is
    // 758.1999999999999 — the defect doc 19 named, on the store's own numbers.
    const dollars = [512.4, 168.2, 55.5, 22.1];
    expect(dollars.reduce((s, d) => s + d, 0)).not.toBe(758.2);
    expect(dollars.reduce((s, d) => s + amountToMinorUnits(d), 0)).toBe(75820);
  });
});

describe('deriveExternalId (the idempotency key)', () => {
  const row = {
    kind: 'revenue',
    asset: 'meadow.example',
    period: '2026-06',
    family: 'ads',
    booking_state: 'estimated',
    source: 'raptive-report',
  };

  it("namespaces a source's own id by that source", () => {
    expect(deriveExternalId({ ...row, external_id: 'INV-4471' })).toBe(
      'raptive-report:INV-4471',
    );
    // The same provider id issued by a different source is a different row.
    expect(deriveExternalId({ ...row, source: 'cj-export', external_id: 'INV-4471' })).toBe(
      'cj-export:INV-4471',
    );
  });

  it('falls back to the accounting grain, so a re-uploaded export keys the same', () => {
    expect(deriveExternalId(row)).toBe(
      'raptive-report:auto/revenue/meadow.example/2026-06/ads/estimated',
    );
    expect(deriveExternalId({ ...row })).toBe(deriveExternalId(row));
  });

  it('separates an estimate from the row that reconciles it', () => {
    expect(deriveExternalId({ ...row, booking_state: 'reconciled' })).not.toBe(
      deriveExternalId(row),
    );
  });

  it('names the cost tag when a row has no source', () => {
    expect(
      deriveExternalId({
        kind: 'cost',
        asset: 'root-os',
        period: '2026-06',
        family: 'inference',
        booking_state: 'estimated',
        ref: 'os-overhead',
      }),
    ).toBe('os-overhead:auto/cost/root-os/2026-06/inference/estimated');
  });
});

describe('LedgerInputRow — the idempotency fields', () => {
  const base = {
    kind: 'revenue' as const,
    asset: 'meadow.example',
    period: '2026-06',
    family: 'ads',
    source: 'raptive-report',
    booking_state: 'estimated' as const,
  };

  it('carries exact cents and a stable id beside the major-unit amount', () => {
    const parsed = LedgerInputRow.safeParse({ ...base, amount: '168.20' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.amount).toBe(168.2);
    expect(parsed.data.amount_minor).toBe(16820);
    expect(parsed.data.stable_id).toBe(
      'raptive-report:auto/revenue/meadow.example/2026-06/ads/estimated',
    );
  });

  it('rejects a figure too large to hold exactly in cents', () => {
    expect(LedgerInputRow.safeParse({ ...base, amount: 1e17 }).success).toBe(false);
  });

  it('lets only a reconciled row supersede another', () => {
    expect(
      LedgerInputRow.safeParse({
        ...base,
        amount: 1,
        supersedes_external_id: 'raptive-report:auto/revenue/meadow.example/2026-06/ads/estimated',
      }).success,
    ).toBe(false);
    expect(
      LedgerInputRow.safeParse({
        ...base,
        amount: 1,
        booking_state: 'reconciled',
        supersedes_external_id: 'raptive-report:auto/revenue/meadow.example/2026-06/ads/estimated',
      }).success,
    ).toBe(true);
  });
});


describe('LedgerInputRow — structured coverage', () => {
  const row = { kind: 'revenue', asset: 'meadow.example', period: '2026-06', family: 'ads', amount: 9, booking_state: 'estimated' };

  it('retains optional unknown dates and literal CSV completeness without changing the stable key', () => {
    const legacy = LedgerInputRow.parse(row);
    const partial = LedgerInputRow.parse({ ...row, coverage_start: '2026-06-01', coverage_end: '2026-06-07', coverage_complete: 'false' });
    expect(partial).toMatchObject({ coverage_start: '2026-06-01', coverage_end: '2026-06-07', coverage_complete: false, stable_id: legacy.stable_id });
    expect(LedgerInputRow.parse({ ...row, coverage_complete: 'true' }).coverage_complete).toBe(true);
    expect(LedgerInputRow.parse({ ...row, coverage_start: null, coverage_end: null, coverage_complete: null })).toMatchObject({ coverage_start: null, coverage_end: null, coverage_complete: null });
    expect(legacy.coverage_end).toBeUndefined();
  });

  it('rejects impossible dates, reversed dates and nonliteral completeness', () => {
    for (const fields of [
      { coverage_start: '2026-02-29' }, { coverage_end: '2026-04-31' },
      { coverage_end: '2026-6-01' }, { coverage_end: '2026-06-01T00:00:00Z' },
      { coverage_start: '2026-06-08', coverage_end: '2026-06-07' },
      { coverage_complete: 'no' }, { coverage_complete: 0 },
    ]) expect(LedgerInputRow.safeParse({ ...row, ...fields }).success, JSON.stringify(fields)).toBe(false);
    // Coverage dates are not constrained to the accounting period by the store.
    expect(LedgerInputRow.safeParse({ ...row, coverage_start: '2024-02-29', coverage_end: '2026-06-07' }).success).toBe(true);
  });
});


describe('LedgerInputRow — stated currency', () => {
  const row = { kind: 'revenue', asset: 'meadow.example', period: '2026-06', family: 'ads', amount: '12.345', booking_state: 'estimated' };
  it('keeps old USD exports and uses each stated currency precision', () => {
    expect(LedgerInputRow.parse(row)).toMatchObject({ currency: 'USD', amount_minor: 1235 });
    expect(LedgerInputRow.parse({ ...row, currency: 'EUR' })).toMatchObject({ currency: 'EUR', amount_minor: 1235 });
    expect(LedgerInputRow.parse({ ...row, currency: 'JPY' })).toMatchObject({ currency: 'JPY', amount_minor: 12 });
    expect(LedgerInputRow.parse({ ...row, currency: 'KWD' })).toMatchObject({ currency: 'KWD', amount_minor: 12345 });
  });
  it('refuses unknown, lowercase and empty codes without changing stable identity', () => {
    for (const currency of ['XYZ', 'eur', '', ' EUR ', null]) {
      expect(LedgerInputRow.safeParse({ ...row, currency }).success).toBe(false);
    }
    expect(LedgerInputRow.parse({ ...row, currency: 'EUR' }).stable_id).toBe(LedgerInputRow.parse(row).stable_id);
  });
});
