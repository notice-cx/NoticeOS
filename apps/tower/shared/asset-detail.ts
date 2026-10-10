import type { DailyRevenueHistory } from "./daily-revenue";
import type { Liveness, SignalVerification } from "./signal-liveness";

// Shared AssetDetail contract: the single payload GET /api/assets/:id returns.
// Same discipline as wall.ts — pure types + plain constants, no runtime deps, so
// it is safe in workerd AND imported by the client for rendering. The page is the
// reference implementation of doc-15 principle 10 ("every knob is visible where it
// acts"): every fact carries its EFFECTIVE value plus an OWNER pointer to the file
// (or store table, per doc 06) that changes it. The Tower points at owners; it
// never edits them.

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

// The annotation vocabulary lives in its own module (both payload contracts need
// it now) but is re-exported here, where the timeline it describes is assembled.
export type { AnnotationItem, AnnotationKind, AnnotationTimeline };

/** Onboarding lifecycle, db/0001 assets.status CHECK. `retired` is off the
 * happy path (rendered distinctly by the stepper). */
export type AssetStatus =
  | "pre-launch"
  | "onboarding"
  | "baselining"
  | "live"
  | "retired";

/** The lifecycle word an operator reads. It lives beside the type rather than
 * inside one route because three surfaces state it now: the asset page's status
 * control, that page's staged-edit preview, and Home's assets table (bead
 * `ro-pbzu.3`). One map means one spelling — two pages naming the same
 * lifecycle stage differently is the drift the registry exists to prevent. */
export const ASSET_STATUS_LABEL: Record<AssetStatus, string> = {
  "pre-launch": "Pre-launch",
  onboarding: "Onboarding",
  baselining: "Baselining",
  live: "Live",
  retired: "Retired",
};

/**
 * The same word for a status that arrived as a bare string.
 *
 * The Wall payload types `AssetCard.status` as `string`, not this union: what
 * guarantees the value is the store's own CHECK constraint, and a read model
 * that crashed on a status a migration added would be a worse failure than one
 * that shows it. So an unrecognized value is HUMANIZED rather than dropped or
 * blanked — a lifecycle stage the Tower has never seen is still a fact about
 * the asset.
 */
export function assetStatusLabel(status: string): string {
  return (
    ASSET_STATUS_LABEL[status as AssetStatus] ??
    status.replace(/[-_]+/g, " ").replace(/^./, (letter) => letter.toUpperCase())
  );
}

// ---------------------------------------------------------------------------
// A stage move is an EVENT on the asset (bead `ro-3085`)
// ---------------------------------------------------------------------------

/**
 * A lifecycle move recorded as a timeline row, because `assets.status` holds
 * only where an asset IS and never where it has been.
 *
 * WHY AN ANNOTATION AND NOT A COLUMN. Restore used to return an asset to the
 * stage it remembered in React state, and to `live` once that memory was gone —
 * so an asset archived out of `baselining` and restored the next day silently
 * became live and armed its alert rules early. The store carried no answer to
 * "what stage did it leave", and giving it one would mean a migration, which is
 * operator-only (AGENTS.md). The timeline is where changes to an asset already
 * live, it is already read by this payload, and the Activity tab renders it — so
 * the move is written there and Restore READS the answer instead of guessing.
 *
 * WHY `kind: "config"` AND NOT A NEW KIND. `annotations.kind` is a CHECK
 * constraint in db/0001 — widening the vocabulary is a migration. `config` is
 * the closest existing member and an honest one: a stage is a stored setting on
 * the asset, edited from the Settings tab under the `db · assets row` owner.
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
 * The `ref` a stage move is stored under — `lifecycle:baselining>retired`:
 * machine readable, ASCII, and part of the row's `(asset, at, kind, ref)`
 * identity, so
 * two different moves recorded in the same second stay two rows and a retried
 * write collapses into one.
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
 * it to.
 *
 * `items` is the detail payload's timeline, newest first, so the FIRST recorded
 * move into `retired` is the archiving this restore undoes. `null` means no such
 * move is on record (an asset archived before this was written, or one whose
 * archiving has fallen off the end of the read) — and a caller that then shows
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

/** Kept as a re-export for callers that consume the asset-detail contract. The
 * canonical vocabulary lives in wall.ts because both portfolio attention and
 * asset detail render the same flags. */
export type { FlagKind } from "./wall";

/** db/0001 flags.disposition — the only sanctioned flag mutation (doc 14-E). */
export type Disposition = "ack" | "snooze" | "tune" | "incident" | "hypothesis";

export type BookingState = "estimated" | "reconciled";

/** db/0013 decisions.kind — which surface the operator decided to mark or
 * dismiss. Page rows are handoffs only and deliberately never enter this
 * store-backed vocabulary. */
export type DecisionKind = "query" | "finding";

/** Tower surfaces that can file work into an asset's task register. This is
 * wider than `DecisionKind`: a page decision and an alert can each file a bead,
 * but neither has an operator display-state row in `decisions` and neither needs
 * a migration to get one — an alert's disposition already lives on the flag.
 *
 * The same four values are `BEADS_HANDOFF_KINDS`
 * (workers/ingest/src/beads-snapshots.ts) and the poller's `HANDOFF_KINDS`
 * (scripts/runner/task-snapshot.mjs). Since `ro-05hb` a kind one of them has not heard of costs
 * its own marker rather than the whole board. */
export type HandoffKind = DecisionKind | "page" | "alert";

