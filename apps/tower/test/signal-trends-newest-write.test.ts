// @vitest-environment node
// The trend read keeps each day's newest write (beads `ro-ujb9.110`,
// ro-ujb9.76.5.3).
//
// Every trend chart reads one value per (asset, lane, day, metric): the one the
// newest successful run wrote. On D1 the read kept that write with a GROUP BY
// over a text key (bead `ro-ujb9.110`); on Postgres it keeps it with DISTINCT
// ON, ordered by the run's finish and then the write's identity
// (apps/tower/worker/signal-trends.ts). The rule is stated below once more as
// a ranking, the way the read stood before `ro-ujb9.110` (ROW_NUMBER() over
// `r.finished_at DESC, o.id DESC`), and that statement is the specification:
// every trend read the Tower issues, and every payload built on them, must
// give the same answer through it. The measurement is in
// docs/artifacts/tower-perf-2026-09-23/measurements.md.

import type { SqlValue, Transaction, WorkspaceStore } from "@noticeos/postgres";
import { describe, expect, it } from "vitest";
import { writeMediavine } from "./money";
import { type AssetDetailDeps, buildAssetDetailView } from "../worker/asset-detail-payload";
import { signalEvidenceFloor } from "../worker/integration-evidence";
import { type SignalTrendOptions, loadSignalTrends } from "../worker/signal-trends";
import { buildWallPayload, type BuildOptions } from "../worker/wall-payload";
import type { IntegrationsConfig } from "../shared/integrations";
import { REVENUE_HISTORY_DAYS } from "../shared/revenue-projection";
import { type TestSignalRun, type TestSignalValue, writeSignalRun, writeSignalValues } from "./collected-metrics";
import { createTestStore, type TestStore } from "./postgres-store";
import { addSites } from "./sites";

