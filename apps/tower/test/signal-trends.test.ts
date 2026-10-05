import { beforeEach, describe, expect, it } from "vitest";
import { SIGNAL_EVIDENCE_FLOOR_DAYS } from "../worker/integration-evidence";
import { emptySignalTrendSet, loadSignalTrends, timeZoneChangesSql } from "../worker/signal-trends";
import type { Transaction, WorkspaceStore } from "@noticeos/postgres";
import { type TestStore, createTestStore } from "./postgres-store";
import { valuesOf, writeSignalRun, writeSignalValues } from "./collected-metrics";
import { addSites } from "./sites";

// Pins what `loadSignalTrends` answers today about FRESHNESS and MISSING
// EVIDENCE, against the real schema. The Wall and asset-page suites already pin
// ordering, provisional tails, timezone marks, the four-week cap and one-asset
// narrowing; these are the run-log rules they leave implicit: which run a day's
// value comes from, which runs are no evidence at all, and what an asset with
// nothing to chart gets back. A change to the trend SQL (series identity, bead
// `ro-ujb9.70`) must keep these answers or change them here on purpose.

const DAY = 86_400_000;
const NOW_MS = Date.parse("2026-07-05T12:00:00.000Z");

let ctx: TestStore;

/** A site in both of the test's stores (test/sites.ts). */
async function asset(raw: TestStore, id: string): Promise<void> {
  await addSites(raw, [{ id, domain: null, displayName: id, status: "live", senseOnly: 0, createdAt: "2026-01-01T00:00:00.000Z" }]);
}

interface RunFixture {
  id: string;
  asset: string;
  integration?: "ga4" | "gsc" | "bing-webmaster";
  finishedAt: string;
  status?: "success" | "error";
  windowStart: string;
  windowEnd: string;
  provisionalFrom?: string | null;
  /** The provider resource measured (a GA4 property, a Search Console site). */
  propertyRef?: string;
  credentialRef?: string;
  timeZone?: string;
}

/** One run, on Postgres where the collectors write them (bead ro-ujb9.76.5.3),
 * in this test's own copy of its sites (test/sites.ts). */
async function run(r: RunFixture): Promise<void> {
  await writeSignalRun(ctx.call, {
    id: r.id,
    asset: r.asset,
    integration: r.integration ?? "ga4",
    credentialRef: r.credentialRef ?? "test-credential",
    propertyRef: r.propertyRef ?? "test-property",
    timeZone: r.timeZone ?? null,
    finishedAt: r.finishedAt,
    status: r.status ?? "success",
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    provisionalFrom: r.provisionalFrom ?? null,
    providerRows: 0,
    observationCount: 0,
  });
}

/** Values a run changed. The store refuses one under a run that failed. */
async function observe(runId: string, values: Record<string, number>, metric = "active_users"): Promise<void> {
  await writeSignalValues(ctx.call, runId, valuesOf(metric, values));
}

/** This test's reads, on Postgres: the series (bead ro-ujb9.76.5.3) and the
 * dated timezone changes (bead ro-ujb9.76.5.7). */
async function trends(...args: Parameters<typeof loadSignalTrends> extends [unknown, ...infer Rest] ? Rest : never) {
  return loadSignalTrends(ctx.call, ...args);
}

beforeEach(async () => {
  ctx = await createTestStore();
  await asset(ctx, "a.example");
  await asset(ctx, "b.example");
  await asset(ctx, "c.example");
});

