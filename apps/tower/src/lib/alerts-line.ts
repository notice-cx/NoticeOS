import { formatInt } from "@/lib/format";

/** "2 open alerts, both warnings" — the one sentence /alerts and a site's Alerts tab open with (D45). */
export function alertsLine(items: readonly { severity: string }[]): string {
  const errors = items.filter((item) => item.severity === "error").length;
  const warnings = items.length - errors;
  if (items.length === 0) return "No open alerts";
  if (items.length === 1) return errors === 1 ? "1 open alert, an error" : "1 open alert, a warning";
  const all = items.length === 2 ? "both" : "all";
  if (errors === 0) return `${formatInt(items.length)} open alerts, ${all} warnings`;
  if (warnings === 0) return `${formatInt(items.length)} open alerts, ${all} errors`;
  return `${formatInt(items.length)} open alerts, ${formatInt(errors)} ${errors === 1 ? "error" : "errors"}`;
}

