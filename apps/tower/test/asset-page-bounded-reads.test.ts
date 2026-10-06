// @vitest-environment node
// Two asset-page reads bounded by what the page shows (bead `ro-ujb9.103`).
//
// Site-health history used to read every night the asset ever recorded to
// keep ninety: its date filter skipped the middle column of the unique index,
// so SQLite could not use it. The timeline's bounds read counted every
// annotation, and found the watch-anchored change by walking all of them.
// Both old statements are kept below as the specification, in Postgres's
// words since the readings (bead ro-ujb9.76.5.8) and the changes and windows
// (bead ro-ujb9.76.5.7) moved there, and the page must state exactly what
// they stated. The measurement is in
// docs/artifacts/tower-perf-2026-09-23/measurements.md.

import { javascriptInstant, type Transaction, type WorkspaceStore } from "@noticeos/postgres";
import { describe, expect, it } from "vitest";
import {
  type AssetDetailDeps,
  HYGIENE_CHECK_IDS,
  HYGIENE_HISTORY_SQL,
  TIMELINE_ITEMS_SQL,
  TIMELINE_TOTAL_SQL,
  buildAssetDetailView,
} from "../worker/asset-detail-payload";
import { storeChanges, storeWatchWindow } from "./change-rows";
import { createTestStore, type TestStore, recordingStore } from "./postgres-store";

import { addSites } from "./sites";

const NOW = new Date("2026-07-05T12:00:00.000Z");
const DAY = 86_400_000;
const DEPS: AssetDetailDeps = {
  now: NOW,
  flagDefaults: { alpha: 0.01, min_baseline_per_day: 3, low_volume_window_hours: 72 },
  pullConfig: [],
  monthlyCaps: { dataUsd: 25 },
  operatorRateUsdPerMin: 2,
  integrations: { catalog: [], assets: {} },
  counters: { assets: {} },
  serpPanel: { assets: {} },
  signalPanels: { assets: {} },
  valueEvents: { assets: {} },
  ga4EventParams: { assets: {} },
  osTimeZone: "UTC",
};

/** The site-health read as it stood before this bead: no check named. */
const HYGIENE_SPEC = `SELECT check_id AS "checkId", observed_at AS "observedAt",
                observed_on AS "observedOn", status,
                value_num AS "valueNum", detail::text AS "detailJson"
           FROM noticeos.hygiene_checks
          WHERE asset_id = $1 AND observed_on >= $2::date
          ORDER BY check_id COLLATE "C" ASC, observed_on ASC`;

/** A site in both of the test's stores (test/sites.ts). */
async function asset(raw: TestStore, id: string): Promise<void> {
  await addSites(raw, [{ id, displayName: id, status: "live", senseOnly: 0, createdAt: "2026-01-01T00:00:00.000Z" }]);
}

// ─── site-health history ────────────────────────────────────────────────────
// On Postgres (bead ro-ujb9.76.5.8).

const dayOf = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString().slice(0, 10);

/** The store with `from` answered by `to` (same parameters). */
function rewritingStore(store: WorkspaceStore, from: string, to: string): WorkspaceStore {
  const swap = (tx: Transaction): Transaction => ({
    workspaceId: tx.workspaceId,
    query: (text, params) => tx.query(text === from ? to : text, params),
    execute: (text, params) => tx.execute(text === from ? to : text, params),
  });
  return {
    where: store.where,
    workspaceId: () => store.workspaceId(),
    read: (work) => store.read((tx) => work(swap(tx))),
    write: (work) => store.write((tx) => work(swap(tx))),
    close: () => store.close(),
  };
}

/** A plan's lines, with sequential scans off: an empty table is cheapest to
 * scan, so this shows the plan the index offers once the readings pile up. */
async function postgresPlan(store: WorkspaceStore, sql: string, params: string[]): Promise<string> {
  const rows = await store.read(async (tx) => {
    await tx.query("SELECT set_config('enable_seqscan', 'off', true)");
    return tx.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, params);
  });
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}

