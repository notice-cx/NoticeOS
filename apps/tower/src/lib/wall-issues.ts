// What is broken, once, for the two Wall widgets that say so. "Needs you"
// states each problem as a sentence with its site and age; a site row states
// the same problems as one mark of at most three words with "+N" for the
// rest. Both read the list this module builds, so a row can never be marked
// for something Needs you does not name.
//
// What counts (all of it material state, `shared/materiality.ts`): open
// error/warn alerts as the payload grouped them; a source whose collection is
// failing, one row per source kind (`failingSources`); a nightly report past
// twice its cadence, unless an open alert already says so, and never for a
// site that declared it sends none; a weekly review past its due date.
//
// The mark is named from the rule, never truncated from the alert sentence.

import { owesNightlyReport } from "@noticeos/contract/reporting";
import { humanizeMetric, translateAlert } from "@shared/alert-language";
import { sourceReadings, type ConnectionReads } from "@shared/connection-status";
import { isAmber } from "@shared/freshness";
import type { CalendarReadState } from "@/lib/meetings";
import {
  AMBER_MULTIPLIER,
  CADENCE_HOURS,
  panelReviewNouns,
  panelReviewState,
  type AssetCard,
  type AttentionItem,
} from "@shared/wall";

export type WallIssueSeverity = "error" | "warn";

/** The material conditions a Needs you row can carry (`shared/materiality.ts`). */
export type WallIssueCondition = "open-flags" | "rollback-failure" | "signal-freshness" | "os-runner-health" | "scheduled-lane-health" | "budget-guardrail";

export interface WallIssue {
  key: string;
  severity: WallIssueSeverity;
  /** The site ids this problem is about. */
  assets: string[];
  /** The site's name, or "4 sites" for one fact about several. */
  site: string;
  /** The problem as a sentence, for Needs you. */
  line: string;
  /** The problem in at most three words, for a site row's mark. */
  mark: string;
  /** When the problem began, as far as the store can tell; null when unknown. */
  since: string | null;
  conditions: WallIssueCondition[];
  /** The alert id behind an alert row, for a stable React key. */
  flagId?: number;
}

/** Source ids as the TV names them: the provider's own short name. */
const SOURCE_SHORT: Readonly<Record<string, string>> = {
  ga4: "GA4",
  gsc: "Search Console",
  "bing-webmaster": "Bing",
  clarity: "Clarity",
  posthog: "PostHog",
  dataforseo: "DataForSEO",
  uptime: "Uptime",
};

/** The nightly report's slot. Its lateness is the "Report late" rule below;
 * its source reading would say the same thing twice. */
const NIGHTLY_SLOT = "nightly-report";

const HOUR_MS = 3_600_000;

function isRollbackFailure(item: AttentionItem): boolean {
  return item.ruleId === "watch-window-closed" && item.ruleInputs?.outcome === "kill_confirmed";
}

/** "Plans saved low", or a two-word fallback when the metric's own name would
 * push the mark past three words. */
