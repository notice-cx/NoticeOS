// @vitest-environment node
// What the Wall lists as broken (docs/25-the-wall.md § Needs you and § Site
// rows; beads `ro-trai.4`, `ro-trai.5`): one ordered list that Needs you states
// as sentences and a site row as one short mark.

import { describe, expect, it } from "vitest";
import type { CredentialSummary, IntegrationHealthItem } from "@noticeos/contract";
import { NO_READS, type ConnectionReads } from "@shared/connection-status";
import type { AssetCard, AttentionItem, CardDataSource } from "@shared/wall";
import { alertMark, needsYouRows, siteMark, wallIssues } from "@/lib/wall-issues";

const NOW = Date.parse("2026-09-22T19:30:00.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const ZERO = { currency: 'USD', revenue: 0, cost: 0, net: 0 };
const NO_TREND = { series: [], provisionalFrom: null, collectedAt: null, timeZoneChanges: [] };

function source(id: string, state: CardDataSource["state"] = "live"): CardDataSource {
  return { id, label: id, state, observedAt: ago(20 * MINUTE) };
}

function asset(id: string, displayName: string, over: Partial<AssetCard> = {}): AssetCard {
  return { netByMonthCurrency: 'USD',
    id, displayName, status: "live", senseOnly: false, worstSeverity: null, openError: 0, openWarn: 0,
    booked: ZERO, forecast: ZERO, netPeriod: "2026-09",
    pulseReceivedAt: ago(17 * HOUR), firstReportAt: ago(80 * 24 * HOUR), reportDays: 28,
    dataSources: [source("nightly-report"), source("ga4")],
    activeUsers: NO_TREND, searchClicks: NO_TREND, netByMonth: [], netByMonthProvisionalFrom: null,
    work: null, panelReview: null, latestPanelDate: null,
    ...over,
  };
}

let nextId = 100;
function alert(over: Partial<AttentionItem>): AttentionItem {
  nextId += 1;
  return {
    id: nextId, asset: "meals.example", assetDisplayName: "Meal Planner", severity: "warn", kind: "anomaly",
    message: "19 in last24h", firedAt: ago(2 * HOUR), metric: "plansSaved", ruleId: "flow-poisson-low",
    ruleInputs: { metric: "plansSaved", observed: 19, baselinePerDay: 58.2, alpha: 0.01, pLowerTail: 0.000004 },
    correlatedChanges: [], occurrences: 1, firstFiredAt: ago(2 * HOUR),
    ...over,
  };
}

const homeDown = (asset: string, name: string, minutesAgo: number) =>
  alert({
    asset, assetDisplayName: name, severity: "error", ruleId: "hygiene-home-unreachable", metric: "home",
    message: "home page did not serve", ruleInputs: { url: `https://${asset}/`, http_status: 503 },
    firedAt: ago(minutesAgo * MINUTE), firstFiredAt: ago(minutesAgo * MINUTE),
  });

const neverReported = (members: [string, string][]) =>
  alert({
    asset: members[0]![0], assetDisplayName: members[0]![1], severity: "error", ruleId: "ingest-freshness",
    metric: "pulse", message: "no pulse ever received", ruleInputs: { rule: "ingest-freshness", state: "never-reported" },
    firstFiredAt: ago(20 * 24 * HOUR), occurrences: members.length,
    members: members.map(([id, name], index) => ({ id: 500 + index, asset: id, assetDisplayName: name, firedAt: ago(20 * 24 * HOUR) })),
  });

const SITES = [asset("meals.example", "Meal Planner"), asset("nosh.example", "Nosh"), asset("areas.example", "Area Lookup")];

describe("the Wall's issue list", () => {
  it("alerts calendar failures, warns on partial reads, and stays quiet while loading", () => {
    const input = { assets: [], attention: [], connections: NO_READS, nowMs: NOW };
    expect(wallIssues({ ...input, calendarState: "failed" })).toEqual([
      expect.objectContaining({ key: "calendar-read", severity: "error", site: "Calendar", assets: [] }),
    ]);
    expect(wallIssues({ ...input, calendarState: "partial" })).toEqual([
      expect.objectContaining({ key: "calendar-read", severity: "warn" }),
    ]);
    expect(wallIssues({ ...input, calendarState: "loading" })).toEqual([]);
    expect(wallIssues({ ...input, calendarState: "retrying" })).toEqual([]);
    expect(wallIssues(input)).toEqual([]);
  });
  it("puts errors before warnings and the newest first within each", () => {
    const issues = wallIssues({
      assets: SITES,
      attention: [alert({}), homeDown("areas.example", "Area Lookup", 25), homeDown("nosh.example", "Nosh", 90)],
      connections: NO_READS,
      nowMs: NOW,
    });
    expect(issues.map((issue) => [issue.severity, issue.site])).toEqual([
      ["error", "Area Lookup"],
      ["error", "Nosh"],
      ["warn", "Meal Planner"],
    ]);
    expect(issues[0]).toMatchObject({ line: expect.stringContaining("Home page"), mark: "Home page down" });
  });

  it("keeps a multi-site alert as one row about every site it names", () => {
    const issues = wallIssues({
      assets: SITES,
      attention: [neverReported([["nosh.example", "Nosh"], ["areas.example", "Area Lookup"]])],
      connections: NO_READS,
      nowMs: NOW,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      site: "2 sites",
      assets: ["nosh.example", "areas.example"],
      mark: "Report alert",
      conditions: ["open-flags"],
    });
    expect(siteMark(issues, "areas.example")).toEqual({ severity: "error", label: "Report alert", more: 0 });
  });

  it("shows the top three and counts the rest", () => {
    const issues = wallIssues({
      assets: SITES,
      attention: [alert({}), alert({ firedAt: ago(HOUR), firstFiredAt: ago(HOUR) }), homeDown("nosh.example", "Nosh", 10), homeDown("areas.example", "Area Lookup", 5)],
      connections: NO_READS,
      nowMs: NOW,
    });
    const rows = needsYouRows(issues);
    expect(rows.total).toBe(4);
    expect(rows.shown.map((issue) => issue.site)).toEqual(["Area Lookup", "Nosh", "Meal Planner"]);
  });

  it("names a rollback failure as its own condition", () => {
    const issues = wallIssues({
      assets: SITES,
      attention: [alert({ severity: "error", ruleId: "watch-window-closed", metric: "clicks", ruleInputs: { outcome: "kill_confirmed" } })],
      connections: NO_READS,
      nowMs: NOW,
    });
    expect(issues[0]).toMatchObject({ mark: "Revert decision", conditions: ["open-flags", "rollback-failure"] });
  });

  it("marks a late nightly report, unless an alert already says so", () => {
    const late = asset("fees.example", "Fee Codes", { pulseReceivedAt: ago(62 * HOUR) });
    const alone = wallIssues({ assets: [late], attention: [], connections: NO_READS, nowMs: NOW });
    expect(alone).toEqual([
      expect.objectContaining({ severity: "warn", site: "Fee Codes", mark: "Report late", line: "No nightly report in 62h" }),
    ]);
    const flagged = wallIssues({
      assets: [late],
      attention: [alert({ asset: "fees.example", assetDisplayName: "Fee Codes", ruleId: "ingest-freshness", metric: "pulse", ruleInputs: { rule: "ingest-freshness", state: "stale", ageHours: 62, thresholdHours: 48 } })],
      connections: NO_READS,
      nowMs: NOW,
    });
    expect(flagged.map((issue) => issue.mark)).toEqual(["Report late"]);
    expect(flagged[0]?.key.startsWith("alert-")).toBe(true);
  });

  it("never marks a site that declared it sends no nightly report for a missing one (D29)", () => {
    const declared = asset("areas.example", "Area Lookup", { noNightlyReport: true, pulseReceivedAt: ago(9 * 24 * HOUR) });
    const issues = wallIssues({
      assets: [asset("nosh.example", "Nosh"), declared],
      attention: [
        alert({ asset: "areas.example", assetDisplayName: "Area Lookup", ruleId: "ingest-freshness", metric: "pulse", ruleInputs: { state: "stale" } }),
        neverReported([["nosh.example", "Nosh"], ["areas.example", "Area Lookup"]]),
      ],
      connections: NO_READS,
      nowMs: NOW,
    });
    expect(siteMark(issues, "areas.example")).toBeNull();
    // The group keeps the member that does owe a report, and says so of it alone.
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ site: "Nosh", assets: ["nosh.example"] });
  });

  it("marks a failing source by its short name, once for every site it fails on", () => {
    const credential: CredentialSummary = {
      provider: "google", source: "store", fields: [], assetsHeld: [], missingFields: [], auth: null, metadata: null,
      keyVersion: 1, createdAt: ago(40 * 24 * HOUR), updatedAt: ago(40 * 24 * HOUR), lastUsedAt: ago(HOUR), lastOkAt: ago(HOUR), lastError: null,
    };
    const failing = (asset: string): IntegrationHealthItem => ({
      id: `ga4-${asset}`, provider: "google", capability: "ga4-daily", label: "Analytics daily reports", asset, detail: null, report: null, reportDate: null,
      state: "failing", lastAttemptAt: ago(10 * MINUTE), lastSuccessAt: ago(3 * HOUR), nextAttemptAt: null,
      failure: "access", code: "access", action: "Review.", coverage: "monitored",
    });
    const connections: ConnectionReads = {
      credentials: new Map([["google", credential]]),
      items: [failing("nosh.example"), failing("areas.example")],
    };
    const issues = wallIssues({ assets: SITES, attention: [], connections, nowMs: NOW });
    expect(issues).toEqual([
      expect.objectContaining({ severity: "error", site: "2 sites", line: "GA4 collection failing", mark: "GA4 failing", since: ago(3 * HOUR) }),
    ]);
    expect(siteMark(issues, "nosh.example")).toEqual({ severity: "error", label: "GA4 failing", more: 0 });
    expect(siteMark(issues, "meals.example")).toBeNull();
  });

  it("gives a site one mark for its worst, newest problem and counts the rest", () => {
    const issues = wallIssues({
      assets: SITES,
      attention: [alert({ asset: "areas.example", assetDisplayName: "Area Lookup" }), homeDown("areas.example", "Area Lookup", 25)],
      connections: NO_READS,
      nowMs: NOW,
    });
    expect(siteMark(issues, "areas.example")).toEqual({ severity: "error", label: "Home page down", more: 1 });
    expect(siteMark(issues, "meals.example")).toBeNull();
  });

  it("names every alert rule in three words or fewer", () => {
    for (const ruleId of ["flow-poisson-low", "flow-lowvol-window", "flow-pct-drop", "asset-declared", "ingest-freshness", "asset-pull-failed", "hygiene-home-unreachable", "hygiene-sitemap", "os-egress-down", "watch-window-closed", "a-rule-nobody-knows"]) {
      const mark = alertMark(alert({ ruleId, metric: "averageSessionDurationSeconds" }));
      expect(mark.split(" ").length, `${ruleId} → ${mark}`).toBeLessThanOrEqual(3);
    }
    expect(alertMark(alert({}))).toBe("Plans saved low");
  });
});
