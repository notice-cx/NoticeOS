// The integrations contract: the payloads GET /api/integrations and the
// `integrations` section of GET /api/assets/:id return. Types and pure display
// helpers only, so it loads in workerd and in the browser. The register it
// describes is config/integrations.json; collector health is derived read-only
// from the store at render time, and the file is never auto-edited.

import { INTEGRATION_PROVIDERS } from "@noticeos/contract/integrations";
import type { MeteredDataSpend, MeteredSpendAsset } from "@noticeos/contract/metered-spend";
import { AMBER_MULTIPLIER, CADENCE_HOURS, type CardDataSource, type SeriesPoint } from "./wall";
import { evidenceInstant } from "./signal-liveness";
import type { LaneFailureMode, LaneUsage } from "./lane-facts";

/** The provider whose credential a data source (register lane) runs on — the
 * card on Integrations that connects it — or null when none does. */
export function laneProvider(laneId: string): string | null {
  return INTEGRATION_PROVIDERS.find((provider) => provider.companionOf === undefined && provider.lanes.includes(laneId))?.id ?? null;
}

/** The one word a data source that is not working wears: a late nightly
 * report is Overdue, anything else is Failing. */
export function degradedKind(laneId: string): "overdue" | "failing" {
  return laneId === NIGHTLY_REPORT_LANE_ID ? "overdue" : "failing";
}

/**
 * A source the product cannot connect yet is not a to-do. The catalog can
 * carry a source no provider card on Integrations connects (uptime, affiliate
 * revenue, deployment history), and such a cell is never a to-do while it is
 * only Not set up; once in use (working, failing or declined) it is listed
 * like any other.
 */
export function withoutConnectPath(cell: { laneId: string; effective: IntegrationState }): boolean {
  return cell.effective === "needs-setup" && laneProvider(cell.laneId) === null;
}

/** …and while nothing has arrived for it either, it gets no row, no slot and
 * no grid line at all. Evidence keeps it (revenue added by hand), because that
 * row says where money came from. */
export function unusedWithoutConnectPath(cell: {
  laneId: string;
  effective: IntegrationState;
  evidence?: readonly unknown[];
}): boolean {
  return withoutConnectPath(cell) && (cell.evidence?.length ?? 0) === 0;
}

/** The five states, verbatim from config/integrations.README.md. */
export type IntegrationState =
  | "live"
  | "degraded"
  | "needs-setup"
  | "skipped"
  | "not-applicable";

export const INTEGRATION_STATES: IntegrationState[] = [
  "live",
  "degraded",
  "needs-setup",
  "skipped",
  "not-applicable",
];

/** The owner file every setup/applicability fact points at. */
export const INTEGRATIONS_OWNER = "config/integrations.json";

/** A lane that is never declared: the nightly self-report pipeline the OS
 * already runs. Its state is derived from the store on every read (the
 * worker's `buildNightlyReportLane`), so it has no cell in
 * config/integrations.json. */
export const NIGHTLY_REPORT_LANE_ID = "nightly-report";

/** The OS's own egress — the layer under every other lane. Also derived, from
 * the `os-egress-down` flag and the `egress_checks` rows the ingest lanes
 * write. */
export const EGRESS_LANE_ID = "egress";

/** Whether the site is up: no account and no connect step. The OS checks each
 * site's home page itself every hour, and the register cell reads its state
 * from that check (the worker's `uptimeState`). */
export const UPTIME_LANE_ID = "uptime";

/** Product names are presentation, not editable provider configuration. */
export function integrationLabel(id: string, fallback: string): string {
  const labels: Record<string, string> = {
    gsc: "Google Search Console",
    "bing-webmaster": "Bing Webmaster Tools",
    ga4: "Google Analytics",
    clarity: "Microsoft Clarity",
    posthog: "PostHog",
    dataforseo: "DataForSEO",
    uptime: "Uptime monitoring",
    "ad-network": "Ad revenue",
    "affiliate-cj": "CJ affiliate revenue",
    "affiliate-amazon": "Amazon affiliate revenue",
    "deploy-annotations": "Deployment history",
    "github-app": "GitHub",
    "discord-webhooks": "Discord notifications",
    "nightly-report": "Nightly report",
    egress: "Internet connection",
  };
  return labels[id] ?? fallback;
}

