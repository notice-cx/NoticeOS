import type { HealthState } from "./HealthGrid";

export type SourceDayState = "reported" | "counting" | "missed" | "late" | "before";

export interface SourceHistoryRow {
  id: string;
  /** Accessible coverage summary supplied by the caller. */
  summary: string;
  /** What the row prints. */
  name: string;
  /** The full name, on hover and to screen readers. */
  label: string;
  /** The source's state now, in the grid's words; null for a row read only
   * from its data. */
  state: HealthState | null;
  stateLabel: string | null;
  since: string | null;
  /** One state per day, oldest first; null when this read holds no daily record. */
  days: { t: string; state: SourceDayState }[] | null;
  /** The newest day that reported. */
  through: string | null;
}

export interface SourceHistoryHeadline {
  tone: "error" | "warn" | "clear" | "gap";
  text: string;
}
