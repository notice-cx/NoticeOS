import { Link, useLocation } from "react-router-dom";
import { setReportReturnParams, type ReportReturn } from "@noticeos/contract/report-return";
import { connectionState, integrationProvider } from "@noticeos/contract/integrations";
import { connectHref, providerName } from "@shared/connect-panel";
import { laneStatus } from "@shared/connection-status";
import { integrationLabel, verifiedCollectionEvidence, type AssetIntegrations } from "@shared/integrations";
import { connectBlockers } from "@shared/integrations-page";
import type { SignalTrend } from "@shared/wall";
import { Button } from "@/components/ui/button";
import { useConnections } from "@/hooks/useConnections";
import { useBackupPreview, useCanEditWorkspace, useDemoReadonly } from "@/lib/browser-context";
import { tabPath } from "./AssetTabs";
import { rangeFromParam } from "./useRange";

const reportLanes = {
  audience: ["ga4"],
  search: ["bing-webmaster", "gsc"],
  revenue: ["ad-network", "adsense", "subscriptions"],
  trackedSearch: ["dataforseo"],
};
export function sourceReportPath(destination: ReportReturn): string {
  return tabPath(destination.asset, destination.report, destination.range === undefined ? '' : `range=${destination.range}`);
}

export function hasRecordedTrend(trend: SignalTrend): boolean {
  return trend.collectedAt != null || trend.series.some(point => point.v != null)
    || (trend.contextSeries?.some(point => point.v != null) ?? false);
}

export function ReportSourceNext({ report, data, nowMs, assetTab, configuredHref }: {
  report: keyof typeof reportLanes;
  data: { asset: { id: string }; integrations: AssetIntegrations };
  nowMs: number;
  assetTab: ReportReturn['report'];
  configuredHref?: string;
}) {
  const canEdit = useCanEditWorkspace();
  const backupPreview = useBackupPreview();
  const demoReadonly = useDemoReadonly();
  const { providers, credentials, items } = useConnections(false);
  const { search } = useLocation();
  const { id } = data.asset;
  if (backupPreview) return <p className="text-sm text-muted-foreground">This preview shows the reports saved in the backup.</p>;
  if (demoReadonly) return null;
  const trackedTerms = configuredHref && (canEdit
    ? <Button asChild size="sm" variant="outline"><Link to={configuredHref}>Track search terms</Link></Button>
    : <p className="text-sm text-muted-foreground">A workspace owner or operator can set up tracked terms for this asset.</p>);
  // Tracked terms are editable per asset even when its source catalog omits paid search.
  if (trackedTerms && !data.integrations.lanes.some(({ catalog }) => reportLanes[report].includes(catalog.id))) return trackedTerms;
  const sources = reportLanes[report].flatMap(laneId => {
    const lane = data.integrations.lanes.find(({ catalog }) => catalog.id === laneId);
    if (!lane) return [];
    const reading = laneStatus({ laneId, assetId: id, cell: lane.cell, credentials, items, nowMs });
    const provider = reading.provider && integrationProvider(reading.provider);
    if (!provider || reading.kind === "not-applicable" || reading.kind === "not-using") return [];
    const kind = credentials?.has(provider.id) ? reading.kind : "unknown";
    return [{ provider, kind, laneId, mapped: lane.cell.mapped === true,
      reported: verifiedCollectionEvidence(lane.cell, nowMs) !== null }];
  });
  const connected = sources.find(source => source.kind !== "not-connected" && source.kind !== "unknown");
  if (connected) {
    if (["working", "collecting"].includes(connected.kind)) {
      if (trackedTerms) return trackedTerms;
      return <p className="text-sm text-muted-foreground">{providerName(connected.provider)} is connected for this asset.</p>;
    }
    return ["overdue", "failing", "reconnecting"].includes(connected.kind)
      ? <Button asChild size="sm" variant="outline"><Link to={tabPath(id, "sources", search)}>Review data sources</Link></Button>
      : null;
  }
  if (sources.some(source => source.kind === "unknown" || source.reported)) return null;

  // A mapping identifies the intended source when a report can use several providers.
  const source = sources.find(candidate => candidate.mapped) ?? sources[0];
  if (!source) return null;
  const credential = credentials?.get(source.provider.id);
  if (!credential) return null;
  const disconnected = connectionState(credential) === "not-connected";
  if (trackedTerms && !disconnected) return trackedTerms;
  const name = disconnected ? providerName(source.provider) : integrationLabel(source.laneId, source.provider.label);
  if (!canEdit) return <p className="text-sm text-muted-foreground">A workspace owner or operator can {disconnected ? "connect" : "set up"} {name}.</p>;
  if (!providers?.data || connectBlockers(providers.data).length) return null;
  const label = disconnected ? `Connect ${name}` : `Set up ${name} for this asset`;
  const target = new URL(connectHref(source.provider.id, id), "http://local.invalid");
  const range = new URLSearchParams(search).get("range");
  setReportReturnParams(target.searchParams, { asset: id, report: assetTab, ...(range ? { range: rangeFromParam(range) } : {}) });
  return <Button asChild size="sm" variant="outline"><Link to={`${target.pathname}${target.search}`}>{label}</Link></Button>;
}
