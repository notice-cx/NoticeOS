// The data-source evidence reads, bounded (bead `ro-ujb9.104`).
//
// Every asset tab and every Wall refresh reads the newest archive manifest per
// (asset, lane, report family) and each asset's latest Mediavine attempt. The
// first ranked every manifest of the last 400 days with ROW_NUMBER() to keep a
// handful; the second visited every attempt ever made and every stored day of
// revenue. Both old statements are kept below VERBATIM as the specification:
// the rows, and every payload built on them, must be the same. The
// measurement is in docs/artifacts/tower-perf-2026-09-23/measurements.md.

import type { SqlValue, Transaction, WorkspaceStore } from "@noticeos/postgres";
import { describe, expect, it } from "vitest";
import { writeMediavine } from "./money";
import { createTestStore, type TestStore } from "./postgres-store";
import { writeArchiveRuns, type TestArchiveRun } from "./provider-reports";
import { type AssetDetailDeps, buildAssetDetailView } from "../worker/asset-detail-payload";
import {
  MEDIAVINE_RUNS_SQL,
  SIGNAL_EVIDENCE_FLOOR_DAYS,
  latestDumpRunsSql,
  signalEvidenceFloor,
} from "../worker/integration-evidence";
import { buildIntegrationsMatrix } from "../worker/integrations-payload";
import { buildWallPayload, type BuildOptions } from "../worker/wall-payload";
import type { IntegrationsConfig } from "../shared/integrations";

import { addSites } from "./sites";

const NOW = new Date("2026-07-05T12:00:00.000Z");
const FLOOR = signalEvidenceFloor(NOW.getTime());
const ARCHIVE = ["ga4", "gsc", "bing-webmaster"] as const;
const COLLECTED = ["dataforseo", "posthog", "clarity"] as const;
const ASSETS = ["a.example", "b.example", "c.example"] as const;

/** The manifest read as it stood before this bead, on the Postgres store
 * (bead ro-ujb9.76.5.4): every run of the slice ranked, the one written last
 * winning a tie, as D1's rowid did; its order stated, as D1's window gave it. */
function dumpSpec(integrations: readonly string[], oneAsset: boolean): string {
  const inList = integrations.map((id) => `'${id}'`).join(", ");
  return `SELECT asset, integration, report, "reportDate", "finishedAt", status,
            "providerRows", "errorCode", "errorMessage"
       FROM (
         SELECT d.asset_id AS asset, d.integration, d.report,
                d.report_date AS "reportDate",
                d.finished_at AS "finishedAt", d.status,
                d.provider_rows AS "providerRows",
                d.error_code AS "errorCode",
                d.error_message AS "errorMessage",
                ROW_NUMBER() OVER (
                  PARTITION BY d.asset_id, d.integration, d.report
                  ORDER BY d.finished_at DESC, d.run_seq DESC
                ) AS rn
           FROM noticeos.assets a
           JOIN noticeos.archive_runs d ON d.workspace_id = a.workspace_id AND d.asset_id = a.asset_id
          WHERE d.integration IN (${inList})
            AND d.finished_at >= $1::timestamptz
            ${oneAsset ? "AND a.asset_id = $2" : ""}
       ) ranked
      WHERE rn = 1
      ORDER BY asset COLLATE "C", integration COLLATE "C", report COLLATE "C"`;
}

/** The Mediavine read as it stood before this bead, on the Postgres store
 * (bead ro-ujb9.76.5.5): every attempt ever made, the one written last
 * winning a tie, as D1's rowid did. */
const MEDIAVINE_SPEC = `SELECT r.asset_id AS asset, r.attempted_at, r.outcome, r.message,
    (SELECT MAX(report_date) FROM noticeos.mediavine_current_daily d WHERE d.asset_id = r.asset_id) AS reported_through
    FROM noticeos.mediavine_runs r WHERE r.run_seq = (SELECT x.run_seq FROM noticeos.mediavine_runs x WHERE x.asset_id = r.asset_id ORDER BY attempted_at DESC, run_seq DESC LIMIT 1)`;