/**
 * db/0021 decisions.status — what the operator wants DISPLAYED, and nothing
 * else. There is no `open`: an untouched item has no row at all, and clearing a
 * decision deletes it (doc 10 "absence means untouched").
 *
 * `handed_off` was a third value and is RETIRED (bead `ro-5e8.3`). It recorded
 * that the operator had COPIED a query's Markdown, which is a claim about
 * intent and not about work: a copy nobody ever ran filed nothing while the row
 * claimed otherwise, and a bead filed by hand left no row at all. `handoffBeads`
 * answers that same question from the register, so the query row reads THAT and
 * this vocabulary shrinks to the two states that really are display state.
 *
 * The store agrees since `db/0021` (bead `ro-5e8.4`), which deleted the rows an
 * older Tower had written and narrowed the CHECK to these two values. This type
 * and that constraint are now the same vocabulary, stated twice.
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
 * A bead somebody filed FROM this asset's Tower handoff — the register's
 * answer to a finding, joined back to it (bead `ro-248`).
 *
 * The join is the handoff's own metadata grammar, not a foreign key the OS
 * owns: `apps/tower/src/lib/task-handoff.ts` writes `noticeos_key` /
 * `noticeos_kind` / `noticeos_asset` into the `bd create` an agent runs, the
 * poller reads them back off the asset's spoke, and `key` here is that
 * `noticeos_key` byte for byte. Nothing in the OS creates these beads; the
 * analyzer deliberately never writes to the register (design decision
 * 2026-08-01), so this is a photograph of what a person filed, and a finding
 * with no bead simply has none.
 *
 * `key` is the rendered row's own stable key — the normalized query for kind
 * `query`, the card key for kind `finding`, the absolute URL for kind `page`,
 * and the flag id for kind `alert` — so every surface matches by key alone,
 * with no second join in the payload.
 */
export interface HandoffBead {
  kind: HandoffKind;
  /** `noticeos_key` verbatim. Byte-exact, because a query may contain a comma
   * and `bd` splits LABEL values on commas — the `key:` label carries a lossy
   * slug and only the metadata field can be matched against a rendered key. */
  key: string;
  /** The bead in the asset's own spoke (`mp-1w2`) — the thing to go and
   * read, and the ref the commit, annotation, and watch window all quote. */
  beadId: string;
  /**
   * `bd`'s richer statuses collapse to two: in_progress, blocked, and deferred
   * are all ways of the work not having landed yet.
   *
   * `closed` records a task decision, not proof of shipment or outcome. A task
   * may have been declined. Nothing rendering this may treat a closed bead as
   * a resolved finding without separate change and outcome evidence.
   */
  status: "open" | "closed";
  /** When it was closed. Null on an open bead, and on a closed one whose
   * timestamp the poller could not read. */
  closedAt: string | null;
}

/** An owner pointer: the repo file (doc 06 config-is-files) or store table where
 * a fact is CHANGED. Rendered as a monospace path chip with a copy affordance —
 * the Tower points precisely at what it does not itself edit. */
export type OwnerPath = string;

/** Canonical owner pointers, single-sourced so copy never drifts. */
export const OWNER = {
  pull: "config/pull.json",
  constants: "config/constants.json",
  assets: "db · assets row",
  ingest: "workers/ingest",
  ingestSecrets: "workers/ingest/.dev.vars",
} as const;

/** How a site's nightly report is authenticated, as a site's Settings shows it
 * (bead `ro-ujb9.166`): the site's own bearer token, never shown. It used to be
 * the environment binding's expression (`ASSET_TOKENS['<site>']`) printed to a
 * stranger on a new site; that binding is doc 06's to name, not a screen's. */
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
  /** The operator declared that this asset sends no nightly report (bead
   * `ro-ujb9.96.8`). Whether a report is expected is
   * `expectsNightlyReport(noNightlyReport, freshness.pulseReceivedAt)`: never
   * while declared, and otherwise only once one has arrived (D29 amended, bead
   * `ro-ujb9.121`). Absent on an older payload, which means not declared. */
  noNightlyReport?: boolean;
  /** Worst severity among OPEN flags. The header renders a dot only for
   * actionable warning/error states; healthy identity is the favicon. */
  worstOpenSeverity: Severity | null;
  openError: number;
  openWarn: number;
}

// ---------------------------------------------------------------------------
// Wiring panel (doc 14 principle 10 — secondary, operator-expandable config)
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
   * The job that produces this asset's nightly report and its schedule AS
   * SAVED (bead `ro-ujb9.96.7.12`) — the OS's pull (`pull`) or its own
   * self-report (`asset-zero`); null for a pushing asset, which sends on its
   * own clock. It used to be a clock time typed into the payload builder
   * ("02:30"), a second answer to what Settings → Data collection edits, which
   * would have gone on saying 02:30 after the operator moved the job. Now it
   * is `scheduleFor(job, saved)`, the one derivation the runner arms from, and
   * the Settings tab links it to where it is changed.
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
  /** Every asset declared as sending no nightly report, as SAVED
   * (config/constants.json `no_nightly_report`), or null while none has ever
   * been declared. The whole list, because the Settings switch writes it back
   * whole and guards the write with exactly what it read (ro-ujb9.96.8). */
  noReportDeclarations?: string[] | null;
}

// ---------------------------------------------------------------------------
// Rules in force (anomaly config)
// ---------------------------------------------------------------------------
/** One anomaly-rule knob: plain-language label + jargon, effective value, a
 * one-line explainer (doc 14 principle 9), and its owner file. */
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
  /** Phase 0 has no per-asset overrides — the portfolio default always applies.
   * `scope` and `hasOverride` ARE that fact; no note restates it as a sentence
   * (bead `ro-ujb9.96.6.3`). */
  scope: "portfolio-default";
  hasOverride: false;
  knobs: KnobFact[];
}

