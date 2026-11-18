import type { ConnectionKind, ConnectionStatus } from "@shared/connection-status";

export function connectionUrgency(kind: ConnectionKind | "not-applicable", sitesFailing = 0): number {
  if (kind === "failing" || sitesFailing > 0) return 2;
  if (kind === "overdue") return 1;
  return 0;
}

/** Unknown, untested and merely accepted credentials are not successful
 * collection. Coverage uses the connection model's Working proof. */
export function connectionCoverage(rows: readonly ConnectionStatus[]) {
  return {
    total: rows.length,
    working: rows.filter((row) => row.kind === "working").length,
    attention: rows.filter((row) => connectionUrgency(row.kind, row.sitesFailing) > 0).length,
    unverified: rows.filter((row) => row.kind === "unknown" || row.kind === "not-checked").length,
  };
}
