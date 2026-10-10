// The one status model for a connection. Every screen that shows a
// connection's state derives it here.
//
//   Not connected → (Checking, the panel's one call) → Key accepted → Collecting
//     → Working | Failing, plus Not using, Overdue and Unknown
//
// Works now, not worst ever: each kind of work (one capability, one report)
// is judged by its latest attempt; an older failure a later success superseded
// is a gap — a missing report, counted and shown on the site that owns it,
// never a status. A site fails when its latest work fails; a connection fails
// when its credential is refused or most of its sites fail. An incomplete
// report is a data fact, never a failed connection. Never ahead of proof:
// Working needs a stored successful attempt; a saved key nobody tested is Not
// checked; a monitoring read that is not current turns every retained success
// into Unknown.

import {
  INTEGRATION_MONITORS,
  type IntegrationHealthItem,
  type IntegrationHealthPayload,
  type IntegrationMonitorDefinition,
} from "@noticeos/contract/integration-health";
import { connectionState, type AcceptedAs, type CredentialSummary } from "@noticeos/contract/integrations";
import { UPTIME_LANE_ID, cardSourceCell, connectionHealthState, degradedKind, laneProvider, type IntegrationCellBase, type LaneScope } from "./integrations";
import type { CardDataSource, SeriesPoint } from "./wall";

/** Lives with the register (`./integrations`), which needs it too; every
 * screen keeps importing it from here. */
export { laneProvider };

export type ConnectionKind =
  | "not-connected"
  | "not-checked"
  | "key-accepted"
  | "collecting"
  | "working"
  | "overdue"
  | "failing"
  | "not-using"
  | "unknown";

/** What one site (or feed, or the account itself) can be. */
export type SiteKind = "collecting" | "working" | "overdue" | "failing" | "not-using" | "unknown";

type WorkKind = SiteKind | "idle";

/** One kind of work on one site: a capability, and for an archive one report. */
export interface WorkStatus {
  key: string;
  capability: string;
  /** The monitor's own label ("Analytics report archive"). */
  label: string;
  /** The report family for an archive; empty for everything else. */
  report: string;
  kind: WorkKind;
  /** The newest attempt this work has, whatever its outcome. */
  latest: IntegrationHealthItem | null;
  /** Failed report dates a later success superseded, oldest first. */
  missing: IntegrationHealthItem[];
  /** Report dates the provider answered with an incomplete or unusable report. */
  incomplete: IntegrationHealthItem[];
}

export interface SiteStatus {
  /** The asset id, a feed's name, or "" for the account itself. */
  key: string;
  asset: string | null;
  kind: SiteKind;
  missing: number;
  incomplete: number;
  /** Works whose scheduled attempt is late while others still work. */
  overdue: number;
  lastSuccessAt: string | null;
  /** The latest failed attempt behind a Failing site, for its reason. */
  failure: IntegrationHealthItem | null;
  works: WorkStatus[];
}

export interface ConnectionStatus {
  provider: string;
  kind: ConnectionKind;
  /** Sites in the order they need the operator: failing first. */
  sites: SiteStatus[];
  sitesFailing: number;
  /** Sites with a result either way (working, overdue or failing). */
  sitesMeasured: number;
  sitesOverdue: number;
  missing: number;
  incomplete: number;
}

export const CONNECTION_LABELS: Record<ConnectionKind | "checking", string> = {
  "not-connected": "Not connected",
  "not-checked": "Not checked",
  checking: "Checking",
  "key-accepted": "Key accepted",
  collecting: "Collecting",
  working: "Working",
  overdue: "Overdue",
  failing: "Failing",
  "not-using": "Not using",
  unknown: "Unknown",
};

/** The uptime source's two observed states, in the words every monitor uses:
 * what its check observes is the site, so Down says the site is. */
const UPTIME_LABELS: Partial<Record<ConnectionKind, string>> = { working: "Up", failing: "Down" };

/** An accepted connection, in the words of what the operator gave it
 * (`acceptedAs` in the contract decides which). */
export const ACCEPTED_LABELS: Record<AcceptedAs, string> = {
  key: "Key accepted",
  "sign-in": "Signed in",
  url: "URL accepted",
};