/** Direct evidence inputs compact enough for an asset header. Revenue,
 * notification, and Act credentials remain in the full integration register. */
export const PROPERTY_DATA_SOURCE_IDS = new Set([
  "gsc",
  "bing-webmaster",
  "ga4",
  "clarity",
  "posthog",
  "dataforseo",
  "uptime",
]);

// ---------------------------------------------------------------------------
// The config file shape (config/integrations.json). The worker reads
// setup/applicability posture from here and never writes it.
// ---------------------------------------------------------------------------
/** Whether a lane is unlocked by ONE portfolio credential ("shared") or has no
 * shareable credential so every cell is its own task ("per-property"). */
export type CredentialScope = "shared" | "per-property";

/**
 * Which side of the portfolio a lane can attach to at all. `property` — a
 * content asset's own surface (organic search, analytics, ad network); the
 * System row has none of them. `portfolio` — the OS's own lane, run once for
 * the whole portfolio; an asset has no cell of its own. `both` — applies
 * either side (uptime, the GitHub app), so the register states each cell.
 * This is what lets the register be sparse: the `not-applicable` cells are
 * derived from it.
 */
export type LaneScope = "property" | "portfolio" | "both";

/**
 * Which tier has to be working for a lane's cell to be working. `os` — this
 * machine and its own connection to the internet; a red row here means
 * nothing below it was measured. `provider` — a third-party service the OS
 * reads, and the account it reads with. `property` — the asset's own plumbing
 * has to reach the OS (its nightly report endpoint, its deploy pipeline).
 * Not `credential` restated: how many credentials a lane needs and whose
 * failure it reports are different facts (Clarity is a provider lane that
 * issues one token per project).
 */
export type IntegrationLayer = "os" | "provider" | "property";

/** Layers in the order they are read: widest blast radius first, so a red row
 * is read against what sits above it. */
export const INTEGRATION_LAYERS: IntegrationLayer[] = ["os", "provider", "property"];

export interface IntegrationsConfigCatalogRow {
  id: string;
  label: string;
  docRef: string;
  /** Defaults to `property`. */
  scope?: LaneScope;
  /** Defaults to `property`: a forgotten field claims nothing about a shared tier. */
  layer?: IntegrationLayer;
  credential?: CredentialScope;
}

export interface IntegrationsConfigCell {
  mediavineSiteId?: string;
  mediavineEnabled?: boolean;
  revenueHolidayCalendar?: 'none' | 'US' | 'CA' | 'US,CA';
  status: IntegrationState;
  /** Why the source is skipped, or what blocks it. Absent on a cell nobody has
   * said anything about, so the first reason is written as a first write. */
  note?: string;
  ref?: string;
  since: string;
  /**
   * The per-asset provider mapping, sparse: only the lanes that have one carry
   * any of these. Declared once, in `asset-lane`
   * (`scripts/config-registers.mjs`), which the Sources tab renders and the
   * write lane validates against.
   */
  propertyId?: string;
  siteUrl?: string;
  locationCode?: number;
  languageCode?: string;
}

export interface IntegrationsConfig {
  catalog: IntegrationsConfigCatalogRow[];
  /** assetId → laneId → file-backed setup/applicability cell. */
  assets: Record<string, Record<string, IntegrationsConfigCell>>;
}

// ---------------------------------------------------------------------------
// Observed evidence — the read-only merge output: the why behind an effective
// state that differs from (or annotates) the file-backed one.
// ---------------------------------------------------------------------------
export interface CollectionVerification {
  kind: "collection-success";
  laneId: string;
}

