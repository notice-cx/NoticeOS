export * from './integration-evidence';
import { loadIntegrationEvidence, buildNightlyReportLane } from './integration-evidence';
// Integrations payload assembly — behind GET /api/integrations (the portfolio
// matrix) and the `integrations` section of GET /api/assets/:id. Pure over the
// call's injected store (Postgres, a test's own copy under Vitest), so the
// exact SQL runs against the real schema.
//
// The register's setup/applicability posture comes from
// config/integrations.json (injected at build time, supplied directly by tests
// — never read from disk here). Collector health is derived READ-ONLY from the
// latest stored attempt by `mergeLane`; the file is never rewritten, and every
// observed state carries its WHY as an evidence line.

import { assetDisplayName } from "@noticeos/contract/asset-name";
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { readSites } from "./asset-registry";
import {
  connectionHistoryPayload,
  loadConnectionHistory,
  recordConnectionDay,
} from "./connection-daily";
import type { PullConfigEntry } from "./asset-config";
import { loadDataForSeoSpend, utcMonth } from "./metered-spend";
import {
  type DerivedLaneRow,
  type IntegrationCatalogRow,
  type IntegrationCell,
  type IntegrationCellBase,
  type IntegrationEvidence,
  type IntegrationState,
  type IntegrationsConfig,
  type IntegrationsMatrix,
  type IntegrationAssetRef,
  EGRESS_LANE_ID,
  INTEGRATIONS_OWNER,
  derivedNotApplicable,
  sharedCredentialInsight,
  summarize,
  undeclaredLanes,
} from "../shared/integrations";
// ---------------------------------------------------------------------------
// The other DERIVED lane, and the layer under every one of them: can this OS
// reach the internet at all (bead `ro-034`).
//
// THE INCIDENT. 2026-08-08, the operator's home internet was down for the night.
// Every nightly lane runs from that machine, so the OS fired ~15 flags accusing
// six assets of being dark. The ingest side now decides fault before it
// attributes a statusless failure (workers/ingest/src/egress.ts) and files ONE
// flag against its own row; this lane is the read of that fact.
//
// The gate probes after a fetch returns no status, not on a schedule. Raw
// effective state retains the open-outage contract; the display separately
// distinguishes absence of an outage from verified current connectivity.
// ---------------------------------------------------------------------------
const EGRESS_LANE: IntegrationCatalogRow = {
  id: EGRESS_LANE_ID,
  layer: "os",
  label: "The OS's own internet connection",
  docRef: "workers/ingest/src/egress.ts · db/postgres/migrations/0001_baseline.sql",
  // Live means no unresolved internet-outage alert. Checks happen after a
  // failed fetch, not continuously, so live alone never verifies the
  // connection now — the cell reads Not checked until a check is recorded.
  // The OS's own lane, run once for the whole portfolio. A content asset has
  // no cell here: its uplink is its host's problem, not this machine's.
  scope: "portfolio",
  // The check is lazy — two reference sites, asked only after a fetch came
  // back without a status, at most once every five minutes per run — and an
  // outage pauses the asset checks rather than failing them (bead `ro-034`).
  usage: { cost: "free", trigger: "failed-fetch", limit: "1 check per 5 min" },
  onFailure: "pauses-asset-checks",
  // No credential at all: the reference sites are asked anonymously, under the
  // OS's own User-Agent. The facts row shows a credential only on a provider
  // lane, so this value is never drawn.
  credential: "shared",
  derived: true,
};

// ---------------------------------------------------------------------------
// The L0 egress lane — PURE over the two things the store holds about it.
// ---------------------------------------------------------------------------
/** The open `os-egress-down` flag, as the read side needs it. */
export interface EgressFlag {
  /** The FIRST down verdict of this outage — the gate leaves it alone while the
   * outage continues, so this row dates the moment the connection went. */
  firedAt: string;
  /** `flags.rule_inputs` verbatim: {beacons, unmeasuredAssets, failureCount, …}. */
  ruleInputs: string | null;
}

