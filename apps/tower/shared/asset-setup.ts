import { expectsNightlyReport } from "@noticeos/contract/reporting";
import { NIGHTLY_REPORT_LANE_ID } from "./integrations";
import { isUnusedSource, type SourceKind, type SourceReading } from "./connection-status";

/**
 * Shared setup progress derived from incomplete data-collection checks. Connecting
 * the sources, historical report arrival and observed report coverage are
 * separate steps; none of them proves that a connection is currently working.
 *
 * Everything is derived from existing payload facts and, for the sources, the
 * one status model every other screen reads (`sourceReadings`). The Sources
 * checklist and its summary callers share this calculation; there is no stored
 * checklist or operator-tickable completion state.
 */

/** The checklist's coverage window, not an alert eligibility threshold. Each
 * rule evaluates its own metric history and volume prerequisites. */
export const SETUP_BASELINE_DAYS = 28;

export type SetupItemId = "identity" | "sources" | "first-report" | "baseline" | "pause-check";

/** Resolved, still owed, or offered. The ring counts `done` of `done` +
 * `pending`; an `optional` step — something the site can set up but nobody
 * owes — is listed and never counted. `unavailable` is a capability not
 * implemented, not an offered action or a setup obligation. */
export type SetupItemState = "done" | "pending" | "optional" | "unavailable";

export interface SetupChecklistItem {
  id: SetupItemId;
  /** The operator's words. */
  label: string;
  state: SetupItemState;
  /** The setup or historical-report fact behind this step, not a current
   * connection-health verdict. */
  note: string;
  /** Where to inspect or complete the item, as a Tower path. */
  href: string | null;
  /** A countable sub-progress where the item has one (sources: sources settled
   * of applicable; baseline: report dates covered out of 28). null where the
   * item is a plain boolean. */
  progress: { done: number; total: number } | null;
}

export interface SetupChecklist {
  /** Fixed order — the order flow A does the work in. */
  items: SetupChecklistItem[];
  done: number;
  total: number;
  /** Incomplete setup steps, in item order. [] means these checks are complete,
   * not that current health or launch readiness has been verified. */
  remaining: string[];
  /** Shared summary text for checklist progress. */
  title: string;
}

/** Setup facts available from the wall and asset-detail payloads. */
export interface SetupChecklistFacts {
  id: string;
  displayName: string;
  /** `assets.status` as the store holds it (a bare string on the wall payload). */
  status: string;
  /** The fixed source inventory as the status model reads it
   * (`sourceReadings` over `AssetCard.dataSources` on the wall payload or
   * `integrations.sources` on the asset payload — one type, built by one
   * worker helper). */
  sources: readonly Pick<SourceReading, "id" | "kind">[];
  /** received_at of the FIRST nightly report ever accepted for this asset;
   * null when none has arrived. This is an arrival date, not coverage. */
  firstReportAt: string | null;
  /** Distinct report dates in the last 28 completed UTC days. Missing on an
   * older payload means unknown, never elapsed days or an assumed zero. */
  reportDays?: number | null;
  /** received_at of the LATEST nightly report; null when none has arrived. */
  latestReportAt: string | null;
  /** The operator declared this asset sends no nightly report. With
   * `latestReportAt` it decides whether the report is expected
   * (`expectsNightlyReport`). */
  noNightlyReport?: boolean;
  nowMs: number;
}

const MS_PER_DAY = 86_400_000;

/** Whole days from an instant to now, floored at 0. A clock skew that puts the
 * first report in the future reads as day zero rather than as a negative
 * baseline. */
export function daysSince(iso: string, nowMs: number): number {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((nowMs - then) / MS_PER_DAY));
}

/** Archived sites stay hidden until restored. */
export function isRetired(status: string): boolean {
  return status === "retired";
}

/** A connection settles setup regardless of current health. An unanswered
 * monitoring read cannot prove that setup is complete. */
function isSettled(kind: SourceKind): boolean {
  return kind !== "unknown";
}