export interface IntegrationEvidence {
  /** Which way the evidence cuts. `against` explains an error/stale state;
   * `supporting` shows data actually arriving (or a manual revenue path). */
  polarity: "against" | "supporting";
  /** What happened, as a short title ("Nightly report overdue", "Affiliate revenue added by hand"). */
  source: string;
  /** The facts behind it as values ("1,840 daily rows · 2026-09-16 → 2026-09-22"),
   * never a sentence; empty when the title and age say it all. */
  detail: string;
  /** Store timestamp so the client can age it ("2d ago"); null when the time
   * context lives in the sentence (e.g. a ledger period). */
  at: string | null;
  /** Explicit outcome from a stored successful collector run. Optional for
   * older payloads; prose, polarity, and configured health are never proof.
   * The source id prevents one connection's success verifying another one. */
  verification?: CollectionVerification;
}

/** Historical proof only: it says what this source successfully did at `at`,
 * not whether today's saved credentials or mapping are still valid. */
export function verifiedCollectionEvidence(
  cell: IntegrationCellBase,
  nowMs: number = Date.now(),
): IntegrationEvidence | null {
  if (cell.effective === "skipped" || cell.effective === "not-applicable") return null;
  return cell.evidence
    .filter((evidence) => {
      return evidence.verification?.kind === "collection-success" &&
        evidence.verification.laneId === cell.laneId &&
        evidenceInstant(evidence.at, nowMs) !== null;
    })
    .sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))[0] ?? null;
}

/** A live state without recent source-specific proof is not verified working. */
export function configuredWithoutVerification(cell: IntegrationCellBase, nowMs: number): boolean {
  return connectionHealthState(cell, nowMs) === "unverified";
}

/** Existing source cadences, shared by the read model and its presentation.
 * Event-triggered checks (including egress) have no scheduled freshness claim. */
export function collectionCadenceHours(laneId: string): number | null {
  if (laneId === 'ad-network') return 24;
  if (laneId === "ga4" || laneId === "gsc") return CADENCE_HOURS.signals;
  if (laneId === "bing-webmaster") return CADENCE_HOURS.bingSignals;
  if (laneId === "dataforseo") return CADENCE_HOURS.dataforseoSignals;
  if (laneId === "posthog") return CADENCE_HOURS.posthogSignals;
  if (laneId === "clarity") return CADENCE_HOURS.claritySignals;
  if (laneId === NIGHTLY_REPORT_LANE_ID) return CADENCE_HOURS.pulse;
  if (laneId === UPTIME_LANE_ID) return CADENCE_HOURS.uptime;
  return null;
}

/** Display only. The stored effective state and its historical rollups are
 * unchanged; a historical success never becomes a current working claim. */
export type IntegrationHealthState = IntegrationState | "unverified";

export function connectionHealthState(cell: IntegrationCellBase, nowMs: number): IntegrationHealthState {
  if (cell.effective !== "live") return cell.effective;
  const proof = verifiedCollectionEvidence(cell, nowMs);
  const cadence = collectionCadenceHours(cell.laneId);
  return proof && cadence !== null && nowMs - Date.parse(proof.at!) <= cadence * AMBER_MULTIPLIER * 3_600_000
    ? "live" : "unverified";
}

/** A card's source slot as the register cell it was built from, carrying the
 * same proof, so the status model (`laneStatus`) reads a card exactly as it
 * reads the full cell. A timestamp can date a failed attempt, so it is never
 * enough on its own. */
export function cardSourceCell(source: CardDataSource, assetId: string): IntegrationCellBase {
  return {
    assetId, laneId: source.id, effective: source.state,
    evidence: [{
      polarity: "supporting", source: source.label, detail: source.detail ?? "",
      at: source.observedAt ?? null, verification: source.verification,
    }],
  };
}

export interface IntegrationHealthSummary extends IntegrationSummary {
  counts: Record<IntegrationHealthState, number>;
}

