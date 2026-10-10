import type { DailyRevenueHistory } from "./daily-revenue";
import type { Liveness, SignalVerification } from "./signal-liveness";

// The AssetDetail contract: the payload GET /api/assets/:id returns. Pure types
// and plain constants only, so it loads in workerd and in the browser. Every
// fact carries its effective value plus an owner pointer to the file or store
// table that changes it; the Tower points at owners, it never edits them.

import type {
  CounterCard,
  LedgerFigure,
  PanelReview,
  FlagKind,
  Severity,
  SeriesPoint,
  SignalTrendSet,
  ScheduledLane,
} from "./wall";
import type { AnnotationItem, AnnotationKind, AnnotationTimeline } from "./annotations";
import type { FlagReading } from "./alert-language";
import type { RecommendationSourceEvidence } from "./recommendation-validity";
import type { AssetIntegrations } from "./integrations";
import type { JsonValue } from "./changeset";
import type { WatchSeriesHistory } from "./watch-windows";
import type { WorkItem } from "./work";
import type { WatchScopeInput } from "@noticeos/contract/create-watch-window";
import type { SearchMarket } from "@noticeos/contract/dataforseo";

export type { AnnotationItem, AnnotationKind, AnnotationTimeline };

/** Onboarding lifecycle, the assets.status CHECK. `retired` is off the happy
 * path and the stepper renders it distinctly. */
export type AssetStatus =
  | "pre-launch"
  | "onboarding"
  | "baselining"
  | "live"
  | "retired";

/** The lifecycle word an operator reads, shared so every surface spells it
 * the same way. */
export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = {
  "pre-launch": "Pre-launch",
  onboarding: "Onboarding",
  baselining: "Baselining",
  live: "Live",
  retired: "Retired",
};

/**
 * The same word for a status that arrived as a bare string. The Wall types
 * `AssetCard.status` as `string`; an unrecognized value is humanized rather
 * than dropped, because a stage the Tower has never seen is still a fact.
 */
export function assetStatusLabel(status: string): string {
  return (
    ASSET_STATUS_LABEL[status as AssetStatus] ??
    status.replace(/[-_]+/g, " ").replace(/^./, (letter) => letter.toUpperCase())
  );
}

// ---------------------------------------------------------------------------
// Lifecycle moves
// ---------------------------------------------------------------------------

/**
 * A lifecycle move is recorded as a timeline row because `assets.status` holds
 * only where an asset is, never where it has been; Restore reads the previous
 * stage from the timeline instead of guessing. It uses the existing `config`
 * kind: a stage is a stored setting on the asset, and `annotations.kind` is a
 * CHECK constraint.
 */
export const LIFECYCLE_ANNOTATION_KIND: AnnotationKind = "config";

/** What a lifecycle-move `ref` starts with. Prefixed rather than bare so an
 * operator-written ref can never be mistaken for one. */
export const LIFECYCLE_REF_PREFIX = "lifecycle:";

/** The two ends of one recorded move. */
export interface LifecycleMove {
  from: AssetStatus;
  to: AssetStatus;
}

/**
 * The `ref` a stage move is stored under (`lifecycle:baselining>retired`). It
 * is part of the row's `(asset, at, kind, ref)` identity, so two moves in the
 * same second stay two rows and a retried write collapses into one.
 */
export function lifecycleMoveRef(move: LifecycleMove): string {
  return `${LIFECYCLE_REF_PREFIX}${move.from}>${move.to}`;
}

/** The move a `ref` records, or null when it is not one. Both stages are checked
 * against the lifecycle enum: a malformed ref is not a move, it is a string. */
export function parseLifecycleMoveRef(ref: string | null): LifecycleMove | null {
  if (!ref || !ref.startsWith(LIFECYCLE_REF_PREFIX)) return null;
  const [from, to, ...rest] = ref.slice(LIFECYCLE_REF_PREFIX.length).split(">");
  if (rest.length > 0) return null;
  if (!isAssetStatus(from) || !isAssetStatus(to)) return null;
  return { from, to };
}

function isAssetStatus(value: string | undefined): value is AssetStatus {
  return value !== undefined && value in ASSET_STATUS_LABEL;
}

/** The one plain sentence a recorded move is stated in, wherever it renders. */
export function lifecycleMoveSentence(move: LifecycleMove): string {
  return `Stage moved from ${ASSET_STATUS_LABEL[move.from]} to ${ASSET_STATUS_LABEL[move.to]}`;
}

/**
 * The stage this asset was in when it was last archived — what Restore returns
 * it to. `items` is newest first, so the first move into `retired` is the one
 * being undone. `null` means no move is on record; a caller that then shows
 * `live` must say it is a default rather than a fact.
 */
export function stageBeforeRetire(
  items: readonly AnnotationItem[],
): { stage: AssetStatus; at: string } | null {
  for (const item of items) {
    if (item.kind !== LIFECYCLE_ANNOTATION_KIND) continue;
    const move = parseLifecycleMoveRef(item.ref);
    if (!move || move.to !== "retired" || move.from === "retired") continue;
    return { stage: move.from, at: item.at };
  }
  return null;
}

/** How the OS gets this asset's pulse. `pull` when the asset has an entry in
 * config/pull.json (the OS scrapes it); `push` otherwise (the asset POSTs). */
export type SenseMode = "pull" | "push";

/** Re-exported for callers of this contract; the vocabulary lives in wall.ts. */
export type { FlagKind } from "./wall";

/** flags.disposition — the only sanctioned flag mutation. */
export type Disposition = "ack" | "snooze" | "tune" | "incident" | "hypothesis";

export type BookingState = "estimated" | "reconciled";

/** decisions.kind — which surface the operator marked or dismissed. Page rows
 * are handoffs only and never enter this store-backed vocabulary. */
export type DecisionKind = "query" | "finding";

/** Tower surfaces that can file work into an asset's task register. Wider than
 * `DecisionKind`: a page decision and an alert can each file a task, but neither
 * has a display-state row in `decisions`. The same four values are
 * `BEADS_HANDOFF_KINDS` (workers/ingest/src/beads-snapshots.ts) and the poller's
 * `HANDOFF_KINDS` (scripts/runner/task-snapshot.mjs). */
export type HandoffKind = DecisionKind | "page" | "alert";

/**
 * decisions.status — what the operator wants displayed, and nothing else. There
 * is no `open`: an untouched item has no row at all, and clearing a decision
 * deletes it. Whether a task was filed is answered by `handoffBeads`, never by
 * this vocabulary.
 */
export type DecisionStatus = "marked" | "dismissed";

/** One recorded operator judgement. `key` is the normalized (lowercased,
 * trimmed) query for kind `query` and the snapshot's `ExecutiveInsight.key` for
 * kind `finding`, so the client matches rows by key without a join. */
export interface AssetDecision {
  kind: DecisionKind;
  key: string;
  status: DecisionStatus;
  decidedAt: string;
  updatedAt: string;
}

/**
 * A task somebody filed from this asset's Tower handoff, joined back to it by
 * the handoff's own metadata: `apps/tower/src/lib/task-handoff.ts` writes
 * `noticeos_key` / `noticeos_kind` / `noticeos_asset` into the `bd create`, the
 * poller reads them back, and `key` here is that `noticeos_key` byte for byte.
 * Nothing in the OS creates these tasks; a finding with no task simply has none.
 *
 * `key` is the rendered row's own stable key — the normalized query for kind
 * `query`, the card key for `finding`, the absolute URL for `page`, the flag id
 * for `alert` — so every surface matches by key alone.
 */
