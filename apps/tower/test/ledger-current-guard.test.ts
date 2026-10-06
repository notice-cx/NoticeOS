// @vitest-environment node
// The ledger's current-row guard, on Postgres (beads `ro-ujb9.101`,
// ro-ujb9.76.6.1).
//
// Every Tower money read keeps a row of the financial view only while no row
// of that view replaces it. On D1 each read added that guard itself (`CURRENT`,
// index-backed since ro-ujb9.101). The Postgres view, `noticeos.financial_ledger`,
// holds current money entries only, so the readers read it alone. The old
// guard is kept below as the specification, over the Postgres view:
//
//  - on a fixture holding every edge the guard exists for, the view keeps
//    exactly the rows the guard keeps;
//  - every builder that reads money returns the same payload when each of its
//    money statements reads the guarded rows instead of the view.
//
// D1's fixture also held a replaced ledger row with a NEGATIVE id equal to a
// month of daily estimates' synthesized id. Neither writer of the Postgres
// ledger books one: the route and the collectors take the store's identities,
// and the importer refuses an id below 1. So that collision cannot be stored.

import type { Transaction, WorkspaceStore } from "@noticeos/postgres";
import { describe, expect, it } from "vitest";
import { type AssetDetailDeps, buildAssetDetailPayload, buildAssetDetailView } from "../worker/asset-detail-payload";
import { buildFinancialsPayload } from "../worker/financials-payload";
import { buildIntegrationsMatrix } from "../worker/integrations-payload";
import { loadAssetMonths } from "../worker/ledger-history";
import { buildWallPayload, type BuildOptions } from "../worker/wall-payload";
import type { IntegrationsConfig } from "../shared/integrations";
import { createTestStore, type TestStore } from "./postgres-store";
import { bookLedger, type LedgerRow, writeMediavine } from "./money";
import { addSites } from "./sites";

/** The guard as every ledger read in the Tower wrote it before ro-ujb9.101, over the Postgres view. */
const SPEC_ROWS = `SELECT v.* FROM noticeos.financial_ledger v
  WHERE NOT EXISTS (SELECT 1 FROM noticeos.financial_ledger s WHERE s.supersedes_id = v.entry_id)`;

const NOW = new Date("2026-07-05T12:00:00.000Z");
const CARDS = ["meals.example", "nosh.example", "fees.example"] as const;
const INTEGRATIONS: IntegrationsConfig = { catalog: [], assets: {} };
const COUNTERS = { assets: {} };

const WALL_OPTIONS: BuildOptions = {
  now: NOW,
  osTimeZone: "UTC",
  constants: { dataUsd: 25 },
  integrations: INTEGRATIONS,
  serpPanel: { assets: {} },
  pullConfig: [],
  dashboard: {},
};

const DETAIL_DEPS: AssetDetailDeps = {
  now: NOW,
  flagDefaults: { alpha: 0.01, min_baseline_per_day: 3, low_volume_window_hours: 72 },
  pullConfig: [],
  monthlyCaps: { dataUsd: 25 },
  operatorRateUsdPerMin: 2,
  integrations: INTEGRATIONS,
  counters: COUNTERS,
  serpPanel: { assets: {} },
  signalPanels: { assets: {} },
  valueEvents: { assets: {} },
  ga4EventParams: { assets: {} },
  osTimeZone: "UTC",
};

interface Row {
  id: number;
  kind: "revenue" | "cost";
  asset: string;
  period: string;
  family: string;
  amount: number;
  state: "estimated" | "reconciled";
  supersedes?: number;
  source?: string;
}

/** One entry, named `fixture:<id>` so a view row says which it is. */
const entry = (row: Row): LedgerRow => ({
  id: row.id,
  kind: row.kind,
  asset: row.asset,
  period: row.period,
  family: row.family,
  amount_minor: row.amount,
  booking_state: row.state,
  supersedes_id: row.supersedes ?? null,
  source: row.source ?? null,
  recorded_at: `${row.period}-20T00:00:00.000Z`,
  external_id: `fixture:${row.id}`,
});

/** Daily Mediavine rows for `asset` from `first` to `last` inclusive, 400¢ each. */
function daily(asset: string, site: string, first: string, last: string) {
  const days: [string, number][] = [];
  for (let day = first; day <= last; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) days.push([day, 400]);
  return { id: `${asset}:${first}`, asset, siteId: site, start: first, end: last, attemptedAt: `${last}T08:00:00.000Z`, days, recordedAt: `${last}T08:00:00.000Z` };
}

async function sites(raw: TestStore) {
  // In both of the test's stores (test/sites.ts).
  await addSites(raw, [
    { id: "root-os", domain: null, displayName: "NoticeOS", status: "live", senseOnly: 0, isOs: 1, createdAt: "2026-01-01T00:00:00.000Z" },
    ...CARDS.map((id) => ({ id, displayName: id, status: "live", senseOnly: 0, createdAt: "2026-01-01T00:00:00.000Z" })),
  ]);
}