/** The one word a connection wears. An accepted one is named for what was
 * given — a key, a sign-in, an address (`ACCEPTED_LABELS`); the uptime source
 * (`lane`) is Up or Down. */
export function connectionLabel(kind: ConnectionKind, accepted: AcceptedAs = "key", lane: string | null = null): string {
  if (lane === UPTIME_LANE_ID && UPTIME_LABELS[kind]) return UPTIME_LABELS[kind];
  return kind === "key-accepted" ? ACCEPTED_LABELS[accepted] : CONNECTION_LABELS[kind];
}

// --- reading the monitoring payload ------------------------------------------

/**
 * The saved observations as this screen may use them. A read older than 90
 * seconds, or one that failed, cannot keep a retained success looking current:
 * every healthy or idle result becomes Unknown, and recorded failures stay.
 */
export function currentHealth(
  data: IntegrationHealthPayload | undefined,
  isError: boolean,
  nowMs: number,
): { current: boolean; available: boolean; items: IntegrationHealthItem[] } {
  const age = nowMs - Date.parse(data?.generatedAt ?? "");
  const current = Boolean(data && !isError && age >= -10_000 && age < 90_000);
  const items = (data?.items ?? []).map((saved) =>
    !current && (saved.state === "healthy" || saved.state === "idle") && saved.coverage !== "setup"
      ? { ...saved, state: "unknown" as const }
      : saved,
  );
  return { current, available: current && data?.available === true, items };
}

function monitorOf(item: Pick<IntegrationHealthItem, "provider" | "capability">): IntegrationMonitorDefinition | undefined {
  const monitors = (INTEGRATION_MONITORS as Record<string, readonly IntegrationMonitorDefinition[]>)[item.provider];
  return monitors?.find((entry) => entry.id === item.capability);
}

/** Which data sources (register lanes) an item's work feeds. */
export function itemLanes(item: Pick<IntegrationHealthItem, "provider" | "capability">): readonly string[] {
  return monitorOf(item)?.lanes ?? [];
}

/** An archive item's report family and report day, from the item's own
 * fields — never from `detail`, which is display text. Empty for anything
 * that is not one report of an archive. */
export function reportOf(item: Pick<IntegrationHealthItem, "provider" | "capability" | "report" | "reportDate">): { report: string; date: string } {
  if (monitorOf(item)?.evidence !== "signal_dump_runs") return { report: "", date: "" };
  const date = item.reportDate ?? "";
  return { report: item.report ?? "", date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "" };
}

/** The site an item belongs to: its asset, a feed's own name, or the account. */
function siteKeyOf(item: IntegrationHealthItem): string {
  if (item.asset) return item.asset;
  const monitor = monitorOf(item);
  return monitor && monitor.scope !== "account" && item.detail ? item.detail : "";
}

const REPORT_QUALITY = new Set(["incomplete-report", "invalid-report"]);
const attemptTime = (item: IntegrationHealthItem) => (item.lastAttemptAt ? Date.parse(item.lastAttemptAt) : Number.NaN);

function workStatus(key: string, items: IntegrationHealthItem[]): WorkStatus {
  const first = items[0]!;
  const attempted = items.filter((item) => Number.isFinite(attemptTime(item))).sort((a, b) => attemptTime(b) - attemptTime(a));
  const latest = attempted[0] ?? null;
  const newestSuccess = Math.max(
    ...items.map((item) => (item.state === "healthy" ? attemptTime(item) : Number.NaN)).filter(Number.isFinite),
    ...items.map((item) => (item.lastSuccessAt ? Date.parse(item.lastSuccessAt) : Number.NaN)).filter(Number.isFinite),
  );
  const quality = (item: IntegrationHealthItem) => item.failure !== null && REPORT_QUALITY.has(item.failure);
  const failed = items.filter((item) => item.state === "failing");
  let kind: WorkKind;
  if (latest === null) {
    kind = items.some((item) => item.state === "never-run") ? "collecting"
      : items.some((item) => item.state === "stale") ? "overdue"
        : items.some((item) => item.state === "unknown" || item.state === "unmonitored") ? "unknown"
          : items.every((item) => item.state === "paused") ? "not-using" : "idle";
  } else if (latest.state === "failing" && !quality(latest)) kind = "failing";
  else if (latest.state === "stale") kind = "overdue";
  else if (latest.state === "unknown" || latest.state === "unmonitored") kind = "unknown";
  else if (latest.state === "paused") kind = "not-using";
  else if (latest.state === "never-run") kind = "collecting";
  else if (latest.state === "idle" || latest.state === "disconnected") kind = "idle";
  else kind = "working";
  return {
    key, capability: first.capability, label: first.label, report: reportOf(first).report, kind, latest,
    missing: failed.filter((item) => !quality(item) && attemptTime(item) < newestSuccess).sort((a, b) => attemptTime(a) - attemptTime(b)),
    incomplete: failed.filter(quality),
  };
}