export interface HandoffBead {
  kind: HandoffKind;
  /** `noticeos_key` verbatim. Byte-exact, because a query may contain a comma
   * and `bd` splits label values on commas, so the `key:` label is a lossy slug. */
  key: string;
  /** The task id in the asset's own project — the ref the commit, annotation
   * and watch window all quote. */
  beadId: string;
  /**
   * `bd`'s richer statuses collapse to two: in_progress, blocked and deferred
   * are all ways of the work not having landed yet. `closed` records a task
   * decision, not proof of shipment or outcome; nothing rendering this may
   * treat a closed task as a resolved finding.
   */
  status: "open" | "closed";
  /** When it was closed. Null on an open task, and on a closed one whose
   * timestamp the poller could not read. */
  closedAt: string | null;
}

/** An owner pointer: the repo file or store table where a fact is changed. */
export type OwnerPath = string;

/** Canonical owner pointers, single-sourced so copy never drifts. */
export const OWNER = {
  pull: "config/pull.json",
  constants: "config/constants.json",
  assets: "db · assets row",
  ingest: "workers/ingest",
  ingestSecrets: "workers/ingest/.dev.vars",
} as const;

/** How a site's nightly report is authenticated, as its Settings shows it: the
 * site's own bearer token, never shown. */
export const SITE_TOKEN = "Site token";

// ---------------------------------------------------------------------------
// Header / identity
// ---------------------------------------------------------------------------
export interface AssetInfo {
  id: string;
  displayName: string;
  domain: string | null;
  status: AssetStatus;
  senseOnly: boolean;
  isOs: boolean;
  createdAt: string;
  updatedAt: string;
  /** received_at of the FIRST nightly report ever accepted for this asset. */
  firstReportAt: string | null;
  /** Distinct pulse dates in the last 28 completed UTC days. Older payloads
   * omit it; readers must then show coverage as unknown. */
  reportDays?: number | null;
  /** The operator declared that this asset sends no nightly report. Whether a
   * report is expected is `expectsNightlyReport(noNightlyReport,
   * freshness.pulseReceivedAt)`: never while declared, and otherwise only once
   * one has arrived. Absent on an older payload, which means not declared. */
  noNightlyReport?: boolean;
  /** Worst severity among OPEN flags. The header renders a dot only for
   * actionable warning/error states; healthy identity is the favicon. */
  worstOpenSeverity: Severity | null;
  openError: number;
  openWarn: number;
}

// ---------------------------------------------------------------------------
// Wiring panel
// ---------------------------------------------------------------------------
/** One open wiring-health flag surfaced on the sense-mode card (read-only). */
export interface WiringFlag {
  ruleId: string;
  firedAt: string;
  message: string | null;
}

/** Pull-mode facts, all owned by config/pull.json (+ .dev.vars for the token). */
export interface PullWiring {
  /** This entry's array index in config/pull.json — the base for its edit
   * pointers (`/{index}/url`, `/{index}/enabled`). RFC-6901 needs the index;
   * the changeset's `expect` guard covers any reordering before apply. */
  index: number;
  url: string;
  enabled: boolean;
  format: string;
  /** Report metric name → source counter (config/pull.json `metrics` map).
   * null when the wire format carries no mapping: an `envelope` endpoint returns
   * the contract verbatim, so there is nothing to map (never an empty map). */
  metricMap: { metric: string; counter: string }[] | null;
  /** How the pull cron authenticates to the asset's scrape endpoint. */
  auth: string;
  authOwner: OwnerPath;
}

/** Push-mode facts: the asset POSTs its own pulse. */
export interface PushWiring {
  endpoint: string;
  endpointOwner: OwnerPath;
  auth: string;
  authOwner: OwnerPath;
}

/** A nightly report's job and the schedule it runs on (`Wiring.schedule`). */
export interface WiringSchedule {
  /** The scheduled job's id (`scripts/scheduled-jobs.mts`). */
  job: string;
  enabled: boolean;
  cron: string;
  /** The zone the cron is read in; absent reads as UTC. */
  timezone?: string;
}

export interface Wiring {
  mode: SenseMode;
  /** Where the mode itself is decided (presence in config/pull.json). */
  modeOwner: OwnerPath;
  /** Expected cadence in plain words ("nightly"). */
  cadence: string;
  /**
   * The job that produces this asset's nightly report and its schedule as
   * saved — the OS's pull (`pull`) or its own self-report (`asset-zero`); null
   * for a pushing asset, which sends on its own clock. Derived by
   * `scheduleFor(job, saved)`, the same derivation the runner arms from.
   */
  schedule: WiringSchedule | null;
  cadenceOwner: OwnerPath;
  pull: PullWiring | null;
  push: PushWiring | null;
  /** received_at of the latest pulse (age badge); null if none ever arrived. */
  lastPulseReceivedAt: string | null;
  /** date (YYYY-MM-DD) of the latest pulse; null if none. */
  lastPulseDate: string | null;
  /** Open `asset-pull-failed` flag for this asset (pull health), else null. */
  pullFailure: WiringFlag | null;
  /** Open `ingest-freshness` flag for this asset, else null. */
  ingestFreshness: WiringFlag | null;
  /** Every asset declared as sending no nightly report, as saved
   * (config/constants.json `no_nightly_report`), or null while none has been
   * declared. The whole list, because the Settings switch writes it back whole
   * and guards the write with what it read. */
  noReportDeclarations?: string[] | null;
}

// ---------------------------------------------------------------------------
// Rules in force (anomaly config)
// ---------------------------------------------------------------------------
/** One anomaly-rule knob: label, jargon, effective value, one-line explainer
 * and owner file. */
export interface KnobFact {
  key: string;
  label: string;
  jargon: string;
  value: string;
  explain: string;
  owner: OwnerPath;
  /** JSON pointer into the owner file (config/constants.json), so the Tower can
   * write this exact value (`/flag_defaults/alpha`). */
  pointer: string;
  /** The raw effective value (number in constants.json), used as the written
   * op's `expect` — the string `value` above is display-only. */
  raw: number | string;
}

export interface RulesInForce {
  /** No per-asset overrides exist; the portfolio default always applies. */
  scope: "portfolio-default";
  hasOverride: false;
  knobs: KnobFact[];
}

// ---------------------------------------------------------------------------
// Portfolio-wide spend & rate (config/constants.json) — editable, portfolio-wide
// ---------------------------------------------------------------------------
/** One portfolio-wide constant surfaced for editing on every asset page, with
 * the pointer and raw value needed to stage a changeset op and a unit so the
 * editor formats and validates it. */
export interface PortfolioKnob {
  key: string;
  pointer: string;
  label: string;
  jargon: string;
  value: number;
  unit: "usd" | "usd_per_min" | "number";
}

export interface PortfolioConfig {
  owner: OwnerPath;
  note: string;
  knobs: PortfolioKnob[];
}

// ---------------------------------------------------------------------------
// Pulse metrics
// ---------------------------------------------------------------------------
export interface PulseMetric {
  name: string;
  /** From the LATEST pulse envelope (null when the key is absent that day). */
  last24h: number | null;
  avg7d: number | null;
  total: number | null;
  /** Up to 30 days of last24h (chronological) for the metric's spark. */
  series: SeriesPoint[];
}

