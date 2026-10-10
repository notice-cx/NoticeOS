// @vitest-environment node
//
// The Wall's live feed: one stored row per source, placed around the window
// (6 PM yesterday in the OS time zone), stated once each, newest first, with
// the three fold rules and nothing outside the window. The query half: a fixed
// number of statements per request, every event table searched through an index.

import type { SqlValue, WorkspaceStore } from "@noticeos/postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookLedger, writeMediavine } from "./money";
import {
  FEED_ANNOTATIONS_SQL,
  FEED_CONFIG_SQL,
  FEED_DUMPS_SQL,
  FEED_FLAGS_FIRED_SQL,
  FEED_FLAGS_RESOLVED_SQL,
  FEED_HEALTH_SQL,
  FEED_HYGIENE_SQL,
  FEED_INSIGHTS_SQL,
  FEED_JOBS_SQL,
  FEED_LEDGER_SQL,
  FEED_MEDIAVINE_RUNS_SQL,
  FEED_PULSES_SQL,
  FEED_RESEARCH_SQL,
  FEED_REVENUE_SQL,
  FEED_SIGNAL_FAILURES_SQL,
  FEED_SIGNAL_LATEST_SQL,
  FEED_TASKS_SQL,
  buildWallFeed,
  handleWallFeedRequest,
} from "../worker/wall-feed";
import { WALL_FEED_KINDS, feedSentence, feedWindowStart, feedWordCount, type WallFeedItem } from "../shared/wall-feed";
import { osDeployAnnotation } from "../../../scripts/os-deploy-events.mjs";
import { type AlertRow, storeAlerts, storeReports } from "./alert-rows";
import { writeSignalRun } from "./collected-metrics";
import { storeChanges } from "./change-rows";
import { createTestStore, type TestStore, postgresUnavailable, recordingStore } from "./postgres-store";

import { writeArchiveRuns, writeInsightSnapshots, writeResearch, type TestArchiveRun, type TestInsightSnapshot } from "./provider-reports";
import { addSites } from "./sites";

/** 12:30 PDT on Tuesday 22 September — the Wall fixture's own clock. */
const NOW = new Date("2026-09-22T19:30:00.000Z");
const ZONE = "America/Los_Angeles";
/** 6 PM PDT on Monday 21 September. */
const SINCE = "2026-09-22T01:00:00.000Z";
const at = (hhmm: string, day = "2026-09-22") => `${day}T${hhmm}:00.000Z`;

/** A site, in both of the test's stores (test/sites.ts). */
async function asset(raw: TestStore, id: string, name: string, isOs = 0): Promise<void> {
  await addSites(raw, [{ id, displayName: name, status: "live", senseOnly: 0, isOs, createdAt: "2026-01-01T00:00:00.000Z" }]);
}

function flag(a: string, firedAt: string, message: string, severity = "warn", resolvedAt: string | null = null): AlertRow {
  return { asset: a, firedAt, severity, kind: "anomaly", metric: null, message, ruleId: "feed-test-rule", ruleInputs: null, resolvedAt };
}

/** One collection run; the store must already hold its site. */
async function signalRun(store: WorkspaceStore, id: string, a: string, integration: "ga4" | "gsc" | "bing-webmaster", finishedAt: string, ok = true): Promise<void> {
  await writeSignalRun(store, {
    id, asset: a, integration, credentialRef: "cred", propertyRef: "prop", finishedAt, status: ok ? "success" : "error",
    windowStart: "2026-09-01", windowEnd: "2026-09-21", providerRows: 0, observationCount: 0,
    errorCode: ok ? null : "403", errorMessage: ok ? null : "denied",
  });
}

/** One provider report run, as `seedProviderReports` writes it. */
function dump(id: string, a: string, integration: string, finishedAt: string, costUsd: number, ok = true): TestArchiveRun {
  return {
    id, asset: a, integration, report: "report", credential_ref: "cred", property_ref: "prop", report_date: "2026-09-21",
    finished_at: finishedAt, status: ok ? "success" : "error", provider_rows: 1, request_count: 1, object_key: `obj/${id}`,
    object_bytes: 10, error_code: "provider", error_message: "failed", provider_cost_usd: costUsd,
  };
}

/** A source's transition, with the target it is about. */
async function health(pg: TestStore, eventId: string, provider: string, capability: string, a: string, recordedAt: string,
  kind: "failed" | "recovered", evidenceSource: string, evidenceId: string): Promise<void> {
  await pg.call.write(async (tx) => {
    const [target] = await tx.query<{ seq: string }>(
      `INSERT INTO noticeos.capability_targets (workspace_id, provider, connection_revision, capability, asset_id, target_id, family)
       VALUES ($1, $2, 'rev', $3, $4, 'target', '') RETURNING target_seq::text AS seq`,
      [tx.workspaceId, provider, capability, a],
    );
    const failure = kind === "failed" ? "access" : null;
    await tx.execute(
      `INSERT INTO noticeos.integration_health_events (workspace_id, event_id, target_seq, attempt_id, started_at, recorded_at,
         kind, failure_kind, safe_code, evidence_source, evidence_id)
       VALUES ($1, $2, $3::bigint, $4, $5::timestamptz, $5::timestamptz, $6, $7, $8, $9, $10)`,
      [tx.workspaceId, eventId, target!.seq, `attempt-${eventId}`, recordedAt, kind, failure, failure, evidenceSource, evidenceId],
    );
  });
}