const NOW = new Date("2026-07-05T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const FLOOR = signalEvidenceFloor(NOW_MS);

const isTrendRead = (sql: string) => /latest_success AS/.test(sql);

/**
 * The shipped statement with its value selection swapped for the rule stated
 * as a ranking: the lanes, the latest-run CTE and the three steps from it to
 * the values are the shipped ones, and the bindings are the same.
 */
function specOf(shipped: string): string {
  const select = shipped.indexOf("SELECT DISTINCT ON (");
  const from = shipped.indexOf("  FROM latest_success latest");
  const order = shipped.lastIndexOf(" ORDER BY latest.asset");
  if (select < 0 || from < 0 || order < 0) throw new Error("the shipped trend read changed shape; update specOf");
  return `${shipped.slice(0, select)}SELECT asset, integration, "finishedAt", "provisionalFrom", date, metric, value
  FROM (SELECT latest.asset, latest.integration, latest."finishedAt", latest."provisionalFrom",
               written.date, series.metric, written.value,
               ROW_NUMBER() OVER (
                 PARTITION BY latest.asset, latest.integration, written.date, series.metric
                 ORDER BY written.finished_at DESC, written.observation_id DESC
               ) AS value_rank
        ${shipped.slice(from, order)}) ranked
 WHERE value_rank = 1
 ORDER BY asset COLLATE "C", integration COLLATE "C", date`;
}

/** The shipped statement with a different newest-write order, to show which
 * parts of the rule the fixture depends on. */
function withOrder(shipped: string, order: string): string {
  const swapped = shipped.replace("written.finished_at DESC, written.observation_id DESC", order);
  if (swapped === shipped) throw new Error("the shipped trend read changed shape; update withOrder");
  return swapped;
}

/** The call's store, with each statement `swap` rewrites run rewritten. */
function swappingStore(store: WorkspaceStore, swap: (sql: string) => string | null): WorkspaceStore {
  const watched = (tx: Transaction): Transaction => ({
    workspaceId: tx.workspaceId,
    query: (sql, params) => tx.query(swap(sql) ?? sql, params),
    execute: (sql, params) => tx.execute(swap(sql) ?? sql, params),
  });
  return {
    where: store.where,
    workspaceId: () => store.workspaceId(),
    read: (work) => store.read((tx) => work(watched(tx))),
    write: (work) => store.write((tx) => work(watched(tx))),
    close: () => store.close(),
  };
}

/** A store whose trend reads run the specification instead. */
function specStore(store: WorkspaceStore, swaps: string[]): WorkspaceStore {
  return swappingStore(store, (sql) => {
    if (!isTrendRead(sql)) return null;
    swaps.push(sql);
    return specOf(sql);
  });
}

interface Captured {
  sql: string;
  params: SqlValue[];
}

// ── Fixture ──────────────────────────────────────────────────────────────────

const ASSETS = [
  "carry.example",
  "ties.example",
  "repoint.example",
  "edges.example",
  "floor.example",
  "empty.example",
] as const;

/** A site in both of the test's stores (test/sites.ts). */
async function addAsset(raw: TestStore, id: string): Promise<void> {
  await addSites(raw, [{ id, domain: null, displayName: id, status: "live", senseOnly: 0, createdAt: "2026-01-01T00:00:00.000Z" }]);
}

interface RunFixture {
  id: string;
  asset: string;
  integration: "ga4" | "gsc" | "bing-webmaster";
  finishedAt: string;
  windowEnd: string;
  status?: "success" | "error";
  provisionalFrom?: string;
  propertyRef?: string;
  credentialRef?: string;
}

const daysBefore = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** The first day each trend read keeps, counted back from a window end: the
 * Wall's cards (28 + 62 days), the revenue projection (84 + 62) and the asset
 * page (90 + 62). */
const WINDOW_BACK_DAYS = [28 + 62 - 1, REVENUE_HISTORY_DAYS + 62 - 1, 90 + 62 - 1];

/** The fixture, on Postgres where the runs and their values are (bead
 * ro-ujb9.76.5.3), in this test's own copy of its sites; returns that store. */
async function seed(raw: TestStore): Promise<WorkspaceStore> {
  for (const id of ASSETS) await addAsset(raw, id);
  const store = raw.call;
  const addRun = (r: RunFixture) =>
    writeSignalRun(store, {
      id: r.id, asset: r.asset, integration: r.integration, finishedAt: r.finishedAt, status: r.status ?? "success",
      credentialRef: r.credentialRef ?? "cred", propertyRef: r.propertyRef ?? "property",
      windowStart: "2020-01-01", windowEnd: r.windowEnd, provisionalFrom: r.provisionalFrom ?? null,
      providerRows: 0, observationCount: 0,
    } satisfies TestSignalRun);
  /** Values as `date → value`, or `date → [value, explicit identity]`. */
  const addValues = (runId: string, metric: string, values: Record<string, number | [number, bigint]>) =>
    writeSignalValues(store, runId, Object.entries(values).map(([date, value]): TestSignalValue =>
      Array.isArray(value) ? { date, metric, value: value[0], id: value[1] } : { date, metric, value }));

  // CARRY-FORWARD, BACKFILL, GAPS, FAILED RUNS (GA4). The run log is a change
  // log: a day the newest run did not rewrite keeps an older run's value.
  const carry = { asset: "carry.example", integration: "ga4" } as const;
  await addRun({ ...carry, id: "c1", finishedAt: "2026-07-01T12:00:00.000Z", windowEnd: "2026-07-01", provisionalFrom: "2026-07-01" });
  await addValues("c1", "active_users", { "2026-06-28": 10, "2026-06-29": 11, "2026-06-30": 12, "2026-07-01": 13 });
  await addValues("c1", "sessions", { "2026-06-28": 20, "2026-06-29": 21, "2026-06-30": 22, "2026-07-01": 23 });
  await addValues("c1", "page_views", { "2026-06-28": 30, "2026-07-01": 33 });
  await addValues("c1", "event_count", { "2026-06-28": 40 });
  await addRun({ ...carry, id: "c2", finishedAt: "2026-07-03T12:00:00.000Z", windowEnd: "2026-07-03", provisionalFrom: "2026-07-03" });
  await addValues("c2", "active_users", { "2026-07-01": 113, "2026-07-02": 114, "2026-07-03": 115 });
  await addValues("c2", "sessions", { "2026-07-03": 125 });
  await addValues("c2", "page_views", { "2026-07-01": 133 });
  // A failed run is no evidence, however new. On D1 it could carry values;
  // the store refuses a value under a failed run, so it carries none.
  await addRun({ ...carry, id: "c-failed", status: "error", finishedAt: "2026-07-04T00:00:00.000Z", windowEnd: "2026-07-04" });
  // A backfill finished after c1 rewrites an old day and adds older ones; the
  // days between them stay a gap.
  await addRun({ ...carry, id: "c-backfill", finishedAt: "2026-07-04T06:00:00.000Z", windowEnd: "2026-06-28" });
  await addValues("c-backfill", "active_users", { "2026-06-01": 1, "2026-06-02": 2, "2026-06-28": 99 });
  await addValues("c-backfill", "sessions", { "2026-06-01": 5 });
  await addRun({ ...carry, id: "c3", finishedAt: "2026-07-05T11:00:00.000Z", windowEnd: "2026-07-05", provisionalFrom: "2026-07-05" });
  await addValues("c3", "active_users", { "2026-07-04": 124, "2026-07-05": 125 });
  await addValues("c3", "sessions", { "2026-07-05": 135 });
  // A failed run newer than the newest success.
  await addRun({ ...carry, id: "c-failed-latest", status: "error", finishedAt: "2026-07-05T11:30:00.000Z", windowEnd: "2026-07-05" });

  // TIES AND TIMESTAMP SHAPES (Search Console).
  const ties = { asset: "ties.example", integration: "gsc" } as const;
  // Two runs finish in the same instant, both newest. The newest run is the
  // later-written one, but the day's value is the later-written VALUE (its
  // identity): here the other run's.
  await addRun({ ...ties, id: "t-latest-a", finishedAt: "2026-07-05T10:00:00.000Z", windowEnd: "2026-07-05" });
  await addRun({ ...ties, id: "t-latest-b", finishedAt: "2026-07-05T10:00:00.000Z", windowEnd: "2026-07-05" });
  await addValues("t-latest-b", "clicks", { "2026-07-04": 41 });
  await addValues("t-latest-a", "clicks", { "2026-07-04": 42, "2026-07-05": 50 });
  // The same second, a different millisecond.
  await addRun({ ...ties, id: "t-ms-900", finishedAt: "2026-07-03T08:00:00.900Z", windowEnd: "2026-07-03" });
  await addRun({ ...ties, id: "t-ms-100", finishedAt: "2026-07-03T08:00:00.100Z", windowEnd: "2026-07-03" });
  await addValues("t-ms-900", "impressions", { "2026-07-02": 900 });
  await addValues("t-ms-100", "impressions", { "2026-07-02": 100 });
  await addValues("t-ms-900", "ctr", { "2026-07-02": 0.09 });
  await addValues("t-ms-100", "ctr", { "2026-07-02": 0.01 });
  // finished_at in four spellings. On D1 they were text, compared as text;
  // in the store each is an instant: the first three are 09:00 UTC (a time
  // with no zone is UTC, as the importer reads it), the fourth 23:00 UTC.
  const shapes = {
    zulu: "2026-07-02T09:00:00Z",
    millis: "2026-07-02T09:00:00.000Z",
    prefix: "2026-07-02T09:00:00",
    space: "2026-07-02 23:00:00",
  };
  for (const [name, finishedAt] of Object.entries(shapes)) {
    await addRun({ ...ties, id: `t-${name}`, finishedAt, windowEnd: "2026-07-02" });
  }
  await addValues("t-space", "clicks", { "2026-07-01": 4 });
  await addValues("t-zulu", "clicks", { "2026-07-01": 1 });
  await addValues("t-prefix", "clicks", { "2026-07-01": 3 });
  await addValues("t-millis", "clicks", { "2026-07-01": 2 });
  // Only two spellings of one instant compete: the later-written value wins.
  await addValues("t-millis", "clicks", { "2026-06-30": 20 });
  await addValues("t-prefix", "clicks", { "2026-06-30": 30 });
  await addValues("t-millis", "position", { "2026-06-30": 2.5 });
  await addValues("t-prefix", "position", { "2026-06-30": 3.5 });
  // Tied runs whose writes carry negative and extreme identities (a restored
  // or hand-repaired store; the importer keeps D1's ids). The greater identity
  // is the newer write.
  await addRun({ ...ties, id: "t-neg-1", finishedAt: "2026-07-01T07:00:00.000Z", windowEnd: "2026-07-01" });
  await addRun({ ...ties, id: "t-neg-2", finishedAt: "2026-07-01T07:00:00.000Z", windowEnd: "2026-07-01" });
  await addValues("t-neg-1", "impressions", {
    "2026-06-29": [-10, -10n],
    "2026-06-28": [-1, -1n],
    "2026-06-27": [-9_000, -9223372036854775808n],
  });
  await addValues("t-neg-2", "impressions", {
    "2026-06-29": [-5, -5n],
    "2026-06-28": [7, 1_000_000_007n],
    "2026-06-27": [-8_000, -9223372036854775807n],
  });

  // A REPOINTED PROPERTY and a rotated credential (Search Console and Bing).
  for (const integration of ["gsc", "bing-webmaster"] as const) {
    const lane = { asset: "repoint.example", integration };
    const p = integration === "gsc" ? "g" : "b";
    await addRun({ ...lane, id: `${p}-old-1`, propertyRef: "old", finishedAt: "2026-06-20T12:00:00.000Z", windowEnd: "2026-06-20" });
    await addValues(`${p}-old-1`, "clicks", { "2026-06-17": 1, "2026-06-18": 2, "2026-06-19": 3, "2026-06-20": 4 });
    await addRun({ ...lane, id: `${p}-new-1`, propertyRef: "new", finishedAt: "2026-06-26T12:00:00.000Z", windowEnd: "2026-06-26" });
    await addValues(`${p}-new-1`, "clicks", { "2026-06-23": 23, "2026-06-24": 24, "2026-06-25": 25, "2026-06-26": 26 });
    await addValues(`${p}-new-1`, "impressions", { "2026-06-26": 260 });
    // The old property collected once more after the switch.
    await addRun({ ...lane, id: `${p}-old-2`, propertyRef: "old", finishedAt: "2026-06-27T12:00:00.000Z", windowEnd: "2026-06-27" });
    await addValues(`${p}-old-2`, "clicks", { "2026-06-26": 555, "2026-06-27": 556 });
    await addRun({ ...lane, id: `${p}-rotated`, propertyRef: "new", credentialRef: "rotated", finishedAt: "2026-06-30T12:00:00.000Z", windowEnd: "2026-06-30" });
    await addValues(`${p}-rotated`, "clicks", { "2026-06-30": 30 });
    await addRun({ ...lane, id: `${p}-new-2`, propertyRef: "new", finishedAt: "2026-07-05T09:00:00.000Z", windowEnd: "2026-07-05" });
    await addValues(`${p}-new-2`, "clicks", { "2026-07-05": 5 });
  }

  // WINDOW EDGES, for each read's window (GA4 for the revenue read, Bing for
  // the web-search ones). A run finished ON the first kept day is read, one a
  // millisecond before it is not; a day ON the first kept day is kept, the day
  // before it is not; a day after the newest window end is not.
  for (const integration of ["ga4", "bing-webmaster"] as const) {
    const lane = { asset: "edges.example", integration };
    const [first, second] = integration === "ga4" ? ["active_users", "sessions"] : ["clicks", "impressions"];
    for (const back of WINDOW_BACK_DAYS) {
      const edge = daysBefore("2026-07-05", back);
      await addRun({ ...lane, id: `${integration}-on-${back}`, finishedAt: `${edge}T00:00:00.000Z`, windowEnd: edge });
      await addValues(`${integration}-on-${back}`, first!, { [edge]: back, [daysBefore(edge, 1)]: -back });
      await addRun({ ...lane, id: `${integration}-before-${back}`, finishedAt: `${daysBefore(edge, 1)}T23:59:59.999Z`, windowEnd: edge });
      await addValues(`${integration}-before-${back}`, second!, { [edge]: back * 10 });
    }
    // The same instant as the newest run, written before it: read.
    await addRun({ ...lane, id: `${integration}-twin`, finishedAt: "2026-07-05T08:00:00.000Z", windowEnd: "2026-07-05" });
    await addValues(`${integration}-twin`, second!, { "2026-07-05": 7 });
    // The run's window ends on its last day; a day after it is a day it does
    // not cover, and the read leaves it out.
    await addRun({ ...lane, id: `${integration}-latest`, finishedAt: "2026-07-05T08:00:00.000Z", windowEnd: "2026-07-05" });
    await addValues(`${integration}-latest`, first!, { "2026-07-05": 8, "2026-07-06": 9 });
  }

  // THE EVIDENCE FLOOR. A lane whose only success finished exactly on the
  // floor is read; one a millisecond older is not; only failures is nothing.
  const floorDay = FLOOR.slice(0, 10);
  await addRun({ asset: "floor.example", integration: "gsc", id: "f-on", finishedAt: FLOOR, windowEnd: floorDay });
  await addValues("f-on", "clicks", { [floorDay]: 1, [daysBefore(floorDay, 1)]: 2 });
  const justBefore = new Date(Date.parse(FLOOR) - 1).toISOString();
  await addRun({ asset: "floor.example", integration: "bing-webmaster", id: "f-before", finishedAt: justBefore, windowEnd: floorDay });
  await addValues("f-before", "clicks", { [floorDay]: 3 });
  await addRun({ asset: "floor.example", integration: "ga4", id: "f-failed", status: "error", finishedAt: "2026-07-05T00:00:00.000Z", windowEnd: "2026-07-05" });

  // Revenue for one asset, so the Wall issues its second trend read: on
  // Postgres (bead ro-ujb9.76.5.5), written by the test that builds the Wall
  // (`seedCarryRevenue`).

  // The largest identities last.
  await addRun({ ...ties, id: "t-max-1", finishedAt: "2026-06-30T07:00:00.000Z", windowEnd: "2026-06-30" });
  await addRun({ ...ties, id: "t-max-2", finishedAt: "2026-06-30T07:00:00.000Z", windowEnd: "2026-06-30" });
  await addValues("t-max-1", "impressions", { "2026-06-26": [1, 9223372036854775807n] });
  await addValues("t-max-2", "impressions", { "2026-06-26": [2, 9223372036854775806n] });
  return store;
}

/** carry.example's daily revenue, in the test's own copy of its sites. */
async function seedCarryRevenue(store: WorkspaceStore): Promise<void> {
  const days: [string, number][] = [];
  for (let back = 1; back <= 30; back += 1) days.push([daysBefore("2026-07-05", back), 100 + back]);
  await writeMediavine(store, [{ id: "mv-1", asset: "carry.example", siteId: "site-carry", start: "2026-06-01", end: "2026-07-04",
    attemptedAt: "2026-07-05T06:00:00.000Z", days }]);
}

// Every trend read the Tower issues: the Wall's two (wall-payload.ts) and the
// asset page's (asset-detail-payload.ts), plus shapes a caller could pass.
const READS: { name: string; days: number; options: SignalTrendOptions }[] = [
  { name: "Wall cards", days: 28, options: { includeWebSearch: true } },
  { name: "Wall revenue traffic", days: REVENUE_HISTORY_DAYS, options: { includeWebSearch: false, includeSessions: true } },
  ...ASSETS.map((asset) => ({ name: `asset page, ${asset}`, days: 90, options: { includeSecondarySeries: true, asset } })),
  { name: "asset page, unknown asset", days: 90, options: { includeSecondarySeries: true, asset: "nobody.example" } },
  { name: "three-day window", days: 3, options: { includeSecondarySeries: true } },
  { name: "GA4 only", days: 28, options: { includeWebSearch: false } },
];

const rowKey = (row: Record<string, unknown>) =>
  [row.asset, row.integration, row.date, row.metric].map(String).join("\u0000");
const byKey = (rows: Record<string, unknown>[]) =>
  [...rows].sort((a, b) => (rowKey(a) < rowKey(b) ? -1 : rowKey(a) > rowKey(b) ? 1 : 0));

/** The one trend statement a read issues, with the values it bound. */
async function capture(store: WorkspaceStore, days: number, options: SignalTrendOptions): Promise<Captured> {
  const out: Captured[] = [];
  const recording: WorkspaceStore = {
    where: store.where,
    workspaceId: () => store.workspaceId(),
    read: (work) =>
      store.read((tx) =>
        work({
          workspaceId: tx.workspaceId,
          query: (sql, params) => {
            if (isTrendRead(sql)) out.push({ sql, params: [...(params ?? [])] });
            return tx.query(sql, params);
          },
          execute: (sql, params) => tx.execute(sql, params),
        }),
      ),
    write: (work) => store.write(work),
    close: () => store.close(),
  };
  await loadSignalTrends(recording, days, { ...options, nowMs: NOW_MS });
  expect(out).toHaveLength(1);
  return out[0]!;
}

/** A statement's rows, read through the store. */
function rowsOf(store: WorkspaceStore, sql: string, params: readonly SqlValue[]): Promise<Record<string, unknown>[]> {
  return store.read((tx) => tx.query(sql, params));
}

describe("the trend read keeps each day's newest write (ro-ujb9.110)", () => {
  it("gives the specification's rows for every trend read", async () => {
    const raw = await createTestStore();
    const store = await seed(raw);
    for (const read of READS) {
      const { sql, params } = await capture(store, read.days, read.options);
      const shipped = await rowsOf(store, sql, params);
      const spec = await rowsOf(store, specOf(sql), params);
      expect(byKey(shipped), read.name).toEqual(byKey(spec));
      // The spec orders by (asset, lane, day) and leaves metrics on one day in
      // no stated order; the shipped read orders them too, so its order is the
      // spec's sort key, refined.
      expect(shipped, `${read.name}: ordered`).toEqual(byKey(shipped));
    }
  });

  it("gives the specification's trends and payloads", async () => {
    const raw = await createTestStore();
    const store = await seed(raw);
    for (const read of READS) {
      const swaps: string[] = [];
      const options = { ...read.options, nowMs: NOW_MS };
      expect(await loadSignalTrends(store, read.days, options), read.name)
        .toEqual(await loadSignalTrends(specStore(store, swaps), read.days, options));
      expect(swaps, read.name).toHaveLength(1);
    }

    const wallSwaps: string[] = [];
    await seedCarryRevenue(store);
    const wall = await buildWallPayload(store, WALL);
    expect(wall).toEqual(await buildWallPayload(specStore(store, wallSwaps), WALL));
    // Both of the Wall's trend reads went through the spec.
    expect(wallSwaps).toHaveLength(2);
    // And the fixture reached them: cards with series, and traffic for revenue.
    expect(wall.assets.filter((card) => card.activeUsers.series.length > 0).map((card) => card.id).sort())
      .toEqual(["carry.example", "edges.example"]);

    for (const asset of ASSETS) {
      for (const tab of ["overview", "growth"] as const) {
        const swaps: string[] = [];
        const shipped = await buildAssetDetailView(store, asset, DEPS, tab);
        expect(shipped, `${asset} ${tab}`).toEqual(await buildAssetDetailView(specStore(store, swaps), asset, DEPS, tab));
        expect(swaps, `${asset} ${tab}`).toHaveLength(1);
      }
    }
  });

  it("answers the fixture's edge cases the way the specification does", async () => {
    // The spec's answers, stated, so a reader can see what the fixture pins.
    const raw = await createTestStore();
    const store = await seed(raw);
    const page = async (asset: string) =>
      (await loadSignalTrends(store, 90, { includeSecondarySeries: true, asset, nowMs: NOW_MS })).get(asset);

    const carry = (await page("carry.example"))!;
    expect(carry.activeUsers.series).toEqual([
      { t: "2026-06-01", v: 1 },
      { t: "2026-06-02", v: 2 },
      { t: "2026-06-28", v: 99 },
      { t: "2026-06-29", v: 11 },
      { t: "2026-06-30", v: 12 },
      { t: "2026-07-01", v: 113 },
      { t: "2026-07-02", v: 114 },
      { t: "2026-07-03", v: 115 },
      { t: "2026-07-04", v: 124 },
      { t: "2026-07-05", v: 125 },
    ]);
    expect(carry.activeUsers.collectedAt).toBe("2026-07-05T11:00:00.000Z");
    expect(carry.activeUsers.provisionalFrom).toBe("2026-07-05");

    const ties = (await page("ties.example"))!;
    const at = (series: { t: string; v: number }[], day: string) => series.find((point) => point.t === day)?.v;
    const clicks = ties.webSearchClicks.google.series;
    expect(at(clicks, "2026-07-04")).toBe(42);
    // The four spellings are instants on Postgres (bead ro-ujb9.76.5.3): the
    // run that finished at 23:00 is the newest, where D1's text order put
    // "…T09:00:00Z" last and answered 1.
    expect(at(clicks, "2026-07-01")).toBe(4);
    // "…T09:00:00.000Z" and "…T09:00:00" are one instant, so the later-written
    // value wins, where D1's text order put the longer text last and answered
    // 20 (and 2.5 for the position).
    expect(at(clicks, "2026-06-30")).toBe(30);
    const impressions = ties.webSearchImpressions.google.series;
    expect(at(impressions, "2026-07-02")).toBe(900);
    expect([at(impressions, "2026-06-29"), at(impressions, "2026-06-28"), at(impressions, "2026-06-27"), at(impressions, "2026-06-26")])
      .toEqual([-5, 7, -8_000, 1]);
    expect(at(ties.searchPosition.series, "2026-06-30")).toBe(3.5);

    const repoint = (await page("repoint.example"))!;
    for (const series of [repoint.webSearchClicks.google.series, repoint.webSearchClicks.bing.series]) {
      expect(series).toEqual([
        { t: "2026-06-23", v: 23 },
        { t: "2026-06-24", v: 24 },
        { t: "2026-06-25", v: 25 },
        { t: "2026-06-26", v: 26 },
        { t: "2026-06-30", v: 30 },
        { t: "2026-07-05", v: 5 },
      ]);
    }

    const edges = (await page("edges.example"))!;
    const pageEdge = daysBefore("2026-07-05", 90 + 62 - 1);
    const bingClicks = [...(edges.webSearchClicks.bing.contextSeries ?? []), ...edges.webSearchClicks.bing.series];
    expect(bingClicks[0]).toEqual({ t: pageEdge, v: 90 + 62 - 1 });
    expect(bingClicks.at(-1)).toEqual({ t: "2026-07-05", v: 8 });
    const bingImpressions = [...(edges.webSearchImpressions.bing.contextSeries ?? []), ...edges.webSearchImpressions.bing.series];
    expect(bingImpressions.map((point) => point.t)).not.toContain(pageEdge);
    expect(bingImpressions.at(-1)).toEqual({ t: "2026-07-05", v: 7 });

    const floor = (await page("floor.example"))!;
    expect(floor.webSearchClicks.google.series).toEqual([
      { t: daysBefore(FLOOR.slice(0, 10), 1), v: 2 },
      { t: FLOOR.slice(0, 10), v: 1 },
    ]);
    expect(floor.webSearchClicks.bing.series).toEqual([]);
    expect(floor.activeUsers.series).toEqual([]);

    expect(await page("empty.example")).toBeUndefined();
  });

  it("the fixture reaches every part of the rule", async () => {
    // A weaker rule must give a different answer here, or the fixture would not
    // prove that part of the rule is needed.
    const raw = await createTestStore();
    const store = await seed(raw);
    const { sql, params } = await capture(store, 90, { includeSecondarySeries: true, asset: "ties.example" });
    const rows = async (statement: string) => byKey(await rowsOf(store, statement, params));
    const spec = await rows(specOf(sql));
    expect(await rows(sql)).toEqual(spec);
    // The newest write alone, whenever its run finished.
    expect(await rows(withOrder(sql, "written.observation_id DESC"))).not.toEqual(spec);
    // Two runs in one instant: the OLDER write winning instead.
    expect(await rows(withOrder(sql, "written.finished_at DESC, written.observation_id"))).not.toEqual(spec);
  });

  it("reads an empty store as nothing, like the specification", async () => {
    const raw = await createTestStore();
    await addAsset(raw, "carry.example");
    const store = raw.call;
    const { sql, params } = await capture(store, 28, { includeWebSearch: true });
    expect(await rowsOf(store, sql, params)).toEqual([]);
    expect(await rowsOf(store, specOf(sql), params)).toEqual([]);
    expect(await loadSignalTrends(store, 28, { nowMs: NOW_MS })).toEqual(new Map());
  });

  it("sorts the candidates once", async () => {
    // Pinned as a PLAN. Before bead ro-ujb9.110 the read ranked every
    // candidate in a window (one sort) and sorted the survivors again for
    // output (a second); DISTINCT ON's one sort is also the output order.
    const raw = await createTestStore();
    const store = await seed(raw);
    for (const read of READS) {
      const { sql, params } = await capture(store, read.days, read.options);
      const plan = await store.read((tx) => tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, params));
      const sorts = plan.map((row) => row["QUERY PLAN"]).filter((line) => /^\s*(->\s+)?Sort\s+\(/.test(line));
      expect(sorts, read.name).toHaveLength(1);
    }
  });
});

// ── The collector's own instants ─────────────────────────────────────────────
//
// What changed with the move is only how odd spellings of an instant compare.
// Every instant the collector writes is `Date#toISOString()`, where text order
// and time order are one order, so the newest write must be the one D1 chose:
// the run that finished last, and of two in the same millisecond, the value
// written last.

describe("for every instant the collector writes, the newest write is D1's", () => {
  it("picks the write D1 picked, same-millisecond runs included", async () => {
    const raw = await createTestStore();
    await addAsset(raw, "collector.example");
    const store = raw.call;
    // Twelve runs over five days of one series, finishing at instants drawn
    // from four, so several finish in the same millisecond; each rewrites some
    // of the days. Deterministic, so a failure reproduces.
    const instants = ["2026-07-03T08:00:00.000Z", "2026-07-03T08:00:00.001Z", "2026-07-04T23:59:59.999Z", "2026-07-05T01:00:00.000Z"];
    const days = ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"];
    let state = 7;
    /** A deterministic draw below `n`, from the generator's high bits. */
    const pick = (n: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return (state >>> 16) % n;
    };
    /** D1's rule over the collector's instants: (finished_at text, write order), greatest wins. */
    const newest = new Map<string, { finishedAt: string; order: number; value: number }>();
    let order = 0;
    const finishes = new Map<string, string[]>();
    for (let run = 0; run < 12; run += 1) {
      const finishedAt = instants[pick(instants.length)]!;
      const written = days.filter(() => pick(2) === 0);
      const values = written.map((date) => ({ date, metric: "active_users", value: pick(1000) }));
      await writeSignalRun(store, {
        id: `collector-${run}`, asset: "collector.example", integration: "ga4", finishedAt,
        windowStart: "2026-07-01", windowEnd: "2026-07-05", observationCount: values.length,
      }, values);
      for (const value of values) {
        order += 1;
        const held = newest.get(value.date);
        finishes.set(value.date, [...(finishes.get(value.date) ?? []), finishedAt]);
        if (!held || finishedAt > held.finishedAt || (finishedAt === held.finishedAt && order > held.order)) {
          newest.set(value.date, { finishedAt, order, value: value.value });
        }
      }
    }
    // The fixture does reach the tie: on some day the newest millisecond holds
    // more than one write, and the value written last decides it.
    const decidedByIdentity = [...newest].filter(([date, held]) =>
      finishes.get(date)!.filter((finishedAt) => finishedAt === held.finishedAt).length > 1);
    expect(decidedByIdentity.length).toBeGreaterThan(0);
    const trend = (await loadSignalTrends(store, 28, { nowMs: NOW_MS })).get("collector.example")!;
    expect(trend.activeUsers.series).toEqual(
      days.filter((date) => newest.has(date)).map((date) => ({ t: date, v: newest.get(date)!.value })),
    );
  });
});

// ── Payload inputs ───────────────────────────────────────────────────────────

const INTEGRATIONS: IntegrationsConfig = {
  catalog: [
    { id: "gsc", label: "Google Search Console", docRef: "docs/11-integrations.md" },
    { id: "ga4", label: "Google Analytics 4", docRef: "docs/11-integrations.md" },
    { id: "bing-webmaster", label: "Bing Webmaster", docRef: "docs/11-integrations.md" },
    { id: "ad-network", label: "Ad network", docRef: "docs/11-integrations.md" },
  ],
  assets: Object.fromEntries(ASSETS.map((id) => [id, {
    gsc: { status: "live", note: "live", since: "2026-01-01" },
    ga4: { status: "live", note: "live", since: "2026-01-01" },
    "bing-webmaster": { status: "live", note: "live", since: "2026-01-01" },
  }])),
} as IntegrationsConfig;

const WALL: BuildOptions = {
  now: NOW,
  osTimeZone: "UTC",
  constants: { dataUsd: 25 },
  integrations: INTEGRATIONS,
  pullConfig: [],
  dashboard: {},
  serpPanel: { assets: {} },
};

const DEPS: AssetDetailDeps = {
  now: NOW,
  flagDefaults: { alpha: 0.01, min_baseline_per_day: 3, low_volume_window_hours: 72 },
  pullConfig: [],
  monthlyCaps: { dataUsd: 25 },
  operatorRateUsdPerMin: 2,
  integrations: INTEGRATIONS,
  counters: { assets: {} },
  serpPanel: { assets: {} },
  signalPanels: { assets: {} },
  valueEvents: { assets: {} },
  ga4EventParams: { assets: {} },
  osTimeZone: "UTC",
};