// ---------------------------------------------------------------------------
// Flags (immutable evidence plus the sanctioned operator lifecycle fields)
// ---------------------------------------------------------------------------
export interface FlagRecord {
  id: number;
  firedAt: string;
  severity: Severity;
  kind: FlagKind;
  metric: string | null;
  /** The rule's own words, verbatim — audit trail and translator fallback. */
  message: string | null;
  ruleId: string;
  /** flags.rule_inputs, parsed (the column is TEXT). Feeds `translateAlert`,
   * which turns rule_id + these numbers into the operator's headline and the
   * evidence behind it — the same translation the attention band applies. */
  ruleInputs: Record<string, unknown> | null;
  /** Timeline events on this asset in the 48h before the condition started
   * (`firstFiredAt`); [] when none. Anchored to the onset, not `firedAt`: a
   * month-old condition's newest firing is a routine re-evaluation, and the two
   * days before it reliably hold nothing. */
  correlatedChanges: AnnotationItem[];
  disposition: Disposition | null;
  dispositionAt: string | null;
  dispositionNote: string | null;
  snoozeUntil: string | null;
  ackExpiry: string | null;
  resolvedAt: string | null;
  /** What this flag's own source of truth says about it right now, derived at
   * read time. `resolved_at IS NULL` only means nobody clicked Resolve. */
  liveness: Liveness;
  /** Missing on older payloads: unknown, never confirmed. */
  verification?: SignalVerification;
  /** How many open firings this row stands for — 1 for an ordinary event, and
   * always 1 in `history`. The same number the Wall's
   * `AttentionItem.occurrences` carries, from the same `groupConditionFirings`. */
  occurrences: number;
  /** When this condition FIRST fired. Equals `firedAt` when `occurrences` is 1,
   * and is what the row AGES from — a condition is as old as it has been true,
   * not as old as its most recent re-reading. */
  firstFiredAt: string;
  /**
   * When the OS told the operator about this alert on its notification channel,
   * or null. A row in `notifications` means a message actually landed, so this
   * is evidence rather than intent; null covers "did not qualify", "delivery
   * failed" and "table not applied" alike. Optional because the Wall does not
   * carry it.
   */
  notifiedAt?: string | null;
  /** This condition's stored readings, newest first (`flag_evidence`); absent
   * when it has none or the store predates them. */
  readings?: FlagReading[];
}

export interface FlagsSection {
  /** Unresolved and attention-eligible, one row per condition, worst severity
   * first. Includes last-known conditions with unverified evidence. The grouping
   * is `groupConditionFirings` (shared/wall), and the scope `applyFlagAction`
   * re-derives in SQL, so Mark read / Resolve act on what the row claims. */
  open: FlagRecord[];
  /** Open in the store but not current: milestones (events, never conditions)
   * and anything whose source of truth no longer carries it. Kept as evidence,
   * without a heading that calls them live or a Resolve button. */
  notCurrent: FlagRecord[];
  /** Snoozed with time still on the clock, one row per condition, soonest back
   * first. Neither settled nor open: each comes back on its `snoozeUntil`. */
  snoozed: FlagRecord[];
  /** Settled — resolved, or given a decision that does not expire
   * (`flag-open.ts`) — most recent first (last ~20). One row per firing: this
   * is the audit trail, and every row carries `occurrences: 1`. */
  history: FlagRecord[];
  /** Attention-eligible error/warn conditions, matching the Wall asset card.
   * Repeated firings stay in each row's `occurrences`, not in these badges. */
  openError: number;
  openWarn: number;
}

// ---------------------------------------------------------------------------
// Ledger slice
// ---------------------------------------------------------------------------
export interface LedgerFamilyAmount {
  currency: string;
  family: string;
  amount: number;
}

/** One side of one period's P&L: the figure, and the families it is made of.
 * The breakdown travels with the figure so a family list can never be summed
 * over both booking states under a reconciled net. */
export interface LedgerRollup {
  figure: LedgerFigure;
  revenueByFamily: LedgerFamilyAmount[];
  costByFamily: LedgerFamilyAmount[];
}

/** One accounting month in the same two halves the portfolio headline and every
 * asset card state. The sides are separate fields so nothing can add them:
 * `figureHasMoney` (shared/wall) decides which renders, and the stated net is
 * `booked` only. */
export interface LedgerPeriod {
  period: string;
  /** RECONCILED current rows for `period` — the figure the page states. */
  booked: LedgerRollup;
  /** ESTIMATED current rows for `period` — reported, not reconciled. Rendered
   * under the hollow notch, below the rule, never inside `booked`. */
  forecast: LedgerRollup;
}

/** A raw current ledger row; booking_state is visible because estimated versus
 * reconciled is a fact the operator must see. */
export interface LedgerRawRow {
  currency: string;
  id: number;
  kind: "revenue" | "cost";
  period: string;
  family: string;
  amount: number;
  bookingState: BookingState;
  source: string | null;
  ref: string | null;
  note: string | null;
  recordedAt: string;
}

export interface LedgerSlice {
  /** Current (non-superseded) rows grouped by period, most-recent period first. */
  periods: LedgerPeriod[];
  /** Raw current rows, most-recent first, capped (~20) — booking_state visible. */
  recentRows: LedgerRawRow[];
  empty: boolean;
  currency: string | null;
}

// ---------------------------------------------------------------------------
// Watch windows — read-only here
// ---------------------------------------------------------------------------
/** watch_windows.outcome — the evaluator's verdict, never the Tower's. */
export type WatchOutcome =
  | "ship_confirmed"
  | "kill_confirmed"
  | "inconclusive"
  | "unmeasurable";

/** One pre-registered outcome check: the comparison was chosen before the
 * numbers existed, and the evaluator reads it back. The Tower only selects;
 * registration lives in the ingest worker's operator API, and the evaluator
 * owns every field that changes after registration. */
export interface WatchWindowItem {
  id: string;
  /** The measured series, in the `signal_observations` vocabulary: a metric
   * name alone does not identify one, so the integration travels with it. */
  metricIntegration: "ga4" | "gsc" | "bing-webmaster";
  metric: string;
  /** The one query or page the series is narrowed to; null is the whole site. */
  scope: WatchScopeInput | null;
  /** What is being watched (an annotation id, a decision id, or free text). */
  refKind: "annotation" | "decision" | "manual";
  ref: string;
  registeredAt: string;
  /** Calendar date of the earliest registered check the evaluator has not read
   * yet. null when every check has been read (or the registration named none). */
  nextCheckDate: string | null;
  /** Checks already recorded, out of the number registration asked for. */
  readings: number;
  checks: number;
  status: "open" | "closed";
  outcome: WatchOutcome | null;
  /** The evaluator's figures for `outcome`, without the series, scope or
   * offset (`watchVerdictFigures`). */
  outcomeNote: string | null;
  closedAt: string | null;
  /** The operator's registration note; never rewritten. */
  note: string | null;
  /** A valid task id already recorded on this watch; not evidence of a decision. */
  readbackTaskId?: string;
}

export interface WatchSlice {
  /** Still open, earliest-registered first — the oldest question is the one
   * most likely to be answerable. */
  open: WatchWindowItem[];
  /** Recently closed, most recently closed first (last few). */
  closed: WatchWindowItem[];
  /**
   * This asset's own recent daily values for every measurable series it
   * reports, so a registration's threshold can be calibrated from what this
   * asset does when nothing is shipped. The raw series travels because the
   * floor depends on the window length the operator picks; `watchCalibration`
   * (shared/watch-windows.ts) is the one derivation over it. A series this
   * asset has never reported is absent, not an empty history: the composer's
   * fallback sentence turns on "no usable history".
   */
  history: WatchSeriesHistory[];
}

/** The operator actions the task hub attributes to this asset. The two counts
 * are nullable together: a snapshot from an older poller is unknown here, never
 * a plausible-looking list. */
export interface AssetOperatorPosture {
  /** When the local runner photographed the hub. Survives an unknown project so
   * the page can distinguish a stale photograph from no photograph. */
  capturedAt: string | null;
  /** Exact untruncated count, or null when the current inbox semantics were not
   * measured for this asset. */
  waiting: number | null;
  /** Human gates plus P0/P1 ready-human rows, over the same untruncated inbox. */
  urgent: number | null;
  /** Ranked head of the inbox (the poller deliberately bounds it at ten). Empty
   * when the counts are unknown; consumers must never render legacy rows. */
  items: WorkItem[];
}

// ---------------------------------------------------------------------------
// Link outreach / reclamation pipeline — read-only here
// ---------------------------------------------------------------------------
/** reclamation_targets.status. The first six are the funnel in order; `skip`
 * (never pitch) and `dead` (the broken link is gone) are terminal exits. */