/** A task-hub photograph. */
async function snapshot(
  store: WorkspaceStore,
  capturedAt: string,
  closed: Record<string, [string, string, string][]>,
  created: Record<string, [string, string, string][]> = {},
): Promise<void> {
  // The shape the store keeps for a photograph a newer one replaced
  // (supersededPayload, workers/ingest/src/beads-snapshots.ts): only the two
  // lists the feed reads, each item its id, title and time.
  const projects = [...new Set([...Object.keys(closed), ...Object.keys(created)])].map((a) => ({
    asset: a, ok: true,
    counts: { open: 0, ready: 0, inProgress: 0, blocked: 0, closedRecent: closed[a]?.length ?? 0 },
    recentlyClosed: (closed[a] ?? []).map(([id, title, closedAt]) => ({ id, title, closedAt })),
    ...(created[a]
      ? { recentlyCreated: created[a].map(([id, title, createdAt]) => ({ id, title, createdAt })) }
      : {}),
  }));
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.task_snapshots (workspace_id, captured_at, payload) VALUES ($1::uuid, $2::timestamptz, $3::jsonb)`,
      [tx.workspaceId, capturedAt, JSON.stringify({ projects })],
    ),
  );
}

function insight(id: string, a: string, generatedAt: string, findings: [string, string][]): TestInsightSnapshot {
  return { id, asset: a, generated_at: generatedAt, payload: JSON.stringify({ items: findings.map(([key, title]) => ({ key, title })) }) };
}

/**
 * The fixture, newest first as the feed must state it (UTC; PDT is −7h):
 *
 *   19:24 task done      Recipes   (seen in two photographs)
 *   19:11 new task       Menus     (filed; in two photographs)
 *   18:59 collected      Google · 3 sites, none failed (18:44 run superseded)
 *   18:40 source failed  Codes (health event + its failed run: one line)
 *   18:38 task done      Codes
 *   18:15 new finding    Recipes   (the newest analysis's new key)
 *   18:15 insights       refreshed for 2 sites
 *   18:00 collected      Bing · Menus (the run that brought it back)
 *   18:00 source back    Menus
 *   17:30 alert          Recipes
 *   16:15 revenue        2 sites reported $55.25 for Sep 21
 *   16:14 collected      Mediavine · 2 sites, none failed
 *   16:00 resolved       Menus
 *   15:30 cost           DataForSEO · $0.12 for 1 lookup
 *   15:02 collected      DataForSEO · 2 sites, none failed
 *   15:02 cost           DataForSEO · $0.41 for 2 reports
 *   14:25 task done      Feed reads the store
 *   14:20 task done      Feed folds runs
 *   14:15 task done      Standards table loads
 *   14:00 source failed  Money (a failed PostHog report, no health event)
 *   13:00 cost           Booked $12.00 infra cost (NoticeOS)
 *   12:00 setting saved
 *   11:05 job failed     Backups
 *   11:00 collected      Site checks · Recipes
 *   10:00 nightly report 4 sites
 *   03:00 change         Menus (an incident annotation)
 *   02:40 deployed       NoticeOS (7:40 PM yesterday, inside the window)
 *
 * And outside it (00:30, before 6 PM PDT yesterday): an alert, a task, a
 * report, a deploy.
 */
async function seed(raw: TestStore): Promise<void> {
  // The OS row's stored name is one every line still reads as NoticeOS.
  await asset(raw, "os.example.com", "ReindexOS", 1);
  await asset(raw, "recipes.example.com", "Recipes");
  await asset(raw, "menus.example.com", "Menus");
  await asset(raw, "fitness.example.com", "Fitness");
  await asset(raw, "codes.example.com", "Codes");
  await asset(raw, "money.example.com", "Money");

}

/** Mediavine's revenue and the money booked, once the sites are there: two
 * sites reported Sep 21 (and revised Sep 20, which is not news), and the OS
 * booked its infra cost. */
async function seedMoney(store: WorkspaceStore): Promise<void> {
  await writeMediavine(store, ([["mv-mp", "recipes.example.com", 4110], ["mv-nom", "menus.example.com", 1415]] as const).map(([site, a, cents]) => ({
    id: `run-${site}`, asset: a, siteId: site, start: "2026-09-15", end: "2026-09-21", attemptedAt: at("16:14"),
    days: [["2026-09-20", 999], ["2026-09-21", cents]] as [string, number][], recordedAt: at("16:15"),
  })));
  await bookLedger(store, [{ kind: "cost", asset: "os.example.com", period: "2026-09", family: "infra", amount_minor: 1200,
    booking_state: "reconciled", recorded_at: at("13:00") }]);
}

/** The paid reports and lookups and the insights, in a store already holding
 * their sites. */
async function seedProviderReports(store: WorkspaceStore): Promise<void> {
  // DataForSEO paid reports, and a PostHog report that failed with no
  // transition recorded — still its own line.
  await writeArchiveRuns(store, [
    dump("d-mp", "recipes.example.com", "dataforseo", at("15:02"), 0.2),
    dump("d-nom", "menus.example.com", "dataforseo", at("15:01"), 0.21),
    dump("p-fin", "money.example.com", "posthog", at("14:00"), 0, false),
  ]);
  await writeResearch(store, [{
    asset: "recipes.example.com", endpoint: "labs/overview", params_sha256: "a".repeat(64), question: "overview",
    cost_usd: 0.12, actor: "collector", bought_at: at("15:30"),
  }]);
  // Insights: Recipes's newest analysis adds one finding; Menus's first ever.
  await writeInsightSnapshots(store, [
    insight("i-mp-old", "recipes.example.com", at("06:00", "2026-09-20"), [["k-a", "Sitemap steady"]]),
    insight("i-mp", "recipes.example.com", at("18:15"), [["k-a", "Sitemap steady"], ["k-b", "Recipe pages gained 40 clicks"]]),
    insight("i-nom", "menus.example.com", at("18:14"), [["k-c", "First look"]]),
  ]);
}

/** `seed`'s alerts and nightly reports, in a store already holding its sites. */
async function seedAlertsAndReports(store: WorkspaceStore): Promise<void> {
  // Alerts: one fired, one resolved, one fired before the window.
  await storeAlerts(store, [
    flag("recipes.example.com", at("17:30"), "Plans saved well below normal — 19 vs ~58/day"),
    flag("menus.example.com", at("10:00", "2026-09-21"), "Menu imports stalled", "error", at("16:00")),
    flag("menus.example.com", at("00:30"), "Old news from before the window"),
  ]);
  // Nightly reports for Sep 21 from four sites, and one from before the window.
  await storeReports(store, [
    ...["recipes.example.com", "menus.example.com", "codes.example.com", "os.example.com"].map((a) => ({
      asset: a, date: "2026-09-21", receivedAt: at("10:00"), envelope: {},
    })),
    { asset: "money.example.com", date: "2026-09-20", receivedAt: at("00:30"), envelope: {} },
  ]);
}

/** The fixture's collection runs: Google, two runs for Recipes (the older is
 * superseded), one each for Menus and Money, and Codes's failure; Bing, the
 * run that brought Menus back. */
async function seedSignalRuns(store: WorkspaceStore): Promise<void> {
  await signalRun(store, "g-mp-old", "recipes.example.com", "ga4", at("18:44"));
  await signalRun(store, "g-mp", "recipes.example.com", "ga4", at("18:59"));
  await signalRun(store, "g-mp-gsc", "recipes.example.com", "gsc", at("18:58"));
  await signalRun(store, "g-nom", "menus.example.com", "ga4", at("18:59"));
  await signalRun(store, "g-fin", "money.example.com", "ga4", at("18:58"));
  await signalRun(store, "g-ac-fail", "codes.example.com", "ga4", at("18:40"), false);
  await signalRun(store, "b-nom", "menus.example.com", "bing-webmaster", at("18:00"));
}

/** The seed's rows on Postgres: the collection runs, the paid reports and
 * lookups and the insights, two sources' transitions, the nightly site
 * checks, the alerts and nightly reports, the deploys and changes, the setting
 * saved at noon, the backup that failed at 11:05, and the task hub's photographs. */
async function seedPostgres(pg: TestStore): Promise<void> {
  await seedSignalRuns(pg.call);
  await seedProviderReports(pg.call);
  // The task hub: an early photograph holds three closures the newest no
  // longer does (five later ones pushed them out); ro-9 is in two.
  await snapshot(pg.call, at("14:30"), {
    "os.example.com": [["ro-9", "Feed reads the store", at("14:25")], ["ro-10", "Feed folds runs", at("14:20")], ["ro-0", "Before the window", at("00:30")]],
    "fitness.example.com": [["pft-1", "Standards table loads", at("14:15")]],
  });
  await snapshot(pg.call, at("16:00"), { "os.example.com": [["ro-9", "Feed reads the store", at("14:25")]] });
  // Newly filed work: one task inside the window, in two photographs; one
  // filed before it.
  await snapshot(pg.call, at("19:15"), {}, { "menus.example.com": [["mn-7", "Menu import skips closed restaurants", at("19:11")]] });
  await snapshot(pg.call, at("19:25"), {
    "recipes.example.com": [["mp-1", "Recipe cards load faster", at("19:24")]],
    "codes.example.com": [["ac-1", "Lookup page shows the local time", at("18:38")]],
  }, {
    "menus.example.com": [["mn-7", "Menu import skips closed restaurants", at("19:11")], ["mn-1", "Filed long ago", at("00:10")]],
  });
  await health(pg, "ev-ac", "google", "ga4-daily", "codes.example.com", at("18:40"), "failed", "signal_runs", "g-ac-fail");
  await health(pg, "ev-nom", "bing-webmaster", "bing-daily", "menus.example.com", at("18:00"), "recovered", "signal_runs", "b-nom");
  await seedAlertsAndReports(pg.call);
  // Deploys and changes: one before the window.
  await storeChanges(pg.call, [
    { asset: "os.example.com", at: at("02:40"), kind: "deploy", ref: "abc1234def" },
    { asset: "menus.example.com", at: at("03:00"), kind: "incident", note: "Checkout outage" },
    { asset: "menus.example.com", at: at("00:30"), kind: "deploy", ref: "old" },
  ]);
  await pg.store.inWorkspace(pg.workspaceId, (tx) =>
    tx.execute(
      `INSERT INTO noticeos.hygiene_checks (workspace_id, asset_id, check_id, observed_at, observed_on, status, value_num)
       SELECT $1::uuid, 'recipes.example.com', c.check_id, $2::timestamptz, '2026-09-22', 'ok', 1
         FROM unnest(ARRAY['html-depth', 'robots-ai-access', 'sitemap', 'page-structure']) AS c(check_id)`,
      [tx.workspaceId, at("11:00")],
    ),
  );
  await pg.store.inWorkspace(pg.workspaceId, async (tx) => {
    await tx.execute(
      `INSERT INTO noticeos.config_documents (workspace_id, document_key, body, version, updated_at, updated_by)
       VALUES ($1::uuid, 'tower', '{}', 2, $2::timestamptz, 'operator')`,
      [tx.workspaceId, at("12:00")],
    );
    await tx.execute(
      `INSERT INTO noticeos.config_changes (workspace_id, document_key, ops, reason, actor, version_before, version_after, changed_at)
       VALUES ($1::uuid, 'tower', '[]', 'Moved the feed to the right', 'operator', 1, 2, $2::timestamptz)`,
      [tx.workspaceId, at("12:00")],
    );
  });
  await pg.call.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.job_runs (workspace_id, job, started_at, finished_at, outcome, detail, recorded_at)
       VALUES ($1::uuid, 'backup', $2::timestamptz, $3::timestamptz, 'failed', 'disk full', $3::timestamptz)`,
      [tx.workspaceId, at("11:04"), at("11:05")],
    ),
  );
}

