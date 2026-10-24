// The System as a graph of its parts, for System health: each connected data
// provider feeding the collectors, the collectors filling the store, the store
// serving the Tower and copied by the backups, the scheduled runner driving the
// collectors. Every state is re-read from the credentials, the monitoring
// items and the Wall payload's system band; a part nothing measures is idle,
// never healthy by default.
import { Archive, Database, Download, MonitorSmartphone, Plug, Timer } from "lucide-react";
import { INTEGRATION_PROVIDERS, connectionState, type CredentialSummary } from "@noticeos/contract/integrations";
import type { IntegrationHealthItem } from "@noticeos/contract/integration-health";
import { connectionStatus, type ConnectionKind } from "@shared/connection-status";
import type { SystemBand } from "@shared/wall";
import { scheduledLanePosture } from "@/components/ScheduledLanes";
import { backupStatus, isBackupLane, lastGoodCopy, type BackupState } from "@/lib/backups";
import type { FlowEdge, FlowNode, FlowState } from "@/components/viz/FlowGraph";
import { formatAge } from "@shared/freshness";
import { siteCount } from "@shared/site-noun";

const PROVIDER_STATE: Record<ConnectionKind, FlowState> = {
  working: "ok",
  collecting: "active",
  reconnecting: "idle",
  "key-accepted": "idle",
  "not-checked": "idle",
  overdue: "warn",
  failing: "error",
  "not-connected": "absent",
  "not-using": "absent",
  unknown: "idle",
};

const BACKUP_NODE: Record<BackupState, FlowState> = {
  none: "absent",
  off: "absent",
  working: "ok",
  missed: "warn",
  failing: "error",
};

const PROVIDER_WORD: Partial<Record<ConnectionKind, string>> = {
  working: "collecting on schedule",
  collecting: "first collection running",
  overdue: "a report is late",
  failing: "failing",
  "key-accepted": "key accepted, nothing collected yet",
  "not-checked": "not checked yet",
  unknown: "not read yet",
};

/** The provider's own short name; its card on Integrations carries the full one. */
const PROVIDER_SHORT: Readonly<Record<string, string>> = {
  google: "Google",
  "bing-webmaster": "Bing",
  dataforseo: "DataForSEO",
  posthog: "PostHog",
  clarity: "Clarity",
  mediavine: "Mediavine",
};

export interface SystemFlowInputs {
  credentials: ReadonlyMap<string, CredentialSummary> | undefined;
  items: readonly IntegrationHealthItem[] | null;
  system: SystemBand | null;
  nowMs: number;
}

/** The connected data providers, then the System's own parts. */
export function systemFlow({ credentials, items, system, nowMs }: SystemFlowInputs): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const providers = INTEGRATION_PROVIDERS.filter((provider) => provider.lanes.length > 0 && provider.companionOf === undefined);
  const connected = providers.filter((provider) => {
    const credential = credentials?.get(provider.id);
    return credential !== undefined && credential !== null && connectionState(credential) !== "not-connected";
  });
  const sourceNodes: FlowNode[] = connected.map((provider) => {
    const status = connectionStatus(provider.id, credentials?.get(provider.id), [...(items ?? [])]);
    const failing = status.sites.filter((site) => site.kind === "failing");
    const since = failing.map((site) => site.lastSuccessAt).filter((at): at is string => at !== null).sort()[0] ?? null;
    // A provider failing on some of its sites is at risk even while the
    // connection as a whole reads Working.
    const state: FlowState = items === null ? "idle" : status.kind === "working" && failing.length > 0 ? "warn" : PROVIDER_STATE[status.kind];
    return {
      id: `source:${provider.id}`,
      label: PROVIDER_SHORT[provider.id] ?? provider.label,
      column: 0,
      icon: Plug,
      state,
      since: failing.length > 0 ? since : null,
      caption: failing.length > 0 ? `${failing.length} of ${siteCount(status.sites.length)} failing` : PROVIDER_WORD[status.kind],
      href: "/integrations",
    };
  });
  const failingSources = sourceNodes.filter((node) => node.state === "error").length;
  const lateSources = sourceNodes.filter((node) => node.state === "warn").length;
  const reading = sourceNodes.filter((node) => node.state === "ok" || node.state === "active").length;
  const lanes = (system?.scheduledLanes ?? []).filter((lane) => system?.backupSchedule?.enabled !== false || !isBackupLane(lane));
  const posture = system ? scheduledLanePosture(lanes, nowMs) : "unknown";
  const latestRun = lanes.reduce<string | null>((at, lane) => (at === null || lane.startedAt > at ? lane.startedAt : at), null);
  const backups = backupStatus(system?.scheduledLanes ?? [], nowMs, system?.backupSchedule, system?.backupLastGoodAt);

  const nodes: FlowNode[] = [
    ...sourceNodes,
    {
      id: "runner",
      label: "Scheduled runs",
      column: 0,
      icon: Timer,
      state: posture === "failed" ? "error" : posture === "silent" ? "error" : posture === "healthy" ? "active" : posture === "skipped" ? "warn" : "idle",
      value: lanes.length > 0 ? String(lanes.length) : undefined,
      caption: latestRun ? `last run ${formatAge(nowMs - Date.parse(latestRun))} ago` : "nothing has run yet",
      since: posture === "failed" ? lanes.filter((lane) => lane.outcome === "failed").map((lane) => lane.startedAt).sort().at(-1) ?? null : null,
      href: "/workflows",
    },
    {
      id: "collectors",
      label: "Collectors",
      column: 1,
      icon: Download,
      state: failingSources > 0 || lateSources > 0 ? "warn" : sourceNodes.length === 0 ? "idle" : "ok",
      value: sourceNodes.length > 0 ? `${reading} of ${sourceNodes.length}` : undefined,
      caption: sourceNodes.length > 0 ? "providers reading fully" : "no provider connected",
    },
    {
      id: "store",
      label: "Store",
      column: 2,
      icon: Database,
      state: system ? "ok" : "idle",
      caption: system ? "answering" : "not read yet",
    },
    {
      id: "tower",
      label: "Tower and Wall",
      column: 3,
      icon: MonitorSmartphone,
      state: "ok",
      caption: "reading the store",
    },
    {
      id: "backups",
      label: "Backups",
      column: 3,
      icon: Archive,
      state: BACKUP_NODE[backups.state],
      since: backups.failingSince,
      caption: backups.state === "off" ? "Off" : lastGoodCopy(backups, nowMs),
      href: "/workflows",
    },
  ];
  const edges: FlowEdge[] = [
    ...sourceNodes.map((node): FlowEdge => ({ from: node.id, to: "collectors", state: node.state === "error" ? "broken" : node.state === "absent" || node.state === "idle" ? "idle" : "flowing" })),
    { from: "runner", to: "collectors", state: posture === "failed" || posture === "silent" ? "broken" : posture === "healthy" ? "flowing" : "idle" },
    { from: "collectors", to: "store", state: sourceNodes.length === 0 ? "idle" : "flowing" },
    { from: "store", to: "tower", state: system ? "flowing" : "idle" },
    { from: "store", to: "backups", state: backups.state === "failing" ? "broken" : (backups.state === "none" || backups.state === "off") ? "idle" : "flowing" },
  ];
  return { nodes, edges };
}
