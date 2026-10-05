// The live feed's synthetic store (beads ro-trai.6, ro-trai.9): the D28
// reference feed (docs/artifacts/wall-rethink-2026-09-23/d28-six-1920.png) as
// STORED ROWS, so `/api/wall/feed` runs its real SQL, folds and window over
// them. Times are minutes before the fixture server's own clock. The sites are
// the Wall fixture's own cards (one list, `wall-fixture.ts`), plus the OS;
// every value is invented.
import type { WorkspaceStore } from "@noticeos/postgres";
import { osDeployAnnotation } from "../../../scripts/os-deploy-events.mjs";
import { writeMediavine } from "../test/money";
import { writeArchiveRuns, writeInsightSnapshots } from "../test/provider-reports";
import { wallFixturePayload } from "./wall-fixture";

/** The OS itself: the asset an OS deploy is recorded against. Its row stores a
 * name of its own, as the owner's pre-rename store does; the feed still calls
 * it NoticeOS (bead ro-ujb9.77.10). */
export const WALL_FEED_OS: readonly [id: string, storedName: string] = ["os.example.com", "Stored name, never shown"];

// No saved layout here: D28's default places the feed beside the column
// (bead ro-trai.11), so the Wall nobody arranged is the one the feed runs in.

/** What the arrival journey injects: one new stored alert. */
export const WALL_FEED_INJECTED_TEXT = "Home page stopped answering";

const MINUTE = 60_000;

/** The Wall fixture's sites, in its order. */
function sites(): [id: string, name: string][] {
  return wallFixturePayload().assets.map((card) => [card.id, card.displayName]);
}

/** One site the feed is about, in the Postgres fixture. */
export interface WallFeedSite {
  id: string;
  domain: string | null;
  displayName: string;
  isOs: boolean;
}

/** The feed's sites: the OS and the Wall fixture's cards, all live, added
 * 2026-01-01. The harness writes them into its Postgres copy. */
export const WALL_FEED_SITES_ADDED_AT = "2026-01-01T00:00:00.000Z";
export function wallFeedSites(): WallFeedSite[] {
  return [
    { id: WALL_FEED_OS[0], domain: null, displayName: WALL_FEED_OS[1], isOs: true },
    ...sites().map(([id, name]) => ({ id, domain: id, displayName: name, isOs: false })),
  ];
}

/** The OS moved to a newer version at 7:40 PM yesterday (its own clock): the
 * annotation the runner files from its deploy log (bead ro-trai.8), on
 * Postgres where the feed reads changes (bead ro-ujb9.76.5.7), in a store
 * already holding the feed's sites. */
export async function seedWallFeedChanges(store: WorkspaceStore, nowIso: string): Promise<void> {
  const at = new Date(Date.parse(nowIso) - 1010 * MINUTE).toISOString();
  const deploy = osDeployAnnotation({ at, action: "deploy", from: "1".repeat(40), to: "2".repeat(40), result: "healthy" }, WALL_FEED_OS[0])!;
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind, ref, note)
       VALUES ($1::uuid, $2, $3::timestamptz, $4, $5, $6)`,
      [tx.workspaceId, deploy.asset, deploy.at, deploy.kind, deploy.ref, deploy.note],
    ),
  );
}

/** The insight refreshes and the paid reports, on Postgres where the
 * publisher and the collector write them (bead ro-ujb9.76.5.4), after the
 * feed's sites are there. */
export async function seedWallFeedProviderReports(store: WorkspaceStore, nowIso: string): Promise<void> {
  const now = Date.parse(nowIso);
  const ago = (minutes: number) => new Date(now - minutes * MINUTE).toISOString();
  const day = (minutes: number) => ago(minutes).slice(0, 10);
  const all = sites();
  const [first, second, third] = all.map(([id]) => id) as [string, string, string];
  const reporting = all.slice(0, 5).map(([id]) => id);

  // Insight refreshes 75 minutes ago; each site's analysis before it two days
  // back, with the same findings (a refresh, no news).
  await writeInsightSnapshots(store, reporting.flatMap((id) => {
    const payload = JSON.stringify({ items: [{ key: `${id}-steady`, title: "Search clicks steady" }] });
    return [
      { id: `feed-old-${id}`, asset: id, generated_at: ago(60 * 48), payload },
      { id: `feed-new-${id}`, asset: id, generated_at: ago(75), payload },
    ];
  }));

  // Twelve paid DataForSEO reports, 268 minutes ago: $0.41.
  await writeArchiveRuns(store, Array.from({ length: 12 }, (_, i) => ({
    id: `feed-dfs-${i}`, asset: [first, second, third][i % 3]!, integration: "dataforseo", report: `report-${i}`,
    credential_ref: "synthetic", property_ref: "synthetic", report_date: day(60 * 24), requested_at: ago(270),
    finished_at: ago(268), provider_rows: 1, request_count: 1, object_key: `feed/dfs-${i}`, object_bytes: 10,
    provider_cost_usd: i < 5 ? 0.04 : 0.03,
  })));
}

/** Yesterday's ad revenue from two sites, reported 195 minutes ago: on
 * Postgres, where Mediavine's reports are read (bead ro-ujb9.76.5.5), after
 * the feed's sites are there. */
export async function seedWallFeedRevenue(store: WorkspaceStore, nowIso: string): Promise<void> {
  const now = Date.parse(nowIso);
  const ago = (minutes: number) => new Date(now - minutes * MINUTE).toISOString();
  const day = (minutes: number) => ago(minutes).slice(0, 10);
  const [first, second] = sites().map(([id]) => id) as [string, string];
  await writeMediavine(store, ([[first, 4110], [second, 1415]] as const).map(([id, cents]) => ({
    id: `feed-mv-${id}`, asset: id, siteId: `mv-${id}`, start: day(60 * 24 * 7), end: day(60 * 24), attemptedAt: ago(195),
    days: [[day(60 * 24), cents]],
  })));
}

/** One stored alert, as a lane raises it (bead ro-ujb9.76.5.2). */
async function storeFeedAlert(store: WorkspaceStore, asset: string, firedAt: string, severity: string, message: string): Promise<void> {
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.flags (workspace_id, asset_id, fired_at, severity, kind, metric, message, rule_id)
       VALUES ($1, $2, $3::timestamptz, $4, 'anomaly', NULL, $5, 'journey-feed')`,
      [tx.workspaceId, asset, firedAt, severity, message],
    ),
  );
}