function pluralDays(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/**
 * The checklist for one monitored asset, or null when its checks are complete.
 *
 * Launch holds and retired sites have no collection setup obligation. Current
 * data and source facts determine completion, regardless of an old stage.
 */
export function assetSetupChecklist(
  facts: SetupChecklistFacts,
): SetupChecklist | null {
  if (isRetired(facts.status) || facts.status === "pre-launch") return null;

  // The first report and report coverage are the nightly obligation, and only
  // a site that expects a report owes them. One that has never sent one is
  // offered the report — listed, never counted; one declared as sending none
  // is not offered it at all.
  const declared = facts.noNightlyReport === true;
  const nightly: SetupChecklistItem[] = expectsNightlyReport(declared, facts.latestReportAt)
    ? [firstReportItem(facts), baselineItem(facts)]
    : declared
      ? []
      : [nightlyReportOffer(facts)];
  const items: SetupChecklistItem[] = [identityItem(facts), sourcesItem(facts), ...nightly, {
    id: "pause-check",
    label: "Pause check",
    state: "unavailable",
    note: "Unavailable · Agent execution is manual.",
    href: null,
    progress: null,
  }];

  const counted = items.filter((item) => item.state === "done" || item.state === "pending");
  const done = counted.filter((item) => item.state === "done").length;
  const remaining = counted
    .filter((item) => item.state === "pending")
    .map((item) => item.label);

  if (remaining.length === 0) return null;

  return {
    items,
    done,
    total: counted.length,
    remaining,
    title:
      remaining.length === 0
        ? `Setup ${done} of ${counted.length} — all done`
        : `Setup ${done} of ${counted.length} — still to do: ${remaining.join(", ")}`,
  };
}

/**
 * Item 1 — identity. Done when the asset carries a name of its own rather
 * than echoing its id. A row seeded by hand can lack one, so the item is
 * falsifiable; on the normal path it is the tick that makes the ring start at
 * one quarter instead of empty.
 */
function identityItem(facts: SetupChecklistFacts): SetupChecklistItem {
  const name = facts.displayName.trim();
  const named = name.length > 0 && name !== facts.id;
  return {
    id: "identity",
    label: "Identity",
    state: named ? "done" : "pending",
    note: named ? `Recorded as ${name} · ${facts.id}` : `No name · shows as ${facts.id}`,
    href: `/assets/${encodeURIComponent(facts.id)}/settings`,
    progress: null,
  };
}

/**
 * Unconnected, unused and inapplicable catalog entries are not setup
 * obligations. Unknown connection evidence remains unresolved. The nightly
 * report has its own arrival item.
 */
function sourcesItem(facts: SetupChecklistFacts): SetupChecklistItem {
  const kinds = facts.sources
    .filter((source) => source.id !== NIGHTLY_REPORT_LANE_ID)
    .map((source) => source.kind)
    .filter((kind) => !isUnusedSource(kind));
  const settled = kinds.filter(isSettled).length;
  const unknown = kinds.length - settled;
  return {
    id: "sources",
    label: "Data sources",
    state: kinds.length === 0 ? "optional" : unknown === 0 ? "done" : "pending",
    note: kinds.length === 0
      ? "No data sources connected."
      : `${settled} connected${unknown > 0 ? ` · ${unknown} unknown` : ""}`,
    href: `/assets/${encodeURIComponent(facts.id)}/sources`,
    progress: kinds.length === 0 ? null : { done: settled, total: kinds.length },
  };
}

/**
 * Item 3 — the first nightly report, listed once one has arrived: that
 * arrival is what makes the site expect its report
 * (`expectsNightlyReport`), so the step is done by then, and the freshness
 * alert owns any later stopping.
 */
function firstReportItem(facts: SetupChecklistFacts): SetupChecklistItem {
  return {
    id: "first-report",
    label: "First nightly report",
    state: "done",
    note: facts.firstReportAt
      ? `First report arrived ${pluralDays(daysSince(facts.firstReportAt, facts.nowMs))} ago.`
      : "A nightly report has arrived.",
    href: "/health",
    progress: null,
  };
}

/**
 * Item 3, before any report — the nightly report as an offer. A site that
 * has never sent one expects none, so the step is optional: never counted,
 * never "to do". It links to the site's Data collection card.
 */
function nightlyReportOffer(facts: SetupChecklistFacts): SetupChecklistItem {
  return {
    id: "first-report",
    label: "Nightly report",
    state: "optional",
    note: "Optional",
    href: `/assets/${encodeURIComponent(facts.id)}/settings#data-collection`,
    progress: null,
  };
}

/** Recent coverage is measured from distinct stored report dates. Elapsed
 * time cannot prove that reports arrived, and coverage alone does not arm a
 * rule. The note is the count the step is waiting on, or "Unknown" where the
 * payload does not carry it. */
function baselineItem(facts: SetupChecklistFacts): SetupChecklistItem {
  const observed = facts.reportDays;
  const count = typeof observed === "number" && Number.isInteger(observed)
    && observed >= 0 && observed <= SETUP_BASELINE_DAYS ? observed : null;
  const complete = count === SETUP_BASELINE_DAYS;
  return {
    id: "baseline",
    label: `${SETUP_BASELINE_DAYS} days of reports`,
    state: complete ? "done" : "pending",
    note: count === null ? "Unknown" : `${count} of ${SETUP_BASELINE_DAYS} days`,
    href: "/health",
    progress: count === null ? null : { done: count, total: SETUP_BASELINE_DAYS },
  };
}