// ---------------------------------------------------------------------------
// Portfolio-wide spend & rate (config/constants.json) — editable, portfolio-wide
// ---------------------------------------------------------------------------
/** One portfolio-wide constant surfaced for editing on every asset page. Each
 * carries the pointer + raw value the Tower needs to stage a changeset op, and a
 * unit so the editor formats/validates it (docs/15 principle 10, made two-way).
 * No explainer: the page owns its label-length unit line and shows the state
 * (bead `ro-ujb9.96.6.3`). */
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
  /** Timeline events on this asset in the 48h BEFORE the condition STARTED
   * (`firstFiredAt`); [] when none.
   *
   * Anchored to the onset rather than to `firedAt` for the same reason the
   * Wall's row is (`ro-kukv.1`): a month-old condition's newest firing is a
   * routine nightly re-evaluation, and searching the two days before THAT
   * reliably finds nothing at all. */
  correlatedChanges: AnnotationItem[];
  disposition: Disposition | null;
  dispositionAt: string | null;
  dispositionNote: string | null;
  snoozeUntil: string | null;
  ackExpiry: string | null;
  resolvedAt: string | null;
  /**
   * What this flag's own source of truth says about it RIGHT NOW (`ro-wlq5`).
   *
   * `resolved_at IS NULL` only ever meant "nobody clicked Resolve", so a
   * surface that renders open rows as current is making a claim the store
   * cannot support. This field is that claim, derived at read time and stated
   * per row rather than assumed for the list.
   */
  liveness: Liveness;
  /** Missing on older payloads: unknown, never confirmed. */
  verification?: SignalVerification;
  /**
   * How many OPEN firings this row stands for — 1 for an ordinary event, and
   * always 1 in `history`, where a row stands for itself (`ro-kukv.5`).
   *
   * The same number the Wall's `AttentionItem.occurrences` carries for the same
   * condition, from the same `groupConditionFirings` call: the two surfaces read
   * different payloads, and a count each derived for itself is a count that
   * drifts.
   */
  occurrences: number;
  /** When this condition FIRST fired. Equals `firedAt` when `occurrences` is 1,
   * and is what the row AGES from — a condition is as old as it has been true,
   * not as old as its most recent re-reading. */
  firstFiredAt: string;
  /**
   * When the OS told the operator about this alert on its notification channel,
   * or null (bead `ro-vu8d.23`).
   *
   * A row in `notifications` (db/0031) means a message ACTUALLY LANDED — the
   * notifier records nothing for a delivery that failed — so this is evidence
   * rather than intent. Null covers three cases that are all "they were not
   * told": the alert did not qualify, the delivery failed, or the table is not
   * applied on this install and the notifier is standing down.
   *
   * Optional because the Wall does not carry it: nobody can act from a
   * television, and D15 gives the fact to the action list.
   */
  notifiedAt?: string | null;
  /** This condition's stored readings, newest first (`flag_evidence`, db/0040,
   * bead `ro-ujb9.220`); absent when it has none or the store predates them. */
  readings?: FlagReading[];
}

export interface FlagsSection {
  /** Unresolved and attention-eligible, ONE ROW PER CONDITION. Includes
   * last-known conditions with unverified evidence. Worst severity first.
   *
   * The grouping is the Wall's, verbatim (`shared/wall`'s
   * `groupConditionFirings`), so a condition that reads "16× in 26d" on the Wall
   * is one row saying the same thing here; and it is the scope `applyFlagAction`
   * re-derives in SQL, so the Mark read / Resolve pair under a row acts on
   * exactly what the row claims to be. */
  open: FlagRecord[];
  /**
   * Open in the store but NOT current: milestones (events, never conditions)
   * and anything whose source of truth no longer carries it.
   *
   * Kept rather than dropped. These rows are real evidence and remain
   * reachable; what they lose is a heading that calls them live and a Resolve
   * button that implies they are actionable.
   */
  notCurrent: FlagRecord[];
  /**
   * Snoozed with time still on the clock, ONE ROW PER CONDITION, soonest back
   * first — the site's share of `/alerts`' Snoozed panel (bead `ro-ujb9.194`).
   * Not settled and not open: each comes back on its `snoozeUntil`.
   */
  snoozed: FlagRecord[];
  /** SETTLED — resolved, or given a decision that does not expire
   * (`flag-open.ts`) — most-recent activity first (last ~20). ONE ROW
   * PER FIRING: this is the audit trail, ordered by when each row was closed,
   * and a group whose members were dispositioned on different days is not one
   * event. Every row here carries `occurrences: 1` by construction. */
  history: FlagRecord[];
  /**
   * Attention-eligible error/warn CONDITIONS, matching the Wall asset card and
   * the actionable rows. Repeated firings stay in each row's `occurrences`,
   * not in these badges. Unverified unresolved conditions remain included;
   * historical events and conditions ended by newer source evidence do not.
   */
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
 *
 * The breakdown travels WITH the figure rather than beside it because the two
 * are the same claim at two resolutions — a family list summed over both booking
 * states, sitting under a reconciled net, is the blended total this split exists
 * to remove, just spelled out per family (bead `ro-jk7`). */
export interface LedgerRollup {
  figure: LedgerFigure;
  revenueByFamily: LedgerFamilyAmount[];
  costByFamily: LedgerFamilyAmount[];
}

/** One accounting month on the asset page, in the SAME two halves the
 * portfolio headline and every asset card state (beads `ro-qes`,
 * `ro-uwo.2`, `ro-jk7`).
 *
 * This period used to carry ONE revenue/cost/net rolled up over every current
 * row regardless of `booking_state`, so the page quoted a booked-P&L number over
 * money nobody had confirmed — the 2026-07 audit's finding 4, one surface further down than
 * the Wall. The two sides are separate fields precisely so nothing can add them:
 * `figureHasMoney` (shared/wall) decides which of them renders, and the stated
 * net is `booked` and only `booked`. */
export interface LedgerPeriod {
  period: string;
  /** RECONCILED current rows for `period` — the figure the page states. */
  booked: LedgerRollup;
  /** ESTIMATED current rows for `period` — reported, not reconciled. Rendered
   * under the hollow notch, below the rule, never inside `booked`. */
  forecast: LedgerRollup;
}

/** A raw CURRENT ledger row — booking_state is visible because estimated-vs-
 * reconciled is an honesty fact the operator must see (doc 00 / doc 02). */
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
// Watch windows (db/0012) — READ-ONLY here
// ---------------------------------------------------------------------------
/** db/0012 watch_windows.outcome — the evaluator's verdict, never the Tower's. */
export type WatchOutcome =
  | "ship_confirmed"
  | "kill_confirmed"
  | "inconclusive"
  | "unmeasurable";

/** One pre-registered outcome check (docs/03): the comparison was chosen before
 * the numbers existed, and the 03:30 cron reads it back out. The Tower only
 * SELECTs — registration lives in the ingest worker's operator API, and the
 * evaluator owns every field that changes after registration. */
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
   * This asset's OWN recent daily values for every measurable series it
   * actually reports, so a registration's threshold can be calibrated from what
   * this asset does when nothing is shipped rather than from the README's
   * example (bead `ro-5e8.2`).
   *
   * The raw series travels rather than a pre-computed number because the floor
   * depends on the window length the operator picks, and the baseline is
   * editable in the composer — a figure derived server-side at 28 days would
   * quietly describe the wrong comparison the moment they widened it.
   * `watchCalibration` (shared/watch-windows.ts) is the one derivation over it.
   *
   * A series this asset has never reported is ABSENT, not an empty history:
   * the composer's fallback sentence turns on "no usable history", and an empty
   * array and a missing entry must not be two ways of saying it.
   */
  history: WatchSeriesHistory[];
}

