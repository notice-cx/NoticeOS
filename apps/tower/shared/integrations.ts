// Shared INTEGRATIONS contract: the payloads GET /api/integrations (the portfolio
// matrix) and the `integrations` section of GET /api/assets/:id return. Same
// discipline as wall.ts / asset-detail.ts — types and pure display helpers, no
// platform deps, so it is safe in workerd AND imported by the client for rendering.
//
// The register this describes is config/integrations.json (see its README): the
// per-asset × per-lane setup/applicability inventory. Automated collector health
// is derived READ-ONLY from the store at render time (the worker's mergeLane);
// the file is never auto-edited. Every observed state carries its WHY.

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

/**
 * The one word a data source that is not working wears where no provider
 * reads it (bead `ro-ffbg`): a late nightly report is Overdue, anything else
 * is Failing — the connection status the Health grid shows for the cell and
 * the word its Other sources row leads with.
 */
export function degradedKind(laneId: string): "overdue" | "failing" {
  return laneId === NIGHTLY_REPORT_LANE_ID ? "overdue" : "failing";
}

/**
 * A SOURCE THE PRODUCT CANNOT CONNECT YET IS NOT A TO-DO (bead
 * `ro-ujb9.133`). The catalog can carry a source no provider card on
 * Integrations connects — uptime monitoring, affiliate revenue, deployment
 * history, the GitHub App — and a new site writes every applicable source as
 * Not set up. Offered as "Connect … once" or a row to answer, each was a dead
 * end that stayed on the page forever. Such a cell is never a to-do while it
 * is only Not set up; once it is in use (Working, failing, or declined) it is
 * listed like any other, and a source that gains a provider is offered again
 * by itself.
 */
export function withoutConnectPath(cell: { laneId: string; effective: IntegrationState }): boolean {
  return cell.effective === "needs-setup" && laneProvider(cell.laneId) === null;
}

/**
 * …and while nothing has arrived for it either, it gets no row, no slot and
 * no grid line at all: nothing a site must answer. Evidence keeps it (revenue
 * added by hand for an affiliate network), because that row says where money
 * came from.
 */
export function unusedWithoutConnectPath(cell: {
  laneId: string;
  effective: IntegrationState;
  evidence?: readonly unknown[];
}): boolean {
  return withoutConnectPath(cell) && (cell.evidence?.length ?? 0) === 0;
}

/** The five states, verbatim from doc 11 / config/integrations.README.md. */
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

/** The owner file every setup/applicability fact points at (doc 06 config-is-files). */
export const INTEGRATIONS_OWNER = "config/integrations.json";

/** The first lane that is never declared: the nightly self-report pipeline the
 * OS already runs. Its state is derived from the store on every read (see the
 * worker's `buildNightlyReportLane`), so it cannot drift from what actually
 * arrived — which is exactly why it has no cell in config/integrations.json. */
export const NIGHTLY_REPORT_LANE_ID = "nightly-report";

/** The OS's own egress — the layer under every other lane (bead `ro-034`, the
 * 2026-08-08 home-uplink outage). Also derived, from the `os-egress-down` flag
 * and the `egress_checks` rows the ingest lanes write when they have to ask. */
export const EGRESS_LANE_ID = "egress";

/** Whether the site is up (bead `ro-ujb9.165`): no account and no connect step.
 * The OS checks each site's home page itself every hour, and the register cell
 * reads its state from that check (the worker's `uptimeState`). */
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
    // One name on every screen, the lexicon's (docs/17 "pulse" row, bead
    // `ro-ffbg`): the grid, Other sources and Latest evidence all say it.
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
// The config file shape (config/integrations.json) — what vite injects at build
// time as __INTEGRATIONS__ and what the tests supply directly. Mirrors the file
// exactly; the worker reads setup/applicability posture from here and never
// writes it.
// ---------------------------------------------------------------------------
/** Whether a lane is unlocked by ONE portfolio credential ("shared") or has no
 * shareable credential so every cell is its own task ("per-property"). */
export type CredentialScope = "shared" | "per-property";