/** One site's status from its own items (one provider, or one data source). */
export function siteStatus(key: string, items: IntegrationHealthItem[]): SiteStatus | null {
  const byWork = new Map<string, IntegrationHealthItem[]>();
  for (const item of items) {
    const workKey = `${item.capability}|${reportOf(item).report}`;
    byWork.set(workKey, [...(byWork.get(workKey) ?? []), item]);
  }
  const works = [...byWork.entries()].map(([workKey, list]) => workStatus(workKey, list));
  const has = (kind: WorkKind) => works.some((work) => work.kind === kind);
  const kind: SiteKind | null = has("failing") ? "failing" : has("working") ? "working" : has("overdue") ? "overdue"
    : has("collecting") ? "collecting" : has("unknown") ? "unknown" : has("not-using") ? "not-using" : null;
  if (kind === null) return null;
  // The reason a failing site leads with: its direct pull before any one report
  // family, then the newest attempt.
  const failing = works.filter((work) => work.kind === "failing")
    .sort((a, b) => Number(a.report !== "") - Number(b.report !== "") || attemptTime(b.latest!) - attemptTime(a.latest!))[0]?.latest ?? null;
  const successes = items.flatMap((item) => [item.lastSuccessAt, item.state === "healthy" ? item.lastAttemptAt : null])
    .filter((value): value is string => value !== null).sort();
  return {
    key, asset: items.find((item) => item.asset)?.asset ?? null, kind,
    missing: works.reduce((sum, work) => sum + work.missing.length, 0),
    incomplete: works.reduce((sum, work) => sum + work.incomplete.length, 0),
    overdue: kind === "working" ? works.filter((work) => work.kind === "overdue").length : 0,
    lastSuccessAt: successes.at(-1) ?? null,
    failure: failing,
    works: works.filter((work) => work.kind !== "idle" || work.missing.length > 0 || work.incomplete.length > 0),
  };
}

const SITE_ORDER: Record<SiteKind, number> = { failing: 0, overdue: 1, unknown: 2, collecting: 3, working: 4, "not-using": 5 };

/** Every site of one provider, failing first, then by how much is missing. */
export function siteStatuses(items: IntegrationHealthItem[]): SiteStatus[] {
  const bySite = new Map<string, IntegrationHealthItem[]>();
  for (const item of items) bySite.set(siteKeyOf(item), [...(bySite.get(siteKeyOf(item)) ?? []), item]);
  return [...bySite.entries()]
    .flatMap(([key, list]) => {
      const site = siteStatus(key, list);
      return site ? [site] : [];
    })
    .sort((a, b) => SITE_ORDER[a.kind] - SITE_ORDER[b.kind] || b.missing - a.missing || (a.key === "" ? -1 : b.key === "" ? 1 : a.key.localeCompare(b.key)));
}

/**
 * The connection's one status.
 *
 * `credential` is the provider's stored credential summary; `items` are the
 * monitoring items as `currentHealth` returns them, for any providers (the
 * provider's own are picked out here).
 */