/** The operator actions the task hub currently attributes to this asset.
 *
 * The two counts are deliberately nullable together. `waitingUrgent` was added
 * when the inbox was narrowed to blocker-aware ready-human work plus open human
 * gates; its presence is therefore the version proof that `waiting` and
 * `items` carry the same meaning the Wall does now. A snapshot from an older
 * long-running poller is UNKNOWN here, never a plausible-looking legacy list.
 */
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
// Link outreach / reclamation pipeline (db/0015) — READ-ONLY here
// ---------------------------------------------------------------------------
/** db/0015 reclamation_targets.status. The first six are the funnel in order;
 * `skip` (never pitch) and `dead` (the broken link is gone from the page) are
 * terminal exits from it, not stages. */
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
// Nightly site-health history (db/0014 hygiene_checks) — READ-ONLY here
// ---------------------------------------------------------------------------
/** The served-layer guards docs/08 §S5 defines, ids verbatim from the
 * `hygiene_checks.check_id` CHECK constraint (db/0014, widened by db/0026). */
export type HygieneCheckId =
  | "html-depth"
  | "robots-ai-access"
  | "sitemap"
  | "page-structure";

/** The four states one night's fetch can record, verbatim from db/0014.
 *
 * `error` and `unreachable` are deliberately apart at rest and stay apart here:
 * "the server told us no" and "we never reached the server" are different facts
 * and only the first is evidence about the asset. Folding them into one
 * "failed" would delete the difference on the only surface that reads them. */
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
   * URLs (sitemap), or pages read (page-structure). **null is "not measured",
   * never zero** — it is every robots-ai-access row and every failed fetch, and
   * reading it as zero is the exact mistake that would turn an outage into a
   * reported collapse.
   *
   * `page-structure` is the one check that stores a REAL zero: "the roster was
   * empty, so nothing was sampled". It is told apart from null by the status
   * beside it, which is `unreachable` rather than `ok` — a check that measured
   * nothing has not found nothing wrong. */
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
 * The nightly site-health history the OS has been collecting since 2026-07-31
 * and nothing read back (bead `ro-gct`).
 *
 * The hygiene guard writes one row per (asset, check, day), and until now the
 * only way any of it reached a human was a rule firing. That is precisely wrong
 * for this family: all three founding cases are SLOW declines nobody noticed —
 * a home page that served 88 words for months, an AI crawler quietly disallowed,
 * a sitemap shrinking week by week. A rule fires on a step change; the history
 * is what shows a slope.
 *
 * `null` on the payload when the asset has no readings at all, which is every
 * asset until the guard's first night: a section with no data and no way to
 * add any is a dead end, not an invitation (the WatchesStrip rule).
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
/** Every provider series this page charts: the three headline trends plus the
 * supporting GA4 volume and Search Console rate series. 90 visible dates each,
 * plus the optional calculation-only pre-roll each SignalTrend carries. The
 * shape is single-sourced with the Wall's loader (shared/wall `SignalTrendSet`)
 * so one query can serve both surfaces without either shape drifting. */
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
   * What this lane states about its own series BEFORE ranking it — today, the
   * `Grounding queries excluded` row both movers lanes carry. Same
   * `{label, value, detail}` shape the cards use, and read the same way:
   *
   * A PRESENT ROW AT ZERO IS THE POINT. The row exists to prove the check ran,
   * so it is emitted even when nothing was excluded ("No quoted-literal queries
   * in this window"). An EMPTY array is the different fact — this lane makes no
   * such statement — and the two must stay distinguishable on the surface, or a
   * lane nobody audited reads exactly like a lane that came back clean.
   *
   * Snapshots written before the field existed carry no `evidence` key at all;
   * the parser normalizes that absence to `[]`, which is honest: a producer
   * that predates the check did not run it.
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
   * Tracked-query SERP panel evidence (`dataforseo/serp-panel`, doc 08 §S1b),
   * ONE READING PER DEVICE (bead `ro-14d.1`): whether the live result page for
   * this exact term carried an AI Overview on that surface, and whether it
   * cited this asset there.
   *
   * An EMPTY LIST means unknown — the query is not on the asset's panel.
   * A reading whose fields are null means the panel covered the term and could
   * not answer (the asynchronous overview never loaded). Neither ever means "no
   * overview". Rules that read this must leave an empty list behaving exactly
   * as it did before the panel existed.
   *
   * Snapshots written before the split carry a flat `aioPresent`/`aioCitesUs`
   * pair instead; the payload parser turns those into a single desktop reading,
   * because desktop is what the collector could only have been reading then.
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
// Product: what people do once they arrive, and where it breaks (PostHog,
// beads ro-ghis.2 / ro-ghis.3)
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
  /** Null when DataForSEO's platform row stated no figure, or the family was
   * never collected (bead `ro-8s5`): unknown, never zero. */
  ai: {
    googleMentions: number | null;
    googleSearchVolume: number | null;
    chatgptMentions: number | null;
    chatgptSearchVolume: number | null;
  };
  /**
   * The NAMES behind the backlink counts (`ro-kukv.2`). `backlinks` above says
   * how many referring domains exist; this says which, so "we lost 12 referring
   * domains" can become a reclamation target instead of a number.
   */
  referringDomains: ReferringDomain[];
  /** The inbound anchor distribution — a risk read and, per docs/08, an
   * AI-visibility input: brand mentions out-predict raw link counts ~3x. */
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
   * `intersections / competitorKeywords`, 0–1 (operator decision 2026-08-31).
   *
   * Raw intersections rank the general web first — YouTube, Facebook, Reddit
   * overlap us on thousands of keywords because they rank for everything, which
   * is true and useless. Share asks how much of THEIR footprint is ours: a
   * focused nutrition site overlapping on 2,000 of its 5,000 keywords is a
   * competitor; YouTube at 3,606 of millions is not. The giants sink on their
   * own, with no denylist to keep true.
   */
  overlapShare: number;
  avgPosition: number;
}