/** The newest row in `egress_checks`, or null when the table is empty. */
export interface EgressCheck {
  observedAt: string;
  up: boolean;
  /** The round's `detail` as JSON text: {beacons: [{url, status, error?}, …]}. */
  detail: string | null;
}

/**
 * The one L0 state decision.
 *
 *   • an OPEN os-egress-down flag        → degraded (the beacons that failed)
 *   • …whose connection has come back    → live (collectors still catching up)
 *   • anything else                      → live
 *
 * The middle branch exists because the flag now outlives the outage (bead
 * `ro-aed0.5`): it stays open until every collector that missed an asset has run
 * again, and records `connectionBackAt` the moment a reference site answers. The
 * uplink is this row's subject, so a flag held open only for re-collection is no
 * longer evidence against it — the gaps it names stay in the attention band.
 *
 * There is deliberately no staleness branch. Every other lane in this file goes
 * amber when its evidence ages past a cadence, and doing that here would invert
 * the meaning of the data: the gate probes only after something already failed,
 * so old rows — or none at all — mean nothing has had to ask. Rendering that as
 * degraded would recreate the 2026-08-08 failure in the opposite direction,
 * reporting a quiet night as a problem.
 */
export function egressState(
  flag: EgressFlag | null,
  latest: EgressCheck | null,
): { effective: IntegrationState; evidence: IntegrationEvidence[] } {
  if (flag) {
    const inputs = parseStoredJson(flag.ruleInputs);
    const beacons = beaconLines(inputs?.beacons);
    const unmeasured = stringList(inputs?.unmeasuredAssets);
    const backAt = typeof inputs?.connectionBackAt === "string" ? inputs.connectionBackAt : null;
    if (backAt !== null) {
      return {
        effective: "live",
        evidence: [
          {
            polarity: "supporting",
            source: "Connection answered again",
            detail: unmeasured.length > 0 ? `Waiting on ${unmeasured.join(", ")}` : "Waiting on the next collection",
            at: backAt,
          },
        ],
      };
    }
    const evidence: IntegrationEvidence[] = [
      {
        polarity: "against",
        // The same words this fact already has in the attention band
        // (shared/alert-language.ts `egressDown`), so one fact does not read as
        // two things on two surfaces. Only the polarity differs, and it has to:
        // there the evidence SUPPORTS the alert, here it is evidence AGAINST the
        // lane's health.
        source: "Reference sites that did not answer",
        // Verbatim, because the whole argument for not blaming the assets is
        // that two unrelated sites failed exactly the way the assets did. An
        // alert that recorded none shows the title and its age alone.
        detail: beacons.join(" · "),
        at: flag.firedAt,
      },
    ];
    if (unmeasured.length > 0) {
      // Named, as values: the collectors checked nothing there, so nothing
      // about these sites was concluded either way.
      evidence.push({
        polarity: "against",
        source: "Sites not measured",
        detail: unmeasured.join(" · "),
        at: flag.firedAt,
      });
    }
    return { effective: "degraded", evidence };
  }

  if (latest) {
    // The last check, as its result and its readings: a check runs only after
    // a fetch came back empty-handed, so its age dates the last time the
    // connection was in doubt. A failed one with no alert open means the
    // connection was proved since, or the alert was closed by hand.
    const beacons = beaconLines(parseStoredJson(latest.detail)?.beacons);
    return {
      effective: "live",
      evidence: [
        {
          polarity: "supporting",
          source: latest.up ? "Internet check passed" : "Internet check failed",
          detail: beacons.join(" · "),
          at: latest.observedAt,
        },
      ],
    };
  }

  return {
    effective: "live",
    evidence: [
      {
        polarity: "supporting",
        // No outage alert and no check on record: checks run only after a
        // fetch fails, so an empty record is not a continuous health check —
        // the cell reads Not checked, never Working.
        source: "No internet check recorded",
        detail: "",
        at: null,
      },
    ],
  };
}

