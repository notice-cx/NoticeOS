import { dataForSeoReportsFor } from "@noticeos/contract";
import type { TestStore } from "./postgres-store";
import { writeArchiveRun, writeArchiveRuns, type TestArchiveRun } from "./provider-reports";

// The two store shapes behind an asset's serp-panel review obligation,
// written exactly as their writers write them. Shared by the Wall's card tests
// and the asset page's, because both surfaces are fed by the same two readers
// (`cardPanelReviewsOf` + `loadLatestPanelLandings`).

/** The counts shape a current poller writes. */
export function workCounts(overrides: Record<string, number> = {}) {
  return {
    open: 12,
    highPriority: 3,
    ready: 9,
    inProgress: 2,
    blocked: 1,
    closedRecent: 4,
    ...overrides,
  };
}

/** One project inside a task-hub snapshot. `panelReview` is absent by default,
 * as an older poller's snapshot omits the key. */
export function workProject(overrides: Record<string, unknown> = {}) {
  return {
    asset: "meadow.example",
    prefix: "md",
    ok: true,
    error: null,
    counts: workCounts(),
    priorities: [1, 2, 8, 3, 1],
    ready: [],
    inProgress: [],
    recentlyClosed: [],
    ...overrides,
  };
}

/** An open review task on meadow's panel, due a week after the landing. */
export function panelReviewBead(overrides: Record<string, unknown> = {}) {
  return {
    beadId: "md-4a2",
    panelDate: "2026-07-01",
    dueAt: "2026-07-08T06:00:00.000Z",
    status: "open",
    ...overrides,
  };
}

/** One task-hub photograph, in the test's own Postgres copy of its sites:
 * written only by the tests that read it. */
export async function seedSnapshot(
  of: TestStore | TestStore,
  capturedAt: string,
  projects: unknown[],
): Promise<void> {
  await (of.call).write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.task_snapshots (workspace_id, captured_at, payload) VALUES ($1::uuid, $2::timestamptz, $3::jsonb)`,
      [tx.workspaceId, capturedAt, JSON.stringify({ projects })],
    ),
  );
}

/** One report run for a tracked-SERP panel collection. `report_date` is the
 * panel day, the fact the review is matched against, and `finished_at` is
 * only when the archive was written, which is why a backfill can make them
 * disagree. */
export async function insertPanelRun(
  raw: TestStore,
  asset: string,
  panelDate: string,
  finishedAt: string,
  status: "success" | "unchanged" | "error" = "success",
  report = "serp-panel",
): Promise<void> {
  await writeArchiveRun(raw.call, panelRun(asset, panelDate, finishedAt, status, report));
}

function panelRun(asset: string, panelDate: string, finishedAt: string, status: "success" | "unchanged" | "error", report: string): TestArchiveRun {
  return {
    id: `${asset}-${report}-${panelDate}-${finishedAt}-${status}`,
    asset, integration: "dataforseo", report, credential_ref: "dataforseo", property_ref: asset,
    report_date: panelDate, finished_at: finishedAt, status, provider_rows: 20, request_count: 20,
    object_key: `dumps/${asset}/${finishedAt}.json.gz`, content_sha256: "a".repeat(64), object_bytes: 2048,
    error_code: "provider_error", error_message: "the provider returned 500",
  };
}

/** One coherent weekly collection, using the same family contract as both
 * payload builders. `panel` is supplied by the test's injected config. */
export async function insertDataForSeoCollection(
  raw: TestStore,
  asset: string,
  panelDate: string,
  finishedAt: string,
  options: {
    panel: boolean;
    status?: "success" | "unchanged" | "error";
    omit?: readonly string[];
  },
): Promise<void> {
  const panelAssets = new Set(options.panel ? [asset] : []);
  await writeArchiveRuns(
    raw.call,
    dataForSeoReportsFor(asset, panelAssets)
      .filter((report) => !options.omit?.includes(report))
      .map((report) => panelRun(asset, panelDate, finishedAt, options.status ?? "success", report)),
  );
}