export type ReclamationStatus =
  | "queued"
  | "sent"
  | "opened"
  | "clicked"
  | "replied"
  | "won"
  | "skip"
  | "dead";

/** One pitchable page and where it has got to. Identity and evidence fields
 * (contact, the dead links, the replacement) stay in the store: this strip is a
 * progress glance, and the operator works the campaign in the CSV lane. */
export interface ReclamationTarget {
  id: number;
  domain: string;
  status: ReclamationStatus;
  /** When the row entered its current status; null for a target never touched. */
  statusAt: string | null;
}

export interface ReclamationSlice {
  /** Every status carrying at least one row, funnel order. A status with no rows
   * is omitted rather than rendered as a zero — an unstarted stage is not a
   * measurement. */
  counts: { status: ReclamationStatus; count: number }[];
  /** Total rows for this asset, including `skip` — the denominator the funnel
   * counts are drawn from. */
  total: number;
  /** Up to ten most recently moved non-skip targets. `skip` rows are a
   * do-not-pitch reference list, not work in progress. */
  recent: ReclamationTarget[];
}

// ---------------------------------------------------------------------------
// Nightly site-health history (hygiene_checks) — read-only here
// ---------------------------------------------------------------------------
/** The served-layer guards, ids verbatim from the `hygiene_checks.check_id`
 * CHECK constraint. */
export type HygieneCheckId =
  | "html-depth"
  | "robots-ai-access"
  | "sitemap"
  | "page-structure";

/** The four states one night's fetch can record. `error` ("the server told us
 * no") and `unreachable` ("we never reached the server") are different facts;
 * only the first is evidence about the asset. */
export type HygieneStatus = "ok" | "warn" | "error" | "unreachable";

/** One night's reading of one check. */
export interface HygieneReading {
  /** 'YYYY-MM-DD' — the check's grain is one row per day. */
  date: string;
  /** Exact instant the nightly fetch finished. The date remains the chart grain;
   * this instant is the age-badge clock, so a stopped guard cannot leave an old
   * reading looking current. */
  observedAt: string;
  status: HygieneStatus;
  /** The check's headline number: words of served text (html-depth), `<loc>`
   * URLs (sitemap), or pages read (page-structure). null is "not measured",
   * never zero: every robots-ai-access row and every failed fetch.
   * `page-structure` stores a real zero when the roster was empty; its status
   * is then `unreachable` rather than `ok`. */
  value: number | null;
}

/** One check's history for this asset, oldest reading first. */
export interface HygieneCheckHistory {
  check: HygieneCheckId;
  /** Chronological, one entry per day the check ran. Days it did not run are
   * absent rather than filled: a night with no fetch measured nothing. */
  readings: HygieneReading[];
  /** The newest reading, or null when this check has never run for the asset. */
  latest: HygieneReading | null;
}

/** One watched AI crawler's resolved access, from the newest robots reading. */
export interface HygieneBotAccess {
  /** The crawler's own token — `GPTBot`, `ClaudeBot`, `Bingbot`, … */
  bot: string;
  allowed: boolean;
}

/**
 * The nightly site-health history. A rule fires on a step change; the history
 * is what shows a slope. `null` on the payload when the asset has no readings
 * at all: a section with no data and no way to add any is a dead end.
 */
export interface HygieneHistory {
  htmlDepth: HygieneCheckHistory;
  robots: HygieneCheckHistory;
  sitemap: HygieneCheckHistory;
  /** Resolved access for each watched crawler, from the NEWEST robots reading
   * that had a robots.txt to resolve. Empty when the newest reading found none —
   * an absent file is not a permission map, and inventing "allowed: true" for
   * every bot would state a fact the fetch never established. */
  bots: HygieneBotAccess[];
  /** How many days back the window reaches. Stated so the section can name its
   * own horizon rather than implying the series is all there ever was. */
  windowDays: number;
}

// ---------------------------------------------------------------------------
// Freshness (per-lane age badges)
// ---------------------------------------------------------------------------
export interface FreshnessLanes {
  pulseReceivedAt: string | null;
  ledgerRecordedAt: string | null;
  flagFiredAt: string | null;
  annotationAt: string | null;
}

// ---------------------------------------------------------------------------
// Executive performance + evidence-derived interpretation
// ---------------------------------------------------------------------------
/** Every provider series this page charts: 90 visible dates each, plus the
 * optional calculation-only pre-roll each SignalTrend carries. The shape is
 * the Wall's `SignalTrendSet` so one query serves both surfaces. */
export type PropertyPerformance = SignalTrendSet;

export type ExecutiveInsightKind =
  | "warning"
  | "recommendation"
  | "discovery"
  | "insight";

export type ExecutiveInsightConfidence = "medium" | "high";

export interface ExecutiveEvidence {
  label: string;
  value: string;
  detail?: string;
}

/** One deterministic interpretation of named provider rows. This is neither a
 * flag nor an autonomous decision: exact evidence and caveat travel with it. */
export interface ExecutiveInsight {
  key: string;
  kind: ExecutiveInsightKind;
  title: string;
  summary: string;
  whyItMatters: string;
  primary: { value: string; label: string };
  confidence: ExecutiveInsightConfidence;
  windowStart: string;
  windowEnd: string;
  evidence: ExecutiveEvidence[];
  sources: string[];
  caveat: string;
}

/** A finding the display cut dropped: enough to name it, and deliberately not
 * enough to act on it. Evidence, window, and caveat stay with the eight cards
 * the page shows, so this can never be mistaken for a rendered finding. */
export interface SuppressedInsight {
  key: string;
  kind: ExecutiveInsightKind;
  title: string;
}

export type SearchQueryProvider = "google" | "bing";

/** One query present in both comparable provider windows. Missing top-row
 * exports remain unknown and are deliberately excluded rather than read as 0. */
export interface SearchQueryMover {
  query: string;
  currentImpressions: number;
  previousImpressions: number;
  impressionDelta: number;
  impressionDeltaPercent: number;
  currentPosition: number;
  previousPosition: number;
  /** Positive means the query moved closer to position 1. */
  positionImprovement: number;
}

/** One provider's like-for-like query window. Google and Bing stay separate
 * because their report horizons and top-row coverage are not comparable. */
export interface SearchQueryProviderTrend {
  provider: SearchQueryProvider;
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
  daysPerWindow: number;
  movers: SearchQueryMover[];
  /**
   * What this lane states about its own series before ranking it (the
   * `Grounding queries excluded` row). A present row at zero proves the check
   * ran and is emitted even when nothing was excluded; an empty array means the
   * lane makes no such statement, and the two must stay distinguishable.
   * Snapshots written before the field existed normalize to `[]`.
   */
  evidence: ExecutiveEvidence[];
  source: string;
  caveat: string;
}

export type DataForSeoAiOverviewState = "cited" | "present" | "none";

/** Current query-level search visibility from the retained DataForSEO
 * ranked-keywords snapshot. Search volume is provider-modelled market demand,
 * not asset impressions. Rank movement exists only after two locally stored
 * snapshots contain the same query/page pair. */
export interface DataForSeoQueryVisibilityRow {
  query: string;
  monthlySearches: number;
  organicPosition: number | null;
  previousOrganicPosition: number | null;
  /** Positive means the organic result moved closer to position 1. */
  positionImprovement: number | null;
  keywordDifficulty: number | null;
  estimatedVisits: number | null;
  page: string;
  intent: string | null;
  aiOverview: DataForSeoAiOverviewState;
  aiCitationPosition: number | null;
  /**
   * Tracked-query SERP panel evidence (`dataforseo/serp-panel`), one reading
   * per device: whether the live result page for this term carried an AI
   * Overview on that surface, and whether it cited this asset. An empty list
   * means unknown (the query is not on the panel); a reading whose fields are
   * null means the panel covered the term and could not answer. Neither ever
   * means "no overview". A snapshot carrying a flat `aioPresent`/`aioCitesUs`
   * pair is parsed into a single desktop reading.
   */
  aioDevices: SerpPanelAioReading[];
}