const INTEGRATIONS: IntegrationsConfig = {
  catalog: [
    { id: "gsc", label: "Google Search Console", docRef: "docs/11-integrations.md" },
    { id: "ga4", label: "Google Analytics 4", docRef: "docs/11-integrations.md" },
    { id: "bing-webmaster", label: "Bing Webmaster", docRef: "docs/11-integrations.md" },
    { id: "dataforseo", label: "DataForSEO", docRef: "docs/11-integrations.md" },
    { id: "ad-network", label: "Ad network", docRef: "docs/11-integrations.md" },
  ],
  assets: Object.fromEntries(ASSETS.map((id) => [id, {
    gsc: { status: "live", note: "live", since: "2026-01-01" },
    ga4: { status: "live", note: "live", since: "2026-01-01" },
    "bing-webmaster": { status: "live", note: "live", since: "2026-01-01" },
    dataforseo: { status: "live", note: "live", since: "2026-01-01" },
  }])),
} as IntegrationsConfig;

const DEPS: AssetDetailDeps = {
  now: NOW,
  flagDefaults: { alpha: 0.01, min_baseline_per_day: 3, low_volume_window_hours: 72 },
  pullConfig: [],
  monthlyCaps: { dataUsd: 25 },
  operatorRateUsdPerMin: 2,
  integrations: INTEGRATIONS,
  counters: { assets: {} },
  serpPanel: { assets: { "a.example": { queries: ["q"] } } },
  signalPanels: { assets: {} },
  valueEvents: { assets: {} },
  ga4EventParams: { assets: {} },
  osTimeZone: "UTC",
};

const WALL: BuildOptions = {
  now: NOW,
  osTimeZone: "UTC",
  constants: { dataUsd: 25 },
  integrations: INTEGRATIONS,
  pullConfig: [],
  dashboard: {},
  serpPanel: { assets: { "a.example": { queries: ["q"] } } },
};

const daysBack = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/**
 * Manifests on every edge of "newest attempt per family, within the floor":
 *  - daily archive families over 500 days, so the floor cuts through them;
 *  - a BACKFILL: an old report date whose attempt finished last;
 *  - two attempts finishing in the same instant (the later row wins);
 *  - an attempt exactly AT the floor (kept) and one a millisecond before (not);
 *  - a family whose attempts are all older than the floor (absent);
 *  - family names that sort awkwardly: 'A-upper', 'a', 'a-b', 'b' (the store
 *    refuses an empty one, which D1's fixture also held);
 *  - failures, lanes outside the read's list, and an asset with nothing.
 * On Postgres where the collectors write them (bead ro-ujb9.76.5.4), in the
 * order given.
 */