/** Above this, an anchor is spam rather than editorial. DataForSEO scores 0–100
 * and the observed PBN anchors on one asset scored 65 while genuine ones sat
 * at 0–15, so the threshold sits well clear of both. */
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
  /** The cards the eight-card display cut dropped, named rather than discarded:
   * the OS may decide not to *show* a finding, never not to *mention* it
   * (`scripts/signal-insights.mjs`, the honesty rule beside INSIGHT_CARD_LIMIT).
   * Only the identity of each — a suppressed card carries no evidence, and it is
   * a mention, not a row to act on. Snapshots written before the producer
   * emitted the list are normalized to `[]` by the payload parser, which is why
   * an empty array here never means "the cut dropped nothing it could name". */
  suppressedItems: SuppressedInsight[];
  /** Compact query movement derived from the same immutable archives. Older
   * snapshots are normalized to null by the payload parser. */
  searchQueries: SearchQueryTrends | null;
  /** The same comparison at PAGE grain (`ro-427`) — the evidence the page
   * decision table is built on. Null on every snapshot written before the
   * producer emitted it, and on any asset without two complete weeks. */
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
  /** What people do once they arrive, and where it breaks — PostHog's product
   * families (beads ro-ghis.2 / ro-ghis.3). null when no family was collected
   * for this asset; absent on snapshots written before the block existed,
   * which means the same thing. */
  product?: ProductSnapshot | null;
  /** Latest Clarity 72-hour observation; older snapshots normalize to null. */
  clarity?: ClaritySnapshot | null;
  methodology: string[];
}

// ---------------------------------------------------------------------------
// The tracked-query SERP panel (bead `ro-282.3`)
// ---------------------------------------------------------------------------

/** One device's AI-Overview reading of one tracked result page (bead
 * `ro-14d.1`).
 *
 * The panel reads every term on the phone AND the desktop, and a phone result
 * page is not a narrower desktop one: an overview can consume the click on one
 * surface and not the other. So the reading is per device and is never folded
 * into a single verdict at rest — every fold in this file is a named,
 * documented derivation a surface asked for. */
export interface SerpPanelAioReading {
  /** The surface, as the archive recorded it: `mobile` or `desktop` in
   * practice. An unrecognized literal rides through rather than being dropped —
   * the collector's device list is config, not a closed set. */
  device: string;
  aioPresent: boolean | null;
  aioCitesUs: boolean | null;
}

/** The order every device-keyed surface states the devices in. The phone leads
 * because that is where most of this demand searches (the reason `ro-o1n`
 * bought the second device), and the first column is the one that gets read. */
export const SERP_PANEL_DEVICE_ORDER = ["mobile", "desktop"];

/** Device order, with anything unrecognized sorted after both alphabetically. */
export function bySerpPanelDevice(left: string, right: string): number {
  const rank = (device: string) => {
    const index = SERP_PANEL_DEVICE_ORDER.indexOf(device);
    return index === -1 ? SERP_PANEL_DEVICE_ORDER.length : index;
  };
  return rank(left) - rank(right) || left.localeCompare(right);
}

/** The surface as the OPERATOR names it (doc 14: the collection mechanism is
 * never the asset page's vocabulary, and neither is the lane's `mobile`).
 * One implementation, because two surfaces on the same page calling the same
 * device different things is two devices to the reader. */