/** Counts the same evidence-aware states rendered in individual cells. */
export function summarizeConnectionHealth(cells: readonly IntegrationCellBase[], nowMs: number): IntegrationHealthSummary {
  const counts: IntegrationHealthSummary["counts"] = {
    live: 0, unverified: 0, degraded: 0, "needs-setup": 0, skipped: 0, "not-applicable": 0,
  };
  for (const cell of cells) counts[connectionHealthState(cell, nowMs)]++;
  return { counts, total: cells.length, needsAttention: counts.degraded + counts["needs-setup"] };
}

// ---------------------------------------------------------------------------
// Catalog row (rendered): the file's fields + the usage and failure facts the
// worker supplies (they don't live in the file — they are the same for every
// asset, so the worker attaches them once per lane).
// ---------------------------------------------------------------------------
export interface IntegrationCatalogRow {
  id: string;
  label: string;
  docRef: string;
  /** Which side of the portfolio this lane can attach to. */
  scope: LaneScope;
  /** Which tier has to be working for this lane to work; the surface groups
   * its rows by this. */
  layer: IntegrationLayer;
  /** What it costs, what event runs it, and the provider's limit, as values
   * (`shared/lane-facts`). */
  usage: LaneUsage;
  /** What the OS does while this lane is failing; null for a lane the Worker
   * does not know yet, which claims nothing. */
  onFailure: LaneFailureMode | null;
  /** Whether one portfolio credential unlocks this lane, or every cell is its own task. */
  credential: CredentialScope;
  /** True when this lane has no register cell and is computed entirely from the
   * store. Collector-backed catalog lanes also derive health from the store,
   * while retaining a cell for applicability/setup metadata. */
  derived: boolean;
}

// ---------------------------------------------------------------------------
// One (asset, lane) cell. Every rendered cell carries a state and the evidence
// behind it; only file-backed cells also carry a declared state and the
// register file's note/ref/since.
// ---------------------------------------------------------------------------
export interface IntegrationCellBase {
  assetId: string;
  laneId: string;
  /** The state the Tower renders (never written back to any file). */
  effective: IntegrationState;
  /** Store evidence behind (or annotating) this state. */
  evidence: IntegrationEvidence[];
}

export interface IntegrationCell extends IntegrationCellBase {
  /** The legacy file-backed status field. For automated lanes it supplies only
   * explicit skipped/not-applicable scope; current health comes from evidence. */
  declared: IntegrationState;
  /** The cell's note, or `null` when it has none (`RegisterCell.note`). */
  note: string | null;
  ref: string | null;
  since: string;
}

/** One derived register row: a lane with no cells in the register file, whose
 * per-asset state is read out of the store on every request. */
export interface DerivedLaneRow {
  catalog: IntegrationCatalogRow;
  /** assetId → that asset's cell (one per matrix column). */
  cells: Record<string, IntegrationCellBase>;
}

/** Counts by effective status. */
export interface IntegrationSummary {
  counts: Record<IntegrationState, number>;
  total: number;
  /** Cells whose effective status wants the operator: needs-setup + degraded. */
  needsAttention: number;
}

/** One column of the portfolio matrix. */
export interface IntegrationAssetRef {
  id: string;
  displayName: string;
  isOs: boolean;
}

/** How many reusable-credential lanes have unresolved cells, and how many
 * asset setups those lanes cover. This counts lanes, not account secrets:
 * one lane can legitimately use several service accounts. */
export interface SharedCredentialInsight {
  /** Distinct reusable-credential lanes with ≥1 needs-setup cell. */
  lanes: number;
  /** Total needs-setup cells on those shared-credential lanes. */
  cells: number;
}

/** One asset's share of the metered month. */
export type DataSpendAsset = MeteredSpendAsset;

/** The same known-dollar subtotal and unpriced records the collector reads. */
export interface DataSpendSummary extends MeteredDataSpend {
  /** The UTC calendar month, YYYY-MM. */
  period: string;
  capUsd: number;
}

/** The connection history behind /health's strip and its freshness chart
 * (`noticeos.connection_daily_counts`). Zero days means no observations have
 * been recorded; a failed read throws. */