/**
 * - a.example: every check across a year, so most rows fall outside the
 *   90-day window; the window's first day (90 back) is in, the day before out;
 *   robots maps that are malformed, empty or absent on the newest nights; a
 *   failed night with no value.
 * - b.example: only `page-structure` rows in the window, so the section exists
 *   though it draws none of them.
 * - c.example: rows only before the window, so the section is absent.
 * - d.example: nothing at all.
 *
 * Written in one statement into the test's own copy of its sites
 * (test/sites.ts), which it returns.
 */
async function seedHygiene(ctx: TestStore): Promise<WorkspaceStore> {
  for (const id of ["a.example", "b.example", "c.example", "d.example"]) await asset(ctx, id);
  const rows: { id: string; check: string; days: number; status: string; value: number | null; detail: string }[] = [];
  const reading = (id: string, check: string, days: number, status = "ok", value: number | null = 100, detail = "{}") =>
    rows.push({ id, check, days, status, value, detail });
  for (let days = 365; days >= 1; days -= 1) {
    reading("a.example", "html-depth", days, days % 17 === 0 ? "unreachable" : "ok", days % 17 === 0 ? null : 1800 + days);
    reading("a.example", "sitemap", days, "ok", 400);
    reading("a.example", "page-structure", days, "warn", 3);
    // The store keeps only JSON, so the malformed night is a map that is not one.
    const detail = days === 1 ? JSON.stringify({ bots: "not a map" }) : days === 2 ? JSON.stringify({ bots: {} }) : days === 3 ? "{}" : JSON.stringify({ bots: { GPTBot: days % 2 === 0, ClaudeBot: true } });
    reading("a.example", "robots-ai-access", days, "ok", null, detail);
  }
  for (const days of [91, 90, 89]) reading("b.example", "page-structure", days);
  for (const days of [120, 91]) reading("c.example", "sitemap", days);
  const store = ctx.call;
  await store.write((tx) =>
    tx.execute(
      `INSERT INTO noticeos.hygiene_checks (workspace_id, asset_id, check_id, observed_at, observed_on, status, value_num, detail)
       SELECT $1::uuid, r.asset_id, r.check_id, r.observed_at, (r.observed_at AT TIME ZONE 'UTC')::date, r.status, r.value_num, r.detail::json
         FROM unnest($2::text[], $3::text[], $4::timestamptz[], $5::text[], $6::float8[], $7::text[])
           AS r(asset_id, check_id, observed_at, status, value_num, detail)`,
      [
        tx.workspaceId,
        rows.map((row) => row.id),
        rows.map((row) => row.check),
        rows.map((row) => `${dayOf(row.days)}T06:00:00.000Z`),
        rows.map((row) => row.status),
        rows.map((row) => row.value),
        rows.map((row) => row.detail),
      ],
    ),
  );
  return store;
}