const DEPS = { now: NOW, osTimeZone: ZONE };
const unavailable = postgresUnavailable();
const needsPostgres = describe.skipIf(unavailable !== null);

describe("the feed's window", () => {
  it("opens at 6 PM yesterday in the OS time zone, across both DST changes", () => {
    expect(feedWindowStart(NOW, ZONE)).toBe(SINCE);
    expect(feedWindowStart(NOW, "UTC")).toBe("2026-09-21T18:00:00.000Z");
    // 1 AM PDT is still "today" there; yesterday's evening is the window.
    expect(feedWindowStart(new Date("2026-09-22T08:00:00.000Z"), ZONE)).toBe(SINCE);
    // The evening before the fall change is still PDT; before the spring one, PST.
    expect(feedWindowStart(new Date("2026-11-01T20:00:00.000Z"), ZONE)).toBe("2026-11-01T01:00:00.000Z");
    expect(feedWindowStart(new Date("2026-03-09T19:00:00.000Z"), ZONE)).toBe("2026-03-09T01:00:00.000Z");
    expect(feedWindowStart(new Date("2026-03-08T19:00:00.000Z"), ZONE)).toBe("2026-03-08T02:00:00.000Z");
    expect(feedWindowStart(NOW, "Not/AZone")).toBe("2026-09-21T18:00:00.000Z");
  });

  // The task store keeps two days of photographs for this window, sized on a
  // 31-hour reach (WALL_FEED_REACH_HOURS, workers/ingest/src/beads-snapshots.ts).
  // A longer reach would read photographs already pruned.
  it("never reaches back more than 31 hours, across a fall-back night", () => {
    let longest = 0;
    for (const zone of ["UTC", "America/Los_Angeles", "Australia/Lord_Howe", "Asia/Kathmandu"]) {
      const from = Date.parse(zone === "Australia/Lord_Howe" ? "2026-04-03T00:00:00.000Z" : "2026-10-30T00:00:00.000Z");
      for (let at = from; at < from + 5 * 86_400_000; at += 15 * 60_000) {
        longest = Math.max(longest, (at - Date.parse(feedWindowStart(new Date(at), zone))) / 3_600_000);
      }
    }
    expect(longest).toBeGreaterThan(30);
    expect(longest).toBeLessThanOrEqual(31);
  });

  it("cuts a line to twelve words", () => {
    expect(feedSentence("one two three")).toBe("one two three");
    const cut = feedSentence("The Tower serves one feed of what just happened across tasks, alerts, sources, collections and money");
    expect(feedWordCount(cut)).toBe(12);
    expect(cut.endsWith("…")).toBe(true);
  });
});