function manifests(): TestArchiveRun[] {
  const runs: TestArchiveRun[] = [];
  const manifest = (asset: string, integration: string, report: string, reportDate: string, finishedAt: string, status: "success" | "unchanged" | "error" = "success") => {
    const n = runs.length + 1;
    runs.push({
      id: `m${n}`, asset, integration, report, credential_ref: "cred", property_ref: asset, report_date: reportDate,
      finished_at: finishedAt, status, data_state: "provider-final", provider_rows: n, request_count: 1,
      object_key: `dumps/${n}.json.gz`, content_sha256: "a".repeat(64), object_bytes: 1024,
      error_code: `code_${n}`, error_message: `failure ${n}`,
    });
  };
  for (const asset of ["a.example", "b.example"]) {
    for (let day = 500; day >= 1; day -= 1) {
      const date = daysBack(day).slice(0, 10);
      for (const lane of ARCHIVE) manifest(asset, lane, `${lane}-daily`, date, daysBack(day - 0.2), day % 97 === 0 ? "error" : "success");
    }
  }
  manifest("a.example", "gsc", "gsc-daily", "2025-01-01", daysBack(0.1)); // backfill, newest attempt
  manifest("a.example", "ga4", "ga4-pages", "2026-07-01", daysBack(2), "error");
  manifest("a.example", "ga4", "ga4-pages", "2026-07-02", daysBack(2)); // same instant, later row
  manifest("b.example", "bing-webmaster", "bing-queries", "2025-05-01", FLOOR); // exactly at the floor
  manifest("b.example", "bing-webmaster", "bing-pages", "2025-05-01", new Date(Date.parse(FLOOR) - 1).toISOString()); // just before
  manifest("b.example", "ga4", "ga4-old", "2024-01-01", daysBack(600)); // all older than the floor
  for (const report of ["b", "a-b", "a", "A-upper"]) {
    manifest("a.example", "dataforseo", report, "2026-06-29", daysBack(6), report === "a" ? "error" : "success");
    manifest("a.example", "dataforseo", report, "2026-06-22", daysBack(13));
  }
  manifest("b.example", "posthog", "events", "2026-07-04", daysBack(1));
  manifest("b.example", "clarity", "url-3d", "2026-07-04", daysBack(1), "error");
  return runs;
}

/**
 * Mediavine attempts and days, on Postgres (bead ro-ujb9.76.5.5), in the
 * store the reads take. D1's fixture also held a second site for one asset and
 * days of an asset with no attempt, with its foreign keys switched off; the
 * Postgres store refuses both (one Mediavine site per site of ours, and a day
 * belongs to an attempt of its own site), so neither can be stored.
 */
async function mediavine(store: WorkspaceStore): Promise<void> {
  const at = "2026-07-04T08:00:00.000Z";
  await writeMediavine(store, [
    // a.example: two attempts in the same instant (the later row is latest),
    // revisions of one day, and a later attempt reporting the newest day.
    { id: "a-1", asset: "a.example", siteId: "site-a", start: "2026-07-01", end: "2026-07-03", attemptedAt: at, outcome: "success",
      days: [["2026-07-01", 400], ["2026-07-02", 400], ["2026-07-03", 400]], recordedAt: at },
    { id: "a-2", asset: "a.example", siteId: "site-a", start: "2026-07-01", end: "2026-07-03", attemptedAt: at, outcome: "failed",
      message: "login expired", days: [["2026-07-03", 450], ["2026-07-04", 10]], recordedAt: at },
    // b.example: attempts, no daily rows.
    { id: "b-1", asset: "b.example", siteId: "site-b", start: "2026-07-01", end: "2026-07-03", attemptedAt: "2026-07-02T08:00:00.000Z",
      outcome: "incomplete", message: "partial" },
    { id: "b-0", asset: "b.example", siteId: "site-b", start: "2026-07-01", end: "2026-07-03", attemptedAt: "2026-06-02T08:00:00.000Z",
      outcome: "success" },
  ]);
  // c.example: no attempts, so not in the read at all.
}

async function seed(ctx: TestStore): Promise<WorkspaceStore> {
  // In both of the test's stores (test/sites.ts).
  await addSites(ctx, ASSETS.map((id) => ({ id, displayName: id, status: "live", senseOnly: 0, createdAt: "2026-01-01T00:00:00.000Z" })));
  const store = ctx.call;
  await writeArchiveRuns(store, manifests());
  return store;
}

/** The call's store with the shipped manifest and Mediavine reads answered by
 * the old ones (the same parameters, in the same order). */