export interface IntegrationsHistory {
  days: number;
  /** Recorded effective-state counts, summed over every lane held that day.
   * These predate typed verification and are NOT verified-working history. */
  states: Record<IntegrationState, SeriesPoint[]>;
  /** Freshness by data source, in hours since its newest dated evidence,
   * measured at the instant the day was observed. A source that carried no
   * dated evidence on a day is absent from that day rather than drawn as
   * infinitely stale. */
  sources: { source: string; points: SeriesPoint[] }[];
}

/** No recorded history. A function rather than a shared constant: the arrays
 * are mutable. */
export function emptyIntegrationsHistory(): IntegrationsHistory {
  const states = {} as Record<IntegrationState, SeriesPoint[]>;
  for (const state of INTEGRATION_STATES) states[state] = [];
  return { days: 0, states, sources: [] };
}

/** GET /api/integrations — the full portfolio matrix. */
export interface IntegrationsMatrix {
  generatedAt: string;
  owner: string;
  /** Lanes, in file (catalog) order — the matrix rows. */
  catalog: IntegrationCatalogRow[];
  /** Store-derived rows, rendered above the catalog: lanes the OS already
   * runs, whose state is evidence rather than a declaration. */
  derivedLanes: DerivedLaneRow[];
  /** Assets, in fixed seed order — the matrix columns. */
  assets: IntegrationAssetRef[];
  /** assetId → cells in the same order as `catalog` (cells[a][i] ↔ catalog[i]). */
  cells: Record<string, IntegrationCell[]>;
  summary: IntegrationSummary;
  /** Data sources some asset has no entry for — the register's own invariant,
   * checked rather than assumed. Empty is the healthy state. */
  undeclared: UndeclaredLane[];
  /** Reusable-credential lanes and the pending asset setups they cover. */
  sharedCredential: SharedCredentialInsight;
  /** What the metered lane has spent this month against its cap. */
  dataSpend: DataSpendSummary;
  /** What all of the above looked like on each of the days the daily rollup
   * holds — the series /health's figures ride. */
  history: IntegrationsHistory;
}

// ---------------------------------------------------------------------------
// The per-asset mapping and its setup steps
// ---------------------------------------------------------------------------
/**
 * One mapping field of one lane, as the asset page hands it to the card. The
 * rule for the value is the `asset-lane` field declaration in
 * `scripts/config-registers.mjs`; this carries only what the file holds.
 */
export interface LaneMappingValue {
  /** The `asset-lane` field name, and the last token of its pointer. */
  name: string;
  /** What `config/integrations.json` holds, or `null` when nothing is mapped. */
  value: string | number | null;
}

/** One structured list field of one lane (PostHog's funnels). Carried whole
 * for its own editor; its rule is the `asset-lane` declaration. */
export interface LaneMappingList {
  name: string;
  /** The list the file holds, or `null` when the key is absent. */
  value: unknown[] | null;
}

/**
 * Which mapping the collectors read for one lane on one asset. `register` —
 * this asset's own `config/integrations.json` entry holds a value. `fallback`
 * — it holds none, so the lane is on its declared fallback source (the Google
 * credential's property map, the asset's domain matched against Bing's
 * verified sites, the DataForSEO baseline market).
 */
export type LaneMappingSource = "register" | "fallback";

/** One lane on an asset's detail page: the cell plus its catalog metadata. */
export interface AssetIntegrationLane {
  catalog: IntegrationCatalogRow;
  cell: IntegrationCell;
  /** This asset's provider mapping for this lane, in card order — empty for
   * every lane that has none. Only the asset page carries these. */
  mapping: LaneMappingValue[];
  /** Structured list fields beside the mapping (PostHog's funnels). Absent for
   * every lane that declares none. */
  mappingLists?: LaneMappingList[];
  /** Whether this asset's own saved value steers the collector (`register`)
   * or the lane's declared fallback does. */
  mappingSource: LaneMappingSource;
}