function metricLow(metric: string | null): string {
  const words = metric ? humanizeMetric(metric) : "";
  if (!words || words.split(" ").length > 2) return "Signal low";
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} low`;
}

/** An alert's mark, by rule id. Every label is three words or fewer. */
export function alertMark(item: Pick<AttentionItem, "ruleId" | "ruleInputs" | "metric" | "kind" | "message">): string {
  const metric = typeof item.ruleInputs?.metric === "string" ? item.ruleInputs.metric : item.metric;
  switch (item.ruleId) {
    case "flow-poisson-low":
    case "flow-lowvol-window":
    case "flow-pct-drop":
      return metricLow(metric);
    case "asset-declared":
      return translateAlert({ ...item, members: undefined }).headline.includes("below normal")
        ? metricLow(metric)
        : "Site alert";
    case "ingest-freshness":
      return item.ruleInputs?.state === "stale" ? "Report late" : "Report alert";
    case "asset-pull-failed":
      return "Report pull failing";
    case "hygiene-home-unreachable":
      return "Home page down";
    case "hygiene-sitemap":
      return "Sitemap failing";
    case "os-egress-down":
      return "Connection down";
    case "watch-window-closed":
      return item.ruleInputs?.outcome === "kill_confirmed" ? "Revert decision" : "Outcome ready";
    default:
      return item.kind === "opportunity" ? "Opportunity" : "Alert open";
  }
}

function siteLabel(names: readonly string[]): string {
  return names.length === 1 ? names[0]! : `${names.length} sites`;
}

/** One failing source kind: the sites it fails on, and its oldest onset. */
export interface FailingSource {
  assets: AssetCard[];
  since: string | null;
}

/**
 * The failing sources, one entry per source kind: a provider failing on five
 * sites is one thing to fix, not five. The nightly report's slot is left out;
 * its lateness is "Report late" and the strip's "reports stale". Needs you
 * lists one row per entry and the strip's "N sources failing" is the number
 * of entries (`failingSourceCount`), so the two can never disagree.
 */
export function failingSources(
  assets: readonly AssetCard[],
  connections: ConnectionReads,
  nowMs: number,
): Map<string, FailingSource> {
  const failing = new Map<string, FailingSource>();
  for (const asset of assets) {
    for (const reading of sourceReadings(asset.id, asset.dataSources, connections, nowMs)) {
      if (reading.kind !== "failing" || reading.id === NIGHTLY_SLOT) continue;
      const since = reading.site?.lastSuccessAt ?? reading.site?.failure?.lastAttemptAt ?? reading.observedAt;
      const entry = failing.get(reading.id) ?? { assets: [], since: null };
      entry.assets.push(asset);
      // The group is as old as its oldest onset.
      if (since && (entry.since === null || since < entry.since)) entry.since = since;
      failing.set(reading.id, entry);
    }
  }
  return failing;
}

export interface WallIssueInputs {
  assets: readonly AssetCard[];
  attention: readonly AttentionItem[];
  /** The credentials and monitoring reads every source status comes from. */
  connections: ConnectionReads;
  calendarState?: CalendarReadState;
  nowMs: number;
}

/**
 * Every open problem, errors first, then newest first within a severity (the
 * order Needs you shows and a site's mark takes its label from). A problem
 * whose onset is unknown sorts after the dated ones of its severity.
 */
export function wallIssues({ assets, attention, connections, calendarState, nowMs }: WallIssueInputs): WallIssue[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const declared = (id: string) => byId.get(id)?.noNightlyReport === true;
  const issues: WallIssue[] = [];
  if (calendarState === "failed" || calendarState === "partial") {
    issues.push({
      key: "calendar-read",
      severity: calendarState === "failed" ? "error" : "warn",
      assets: [], site: "Calendar",
      line: calendarState === "failed" ? "Events not updating · check Integrations" : "Some feeds unavailable · check Integrations",
      mark: "Calendar not updating", since: null, conditions: ["signal-freshness"],
    });
  }
  // Sites an open alert already reports as late or silent: the alert is the row.
  const reportAlerted = new Set<string>();

  for (const item of attention) {
    if (item.severity !== "error" && item.severity !== "warn") continue;
    const members = item.members && item.members.length > 1 ? item.members : null;
    let ids = members ? members.map((member) => member.asset) : [item.asset];
    let names = members ? members.map((member) => member.assetDisplayName) : [item.assetDisplayName];
    // A site that declared it sends no nightly report is never marked for a
    // missing one, even by an alert that fired before the declaration.
    if (item.ruleId === "ingest-freshness") {
      const kept = ids.map((id, index) => ({ id, name: names[index]! })).filter(({ id }) => !declared(id));
      if (kept.length === 0) continue;
      ids = kept.map(({ id }) => id);
      names = kept.map(({ name }) => name);
      for (const id of ids) reportAlerted.add(id);
    }
    const shownMembers = members?.filter((member) => ids.includes(member.asset));
    issues.push({
      key: `alert-${item.id}`,
      flagId: item.id,
      severity: item.severity,
      assets: ids,
      site: siteLabel(names),
      line: translateAlert({ ...item, members: shownMembers && shownMembers.length > 1 ? shownMembers : undefined }).headline,
      mark: alertMark(item),
      since: item.firstFiredAt ?? item.firedAt,
      conditions: [
        "open-flags",
        ...(isRollbackFailure(item) ? (["rollback-failure"] as const) : []),
      ],
    });
  }

  for (const [source, entry] of failingSources(assets, connections, nowMs)) {
    const name = SOURCE_SHORT[source] ?? source;
    issues.push({
      key: `source-${source}`,
      severity: "error",
      assets: entry.assets.map((asset) => asset.id),
      site: siteLabel(entry.assets.map((asset) => asset.displayName)),
      line: `${name} collection failing`,
      mark: `${name} failing`,
      since: entry.since,
      conditions: ["signal-freshness"],
    });
  }

  for (const asset of assets) {
    const received = asset.pulseReceivedAt;
    if (
      received !== null &&
      !reportAlerted.has(asset.id) &&
      owesNightlyReport(asset.status, asset.noNightlyReport === true, received) &&
      isAmber(nowMs, received, CADENCE_HOURS.pulse)
    ) {
      const receivedMs = Date.parse(received);
      issues.push({
        key: `report-${asset.id}`,
        severity: "warn",
        assets: [asset.id],
        site: asset.displayName,
        line: `No nightly report in ${Math.floor((nowMs - receivedMs) / HOUR_MS)}h`,
        mark: "Report late",
        since: new Date(receivedMs + CADENCE_HOURS.pulse * AMBER_MULTIPLIER * HOUR_MS).toISOString(),
        conditions: ["signal-freshness"],
      });
    }
    if (panelReviewState(asset.panelReview, asset.latestPanelDate, nowMs) === "overdue") {
      issues.push({
        key: `review-${asset.id}`,
        // The review badge's own tone for a missed due date (PanelReviewBadge).
        severity: "error",
        assets: [asset.id],
        site: asset.displayName,
        line: `${panelReviewNouns(asset.panelReview).label} review overdue`,
        mark: "Review overdue",
        since: asset.panelReview?.dueAt ?? null,
        conditions: [],
      });
    }
  }

  return issues.sort(compareIssues);
}

export function compareIssues(a: WallIssue, b: WallIssue): number {
  if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
  const at = (issue: WallIssue) => (issue.since ? Date.parse(issue.since) : Number.NaN);
  const left = at(a);
  const right = at(b);
  if (Number.isNaN(left) || Number.isNaN(right)) {
    return Number.isNaN(left) === Number.isNaN(right) ? 0 : Number.isNaN(left) ? 1 : -1;
  }
  return right - left;
}

/** Needs you's rows: the first `limit` of the ordered list, and the total. */
export function needsYouRows(issues: readonly WallIssue[], limit = 3): { shown: WallIssue[]; total: number } {
  return { shown: issues.slice(0, limit), total: issues.length };
}

export interface SiteMark {
  severity: WallIssueSeverity;
  label: string;
  /** How many more problems this site has beyond the one named. */
  more: number;
}

/** A site row's one mark, or null when nothing on it is broken. It names the
 * worst, newest problem — the one Needs you would list first for this site. */
export function siteMark(issues: readonly WallIssue[], assetId: string): SiteMark | null {
  const mine = issues.filter((issue) => issue.assets.includes(assetId));
  const first = mine[0];
  return first ? { severity: first.severity, label: first.mark, more: mine.length - 1 } : null;
}