function storeAsBefore(store: WorkspaceStore, swapped: string[]): WorkspaceStore {
  const swap = new Map<string, string>([[MEDIAVINE_RUNS_SQL, MEDIAVINE_SPEC]]);
  for (const list of [ARCHIVE, COLLECTED]) {
    for (const one of [false, true]) swap.set(latestDumpRunsSql(list, one), dumpSpec(list, one));
  }
  const wrap = (tx: Transaction): Transaction => ({
    workspaceId: tx.workspaceId,
    query: (sql, params) => {
      const old = swap.get(sql);
      if (old === undefined) return tx.query(sql, params);
      swapped.push(old);
      return tx.query(old, params);
    },
    execute: (sql, params) => tx.execute(sql, params),
  });
  return {
    where: store.where,
    workspaceId: () => store.workspaceId(),
    read: (work) => store.read((tx) => work(wrap(tx))),
    write: (work) => store.write((tx) => work(wrap(tx))),
    close: () => store.close(),
  };
}

describe("the data-source evidence reads seek instead of ranking history (ro-ujb9.104)", () => {
  it("the newest manifest per family is the ranked read's row, in its order", async () => {
    const ctx = await createTestStore();
    const store = await seed(ctx);
    const rows = (sql: string, params: SqlValue[]) => store.read((tx) => tx.query<{ asset: string; report: string; reportDate: string; status: string }>(sql, params));
    for (const list of [ARCHIVE, COLLECTED]) {
      expect(await rows(latestDumpRunsSql(list, false), [FLOOR]), list.join())
        .toEqual(await rows(dumpSpec(list, false), [FLOOR]));
      for (const id of [...ASSETS, "unknown.example"]) {
        expect(await rows(latestDumpRunsSql(list, true), [FLOOR, id]), `${list.join()} ${id}`)
          .toEqual(await rows(dumpSpec(list, true), [FLOOR, id]));
      }
    }
    // The edges are really in the fixture.
    const archive = await rows(latestDumpRunsSql(ARCHIVE, false), [FLOOR]);
    const pick = (asset: string, report: string) => archive.find((r) => r.asset === asset && r.report === report);
    expect(pick("a.example", "gsc-daily")?.reportDate).toBe("2025-01-01"); // the backfill
    expect(pick("a.example", "ga4-pages")?.status).toBe("success"); // the later of two same-instant rows
    expect(pick("b.example", "bing-queries")).toBeDefined(); // at the floor
    expect(pick("b.example", "bing-pages")).toBeUndefined(); // before it
    expect(pick("b.example", "ga4-old")).toBeUndefined();
    const families = (await rows(latestDumpRunsSql(COLLECTED, true), [FLOOR, "a.example"])).map((r) => r.report);
    expect(families).toEqual(["A-upper", "a", "a-b", "b"]);
  });

  it("each asset's latest Mediavine attempt and last reported day are the old read's", async () => {
    const ctx = await createTestStore();
    const store = await seed(ctx);
    await mediavine(store);
    const byAsset = (rows: unknown[]) => new Map((rows as { asset: string }[]).map((r) => [r.asset, r]));
    const shipped = byAsset(await store.read((tx) => tx.query(MEDIAVINE_RUNS_SQL)));
    expect(shipped).toEqual(byAsset(await store.read((tx) => tx.query(MEDIAVINE_SPEC))));
    expect(shipped.get("a.example")).toMatchObject({ outcome: "failed", reported_through: "2026-07-04" });
    expect(shipped.get("b.example")).toMatchObject({ outcome: "incomplete", reported_through: null });
    expect(shipped.has("c.example")).toBe(false);
    // With no attempts at all there is nothing to read.
    const empty = await createTestStore();
    await addSites(empty, ASSETS.map((id) => ({ id, displayName: id, status: "live", senseOnly: 0, createdAt: "2026-01-01T00:00:00.000Z" })));
    expect(await (empty.call).read((tx) => tx.query(MEDIAVINE_RUNS_SQL))).toEqual([]);
  });

  it("every page built on them states the same thing", async () => {
    const ctx = await createTestStore();
    const store = await seed(ctx);
    await mediavine(store);
    const swapped: string[] = [];
    const storeBefore = storeAsBefore(store, swapped);
    for (const id of ASSETS) {
      for (const view of ["sources", "alerts", "overview"] as const) {
        expect(await buildAssetDetailView(store, id, DEPS, view), `${id} ${view}`)
          .toEqual(await buildAssetDetailView(storeBefore, id, DEPS, view));
      }
    }
    // Each tab reads both manifest lists for its asset and the Mediavine runs.
    expect(swapped).toHaveLength(ASSETS.length * 3 * 3);
    swapped.length = 0;
    expect(await buildWallPayload(store, WALL)).toEqual(await buildWallPayload(storeBefore, WALL));
    expect(swapped).toEqual([dumpSpec(COLLECTED, false)]); // the card read: collected lanes only
    swapped.length = 0;
    const matrix = { now: NOW, integrations: INTEGRATIONS, pullConfig: [], monthlyCaps: { dataUsd: 25 }, serpPanel: WALL.serpPanel };
    expect(await buildIntegrationsMatrix(store, matrix)).toEqual(await buildIntegrationsMatrix(storeBefore, matrix));
    expect([...swapped].sort()).toEqual([dumpSpec(ARCHIVE, false), dumpSpec(COLLECTED, false), MEDIAVINE_SPEC].sort());
  });

  it("seeks the indexes and never ranks or scans the history", async () => {
    const ctx = await createTestStore();
    const store = await seed(ctx);
    for (const list of [ARCHIVE, COLLECTED]) {
      for (const [one, params] of [[false, [FLOOR]], [true, [FLOOR, "a.example"]]] as const) {
        const text = await store.read(async (tx) => {
          // A copy is never analyzed; forbidding a scan shows the plan the
          // indexes offer once the history grows (the port pattern, step 9).
          await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
          const rows = await tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${latestDumpRunsSql(list, one)}`, [...params]);
          return rows.map((row) => row["QUERY PLAN"]).join("\n");
        });
        const where = `${list} ${one}`;
        expect(text, where).not.toMatch(/Seq Scan on archive_runs/);
        // Each family is found by a seek down the runs' (site, lane, report,
        // finish) index…
        expect(text, where).toMatch(
          /Index Only Scan using archive_runs_finished on archive_runs f [^\n]*\n\s+Index Cond: \(\(workspace_id = a\.workspace_id\) AND \(asset_id = a\.asset_id\) AND \(integration = /,
        );
        // …and its newest attempt by one bounded seek down that family's
        // entries, the floor inside the index condition.
        expect(text, where).toMatch(
          /Index Scan using archive_runs_finished on archive_runs x [^\n]*\n\s+Index Cond: \([^\n]*\(report = r\.report\) AND \(finished_at >= /,
        );
        // Only attempts that finished in one instant are ever sorted.
        expect(text, where).toMatch(/Incremental Sort [^\n]*\n\s+Sort Key: x\.finished_at DESC, x\.run_seq DESC\n\s+Presorted Key: x\.finished_at\n/);
      }
    }
  });

  it("reads each site's latest Mediavine attempt and last day through their indexes on Postgres", async () => {
    const test = await createTestStore();
    try {
      const plan = await test.store.inWorkspace(test.workspaceId, async (tx) => {
        // An empty table is cheapest to scan; forbidding that shows the plan
        // the indexes offer once the history grows.
        await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
        return tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${MEDIAVINE_RUNS_SQL}`);
      }, { readOnly: true });
      const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
      expect(text).toMatch(/Index (Only )?Scan (Backward )?using mediavine_runs_asset on mediavine_runs x/);
      expect(text).toMatch(/Index Only Scan (Backward )?using mediavine_daily_latest on mediavine_daily d/);
      expect(text).not.toMatch(/Seq Scan on mediavine_(runs|daily)/);
    } finally {
      await test.close();
    }
  });

  it("keeps the evidence floor the lanes have always used", () => {
    expect(SIGNAL_EVIDENCE_FLOOR_DAYS).toBe(400);
  });
});
