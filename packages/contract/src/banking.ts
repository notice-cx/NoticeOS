import type { MercurySnapshot } from './banking-schema.js';
export type { BankAccount, BankTransaction, MercurySnapshot } from './banking-schema.js';

export const MERCURY_WINDOW_DAYS = 35;
export const BANK_ACTIVITY_DISPLAY_LIMIT = 25;

export interface BankingPayload {
  state: 'not-connected' | 'awaiting' | 'recorded' | 'unavailable';
  observedAt: string | null;
  snapshot: MercurySnapshot | null;
}
