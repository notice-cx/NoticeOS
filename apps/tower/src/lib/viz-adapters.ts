// The Wall payload read into the visual kit's shapes, once, for every screen
// that draws them (Home, the Wall). Each function only re-reads what the
// payload and the connection reads already say; a state nobody recorded stays
// unknown and an onset nobody recorded stays null.
import { connectionLabel, sourceReadings, type ConnectionReads, type SourceReading } from "@shared/connection-status";
import { SCHEDULED_JOBS, jobRunName } from "@shared/scheduled-jobs";
import { osReportMissing, type AssetCard, type ScheduledLane, type SystemBand } from "@shared/wall";
import type { WallFeedItem } from "@shared/wall-feed";
import type { TimelineEvent, TimelineEventKind, TimelineLane, TimelineSpan } from "@/components/viz/EventTimeline";
import { healthStateOf, type HealthCell, type HealthColumn, type HealthRow } from "@/components/viz/HealthGrid";
import type { Incident } from "@/components/viz/IncidentList";
import type { WorkFlowRow } from "@/components/viz/WorkFlow";
import { backupStatus, isBackupLane, lastGoodCopy, type BackupState } from "@/lib/backups";
import type { WallIssue } from "@/lib/wall-issues";

/** What a source column prints above its cells. */
const SOURCE_SHORT: Readonly<Record<string, string>> = {
  "nightly-report": "Report",
  gsc: "Search",
  "bing-webmaster": "Bing",
  ga4: "GA4",
  clarity: "Clarity",
  posthog: "PostHog",
  dataforseo: "Ranks",
  uptime: "Uptime",
};

/** The OS's own row: what keeps the machine honest, beside the sites' sources. */
export const SYSTEM_COLUMNS: readonly HealthColumn[] = [
  { id: "os-report", label: "The System's own nightly report", short: "Report" },
  { id: "jobs", label: "Scheduled runs", short: "Runs" },
  { id: "backups", label: "Backups", short: "Backups" },
  { id: "spend", label: "Data spend against the daily cap", short: "Spend" },
];

export const SYSTEM_ROW_ID = "system";

/** When a source entered its state, as far as its reading says: a failure or
 * a lateness dates from its last success. A working source has no onset. */
function readingSince(reading: SourceReading): string | null {
  if (reading.kind !== "failing" && reading.kind !== "overdue") return null;
  return reading.site?.lastSuccessAt ?? reading.site?.failure?.lastAttemptAt ?? reading.observedAt ?? null;
}

/** The sources as columns, in the payload's own slot order. */
export function sourceColumns(assets: readonly Pick<AssetCard, "dataSources">[]): HealthColumn[] {
  const seen = new Map<string, HealthColumn>();
  for (const asset of assets) {
    for (const source of asset.dataSources) {
      if (!seen.has(source.id)) seen.set(source.id, { id: source.id, label: source.label, short: SOURCE_SHORT[source.id] ?? source.label });
    }
  }
  return [...seen.values()];
}

/** A site's sources as grid cells. */
export function siteHealthRow(asset: Pick<AssetCard, "id" | "displayName" | "dataSources">, connections: ConnectionReads, nowMs: number, href?: string): HealthRow {
  return {
    id: asset.id,
    name: asset.displayName,
    kind: "site",
    href,
    cells: sourceReadings(asset.id, asset.dataSources, connections, nowMs).map((reading): HealthCell => ({
      column: reading.id,
      state: healthStateOf(reading.kind),
      label: reading.kind === "not-applicable" ? undefined : connectionLabel(reading.kind, "key", reading.id),
      since: readingSince(reading),
      detail: reading.detail ?? reading.site?.failure?.detail ?? null,
      href: href ? `${href}?tab=sources` : undefined,
    })),
  };
}

function laneLabel(lane: ScheduledLane): string {
  return SCHEDULED_JOBS.find((job) => jobRunName(job) === lane.job)?.label ?? lane.job;
}

const BACKUP_CELL: Record<BackupState, HealthCell["state"]> = {
  none: "not-connected",
  working: "working",
  missed: "overdue",
  failing: "failing",
};

/** The OS's row: its report, its scheduled jobs, its backups and its spend. */
export function systemHealthRow(system: SystemBand, nowMs: number, href = "/health"): HealthRow {
  const jobs = system.scheduledLanes.filter((lane) => !isBackupLane(lane));
  const failedJobs = jobs.filter((lane) => lane.outcome === "failed");
  const latest = (lanes: readonly ScheduledLane[]) => lanes.reduce<string | null>((at, lane) => (at === null || lane.startedAt > at ? lane.startedAt : at), null);
  const backups = backupStatus(system.scheduledLanes);
  const cells: HealthCell[] = [
    { column: "os-report", state: osReportMissing(system) ? "failing" : system.assetId === null ? "not-using" : "working", href },
    jobs.length === 0
      ? { column: "jobs", state: "unknown", detail: "Nothing scheduled has run yet", href }
      : failedJobs.length > 0
        ? { column: "jobs", state: "failing", since: latest(failedJobs), detail: failedJobs.map(laneLabel).join(", "), href }
        : { column: "jobs", state: "working", href },
    { column: "backups", state: BACKUP_CELL[backups.state], since: backups.failingSince, detail: lastGoodCopy(backups, nowMs), href },
    {
      column: "spend",
      state: system.dailyCapUsd > 0 && system.spendTodayUsd > system.dailyCapUsd ? "overdue" : "working",
      detail: `$${system.spendTodayUsd.toFixed(2)} of $${system.dailyCapUsd.toFixed(2)} today`,
      href,
    },
  ];
  return { id: SYSTEM_ROW_ID, name: "System", kind: "system", href, columns: SYSTEM_COLUMNS, cells };
}

