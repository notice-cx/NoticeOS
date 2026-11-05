import { z } from 'zod';

export const stripeSnapshotSchema = z.object({
  version: z.literal(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  activeSubscriptions: z.number().int().nonnegative(),
  trials: z.number().int().nonnegative(),
  pastDue: z.number().int().nonnegative(),
  canceling: z.number().int().nonnegative(),
  unmeasuredSubscriptions: z.number().int().nonnegative(),
  customers: z.array(z.object({ ref: z.string().min(1), mrrMinor: z.number().finite().nonnegative().nullable() })),
});

/** Customer references stay on the server; browser reports contain aggregates. */
export type StripeSnapshot = z.infer<typeof stripeSnapshotSchema>;
export const stripeSummarySchema = stripeSnapshotSchema.omit({ customers: true, version: true }).extend({
  observedAt: z.string().datetime(),
  mrrMinor: z.number().finite().nonnegative().nullable(),
  paidCustomers: z.number().int().nonnegative().nullable(),
});
export type StripeSnapshotSummary = z.infer<typeof stripeSummarySchema>;
export interface StripeGrowth {
  from: string;
  to: string;
  newCustomers: number;
  lostCustomers: number;
  /** Opening paid customers that are absent at the closing snapshot. */
  customerChurnPercent: number | null;
  newMrrMinor: number;
  lostMrrMinor: number;
  expansionMinor: number;
  contractionMinor: number;
  netMrrMinor: number;
}
export interface StripeSubscriptionReport {
  latest: StripeSnapshotSummary | null;
  history: StripeSnapshotSummary[];
  comparisons: { days: number; growth: StripeGrowth | null }[];
}
export interface SalesBreakdown {
  salesMinor: number;
  refundsMinor: number;
  feesMinor: number;
  payments: number;
  refunds: number;
}

export function summarizeStripe(snapshot: StripeSnapshot, observedAt: string): StripeSnapshotSummary {
  const { customers, version: _version, ...counts } = snapshot;
  const complete = snapshot.unmeasuredSubscriptions === 0 && customers.every((customer) => customer.mrrMinor !== null);
  return { ...counts, observedAt,
    mrrMinor: complete ? Math.round(customers.reduce((sum, customer) => sum + customer.mrrMinor!, 0)) : null,
    paidCustomers: complete ? customers.filter((customer) => customer.mrrMinor! > 0).length : null };
}

/** Endpoint movements, not a count of intervening cancel/reactivate events. */
export function compareStripe(before: StripeSnapshot, after: StripeSnapshot, from: string, to: string): StripeGrowth | null {
  if (before.currency !== after.currency || summarizeStripe(before, from).mrrMinor === null || summarizeStripe(after, to).mrrMinor === null) return null;
  const opening = new Map(before.customers.filter((c) => c.mrrMinor! > 0).map((c) => [c.ref, c.mrrMinor!]));
  const closing = new Map(after.customers.filter((c) => c.mrrMinor! > 0).map((c) => [c.ref, c.mrrMinor!]));
  let newCustomers = 0, lostCustomers = 0, newMrrMinor = 0, lostMrrMinor = 0, expansionMinor = 0, contractionMinor = 0;
  for (const [ref, value] of closing) {
    const previous = opening.get(ref);
    if (previous === undefined) { newCustomers++; newMrrMinor += value; }
    else if (value > previous) expansionMinor += value - previous;
    else contractionMinor += previous - value;
  }
  for (const [ref, value] of opening) if (!closing.has(ref)) { lostCustomers++; lostMrrMinor += value; }
  return { from, to, newCustomers, lostCustomers,
    customerChurnPercent: opening.size === 0 ? null : lostCustomers / opening.size * 100,
    newMrrMinor: Math.round(newMrrMinor), lostMrrMinor: Math.round(lostMrrMinor),
    expansionMinor: Math.round(expansionMinor), contractionMinor: Math.round(contractionMinor),
    netMrrMinor: summarizeStripe(after, to).mrrMinor! - summarizeStripe(before, from).mrrMinor! };
}

/** Store the compact public aggregate beside the private comparison evidence. */
export function stripeSnapshotRecord(snapshot: StripeSnapshot, observedAt: string) {
  return { ...snapshot, summary: summarizeStripe(snapshot, observedAt) };
}