export function connectionStatus(
  provider: string,
  credential: CredentialSummary | null | undefined,
  items: IntegrationHealthItem[],
): ConnectionStatus {
  const empty: ConnectionStatus = { provider, kind: "not-connected", sites: [], sitesFailing: 0, sitesMeasured: 0, sitesOverdue: 0, missing: 0, incomplete: 0 };
  if (!credential || connectionState(credential) === "not-connected") return empty;
  const sites = siteStatuses(items.filter((item) => item.provider === provider && item.state !== "disconnected"));
  const measured = sites.filter((site) => site.kind === "working" || site.kind === "failing" || site.kind === "overdue");
  const failing = sites.filter((site) => site.kind === "failing").length;
  const some = (kind: SiteKind) => sites.some((site) => site.kind === kind);
  const kind: ConnectionKind =
    connectionState(credential) === "failing" || (failing > 0 && failing * 2 > measured.length) ? "failing"
      : some("working") ? "working"
        : some("overdue") ? "overdue"
          : some("collecting") ? "collecting"
            : sites.length > 0 && sites.every((site) => site.kind === "not-using") ? "not-using"
              : some("unknown") ? "unknown"
                : credential.lastOkAt !== null ? "key-accepted"
                  : "not-checked";
  return {
    provider, kind, sites, sitesFailing: failing, sitesMeasured: measured.length,
    sitesOverdue: sites.filter((site) => site.kind === "overdue").length,
    missing: sites.reduce((sum, site) => sum + site.missing, 0),
    incomplete: sites.reduce((sum, site) => sum + site.incomplete, 0),
  };
}

/**
 * One data source on one asset: that site's status for the provider's work on
 * this lane. A connected provider with nothing scheduled for this asset has not
 * connected this asset; `items === null` means the monitoring read is missing,
 * which is Unknown, never Not connected.
 */
export function sourceStatus(
  credential: CredentialSummary | null | undefined,
  items: IntegrationHealthItem[] | null,
  asset: string,
  lane: string,
): { kind: ConnectionKind; site: SiteStatus | null } {
  if (credential === undefined || items === null) return { kind: "unknown", site: null };
  if (credential === null || connectionState(credential) === "not-connected") return { kind: "not-connected", site: null };
  const own = items.filter((item) => item.asset === asset && item.state !== "disconnected" && itemLanes(item).includes(lane));
  const site = siteStatus(asset, own);
  if (site) return { kind: site.kind, site };
  return { kind: connectionState(credential) === "failing" ? "failing" : "not-connected", site: null };
}

/**
 * A register cell read in the same vocabulary, for a data source no provider
 * credential collects (the nightly report, uptime, affiliate revenue…): proof
 * of a recent success is Working, a late nightly report is Overdue.
 */
export function registerKind(cell: IntegrationCellBase, nowMs: number): ConnectionKind | "not-applicable" {
  const state = connectionHealthState(cell, nowMs);
  return state === "live" ? "working"
    : state === "unverified" ? "not-checked"
      : state === "degraded" ? degradedKind(cell.laneId)
        : state === "needs-setup" ? "not-connected"
          : state === "skipped" ? "not-using"
            : "not-applicable";
}

/**
 * One data source on one asset, as every screen shows it. A declined or
 * inapplicable source is the register's decision; a provider's source is that
 * site's status for the provider's work on this lane; everything else is its
 * register cell. `credentials` undefined, or `items` null, means that read is
 * missing: Unknown, never Not connected.
 */
export function laneStatus(input: {
  laneId: string;
  assetId: string;
  cell: IntegrationCellBase;
  scope?: LaneScope;
  credentials: ReadonlyMap<string, CredentialSummary> | undefined;
  items: IntegrationHealthItem[] | null;
  nowMs: number;
}): { kind: ConnectionKind | "not-applicable"; site: SiteStatus | null; provider: string | null } {
  const { laneId, assetId, cell, scope, credentials, items, nowMs } = input;
  const provider = laneProvider(laneId);
  if (cell.effective === "not-applicable") return { kind: "not-applicable", site: null, provider };
  if (cell.effective === "skipped") return { kind: "not-using", site: null, provider };
  if (provider === null) return { kind: registerKind(cell, nowMs), site: null, provider };
  const credential = credentials === undefined ? undefined : credentials.get(provider) ?? null;
  if (scope === "portfolio") {
    if (credential === undefined || items === null) return { kind: "unknown", site: null, provider };
    return { kind: connectionStatus(provider, credential, items).kind, site: null, provider };
  }
  return { ...sourceStatus(credential, items, assetId, laneId), provider };
}

// --- one asset's sources, on every compact screen ------------------------------