/** The derived L0 row: one real cell, on the OS's own column. */
export function buildEgressLane(
  assets: IntegrationAssetRef[],
  flag: EgressFlag | null,
  latest: EgressCheck | null,
): DerivedLaneRow {
  const cells: Record<string, IntegrationCellBase> = {};
  for (const a of assets) {
    // The SAME scope rule the declared register uses (`registerCell`), so a
    // content asset's column reads Doesn't apply rather than a hole the
    // operator has to interpret — and the matrix keeps having no holes.
    const ruled = derivedNotApplicable(EGRESS_LANE.scope, a.isOs);
    cells[a.id] = ruled
      ? { assetId: a.id, laneId: EGRESS_LANE_ID, effective: "not-applicable", evidence: [] }
      : { assetId: a.id, laneId: EGRESS_LANE_ID, ...egressState(flag, latest) };
  }
  return { catalog: EGRESS_LANE, cells };
}

/**
 * Stored JSON as a plain record. `flags.rule_inputs` and
 * `egress_checks.detail` are written by another Worker, so they are parsed
 * defensively: an unreadable payload must degrade to a lane that says less,
 * never to a throw inside a page load.
 */
function parseStoredJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Beacon readings as sentence fragments, in the order they were asked. Both
 * stores carry `url`; a flag carries the error verbatim, while an egress_checks
 * row carries the HTTP status that proved egress (any status at all is the
 * proof — see the module header of workers/ingest/src/egress.ts). */
function beaconLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const beacon = entry as Record<string, unknown>;
    if (typeof beacon.url !== "string") continue;
    const status = typeof beacon.status === "number" ? `HTTP ${beacon.status}` : null;
    const error = typeof beacon.error === "string" ? beacon.error : null;
    lines.push(`${beacon.url}: ${status ?? error ?? "no response"}`);
  }
  return lines;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// ---------------------------------------------------------------------------
// The portfolio matrix (GET /api/integrations).
// ---------------------------------------------------------------------------
export interface IntegrationsDeps {
  now: Date;
  /** config/integrations.json, verbatim (injected at build time / test-supplied). */
  integrations: IntegrationsConfig;
  /** config/pull.json, verbatim — who the OS fetches nightly (the derived lane). */
  pullConfig: PullConfigEntry[];
  /** config/constants.json `monthly_caps.data_usd` — what the metered lane's
   * month-to-date spend is measured against. */
  monthlyCaps: { dataUsd: number };
  /** config/serp-panel.json — key set only. An asset listed here is due a
   * SIXTH weekly DataForSEO family, so the lane's completeness test cannot be a
   * portfolio constant. */
  serpPanel: { assets?: Record<string, unknown> };
  /** config/constants.json `no_nightly_report` — the assets declared as
   * sending no nightly report, whose derived lane is Not using (ro-ujb9.96.8). */
  noNightlyReport?: readonly string[] | null;
}

/** The stored settings the matrix is built from, as the Tower's config
 * resolver (config-source.ts) answers them for a request or a tick. */
export type IntegrationsSettings = Omit<IntegrationsDeps, "now">;

/** The matrix's inputs out of the resolved settings — one mapping, so the page
 * and the hourly tick build the same matrix. */
export function integrationsDeps(settings: IntegrationsSettings, now: Date): IntegrationsDeps {
  return {
    now,
    integrations: settings.integrations,
    pullConfig: settings.pullConfig,
    monthlyCaps: settings.monthlyCaps,
    serpPanel: settings.serpPanel,
    noNightlyReport: settings.noNightlyReport,
  };
}

/** GET /api/integrations: the matrix, and the source history the hourly tick
 * recorded. Building it writes nothing (bead `ro-ujb9.96.7.31`). Every fact
 * it reads is in the call's store (epic ro-ujb9.76). */