/** The `integrations` section of GET /api/assets/:id (this asset's lanes). */
export interface AssetIntegrations {
  /** The same fixed seven-slot source strip used by Home/Wall asset cards. */
  sources: import("./wall").CardDataSource[];
  lanes: AssetIntegrationLane[];
  summary: IntegrationSummary;
}

// ---------------------------------------------------------------------------
// The sparse register
// ---------------------------------------------------------------------------
/**
 * Why a lane cannot apply to this asset at all — or `null` when it can. The
 * rule is the catalog row's `scope`, and it wins over a declared cell; a test
 * asserts the register carries no cell this would derive.
 */
export type NotApplicableRule =
  /** A content-site source on the System row: the OS has no organic search,
   * analytics or revenue surface of its own. */
  | "content-only"
  /** The System's own source on a content site: run once for the whole
   * portfolio, never per site. */
  | "system-only";

export function derivedNotApplicable(
  scope: LaneScope,
  isOs: boolean,
): NotApplicableRule | null {
  if (scope === "property" && isOs) return "content-only";
  if (scope === "portfolio" && !isOs) return "system-only";
  return null;
}

/** One cell as the register answers for it: what the file declares, or what
 * the scope rule derives, or "nothing states this". A derived or undecided
 * cell carries no note and an empty `since`. */
export interface RegisterCell {
  status: IntegrationState;
  /** `null` when the cell carries no note key at all: a derived or undecided
   * cell, or a new site's source nobody has said anything about yet. A write
   * to it is then a first write, guarded as one. */
  note: string | null;
  ref: string | null;
  since: string;
}

/**
 * Resolve one (asset, lane) cell. The single place the sparse register is read,
 * so the matrix, the asset page, and the compact source strip cannot end up
 * with three answers for the same missing cell.
 */
export function registerCell(
  declared: IntegrationsConfigCell | undefined,
  scope: LaneScope,
  isOs: boolean,
): RegisterCell {
  if (derivedNotApplicable(scope, isOs)) {
    return { status: "not-applicable", note: null, ref: null, since: "" };
  }
  if (declared) {
    return {
      status: declared.status,
      note: declared.note ?? null,
      ref: declared.ref ?? null,
      since: declared.since,
    };
  }
  // A lane that can apply here and that nobody has written down: rendered as
  // not-applicable, but it is a gap in the register, not a decision.
  return { status: "not-applicable", note: null, ref: null, since: "" };
}

// ---------------------------------------------------------------------------
// The gap the sparse register can have
// ---------------------------------------------------------------------------
/**
 * One data source, and the assets that owe it a decision. Every asset must
 * carry an entry for every data source the scope rule does not answer, and
 * adding a catalog row from `/settings` gives no asset a status.
 */
export interface UndeclaredLane {
  laneId: string;
  /** What the operator calls the data source — the catalog's own label. */
  label: string;
  /** The asset ids owing an entry, in matrix column order. */
  assets: string[];
}

/**
 * Every data source some asset has no cell for. It reads the same scope rule
 * the matrix renders with (`derivedNotApplicable`), so a cell the rule answers
 * is never a gap. An empty list is the healthy state. An asset with no entry
 * at all owes every applicable data source.
 */
