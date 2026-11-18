import { Link, useLocation } from "react-router-dom";
import { ASSET_ID_MAX, CONFIG_ASSET_KEY_RE } from "@noticeos/contract/configuration";
import { connectionState, integrationProvider } from "@noticeos/contract/integrations";
import { connectHref, providerName } from "@shared/connect-panel";
import { laneStatus } from "@shared/connection-status";
import { integrationLabel, verifiedCollectionEvidence, type AssetIntegrations } from "@shared/integrations";
import { connectBlockers } from "@shared/integrations-page";
import type { SignalTrend } from "@shared/wall";
import { Button } from "@/components/ui/button";
import { useConnections } from "@/hooks/useConnections";
import { useBackupPreview, useCanEditWorkspace, useDemoReadonly } from "@/lib/browser-context";
import { tabPath, type AssetTab } from "./AssetTabs";

const reportLanes = {
  audience: ["ga4"],
  search: ["bing-webmaster", "gsc"],
  revenue: ["ad-network", "adsense", "subscriptions"],
  trackedSearch: ["dataforseo"],
};
const REPORT_TABS = ["journeys", "growth", "search", "financials"] as const satisfies readonly AssetTab[];
type ReportTab = typeof REPORT_TABS[number];

export function sourceReportPath(params: URLSearchParams): string | null {
  const asset = params.get("asset");
  const report = REPORT_TABS.find(tab => tab === params.get("fromReport"));
  if (!report || !asset || asset.length > ASSET_ID_MAX || !CONFIG_ASSET_KEY_RE.test(asset)) return null;
  return tabPath(asset, report, params.toString());
}

export function hasRecordedTrend(trend: SignalTrend): boolean {
  return trend.collectedAt != null || trend.series.some(point => point.v != null)
    || (trend.contextSeries?.some(point => point.v != null) ?? false);
}

export function ReportSourceNext({ report, data, nowMs, assetTab, configuredHref }: {
  report: keyof typeof reportLanes;
  data: { asset: { id: string }; integrations: AssetIntegrations };
  nowMs: number;
  assetTab: ReportTab;
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
  // Tracked terms are editable per asset even when its source catalog omits paid search.
  if (configuredHref && !data.integrations.lanes.some(({ catalog }) => reportLanes[report].includes(catalog.id))) {
    return canEdit ? <Button asChild size="sm" variant="outline"><Link to={configuredHref}>Track search terms</Link></Button>
      : <p className="text-sm text-muted-foreground">A workspace owner or operator can set up tracked terms for this asset.</p>;
  }
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
      if (configuredHref) return canEdit ? <Button asChild size="sm" variant="outline"><Link to={configuredHref}>Track search terms</Link></Button> : null;
      return <p className="text-sm text-muted-foreground">{providerName(connected.provider)} is connected for this asset.</p>;
    }
    return ["overdue", "failing", "reconnecting"].includes(connected.kind)
      ? <Button asChild size="sm" variant="outline"><Link to={tabPath(id, "sources")}>Review data sources</Link></Button>
      : null;
  }
  if (sources.some(source => source.kind === "unknown" || source.reported)) return null;

  // A mapping identifies the intended source when a report can use several providers.
  const source = sources.find(candidate => candidate.mapped) ?? sources[0];
  if (!source) return null;
  const credential = credentials?.get(source.provider.id);
  if (!credential) return null;
  const disconnected = connectionState(credential) === "not-connected";
  if (configuredHref && !disconnected) return canEdit ? <Button asChild size="sm" variant="outline"><Link to={configuredHref}>Track search terms</Link></Button> : null;
  const name = disconnected ? providerName(source.provider) : integrationLabel(source.laneId, source.provider.label);
  if (!canEdit) return <p className="text-sm text-muted-foreground">A workspace owner or operator can {disconnected ? "connect" : "set up"} {name}.</p>;
  if (!providers?.data || connectBlockers(providers.data).length) return null;
  const label = disconnected ? `Connect ${name}` : `Set up ${name} for this asset`;
  const target = new URL(connectHref(source.provider.id, id), "http://local.invalid");
  target.searchParams.set("asset", id);
  target.searchParams.set("fromReport", assetTab);
  const range = new URLSearchParams(search).get("range");
  if (range) target.searchParams.set("range", range);
  return <Button asChild size="sm" variant="outline"><Link to={`${target.pathname}${target.search}`}>{label}</Link></Button>;
}