/**
 * Which side of the portfolio a lane can attach to at all *(added 2026-08-04,
 * bead `ro-9mx`)*.
 *
 * `asset` — a content asset's own surface (organic search, analytics, ad
 * network). The System row (asset #0) is the OS itself and has none of them.
 * `portfolio` — the OS's own lane, run once for the whole portfolio (operator
 * notifications). An asset has no cell of its own to fill in.
 * `both` — genuinely applies either side (uptime, the GitHub app), so the
 * register states each cell.
 *
 * This is what lets the register hold obligations and exceptions instead of a
 * full matrix: fifteen `not-applicable` cells whose notes were fifteen copies
 * of one of two sentences are now derived from this field.
 */
export type LaneScope = "property" | "portfolio" | "both";

/**
 * WHICH TIER has to be working for a lane's cell to be working *(added
 * 2026-08-09, bead `ro-034`)*.
 *
 * `os` — this machine and its own connection to the internet. One lane, and it
 * sits under every other one: on 2026-08-08 the operator's home uplink was down
 * and the OS filed ~15 flags accusing six assets of being dark. A red row
 * here means nothing below it was measured, which is why the layers are rendered
 * in this order and why the OS's own row is first.
 * `provider` — a third-party service the OS reads, and the account it reads with
 * (Google, Bing, Clarity, DataForSEO, CJ, an ad network, GitHub, Discord).
 * `asset` — the asset's own plumbing has to reach the OS: its nightly
 * report endpoint, its deploy pipeline. No third party is involved at all.
 *
 * This is deliberately NOT `credential` restated. The two agree on eleven of the
 * twelve declared lanes and disagree on Clarity, which is a provider lane that
 * happens to issue one token per project — how many credentials a lane needs and
 * whose failure it reports are different facts, so the file declares this one.
 */
export type IntegrationLayer = "os" | "provider" | "property";

/**
 * Layers in the order they are read: widest blast radius first. The OS's own
 * connection takes every lane down at once, one provider account takes its lane
 * down on every asset, and an asset's own wiring takes down one lane on one
 * asset — so the surface renders them in that order and never any other way
 * round, and a red row is read against what sits above it.
 */
export const INTEGRATION_LAYERS: IntegrationLayer[] = ["os", "provider", "property"];

export interface IntegrationsConfigCatalogRow {
  id: string;
  label: string;
  docRef: string;
  /** Defaults to `asset` — the shape of most lanes in the register. */
  scope?: LaneScope;
  /** Defaults to `asset`: the conservative read of a forgotten field is that
   * this cell answers for itself, claiming nothing about a shared tier. */
  layer?: IntegrationLayer;
  credential?: CredentialScope;
  // No prose (bead `ro-ujb9.96.6.20`): a lane's facts render as values
  // (`shared/lane-facts`), and what "live" means per lane is doc 11's table.
}