export function serpPanelDeviceNoun(device: string): string {
  if (device === "mobile") return "Phone";
  if (device === "desktop") return "Desktop";
  return device.charAt(0).toUpperCase() + device.slice(1);
}

/** The three AI-Overview states the ✧ glyph has weights for, plus the fourth
 * that has none: `unknown` draws no mark at all, which is why the
 * checked-and-clear case gets its own ghosted one (doc 14). */
export type AiOverviewGlyphState = "cited" | "uncited" | "absent" | "unknown";

/**
 * One device's reading as the glyph reads it.
 *
 * `null` presence is UNKNOWN and must never harden into `absent` — the overview
 * loads asynchronously and a pull that missed it recorded nothing. A present
 * overview whose citation did not parse reads `uncited`, which is the same call
 * both glyphs already made off the raw booleans: it is the weaker claim, and
 * the strong one ("cites this asset") is the one that must be earned.
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
 * on — a DERIVATION for surfaces that count terms, never a stored fact.
 *
 * ANY SURFACE, not all. An overview that fires on the phone is an overview a
 * real person hit, and a clear desktop page does not give that click back; the
 * fold that required both surfaces to agree would let the quieter one veto the
 * evidence, which is the single-device defect rebuilt with extra steps. False
 * only survives when a device answered and none saw an overview, so the
 * three-state discipline holds: unknown stays unknown, never `false`.
 *
 * For a one-device panel — every collection before 2026-08-04, and every
 * asset that tracks one surface — this returns exactly the pair the row
 * carried before the split.
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

/** One tracked query on one device, as that live result page, in the site's
 * search market, showed it.
 *
 * This is the panel's OWN row set — every query the operator pays to track —
 * not the subset the broad ranked-keywords inventory happens to also carry. The
 * difference is the whole point of a scoreboard: "ranks on 12 of 20" is only
 * true if the 20 is the panel's, and the inventory cannot supply it. Since
 * `ro-14d.1` the 20 is a count of TERMS while this array holds one row per term
 * per device; `serpPanelTerms()` below is the only sanctioned way back, so no
 * denominator on the page can be multiplied by a device split. */
export interface SerpPanelQuery {
  query: string;
  /** The surface this row was read on. A snapshot written before the split
   * carries none, and the parser reads that absence as `desktop` — which it was
   * by construction, since the collector had one device literal in it until
   * 2026-08-04. */
  device: string;
  /**
   * The cluster this query measures — the BET, not the term (bead `ro-282.5`).
   *
   * A panel of twenty terms can be six bets (a calculator seam, an item head, a
   * category head, ...), and "which of them
   * is moving" is the operator's actual question. `null` is normal input in two
   * ways that must both keep working: a panel may label nothing at all, and
   * collections made before labels existed have empty cells because `ro-282.2` chose no
   * backfill.
   *
   * It is the ARCHIVED label, never today's config. A cluster rename applies
   * from the next collection forward and does not relabel history, so nothing
   * that renders this may look it up in config/serp-panel.json.
   */
  label: string | null;
  /**
   * Best organic rank this asset holds on the page, or `null`.
   *
   * `null` means NO RESULT INSIDE THE TRACKED DEPTH — not "does not rank". The
   * panel is a fixed-depth pull of this term on this device (`trackedDepth`,
   * 20 in practice), so
   * rank 24 and rank 900 and genuinely absent are one observation to it, and
   * every one of them is a term worth working. A surface that printed "not
   * ranking" here would invent a fact the collection never bought.
   */
  bestRank: number | null;
  /** The URL holding `bestRank`, null when nothing ranked inside the depth. */
  bestUrl: string | null;
  /**
   * Whether an AI Overview fired on that result page, and whether it cited this
   * asset.
   *
   * `null` is UNKNOWN and never "no": the overview loads asynchronously and a
   * pull that did not catch it recorded nothing. A count that folded unknown
   * into no would report an asset clear of an AI Overview it has never been
   * checked against, which is the one wrong answer that reads as good news.
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

/** What surrounded the asset on one readable tracked result page.
 *
 * This is CURRENT COMPOSITION ONLY. The insight snapshot retains one panel
 * collection, so none of these fields may be read as movement or a takeover;
 * that needs a second retained collection. */
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
   * How deep the pull looked, from the archive's own `tracked_depth`.
   *
   * `null` on a legacy row that never recorded it — unstated, and deliberately
   * NOT defaulted to 20: assuming a depth would silently turn "no rank
   * recorded" into "outside the top 20", which is a claim about a page nobody
   * read that far down. A surface with a null depth says "inside tracked depth"
   * without a number rather than naming one it does not have.
   */
  trackedDepth: number | null;
  /**
   * The search market the site saved, the one the panel is asked in (bead
   * `ro-ujb9.230`). `null` when the site saved none, or on a snapshot written
   * before the block carried it: the caption then names no market rather than
   * a default the site never chose.
   */
  market: SearchMarket | null;
  queries: SerpPanelQuery[];
}

/** The line a human reads first: how the panel is doing, before what each row
 * is (bead `ro-282.3`, the altitude nom's markdown reports opened with).
 *
 * Every field is a COUNT OF QUERIES, and the two AI-Overview denominators are
 * deliberately different from `tracked`: `aioKnown` counts only the rows the
 * panel could answer the question for at all. Dividing by `tracked` instead
 * would spend every unknown as a "no". */