export async function buildIntegrationsMatrix(store: WorkspaceStore, deps: IntegrationsDeps): Promise<IntegrationsMatrix> {
  return {
    ...(await assembleIntegrationsMatrix(store, deps)),
    history: connectionHistoryPayload(await loadConnectionHistory(store)),
  };
}

/** What one hourly recording of the source history did. */
export type SourceHistoryRun = { outcome: "ran"; written: number };

/**
 * THE HOURLY STEP (bead `ro-ujb9.96.7.31`, worker/tower-cron.ts): build the
 * matrix with the derivation the page uses and upsert today's row per data
 * source (connection-daily.ts, on Postgres), so a day the OS ran has a point
 * whether or not anyone opened a page.
 */
export async function recordTodaysSourceHistory(store: WorkspaceStore, deps: IntegrationsDeps): Promise<SourceHistoryRun> {
  const written = await recordConnectionDay(store, await assembleIntegrationsMatrix(store, deps), deps.now);
  return { outcome: "ran", written };
}

/** The matrix without its history: every cell, lane and summary. */
async function assembleIntegrationsMatrix(
  store: WorkspaceStore,
  { now, integrations, pullConfig, monthlyCaps, serpPanel, noNightlyReport }: IntegrationsDeps,
): Promise<Omit<IntegrationsMatrix, "history">> {
  const evidence = await loadIntegrationEvidence(store, { now, integrations, serpPanel, presentation: 'full' });
  const catalog = evidence.catalog;

  // Columns: the register's authored asset order (== db/0002 seed order), joined
  // to live display names from the site list on Postgres. Never sorted — a
  // stable column order is what makes the matrix scannable (doc 15 principle 3).
  const dbById = new Map((await readSites(store)).map((a) => [a.id, a]));
  const assets: IntegrationAssetRef[] = Object.keys(integrations.assets)
    .filter((id) => dbById.has(id))
    .map((id) => {
      const row = dbById.get(id)!;
      return { id, displayName: assetDisplayName(row.isOs, row.displayName), isOs: row.isOs === 1 };
    });

  const cells: Record<string, IntegrationCell[]> = {};
  const all: IntegrationCellBase[] = [];
  for (const a of assets) {
    const rowCells = evidence.cells(a.id, a.isOs);
    cells[a.id] = rowCells;
    all.push(...rowCells);
  }

  const nightly = buildNightlyReportLane(
    assets,
    await loadLastReports(store),
    pullConfig,
    now,
    new Set(noNightlyReport ?? []),
  );
  // The OS's own row is store data (`assets.is_os`), never a written-down id —
  // same reason the gate reads it rather than hard-coding the OS asset's id.
  const osAssetId = assets.find((a) => a.isOs)?.id ?? null;
  const egress = buildEgressLane(
    assets,
    osAssetId === null ? null : await loadOpenEgressFlag(store, osAssetId),
    await loadLatestEgressCheck(store),
  );
  all.push(...Object.values(nightly.cells), ...Object.values(egress.cells));

  return {
    generatedAt: now.toISOString(),
    owner: INTEGRATIONS_OWNER,
    catalog,
    // L0 first: the layer that explains the others. The client groups by layer,
    // but a reader of the raw payload should meet them in the same order.
    derivedLanes: [egress, nightly],
    assets,
    cells,
    // Derived cells count once, by effective state, exactly like declared ones —
    // so a live nightly lane raises `live` and never `needsAttention`.
    summary: summarize(all),
    // The register's own invariant, CHECKED (bead `ro-qodp`). Adding a catalog
    // row from /settings gives no asset a status, so the file lands in the state
    // config/integrations.README.md forbids and nothing said so — the README's
    // validation snippet exists and nothing in the repo runs it. Derived here
    // because this is where the catalog, the store's `is_os` flag and the file's
    // own cells are all in one place; the two derived lanes are outside it by
    // construction, having no catalog row to owe an entry for.
    undeclared: undeclaredLanes(catalog, assets, integrations.assets),
    // The shared-credential insight is about credentials the operator still has
    // to go and create; the derived lane is per-property and never file-declared,
    // so it is deliberately outside that count.
    sharedCredential: sharedCredentialInsight(catalog, cells),
    dataSpend: {
      period: utcMonth(now),
      ...(await loadDataForSeoSpend(store, now)),
      capUsd: monthlyCaps.dataUsd,
    },
  };
}

