import type { ConnectionKind, ConnectionStatus } from "@shared/connection-status";
import type { ViewId } from "@shared/views";

/** Display emphasis only. Applicability and connection health still come
 * from the source register and the shared connection-status selector. */
const SOURCES: Record<ViewId, readonly string[]> = {
  overview: [],
  growth: ["gsc", "ga4", "bing-webmaster", "dataforseo", "clarity", "posthog"],
  revenue: ["ad-network", "affiliate-cj", "affiliate-amazon", "subscriptions", "stripe", "nightly-report"],
  delivery: ["github-app", "deploy-annotations", "nightly-report", "calendar", "discord-webhooks"],
  reliability: ["uptime", "egress", "nightly-report", "crux", "cloudflare"],
};

export const SOURCE_CONTEXT: Record<ViewId, { title: string; detail: string }> = {
  overview: { title: "Source coverage", detail: "Collection and connection evidence" },
  growth: { title: "Acquisition and conversion inputs", detail: "Search, traffic and product analytics coverage" },
  revenue: { title: "Financial inputs", detail: "Revenue collection and asset reports" },
  delivery: { title: "Work and release inputs", detail: "Code, deploy history and coordination coverage" },
  reliability: { title: "Availability and freshness inputs", detail: "Uptime, connectivity and asset report coverage" },
};

export function sourceInView(id: string, view: ViewId): boolean {
  return view === "overview" || SOURCES[view].includes(id);
}

export function providerInView(provider: { id: string; lanes: readonly string[] }, view: ViewId): boolean {
  return sourceInView(provider.id, view) || provider.lanes.some((lane) => sourceInView(lane, view));
}

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