export interface SerpPanelScoreboard {
  /** TERMS on the panel — the denominator for the three rank tiers, and a
   * count of terms rather than of rows, so reading each term on two devices
   * does not double it. */
  tracked: number;
  /** Terms holding any rank inside `trackedDepth`, on any device read. */
  ranking: number;
  top10: number;
  top3: number;
  /** Terms whose AI-Overview presence was actually observed on at least one
   * device (true OR false). Below `tracked` means the rest are unknown, and the
   * surface says so by quoting this as the denominator rather than hiding the
   * gap. A term unknown on BOTH devices is one unknown, not two. */
  aioKnown: number;
  /** Terms whose result page carried an AI Overview on any device read. */
  aioPresent: number;
  /** Terms whose AI Overview cited this asset on any device read. */
  aioCitesUs: number;
}

/**
 * One tracked TERM and every device the panel read it on (bead `ro-14d.1`).
 *
 * The rows arrive one per (term, device); every count and every list on the
 * asset page is about terms. The folded fields exist so the scoreboard and
 * the row summary share ONE derivation — they are never stored, and a surface
 * that wants the split reads `devices` instead.
 */
export interface SerpPanelTerm {
  query: string;
  /** The cluster the term's rows recorded, or null where none did. Its rows
   * agree — the label rides on the query, not the surface — so the first
   * non-null wins and a mid-cutover pair keeps the bet it was placed on. */
  label: string | null;
  /** Its rows, one per device, in `SERP_PANEL_DEVICE_ORDER`. */
  devices: SerpPanelQuery[];
  /** BEST rank across the surfaces the term was read on, null when no device
   * found a result inside the tracked depth. Best, because the question the
   * tiers answer is whether this asset holds the position anywhere the panel
   * looked; a term ranked 3 on the phone is a term ranked 3. */
  bestRank: number | null;
  /** The URL holding `bestRank`, from whichever device holds it. */
  bestUrl: string | null;
  /** `foldSerpPanelAio(devices)` — an overview on ANY surface. */
  aioPresent: boolean | null;
  aioCitesUs: boolean | null;
}