export interface DataForSeoQueryVisibility {
  observedAt: string;
  queries: DataForSeoQueryVisibilityRow[];
  source: string;
  caveat: string;
}

export interface SearchQueryTrends {
  google: SearchQueryProviderTrend | null;
  bing: SearchQueryProviderTrend | null;
  dataforseo: DataForSeoQueryVisibility | null;
}

export interface ProductUseMetric {
  key: string;
  eventName: string;
  label: string;
  /** null means GA4 returned no row for this event; it is not manufactured zero. */
  users: number | null;
  events: number | null;
  compareTo?: string;
  comparisonLabel?: string;
}

/** One exact rolling aggregate. Metrics remain separate because a person can
 * appear in more than one step and must never be added into a fake total. */
export interface ProductUseSnapshot {
  windowStart: string;
  windowEnd: string;
  days: number;
  build: ProductUseMetric[];
  sharing: ProductUseMetric[];
  supporting: ProductUseMetric[];
  source: string;
  caveat: string;
}

// ---------------------------------------------------------------------------
// Product: what people do once they arrive, and where it breaks (PostHog)
// ---------------------------------------------------------------------------

/** Google's Core Web Vitals verdict for one 75th percentile. `null` when that
 * metric had no measurements — unmeasured, never "good". */
export type WebVitalRating = "good" | "needs-improvement" | "poor";

/** The four things a product rule can report. Only `fired` produced a finding;
 * `not-enough-data` names the floor it missed, so a thin window never reads as
 * a healthy one. */
export type ProductCheckState = "fired" | "clear" | "not-enough-data" | "not-collected";

export interface ProductCheck {
  key: string;
  label: string;
  state: ProductCheckState;
  detail: string;
}

/** One family's newest read: when it ended and what window it measured. */
export interface ProductFamilyReading {
  family: string;
  reportDate: string;
  windowStart: string;
  windowEnd: string;
  rows: number;
  /** The read hit its row limit, so it is a top-N list and any total is a floor. */
  truncated: boolean;
}

/** One day of site use. Each figure is null when PostHog sent none — never 0.
 * `people` is unique within that day, so days never add into a total. */
export interface ProductDay {
  date: string;
  people: number | null;
  pageviews: number | null;
  sessions: number | null;
}

export interface ProductWebDaily {
  windowStart: string;
  windowEnd: string;
  reportDate: string;
  days: ProductDay[];
}

export interface ProductFunnelStep {
  step: number;
  event: string;
  /** null when the step is not pinned to a page. */
  path: string | null;
  people: number;
}

export interface ProductFunnelDrop {
  fromStep: number;
  toStep: number;
  lostPeople: number;
  /** Share of the earlier step's people who reached the later one, 0–1. */
  stepConversion: number;
}

export interface ProductFunnel {
  id: string;
  name: string;
  windowStart: string;
  windowEnd: string;
  steps: ProductFunnelStep[];
  /** Last step ÷ first step; null with fewer than two steps or no starters. */
  conversion: number | null;
  largestDrop: ProductFunnelDrop | null;
  /** The same funnel in the read that ended seven days earlier. null when no
   * such read exists — "no comparison yet", never "no change". */
  prior: {
    windowStart: string;
    windowEnd: string;
    conversion: number | null;
    /** The same step pair as `largestDrop`, one window earlier. */
    stepConversion: number | null;
  } | null;
}

export interface ProductVitalSegment {
  path: string;
  device: string | null;
  os: string | null;
  measurements: number;
  lcpP75: number | null;
  inpP75: number | null;
  clsP75: number | null;
  lcpRating: WebVitalRating | null;
  inpRating: WebVitalRating | null;
  clsRating: WebVitalRating | null;
}

export interface ProductVitalLine {
  good: number;
  poor: number;
}

export interface ProductVitals {
  windowStart: string;
  windowEnd: string;
  reportDate: string;
  /** Segments below this many measurements are not rated. */
  minMeasurements: number;
  /** Google's lines at the 75th percentile, as the producer applied them. */
  lines: { lcp: ProductVitalLine; inp: ProductVitalLine; cls: ProductVitalLine };
  /** Rated segments on the top pages, worst first. */
  segments: ProductVitalSegment[];
  /** Top-page segments left unrated for having too few measurements. */
  unmeasuredSegments: number;
}

export interface ProductException {
  type: string | null;
  message: string | null;
  count: number;
  people: number;
  sessions: number | null;
  maxPerSession: number | null;
  /** null when PostHog could not say. */
  hasSourceFile: boolean | null;
  topPath: string | null;
  topBrowser: string | null;
}

export interface ProductExceptions {
  windowStart: string;
  windowEnd: string;
  reportDate: string;
  total: number;
  truncated: boolean;
  /** One message holding half the volume with no source file: probably not the
   * site's own code. Set aside before the ranking. */
  noise: (ProductException & { share: number }) | null;
  /** The rest, by people affected. */
  top: ProductException[];
}

export interface ProductRageCluster {
  path: string;
  tag: string | null;
  text: string | null;
  attr: string | null;
  /** What a person would call the control ("heightFeet input"). */
  element: string;
  clicks: number;
  people: number;
  pagePeople: number;
  /** people ÷ pagePeople. */
  share: number;
  desktopShare: number | null;
}

export interface ProductRageClicks {
  windowStart: string;
  windowEnd: string;
  reportDate: string;
  /** The share of page visitors past which an element is a cluster. */
  shareLine: number;
  clusters: ProductRageCluster[];
}

export interface ProductOnceEvent {
  event: string;
  count: number;
  people: number;
  perPerson: number;
}

/** The Growth tab's Product section. Each part is null when its family was not
 * collected; the section never draws a zero for a figure nobody measured. */
export interface ProductSnapshot {
  source: "posthog";
  /** The newest report date across the collected families. */
  observedAt: string;
  collectedAt: string | null;
  families: ProductFamilyReading[];
  webDaily: ProductWebDaily | null;
  funnels: ProductFunnel[];
  vitals: ProductVitals | null;
  exceptions: ProductExceptions | null;
  rageClicks: ProductRageClicks | null;
  onceEvents: ProductOnceEvent[];
  checks: ProductCheck[];
  caveat: string;
}

export interface SearchIntelligenceSnapshot {
  observedAt: string | null;
  /** Exact provider-reported cost of the latest retained report families. */
  costUsd: number;
  rankings: {
    keywords: number;
    top3: number;
    top10: number;
    top20: number;
    estimatedVisits: number;
    estimatedPaidTrafficCost: number;
    aiOverviewReferences: number;
  };
  backlinks: {
    rank: number;
    backlinks: number;
    referringDomains: number;
    newReferringDomains: number;
    lostReferringDomains: number;
  } | null;
  /** Null when the provider stated no figure or the family was never
   * collected: unknown, never zero. */
  ai: {
    googleMentions: number | null;
    googleSearchVolume: number | null;
    chatgptMentions: number | null;
    chatgptSearchVolume: number | null;
  };
  /** The names behind the backlink counts, so a lost referring domain can
   * become a reclamation target instead of a number. */
  referringDomains: ReferringDomain[];
  /** The inbound anchor distribution — a risk read and an AI-visibility input. */
  anchors: AnchorProfile | null;
  /** Net-new demand the asset does not already rank for. */
  keywordIdeas: KeywordIdea[];
  /** Who else holds the pages this asset competes on. */
  competitors: SerpCompetitor[];
}

export interface ReferringDomain {
  domain: string;
  /** Provider domain rank, 0–1000. */
  rank: number;
  backlinks: number;
  spamScore: number;
  firstSeen: string | null;
}