describe("site-health history reads only its ninety days (ro-ujb9.103)", () => {
  it("returns the old read's rows, and the page states the same history", async () => {
    const ctx = await createTestStore();
    const store = await seedHygiene(ctx);
    const since = dayOf(90);
    const read = (sql: string, id: string) => store.read((tx) => tx.query(sql, [id, since]));
    for (const id of ["a.example", "b.example", "c.example", "d.example"]) {
      expect(await read(HYGIENE_HISTORY_SQL, id), id).toEqual(await read(HYGIENE_SPEC, id));
      const shipped = await buildAssetDetailView(store, id, DEPS, "sources");
      const before = await buildAssetDetailView(rewritingStore(store, HYGIENE_HISTORY_SQL, HYGIENE_SPEC), id, DEPS, "sources");
      expect(shipped, id).toEqual(before);
    }
    // The edges are really in the fixture.
    const a = (await buildAssetDetailView(ctx.call, "a.example", DEPS, "sources"))!.hygiene!;
    expect(a.htmlDepth.readings[0]!.date).toBe(since);
    expect(a.htmlDepth.readings).toHaveLength(90);
    expect(a.bots).toEqual([{ bot: "GPTBot", allowed: true }, { bot: "ClaudeBot", allowed: true }]); // night 4's map
    expect((await buildAssetDetailView(ctx.call, "b.example", DEPS, "sources"))!.hygiene).not.toBeNull();
    expect((await buildAssetDetailView(ctx.call, "c.example", DEPS, "sources"))!.hygiene).toBeNull();
    expect((await buildAssetDetailView(ctx.call, "d.example", DEPS, "sources"))!.hygiene).toBeNull();
  });

  it("names every check the store's vocabulary lists, so no stored row is left out", async () => {
    // The read lists check ids so the index can seek the date. A migration that
    // adds a check to the vocabulary must widen this list too, or the section
    // would stop reading the new check's rows without a word.
    const ctx = await createTestStore();
    const kinds = await (ctx.call).read((tx) =>
      tx.query<{ check_id: string }>(`SELECT check_id FROM noticeos_ref.check_kinds ORDER BY check_id COLLATE "C"`),
    );
    expect([...HYGIENE_CHECK_IDS]).toEqual(kinds.map((row) => row.check_id));
  });

  it("reads the site through the unique index, the window's first day inside the index condition", async () => {
    // Postgres applies the date inside the index scan, so a night before the
    // window is passed over in the index and never read from the table; the
    // check list filters what that returns. (SQLite could use the date only
    // after every check was named.)
    const store = (await createTestStore()).call;
    const shipped = await postgresPlan(store, HYGIENE_HISTORY_SQL, ["a.example", "2026-04-06"]);
    expect(shipped).toMatch(/Index Scan using hygiene_checks_workspace_id_asset_id_check_id_observed_on_key/);
    expect(shipped).toMatch(/Index Cond: .*asset_id = .*observed_on >= /);
    expect(shipped).not.toMatch(/Seq Scan/);
  });
});

// ─── the timeline ───────────────────────────────────────────────────────────
// On Postgres (bead ro-ujb9.76.5.7): the changes and the readback windows the
// read joins, and the old two reads in Postgres's words. A change is known by
// its workspace's number; a window anchors one when its ref is that number
// written out, D1's `w.ref = CAST(anchor.id AS TEXT)`.

/** The timeline's two reads as they stood before this bead. */
const TIMELINE_BOUNDS_SPEC = `SELECT count(*)::int AS total,
              COALESCE(SUM(CASE WHEN a.at >= (
                SELECT min(anchor.at)
                  FROM noticeos.annotations anchor
                  JOIN noticeos.watch_windows w
                    ON w.ref_kind = 'annotation' AND w.ref = anchor.annotation_number::text
                 WHERE anchor.asset_id = $1 AND w.asset_id = $1
              ) THEN 1 ELSE 0 END), 0)::int AS anchored
         FROM noticeos.annotations a
        WHERE a.asset_id = $1`;
const TIMELINE_ITEMS_SPEC = `SELECT annotation_number::int AS id, at, kind, ref, note
           FROM noticeos.annotations
          WHERE asset_id = $1
          ORDER BY at DESC, annotation_number DESC
          LIMIT $2`;
const TIMELINE_LIMIT = 200;

/** The timeline exactly as the old reader built it. */
async function specTimeline(store: WorkspaceStore, asset: string) {
  const [bounds] = await store.read((tx) => tx.query<{ total: number; anchored: number }>(TIMELINE_BOUNDS_SPEC, [asset]));
  const total = bounds?.total ?? 0;
  const depth = Math.max(TIMELINE_LIMIT, bounds?.anchored ?? 0);
  const items = (
    await store.read((tx) =>
      tx.query<{ id: number; at: string; kind: string; ref: string | null; note: string | null }>(TIMELINE_ITEMS_SPEC, [asset, depth]),
    )
  ).map((item) => ({ ...item, at: javascriptInstant(item.at) }));
  return { items, olderCount: Math.max(0, total - items.length) };
}

