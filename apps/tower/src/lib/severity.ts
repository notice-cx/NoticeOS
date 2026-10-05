import { worstReportingState, type ReportingCoverage } from "@noticeos/contract/reporting";
import type { Severity } from "@shared/wall";

/** A stale expected report needs attention; unconfigured reporting is neutral. */
export function coverageSeverity(coverage: ReportingCoverage): "warn" | null {
  const worst = worstReportingState(coverage);
  if (worst === "stale") return "warn";
  return null;
}

/** doc 10 principle 3: severity owns attention color. These maps are the single
 * place severity → token class is decided; components never inline it. */

export const SEVERITY_RANK: Record<Severity, number> = {
  error: 3,
  warn: 2,
  info: 1,
};

/** Worst (highest-rank) severity in a list, or null if none present. */
export function worstSeverity(
  values: ReadonlyArray<Severity | null | undefined>,
): Severity | null {
  let worst: Severity | null = null;
  for (const s of values) {
    if (s && (worst === null || SEVERITY_RANK[s] > SEVERITY_RANK[worst])) {
      worst = s;
    }
  }
  return worst;
}

export const severityBgClass: Record<Severity, string> = {
  error: "bg-error",
  warn: "bg-warn",
  info: "bg-info",
};

export const severityTextClass: Record<Severity, string> = {
  error: "text-error",
  warn: "text-warn",
  info: "text-info",
};

/** Solid chip: colored background + its readable foreground token. */
export const severityChipClass: Record<Severity, string> = {
  error: "bg-error text-error-foreground",
  warn: "bg-warn text-warn-foreground",
  info: "bg-info text-info-foreground",
};

export const severityLabel: Record<Severity, string> = {
  error: "Error",
  warn: "Warn",
  info: "Info",
};

/**
 * What a site's alert dot says it is (bead `ro-32ry`): its OPEN ALERTS,
 * counted — "1 open error alert", "2 open warning alerts", both joined — so
 * the dot beside a site's name is never read as a data source's status, which
 * has its own marks (`DataSourceIcons`). The dot's hover and accessible name;
 * no visible words.
 */
export function openAlertsLabel(openError: number, openWarn: number): string {
  const part = (count: number, kind: string) => `${count} open ${kind} ${count === 1 ? "alert" : "alerts"}`;
  const parts = [openError > 0 ? part(openError, "error") : null, openWarn > 0 ? part(openWarn, "warning") : null];
  const said = parts.filter(Boolean).join(", ");
  return said || "No open alerts";
}