describe("loadSignalTrends — which run a day's value comes from", () => {
  it("keeps the newest SUCCESSFUL run's evidence when a later run failed", async () => {
    await run({
      id: "ok",
      asset: "a.example",
      finishedAt: "2026-07-04T12:00:00.000Z",
      windowStart: "2026-07-01",
      windowEnd: "2026-07-04",
    });
    await observe("ok", { "2026-07-01": 1, "2026-07-02": 2, "2026-07-03": 3, "2026-07-04": 4 });
    // A failed run is newer: it is still no evidence (and the store refuses
    // any value under it, bead ro-ujb9.76.5.3).
    await run({
      id: "failed",
      asset: "a.example",
      status: "error",
      finishedAt: "2026-07-05T11:00:00.000Z",
      windowStart: "2026-07-02",
      windowEnd: "2026-07-05",
    });

    const trend = (await trends(28, { nowMs: NOW_MS })).get("a.example")!;
    expect(trend.activeUsers).toEqual({
      contextSeries: [],
      series: [
        { t: "2026-07-01", v: 1 },
        { t: "2026-07-02", v: 2 },
        { t: "2026-07-03", v: 3 },
        { t: "2026-07-04", v: 4 },
      ],
      provisionalFrom: null,
      collectedAt: "2026-07-04T12:00:00.000Z",
      timeZoneChanges: [],
    });
  });

  it("reads each day from the newest run that wrote it, carrying unrewritten days forward", async () => {
    // The observation table is a change log: a run writes only what changed, so
    // a day the latest run left alone is still the earlier run's value.
    await run({
      id: "earlier",
      asset: "a.example",
      finishedAt: "2026-07-03T12:00:00.000Z",
      windowStart: "2026-06-30",
      windowEnd: "2026-07-03",
      provisionalFrom: "2026-07-03",
    });
    await observe("earlier", {
      "2026-06-30": 10,
      "2026-07-01": 11,
      "2026-07-02": 12,
      "2026-07-03": 13,
    });
    await run({
      id: "latest",
      asset: "a.example",
      finishedAt: "2026-07-05T11:00:00.000Z",
      windowStart: "2026-07-02",
      windowEnd: "2026-07-05",
      provisionalFrom: "2026-07-05",
    });
    // 07-02 unchanged (not rewritten), 07-03 revised, two new days.
    await observe("latest", { "2026-07-03": 23, "2026-07-04": 24, "2026-07-05": 25 });

    const trend = (await trends(28, { nowMs: NOW_MS })).get("a.example")!;
    expect(trend.activeUsers).toEqual({
      contextSeries: [],
      series: [
        { t: "2026-06-30", v: 10 },
        { t: "2026-07-01", v: 11 },
        { t: "2026-07-02", v: 12 },
        { t: "2026-07-03", v: 23 },
        { t: "2026-07-04", v: 24 },
        { t: "2026-07-05", v: 25 },
      ],
      // Both come from the latest successful run, never from the day's writer.
      provisionalFrom: "2026-07-05",
      collectedAt: "2026-07-05T11:00:00.000Z",
      timeZoneChanges: [],
    });
  });

  it("drops observations dated before the charted history window", async () => {
    // 28 drawn days + 62 context days = 90, counted back from the latest run's
    // window end: 2026-07-05 back 89 days is 2026-04-07.
    await run({
      id: "long",
      asset: "a.example",
      finishedAt: "2026-07-05T11:00:00.000Z",
      windowStart: "2026-04-01",
      windowEnd: "2026-07-05",
    });
    await observe("long", { "2026-04-06": 6, "2026-04-07": 7, "2026-07-05": 5 });

    const trend = (await trends(28, { nowMs: NOW_MS })).get("a.example")!;
    expect(trend.activeUsers.contextSeries).toEqual([]);
    expect(trend.activeUsers.series).toEqual([
      { t: "2026-04-07", v: 7 },
      { t: "2026-07-05", v: 5 },
    ]);
  });
});