export interface IntegrationsConfigCell {
  mediavineSiteId?: string;
  mediavineEnabled?: boolean;
  revenueHolidayCalendar?: 'none' | 'US' | 'CA' | 'US,CA';
  status: IntegrationState;
  /** Why the source is skipped, or what blocks it. ABSENT on a cell nobody has
   * said anything about — a new site's sources start without one (bead
   * `ro-ujb9.96.7.22`), so the first reason is written as a first write. */
  note?: string;
  ref?: string;
  since: string;
  /**
   * The per-asset PROVIDER MAPPING (bead `ro-vu8d.4`), sparse: only the lanes
   * that have one carry any of these, and only once an operator has set it.
   *
   * Declared once, in `asset-lane` (`scripts/config-registers.mjs`), which is
   * what the Sources tab renders and what the write lane validates a save
   * against; these four keys are the same names spelled for TypeScript.
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
// Observed evidence — the READ-ONLY merge output. Each line is the WHY behind an
// effective state that differs from (or annotates) the file-backed one.
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
   * never a sentence (bead `ro-ujb9.96.6.2`); empty when the title and age say it all. */
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
  /** Which side of the portfolio this lane can attach to (bead `ro-9mx`). */
  scope: LaneScope;
  /** Which tier has to be working for this lane to work (bead `ro-034`). The
   * surface groups its rows by this, so a red row is read against the layers
   * above it rather than on its own. */
  layer: IntegrationLayer;
  /** What it costs, what event runs it, and the provider's limit — facts the
   * grid shows as values, never doc 11's sentences (`shared/lane-facts`). */
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
// behind it; only file-backed cells also carry a DECLARED state and the
// register file's setup/applicability note/ref/since.
// ---------------------------------------------------------------------------
export interface IntegrationCellBase {
  assetId: string;
  laneId: string;
  /** The state the Tower RENDERS (never written back to any file). */
  effective: IntegrationState;
  /** The WHY: store evidence behind (or annotating) this state. */
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

/** One DERIVED register row: a lane with no cells in the register file, whose
 * per-asset state is read out of the store on every request. */
export interface DerivedLaneRow {
  catalog: IntegrationCatalogRow;
  /** assetId → that asset's cell (one per matrix column). */
  cells: Record<string, IntegrationCellBase>;
}

/** Counts by EFFECTIVE status — the summary strip's "does anything need me" line. */
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

/** One asset's share of the metered month (bead `ro-4cm`). */
export type DataSpendAsset = MeteredSpendAsset;

/** The same known-dollar subtotal and unpriced records the collector reads. */
export interface DataSpendSummary extends MeteredDataSpend {
  /** The UTC calendar month, YYYY-MM. */
  period: string;
  capUsd: number;
}

/**
 * The connection history behind /health's strip and its freshness chart
 * (`noticeos.connection_daily_counts`, bead `ro-78qo.30`).
 * Zero days means no observations have been recorded; a failed read throws.
 */
export interface IntegrationsHistory {
  days: number;
  /** Recorded effective-state counts, summed over every lane held that day.
   * These predate typed verification and are NOT verified-working history. */
  states: Record<IntegrationState, SeriesPoint[]>;
  /** Freshness by DATA SOURCE, in HOURS since its newest dated evidence,
   * measured at the instant the day was observed. doc 14's step chart. A source
   * that carried no dated evidence on a day is absent from that day rather than
   * drawn as infinitely stale. */
  sources: { source: string; points: SeriesPoint[] }[];
}

/** No recorded history — what an empty store answers, and what a
 * fixture that is not about the history uses. A FUNCTION rather than a shared
 * constant: the arrays are mutable. */
export function emptyIntegrationsHistory(): IntegrationsHistory {
  const states = {} as Record<IntegrationState, SeriesPoint[]>;
  for (const state of INTEGRATION_STATES) states[state] = [];
  return { days: 0, states, sources: [] };
}

/** GET /api/integrations — the full portfolio matrix. */
export interface IntegrationsMatrix {
  generatedAt: string;
  owner: string;
  /** Lanes, in file (catalog) order — the matrix ROWS. */
  catalog: IntegrationCatalogRow[];
  /** Store-derived rows, rendered ABOVE the catalog: lanes the OS already runs,
   * whose state is evidence rather than a declaration. */
  derivedLanes: DerivedLaneRow[];
  /** Assets, in fixed seed order — the matrix COLUMNS. */
  assets: IntegrationAssetRef[];
  /** assetId → cells in the SAME order as `catalog` (so cells[a][i] ↔ catalog[i]). */
  cells: Record<string, IntegrationCell[]>;
  summary: IntegrationSummary;
  /** Data sources some asset has no entry for — the register's own invariant,
   * checked rather than assumed (bead `ro-qodp`). Empty is the healthy state. */
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
// The per-asset MAPPING and its setup steps (bead `ro-vu8d.4`)
// ---------------------------------------------------------------------------
/**
 * One mapping field of one lane, as the asset page hands it to the card.
 *
 * The RULE for the value is not here — it is the `asset-lane` field declaration
 * in `scripts/config-registers.mjs`, which the card looks up by `name` and the
 * write lane judges the save with. This carries only what the file holds, so
 * the payload never becomes a second opinion about what is legal.
 */
export interface LaneMappingValue {
  /** The `asset-lane` field name, and the last token of its pointer. */
  name: string;
  /** What `config/integrations.json` holds, or `null` when nothing is mapped. */
  value: string | number | null;
}

/** One structured list field of one lane — PostHog's funnels (bead
 * `ro-ghis.1`). Carried whole for its own editor; its rule is the `asset-lane`
 * declaration, exactly as for a scalar field. */
export interface LaneMappingList {
  name: string;
  /** The list the file holds, or `null` when the key is absent. */
  value: unknown[] | null;
}

/**
 * Which mapping the collectors read for one lane on one asset (bead
 * `ro-vu8d.16`).
 *
 * `register` — this asset's own `config/integrations.json` entry holds a value,
 * so that is what the next run after a restart asks for. `fallback` — it holds
 * none, so the lane is still on the source it had before the register existed
 * (the Google credential's property map, the asset's own domain matched against
 * Bing's verified sites, the US/English DataForSEO baseline), which the lane's
 * own sentence names.
 */
export type LaneMappingSource = "register" | "fallback";

/** One lane on an asset's detail page: the cell plus its catalog metadata. */
export interface AssetIntegrationLane {
  catalog: IntegrationCatalogRow;
  cell: IntegrationCell;
  /**
   * This asset's provider mapping for this lane, in card order — empty for
   * every lane that has none (a lane whose target is the asset itself).
   *
   * The asset page is the ONLY surface that carries these: the portfolio matrix
   * is a grid of states, and a property id in a matrix cell would be a second
   * place the same fact is edited.
   */
  mapping: LaneMappingValue[];
  /** Structured list fields beside the mapping (PostHog's funnels). Absent for
   * every lane that declares none. */
  mappingLists?: LaneMappingList[];
  /** Whether this asset's own saved value steers the collector (`register`)
   * or the lane's declared fallback does (bead `ro-vu8d.16`) — a state the card
   * draws as a chip, never a sentence (bead `ro-ujb9.96.6.4`). */
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
// The sparse register (bead `ro-9mx`)
// ---------------------------------------------------------------------------
/**
 * Why a lane cannot apply to this asset at all — or `null` when it can.
 *
 * the 2026-07 audit's finding 12: the register was a FULL matrix, and 27 of its 84 cells said
 * "not applicable" in prose. Fifteen of those were two rules written out fifteen
 * times, so a new asset arrived owing seven paragraphs restating what the
 * portfolio already knows, and the payload carried them as though each were a
 * cell somebody might act on. The rule is now the field: `scope` on the catalog
 * row, and this one sentence generated where the file used to repeat it.
 *
 * The rule WINS over a declared cell, and a test asserts the register carries no
 * cell this would derive — so the two can never end up disagreeing about whether
 * the System has an organic-search surface.
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

/** One cell as the register answers for it: what the file declares, or what the
 * scope rule derives, or the honest "nothing states this". A derived or
 * undecided cell carries no note and an empty `since` — the surfaces draw the
 * rule as a chip from the catalog's `scope` (bead `ro-ujb9.96.6.4`), never a
 * sentence riding the cell (bead `ro-ujb9.96.6.1`). */
export interface RegisterCell {
  status: IntegrationState;
  /** `null` when the cell carries no note key at all: a derived or undecided
   * cell, or a new site's source nobody has said anything about yet (bead
   * `ro-ujb9.96.7.22`). A write to it is then a first write, guarded as one. */
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
  // A lane that CAN apply here and that nobody has written down. Rendering it as
  // not-applicable is the conservative read, but it is a gap in the register and
  // says so rather than passing for a decision.
  return { status: "not-applicable", note: null, ref: null, since: "" };
}

// ---------------------------------------------------------------------------
// The gap the sparse register CAN have (bead `ro-qodp`)
// ---------------------------------------------------------------------------
/**
 * One data source, and the assets that owe it a decision.
 *
 * `config/integrations.README.md` makes it an invariant that every asset carries
 * an entry for every data source the scope rule does not answer. Since the
 * catalog became editable from `/settings` an operator can add a row in one
 * changeset — and that row gives no asset a status, so the file is immediately
 * in the state the invariant forbids. The README's validation snippet reports it
 * (`ASSET missing LANE`) and nothing in the repo runs that snippet, so the gap
 * was invisible until somebody opened the file.
 */
export interface UndeclaredLane {
  laneId: string;
  /** What the operator calls the data source — the catalog's own label. */
  label: string;
  /** The asset ids owing an entry, in matrix column order. */
  assets: string[];
}

/**
 * Every data source some asset has no cell for.
 *
 * It reads the SAME scope rule the matrix renders with (`derivedNotApplicable`),
 * so a cell the rule answers can never be counted as a gap — which is the whole
 * reason the register is allowed to be sparse. A lane every asset has decided is
 * absent from the result, so an empty list is the healthy state and the surface
 * shows nothing at all.
 *
 * `declared` is the file's own `assets` map. An asset with no entry at all owes
 * every applicable data source, which is exactly what a half-finished Create
 * looks like and what an operator would want named.
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
// What to unblock next (bead `ro-9mx`)
// ---------------------------------------------------------------------------
/**
 * The three shapes a blocked cell can take, in the order the operator should
 * spend attention on them.
 *
 * `degraded` — a lane with usable but incomplete, stale, or failed evidence. It
 * is current operating risk rather than a setup backlog item, so it leads.
 * `shared-credential` — one account or credential that unlocks a lane on
 * several assets at once: the biggest movement per action in the register.
 * `missing-status` — a site the register holds no status for on a data source
 * (bead `ro-ujb9.96.15`). The source is hidden on that site until one is set,
 * which is worse than a setup backlog, so it follows the regressions. Grouped
 * by site, like the tail, because the fix is on that site's Data sources tab.
 * `property-setup` — the long tail, grouped by the asset you would be
 * sitting in front of, because that is the unit of the visit.
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
  /** Data sources a site has no status for (`undeclaredLanes`, bead
   * `ro-ujb9.96.15`): a missing cell reads as not applicable and hides the
   * source, so each affected site is one thing to go and do. */
  undeclared?: UndeclaredLane[];
}

/**
 * Turn the register's blocked cells into the list of things to go and do.
 *
 * The matrix answers "what state is everything in"; this answers the question
 * the operator actually has, which is "what should I fix first" — and it answers
 * it in ACTIONS, not cells, because a full matrix makes dozens of cells look
 * independently actionable when one credential unlocks nine of them (doc 19
 * finding 12).
 *
 * Ranked: regressions, then leverage, then the tail. Inside a kind, by how many
 * cells the one action clears.
 */
export function unblockers(input: UnblockerInput): Unblocker[] {
  const laneById = new Map(input.catalog.map((lane) => [lane.id, lane]));
  const nameById = new Map(input.assets.map((a) => [a.id, a.displayName]));
  // Asset order is the register's own (seed order), so every list of assets
  // on this page reads in the same order as every other list in the Tower.
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
      // The L0 lane is the one whose fix is not in the OS at all: "Review the
      // OS's own internet connection degradation" would send the operator to
      // look for a credential when the thing to look at is the network the OS
      // runs on. Special-cased by lane id rather than carried as another
      // sentence on every catalog row, because there is exactly one lane like
      // this.
      // The status the grid shows for the same cell, in the operator's words
      // ("Nightly report overdue", "Bing Webmaster Tools failing"), never the
      // register's "degradation" (bead `ro-ffbg`). Uptime's check observes the
      // site itself, so its row names what is down: the site (bead
      // `ro-ujb9.165`), with the sites as the caption.
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
 * The portfolio matrix's own unblocker list, derived lanes folded in.
 *
 * Neither derived lane is in `catalog` — they have no register cell by design —
 * but an asset the OS has never received a report from is the most blocked
 * thing on the page, and an OS that cannot reach the internet outranks even
 * that. Leaving them out would be a list that omits its worst two entries to
 * keep its own data shape tidy.
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

/** Roll a set of cells up into a summary keyed by EFFECTIVE status. Takes both
 * declared and derived cells — a live derived lane counts as live, so it lands
 * outside `needsAttention` exactly like any other live cell. */
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
