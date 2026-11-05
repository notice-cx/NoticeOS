import { z } from 'zod';

export const MERCURY_WINDOW_DAYS = 35;
export const BANK_ACTIVITY_DISPLAY_LIMIT = 25;

/** Bank observations are cash evidence, separate from earned revenue and costs. */
export const bankAccountSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(500),
  kind: z.string().min(1).max(100),
  status: z.enum(['active', 'deleted', 'pending', 'archived']),
  currentMinor: z.number().int().safe(),
  availableMinor: z.number().int().safe(),
});
export const bankTransactionSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  amountMinor: z.number().int().safe(),
  counterparty: z.string().max(500),
  kind: z.string().min(1).max(100),
  status: z.enum(['pending', 'sent', 'cancelled', 'failed', 'reversed', 'blocked']),
  createdAt: z.string().datetime({ offset: true }),
  postedAt: z.string().datetime({ offset: true }).nullable(),
});
export const mercurySnapshotSchema = z.object({
  currency: z.literal('USD'),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  accounts: z.array(bankAccountSchema).max(1000),
  transactions: z.array(bankTransactionSchema).max(10_000),
});
export type BankAccount = z.infer<typeof bankAccountSchema>;
export type BankTransaction = z.infer<typeof bankTransactionSchema>;
export type MercurySnapshot = z.infer<typeof mercurySnapshotSchema>;
export interface BankingPayload {
  state: 'not-connected' | 'awaiting' | 'recorded' | 'unavailable';
  observedAt: string | null;
  snapshot: MercurySnapshot | null;
}
