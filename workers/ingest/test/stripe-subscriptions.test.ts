import { describe, expect, it } from 'vitest';
import { compareStripe, summarizeStripe } from '@noticeos/contract/stripe-report';
import { subscriptionSnapshot } from '../src/stripe-subscriptions';

function subscription(id: string, customer: string, amount: number, interval = 'month', status = 'active') {
  return { id, customer, status, discounts: [], cancel_at_period_end: false, items: { has_more: false,
    data: [{ quantity: 2, discounts: [], price: { unit_amount: amount, currency: 'usd', billing_scheme: 'per_unit',
      tax_behavior: 'exclusive', recurring: { interval, interval_count: 1, usage_type: 'licensed' } } }] } };
}

describe('subscription reporting', () => {
  it('normalizes quantities and annual plans, combines a customer’s subscriptions, and excludes trials and canceled plans', () => {
    const snapshot = subscriptionSnapshot([
      subscription('sub_monthly', 'cus_one', 1000), subscription('sub_yearly', 'cus_one', 12000, 'year'),
      subscription('sub_late', 'cus_late', 2000, 'month', 'past_due'),
      subscription('sub_trial', 'cus_trial', 9000, 'month', 'trialing'),
      subscription('sub_canceled', 'cus_gone', 5000, 'month', 'canceled'),
    ], 'USD');
    expect(summarizeStripe(snapshot, '2026-09-01T12:00:00Z')).toMatchObject({ mrrMinor: 8000, paidCustomers: 2, activeSubscriptions: 3, pastDue: 1, trials: 1 });
    expect(snapshot.customers).toHaveLength(2);
  });

  it('keeps discounts, metered/tiered prices, other currencies, and incomplete items explicitly unmeasured', () => {
    const discounted = { ...subscription('sub_discount', 'cus_one', 1000), discounts: ['di_synthetic'] };
    const metered = subscription('sub_metered', 'cus_two', 1000); metered.items.data[0]!.price.recurring.usage_type = 'metered';
    const tiered = subscription('sub_tiered', 'cus_three', 1000); tiered.items.data[0]!.price.billing_scheme = 'tiered';
    const other = subscription('sub_other', 'cus_four', 1000); other.items.data[0]!.price.currency = 'eur';
    const partial = subscription('sub_partial', 'cus_five', 1000); partial.items.has_more = true;
    const snapshot = subscriptionSnapshot([discounted, metered, tiered, other, partial], 'USD');
    expect(snapshot.unmeasuredSubscriptions).toBe(5);
    expect(summarizeStripe(snapshot, '2026-09-01')).toMatchObject({ mrrMinor: null, paidCustomers: null });
    expect(compareStripe(snapshot, snapshot, '2026-09-01', '2026-09-08')).toBeNull();
  });

  it('does not infer tax-exclusive MRR from unspecified, missing or inclusive tax behavior or manual tax rates', () => {
    for (const behavior of ['inclusive', 'unspecified', undefined]) {
      const row = subscription('sub_tax', 'cus_tax', 1000);
      const price: { tax_behavior?: string } = row.items.data[0]!.price;
      price.tax_behavior = behavior;
      expect(summarizeStripe(subscriptionSnapshot([row], 'USD'), '2026-09-01').mrrMinor).toBeNull();
    }
    const row = { ...subscription('sub_manual', 'cus_tax', 1000), default_tax_rates: ['txr_synthetic'] };
    expect(summarizeStripe(subscriptionSnapshot([row], 'USD'), '2026-09-01').mrrMinor).toBeNull();
  });

  it('distinguishes new, lost, expanded and contracted customer MRR without double-counting subscriptions', () => {
    const before = subscriptionSnapshot([subscription('s1', 'a', 1000), subscription('s2', 'b', 2000), subscription('s3', 'c', 3000)], 'USD');
    const after = subscriptionSnapshot([subscription('s1', 'a', 2000), subscription('s2', 'b', 1000), subscription('s4', 'd', 4000)], 'USD');
    expect(compareStripe(before, after, '2026-09-01', '2026-09-29')).toMatchObject({ newCustomers: 1, lostCustomers: 1,
      newMrrMinor: 8000, lostMrrMinor: 6000, expansionMinor: 2000, contractionMinor: 2000, netMrrMinor: 2000 });
    expect(compareStripe(before, after, 'a', 'b')!.customerChurnPercent).toBeCloseTo(100 / 3);
    const empty = subscriptionSnapshot([], 'USD');
    expect(summarizeStripe(empty, 'today')).toMatchObject({ mrrMinor: 0, paidCustomers: 0 });
    expect(compareStripe(empty, after, 'a', 'b')!.customerChurnPercent).toBeNull();
    expect(compareStripe(empty, { ...after, currency: 'EUR' }, 'a', 'b')).toBeNull();
  });

  it('rejects unknown statuses and duplicated subscriptions instead of inventing zero MRR', () => {
    expect(() => subscriptionSnapshot([{ id: 's', status: 'new_status' }], 'USD')).toThrow();
    const row = subscription('s', 'a', 1000);
    expect(() => subscriptionSnapshot([row, row], 'USD')).toThrow();
  });
});