let nextAt = 0;
/** `at`s changes on one site, filed in order; their numbers. */
async function changes(store: WorkspaceStore, id: string, ats: string[]): Promise<number[]> {
  return storeChanges(
    store,
    ats.map((at) => {
      nextAt += 1;
      return { asset: id, at, kind: "deploy", ref: `sha${nextAt}`, note: `change ${nextAt}` };
    }),
  );
}

async function watch(store: WorkspaceStore, id: string, owner: string, refKind: "annotation" | "decision" | "manual", ref: string): Promise<void> {
  await storeWatchWindow(store, {
    id, asset: owner, refKind, ref, integration: "gsc", metric: "clicks",
    registeredAt: "2026-07-01T00:00:00.000Z", baselineStart: "2026-06-01", baselineEnd: "2026-06-28", offsets: [7, 14, 28],
  });
}

const minutesBack = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
const range = (count: number, at: (i: number) => string) => Array.from({ length: count }, (_, i) => at(i));

/**
 * - short.example: 150 changes, no anchor — every row, nothing older.
 * - exact.example: exactly 200 — every row, and the count still says 0.
 * - over.example: 201 — the newest 200 and "1 older".
 * - deep.example: 450, a watch anchored at the 300th newest, with a second
 *   change at the anchor's exact instant (a later number) and one just before
 *   it; plus windows that must NOT anchor: another asset's window on this
 *   asset's change, this asset's window on another asset's change,
 *   non-canonical refs ('007', ' 7', '7.0'), and a `decision` window whose ref
 *   is a number.
 * - shallow.example: 260, anchored at the 50th newest — the cap wins.
 * - empty.example: nothing.
 *
 * Written into the test's own copy of its sites (test/sites.ts), which it
 * returns.
 */
async function seedTimeline(ctx: TestStore): Promise<{ store: WorkspaceStore; anchor: number; twin: number }> {
  for (const id of ["short.example", "exact.example", "over.example", "deep.example", "shallow.example", "empty.example"]) await asset(ctx, id);
  const store = ctx.call;
  await changes(store, "short.example", range(150, (i) => minutesBack(i * 7)));
  await changes(store, "exact.example", range(200, (i) => minutesBack(i * 7)));
  await changes(store, "over.example", range(201, (i) => minutesBack(i * 7)));
  const deep = await changes(store, "deep.example", range(450, (i) => minutesBack(i * 11)));
  // Same instant as the anchor, filed later (higher number), and one just older.
  const anchorAt = minutesBack(299 * 11);
  const [twin] = await changes(store, "deep.example", [anchorAt]);
  await changes(store, "deep.example", [new Date(Date.parse(anchorAt) - 1000).toISOString()]);
  const shallow = await changes(store, "shallow.example", range(260, (i) => minutesBack(i * 13)));

  const anchor = deep[299]!;
  await watch(store, "w-deep", "deep.example", "annotation", String(anchor));
  await watch(store, "w-other-owner", "over.example", "annotation", String(deep[449]!)); // another asset's window
  await watch(store, "w-foreign-change", "deep.example", "annotation", String(shallow[259]!)); // another asset's change
  await watch(store, "w-padded", "deep.example", "annotation", `00${deep[440]!}`);
  await watch(store, "w-spaced", "deep.example", "annotation", ` ${deep[441]!}`);
  await watch(store, "w-decimal", "deep.example", "annotation", `${deep[442]!}.0`);
  await watch(store, "w-decision", "deep.example", "decision", String(deep[443]!));
  await watch(store, "w-shallow", "shallow.example", "annotation", String(shallow[49]!));
  await watch(store, "w-dangling", "short.example", "annotation", "999999"); // no such change
  return { store, anchor, twin: twin! };
}