/** Every site's row, then the System's. */
export function healthGridRows(
  assets: readonly AssetCard[],
  system: SystemBand | undefined,
  connections: ConnectionReads,
  nowMs: number,
  sitePath: (asset: AssetCard) => string,
): HealthRow[] {
  const rows = assets.map((asset) => siteHealthRow(asset, connections, nowMs, sitePath(asset)));
  return system ? [...rows, systemHealthRow(system, nowMs)] : rows;
}

/** A problem a data-source grid already draws: a failing source, a late
 * report, or the OS's own scheduler, report or spend. */
export function drawnByHealthGrid(issue: Pick<WallIssue, "key">): boolean {
  return issue.key.startsWith("source-") || issue.key.startsWith("system-") || issue.key.startsWith("report-");
}

/** Open problems as the problems list's rows. With `besideGrid`, the ones a
 * health grid on the same screen already draws are left to it, so each
 * problem appears once. */
export function incidentsFromIssues(issues: readonly WallIssue[], options: { besideGrid?: boolean; to?: (issue: WallIssue) => string | undefined } = {}): Incident[] {
  return issues
    .filter((issue) => !(options.besideGrid && drawnByHealthGrid(issue)))
    .map((issue) => ({
      key: issue.key,
      severity: issue.severity,
      title: issue.line,
      site: issue.site === "OS" ? "System" : issue.site,
      since: issue.since,
      to: options.to?.(issue),
    }));
}

const FEED_EVENT: Partial<Record<WallFeedItem["kind"], TimelineEventKind>> = {
  resolved: "resolved",
  "source-back": "resolved",
  "task-done": "win",
  deployed: "shipped",
  change: "shipped",
  revenue: "money",
  insights: "note",
  alert: "problem",
  "source-failed": "problem",
  "job-failed": "problem",
};

/** The timeline's rows, spans and marks: one row per site and one for the
 * System, every open problem as a span from its onset to now, and the feed's
 * stored events as marks on their site's row. Housekeeping (collections,
 * reports, saved settings) is not an event worth a mark. */
export function timelineFromWall(
  assets: readonly AssetCard[],
  issues: readonly WallIssue[],
  feed: readonly WallFeedItem[],
  sitePath: (asset: AssetCard) => string,
): { lanes: TimelineLane[]; spans: TimelineSpan[]; events: TimelineEvent[] } {
  const lanes: TimelineLane[] = [
    ...assets.map((asset) => ({ id: asset.id, label: asset.displayName, href: sitePath(asset) })),
    { id: SYSTEM_ROW_ID, label: "System", href: "/health" },
  ];
  const known = new Set(assets.map((asset) => asset.id));
  const laneOf = (ids: readonly string[]) => ids.find((id) => known.has(id)) ?? SYSTEM_ROW_ID;
  const spans: TimelineSpan[] = issues.flatMap((issue) =>
    (issue.assets.length > 0 ? issue.assets : [SYSTEM_ROW_ID]).map((asset) => ({
      id: `${issue.key}:${asset}`,
      lane: known.has(asset) ? asset : laneOf(issue.assets),
      from: issue.since,
      to: null,
      severity: issue.severity,
      label: issue.line,
      conditions: issue.conditions,
    })),
  );
  const events: TimelineEvent[] = feed.flatMap((item) => {
    const kind = FEED_EVENT[item.kind];
    if (!kind) return [];
    return [{
      id: item.id,
      lane: item.asset && known.has(item.asset) ? item.asset : SYSTEM_ROW_ID,
      at: item.at,
      kind,
      severity: kind === "problem" ? (item.tone === "warn" ? "warn" : "error") : undefined,
      label: item.site ? `${item.text}` : item.text,
    }];
  });
  return { lanes, spans, events };
}

/** Each site's task snapshot as a work-flow row; a site with no snapshot is
 * left out rather than drawn as an empty project. */
export function workFlowRows(assets: readonly AssetCard[], sitePath?: (asset: AssetCard) => string): WorkFlowRow[] {
  return assets.flatMap((asset) => {
    const work = asset.work;
    if (!work) return [];
    return [{
      id: asset.id,
      name: asset.displayName,
      to: sitePath?.(asset),
      done: work.closedRecent,
      inProgress: work.inProgress,
      ready: Math.max(0, work.open - work.blocked),
      blocked: work.blocked,
      urgent: work.highPriority,
    }];
  });
}