export interface AnchorProfile {
  /** Distinct anchors in the retained head, not the asset's whole profile. */
  sampled: number;
  /** Anchors whose spam score clears `ANCHOR_SPAM_THRESHOLD`. */
  spammy: number;
  /** Referring domains behind those spammy anchors — the number that matters,
   * since one PBN can mint a hundred anchors. */
  spammyDomains: number;
  top: AnchorEntry[];
}

export interface AnchorEntry {
  anchor: string;
  referringDomains: number;
  backlinks: number;
  spamScore: number;
}

export interface KeywordIdea {
  keyword: string;
  searchVolume: number;
  /** 0–100; low difficulty at real volume is the whole point of the family. */
  difficulty: number;
  cpc: number;
  intent: string | null;
}

export interface SerpCompetitor {
  domain: string;
  /** How many of OUR keywords this domain also ranks for. */
  intersections: number;
  /** The competitor's own keyword count, the denominator below. */
  competitorKeywords: number;
  /**
   * `intersections / competitorKeywords`, 0–1. Raw intersections rank the
   * general web first, because sites that rank for everything overlap on
   * thousands of keywords; share asks how much of their footprint is ours, so
   * the giants sink without a denylist.
   */
  overlapShare: number;
  avgPosition: number;
}

/** Above this, an anchor is spam rather than editorial. DataForSEO scores
 * 0–100; observed PBN anchors scored around 65 and genuine ones 0–15. */
export const ANCHOR_SPAM_THRESHOLD = 40;

/** One rolling export, with each number's actual page/bucket scope. No daily
 * grain or whole-property audience is implied by a URL-dimension export. */
export interface ClaritySnapshot {
  source: "clarity";
  reportDate: string;
  collectedAt: string | null;
  windowHours: 72;
  truncated: boolean;
  page: { url: string; sessions: number | null; scriptErrors: number | null } | null;
  unattributedSessions: number | null;
}

/** Compact presentation boundary derived from the immutable archives. */
export interface ExecutiveSnapshot {
  schemaVersion: 1;
  asset: string;
  generatedAt: string;
  windowStart: string | null;
  windowEnd: string | null;
  sourceArchiveCount: number;
  items: ExecutiveInsight[];
  /** The cards the eight-card display cut dropped, named rather than discarded
   * (`scripts/signal-insights.mjs`, INSIGHT_CARD_LIMIT). Identity only, never
   * evidence, so a suppressed card cannot be mistaken for a rendered one. Older
   * snapshots normalize to `[]`. */
  suppressedItems: SuppressedInsight[];
  /** Compact query movement derived from the same immutable archives. Older
   * snapshots are normalized to null by the payload parser. */
  searchQueries: SearchQueryTrends | null;
  /** The same comparison at page grain — the evidence the page decision table
   * is built on. Null on older snapshots and on any asset without two complete
   * weeks. */
  searchPages: SearchPageTrends | null;
  /** Exact rolling product-use aggregates when the asset declares a
   * deterministic event map. Older snapshots normalize to null. */
  productUse: ProductUseSnapshot | null;
  /** Latest weekly DataForSEO ranking, link, and AI-visibility snapshot.
   * Older presentation snapshots normalize to null. */
  searchIntelligence: SearchIntelligenceSnapshot | null;
  /** The tracked-query SERP panel this asset bought, if it bought one.
   * ABSENT means no panel — including on every snapshot written before the
   * block existed, which is the same nothing. Never an empty scoreboard. */
  serpPanel: SerpPanelSnapshot | null;
  /** What people do once they arrive, and where it breaks (PostHog). null when
   * no family was collected; absent on older snapshots, which means the same. */
  product?: ProductSnapshot | null;
  /** Latest Clarity 72-hour observation; older snapshots normalize to null. */
  clarity?: ClaritySnapshot | null;
  methodology: string[];
}

// ---------------------------------------------------------------------------
// The tracked-query SERP panel
// ---------------------------------------------------------------------------

/** One device's AI-Overview reading of one tracked result page. A phone result
 * page is not a narrower desktop one — an overview can consume the click on one
 * surface and not the other — so readings are per device and never folded at
 * rest. */
export interface SerpPanelAioReading {
  /** The surface, as the archive recorded it: `mobile` or `desktop` in
   * practice. An unrecognized literal rides through rather than being dropped —
   * the collector's device list is config, not a closed set. */
  device: string;
  aioPresent: boolean | null;
  aioCitesUs: boolean | null;
}

/** The order every device-keyed surface states the devices in: the phone
 * leads because that is where most of this demand searches. */
export const SERP_PANEL_DEVICE_ORDER = ["mobile", "desktop"];

/** Device order, with anything unrecognized sorted after both alphabetically. */
export function bySerpPanelDevice(left: string, right: string): number {
  const rank = (device: string) => {
    const index = SERP_PANEL_DEVICE_ORDER.indexOf(device);
    return index === -1 ? SERP_PANEL_DEVICE_ORDER.length : index;
  };
  return rank(left) - rank(right) || left.localeCompare(right);
}

/** The surface as the operator names it; the lane's `mobile` is never the
 * page's vocabulary. */
export function serpPanelDeviceNoun(device: string): string {
  if (device === "mobile") return "Phone";
  if (device === "desktop") return "Desktop";
  return device.charAt(0).toUpperCase() + device.slice(1);
}

/** The three AI-Overview states the glyph has weights for, plus `unknown`,
 * which draws no mark at all. */
export type AiOverviewGlyphState = "cited" | "uncited" | "absent" | "unknown";

/**
 * One device's reading as the glyph reads it. `null` presence is unknown and
 * must never harden into `absent`. A present overview whose citation did not
 * parse reads `uncited`, the weaker claim.
 */
export function aiOverviewGlyphState(
  reading: SerpPanelAioReading,
): AiOverviewGlyphState {
  if (reading.aioPresent !== true && reading.aioPresent !== false) return "unknown";
  if (!reading.aioPresent) return "absent";
  return reading.aioCitesUs === true ? "cited" : "uncited";
}

/**
 * The panel's AI-Overview answer for one term across every device it was read
 * on — a derivation for surfaces that count terms, never a stored fact. Any
 * surface, not all: an overview on the phone is one a real person hit, and a
 * clear desktop page does not give that click back. False only when a device
 * answered and none saw an overview; unknown stays unknown, never `false`.
 */
export function foldSerpPanelAio(readings: SerpPanelAioReading[]): {
  aioPresent: boolean | null;
  aioCitesUs: boolean | null;
} {
  const any = (pick: (reading: SerpPanelAioReading) => boolean | null) => {
    if (readings.some((reading) => pick(reading) === true)) return true;
    if (readings.some((reading) => pick(reading) === false)) return false;
    return null;
  };
  return {
    aioPresent: any((reading) => reading.aioPresent),
    aioCitesUs: any((reading) => reading.aioCitesUs),
  };
}

/** One tracked query on one device, as that live result page showed it. This
 * is the panel's own row set — every query the operator pays to track — so
 * "ranks on 12 of 20" means the panel's 20. The 20 counts terms while this
 * array holds one row per term per device; `serpPanelTerms()` is the only
 * sanctioned way back. */
