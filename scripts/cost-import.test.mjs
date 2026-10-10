import assert from 'node:assert/strict';
import test from 'node:test';
import { domainCostsFor, monthsBetween, recurringFor } from './cost-import.mjs';

const CONFIG = {
  costs: [
    { id: 'claude-code', label: 'Claude Code', asset: 'root-os', family: 'inference',
      amountUsdPerMonth: 200, from: '2026-06', note: 'portfolio overhead' },
    { id: 'old-host', label: 'Old host', asset: 'root-os', family: 'infra',
      amountUsdPerMonth: 12, from: '2026-01', to: '2026-05', note: 'retired' },
  ],
};

test('walks an inclusive month range across a year boundary', () => {
  assert.deepEqual(monthsBetween('2026-11', '2027-02'),
    ['2026-11', '2026-12', '2027-01', '2027-02']);
  assert.deepEqual(monthsBetween('2026-08', '2026-08'), ['2026-08']);
});

test('returns nothing when the range runs backwards', () => {
  // A reversed range must not silently book a year of costs in the wrong
  // direction; an empty result is the honest answer to an impossible span.
  assert.deepEqual(monthsBetween('2026-08', '2026-06'), []);
});

test('rejects a malformed month rather than guessing', () => {
  assert.throws(() => monthsBetween('2026-8', '2026-09'), /YYYY-MM/);
  assert.throws(() => monthsBetween('August', '2026-09'), /YYYY-MM/);
});

test('books an entry only in the months it was in force', () => {
  assert.deepEqual(recurringFor(CONFIG, '2026-05').map((r) => r.source), ['recurring:old-host']);
  assert.deepEqual(recurringFor(CONFIG, '2026-06').map((r) => r.source), ['recurring:claude-code']);
  // Before anything started: no rows, not zero-value rows. A $0 cost would
  // assert the subscription existed and cost nothing.
  assert.deepEqual(recurringFor(CONFIG, '2025-12'), []);
});

test('carries the config id into the idempotency source, and books estimated', () => {
  const [row] = recurringFor(CONFIG, '2026-06');
  assert.equal(row.source, 'recurring:claude-code');
  assert.equal(row.asset, 'root-os');
  assert.equal(row.family, 'inference');
  assert.equal(row.amount, 200);
  // A standing charge is not a reconciled invoice. Calling it reconciled would
  // erase the figure a real statement is later measured against.
  assert.equal(row.booking_state, 'estimated');
});

test('sums every domain a property carries into one rounded row per month', () => {
  const domains = {
    domains: [
      { domain: 'b.example.com', asset: 'site-a', paidOn: '2026-03-14', paidUsd: 15 },
      { domain: 'a.example.com', asset: 'site-a', paidOn: '2025-11-02', paidUsd: 10 },
      { domain: 'c.example.net', asset: 'site-b', paidOn: '2026-03-01', paidUsd: 0.05 },
    ],
  };
  // 10/12 + 15/12 = 2.0833…, one row under the one idempotency key; site-b's
  // slice rounds to zero and books nothing.
  assert.deepEqual(domainCostsFor(domains, '2026-03'), [{
    kind: 'cost', asset: 'site-a', period: '2026-03', family: 'infra', amount: 2.08,
    source: 'domains', booking_state: 'estimated',
    note: '2 domain(s) amortized: a.example.com, b.example.com',
  }]);
  // The order bought in November covers through October and no further.
  assert.deepEqual(domainCostsFor(domains, '2026-10').map((r) => [r.asset, r.amount]), [['site-a', 2.08]]);
  assert.deepEqual(domainCostsFor(domains, '2026-11').map((r) => [r.asset, r.amount]), [['site-a', 1.25]]);
  assert.deepEqual(domainCostsFor(domains, '2025-10'), []);
});