export function undeclaredLanes(
  catalog: { id: string; label: string; scope: LaneScope }[],
  assets: { id: string; isOs: boolean }[],
  declared: Record<string, Record<string, unknown> | undefined>,
): UndeclaredLane[] {
  const gaps: UndeclaredLane[] = [];
  for (const lane of catalog) {
    const owing = assets
      .filter((asset) => derivedNotApplicable(lane.scope, asset.isOs) === null)
      .filter((asset) => (declared[asset.id] ?? {})[lane.id] === undefined)
      .map((asset) => asset.id);
    if (owing.length > 0) gaps.push({ laneId: lane.id, label: lane.label, assets: owing });
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// What to unblock next
// ---------------------------------------------------------------------------
/**
 * The shapes a blocked cell can take, in the order the operator should spend
 * attention on them. `degraded` — current operating risk, so it leads.
 * `missing-status` — a site the register holds no status for on a data
 * source; the source is hidden on that site until one is set. Grouped by
 * site, because the fix is on that site's Data sources tab.
 * `shared-credential` — one credential that unlocks a lane on several assets
 * at once. `property-setup` — the long tail, grouped by asset.
 */
export type UnblockerKind = "degraded" | "missing-status" | "shared-credential" | "property-setup";

/** The kinds a site's own Data sources tab resolves; the rest are resolved on
 * Integrations. */
export const SITE_UNBLOCKER_KINDS: readonly UnblockerKind[] = ["missing-status", "property-setup"];

export interface Unblocker {
  kind: UnblockerKind;
  /** Stable identity: the lane id, or the asset id for an asset group. */
  key: string;
  /** The action, in the operator's words — the only line that has to be read. */
  action: string;
  /** Everything this ONE action moves: asset names for a lane-keyed group,
   * lane names for an asset-keyed one. */
  unlocks: string[];
  /** How many blocked cells it clears — the ranking key, and the number that
   * makes a shared credential visibly worth more than an install. */
  cells: number;
  /** Where the how-to lives. A reference to READ, never an owner to edit. */
  docRef: string;
}

/** Everything `unblockers` needs, and nothing that ties it to one payload shape:
 * the asset-detail page holds lanes for one asset, the matrix holds cells for
 * all of them, and both can answer this. */
export interface UnblockerInput {
  catalog: IntegrationCatalogRow[];
  assets: IntegrationAssetRef[];
  /** assetId → cells, in any order (each cell names its own lane). */
  cells: Record<string, IntegrationCellBase[]>;
  /** Data sources a site has no status for (`undeclaredLanes`): a missing cell
   * reads as not applicable and hides the source, so each affected site is one
   * thing to go and do. */
  undeclared?: UndeclaredLane[];
}

/**
 * Turn the register's blocked cells into the list of things to go and do, in
 * actions rather than cells, because one credential can unlock many of them.
 * Ranked: regressions, then leverage, then the tail; inside a kind, by how
 * many cells the one action clears.
 */
export function unblockers(input: UnblockerInput): Unblocker[] {
  const laneById = new Map(input.catalog.map((lane) => [lane.id, lane]));
  const nameById = new Map(input.assets.map((a) => [a.id, a.displayName]));
  // Asset order is the register's own (seed order).
  const assetOrder = input.assets.map((a) => a.id);

  const degradedByLane = new Map<string, string[]>();
  const sharedByLane = new Map<string, string[]>();
  const setupByAsset = new Map<string, string[]>();

  for (const assetId of assetOrder) {
    for (const cell of input.cells[assetId] ?? []) {
      const lane = laneById.get(cell.laneId);
      if (!lane || withoutConnectPath(cell)) continue;
      if (cell.effective === "degraded") {
        push(degradedByLane, lane.id, nameById.get(assetId) ?? assetId);
      } else if (cell.effective === "needs-setup") {
        if (lane.credential === "shared") {
          push(sharedByLane, lane.id, nameById.get(assetId) ?? assetId);
        } else {
          push(setupByAsset, assetId, lane.label);
        }
      }
    }
  }

  const out: Unblocker[] = [];
  for (const [laneId, names] of degradedByLane) {
    const lane = laneById.get(laneId)!;
    out.push({
      kind: "degraded",
      key: laneId,
      // The egress lane's fix is the network the OS runs on, not a credential.
      // Otherwise the status the grid shows for the same cell, in the
      // operator's words; uptime's row names what is down: the site.
      action:
        laneId === EGRESS_LANE_ID
          ? "Check this machine's internet connection"
          : laneId === UPTIME_LANE_ID
            ? names.length === 1 ? "Site down" : "Sites down"
            : `${integrationLabel(lane.id, lane.label)} ${degradedKind(lane.id)}`,
      unlocks: names,
      cells: names.length,
      docRef: lane.docRef,
    });
  }
  for (const [laneId, names] of sharedByLane) {
    const lane = laneById.get(laneId)!;
    out.push({
      kind: "shared-credential",
      key: laneId,
      action: `Connect ${lane.label} once`,
      unlocks: names,
      cells: names.length,
      docRef: lane.docRef,
    });
  }
  for (const [assetId, labels] of setupByAsset) {
    out.push({
      kind: "property-setup",
      key: assetId,
      action: `Finish setup on ${nameById.get(assetId) ?? assetId}`,
      unlocks: labels,
      cells: labels.length,
      docRef: "",
    });
  }
  const missingByAsset = new Map<string, string[]>();
  for (const lane of input.undeclared ?? []) {
    for (const assetId of lane.assets) push(missingByAsset, assetId, integrationLabel(lane.laneId, lane.label));
  }
  for (const assetId of assetOrder) {
    const labels = missingByAsset.get(assetId);
    if (!labels) continue;
    out.push({
      kind: "missing-status",
      key: assetId,
      action: `Set source status on ${nameById.get(assetId) ?? assetId}`,
      unlocks: labels,
      cells: labels.length,
      docRef: "",
    });
  }

  const rank: Record<UnblockerKind, number> = {
    degraded: 0,
    "missing-status": 1,
    "shared-credential": 2,
    "property-setup": 3,
  };
  return out.sort(
    (a, b) => rank[a.kind] - rank[b.kind] || b.cells - a.cells || a.key.localeCompare(b.key),
  );
}

/**
 * The portfolio matrix's own unblocker list, derived lanes folded in: an
 * asset the OS has never received a report from is the most blocked thing on
 * the page, and an OS that cannot reach the internet outranks even that.
 */
export function matrixUnblockers(matrix: IntegrationsMatrix): Unblocker[] {
  const cells: Record<string, IntegrationCellBase[]> = {};
  for (const asset of matrix.assets) {
    cells[asset.id] = [...(matrix.cells[asset.id] ?? [])];
  }
  for (const lane of matrix.derivedLanes) {
    for (const [assetId, cell] of Object.entries(lane.cells)) {
      (cells[assetId] ??= []).push(cell);
    }
  }
  return unblockers({
    catalog: [...matrix.catalog, ...matrix.derivedLanes.map((l) => l.catalog)],
    assets: matrix.assets,
    cells,
    undeclared: matrix.undeclared,
  });
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** An empty-count record, so callers never special-case a missing state key. */
export function emptyStateCounts(): Record<IntegrationState, number> {
  return { live: 0, degraded: 0, "needs-setup": 0, skipped: 0, "not-applicable": 0 };
}

/** Roll a set of cells up into a summary keyed by effective status. Takes
 * both declared and derived cells. */
export function summarize(cells: IntegrationCellBase[]): IntegrationSummary {
  const counts = emptyStateCounts();
  for (const c of cells) counts[c.effective] += 1;
  return {
    counts,
    total: cells.length,
    needsAttention: counts["needs-setup"] + counts.degraded,
  };
}

/** How many reusable-credential lanes have unresolved (effective needs-setup)
 * cells, and how many asset setups that covers. Pure: takes the catalog
 * (for per-lane credential scope) and the per-asset cells. */
export function sharedCredentialInsight(
  catalog: IntegrationCatalogRow[],
  cellsByAsset: Record<string, IntegrationCell[]>,
): SharedCredentialInsight {
  const sharedLanes = new Set(
    catalog.filter((c) => c.credential === "shared").map((c) => c.id),
  );
  const needsByLane = new Map<string, number>();
  for (const cells of Object.values(cellsByAsset)) {
    for (const cell of cells) {
      if (cell.effective === "needs-setup" && sharedLanes.has(cell.laneId)) {
        needsByLane.set(cell.laneId, (needsByLane.get(cell.laneId) ?? 0) + 1);
      }
    }
  }
  let cells = 0;
  for (const n of needsByLane.values()) cells += n;
  return { lanes: needsByLane.size, cells };
}
