import { stripeSnapshotSchema, type StripeSnapshot } from '@noticeos/contract/stripe-report';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function discounted(value: Record<string, unknown>): boolean {
  return value.discount != null || (value.discounts != null && (!Array.isArray(value.discounts) || value.discounts.length > 0));
}

/** Fixed, licensed monthly/yearly prices only. Unknown pricing is explicit,
 * including discounts, usage, tiers, unresolved tax and quantity transforms. */
function monthlyAmount(subscription: Record<string, unknown>, currency: string): number | null {
  const items = record(subscription.items);
  if (discounted(subscription) || (Array.isArray(subscription.default_tax_rates) && subscription.default_tax_rates.length > 0) || subscription.pause_collection != null || !items || items.has_more !== false || !Array.isArray(items.data) || items.data.length === 0) return null;
  let total = 0;
  for (const raw of items.data) {
    const item = record(raw), price = record(item?.price), recurring = record(price?.recurring);
    if (!item || !price || !recurring || discounted(item) || price.billing_scheme !== 'per_unit'
      || recurring.usage_type !== 'licensed' || price.transform_quantity != null || price.tax_behavior !== 'exclusive'
      || (Array.isArray(item.tax_rates) && item.tax_rates.length > 0)
      || typeof price.currency !== 'string' || price.currency.toUpperCase() !== currency) return null;
    const amount = price.unit_amount;
    const quantity = item.quantity;
    const intervalCount = recurring.interval_count;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0
      || typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 0
      || typeof intervalCount !== 'number' || !Number.isSafeInteger(intervalCount) || intervalCount < 1) return null;
    const months = recurring.interval === 'month' ? intervalCount : recurring.interval === 'year' ? intervalCount * 12 : null;
    if (months === null || !Number.isSafeInteger(amount * quantity)) return null;
    total += amount * quantity / months;
  }
  return Number.isFinite(total) && total <= Number.MAX_SAFE_INTEGER ? total : null;
}

/** Reduce complete provider results to status counts and customer run rates. */
export function subscriptionSnapshot(rows: readonly unknown[], currency: string): StripeSnapshot {
  const customers = new Map<string, number | null>();
  let activeSubscriptions = 0, trials = 0, pastDue = 0, canceling = 0, unmeasuredSubscriptions = 0;
  const seen = new Set<string>();
  const statuses = new Set(['active', 'past_due', 'trialing', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']);
  for (const raw of rows) {
    const sub = record(raw);
    if (!sub || typeof sub.id !== 'string' || seen.has(sub.id) || typeof sub.status !== 'string' || !statuses.has(sub.status)) throw new Error('Invalid Stripe subscription list.');
    seen.add(sub.id);
    if (sub.status === 'trialing') { trials++; continue; }
    if (sub.status !== 'active' && sub.status !== 'past_due') continue;
    activeSubscriptions++;
    if (sub.status === 'past_due') pastDue++;
    if (sub.cancel_at_period_end === true || sub.cancel_at != null) canceling++;
    const customer = typeof sub.customer === 'string' ? sub.customer : record(sub.customer)?.id;
    if (typeof customer !== 'string' || customer === '') throw new Error('Invalid Stripe customer reference.');
    const monthly = monthlyAmount(sub, currency);
    if (monthly === null) unmeasuredSubscriptions++;
    const previous = customers.get(customer);
    customers.set(customer, monthly === null || previous === null ? null : (previous ?? 0) + monthly);
  }
  return stripeSnapshotSchema.parse({ version: 1, currency, activeSubscriptions, trials, pastDue, canceling, unmeasuredSubscriptions,
    customers: [...customers].sort(([a], [b]) => a.localeCompare(b)).map(([ref, mrrMinor]) => ({ ref, mrrMinor })) });
}
