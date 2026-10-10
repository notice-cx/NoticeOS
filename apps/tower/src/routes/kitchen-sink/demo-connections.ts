import { INTEGRATION_MONITORS, type IntegrationHealthItem } from "@noticeos/contract/integration-health";
import type { CredentialSummary, IntegrationProviderId } from "@noticeos/contract/integrations";
import { CONNECTION_COUNT_KEYS, laneProvider, type ConnectionCounts, type ConnectionCountsHistory, type ConnectionReads } from "@shared/connection-status";
import type { CardDataSource } from "@shared/wall";

/**
 * The gallery's connection reads. A card's source
 * marks read each source through the status model, which needs credentials
 * and monitoring items; the demo cards only carry register states. This turns
 * each demo slot into the reads that model would see — a recorded success for
 * a live provider source, a recorded failure for a degraded one — so the
 * gallery draws the same marks the TV would for that asset.
 */
export function demoConnections(
  cards: readonly { id: string; dataSources: readonly CardDataSource[] }[],
  nowMs: number,
): ConnectionReads {
  const at = new Date(nowMs - 10 * 60_000).toISOString();
  const items: IntegrationHealthItem[] = [];
  const providers = new Set<string>();
  for (const card of cards) {
    for (const source of card.dataSources) {
      const provider = laneProvider(source.id);
      if (!provider || (source.state !== "live" && source.state !== "degraded")) continue;
      const monitors = INTEGRATION_MONITORS[provider as keyof typeof INTEGRATION_MONITORS] ?? [];
      const monitor = monitors.find((entry) => entry.scope === "property" && entry.lanes.includes(source.id))
        ?? monitors.find((entry) => entry.lanes.includes(source.id));
      if (!monitor) continue;
      providers.add(provider);
      const failing = source.state === "degraded";
      items.push({
        id: `demo-${card.id}-${source.id}`, provider, capability: monitor.id, label: monitor.label,
        asset: card.id, detail: null, report: null, reportDate: null, state: failing ? "failing" : "healthy",
        lastAttemptAt: at, lastSuccessAt: failing ? null : at, nextAttemptAt: null,
        failure: failing ? "access" : null, code: failing ? "access" : null,
        action: monitor.action, coverage: "monitored",
      });
    }
  }
  const credentials = new Map<string, CredentialSummary>([...providers].map((provider) => [provider, {
    provider: provider as IntegrationProviderId, source: "store", fields: [], assetsHeld: [], missingFields: [],
    auth: null, metadata: null, keyVersion: 1, createdAt: at, updatedAt: at, lastUsedAt: at, lastOkAt: at, lastError: null,
  }]));
  return { credentials, items };
}

/** A week of the Connections strip's daily record, ending on `nowMs`'s day. */
export function demoCountsHistory(nowMs: number): ConnectionCountsHistory {
  const values: Record<keyof ConnectionCounts, number[]> = {
    sitesFailing: [0, 0, 1, 1, 2, 1, 1],
    sitesOverdue: [0, 1, 0, 0, 0, 1, 0],
    reportsMissing: [4, 3, 3, 2, 2, 1, 1],
    sitesWorking: [3, 3, 2, 2, 1, 2, 2],
  };
  const days = values.sitesFailing.map((_, index) => new Date(nowMs - (6 - index) * 86_400_000).toISOString().slice(0, 10));
  const series = {} as ConnectionCountsHistory["series"];
  for (const key of CONNECTION_COUNT_KEYS) series[key] = days.map((t, index) => ({ t, v: values[key][index]! }));
  return { days: days.length, series };
}
