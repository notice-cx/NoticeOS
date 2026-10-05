// A `flags` row as the alert surfaces read it: one column list, one row shape
// and one mapper to the wire `FlagRecord`.
//
// Which rows are open, closed or snoozed is `flag-scope.ts`'s question; this
// module only says what one row IS once selected. The asset page's open and
// history lists and `/alerts/history` (`alert-history.ts`) both read through
// here, so a settled alert cannot mean one thing on its asset's page and
// another on the portfolio's history.

import type {
  AnnotationItem,
  Disposition,
  FlagKind,
  FlagRecord,
} from "../shared/asset-detail";
import { javascriptInstant } from "@noticeos/postgres";
import { correlateChanges } from "../shared/alert-language";
import type { Severity } from "../shared/wall";

/** The row shape `FLAG_COLUMNS` selects. Shared by the asset page and
 * `alert-history.ts`, which reads the same rows across every asset: one row
 * shape, one column list, one mapper — so a settled alert cannot mean one thing
 * on its asset's page and another on `/alerts/history`. */
export type FlagDbRow = {
  id: number;
  pulseId?: number | null;
  firedAt: string;
  severity: string;
  kind: string;
  metric: string | null;
  message: string | null;
  ruleId: string;
  ruleInputs: string | null;
  disposition: string | null;
  dispositionAt: string | null;
  dispositionNote: string | null;
  snoozeUntil: string | null;
  ackExpiry: string | null;
  resolvedAt: string | null;
};

/** The columns of `noticeos.current_flags` (bead ro-ujb9.76.5.2) a `FlagDbRow`
 * is made of: an alert is known by its workspace's number, and its report by
 * the day's number (`pulse_day_number`), never by a table's own identity. Read
 * the rows through `flagDbRow`. */
export const FLAG_COLUMNS = `flag_number::int AS id, pulse_day_number::int AS "pulseId", fired_at AS "firedAt",
  severity, kind, metric, message,
  rule_id AS "ruleId", rule_inputs::text AS "ruleInputs",
  disposition, disposition_at AS "dispositionAt",
  disposition_note AS "dispositionNote", snooze_until AS "snoozeUntil",
  ack_expiry AS "ackExpiry", resolved_at AS "resolvedAt"`;

/** An instant as the writers stored it (`javascriptInstant`), or null. */
export function flagInstant(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : javascriptInstant(value);
}

/** A row read with `FLAG_COLUMNS` (or any of its instants), each instant in the
 * form JavaScript writes, as D1's text columns held them. */
export function flagDbRow<R extends Partial<FlagDbRow> & { firedAt: string }>(row: R): R {
  return {
    ...row,
    firedAt: javascriptInstant(row.firedAt),
    ...("dispositionAt" in row ? { dispositionAt: flagInstant(row.dispositionAt) } : {}),
    ...("snoozeUntil" in row ? { snoozeUntil: flagInstant(row.snoozeUntil) } : {}),
    ...("ackExpiry" in row ? { ackExpiry: flagInstant(row.ackExpiry) } : {}),
    ...("resolvedAt" in row ? { resolvedAt: flagInstant(row.resolvedAt) } : {}),
  } as R;
}

/** `rule_inputs` is a TEXT column; a row written before a rule stored inputs (or
 * one that got truncated) parses to null and the alert falls back to its stored
 * message rather than failing the whole page. */
export function parseRuleInputs(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}


/**
 * The row as stored. Liveness is deliberately NOT set here — it is derived from
 * a source outside this row (`reviewAlertConditions`), and returning a FlagRecord
 * without it would let a caller forget to ask.
 *
 * `condition` is what this row STANDS FOR: the count and onset of the group it
 * represents (`ro-kukv.5`), supplied by the caller because only the caller knows
 * whether it is holding one firing of an ongoing condition or one closed event
 * out of history. Both are required rather than defaulted, so a new call site
 * has to answer the question rather than inherit a 1 by accident.
 */
export function toFlagRecord(
  r: FlagDbRow,
  changes: AnnotationItem[],
  condition: { occurrences: number; firstFiredAt: string },
): Omit<FlagRecord, "liveness"> {
  return {
    id: r.id,
    firedAt: r.firedAt,
    severity: r.severity as Severity,
    kind: r.kind as FlagKind,
    metric: r.metric,
    message: r.message,
    ruleId: r.ruleId,
    ruleInputs: parseRuleInputs(r.ruleInputs),
    // The 48h before the condition STARTED, matching the Wall (`ro-kukv.1`):
    // anchored to tonight's re-reading of a month-old condition, this window
    // sits after everything that could have caused it.
    correlatedChanges: correlateChanges(changes, condition.firstFiredAt),
    occurrences: condition.occurrences,
    firstFiredAt: condition.firstFiredAt,
    disposition: r.disposition as Disposition | null,
    dispositionAt: r.dispositionAt,
    dispositionNote: r.dispositionNote,
    snoozeUntil: r.snoozeUntil,
    ackExpiry: r.ackExpiry,
    resolvedAt: r.resolvedAt,
    ...(r.resolvedAt ? {
      verification: {
        state: "recorded-closed" as const, source: null,
        lastConfirmedAt: null, lastEvaluatedAt: null,
        reason: "recorded-closed" as const,
      },
    } : {}),
  };
}