describe("the timeline reads its own depth, not the whole history (ro-ujb9.103)", () => {
  it("states the same rows and the same 'N older' as the old two reads", async () => {
    const ctx = await createTestStore();
    const { store, anchor, twin } = await seedTimeline(ctx);
    for (const id of ["short.example", "exact.example", "over.example", "deep.example", "shallow.example", "empty.example"]) {
      const shipped = (await buildAssetDetailView(store, id, DEPS, "settings"))!.annotations;
      const spec = await specTimeline(store, id);
      expect({ ids: shipped.items.map((item) => item.id), olderCount: shipped.olderCount }, id)
        .toEqual({ ids: spec.items.map((item) => item.id), olderCount: spec.olderCount });
      expect(shipped.items, id).toEqual(spec.items);
    }
    // The edges are really in the fixture.
    const view = async (id: string) => (await buildAssetDetailView(store, id, DEPS, "settings"))!.annotations;
    expect((await view("short.example")).olderCount).toBe(0);
    expect((await view("exact.example"))).toMatchObject({ olderCount: 0 });
    expect((await view("exact.example")).items).toHaveLength(200);
    expect((await view("over.example")).olderCount).toBe(1);
    const deep = await view("deep.example");
    expect(deep.items.at(-1)!.id).toBe(anchor); // down to the anchor, ties included
    expect(deep.items.some((item) => item.id === twin)).toBe(true);
    expect(deep.items).toHaveLength(301);
    expect(deep.olderCount).toBe(151);
    expect((await view("shallow.example")).items).toHaveLength(200);
    expect((await view("empty.example"))).toEqual({ items: [], olderCount: 0 });
  });

  it("counts the asset's total only when the timeline is full", async () => {
    const ctx = await createTestStore();
    const { store } = await seedTimeline(ctx);
    const totals = async (id: string) => {
      const seen: string[] = [];
      await buildAssetDetailView(recordingStore(store, seen), id, DEPS, "settings");
      return seen.filter((sql) => sql === TIMELINE_TOTAL_SQL).length;
    };
    expect(await totals("short.example")).toBe(0);
    expect(await totals("empty.example")).toBe(0);
    expect(await totals("over.example")).toBe(1);
  });

  it("seeks the anchor through the watch windows and never walks the annotations", async () => {
    const store = (await createTestStore()).call;
    const items = await postgresPlan(store, TIMELINE_ITEMS_SQL, ["deep.example", "200"]);
    expect(items).not.toMatch(/Seq Scan/);
    // The page's rows and the anchored count: the site's (site, time) range.
    const scan = (on: string, cond: string) => new RegExp(`using ${on}\\s.*\\n\\s+Index Cond: ${cond}`);
    expect(items).toMatch(scan("annotations_asset_at on annotations n", "\\(\\(workspace_id = .*\\) AND \\(asset_id = "));
    expect(items).toMatch(scan("annotations_asset_at on annotations a", "\\(\\(workspace_id = .*\\) AND \\(asset_id = .*\\) AND \\(at >= "));
    // The anchors: the site's annotation windows, then each change by its
    // number, never the site's changes walked.
    expect(items).toMatch(scan("watch_windows_asset_ref on watch_windows w", "\\(\\(workspace_id = .*\\) AND \\(asset_id = .*\\) AND \\(ref_kind = 'annotation'::text\\)\\)"));
    expect(items).toMatch(scan("annotations_workspace_id_annotation_number_key on annotations x", "\\(\\(workspace_id = .*\\) AND \\(annotation_number = anchors\\.number\\)\\)"));
    expect(items).not.toMatch(/Join Filter: \(anchor\.annotation_number/);
    expect(await postgresPlan(store, TIMELINE_TOTAL_SQL, ["deep.example"]))
      .toMatch(scan("annotations_asset_at on annotations", "\\(\\(workspace_id = .*\\) AND \\(asset_id = "));
  });
});
