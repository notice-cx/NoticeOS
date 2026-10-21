export interface DailyMeasureDay {
  t: string;
  /** null: nothing reported that day. */
  v: number | null;
  /** Sources that owed this day and did not report it. With a value, the day
   * is partial; without one, it is missing. Empty and null: nothing was owed. */
  missing: readonly string[];
}

export interface DailyMeasureGap {
  start: string;
  end: string;
  days: number;
  /** Who was silent, when the measure has more than one source. */
  who: string | null;
  /** Another source still reported: the bars are partial, not missing. */
  partial: boolean;
}

export interface DailyMeasureAlert {
  severity: "error" | "warn";
  /** Where the condition begins on the chart: its onset, or the chart's first
   * day when it began before the range. */
  since: string;
  /** The day the condition began. */
  onset: string;
  headline: string;
}

/** Ready-to-render daily evidence; totals, coverage and alert rules belong to the caller. */
export interface DailyMeasureSeries {
  key: string;
  name: string;
  days: readonly DailyMeasureDay[];
  provisionalFrom: string | null;
  usual: { value: number; label: string } | null;
  normal: { low: number; high: number } | null;
  alert: DailyMeasureAlert | null;
  gaps: readonly DailyMeasureGap[];
  sources: readonly string[];
  unit: string;
  format: (value: number) => string;
  axis: (value: number) => string;
}

/** Complete-day selections computed by the caller, referencing the series' days. */
export interface DailyMeasureLandmarks {
  best: DailyMeasureDay | null;
  worst: DailyMeasureDay | null;
  newest: DailyMeasureDay | null;
}