/** The two reads every status is derived from: the stored credentials and the
 * monitoring items (`currentHealth`). A read that has not answered is
 * `undefined` / `null`, which the model reads as Unknown, never Not connected. */
export interface ConnectionReads {
  credentials: ReadonlyMap<string, CredentialSummary> | undefined;
  items: IntegrationHealthItem[] | null;
}

/** Neither read has answered: every provider's source is Unknown. */
export const NO_READS: ConnectionReads = { credentials: undefined, items: null };

/** What one source can read as: a connection status, or not applicable. */
export type SourceKind = ConnectionKind | "not-applicable";

/** One source slot of one asset, read through `laneStatus`. */
export interface SourceReading {
  id: string;
  label: string;
  kind: SourceKind;
  /** The provider site behind a provider's source; null for anything else. */
  site: SiteStatus | null;
  provider: string | null;
  /** The register's own sentence, for a source no provider collects. */
  detail: string | null;
  /** When that register evidence was observed. */
  observedAt: string | null;
}

/**
 * One asset's sources as the header, Home, the Wall and the setup checklist
 * show them. Each card slot is read by `laneStatus` over the same credentials
 * and monitoring items the Data sources rows use. The payload's slot
 * contributes only its register cell: its scope decision, and the proof for a
 * source no provider collects.
 */
export function sourceReadings(
  assetId: string,
  sources: readonly CardDataSource[],
  reads: ConnectionReads,
  nowMs: number,
): SourceReading[] {
  return sources.map((source) => {
    const { kind, site, provider } = laneStatus({
      laneId: source.id, assetId, cell: cardSourceCell(source, assetId),
      credentials: reads.credentials, items: reads.items, nowMs,
    });
    return {
      id: source.id, label: source.label, kind, site, provider,
      detail: source.detail ?? null, observedAt: source.observedAt ?? null,
    };
  });
}

/** How an asset's sources add up: each status's count, the one tally line,
 * and the worst thing waiting on the operator. */
export interface SourcesSummary {
  counts: Record<SourceKind, number>;
  /** "5 working · 1 failing · 1 not connected", zero counts left out. */
  tally: string;
  /** A failing source is an error, an overdue one a warning. */
  attention: "error" | "warn" | null;
}

const TALLIED: readonly [SourceKind, string][] = [
  ["working", "working"], ["failing", "failing"], ["overdue", "overdue"], ["not-connected", "not connected"],
];

/** The one summary of a set of source statuses, wherever it is counted. */
export function sourcesSummary(readings: readonly { kind: SourceKind }[]): SourcesSummary {
  const counts = Object.fromEntries(
    ([...Object.keys(CONNECTION_LABELS).filter((kind) => kind !== "checking"), "not-applicable"] as SourceKind[]).map((kind) => [kind, 0]),
  ) as Record<SourceKind, number>;
  for (const { kind } of readings) counts[kind] += 1;
  return {
    counts,
    tally: TALLIED.filter(([kind]) => counts[kind] > 0).map(([kind, word]) => `${counts[kind]} ${word}`).join(" · "),
    attention: counts.failing > 0 ? "error" : counts.overdue > 0 ? "warn" : null,
  };
}

// --- the facts beside a status -----------------------------------------------