// A series is one provider resource (bead `ro-ujb9.70`): asset + integration +
// `property_ref` + metric. The run log is a change log, so without this rule a
// day only the OLD property reported would be carried forward into the new
// property's line, splicing two resources into one chart.
describe("loadSignalTrends — one provider resource per series", () => {
  it("charts only the current property's days after the asset is repointed", async () => {
    await run({
      id: "old-property",
      asset: "a.example",
      propertyRef: "properties/111",
      finishedAt: "2026-07-03T12:00:00.000Z",
      windowStart: "2026-06-30",
      windowEnd: "2026-07-03",
    });
    await observe("old-property", {
      "2026-06-30": 500,
      "2026-07-01": 510,
      "2026-07-02": 520,
      "2026-07-03": 530,
    });
    // The new property's first run records its own window in full (the ingest
    // writer compares only within one property), and reaches back two days.
    await run({
      id: "new-property",
      asset: "a.example",
      propertyRef: "properties/222",
      finishedAt: "2026-07-05T11:00:00.000Z",
      windowStart: "2026-07-02",
      windowEnd: "2026-07-05",
    });
    await observe("new-property", {
      "2026-07-02": 20,
      "2026-07-03": 30,
      "2026-07-04": 40,
      "2026-07-05": 50,
    });

    const trend = (await trends(28, { nowMs: NOW_MS })).get("a.example")!;
    expect(trend.activeUsers.series).toEqual([
      { t: "2026-07-02", v: 20 },
      { t: "2026-07-03", v: 30 },
      { t: "2026-07-04", v: 40 },
      { t: "2026-07-05", v: 50 },
    ]);
    expect(trend.activeUsers.collectedAt).toBe("2026-07-05T11:00:00.000Z");
  });

  it("keeps carrying unrewritten days forward across a credential rotation", async () => {
    await run({
      id: "old-key",
      asset: "a.example",
      credentialRef: "key-a",
      finishedAt: "2026-07-03T12:00:00.000Z",
      windowStart: "2026-07-01",
      windowEnd: "2026-07-03",
    });
    await observe("old-key", { "2026-07-01": 1, "2026-07-02": 2, "2026-07-03": 3 });
    // Same property, new key: the writer recorded only the days that changed.
    await run({
      id: "new-key",
      asset: "a.example",
      credentialRef: "key-b",
      finishedAt: "2026-07-05T11:00:00.000Z",
      windowStart: "2026-07-01",
      windowEnd: "2026-07-05",
    });
    await observe("new-key", { "2026-07-04": 4, "2026-07-05": 5 });

    const trend = (await trends(28, { nowMs: NOW_MS })).get("a.example")!;
    expect(trend.activeUsers.series.map((point) => point.v)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps a reporting-timezone change on one property as one series, marked", async () => {
    await run({
      id: "pacific",
      asset: "a.example",
      timeZone: "America/Los_Angeles",
      finishedAt: "2026-07-03T12:00:00.000Z",
      windowStart: "2026-06-30",
      windowEnd: "2026-07-03",
    });
    await observe("pacific", {
      "2026-06-30": 10,
      "2026-07-01": 11,
      "2026-07-02": 12,
      "2026-07-03": 13,
    });
    await run({
      id: "eastern",
      asset: "a.example",
      timeZone: "America/New_York",
      finishedAt: "2026-07-05T11:00:00.000Z",
      windowStart: "2026-07-02",
      windowEnd: "2026-07-05",
    });
    // Recorded under the new zone even where equal (07-02), as the fixed writer does.
    await observe("eastern", {
      "2026-07-02": 12,
      "2026-07-03": 14,
      "2026-07-04": 15,
      "2026-07-05": 16,
    });
    await notes([{
      id: "a.example",
      at: "2026-07-04T00:00:00.000Z",
      ref: "reporting-time-zone-changed:ga4:America/Los_Angeles->America/New_York",
    }]);

    const trend = (await trends(28, { nowMs: NOW_MS })).get("a.example")!;
    // No time_zone filter: one line, older days carried from the Pacific run.
    expect(trend.activeUsers.series).toEqual([
      { t: "2026-06-30", v: 10 },
      { t: "2026-07-01", v: 11 },
      { t: "2026-07-02", v: 12 },
      { t: "2026-07-03", v: 14 },
      { t: "2026-07-04", v: 15 },
      { t: "2026-07-05", v: 16 },
    ]);
    // …and the dated annotation still says where the day definition moved.
    expect(trend.activeUsers.timeZoneChanges).toEqual([
      {
        effectiveOn: "2026-07-04",
        from: "America/Los_Angeles",
        to: "America/New_York",
      },
    ]);
  });
});

describe("loadSignalTrends — missing evidence", () => {
  it("treats a lane whose newest success is older than the evidence floor as no evidence", async () => {
    const stale = new Date(NOW_MS - (SIGNAL_EVIDENCE_FLOOR_DAYS + 1) * DAY);
    const staleDay = stale.toISOString().slice(0, 10);
    await run({
      id: "stale-ga4",
      asset: "a.example",
      finishedAt: stale.toISOString(),
      windowStart: staleDay,
      windowEnd: staleDay,
    });
    await observe("stale-ga4", { [staleDay]: 40 });
    // With only the stale lane, the asset is absent — not a set of zeros.
    expect((await trends(28, { nowMs: NOW_MS })).has("a.example")).toBe(false);

    // The floor is per lane: a fresh Search Console run on the same asset still
    // charts, while the stale GA4 lane contributes nothing at all.
    await run({
      id: "fresh-gsc",
      asset: "a.example",
      integration: "gsc",
      finishedAt: "2026-07-05T11:00:00.000Z",
      windowStart: "2026-07-04",
      windowEnd: "2026-07-05",
    });
    await observe("fresh-gsc", { "2026-07-04": 3, "2026-07-05": 4 }, "clicks");

    const trend = (await trends(28, { nowMs: NOW_MS })).get("a.example")!;
    expect(trend.activeUsers).toEqual(emptySignalTrendSet().activeUsers);
    expect(trend.webSearchClicks.google.series).toEqual([
      { t: "2026-07-04", v: 3 },
      { t: "2026-07-05", v: 4 },
    ]);
  });

  it("answers only for assets with evidence, keyed in asset order, and scopes to one asset in the query", async () => {
    for (const id of ["b.example", "a.example"]) {
      await run({
        id: `${id}-run`,
        asset: id,
        finishedAt: "2026-07-05T11:00:00.000Z",
        windowStart: "2026-07-01",
        windowEnd: "2026-07-03",
      });
      // Inserted out of date order; the read returns them ascending.
      await observe(`${id}-run`, { "2026-07-03": 3, "2026-07-01": 1, "2026-07-02": 2 });
    }

    const portfolio = await trends(28, { nowMs: NOW_MS });
    // c.example has no run at all, so it is absent; callers substitute
    // `emptySignalTrendSet()` rather than the store inventing zeros.
    expect([...portfolio.keys()]).toEqual(["a.example", "b.example"]);
    expect(portfolio.get("b.example")!.activeUsers.series).toEqual([
      { t: "2026-07-01", v: 1 },
      { t: "2026-07-02", v: 2 },
      { t: "2026-07-03", v: 3 },
    ]);

    const single = await trends(28, { nowMs: NOW_MS, asset: "b.example" });
    expect([...single.keys()]).toEqual(["b.example"]);
    expect(single.get("b.example")).toEqual(portfolio.get("b.example"));
    expect((await trends(28, { nowMs: NOW_MS, asset: "c.example" })).size).toBe(0);
    expect((await trends(28, { nowMs: NOW_MS, asset: "unknown.example" })).size).toBe(0);
  });

  it("gives callers an empty set with every series present and nothing claimed", () => {
    const empty = {
      contextSeries: [],
      series: [],
      provisionalFrom: null,
      collectedAt: null,
      timeZoneChanges: [],
    };
    expect(emptySignalTrendSet()).toEqual({
      activeUsers: empty,
      webSearchClicks: { google: empty, bing: empty },
      webSearchImpressions: { google: empty, bing: empty },
      sessions: empty,
      pageViews: empty,
      events: empty,
      searchCtr: empty,
      searchPosition: empty,
    });
    // A fresh object every call: a caller that fills one cannot leak into the next.
    expect(emptySignalTrendSet().activeUsers).not.toBe(emptySignalTrendSet().activeUsers);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The reporting-timezone lookup is bounded by the charted window (bead
// `ro-ujb9.102`).
//
// It used to read every annotation in the store on every trend read, so the
// Wall's cost grew with years of deploy and config notes. It now starts at the
// earliest first point of any series, since no change on or before a series'
// first point is ever kept. The statement below is the old read VERBATIM: it
// is the specification, and every trend read must give the same answer through
// it as through the bounded one. The measurement is in
// docs/artifacts/tower-perf-2026-09-23/measurements.md.
// ─────────────────────────────────────────────────────────────────────────────

// The old read in Postgres's words, since the annotations moved there (bead
// ro-ujb9.76.5.7): every change the store holds, its UTC day, oldest first.
const TIME_ZONE_SPEC = `SELECT asset_id AS asset, (at AT TIME ZONE 'UTC')::date AS "effectiveOn", ref
           FROM noticeos.annotations
          WHERE kind = 'config' AND ref LIKE 'reporting-time-zone-changed:%'
          ORDER BY at ASC, annotation_number ASC`;

/** The store as it was: the bounded read answered by the old statement. */
function withSpecTimeZoneRead(store: WorkspaceStore): WorkspaceStore {
  const swap = (tx: Transaction): Transaction => ({
    workspaceId: tx.workspaceId,
    query: (text, params) =>
      text === timeZoneChangesSql(1) || text === timeZoneChangesSql(0) ? tx.query(TIME_ZONE_SPEC) : tx.query(text, params),
    execute: (text, params) => tx.execute(text, params),
  });
  return { ...store, read: (work) => store.read((tx) => work(swap(tx))) };
}

interface Note {
  id: string;
  at: string;
  ref: string;
  kind?: string;
}

/** Changes filed on the test's sites, in one statement, in the order given. */
async function notes(rows: Note[]): Promise<void> {
  const store = ctx.call;
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind, ref, note)
       SELECT $1::uuid, n.asset_id, n.at, n.kind, n.ref, 'change'
         FROM unnest($2::text[], $3::timestamptz[], $4::text[], $5::text[]) WITH ORDINALITY AS n(asset_id, at, kind, ref, filed)
        ORDER BY n.filed`,
      [tx.workspaceId, rows.map((row) => row.id), rows.map((row) => row.at), rows.map((row) => row.kind ?? "config"), rows.map((row) => row.ref)],
    ),
  );
}

function everyDay(from: string, to: string): Record<string, number> {
  const out: Record<string, number> = {};
  let value = 1;
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) {
    out[new Date(t).toISOString().slice(0, 10)] = value;
    value += 1;
  }
  return out;
}

/**
 * Two assets whose series start on different days, and changes on every edge
 * of "after the series' first point":
 *  - a.example (GA4 + Search Console) charts from 2026-06-20; b.example's GA4
 *    lane last succeeded weeks earlier, so it charts from 2026-05-01 and sets
 *    the read's lower bound for everyone;
 *  - changes ON a first point (at midnight and late in the day) are not kept,
 *    the day after is; one is stored with a space rather than a `T`;
 *  - a change before every series, a change for an asset with no series, a
 *    malformed ref, a timezone ref under another kind, and two changes on one
 *    series on one day.
 */
async function seedTimeZoneEdges(): Promise<void> {
  await run({ id: "a-ga4", asset: "a.example", finishedAt: "2026-07-05T11:00:00.000Z", windowStart: "2026-06-20", windowEnd: "2026-07-05" });
  await run({ id: "a-gsc", asset: "a.example", integration: "gsc", finishedAt: "2026-07-05T11:00:00.000Z", windowStart: "2026-06-25", windowEnd: "2026-07-04" });
  await run({ id: "b-ga4", asset: "b.example", finishedAt: "2026-05-10T11:00:00.000Z", windowStart: "2026-05-01", windowEnd: "2026-05-09" });
  await observe("a-ga4", everyDay("2026-06-20", "2026-07-05"));
  await observe("a-ga4", everyDay("2026-06-20", "2026-07-05"), "sessions");
  await observe("a-gsc", everyDay("2026-06-25", "2026-07-04"), "clicks");
  await observe("b-ga4", everyDay("2026-05-01", "2026-05-09"));

  const ga4 = "reporting-time-zone-changed:ga4:America/Los_Angeles->America/New_York";
  await notes([
    { id: "a.example", at: "2025-01-01T00:00:00.000Z", ref: ga4 }, // before every series
    { id: "b.example", at: "2026-05-01T00:00:00.000Z", ref: ga4 }, // ON b's first point: dropped
    { id: "b.example", at: "2026-05-02T00:00:00.000Z", ref: ga4 }, // the day after: kept
    { id: "a.example", at: "2026-06-20T23:59:59.000Z", ref: ga4 }, // ON a's first point, late: dropped
    { id: "a.example", at: "2026-06-21 08:00:00", ref: ga4 }, // no `T` (read as UTC): kept
    { id: "a.example", at: "2026-06-28T09:00:00.000Z", ref: "reporting-time-zone-changed:ga4:America/New_York->UTC" },
    { id: "a.example", at: "2026-06-28T15:00:00.000Z", ref: "reporting-time-zone-changed:ga4:UTC->Europe/Paris" },
    { id: "a.example", at: "2026-06-25T00:00:00.000Z", ref: "reporting-time-zone-changed:gsc:UTC->America/Chicago" }, // ON gsc's first point
    { id: "a.example", at: "2026-06-26T00:00:00.000Z", ref: "reporting-time-zone-changed:gsc:America/Chicago->UTC" },
    { id: "c.example", at: "2026-06-30T00:00:00.000Z", ref: ga4 }, // no series at all
    { id: "a.example", at: "2026-06-30T00:00:00.000Z", ref: "reporting-time-zone-changed:ga4" }, // malformed
    { id: "a.example", at: "2026-06-30T00:00:00.000Z", ref: ga4, kind: "deploy" }, // not a config change
  ]);
}

type TrendRead = (store: WorkspaceStore) => ReturnType<typeof loadSignalTrends>;

/** Every trend read the Tower makes: the Wall's two and the asset page's. */
const TREND_READS: [string, TrendRead][] = [
  ["Wall cards", (store) => loadSignalTrends(store, 28, { includeWebSearch: true, nowMs: NOW_MS })],
  ["Wall revenue traffic", (store) => loadSignalTrends(store, 84, { includeWebSearch: false, includeSessions: true, nowMs: NOW_MS })],
  ["asset page", (store) => loadSignalTrends(store, 90, { includeSecondarySeries: true, asset: "a.example", nowMs: NOW_MS })],
  ["asset page, the older asset", (store) => loadSignalTrends(store, 90, { includeSecondarySeries: true, asset: "b.example", nowMs: NOW_MS })],
  ["a short window", (store) => loadSignalTrends(store, 3, { includeWebSearch: true, nowMs: NOW_MS })],
];

interface Seen {
  sql: string;
  params: unknown[];
}

/** The call's store, recording each statement it sends with its values. */
function recordingStore(store: WorkspaceStore, seen: Seen[]): WorkspaceStore {
  const watched = (tx: Transaction): Transaction => ({
    workspaceId: tx.workspaceId,
    query: (sql, params) => {
      seen.push({ sql, params: [...(params ?? [])] });
      return tx.query(sql, params);
    },
    execute: (sql, params) => {
      seen.push({ sql, params: [...(params ?? [])] });
      return tx.execute(sql, params);
    },
  });
  return {
    where: store.where,
    workspaceId: () => store.workspaceId(),
    read: (work) => store.read((tx) => work(watched(tx))),
    write: (work) => store.write((tx) => work(watched(tx))),
    close: () => store.close(),
  };
}

/** Postgres's plan for a statement, as the store would run it once a history
 * has grown: a table scan forbidden, as an empty table is cheapest to scan. */
async function postgresPlan(store: WorkspaceStore, sql: string, params: readonly unknown[]): Promise<string> {
  const rows = await store.read(async (tx) => {
    await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
    return tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, params as never);
  });
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

describe("loadSignalTrends — the timezone lookup reads only the charted window (ro-ujb9.102)", () => {
  it("marks exactly the changes the whole-store read marked, on every trend read", async () => {
    await seedTimeZoneEdges();
    const store = ctx.call;
    for (const [name, read] of TREND_READS) {
      expect([...(await read(store))], name).toEqual([...(await read(withSpecTimeZoneRead(store)))]);
    }
    // The edges are really in the fixture, so the equality means something.
    const wall = await trends(28, { includeWebSearch: true, nowMs: NOW_MS });
    const marks = (asset: string, pick: (set: ReturnType<typeof emptySignalTrendSet>) => { timeZoneChanges: { effectiveOn: string }[] }) =>
      pick(wall.get(asset)!).timeZoneChanges.map((change) => change.effectiveOn);
    expect(marks("a.example", (set) => set.activeUsers)).toEqual(["2026-06-21", "2026-06-28", "2026-06-28"]);
    expect(marks("a.example", (set) => set.webSearchClicks.google)).toEqual(["2026-06-26"]);
    expect(marks("b.example", (set) => set.activeUsers)).toEqual(["2026-05-02"]);
  });

  it("a read narrowed to several assets is the portfolio read, cut to those assets", async () => {
    await seedTimeZoneEdges();
    const options = { includeWebSearch: false, includeSessions: true, nowMs: NOW_MS };
    const portfolio = await trends(84, options);
    for (const assets of [["a.example"], ["b.example", "a.example"], ["a.example", "c.example"], ["unknown.example"]]) {
      const narrowed = await trends(84, { ...options, assets });
      expect([...narrowed], assets.join()).toEqual([...portfolio].filter(([id]) => assets.includes(id)));
    }
    // An empty list reads nothing at all.
    const seen: Seen[] = [];
    expect((await loadSignalTrends(recordingStore(ctx.call, seen), 84, { ...options, assets: [] })).size).toBe(0);
    expect(seen).toEqual([]);
    // `asset` wins over `assets`, as the one-asset page expects.
    expect([...(await trends(84, { ...options, asset: "b.example", assets: ["a.example"] }))])
      .toEqual([...portfolio].filter(([id]) => id === "b.example"));
  });

  it("reads nothing when no series has a point to mark", async () => {
    await notes([{ id: "a.example", at: "2026-06-28T09:00:00.000Z", ref: "reporting-time-zone-changed:ga4:UTC->America/Chicago" }]);
    const store = ctx.call;
    const seen: Seen[] = [];
    expect((await loadSignalTrends(recordingStore(store, seen), 28, { nowMs: NOW_MS })).size).toBe(0);
    expect(seen).toHaveLength(1); // the series read only
    expect([...(await loadSignalTrends(withSpecTimeZoneRead(store), 28, { nowMs: NOW_MS }))]).toEqual([]);
  });

  it("years of older notes leave every trend read unchanged", async () => {
    await seedTimeZoneEdges();
    const store = ctx.call;
    const before = await Promise.all(TREND_READS.map(([, read]) => read(store).then((map) => [...map])));
    const older: Note[] = [];
    for (let day = 400; day <= 2200; day += 1) {
      const tz = day % 3 === 0;
      older.push({
        id: day % 2 ? "a.example" : "b.example",
        at: new Date(NOW_MS - day * DAY).toISOString(),
        ref: tz ? "reporting-time-zone-changed:ga4:UTC->America/Denver" : `sha${day}`,
        kind: tz ? "config" : "deploy",
      });
    }
    await notes(older);
    const after = await Promise.all(TREND_READS.map(([, read]) => read(store).then((map) => [...map])));
    expect(after).toEqual(before);
  });

  it("seeks the annotation index per asset instead of scanning every annotation", async () => {
    // Pinned as a PLAN: the cost only shows at a history no fixture has. On
    // Postgres (bead ro-ujb9.76.5.7): each site's (site, time) range, its first
    // day inside the index condition.
    const store = ctx.call;
    for (const [sql, params] of [
      [timeZoneChangesSql(0), ["2026-06-01"]],
      [timeZoneChangesSql(1), ["2026-06-01", ["a.example"]]],
    ] as const) {
      const plan = await postgresPlan(store, sql, params);
      expect(plan, sql).not.toMatch(/Seq Scan on annotations/);
      expect(plan, sql).toMatch(/Index Scan using annotations_asset_at on annotations c\s.*\n\s+Index Cond: \(\(workspace_id = a\.workspace_id\) AND \(asset_id = a\.asset_id\) AND \(at >= /);
    }
    // Before: the whole table, no site and no time bound.
    expect(await postgresPlan(store, TIME_ZONE_SPEC, [])).not.toMatch(/asset_id = |at >= /);
  });

  it("every trend read seeks the run log and the values' (series, day) index", async () => {
    // The series read is already flat in history (`ro-48p.1`, measured again
    // for `ro-ujb9.102`); pinned here for every variant the Tower issues, on
    // Postgres since bead ro-ujb9.76.5.3.
    await seedTimeZoneEdges();
    const store = ctx.call;
    await ctx.analyze();
    for (const [name, read] of TREND_READS) {
      const seen: Seen[] = [];
      await read(recordingStore(store, seen));
      const series = seen.find((statement) => statement.sql.includes("latest_success AS"))!;
      const plan = await postgresPlan(store, series.sql, series.params);
      expect(plan, name).not.toMatch(/Seq Scan on (signal_runs|signal_observations|measurement_series)/);
      expect(plan, name).toMatch(/Index (Only )?Scan using signal_runs_latest on signal_runs candidate/);
      expect(plan, name).toMatch(/Index (Only )?Scan using signal_observations_series_date on signal_observations o/);
      expect(plan, name).toMatch(/Index Scan using signal_runs_pkey on signal_runs r\b[^\n]*\n\s+Index Cond: \(\(workspace_id = o\.workspace_id\) AND \(run_seq = o\.run_seq\)\)/);
    }
  });
});