/** Latest accepted report per asset — the derived lane's whole evidence base.
 * On Postgres (bead ro-ujb9.76.5.2): the newest arrival of a day's current
 * revision, as D1's one row per day was stamped by its latest write. */
async function loadLastReports(store: WorkspaceStore): Promise<Map<string, string>> {
  const rows = await store.read((tx) =>
    tx.query<{ asset: string; latest: string }>(
      `SELECT asset_id AS asset, max(received_at) AS latest FROM noticeos.current_pulses GROUP BY asset_id`,
    ),
  );
  return new Map(rows.map((r) => [r.asset, javascriptInstant(r.latest)]));
}

/**
 * The open `os-egress-down` flag on the OS's own row — THE down signal for L0.
 *
 * `resolved_at IS NULL` alone, deliberately: unlike `loadPulseFlags` above, a
 * disposition is not read here. Acking an outage does not put the uplink back,
 * and the gate retracts this row itself once a reference site answers and every
 * collector that missed an asset has run again (workers/ingest/src/egress.ts),
 * so the flag still being open IS the current fact rather than an un-cleared
 * notification — `connectionBackAt` in its inputs says which half is still true.
 *
 * The rule id is spelled out here the same way the pulse-flag read spells its
 * two out: it is the ingest lane's constant, and the Tower restates it — see
 * `TRANSLATORS` in shared/alert-language.ts, which holds the same literal.
 */
async function loadOpenEgressFlag(
  store: WorkspaceStore,
  osAssetId: string,
): Promise<EgressFlag | null> {
  // As its newest reading states it (`current_flags`, bead ro-ujb9.76.5.2):
  // the gate appends each run's reading where D1 rewrote the row.
  const [row] = await store.read((tx) =>
    tx.query<{ firedAt: string; ruleInputs: string | null }>(
      `SELECT fired_at AS "firedAt", rule_inputs::text AS "ruleInputs"
         FROM noticeos.current_flags
        WHERE asset_id = $1 AND rule_id = 'os-egress-down' AND resolved_at IS NULL
        ORDER BY fired_at, flag_id
        LIMIT 1`,
      [osAssetId],
    ),
  );
  return row === undefined ? null : { firedAt: javascriptInstant(row.firedAt), ruleInputs: row.ruleInputs };
}

/**
 * The newest probe round on record, on Postgres (`noticeos.egress_checks`,
 * bead ro-ujb9.76.5.1).
 *
 * A round is written only when a lane had to ask, so this is "the last time
 * something failed and the connection was checked" — and NO row is the healthy
 * shape, not a missing reading. One seek down `egress_checks_observed`
 * (workspace, observed_at), with the row's identity as the tiebreak so two
 * rounds inside the same lane run resolve deterministically.
 */
export const LATEST_EGRESS_CHECK_SQL = `SELECT observed_at AS "observedAt", up, detail::text AS detail
  FROM noticeos.egress_checks
 ORDER BY observed_at DESC, egress_check_id DESC
 LIMIT 1`;

async function loadLatestEgressCheck(store: WorkspaceStore): Promise<EgressCheck | null> {
  const [row] = await store.read((tx) =>
    tx.query<{ observedAt: string; up: boolean; detail: string }>(LATEST_EGRESS_CHECK_SQL),
  );
  return row === undefined
    ? null
    : { observedAt: javascriptInstant(row.observedAt), up: row.up, detail: row.detail };
}