export type ConnectionFactKey = "sites-failing" | "sites-overdue" | "missing" | "incomplete" | "overdue";
export interface ConnectionFact {
  key: ConnectionFactKey;
  count: number;
  label: string;
  tone: "critical" | "caution" | "neutral";
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The compact facts a status carries, each shown once beside it: which sites
 * fail while the connection works, how many report dates are missing or came
 * back incomplete. A connection that fails on every site says so in its status
 * alone.
 */
export function connectionFacts(status: ConnectionStatus | SiteStatus): ConnectionFact[] {
  const facts: ConnectionFact[] = [];
  if ("sites" in status) {
    const partial = status.sitesFailing > 0 && !(status.kind === "failing" && status.sitesFailing === status.sitesMeasured);
    if (partial) facts.push({ key: "sites-failing", count: status.sitesFailing, label: plural(status.sitesFailing, "site failing", "sites failing"), tone: "critical" });
    if (status.sitesOverdue > 0 && status.kind !== "overdue") facts.push({ key: "sites-overdue", count: status.sitesOverdue, label: plural(status.sitesOverdue, "site overdue", "sites overdue"), tone: "caution" });
  } else if (status.overdue > 0) {
    facts.push({ key: "overdue", count: status.overdue, label: plural(status.overdue, "report overdue", "reports overdue"), tone: "caution" });
  }
  if (status.missing > 0) facts.push({ key: "missing", count: status.missing, label: plural(status.missing, "report missing", "reports missing"), tone: "caution" });
  if (status.incomplete > 0) facts.push({ key: "incomplete", count: status.incomplete, label: plural(status.incomplete, "report incomplete", "reports incomplete"), tone: "neutral" });
  return facts;
}

/**
 * The four counts System health's Connections strip states: sites whose
 * latest attempt failed, sites past their schedule, reports not yet
 * re-collected, and sites whose latest attempt worked — across every
 * provider's status. One derivation, so today's number and its daily record
 * count the same things.
 */
export interface ConnectionCounts {
  sitesFailing: number;
  sitesOverdue: number;
  reportsMissing: number;
  sitesWorking: number;
}

export function connectionCounts(statuses: readonly ConnectionStatus[]): ConnectionCounts {
  const sites = statuses.flatMap((status) => status.sites);
  const kind = (wanted: SiteKind) => sites.filter((site) => site.kind === wanted).length;
  return {
    sitesFailing: kind("failing"),
    sitesOverdue: kind("overdue"),
    reportsMissing: sites.reduce((sum, site) => sum + site.missing, 0),
    sitesWorking: kind("working"),
  };
}

/** A provider the store answered for, with its stored credential — what
 * `/api/integrations/providers` lists and what the recorder reads itself. */
export interface ProviderCredential {
  provider: { id: string; companionOf?: string };
  credential: CredentialSummary;
}

/**
 * Every connection System health lists, each with its one status: the
 * providers the store answered for, a companion (the Google OAuth app) folded
 * into the provider it serves. The Connections panel and the daily recorder
 * both count through this and `connectionCounts`.
 */
export function providerStatuses<T extends ProviderCredential>(
  providers: readonly T[],
  items: IntegrationHealthItem[],
): { entry: T; status: ConnectionStatus }[] {
  return providers
    .filter((entry) => entry.provider.companionOf === undefined)
    .map((entry) => ({ entry, status: connectionStatus(entry.provider.id, entry.credential, items) }));
}

/** The four counts in the order the strip states them. */
export const CONNECTION_COUNT_KEYS = ["sitesFailing", "sitesOverdue", "reportsMissing", "sitesWorking"] as const satisfies readonly (keyof ConnectionCounts)[];

/** The four counts, day by day, as `/api/integrations/health` carries them.
 * `days: 0..2` is a record too short to draw. */
export interface ConnectionCountsHistory {
  days: number;
  series: Record<keyof ConnectionCounts, SeriesPoint[]>;
}

/** What `/api/integrations/health` answers: the ingest's health read, plus the
 * strip's history when the Tower could read its record. */
export type IntegrationHealthResponse = IntegrationHealthPayload & {
  countsHistory?: ConnectionCountsHistory;
};

/** A daily line needs three points before it is a shape rather than a segment. */
export const CONNECTION_HISTORY_MIN_DAYS = 3;

/** Why the four counts draw no series: the hourly tick has not recorded a
 * day yet, or no history came. */
export const CONNECTION_HISTORY_GAP = "No daily record of these counts yet";

/** The reason a strip KPI draws no line, or null when it draws one. */
export function connectionHistoryGap(history: ConnectionCountsHistory | null | undefined): string | null {
  if (!history || history.days === 0) return CONNECTION_HISTORY_GAP;
  if (history.days < CONNECTION_HISTORY_MIN_DAYS) return `Only ${history.days} ${history.days === 1 ? "day" : "days"} recorded`;
  return null;
}

export function needsOperator(status: ConnectionStatus): number {
  const sites = status.sitesFailing + status.sitesOverdue;
  return sites > 0 ? sites : status.kind === "failing" || status.kind === "overdue" ? 1 : 0;
}