needsPostgres("buildWallFeed", () => {
  let ctx: TestStore;
  let pg: TestStore;
  beforeEach(async () => {
    ctx = await createTestStore();
    await seed(ctx);
    pg = ctx;
    await seedPostgres(pg);
    await seedMoney(pg.call);
  });
  afterEach(async () => {
    await pg.close();
  });

  const lines = (items: WallFeedItem[]) => items.map((item) => `${item.at.slice(11, 16)} ${item.kind} ${item.site ?? "-"} · ${item.text}`);

  it("states every source once, newest first, inside the window only, keeping tasks named", async () => {
    const feed = await buildWallFeed(pg.call, DEPS);
    expect(feed.since).toBe(SINCE);
    expect(lines(feed.items)).toEqual([
      "19:24 task-done Recipes · Recipe cards load faster",
      "19:11 task-filed Menus · Menu import skips closed restaurants",
      "18:59 collected - · Google · 3 sites, none failed",
      "18:40 source-failed Codes · Analytics daily reports: access denied",
      "18:38 task-done Codes · Lookup page shows the local time",
      "18:15 insights Recipes · Recipe pages gained 40 clicks",
      "18:15 insights - · Insights refreshed for 2 sites",
      "18:00 collected Menus · Bing · 1 site, none failed",
      "18:00 source-back Menus · Bing daily reports working again",
      "17:30 alert Recipes · Plans saved well below normal",
      "16:15 revenue - · 2 sites reported $55.25 for Sep 21",
      "16:14 collected - · Mediavine · 2 sites, none failed",
      "16:00 resolved Menus · Menu imports stalled",
      "15:30 cost Recipes · DataForSEO · $0.12 for 1 lookup",
      "15:02 collected - · DataForSEO · 2 sites, none failed",
      "15:02 cost - · DataForSEO · $0.41 for 2 reports",
      "14:25 task-done NoticeOS · Feed reads the store",
      "14:20 task-done NoticeOS · Feed folds runs",
      "14:15 task-done Fitness · Standards table loads",
      "14:00 source-failed Money · PostHog report failed",
      "13:00 cost NoticeOS · Booked $12.00 infra cost for September",
      "12:00 setting-saved - · Moved the feed to the right",
      "11:05 job-failed - · Backups failed",
      "11:00 collected Recipes · Site checks · 1 site, none failed",
      "10:00 report - · Nightly reports from 4 sites",
      "03:00 change Menus · Checkout outage",
      "02:40 deployed NoticeOS · New version abc1234def is live",
    ]);
    expect(new Set(feed.items.map((item) => item.kind))).toEqual(new Set(WALL_FEED_KINDS));
    const times = feed.items.map((item) => Date.parse(item.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(times.every((t) => t >= Date.parse(SINCE) && t <= NOW.getTime())).toBe(true);
    expect(new Set(feed.items.map((item) => item.id)).size).toBe(feed.items.length);
  });

  it("states a task filed inside the window once, as New task, named for its project's site", async () => {
    const { items } = await buildWallFeed(pg.call, DEPS);
    const filed = items.filter((item) => item.kind === "task-filed");
    expect(filed).toEqual([
      {
        id: "task-filed:mn-7", at: at("19:11"), kind: "task-filed", label: "New task", asset: "menus.example.com",
        site: "Menus", text: "Menu import skips closed restaurants", count: 1, tone: "neutral",
      },
    ]);
    await snapshot(pg.call, at("19:28"), {}, { "unknown.example.com": [["un-1", "Stray task", at("19:27")]] });
    const next = await buildWallFeed(pg.call, DEPS);
    expect(next.items[0]).toMatchObject({ kind: "task-filed", asset: null, site: null, text: "Stray task" });
  });

  it("keeps adjacent created and completed tasks individually named, once per event", async () => {
    const created: Record<string, [string, string, string][]> = {
      "menus.example.com": [
        ["mn-8", "Menus show opening hours", at("19:27")],
        ["mn-9", "Menus show delivery prices", at("19:26")],
      ],
    };
    const closed: Record<string, [string, string, string][]> = {
      "recipes.example.com": [["mp-1", "Recipe cards load faster", at("19:24")]],
      "codes.example.com": [["ac-1", "Lookup page shows the local time", at("18:38")]],
    };
    await snapshot(pg.call, at("19:28"), closed, created);
    await snapshot(pg.call, at("19:29"), closed, created);
    const { items } = await buildWallFeed(pg.call, DEPS);
    expect(items.filter((item) => item.kind === "task-filed").map((item) => [item.text, item.count, item.asset])).toEqual([
      ["Menus show opening hours", 1, "menus.example.com"],
      ["Menus show delivery prices", 1, "menus.example.com"],
      ["Menu import skips closed restaurants", 1, "menus.example.com"],
    ]);
    expect(items.filter((item) => item.kind === "task-done").map((item) => [item.text, item.count, item.asset])).toEqual([
      ["Recipe cards load faster", 1, "recipes.example.com"],
      ["Lookup page shows the local time", 1, "codes.example.com"],
      ["Feed reads the store", 1, "os.example.com"],
      ["Feed folds runs", 1, "os.example.com"],
      ["Standards table loads", 1, "fitness.example.com"],
    ]);
  });

  it("states an OS deploy as Deployed, and a failed deploy and its rollback as their own lines", async () => {
    // The annotations the runner files from the host's deploy log, through the
    // same mapping it uses (scripts/os-deploy-events.mts).
    const failed = "a".repeat(40);
    const previous = "b".repeat(40);
    await storeChanges(pg.call, [
      { at: at("19:02"), action: "deploy", from: previous, to: failed, result: "failed" },
      { at: at("19:03"), action: "rollback", automatic: true, from: failed, to: previous, result: "healthy" },
      { at: at("19:20"), action: "deploy", from: previous, to: "c".repeat(40), result: "healthy" },
    ].map((record) => osDeployAnnotation(record, "os.example.com")!));
    const { items } = await buildWallFeed(pg.call, DEPS);
    const moves = items.filter((item) => item.asset === "os.example.com" && item.kind === "deployed");
    // The healthy deploy and the seed's 02:40 one are the OS's two successful
    // deploys since last night: one line. The failure and the rollback stay
    // their own lines.
    expect(moves.map((item) => [item.at.slice(11, 16), item.label, item.text, item.tone, item.count])).toEqual([
      ["19:20", "Deployed", "2 times since last night", "neutral", 2],
      ["19:03", "Rolled back", "The OS went back to the previous version", "neutral", 1],
      ["19:02", "Deploy failed", "An OS update did not come back healthy", "error", 1],
    ]);
    expect(moves.every((item) => item.site === "NoticeOS")).toBe(true);
    expect(JSON.stringify(items)).not.toContain("ReindexOS");
  });

  it("states all the OS's deploys since last night as one line at the newest, and keeps a site's own", async () => {
    // Four more OS deploys, each between other events, beside the seed's
    // 02:40 one; one before the window; two deploys of sites of their own.
    await storeChanges(pg.call, [
      ...([["04:00", "1"], ["12:30", "2"], ["16:05", "3"], ["19:26", "4"]] as const).map(([hhmm, commit]) =>
        osDeployAnnotation({ at: at(hhmm), action: "deploy", from: "0".repeat(40), to: commit.repeat(40), result: "healthy" }, "os.example.com")!),
      { asset: "os.example.com", at: at("00:30"), kind: "deploy", ref: "0123456789ab" },
      { asset: "menus.example.com", at: at("17:00"), kind: "deploy", ref: "aaaaaaaaaaaa" },
      { asset: "recipes.example.com", at: at("18:20"), kind: "deploy", ref: "bbbbbbbbbbbb" },
    ]);

    const { items } = await buildWallFeed(pg.call, DEPS);
    const deploys = items.filter((item) => item.kind === "deployed");
    expect(deploys.map((item) => [item.at.slice(11, 16), item.site, item.text, item.count])).toEqual([
      ["19:26", "NoticeOS", "5 times since last night", 5],
      ["18:20", "Recipes", "New version bbbbbbbbbbbb is live", 1],
      ["17:00", "Menus", "New version aaaaaaaaaaaa is live", 1],
    ]);
    expect(items[0]).toMatchObject({ kind: "deployed", asset: "os.example.com", label: "Deployed", tone: "neutral", count: 5 });
    expect(items[1]!.text).toBe("Recipe cards load faster");
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it("folds counts, and never folds a failure into a success", async () => {
    const { items } = await buildWallFeed(pg.call, DEPS);
    const byText = (text: string) => items.find((item) => item.text === text)!;
    expect(byText("Feed reads the store")).toMatchObject({ count: 1, asset: "os.example.com", tone: "healthy", label: "Task done" });
    expect(byText("2 sites reported $55.25 for Sep 21")).toMatchObject({ count: 2, tone: "revenue" });
    expect(byText("Nightly reports from 4 sites")).toMatchObject({ count: 4, tone: "neutral" });
    // The failed Google run is its own line beside the Google collection, once
    // (its health transition and its run are one event).
    const failed = items.filter((item) => item.kind === "source-failed");
    expect(failed.map((item) => [item.site, item.tone, item.count])).toEqual([["Codes", "error", 1], ["Money", "error", 1]]);
    expect(items.filter((item) => item.kind === "collected").every((item) => item.tone === "neutral")).toBe(true);
    expect(byText("Recipe pages gained 40 clicks").label).toBe("New finding");
    expect(byText("Checkout outage").label).toBe("Incident");
    expect(byText("Plans saved well below normal").tone).toBe("warn");
  });

  // Every site count goes through siteCount (shared/site-noun.ts).
  it("counts sites with the shared helper: one site, one of two, two of three", async () => {
    const collected = async (runs: [string, string, boolean][]) => {
      const store = await createTestStore();
      for (const [id] of runs) await asset(store, id, id);
      const pgStore = store.call;
      for (const [index, [id, time, ok]] of runs.entries()) await signalRun(pgStore, `g-${index}`, id, "ga4", at(time), ok);
      return (await buildWallFeed(pgStore, DEPS)).items.filter((item) => item.kind === "collected").map((item) => item.text);
    };
    expect(await collected([["a.example.com", "18:59", true]])).toEqual(["Google · 1 site, none failed"]);
    expect(await collected([["a.example.com", "18:59", true], ["b.example.com", "18:55", false]])).toEqual(["Google · 1 of 2 sites"]);
    expect(await collected([["a.example.com", "18:59", true], ["b.example.com", "18:58", true], ["c.example.com", "18:55", false]]))
      .toEqual(["Google · 2 of 3 sites"]);
  });

  it("keeps every line to twelve words and names the site whenever the line is about one", async () => {
    await storeChanges(pg.call, [{
      asset: "menus.example.com", at: at("19:00"), kind: "external",
      note: "A very long note that goes on and on well past the twelve word budget for a line",
    }]);
    const { items } = await buildWallFeed(pg.call, DEPS);
    for (const item of items) {
      expect(feedWordCount(item.text), item.text).toBeLessThanOrEqual(12);
      if (item.asset) expect(item.site).toBeTruthy();
    }
    const names = new Map([["recipes.example.com", "Recipes"], ["menus.example.com", "Menus"], ["codes.example.com", "Codes"], ["money.example.com", "Money"], ["os.example.com", "NoticeOS"], ["fitness.example.com", "Fitness"]]);
    for (const item of items.filter((i) => i.asset)) expect(item.site).toBe(names.get(item.asset!));
  });

  it("an empty store is an empty feed, not an invented one", async () => {
    const emptyPg = await createTestStore();
    try {
      const feed = await buildWallFeed(emptyPg.call, DEPS);
      expect(feed.items).toEqual([]);
      expect(feed.since).toBe(SINCE);
    } finally {
      await emptyPg.close();
    }
  });

  it("honours a later since and a smaller limit, and never reaches before the window", async () => {
    const later = await buildWallFeed(pg.call, { ...DEPS, since: at("18:00") });
    expect(later.since).toBe(at("18:00"));
    expect(later.items.every((item) => item.at >= at("18:00"))).toBe(true);
    const earlier = await buildWallFeed(pg.call, { ...DEPS, since: "2026-09-01T00:00:00.000Z" });
    expect(earlier.since).toBe(SINCE);
    const three = await buildWallFeed(pg.call, { ...DEPS, limit: 3 });
    expect(three.items).toHaveLength(3);
    const capped = await buildWallFeed(pg.call, { ...DEPS, limit: 500 });
    expect(capped.limit).toBe(50);
  });
});

describe("the feed's reads are bounded", () => {
  it.skipIf(unavailable !== null)("keeps new task events after repeated older photographs exceed the source cap", async () => {
    const pg = await createTestStore();
    try {
      await asset(pg, "os.example.com", "NoticeOS", 1);
      const older = Array.from({ length: 8 }, (_, i): [string, string, string] =>
        [`ro-old-${i}`, `Original task ${i}`, at("01:10")]);
      for (let i = 0; i < 40; i++) {
        await snapshot(pg.call, new Date(Date.parse(at("01:15")) + i * 15 * 60_000).toISOString(),
          { "os.example.com": older }, { "os.example.com": older });
      }
      await snapshot(pg.call, at("19:29"), {
        "os.example.com": [["ro-new", "Fresh completion", at("19:28")], ["ro-old-0", "Later edited title", at("01:10")]],
      }, { "os.example.com": [["ro-new", "Fresh filing", at("19:27")]] });
      const rows = await pg.call.read(tx => tx.query<{ list: string; id: string; title: string }>(
        FEED_TASKS_SQL, [SINCE, NOW.toISOString(), SINCE, 500]));
      expect(rows).toHaveLength(18);
      expect(rows.slice(0, 2).map(row => [row.list, row.id])).toEqual([
        ["recentlyClosed", "ro-new"], ["recentlyCreated", "ro-new"],
      ]);
      expect(rows.find(row => row.list === "recentlyClosed" && row.id === "ro-old-0")?.title).toBe("Original task 0");
      const feed = await buildWallFeed(pg.call, DEPS);
      expect(feed.items.slice(0, 2).map(item => item.id)).toEqual(["task:ro-new", "task-filed:ro-new"]);
    } finally { await pg.close(); }
  });

  it.skipIf(unavailable !== null)("applies the unchanged cap to the newest distinct task events", async () => {
    const pg = await createTestStore();
    try {
      const tasks = Array.from({ length: 8 }, (_, i): [string, string, string] =>
        [`ro-${i}`, `Task ${i}`, at(`19:${String(i + 10).padStart(2, "0")}`)]);
      await snapshot(pg.call, at("19:20"), { "os.example.com": tasks });
      await snapshot(pg.call, at("19:29"), { "os.example.com": tasks });
      const rows = await pg.call.read(tx => tx.query<{ id: string }>(
        FEED_TASKS_SQL, [SINCE, NOW.toISOString(), SINCE, 3]));
      expect(rows.map(row => row.id)).toEqual(["ro-7", "ro-6", "ro-5"]);
    } finally { await pg.close(); }
  });

  it.skipIf(unavailable !== null)("runs a fixed set of statements, each capped by LIMIT or by the asset registry", async () => {
    const ctx = await createTestStore();
    await seed(ctx);
    const pg = ctx;
    await seedMoney(pg.call);
    await seedAlertsAndReports(pg.call);
    await seedSignalRuns(pg.call);
    await seedProviderReports(pg.call);
    const stored: string[] = [];
    try {
      await buildWallFeed(recordingStore(pg.call, stored), DEPS);
    } finally {
      await pg.close();
    }
    expect(stored).toHaveLength(18);
    // Per asset, at most one row per integration or two analyses: bounded by
    // the registry, not the history.
    const registryBound = new Set([FEED_SIGNAL_LATEST_SQL, FEED_INSIGHTS_SQL]);
    for (const sql of stored) {
      if (!registryBound.has(sql) && !/FROM noticeos\.assets\b[\s\S]*ORDER BY list_position/.test(sql)) expect(sql, sql).toMatch(/LIMIT \$\d+\s*$/);
    }
    for (const sql of [FEED_CONFIG_SQL, FEED_HEALTH_SQL, FEED_SIGNAL_FAILURES_SQL, FEED_SIGNAL_LATEST_SQL, FEED_MEDIAVINE_RUNS_SQL, FEED_REVENUE_SQL,
      FEED_LEDGER_SQL, FEED_HYGIENE_SQL, FEED_FLAGS_FIRED_SQL, FEED_FLAGS_RESOLVED_SQL, FEED_PULSES_SQL, FEED_JOBS_SQL, FEED_TASKS_SQL,
      FEED_ANNOTATIONS_SQL, FEED_DUMPS_SQL, FEED_RESEARCH_SQL, FEED_INSIGHTS_SQL]) {
      expect(stored).toContain(sql);
    }
  });

  it.skipIf(unavailable !== null)("reads settings saved and sources' transitions through their time indexes on Postgres", async () => {
    const pg = await createTestStore();
    try {
      const [config, transitions] = await pg.store.inWorkspace(pg.workspaceId, async (tx) => {
        // An empty table is cheapest to scan; forbidding that shows the plan
        // the index offers once the history grows.
        await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
        return [
          await tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${FEED_CONFIG_SQL}`, [SINCE, 500]),
          await tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${FEED_HEALTH_SQL}`, [SINCE, 500]),
        ];
      }, { readOnly: true });
      expect(config.map((row) => row["QUERY PLAN"]).join("\n")).toMatch(/Index (Only )?Scan using config_changes_document/);
      // The newest transitions since the window opened, down the recorded-time index.
      expect(transitions.map((row) => row["QUERY PLAN"]).join("\n")).toMatch(/Index Scan Backward using integration_health_events_recorded/);
    } finally {
      await pg.close();
    }
  });

  it.skipIf(unavailable !== null)("seeks each site's Mediavine attempts and the ledger's newest numbers on Postgres", async () => {
    const pg = await createTestStore();
    try {
      const explain = (sql: string, params: SqlValue[]) => pg.store.inWorkspace(pg.workspaceId, async (tx) => {
        await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
        return (await tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, params)).map((row) => row["QUERY PLAN"]).join("\n");
      }, { readOnly: true });
      expect(await explain(FEED_MEDIAVINE_RUNS_SQL, [SINCE, 500])).toMatch(/Index (Only )?Scan using mediavine_runs_asset on mediavine_runs m/);
      const revenue = await explain(FEED_REVENUE_SQL, [SINCE, 500]);
      expect(revenue).toMatch(/Index (Only )?Scan using mediavine_runs_asset on mediavine_runs m/);
      expect(revenue).toMatch(/Index (Only )?Scan (Backward )?using mediavine_daily_workspace_id_run_seq_report_date_key on mediavine_daily/);
      expect(await explain(FEED_LEDGER_SQL, [500, SINCE, 500])).toMatch(/Index Scan Backward using ledger_entries_workspace_id_entry_number_key on ledger_entries/);
      for (const sql of [FEED_MEDIAVINE_RUNS_SQL, FEED_REVENUE_SQL, FEED_LEDGER_SQL]) {
        expect(await explain(sql, sql === FEED_LEDGER_SQL ? [500, SINCE, 500] : [SINCE, 500])).not.toMatch(/Seq Scan on (mediavine|ledger)/);
      }
    } finally {
      await pg.close();
    }
  });

  it.skipIf(unavailable !== null)("reads each site's checks since the window's first day through its (site, check, day) index on Postgres", async () => {
    const pg = await createTestStore();
    try {
      const plan = await pg.store.inWorkspace(pg.workspaceId, async (tx) => {
        await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
        return tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${FEED_HYGIENE_SQL}`, [SINCE.slice(0, 10), SINCE, 500]);
      }, { readOnly: true });
      const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
      expect(text).toMatch(/Index Scan using hygiene_checks_workspace_id_asset_id_check_id_observed_on_key on hygiene_checks h/);
      expect(text).not.toMatch(/Seq Scan on hygiene_checks/);
    } finally {
      await pg.close();
    }
  });

  it.skipIf(unavailable !== null)("reads the window's failed jobs through the job-run record's start index on Postgres", async () => {
    const pg = await createTestStore();
    try {
      const plan = await pg.store.inWorkspace(pg.workspaceId, async (tx) => {
        await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
        return tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${FEED_JOBS_SQL}`, [SINCE, SINCE, 500]);
      }, { readOnly: true });
      const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
      expect(text).toMatch(/Index Scan using job_runs_started on job_runs j|Bitmap Index Scan on job_runs_started/);
      expect(text).not.toMatch(/Seq Scan on job_runs/);
    } finally {
      await pg.close();
    }
  });

  it.skipIf(unavailable !== null)("reads the photograph in force at each quarter hour through the capture-time index on Postgres", async () => {
    const pg = await createTestStore();
    try {
      const plan = await pg.store.inWorkspace(pg.workspaceId, async (tx) => {
        await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
        return tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${FEED_TASKS_SQL}`, [SINCE, NOW.toISOString(), SINCE, 500]);
      }, { readOnly: true });
      const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
      expect(text).toMatch(/Index (Only )?Scan using task_snapshots_captured on task_snapshots s/);
      expect(text).not.toMatch(/Seq Scan on task_snapshots/);
    } finally {
      await pg.close();
    }
  });

  it.skipIf(unavailable !== null)("reads the paid reports and lookups and the insights through their indexes on Postgres", async () => {
    // Postgres plans a table it has never analyzed by its size on disk, so
    // each holds a history from before the window.
    const ctx = await createTestStore();
    await seed(ctx);
    const pg = ctx;
    try {
      const before = Date.parse(SINCE) - 86_400_000;
      const instant = (n: number) => new Date(before - n * 3_600_000).toISOString();
      await writeArchiveRuns(pg.call, Array.from({ length: 3000 }, (_, n) =>
        dump(`h-${n}`, "recipes.example.com", ["dataforseo", "ga4", "gsc"][n % 3]!, instant(n), 0.01)));
      await writeResearch(pg.call, Array.from({ length: 300 }, (_, n) => ({
        asset: "recipes.example.com", cost_usd: 0.01, bought_at: instant(n),
      })));
      await writeInsightSnapshots(pg.call, Array.from({ length: 300 }, (_, n) =>
        insight(`h-${n}`, "recipes.example.com", instant(n), [["k", "Steady"]])));
      const explain = (sql: string, params: SqlValue[]) => pg.store.inWorkspace(pg.workspaceId, async (tx) => {
        await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
        return (await tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, params)).map((row) => row["QUERY PLAN"]).join("\n");
      }, { readOnly: true });
      const dumps = await explain(FEED_DUMPS_SQL, [SINCE, SINCE, 500]);
      expect(dumps).toMatch(/Index Scan using archive_runs_spend on archive_runs r [^\n]*\n\s+Index Cond: \([^\n]*\(integration = "\*VALUES\*"\.column1\) AND \(requested_at >= /);
      expect(dumps).not.toMatch(/Seq Scan|Bitmap/);
      const research = await explain(FEED_RESEARCH_SQL, [SINCE, 500]);
      expect(research).toMatch(/Index Scan Backward using research_log_spend on research_log r [^\n]*\n\s+Index Cond: \([^\n]*\(bought_at >= /);
      expect(research).not.toMatch(/Seq Scan/);
      const insights = await explain(FEED_INSIGHTS_SQL, [SINCE]);
      expect(insights).toMatch(/Index Only Scan using asset_insight_snapshots_latest on asset_insight_snapshots n [^\n]*\n\s+Index Cond: \(\(workspace_id = a\.workspace_id\) AND \(asset_id = a\.asset_id\)/);
      expect(insights).toMatch(/Index Scan using asset_insight_snapshots_latest on asset_insight_snapshots q [^\n]*\n\s+Index Cond: \(\(workspace_id = a\.workspace_id\) AND \(asset_id = a\.asset_id\)\)/);
      expect(insights).not.toMatch(/Seq Scan on asset_insight_snapshots/);
    } finally {
      await pg.close();
    }
  });

  it.skipIf(unavailable !== null)("reads each site's collection runs through its (site, lane, finish) index on Postgres", async () => {
    // Use this fixture's real statistics; disabling table scans checks the
    // indexed path without manufacturing years of unrelated collection runs.
    const ctx = await createTestStore();
    await seed(ctx);
    const pg = ctx;
    try {
      await pg.analyze();
      for (const [sql, params] of [[FEED_SIGNAL_FAILURES_SQL, [SINCE, 500]], [FEED_SIGNAL_LATEST_SQL, [SINCE]]] as const) {
        const plan = await pg.call.read(async (tx) => {
          await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
          return tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, params);
        });
        const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
        expect(text, sql).not.toMatch(/Seq Scan on signal_runs/);
        expect(text, sql).toMatch(/Index Scan using signal_runs_latest on signal_runs r\b[^\n]*\n\s+Index Cond: \(\(workspace_id = a\.workspace_id\) AND \(asset_id = a\.asset_id\) AND \(integration = "\*VALUES\*"\.column1\) AND \(finished_at >= /);
      }
    } finally {
      await pg.close();
    }
  });
});

// Each site's alerts and reports are read through its own (site, time) index.
needsPostgres("the alerts and reports reads on Postgres", () => {
  it("each seeks its site's own (site, time) range", async () => {
    const pg = await createTestStore();
    try {
      const plan = (sql: string) =>
        pg.store.inWorkspace(pg.workspaceId, async (tx) => {
          // Empty tables are cheapest to scan; forbidding that shows the plan
          // the indexes offer once the history grows.
          await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
          const rows = await tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, [SINCE, 500]);
          return rows.map((row) => row["QUERY PLAN"]).join("\n");
        }, { readOnly: true });
      // The index, then its condition: the site and the time, both.
      const seek = (index: string, table: string, time: string) =>
        new RegExp(`Index (Only )?Scan (Backward )?using ${index} on ${table}\\s.*\\n\\s+Index Cond: \\(\\(workspace_id = a\\.workspace_id\\) AND \\(asset_id = a\\.asset_id\\) AND \\(${time} >= `);
      const fired = await plan(FEED_FLAGS_FIRED_SQL);
      expect(fired).toMatch(seek("flags_asset_fired", "flags f", "fired_at"));
      expect(fired).not.toMatch(/Seq Scan/);
      const resolved = await plan(FEED_FLAGS_RESOLVED_SQL);
      // The settled time as a CASE (`settledAtSql`): a COALESCE bound would
      // wait behind the workspace policy and seek nothing.
      expect(resolved).toMatch(seek(
        "flags_asset_settled",
        "flags f",
        "CASE WHEN \\(resolved_at IS NOT NULL\\) THEN resolved_at WHEN \\(disposition_at IS NOT NULL\\) THEN disposition_at ELSE fired_at END",
      ));
      expect(resolved).not.toMatch(/Seq Scan/);
      const reports = await plan(FEED_PULSES_SQL);
      expect(reports).toMatch(seek("pulses_received", "pulses p", "received_at"));
      expect(reports).not.toMatch(/Seq Scan/);
      // The deploys and changes.
      const changes = await plan(FEED_ANNOTATIONS_SQL);
      expect(changes).toMatch(seek("annotations_asset_at", "annotations c", "at"));
      expect(changes).not.toMatch(/Seq Scan/);
    } finally {
      await pg.close();
    }
  });
});

needsPostgres("GET /api/wall/feed", () => {
  it("answers GET with the feed, and refuses anything else", async () => {
    const ctx = await createTestStore();
    await seed(ctx);
    const pg = ctx;
    await seedAlertsAndReports(pg.call);
    await seedSignalRuns(pg.call);
    await seedProviderReports(pg.call);
    try {
      const url = new URL("http://tower.test/api/wall/feed?limit=2");
      const ok = await handleWallFeedRequest(new Request(url), url, pg.call, DEPS);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { items: WallFeedItem[]; since: string };
      expect(body.items).toHaveLength(2);
      expect(body.since).toBe(SINCE);
      const post = await handleWallFeedRequest(new Request(url, { method: "POST" }), url, pg.call, DEPS);
      expect(post.status).toBe(405);
    } finally {
      await pg.close();
    }
  });
});