/** The feed's alerts and nightly reports, on Postgres where the feed reads
 * them (bead ro-ujb9.76.5.2), in a store already holding the feed's sites. */
export async function seedWallFeedAlertsAndReports(store: WorkspaceStore, nowIso: string): Promise<void> {
  const now = Date.parse(nowIso);
  const ago = (minutes: number) => new Date(now - minutes * MINUTE).toISOString();
  const all = sites();
  const reporting = all.slice(0, 5).map(([id]) => id);

  // The alert Needs you shows, two hours ago.
  await storeFeedAlert(store, all[0]![0], ago(120), "warn", "Plans saved well below normal — 19 vs ~58/day");

  // Last night's reports from five sites.
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.pulses (workspace_id, asset_id, pulse_date, received_at, envelope)
       SELECT $1::uuid, asset_id, $3::date, $4::timestamptz, '{}' FROM unnest($2::text[]) AS asset_id`,
      [tx.workspaceId, reporting, ago(60 * 24).slice(0, 10), ago(570)],
    ),
  );
}

/** The task hub's photograph a minute ago, on Postgres where the feed reads it
 * (bead ro-ujb9.76.4.3). Tasks done: one six minutes ago, one at 52, and three
 * within a quarter hour of each other five hours ago (three named lines);
 * one task filed 19 minutes ago. */
export async function seedWallFeedTasks(store: WorkspaceStore, nowIso: string): Promise<void> {
  const now = Date.parse(nowIso);
  const ago = (minutes: number) => new Date(now - minutes * MINUTE).toISOString();
  const [first, second, , fourth] = sites().map(([id]) => id) as [string, string, string, string];
  const project = (a: string, closed: [string, string, number][], created: [string, string, number][] = []) => ({
    asset: a, prefix: a.slice(0, 3), ok: true, error: null,
    counts: { open: created.length, ready: 0, inProgress: 0, blocked: 0, closedRecent: closed.length },
    ready: [], inProgress: [],
    recentlyClosed: closed.map(([id, title, minutes]) => ({ id, title, status: "closed", priority: 2, issueType: "task", closedAt: ago(minutes) })),
    // Newly filed work (bead ro-trai.7).
    recentlyCreated: created.map(([id, title, minutes]) => ({ id, title, status: "open", priority: 2, issueType: "task", createdAt: ago(minutes) })),
  });
  const payload = JSON.stringify({
    projects: [
      project(first, [["t-cards", "Recipe cards load faster", 6], ["t-pantry", "Pantry list keeps its order", 305]]),
      project(fourth, [["t-time", "Lookup page shows the local time", 52], ["t-map", "Map loads on phones", 312]]),
      project(second, [["t-zones", "Delivery zones show on the map", 318]], [["t-menu", "Menu import skips closed restaurants", 19]]),
    ],
  });
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.task_snapshots (workspace_id, captured_at, payload) VALUES ($1::uuid, $2::timestamptz, $3::jsonb)`,
      [tx.workspaceId, ago(1), payload],
    ),
  );
}

/** Google, every reporting site's newest refresh 31 minutes ago: one run each,
 * on Postgres where the collectors write them (bead ro-trai.6, ro-ujb9.76.5.3).
 * The store must already hold the feed's sites. */
export async function seedWallFeedRuns(store: WorkspaceStore, nowIso: string): Promise<void> {
  const now = Date.parse(nowIso);
  const ago = (minutes: number) => new Date(now - minutes * MINUTE).toISOString();
  const day = (minutes: number) => ago(minutes).slice(0, 10);
  const reporting = sites().slice(0, 5).map(([id]) => id);
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.signal_runs (workspace_id, run_id, asset_id, integration, credential_ref, property_ref, started_at,
         finished_at, status, window_start, window_end, data_state, provider_rows, observation_count)
       SELECT $1::uuid, 'feed-ga4-' || s.asset_id, s.asset_id, 'ga4', 'synthetic', 'synthetic', $2::timestamptz, $2::timestamptz,
              'success', $3::date, $4::date, 'final', 1, 1
         FROM unnest($5::text[]) WITH ORDINALITY AS s(asset_id, place)
        ORDER BY s.place`,
      [tx.workspaceId, ago(31), day(60 * 24 * 30), day(60 * 24), reporting],
    ),
  );
}

/** One new stored event, now: what a live Wall would see arrive. */
export async function injectWallFeedEvent(store: WorkspaceStore, nowIso: string): Promise<void> {
  const [, second] = sites();
  await storeFeedAlert(store, second![0], nowIso, "error", WALL_FEED_INJECTED_TEXT);
}