/**
 * The panel's rows grouped back into the terms the operator bought.
 *
 * THE ONLY sanctioned way from rows to terms, because a device split must not
 * multiply a denominator: "ranks on 12 of 20" has to keep meaning twenty terms
 * after the panel starts reading each of them twice, and one unknown term must
 * stay one unknown rather than becoming two. Terms come out in first-seen
 * order — the panel's own config order — so the caller decides the sort.
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
 * The scoreboard, from the panel's own rows.
 *
 * A shared derivation rather than a loop inside the component, for the reason
 * every count on this page is shared: the asset page states these six
 * numbers and the test asserts them, and two implementations of "top 10" is
 * exactly how a surface starts disagreeing with its own evidence.
 *
 * EVERY FIGURE COUNTS TERMS, never rows (`serpPanelTerms`). A panel read on two
 * devices is the same twenty terms, so the split changes what the page can SAY
 * and not one denominator it says it against — and a term nobody could answer
 * the AI question for stays one unknown instead of turning into two.
 *
 * The rank tiers require `bestRank !== null` before comparing, so a query with
 * no result inside the tracked depth is counted in `tracked` and in nothing
 * else — never as a rank-0 or a rank-999.
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
 * The two GA4 declarations this asset owns, as config holds them right now
 * (bead `ro-x5gu.3`) — the rows its Sources tab edits inside the GA4 lane's
 * card.
 *
 * **`null` is not an empty list, and the difference is the whole point of both
 * files.** `null` means the asset has NO entry: nothing is declared, the
 * value-event check stays silent and the js-errors archive skips the asset
 * without a request. `[]` means an entry exists and declares nothing, which
 * behaves the same downstream but is a different write — a first row lands in
 * an existing entry rather than creating one (`CollectionChange` `seed`).
 *
 * They ride here rather than being read in the browser for the reason every
 * config slice does: a browser cannot open a file, and `CollectionEditor` takes
 * its rows from the payload the page already fetches rather than becoming a
 * second reader of one.
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
 * The two tracked-panel registers as they hold THIS asset (bead `ro-x5gu.4`) —
 * what its Growth tab edits under the board that reads the panel back.
 *
 * Same `null`-is-not-`[]` rule as `AssetGa4Config` above, and here the two ends
 * of it are further apart than anywhere else in the config:
 *
 *   - `trackedQueries: null` is an asset that buys **no tracked panel at all** —
 *     `config/serp-panel.README.md` skips an absent asset silently, no call and
 *     no manifest row, and the add-asset wizard deliberately writes nothing
 *     there because a panel is a weekly bill plus a weekly review obligation. It
 *     is also what decides the write: the first term files the asset's whole
 *     entry (`CollectionChange` `seed`) rather than appending.
 *   - `trackedQueries: []` is an entry listing no terms, which that README calls
 *     a **config error** — which is why the register declares `emptyIsAbsent`
 *     and the last term out takes the entry with it (`unseed`). The payload
 *     still reports `[]` honestly if it ever finds one; the surface does not
 *     create one.
 *   - `roster: null` is an **undocumented gap**, because
 *     `config/signal-panels.README.md` makes membership an invariant — every
 *     asset has a row, including the ones that are off.
 *
 * A tracked term is a bare string OR `{query, label}`, in any mix, so the list
 * is `JsonValue[]` rather than `string[]`: repairing it to one shape here would
 * throw away the cluster the panel groups its bets by.
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

/** One failed nightly-report fetch on a site's Data sources tab (bead
 * `ro-ujb9.220`): the stored reading, and whether its alert is still open —
 * this outage's nights, or a past one's. */
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
   * tab edits. Read here rather than fetched separately: the Worker already
   * holds both files, so a second reader would only be a second chance for
   * them to disagree. */
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
   * drawn on its Overview since the Wall's asset card left (bead
   * `ro-trai.21`, docs/14-design.md § What leaves the Wall). Null: the site
   * configures none, and the Overview draws nothing. */
  counters: SiteCounters | null;
  flags: FlagsSection;
  ledger: LedgerSlice;
  dailyRevenue?: DailyRevenueHistory;
  /** The operator's clock the Worker read days in: config/constants.json
   * `os_time_zone` as SAVED, store first (bead `ro-ujb9.88`). The page's own
   * date math uses this, since the browser has no store to read it from. */
  osTimeZone: string;
  /** Every operator decision recorded for this asset (db/0013). An item with
   * no row here is untouched; the client matches rows to queries/findings by
   * `key` alone, so no join travels with them. */
  decisions: AssetDecision[];
  /**
   * The beads filed from this asset's handoffs, as the newest beads snapshot
   * saw them — matched to a query/finding by `key`, exactly like `decisions`.
   *
   * **null is not an empty list.** `[]` means the poller looked at this
   * asset's spoke and nobody has filed anything; `null` means it could not
   * look at all — no snapshot has ever been filed, the asset is not a spoke
   * in `config/beads.json`, `bd` failed for it, or the snapshot predates this
   * field (the poller is a plain node process and only picks the field up when
   * the operator restarts `os:up`). Both render nothing, but only one of them
   * is a measurement, and a card must never turn "we could not ask the
   * register" into "no work was ever filed for this".
   */
  handoffBeads: HandoffBead[] | null;
  /** The asset's exact human-action posture from the same beads photograph
   * that supplied `handoffBeads` and `panelReview`. Tasks remain coordination
   * state, not asset signals; this slice never participates in health or growth
   * derivations. */
  operator: AssetOperatorPosture;
  /** What changed on this asset, newest first, plus a count of any older rows
   * the read did not carry. NOT a bare array: a capped timeline that does not
   * say it is capped reads as the asset's whole history (ro-5e8.1). */
  annotations: AnnotationTimeline;
  /** Pre-registered outcome checks for this asset (db/0012). The strip that
   * renders them stays read-only — a registered comparison is the one thing
   * that must survive learning the answer, and evaluation belongs to the 03:30
   * job — but since bead `ro-71r` the Timeline section can OPEN one, through
   * ingest's `createWatchWindow()` RPC. Both lists are empty when nothing has
   * been registered, and the strip still renders nothing then: the action lives
   * in the section header, so an empty list would only be three lines saying
   * "none yet" on every asset that never opened one. */
  watches: WatchSlice;
  /** This asset's link-outreach pipeline (db/0015), read-only. **null when the
   * table holds no rows for it** — most assets never run a reclamation
   * campaign, and the Tower has no write UI for one, so an empty section would
   * be a dead end rather than an invitation (same rule as the Watches strip). */
  reclamation: ReclamationSlice | null;
  /** The nightly served-layer history (db/0014), read-only. **null until the
   * hygiene guard's first night for this asset** — same rule as the two
   * strips above: nothing collected is nothing to render. */
  hygiene: HygieneHistory | null;
  /** This site's most recent failed nightly-report fetches, newest first: the
   * readings of its `asset-pull-failed` alerts (`noticeos.flag_evidence`, bead
   * `ro-ujb9.220`). [] when none is recorded. */
  fetchFailures: FetchFailure[];
  /** This asset's integration lanes: file-backed scope/setup plus store-derived
   * effective health and evidence. Health is displayed, never manually edited. */
  integrations: AssetIntegrations;
  /** The GA4 lane's two operator declarations, editable on the Sources tab. */
  ga4Config: AssetGa4Config;
  /** This asset's serp-panel review obligation, or null — the SAME two
   * fields the Wall's cards carry, derived by the same functions over the same
   * two reads (bead `ro-elf`).
   *
   * The card is a drill-down TARGET: an overdue badge on the Wall is an
   * instruction to open this page, which until now said nothing whatsoever
   * about the panel review. So the one surface you would go to in order to do
   * the triage was the one surface that did not mention it.
   *
   * Same three absences collapse to null as on the card (no collection landed
   * inside the window, nothing filed yet, a snapshot predating the field), and
   * the page's answer to all three is the same nothing. An asset with no
   * `config/serp-panel.json` entry is not an absence — it owes the same read and
   * states it in its own noun (`panelReviewNouns`, bead `ro-z0g`). */
  panelReview: PanelReview | null;
  /** The newest panel DAY collected for this asset ('YYYY-MM-DD') — the day
   * a finished review has to be about for it to still count. */
  latestPanelDate: string | null;
  freshness: FreshnessLanes;
}

// ---------------------------------------------------------------------------
// Page-grain decisions (`ro-427`)
// ---------------------------------------------------------------------------

/** The page's largest query by impressions in the current window, off the
 * grounding-decontaminated page/query series — what Google is showing this page
 * FOR, which is not the same question as what it earns clicks on.
 *
 * `aioDevices` follows `DataForSeoQueryVisibilityRow.aioDevices` exactly: one
 * reading per device, an EMPTY list meaning the term is not on this asset's
 * panel (unknown), and a reading whose fields are null meaning the panel covered
 * it and could not answer. Neither ever means "no overview". */
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
  /** What this lane states about its own series before ranking it — read
   * exactly like `SearchQueryProviderTrend.evidence`, including the rule that a
   * present row at zero proves the check ran. The one row here is labelled for
   * the LEADING-QUERY JOIN rather than for the totals, because a page row
   * carries no query to classify and the totals therefore cannot be
   * decontaminated. */
  evidence: ExecutiveEvidence[];
  source: string;
  caveat: string;
}
