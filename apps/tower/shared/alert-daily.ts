/** Portfolio snapshots recorded by the existing daily rollup, on its UTC day. */
export interface AlertDailySnapshot {
  day: string;
  observedAt: string | null;
  /** A missing day's counts are unknown, not zero. */
  open: number | null;
  errors: number | null;
  warnings: number | null;
}

export interface AlertDailyPayload {
  generatedAt: string;
  days: AlertDailySnapshot[];
}