/**
 * Every edge the guard exists for:
 *  - a three-link correction chain (only its newest link is current) and a
 *    two-link one, across two booking states, and another three-link chain;
 *  - a Mediavine month estimate hidden by a complete month of daily rows, which
 *    the view replaces with a synthesized row of NEGATIVE number;
 *  - a reconciled Mediavine month, whose daily rows the view must not use;
 *  - a partial month of daily rows that is not usable, beside its estimate;
 *  - the current month, a future month, portfolio overhead on asset #0, and an
 *    asset with no ledger rows at all.
 */
async function seedLedger(store: WorkspaceStore) {
  // Correction chains.
  await bookLedger(store, [
    entry({ id: 1, kind: "revenue", asset: "meals.example", period: "2026-05", family: "ads", amount: 10_000, state: "estimated", source: "raptive-report" }),
    entry({ id: 2, kind: "revenue", asset: "meals.example", period: "2026-05", family: "ads", amount: 9_800, state: "reconciled", supersedes: 1, source: "raptive-report" }),
    entry({ id: 3, kind: "revenue", asset: "meals.example", period: "2026-05", family: "ads", amount: 9_850, state: "reconciled", supersedes: 2, source: "raptive-report" }),
    entry({ id: 4, kind: "revenue", asset: "meals.example", period: "2026-06", family: "affiliate", amount: 3_000, state: "estimated", source: "cj-export" }),
    entry({ id: 5, kind: "cost", asset: "meals.example", period: "2026-06", family: "infra", amount: 2_000, state: "reconciled" }),
    entry({ id: 30, kind: "revenue", asset: "nosh.example", period: "2026-06", family: "affiliate", amount: 700, state: "estimated", source: "cj-export" }),
    entry({ id: 31, kind: "revenue", asset: "nosh.example", period: "2026-06", family: "affiliate", amount: 650, state: "reconciled", supersedes: 30, source: "cj-export" }),
  ]);

  // Mediavine: June complete (usable, hides its estimate), April reconciled
  // (not usable), July partial (not usable, the estimate stays).
  await bookLedger(store, [
    entry({ id: 6, kind: "revenue", asset: "meals.example", period: "2026-06", family: "ads", amount: 11_000, state: "estimated", source: "mediavine" }),
    entry({ id: 8, kind: "revenue", asset: "meals.example", period: "2026-04", family: "ads", amount: 12_000, state: "estimated", source: "mediavine" }),
    entry({ id: 9, kind: "revenue", asset: "meals.example", period: "2026-04", family: "ads", amount: 11_900, state: "reconciled", supersedes: 8, source: "mediavine" }),
    entry({ id: 7, kind: "revenue", asset: "meals.example", period: "2026-07", family: "ads", amount: 1_600, state: "estimated", source: "mediavine" }),
  ]);
  await writeMediavine(store, [
    daily("meals.example", "mv-site", "2026-06-01", "2026-06-30"),
    daily("meals.example", "mv-site", "2026-04-01", "2026-04-30"),
    daily("meals.example", "mv-site", "2026-07-01", "2026-07-04"),
  ]);

  // Current month, future month, overhead, and one more three-link chain.
  await bookLedger(store, [
    entry({ id: 10, kind: "revenue", asset: "nosh.example", period: "2026-07", family: "ads", amount: 500, state: "estimated", source: "raptive-report" }),
    entry({ id: 11, kind: "cost", asset: "nosh.example", period: "2026-08", family: "infra", amount: 100, state: "reconciled" }),
    entry({ id: 20, kind: "cost", asset: "root-os", period: "2026-06", family: "infra", amount: 4_000, state: "reconciled" }),
    entry({ id: 100, kind: "revenue", asset: "nosh.example", period: "2026-03", family: "affiliate", amount: 900, state: "estimated", source: "cj-export" }),
    entry({ id: 12, kind: "revenue", asset: "nosh.example", period: "2026-03", family: "affiliate", amount: 950, state: "estimated", supersedes: 100, source: "cj-export" }),
    entry({ id: 13, kind: "revenue", asset: "nosh.example", period: "2026-03", family: "affiliate", amount: 925, state: "reconciled", supersedes: 12, source: "cj-export" }),
  ]);
}

/** A statement that reads the money view, rewritten to read the guarded rows. */
function toSpec(sql: string): string {
  const cte = `spec_ledger AS (${SPEC_ROWS})`;
  const body = sql.replaceAll("noticeos.financial_ledger", "spec_ledger");
  return /^\s*WITH\s/iu.test(body) ? body.replace(/^\s*WITH\s/iu, `WITH ${cte}, `) : `WITH ${cte}\n${body}`;
}

/** The store with every money statement read through `rewrite`, and recorded;
 * every other statement as it is (a `WITH RECURSIVE` read of the report runs
 * takes no second CTE in front of its own). */