export interface SerpPanelQuery {
  query: string;
  /** The surface this row was read on. A snapshot written before the collector
   * read two devices carries none, and the parser reads that absence as
   * `desktop`. */
  device: string;
  /**
   * The cluster this query measures — the bet, not the term. `null` is normal:
   * a panel may label nothing, and older collections have empty cells. It is
   * the archived label, never today's config: a rename applies from the next
   * collection forward, so nothing rendering this may look it up in
   * config/serp-panel.json.
   */
  label: string | null;
  /**
   * Best organic rank this asset holds on the page. `null` means no result
   * inside the tracked depth — not "does not rank": to a fixed-depth pull,
   * rank 24, rank 900 and genuinely absent are one observation.
   */
  bestRank: number | null;
  /** The URL holding `bestRank`, null when nothing ranked inside the depth. */
  bestUrl: string | null;
  /**
   * Whether an AI Overview fired on that result page, and whether it cited
   * this asset. `null` is unknown and never "no": the overview loads
   * asynchronously and a pull that missed it recorded nothing.
   */
  aioPresent: boolean | null;
  aioCitesUs: boolean | null;
  /** The organic neighborhood on this exact term/device result page, or null
   * when that page was unread. Grouped as one availability boundary so an old
   * snapshot cannot render four empty fields as an observed empty SERP. */
  composition: SerpPanelComposition | null;
  /** Present only when the provider could not answer this paid call. The row is
   * still part of the reviewable panel, but every observation on it is unknown. */
  providerStatus?: string;
  /** Total attempts for this call, including the first one. Three means the
   * bounded exponential-backoff ladder was exhausted. */
  providerAttempts?: number;
}

/** What surrounded the asset on one readable tracked result page. Current
 * composition only: the snapshot retains one collection, so none of these
 * fields may be read as movement. */
export interface SerpPanelComposition {
  /** Domains in organic positions 1–3, in result order. Fewer than three is a
   * readable short list, not three unknown placeholders. */
  top3Domains: string[];
  /** Count of organic results returned inside this pull. */
  organicResults: number;
  /** The asset's second organic slot on this page, when it held one. */
  secondRank: number | null;
  secondUrl: string | null;
  /** Non-organic page features in the provider's own item-type vocabulary. */
  serpFeatures: string[];
}

/** One weekly panel collection, as `scripts/signal-insights.mjs` publishes it
 * onto the asset's insight snapshot from the `dataforseo/serp-panel`
 * archive. */
export interface SerpPanelSnapshot {
  /** The collection day (`report_date`) these rows are about. */
  reportDate: string;
  /**
   * How deep the pull looked, from the archive's own `tracked_depth`. `null` on
   * a legacy row that never recorded it, deliberately not defaulted to 20: a
   * surface with a null depth says "inside tracked depth" without a number.
   */
  trackedDepth: number | null;
  /** The search market the site saved, the one the panel is asked in. `null`
   * when the site saved none or the snapshot predates it: the caption then
   * names no market. */
  market: SearchMarket | null;
  queries: SerpPanelQuery[];
}

/** The line a human reads first. Every field is a count of terms; the two
 * AI-Overview figures use `aioKnown` as their denominator, because dividing by
 * `tracked` would spend every unknown as a "no". */
export interface SerpPanelScoreboard {
  /** Terms on the panel — the denominator for the rank tiers; terms, not rows,
   * so two devices do not double it. */
  tracked: number;
  /** Terms holding any rank inside `trackedDepth`, on any device read. */
  ranking: number;
  top10: number;
  top3: number;
  /** Terms whose AI-Overview presence was observed on at least one device. A
   * term unknown on both devices is one unknown, not two. */
  aioKnown: number;
  /** Terms whose result page carried an AI Overview on any device read. */
  aioPresent: number;
  /** Terms whose AI Overview cited this asset on any device read. */
  aioCitesUs: number;
}

/**
 * One tracked term and every device the panel read it on. The folded fields
 * exist so the scoreboard and the row summary share one derivation; a surface
 * that wants the split reads `devices`.
 */
export interface SerpPanelTerm {
  query: string;
  /** The cluster the term's rows recorded, or null. The label rides on the
   * query, not the surface, so the first non-null wins. */
  label: string | null;
  /** Its rows, one per device, in `SERP_PANEL_DEVICE_ORDER`. */
  devices: SerpPanelQuery[];
  /** Best rank across the surfaces the term was read on; null when no device
   * found a result inside the tracked depth. */
  bestRank: number | null;
  /** The URL holding `bestRank`, from whichever device holds it. */
  bestUrl: string | null;
  /** `foldSerpPanelAio(devices)` — an overview on ANY surface. */
  aioPresent: boolean | null;
  aioCitesUs: boolean | null;
}

/**
 * The panel's rows grouped back into the terms the operator bought — the only
 * sanctioned way from rows to terms, so a device split cannot multiply a
 * denominator or turn one unknown term into two. Terms come out in first-seen
 * order; the caller decides the sort.
 */
export function serpPanelTerms(panel: SerpPanelSnapshot): SerpPanelTerm[] {
  const byTerm = new Map<string, SerpPanelQuery[]>();
  for (const row of panel.queries) {
    const key = row.query.trim().toLocaleLowerCase("en-US");
    byTerm.set(key, [...(byTerm.get(key) ?? []), row]);
  }
  return [...byTerm.values()].map((rows) => {
    const devices = [...rows].sort((left, right) =>
      bySerpPanelDevice(left.device, right.device),
    );
    const best = devices
      .filter((row) => row.bestRank !== null)
      .sort((left, right) => left.bestRank! - right.bestRank!)[0];
    return {
      query: devices[0]!.query,
      label: devices.find((row) => row.label !== null)?.label ?? null,
      devices,
      bestRank: best?.bestRank ?? null,
      bestUrl: best?.bestUrl ?? null,
      ...foldSerpPanelAio(devices),
    };
  });
}

/**
 * The scoreboard, from the panel's own rows. Every figure counts terms, never
 * rows. The rank tiers require `bestRank !== null`, so a term with no result
 * inside the tracked depth is counted in `tracked` and nothing else.
 */
export function serpPanelScoreboard(panel: SerpPanelSnapshot): SerpPanelScoreboard {
  const terms = serpPanelTerms(panel);
  const board: SerpPanelScoreboard = {
    tracked: terms.length,
    ranking: 0,
    top10: 0,
    top3: 0,
    aioKnown: 0,
    aioPresent: 0,
    aioCitesUs: 0,
  };
  for (const row of terms) {
    if (row.bestRank !== null) {
      board.ranking += 1;
      if (row.bestRank <= 10) board.top10 += 1;
      if (row.bestRank <= 3) board.top3 += 1;
    }
    if (row.aioPresent === true || row.aioPresent === false) board.aioKnown += 1;
    if (row.aioPresent === true) board.aioPresent += 1;
    if (row.aioCitesUs === true) board.aioCitesUs += 1;
  }
  return board;
}

/**
 * The two GA4 declarations this asset owns, as config holds them — the rows
 * its Sources tab edits. `null` means the asset has no entry; `[]` means an
 * entry exists and declares nothing. Both behave the same downstream but are
 * different writes: a first row lands in an existing entry rather than
 * creating one (`CollectionChange` `seed`).
 */
export interface AssetGa4Config {
  /** `config/value-events.json` → `/assets/<id>/valueEvents`. */
  valueEvents: string[] | null;
  /** `config/ga4-custom-dimensions.json` → `/assets/<id>/eventParams`. */
  eventParams: string[] | null;
  productUseStages?: import('@noticeos/contract/product-use').ProductUseStage[] | null;
  /** Distinguishes first list creation from first asset-holder creation. */
  valueEventsEntryExists?: boolean;
}

/**
 * The two tracked-panel registers as they hold this asset — what its Growth
 * tab edits. Same `null`-is-not-`[]` rule as `AssetGa4Config`:
 *
 *   - `trackedQueries: null` is an asset that buys no tracked panel at all;
 *     the first term files the asset's whole entry (`seed`) rather than
 *     appending.
 *   - `trackedQueries: []` is an entry listing no terms, which the panel config
 *     treats as an error, so the register declares `emptyIsAbsent` and the
 *     last term out takes the entry with it (`unseed`).
 *   - `roster: null` is a gap, because `config/signal-panels.json` makes
 *     membership an invariant.
 *
 * A tracked term is a bare string or `{query, label}`, in any mix, so the list
 * is `JsonValue[]`: repairing it to one shape would throw away the cluster.
 */
