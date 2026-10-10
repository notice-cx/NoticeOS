export * from './integration-evidence';
import { loadIntegrationEvidence, buildNightlyReportLane } from './integration-evidence';
// Integrations payload assembly — behind GET /api/integrations and the
// `integrations` section of GET /api/assets/:id. The register's posture comes
// from config/integrations.json; collector health is derived read-only from
// the latest stored attempt by `mergeLane`, and the file is never rewritten.

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
// The other derived lane, and the layer under every one of them: can this OS
// reach the internet at all. The ingest decides fault before it attributes a
// statusless failure (workers/ingest/src/egress.ts) and files one flag against
// its own row; this lane is the read of that fact. The gate probes after a
// fetch returns no status, not on a schedule.
// ---------------------------------------------------------------------------
const EGRESS_LANE: IntegrationCatalogRow = {
  id: EGRESS_LANE_ID,
  layer: "os",
  label: "The OS's own internet connection",
  docRef: "workers/ingest/src/egress.ts · db/postgres/migrations/0001_baseline.sql",
  // The OS's own lane, run once for the whole portfolio; a content asset's
  // uplink is its host's problem.
  scope: "portfolio",
  // Two reference sites, asked only after a fetch came back without a status,
  // at most once every five minutes per run.
  usage: { cost: "free", trigger: "failed-fetch", limit: "1 check per 5 min" },
  onFailure: "pauses-asset-checks",
  // No credential at all; the facts row shows one only on a provider lane.
  credential: "shared",
  derived: true,
};

// ---------------------------------------------------------------------------
// The egress lane, pure over the two things the store holds about it.
// ---------------------------------------------------------------------------
/** The open `os-egress-down` flag, as the read side needs it. */
export interface EgressFlag {
  /** The first down verdict of this outage: the gate leaves it alone while
   * the outage continues, so this row dates the moment the connection went. */
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
 * The one egress state decision.
 *
 *   • an open os-egress-down flag        → degraded (the beacons that failed)
 *   • …whose connection has come back    → live (collectors still catching up)
 *   • anything else                      → live
 *
 * The middle branch exists because the flag outlives the outage: it stays
 * open until every collector that missed an asset has run again, and records
 * `connectionBackAt` the moment a reference site answers. There is
 * deliberately no staleness branch: the gate probes only after something
 * already failed, so old rows, or none, mean nothing has had to ask.
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
        // The same words this fact has in the attention band
        // (shared/alert-language.ts `egressDown`); only the polarity differs.
        source: "Reference sites that did not answer",
        // Verbatim: the argument for not blaming the assets is that unrelated
        // sites failed the same way.
        detail: beacons.join(" · "),
        at: flag.firedAt,
      },
    ];
    if (unmeasured.length > 0) {
      // The collectors checked nothing there, so nothing about these sites
      // was concluded either way.
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
    // The last check: its age dates the last time the connection was in
    // doubt. A failed one with no alert open means the connection was proved
    // since, or the alert was closed by hand.
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
        // No outage alert and no check on record: the cell reads Not checked,
        // never Working.
        source: "No internet check recorded",
        detail: "",
        at: null,
      },
    ],
  };
}

/** The derived egress row: one real cell, on the OS's own column. */
export function buildEgressLane(
  assets: IntegrationAssetRef[],
  flag: EgressFlag | null,
  latest: EgressCheck | null,
): DerivedLaneRow {
  const cells: Record<string, IntegrationCellBase> = {};
  for (const a of assets) {
    // The same scope rule the declared register uses (`registerCell`), so the
    // matrix keeps having no holes.
    const ruled = derivedNotApplicable(EGRESS_LANE.scope, a.isOs);
    cells[a.id] = ruled
      ? { assetId: a.id, laneId: EGRESS_LANE_ID, effective: "not-applicable", evidence: [] }
      : { assetId: a.id, laneId: EGRESS_LANE_ID, ...egressState(flag, latest) };
  }
  return { catalog: EGRESS_LANE, cells };
}

/** Stored JSON as a plain record, parsed defensively: an unreadable payload
 * degrades to a lane that says less, never to a throw inside a page load. */
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

/** Beacon readings as sentence fragments, in the order they were asked. A
 * flag carries the error verbatim, while an egress_checks row carries the
 * HTTP status that proved egress (any status at all is the proof). */
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
  /** config/serp-panel.json — key set only. An asset listed here is due one
   * more weekly DataForSEO family, so the lane's completeness test cannot be a
   * portfolio constant. */
  serpPanel: { assets?: Record<string, unknown> };
  /** config/constants.json `no_nightly_report` — the assets declared as
   * sending no nightly report, whose derived lane is Not using. */
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
 * recorded. Building it writes nothing. */
export async function buildIntegrationsMatrix(store: WorkspaceStore, deps: IntegrationsDeps): Promise<IntegrationsMatrix> {
  return {
    ...(await assembleIntegrationsMatrix(store, deps)),
    history: connectionHistoryPayload(await loadConnectionHistory(store)),
  };
}

/** What one hourly recording of the source history did. */
export type SourceHistoryRun = { outcome: "ran"; written: number };

/** The hourly step (worker/tower-cron.ts): build the matrix with the
 * derivation the page uses and upsert today's row per data source
 * (connection-daily.ts), so a day the OS ran has a point whether or not
 * anyone opened a page. */
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

  // Columns: the register's authored asset order (seed order), joined to live
  // display names from the site list. Never sorted.
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
  // The OS's own row is store data (`assets.is_os`), never a written-down id.
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
    // Egress first: the layer that explains the others.
    derivedLanes: [egress, nightly],
    assets,
    cells,
    // Derived cells count once, by effective state, exactly like declared ones.
    summary: summarize(all),
    // The register's own invariant, checked: adding a catalog row from
    // /settings gives no asset a status. The two derived lanes have no catalog
    // row to owe an entry for.
    undeclared: undeclaredLanes(catalog, assets, integrations.assets),
    // About credentials the operator still has to create; the derived lane is
    // never file-declared, so it is outside that count.
    sharedCredential: sharedCredentialInsight(catalog, cells),
    dataSpend: {
      period: utcMonth(now),
      ...(await loadDataForSeoSpend(store, now)),
      capUsd: monthlyCaps.dataUsd,
    },
  };
}

/** Latest accepted report per asset — the derived lane's whole evidence
 * base: the newest arrival of a day's current revision. */
async function loadLastReports(store: WorkspaceStore): Promise<Map<string, string>> {
  const rows = await store.read((tx) =>
    tx.query<{ asset: string; latest: string }>(
      `SELECT asset_id AS asset, max(received_at) AS latest FROM noticeos.current_pulses GROUP BY asset_id`,
    ),
  );
  return new Map(rows.map((r) => [r.asset, javascriptInstant(r.latest)]));
}

/**
 * The open `os-egress-down` flag on the OS's own row — the down signal for
 * egress. `resolved_at IS NULL` alone, deliberately: a disposition is not
 * read, because acking an outage does not put the uplink back, and the gate
 * retracts this row itself (workers/ingest/src/egress.ts).
 * `connectionBackAt` in its inputs says which half is still true.
 */
async function loadOpenEgressFlag(
  store: WorkspaceStore,
  osAssetId: string,
): Promise<EgressFlag | null> {
  // As its newest reading states it (`current_flags`).
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
 * The newest probe round on record (`noticeos.egress_checks`). A round is
 * written only when a lane had to ask, so no row is the healthy shape, not a
 * missing reading. One seek down `egress_checks_observed`, with the row's
 * identity as the tiebreak.
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