function rewriting(store: WorkspaceStore, rewrite: (sql: string) => string, seen: string[]): WorkspaceStore {
  const wrap = (tx: Transaction): Transaction => ({
    workspaceId: tx.workspaceId,
    query: (sql, params) => {
      if (!sql.includes("noticeos.financial_ledger")) return tx.query(sql, params);
      seen.push(sql);
      return tx.query(rewrite(sql), params);
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

/** A builder over D1 (`db`, for what is still there) and the call's store. */
type Build = (store: WorkspaceStore) => Promise<unknown>;

const BUILDERS: [string, Build][] = [
  ["Wall", (store) => buildWallPayload(store, WALL_OPTIONS)],
  ["asset page, whole", (store) => Promise.all(["root-os", ...CARDS].map((id) => buildAssetDetailPayload(store, id, DETAIL_DEPS)))],
  ["asset page, a tab without the ledger", (store) => Promise.all(["root-os", ...CARDS].map((id) => buildAssetDetailView(store, id, DETAIL_DEPS, "alerts")))],
  ["/financials, its own month", (store) => buildFinancialsPayload(store, { now: NOW, osTimeZone: "UTC", domainOrders: [] })],
  ["/financials, June", (store) => buildFinancialsPayload(store, { now: NOW, osTimeZone: "UTC", domainOrders: [], period: "2026-06" })],
  ["/integrations", (store) => buildIntegrationsMatrix(store, { now: NOW, integrations: INTEGRATIONS, pullConfig: [], monthlyCaps: { dataUsd: 25 }, serpPanel: { assets: {} } })],
  ["per-asset months", (store) => loadAssetMonths(store).then((map) => [...map])],
];

/** A builder's answer, a refusal included (an unknown `?period=` is one). */
function settle(result: Promise<unknown>): Promise<unknown> {
  return result.then(
    (value) => ({ value }),
    (error: unknown) => ({ refused: error instanceof Error ? { ...error, name: error.name, message: error.message } : error }),
  );
}

async function compare(seed: (store: WorkspaceStore) => Promise<void>) {
  const ctx = await createTestStore();
  await sites(ctx);
  const store = ctx.call;
  await seed(store);
  for (const [name, build] of BUILDERS) {
    const shipped: string[] = [];
    const spec: string[] = [];
    const now = await settle(build( rewriting(store, (sql) => sql, shipped)));
    const before = await settle(build( rewriting(store, toSpec, spec)));
    expect(now, name).toEqual(before);
    // The rewrite reached this builder's reads, so the equality means something.
    expect(spec.length, name).toBeGreaterThan(0);
    expect(spec.length, name).toBe(shipped.length);
  }
  return { ctx, store };
}

describe("the money view keeps only current entries, as the old guard did (ro-ujb9.101, ro-ujb9.76.6.1)", () => {
  it("keeps exactly the rows the old guard kept", async () => {
    const ctx = await createTestStore();
    await sites(ctx);
    const store = ctx.call;
    await seedLedger(store);
    const rows = (sql: string) => store.read((tx) => tx.query<{ entry_number: bigint; external_id: string | null }>(`${sql} ORDER BY 3`));
    const view = await rows("SELECT v.* FROM noticeos.financial_ledger v");
    expect(view).toEqual(await rows(SPEC_ROWS));

    // The fixture really holds the edges the equality is about.
    const named = new Set(view.map((row) => row.external_id));
    for (const current of [3, 4, 5, 7, 9, 10, 11, 13, 20, 31]) expect(named.has(`fixture:${current}`), `${current}`).toBe(true);
    // Replaced links, and the Mediavine estimate June's daily rows stand in for.
    for (const gone of [1, 2, 6, 8, 12, 30, 100]) expect(named.has(`fixture:${gone}`), `${gone}`).toBe(false);
    // June's month of daily estimates stands in, under minus its first day's number.
    const june = view.find((row) => row.external_id === "mediavine:daily/meals.example/2026-06");
    expect(june?.entry_number).toBeLessThan(0n);
    // April (reconciled) and July (partial) daily rows are not usable months.
    expect(named.has("mediavine:daily/meals.example/2026-04") || named.has("mediavine:daily/meals.example/2026-07")).toBe(false);
  });

  it("every builder that reads the ledger returns the old guard's payload", async () => {
    await compare(seedLedger);
  });

  it("an empty ledger reads the same through both", async () => {
    await compare(async () => undefined);
  });

  it("no money read evaluates the view twice", async () => {
    // D1's first guard evaluated the whole view inside every read. Each money
    // statement now names the view once; the asset page's reads it once into
    // a MATERIALIZED set its parts share.
    const ctx = await createTestStore();
    await sites(ctx);
    const store = ctx.call;
    await seedLedger(store);
    const shipped: string[] = [];
    for (const [, build] of BUILDERS) await build( rewriting(store, (sql) => sql, shipped));
    expect(shipped.length).toBeGreaterThanOrEqual(10);
    for (const sql of shipped) expect(sql.split("noticeos.financial_ledger").length - 1, sql).toBe(1);
  });
});