export interface AssetPanelConfig {
  /** `config/serp-panel.json` → `/assets/<id>/queries`. */
  trackedQueries: JsonValue[] | null;
  /** `config/signal-panels.json` → `/assets/<id>`, the whole roster row. */
  roster: JsonValue | null;
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------
/** A site's configured totals, each resolved to the freshest lane that
 * carries it (`resolveCounterCards`, worker/counters.ts). */
export interface SiteCounters {
  /** The register's own heading for this site ("All-time totals", "Current
   * catalog"). */
  heading: string;
  /** The counters job's longest wait between runs, in hours, as it is
   * scheduled (`countersCadenceHours`): a fast-lane reading older than twice
   * this is amber. */
  cadenceHours: number;
  cards: CounterCard[];
}

/** One failed nightly-report fetch on a site's Data sources tab: the stored
 * reading, and whether its alert is still open. */
export interface FetchFailure extends FlagReading {
  ongoing: boolean;
}

export interface AssetDetailPayload {
  generatedAt: string;
  asset: AssetInfo;
  /** Complete latest-run matrix on asset #0; null on ordinary assets. */
  scheduledLanes: ScheduledLane[] | null;
  wiring: Wiring;
  /** `config/counters.json` → `/assets/<id>`: this site's card totals entry as
   * the file holds it, which the Settings tab's Card totals edits and guards
   * its removal on. `null` when the site declares no totals. */
  countersConfig: JsonValue | null;
  /** The asset's own rows in the two tracked-panel registers, which its Growth
   * tab edits. */
  panelConfig: AssetPanelConfig;
  rules: RulesInForce;
  /** Portfolio-wide spend caps + operator rate (config/constants.json), editable. */
  portfolio: PortfolioConfig;
  /** Current asset-acquisition performance, reconstructed from append-only
   * provider observations and limited to a rolling 90-day visible horizon;
   * calculation-only pre-roll is carried separately on each SignalTrend. */
  performance: PropertyPerformance;
  /** Latest deterministic archive analysis. null means no snapshot was
   * published; missing evidence is never interpreted as a healthy or bad zero. */
  executive: ExecutiveSnapshot | null;
  /** Latest exact-family archive attempts, separate from the saved analysis's
   * generation clock. Missing on older payloads means unavailable. */
  recommendationEvidence?: RecommendationSourceEvidence | null;
  /** The 30 newest nightly reports, per metric. A site's stock totals are
   * `counters` below, resolved to their freshest lane. */
  metrics: PulseMetric[];
  /** This site's all-time totals and catalog counts (config/counters.json),
   * drawn on its Overview. Null: the site configures none. */
  counters: SiteCounters | null;
  flags: FlagsSection;
  ledger: LedgerSlice;
  dailyRevenue?: DailyRevenueHistory;
  /** The operator's clock the Worker read days in: config/constants.json
   * `os_time_zone` as saved. The page's own date math uses this. */
  osTimeZone: string;
  /** Every operator decision recorded for this asset. An item with no row is
   * untouched; the client matches rows by `key` alone. */
  decisions: AssetDecision[];
  /**
   * The tasks filed from this asset's handoffs, as the newest task snapshot
   * saw them, matched by `key` like `decisions`. null is not an empty list:
   * `[]` means the poller looked and nobody has filed anything; `null` means
   * it could not look (no snapshot, the asset is not a project in
   * `config/beads.json`, `bd` failed, or the snapshot predates the field). A
   * card must never turn "could not ask the register" into "nothing filed".
   */
  handoffBeads: HandoffBead[] | null;
  /** The asset's human-action posture from the same task snapshot that
   * supplied `handoffBeads` and `panelReview`. Tasks are coordination state,
   * not asset signals; this slice never feeds health or growth derivations. */
  operator: AssetOperatorPosture;
  /** What changed on this asset, newest first, plus a count of older rows the
   * read did not carry: a capped timeline that does not say it is capped
   * reads as the whole history. */
  annotations: AnnotationTimeline;
  /** Pre-registered outcome checks for this asset. The strip is read-only — a
   * registered comparison must survive learning the answer, and evaluation
   * belongs to the scheduled job — but the Timeline section can open one
   * through ingest's `createWatchWindow()` RPC. The strip renders nothing when
   * both lists are empty; the action lives in the section header. */
  watches: WatchSlice;
  /** This asset's link-outreach pipeline, read-only. null when the table holds
   * no rows for it: the Tower has no write UI for one, so an empty section
   * would be a dead end. */
  reclamation: ReclamationSlice | null;
  /** The nightly served-layer history, read-only. null until the hygiene
   * guard's first night for this asset. */
  hygiene: HygieneHistory | null;
  /** This site's most recent failed nightly-report fetches, newest first: the
   * readings of its `asset-pull-failed` alerts (`flag_evidence`). [] when none. */
  fetchFailures: FetchFailure[];
  /** This asset's integration lanes: file-backed scope/setup plus store-derived
   * effective health and evidence. Health is displayed, never manually edited. */
  integrations: AssetIntegrations;
  /** The GA4 lane's two operator declarations, editable on the Sources tab. */
  ga4Config: AssetGa4Config;
  /** This asset's serp-panel review obligation, or null — the same two fields
   * the Wall's cards carry, derived by the same functions over the same reads,
   * so the page a Wall badge points at states the obligation. The same three
   * absences collapse to null as on the card. An asset with no
   * `config/serp-panel.json` entry is not an absence; it states the read in its
   * own noun (`panelReviewNouns`). */
  panelReview: PanelReview | null;
  /** The newest panel DAY collected for this asset ('YYYY-MM-DD') — the day
   * a finished review has to be about for it to still count. */
  latestPanelDate: string | null;
  freshness: FreshnessLanes;
}

// ---------------------------------------------------------------------------
// Page-grain decisions
// ---------------------------------------------------------------------------

/** The page's largest query by impressions in the current window, off the
 * grounding-decontaminated page/query series — what Google shows this page
 * for, not what it earns clicks on. `aioDevices` reads exactly like
 * `DataForSeoQueryVisibilityRow.aioDevices`. */
export interface SearchPageLeadingQuery {
  query: string;
  impressions: number;
  clicks: number;
  /** Impression-weighted average, or null where no row carried a position. */
  position: number | null;
  aioDevices: SerpPanelAioReading[];
}

/** One page present in BOTH comparable Google windows. A page reported in only
 * one week is unknown rather than zero — `gsc-page` is a top-row export — and is
 * left out, so this understates movement at the export boundary. */
export interface SearchPageMover {
  /** The page URL as GSC reports it: the join key, and what a handoff quotes. */
  page: string;
  /** Path + query string — what the surface renders. */
  path: string;
  currentClicks: number;
  previousClicks: number;
  clickDelta: number;
  /** Null when the previous window took no clicks: a change from zero has no
   * percentage a reader can use, and the absolute is the honest number. */
  clickDeltaPercent: number | null;
  currentImpressions: number;
  previousImpressions: number;
  impressionDelta: number;
  impressionDeltaPercent: number;
  /** Impression-weighted average position, or null where none was reported. */
  currentPosition: number | null;
  previousPosition: number | null;
  /** Positive means the page moved closer to position 1. Null when either
   * window carried no position. */
  positionImprovement: number | null;
  currentCtr: number;
  previousCtr: number;
  /** Null where the page/query export does not cover this page in this window —
   * unknown, never "this page ranks for nothing". */
  leadingQuery: SearchPageLeadingQuery | null;
}

/** The page-grain window comparison. Google only: no other archived family
 * carries a page dimension, so there is no second lane to keep separate. */
export interface SearchPageTrends {
  provider: "google";
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
  daysPerWindow: number;
  pages: SearchPageMover[];
  /** Read exactly like `SearchQueryProviderTrend.evidence`. The one row here
   * is labelled for the leading-query join rather than the totals, because a
   * page row carries no query to classify. */
  evidence: ExecutiveEvidence[];
  source: string;
  caveat: string;
}
