import { formatInt } from "@/lib/format";

/** The shared summary for portfolio and asset alert views. */
export function alertsLine(items: readonly { severity: string }[]): string {
  const errors = items.filter((item) => item.severity === "error").length;
  const warnings = items.filter((item) => item.severity === "warn").length;
  const informational = items.filter((item) => item.severity === "info").length;
  if (items.length === 0) return "No open alerts";
  if (items.length === 1) return errors === 1 ? "1 open alert, an error"
    : warnings === 1 ? "1 open alert, a warning" : "1 open alert, informational";
  const all = items.length === 2 ? "both" : "all";
  const total = `${formatInt(items.length)} open alerts`;
  if (warnings === items.length) return `${total}, ${all} warnings`;
  if (errors === items.length) return `${total}, ${all} errors`;
  if (informational === items.length) return `${total}, ${all} informational`;
  const parts = [
    errors > 0 ? `${formatInt(errors)} ${errors === 1 ? "error" : "errors"}` : null,
    warnings > 0 ? `${formatInt(warnings)} ${warnings === 1 ? "warning" : "warnings"}` : null,
    informational > 0 ? `${formatInt(informational)} informational` : null,
  ].filter((part) => part !== null);
  return `${total}, ${parts.join(", ")}`;
}

