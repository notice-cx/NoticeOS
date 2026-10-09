// Alert language — the one place a stored alert becomes a sentence an operator
// can act on.
//
// The STORE stays factual. workers/ingest writes each flag with the rule's own
// evidence: `message` is "22 in last24h (avg7d 39.3, P(<=22)~=0.0020)" and
// `rule_inputs` is the exact numbers the rule saw. That pair is the audit trail
// — it is never rewritten, and this module never asks it to be. Translation is a
// READ-side concern, so it happens here, over facts the flag row already carries.
//
// The anatomy of an operator-facing alert (doc 14 principle 9):
//
//   1. WHAT HAPPENED — `headline`. Plain language, magnitude included:
//      "Signups well below normal — 22 vs ~39/day". Never the raw statistics.
//      And never a DIRECTION the reader has to decode: on a series where up is
//      bad the headline says improved/worsened, not up/down (`movementPhrase`).
//   2. HOW SURE — deliberately absent from the prose. The severity dot beside
//      the line already carries that, and doc 14's one-representation rule says
//      one fact gets one rendering. A line that also said "warning" would be
//      saying it twice.
//   3. WHAT NOW — `hint`, a rule-specific next step, plus (rendered separately)
//      any recent change that correlates with the alert. A metric drop sitting
//      next to "deploy a1b2c3d, 14h before" is the actual insight.
//
// The statistics do not disappear — they become `evidence`, which the surfaces
// hang behind the existing EvidencePopover glyph. That is what the skeptical
// operator opens, not what everyone else has to read first.
//
// Pure and dependency-light on purpose: the payloads stay data, the components
// stay dumb, and every phrase below is unit-tested directly.

import { WATCH_SERIES } from "@noticeos/contract/create-watch-window";
import { ageMs, formatAge } from "./freshness";
import type { AnnotationItem, AnnotationKind } from "./annotations";
import { siteNoun } from "./site-noun";

/** How far BEFORE an alert fired a change still counts as correlated. Two nights
 * — wide enough to catch the deploy that shipped the evening before the report
 * that tripped the rule, narrow enough that it stays a coincidence worth naming
 * rather than a list of everything that ever happened. */
export const CORRELATION_WINDOW_HOURS = 48;

/**
 * One line of "why this fired", shaped exactly like the integrations register's
 * evidence so the ONE EvidencePopover renders both (doc 14: no rival component).
 *
 * Alert evidence is always `supporting`: it is the arithmetic behind a flag that
 * already fired, not a reading that argues with a declared state. That keeps the
 * glyph the popover's neutral info mark — an amber warning glyph next to the
 * severity dot would be severity rendered twice.
 */
export interface AlertEvidence {
  polarity: "against" | "supporting";
  source: string;
  detail: string;
  at: string | null;
}

/** The rendered alert: a sentence, an optional next step, and the numbers. */
export interface AlertLanguage {
  /** WHAT HAPPENED, with magnitude. Never blank — falls back to the raw message. */
  headline: string;
  /** WHAT NOW, when the rule has something specific to say. Absent is normal:
   * inventing "check your funnel" for every drop is noise, not an insight. */
  hint?: string;
  /** The statistics, for the popover. Empty when the rule keeps none. */
  evidence: AlertEvidence[];
}

/**
 * One stored reading of an open condition: what the rule said at one run,
 * before a later run refreshed the flag (`flag_evidence`, db/0040, bead
 * `ro-ujb9.220`). The flag row is the condition's current summary; these are
 * the nights behind it.
 */
export interface FlagReading {
  /** When the reading was taken, ISO UTC. */
  at: string;
  message: string | null;
  /** `rule_inputs` as they stood at this reading, parsed; null if unreadable. */
  ruleInputs: Record<string, unknown> | null;
}

/** How many of an alert's readings its Evidence lists, and how many failed
 * fetches a site's Data sources tab lists: a week of nightly runs. */
export const READINGS_SHOWN = 7;

/** Everything the translator reads — every field is already on the flags row,
 * except `readings`, which a surface reads beside it. */
export interface AlertFacts {
  ruleId: string;
  /** `rule_inputs`, parsed server-side (the column is TEXT). null when absent
   * or unparseable, which degrades to the raw message rather than to a blank. */
  ruleInputs: Record<string, unknown> | null;
  metric: string | null;
  /** The rule's own stored words — the fallback for any rule not known here. */
  message: string | null;
  /** The other assets a CROSS-ASSET row stands for (`ro-kukv.6`). Absent on an
   * ordinary alert and on a group of one, which is what keeps the single-asset
   * sentence exactly what it was. When present the headline states the fact
   * once, in the plural, rather than once per asset. */
  members?: readonly { assetDisplayName: string }[];
  /** The condition's stored readings, newest first — absent where the surface
   * did not read them, and empty on a store without db/0040. */
  readings?: readonly FlagReading[];
}

// --- small formatting helpers ----------------------------------------------

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** "plansSaved" → "plans saved", "ledgerRows" → "ledger rows". Envelope metric
 * names are the asset's own identifiers; an operator reads words. */
export function humanizeMetric(metric: string): string {
  return metric
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The metric as a sentence subject: "Plans saved". */
function metricName(metric: string | null): string {
  const words = metric ? humanizeMetric(metric) : "";
  return words ? sentenceCase(words) : "This metric";
}

function count(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

const SMALL_NUMBERS = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
] as const;

/**
 * A count at the START of a sentence: "Four assets have never reported".
 *
 * Spelled to nine and digits after, which is the ordinary editorial rule and
 * the one that matters here: a headline is prose, and "4 assets have never
 * reported" reads like a metric that belongs in a tile. Past nine the word gets
 * longer than the number and the digit wins.
 *
 * NOT a general number formatter — `count()` stays the one for magnitudes
 * inside a sentence, where a spelled-out figure would be the wrong register.
 */
export function spellCount(n: number): string {
  const rounded = Math.round(n);
  return rounded >= 0 && rounded < SMALL_NUMBERS.length
    ? SMALL_NUMBERS[rounded]!
    : count(rounded);
}

/** A baseline rounded to what an operator would say out loud: 39.28 → "39",
 * 6.5 → "7", 0.43 → "0.4" (never "0", which would read as "nothing normally"). */
function approx(n: number): string {
  return Math.abs(n) >= 1 ? String(Math.round(n)) : String(Number(n.toFixed(1)));
}

/** A per-day baseline: "~39/day". */
function rate(n: number): string {
  return `~${approx(n)}/day`;
}

/** A probability as a percentage an operator can weigh: 0.00196 → "0.2%". */
function percent(p: number): string {
  const pct = p * 100;
  if (pct >= 1) return `${Math.round(pct)}%`;
  if (pct >= 0.1) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

/** A rule window in the unit it was configured in: 72 → "3 days", 36 → "36h". */
function windowLabel(hours: number): string {
  if (hours % 24 !== 0) return `${hours}h`;
  const days = hours / 24;
  return days === 1 ? "1 day" : `${days} days`;
}

/** The same window used as an adjective: "a 3-day window", "a 36h window". */
function windowAdjective(hours: number): string {
  return hours % 24 === 0 ? `${hours / 24}-day` : `${hours}h`;
}

/** What a zero on this metric most likely means. A zero is not just a big drop —
 * it usually means something stopped, so the hint names the thing to go look at.
 * Keyed by metric because the OS's own bookkeeping metric fails differently from
 * an asset's user-facing flow: no ledger rows is a stalled lane, not lost users. */
const ZERO_HINT_BY_METRIC: Record<string, string> = {
  ledgerRows: "the bookkeeping import looks stalled",
};

function zeroHint(metric: string | null): string {
  return (metric ? ZERO_HINT_BY_METRIC[metric] : undefined) ?? "flow may be broken";
}

/** The last resort: the rule's own stored words, never a blank line. */
function rawFallback(facts: AlertFacts): string {
  const msg = facts.message?.trim();
  if (!msg) return facts.metric ? `${metricName(facts.metric)} alert` : "Alert fired";
  return facts.metric ? `${metricName(facts.metric)} — ${msg}` : msg;
}

// --- the rules --------------------------------------------------------------

/**
 * EVIDENCE IS LABEL AND VALUE, NEVER A SENTENCE (bead `ro-ujb9.96.6.7`).
 *
 * Every row below is a short name for the figure and the figure itself —
 * "Arrived · 22 in 24h", "Chance if nothing changed · 0.2%" — the shape
 * Datadog's evaluation graph and Sentry's issue header use for the numbers
 * behind an alert. The prose each row used to carry ("About a 0.2% chance of
 * coming in this low if nothing had changed (Poisson lower tail)") restated its
 * own label; the method names are the rule's, and the rule id heads the panel.
 */
function flowEvidence(
  observedLabel: string,
  observed: number | null,
  baselinePerDay: number | null,
  pLowerTail: number | null,
  alpha: number | null,
  baseline?: { source: string; detail: string },
): AlertEvidence[] {
  const evidence: AlertEvidence[] = [];
  if (observed !== null) {
    evidence.push({
      polarity: "supporting",
      source: "Arrived",
      detail: `${count(observed)} ${observedLabel}`,
      at: null,
    });
  }
  if (baselinePerDay !== null) {
    evidence.push({
      polarity: "supporting",
      source: baseline?.source ?? "Normal · 7-day average",
      detail: baseline?.detail ?? `${baselinePerDay.toFixed(1)}/day`,
      at: null,
    });
  }
  if (pLowerTail !== null) {
    evidence.push({
      polarity: "supporting",
      source: "Chance if nothing changed",
      detail: alpha !== null
        ? `${percent(pLowerTail)} · fires below ${percent(alpha)}`
        : percent(pLowerTail),
      at: null,
    });
  }
  return evidence;
}

/** The same-weekday baseline as one evidence row: the rate, and the four dates
 * it was averaged over when the rule recorded them. */
function weekdayBaseline(
  baselinePerDay: number,
  dates: readonly string[],
  window?: string,
): { source: string; detail: string } {
  const over = window ? `4 prior ${window} windows` : dates.length > 0 ? dates.join(", ") : "4 prior weeks";
  return {
    source: "Normal · same weekday",
    detail: `${baselinePerDay.toFixed(1)}/day · ${over}`,
  };
}

/** `flow-poisson-low` — the single-day drop at healthy volume. */
function poissonLow(facts: AlertFacts): AlertLanguage {
  const i = facts.ruleInputs ?? {};
  const metric = str(i.metric) ?? facts.metric;
  const observed = num(i.observed);
  const baseline = num(i.baselinePerDay);
  const comparisonDates = Array.isArray(i.baselineComparisonDates)
    ? i.baselineComparisonDates.filter((value): value is string => typeof value === "string")
    : [];
  const seasonal =
    str(i.baselineSource) === "same-weekday-4w" && baseline !== null
      ? weekdayBaseline(baseline, comparisonDates)
      : undefined;
  const evidence = flowEvidence(
    "in 24h",
    observed,
    baseline,
    num(i.pLowerTail),
    num(i.alpha),
    seasonal,
  );

  if (observed === null || baseline === null) return { headline: rawFallback(facts), evidence };
  if (observed === 0) {
    return {
      headline: `${metricName(metric)} hit zero — normally ${rate(baseline)}`,
      hint: zeroHint(metric),
      evidence,
    };
  }
  return {
    headline: `${metricName(metric)} well below normal — ${count(observed)} vs ${rate(baseline)}`,
    evidence,
  };
}

/** `flow-lowvol-window` — the multi-day window the rule widens to when daily
 * volume is too thin for a single day to mean anything. */
function lowVolumeWindow(facts: AlertFacts): AlertLanguage {
  const i = facts.ruleInputs ?? {};
  const metric = str(i.metric) ?? facts.metric;
  const observed = num(i.windowObserved);
  const baseline = num(i.baselinePerDay);
  const lambda = num(i.lambda);
  const hours = num(i.windowHours) ?? 72;
  const window = windowLabel(hours);
  const baselineHours = num(i.baselineWindowHours) ?? hours;
  const seasonal =
    str(i.baselineSource) === "same-weekday-4w" && baseline !== null
      ? weekdayBaseline(baseline, [], windowAdjective(baselineHours))
      : undefined;

  const evidence = flowEvidence(
    `in ${window}`,
    observed,
    baseline,
    num(i.pLowerTail),
    num(i.alpha),
    seasonal,
  );
  // Low volume is why the rule reads a whole window rather than one day, and
  // the expected count across that window is the figure the chance is taken
  // against — so it is its own row, stated as the number it is.
  if (baseline !== null && lambda !== null) {
    evidence.push({
      polarity: "supporting",
      source: `Expected in ${windowAdjective(hours)} window`,
      detail: `~${approx(lambda)} · low volume, days pooled`,
      at: null,
    });
  }

  if (observed === null || baseline === null) return { headline: rawFallback(facts), evidence };
  if (observed === 0) {
    return {
      headline: `${metricName(metric)} hit zero — none in ${window}, normally ${rate(baseline)}`,
      hint: zeroHint(metric),
      evidence,
    };
  }
  return {
    headline: `${metricName(metric)} well below normal — ${count(observed)} in ${window}, normally ${rate(baseline)}`,
    evidence,
  };
}

/** `flow-pct-drop` — the percentage tripwire, gated on absolute volume. */
function percentDrop(facts: AlertFacts): AlertLanguage {
  const i = facts.ruleInputs ?? {};
  const metric = str(i.metric) ?? facts.metric;
  const observed = num(i.observed);
  const baseline = num(i.baselinePerDay);
  const dropFraction = num(i.dropFraction);
  const minDropFraction = num(i.minDropFraction);

  const evidence = flowEvidence("in 24h", observed, baseline, null, null);
  if (dropFraction !== null) {
    evidence.push({
      polarity: "supporting",
      source: "Drop",
      detail: minDropFraction !== null
        ? `${percent(dropFraction)} · fires at ${percent(minDropFraction)}+`
        : percent(dropFraction),
      at: null,
    });
  }

  if (observed === null || baseline === null || dropFraction === null) {
    return { headline: rawFallback(facts), evidence };
  }
  if (observed === 0) {
    return {
      headline: `${metricName(metric)} hit zero — normally ${rate(baseline)}`,
      hint: zeroHint(metric),
      evidence,
    };
  }
  return {
    headline: `${metricName(metric)} down ${percent(dropFraction)} — ${count(observed)} vs ${rate(baseline)}`,
    evidence,
  };
}

/** `ingest-freshness` — the nightly report never arrived (docs/17: pulse → "nightly report").
 *
 * Two failures share this rule and must not share a sentence (docs/19 finding
 * 5): an asset that reported and went quiet has a lane that BROKE, while one
 * that has never reported has a lane that was never WIRED. Same severity, two
 * different next actions, so the headline states which. */
function ingestFreshness(facts: AlertFacts): AlertLanguage {
  const i = facts.ruleInputs ?? {};
  const ageHours = num(i.ageHours);
  const thresholdHours = num(i.thresholdHours);
  const lastReceivedAt = str(i.lastReceivedAt);
  const registeredAt = str(i.registeredAt);
  const neverReported = str(i.state) === "never-reported";
  /** More than one asset behind this row (`ro-kukv.6`). The sentence then has a
   * PLURAL subject and the per-asset evidence below has to stand down: a
   * registration date belongs to one asset, and printing the representative's
   * would quietly attribute it to four. */
  const group = facts.members && facts.members.length > 1 ? facts.members : null;
  /** Hours of this silence the OS's own connection was provably down (ro-6le).
   * The write side already subtracted them before deciding to fire, so a flag
   * carrying this survived the discount — the field exists so the operator
   * reads the exculpation, not so the surface re-litigates the decision. */
  const osDarkHours = num(i.osDarkHours);

  const evidence: AlertEvidence[] = [];
  if (lastReceivedAt) {
    // The row's own age says when; there is nothing to add in words.
    evidence.push({
      polarity: "supporting",
      source: "Last report accepted",
      detail: "",
      at: lastReceivedAt,
    });
  }
  if (osDarkHours !== null && osDarkHours > 0 && ageHours !== null) {
    // The first genuinely exculpatory input this rule has carried, so it is the
    // one "against" row in the family: evidence that argues with the flag it
    // hangs on, placed right after the last-accepted fact so the operator reads
    // the mitigation before the threshold arithmetic. The amber glyph it gives
    // the whole panel is what says "partly not the asset's fault" at a glance.
    evidence.push({
      polarity: "against",
      source: "OS offline, not counted",
      detail: `${Math.round(osDarkHours)}h of ${Math.round(ageHours)}h · ${Math.round(ageHours - osDarkHours)}h unexplained`,
      at: null,
    });
  }
  if (group) {
    evidence.push({
      polarity: "supporting",
      source: "Sites with no nightly reports",
      detail: group.map((member) => member.assetDisplayName).join(", "),
      at: null,
    });
  } else if (neverReported && registeredAt) {
    evidence.push({
      polarity: "supporting",
      source: "Registered, never reported",
      detail: "",
      at: registeredAt,
    });
  }
  if (thresholdHours !== null) {
    evidence.push({
      polarity: "supporting",
      source: "Fires after",
      detail: `${thresholdHours}h without a report`,
      at: null,
    });
  }

  if (neverReported) {
    // ONE SENTENCE FOR ONE FACT (D15). Four assets that have never reported are
    // not four things to read; they are one thing about four assets, and the
    // count belongs in the sentence rather than in a recurrence chip beside it
    // — a chip there would be counting assets in the shape the band uses to
    // count re-firings.
    if (group) {
      return {
        headline: `${spellCount(group.length)} sites have no nightly reports`,
        hint: "their nightly reporting may never have been wired up",
        evidence,
      };
    }
    return {
      headline: "No nightly report has EVER arrived",
      hint: "reporting may never have been wired up",
      evidence,
    };
  }
  if (ageHours === null) return { headline: rawFallback(facts), evidence };
  // The headline's age stays the raw age even when dark hours are credited: the
  // age is the age, and a number that disagreed with the store would cost more
  // than the mitigation buys. The evidence carries the discount, as its one
  // "against" row — the hint stays the next step, not the arithmetic.
  return {
    headline: `No nightly report in ${Math.round(ageHours)}h`,
    hint: "reporting may have stopped",
    evidence,
  };
}

/** What a failing pull most likely needs from the operator, read off the status
 * the provider actually returned — the difference between a dead token and a
 * moved URL is the whole of "what now". */
function pullFailureHint(status: number | null): string | undefined {
  if (status === null) return "the endpoint may be unreachable";
  if (status === 401 || status === 403) return "the fetch credentials may have expired";
  if (status === 404) return "the fetch URL may have moved";
  if (status === 429) return "the site is rate-limiting the fetch";
  if (status >= 500) return "the site's endpoint is erroring";
  return undefined;
}

/**
 * A failed fetch's cause in a few words: the provider's own error name beats
 * our rendered string ("401 unauthorized"), else that string, else the status.
 * The one derivation for the alert's headline and a site's list of failed
 * fetches, so the two cannot name one night two ways.
 */
export function pullFailureCause(inputs: Record<string, unknown> | null): string | null {
  const i = inputs ?? {};
  const status = num(i.status);
  const providerError = str(i.providerError);
  const error = str(i.error);
  return status !== null && providerError
    ? `${status} ${providerError}`
    : (providerError ?? error ?? (status !== null ? `HTTP ${status}` : null));
}

/** `asset-pull-failed` — the OS could not fetch the asset's report. The
 * inputs are rewritten on every failed night, so they carry how long it has been
 * going and what the latest cause was (the row's fired_at still dates the first).
 * Each night's own response is a stored reading (bead `ro-ujb9.220`): when the
 * surface read them, the evidence lists them, newest first. */
function pullFailed(facts: AlertFacts): AlertLanguage {
  const i = facts.ruleInputs ?? {};
  const status = num(i.status);
  const error = str(i.error);
  const url = str(i.url);
  const failureCount = num(i.failureCount) ?? 1;
  const lastFailedAt = str(i.lastFailedAt);

  // The provider's own error name beats our rendered string in a headline; the
  // full rendering (with the provider's sentence) stays in the evidence.
  const cause = pullFailureCause(facts.ruleInputs);

  const evidence: AlertEvidence[] = [];
  const readings = facts.readings ?? [];
  if (readings.length > 0) {
    // One row per failed night in the response's own words. The newest IS the
    // latest response, so that row is not repeated.
    for (const reading of readings.slice(0, READINGS_SHOWN)) {
      evidence.push({
        polarity: "supporting",
        source: "Failed fetch",
        detail: str(reading.ruleInputs?.error) ?? pullFailureCause(reading.ruleInputs) ?? reading.message ?? "",
        at: reading.at,
      });
    }
  } else if (error) {
    evidence.push({
      polarity: "supporting",
      source: "Latest response",
      detail: error,
      at: lastFailedAt,
    });
  }
  if (failureCount > 1) {
    evidence.push({
      polarity: "supporting",
      source: "Failed fetches",
      detail: `${failureCount} since the first`,
      at: null,
    });
  }
  if (url) {
    evidence.push({
      polarity: "supporting",
      source: "Endpoint",
      detail: url,
      at: null,
    });
  }

  if (!cause) return { headline: rawFallback(facts), evidence };
  const headline =
    failureCount > 1
      ? `Nightly report fetch failing ${failureCount} nights — latest: ${cause}`
      : `Nightly report fetch failed — ${cause}`;
  return { headline, hint: pullFailureHint(status), evidence };
}

/** A legacy spoke-level detector signature one site still emits. It reaches the
 * central store as an asset-declared message rather than the structured OS flow
 * rule, so the read side recognizes exactly this bounded grammar and moves its
 * arithmetic into evidence. Anything else remains the asset's own words. */
const DECLARED_POISSON_24H =
  /^last24h\s+([0-9]+(?:\.[0-9]+)?)\s+vs\s+avg7d\s+([0-9]+(?:\.[0-9]+)?)\s+\(rule\s+poisson-24h,\s*P<=([0-9.eE+-]+)\)$/i;

function declaredProbability(p: number): string {
  const pct = p * 100;
  return pct > 0 && pct < 0.01 ? "less than 0.01%" : percent(p);
}

/** `asset-declared` — usually the asset's own human sentence. The one known
 * exception is the legacy poisson signature above: making every operator read
 * storage vocabulary because one spoke has not migrated would put the archive
 * contract ahead of the decision surface. */
function assetDeclared(facts: AlertFacts): AlertLanguage {
  const inputs = facts.ruleInputs ?? {};
  const msg = str(inputs.msg)?.trim() ?? facts.message?.trim();
  const match = msg?.match(DECLARED_POISSON_24H);
  if (match) {
    const observed = Number(match[1]);
    const baseline = Number(match[2]);
    const probability = Number(match[3]);
    const metric = str(inputs.metric) ?? facts.metric;
    if (
      Number.isFinite(observed) &&
      Number.isFinite(baseline) &&
      Number.isFinite(probability) &&
      observed >= 0 &&
      baseline >= 0 &&
      probability >= 0
    ) {
      return {
        headline: `${metricName(metric)} well below normal — ${count(observed)} vs ${rate(baseline)}`,
        evidence: [
          {
            polarity: "supporting",
            source: "Arrived",
            detail: `${count(observed)} in 24h`,
            at: null,
          },
          {
            polarity: "supporting",
            source: "Normal · site's 7-day average",
            detail: `${baseline.toFixed(1)}/day`,
            at: null,
          },
          {
            polarity: "supporting",
            source: "Site's own rule · poisson-24h",
            detail: `P≤${match[3]} (${declaredProbability(probability)})`,
            at: null,
          },
        ],
      };
    }
  }
  // Nothing to show but provenance: the asset raised this itself and attached
  // no statistics the OS recognises. Said as a label and a value, like the rest.
  return {
    headline: msg || rawFallback(facts),
    evidence: [
      {
        polarity: "supporting",
        source: "Raised by",
        detail: "the site's own nightly report · no statistics attached",
        at: null,
      },
    ],
  };
}

/** The hygiene lane stores the URL and response separately, so a first-screen
 * headline does not need to repeat a full URL or the collector's check key.
 *
 * WHAT WENT WRONG, NOT WHICH STATUS CAME BACK (`ro-kukv.6`). This used to end
 * every headline with the HTTP status, which produced "Sitemap check failed —
 * HTTP 200" on one asset: a success status quoted beside the word failed, which
 * reads as a contradiction and tells the operator nothing about what to do. A
 * sitemap can fail at 200 in three different ways — the document is not XML,
 * its child sitemaps could not be read, or its URL count collapsed — and the
 * check records which in `rule_inputs.reason` (workers/ingest/src/hygiene.ts).
 * So the reason picks the sentence, and the status is quoted ONLY where it is
 * itself the failure. */
function hygieneFailure(
  facts: AlertFacts,
  subject: "Home page" | "Sitemap",
): AlertLanguage {
  const inputs = facts.ruleInputs ?? {};
  const status = num(inputs.http_status);
  const error = str(inputs.error);
  const url = str(inputs.url);
  const occurrences = num(inputs.occurrences);
  const observedAt = str(inputs.lastObservedAt) ?? str(inputs.evaluatedAt);
  const reason = str(inputs.reason);
  const served = status !== null && status >= 200 && status < 300;
  // A served status is never a cause: the request succeeded, and whatever else
  // is wrong, "HTTP 200" is not the news.
  const cause = status !== null && !served ? `HTTP ${Math.round(status)}` : error;

  const evidence: AlertEvidence[] = [];
  if (url) {
    evidence.push({
      polarity: "supporting",
      source: "URL checked",
      detail: url,
      at: observedAt,
    });
  }
  if (error) {
    evidence.push({
      polarity: "supporting",
      source: "Latest response",
      detail: error,
      at: observedAt,
    });
  }
  // The unreadable child sitemaps, as a value rather than the sentence the
  // store used to carry (bead `ro-ujb9.96.6.26`).
  const childrenFailed = reason === "child-unreachable" ? strings(inputs.children_failed) : [];
  if (childrenFailed.length > 0) {
    evidence.push({
      polarity: "supporting",
      source: "First unreadable",
      detail: childrenFailed.length > 1 ? `${childrenFailed[0]} · +${count(childrenFailed.length - 1)} more` : childrenFailed[0]!,
      at: observedAt,
    });
  }
  if (occurrences !== null && occurrences > 1) {
    evidence.push({
      polarity: "supporting",
      source: "Checks in a row",
      detail: count(occurrences),
      at: null,
    });
  }

  const hint =
    subject === "Sitemap" && reason === "unparseable"
      ? "the URL may be serving a page instead of XML"
      : subject === "Sitemap" && reason === "child-unreachable"
        ? "the index is there but its child sitemaps are not"
        : subject === "Sitemap" && reason === "count-collapse"
          ? "pages may have dropped out of the sitemap"
          : subject === "Sitemap" && status === 404
            ? "the sitemap may be missing or moved"
            : subject === "Home page" && (status === 401 || status === 403)
              ? "the site may be blocking the checker"
              : subject === "Home page" && status === 404
                ? "the configured home URL may be wrong"
                : undefined;

  if (subject === "Sitemap") {
    if (reason === "unparseable") {
      return {
        headline: served
          ? `Sitemap returned ${Math.round(status!)} but did not parse`
          : "Sitemap did not parse as XML",
        hint,
        evidence,
      };
    }
    if (reason === "child-unreachable") {
      const failed = Array.isArray(inputs.children_failed)
        ? inputs.children_failed.length
        : null;
      return {
        headline:
          failed !== null && failed > 0
            ? `Sitemap index has ${count(failed)} child sitemap${failed === 1 ? "" : "s"} the OS could not read`
            : "Sitemap index has child sitemaps the OS could not read",
        hint,
        evidence,
      };
    }
    if (reason === "count-collapse") {
      const urls = num(inputs.urls);
      const previous = num(inputs.previous_urls);
      return {
        headline:
          urls !== null && previous !== null
            ? `Sitemap shrank to ${count(urls)} URLs — was ${count(previous)}`
            : "Sitemap URL count collapsed",
        hint,
        evidence,
      };
    }
  }

  if (!cause) return { headline: rawFallback(facts), evidence };
  return { headline: `${subject} check failed — ${cause}`, hint, evidence };
}

/**
 * `os-egress-down` — the one alert in this vocabulary whose subject is the OS
 * itself. It fires on asset #0's row when the nightly lanes could not reach the
 * network at all, and it exists because of what happened without it: on
 * 2026-08-08 a dead house uplink produced ~15 flags accusing six assets of
 * being dark. So this line has one job beyond naming the outage — it has to say,
 * before the operator opens anything else, that tonight's quiet is the OS's and
 * not the portfolio's.
 */
function egressDown(facts: AlertFacts): AlertLanguage {
  const i = facts.ruleInputs ?? {};
  const beacons = Array.isArray(i.beacons)
    ? i.beacons.map(record).filter((b): b is Record<string, unknown> => b !== null)
    : [];
  const unmeasured = Array.isArray(i.unmeasuredAssets)
    ? i.unmeasuredAssets.filter((value): value is string => typeof value === "string")
    : null;
  const failureCount = num(i.failureCount);
  const observedAt = str(i.lastFailedAt) ?? str(i.evaluatedAt);
  // Set once a reference site answers again while some collectors have not yet
  // re-run (bead `ro-aed0.5`): the outage is over, and the alert is open only
  // for the gaps it left. Saying "down" then would send the operator to a router
  // that is already fine.
  const backAt = str(i.connectionBackAt);

  // The collectors still owing a re-run, named the way the Workflows page
  // names them, so the evidence row is a list to check rather than a sentence.
  const owed =
    i.lanes !== null && typeof i.lanes === "object" && !Array.isArray(i.lanes)
      ? Object.keys(i.lanes).map((lane) => OWED_COLLECTOR_LABELS[lane] ?? lane)
      : [];

  const evidence: AlertEvidence[] = [];
  if (backAt !== null) {
    evidence.push({
      polarity: "against",
      source: "Connection answered again",
      detail: owed.length > 0 ? `Waiting on ${owed.join(", ")}` : "Waiting on the next collection",
      at: backAt,
    });
  }
  if (beacons.length > 0) {
    evidence.push({
      polarity: "supporting",
      source: "Reference sites that did not answer",
      // Verbatim: the whole argument for suppressing the asset alerts is that
      // two unrelated sites failed the same way the assets did.
      detail: beacons
        .map((b) => `${str(b.url) ?? "beacon"}: ${str(b.error) ?? "no response"}`)
        .join("; "),
      at: observedAt,
    });
  }
  if (failureCount !== null && failureCount > 1) {
    evidence.push({
      polarity: "supporting",
      source: "Failed connectivity checks",
      detail: `${count(failureCount)} since the first`,
      at: null,
    });
  }
  if (unmeasured !== null && unmeasured.length > 0) {
    evidence.push({
      polarity: "supporting",
      source: "Not checked tonight",
      detail: unmeasured.join(", "),
      at: null,
    });
  }

  // WHAT HAPPENED, THEN WHAT TO DO. The subject of the headline is the OS, so
  // "the assets are not at fault" is already said by whose name leads it; the
  // hint is the one move the operator has — the machine's own connection.
  if (unmeasured === null) return { headline: rawFallback(facts), evidence };
  if (backAt !== null) {
    return {
      headline: `OS connection back — ${count(unmeasured.length)} ${siteNoun(unmeasured.length)} not yet re-checked`,
      hint: "no action needed",
      evidence,
    };
  }
  return {
    headline: `OS is offline — ${count(unmeasured.length)} ${siteNoun(unmeasured.length)} not checked`,
    hint: "check this machine's internet connection",
    evidence,
  };
}

/** Plain names for the collectors an outage can leave owing a re-run
 * (workers/ingest/src/egress.ts EGRESS_LANES). */
const OWED_COLLECTOR_LABELS: Record<string, string> = {
  pull: "nightly reports",
  hygiene: "search checks",
  "google-signals": "Google",
  "bing-signals": "Bing",
  "signal-dumps": "traffic archives",
  dataforseo: "search rankings",
  posthog: "product analytics",
  uptime: "uptime checks",
};

/**
 * Which way is GOOD on this series, so a headline can say so.
 *
 * `WATCH_SERIES` is the OS's one polarity table (packages/contract) and the
 * same one the composer reads when it pre-registers a predicate — average
 * search position improves when it goes DOWN, everything else when it goes up.
 * A metric the table has never heard of falls back on its own name: a new rank
 * series must not be able to reach a headline reading "up" on a number where up
 * is bad, and defaulting an unrecognized `position`/`rank` to higher-is-better
 * is exactly that failure waiting to happen.
 */
function improvesWhen(
  integration: string | null,
  metric: string | null,
): "up" | "down" {
  if (!metric) return "up";
  const exact = WATCH_SERIES.find(
    (series) =>
      series.metric === metric &&
      (integration === null || series.integration === integration),
  );
  if (exact) return exact.improvesWhen;
  const byMetric = WATCH_SERIES.filter((series) => series.metric === metric);
  const first = byMetric[0];
  if (first && byMetric.every((series) => series.improvesWhen === first.improvesWhen)) {
    return first.improvesWhen;
  }
  return /position|rank/i.test(metric) ? "down" : "up";
}

/**
 * The measured move, in words that carry their own valence (`ro-kukv.3`).
 *
 * Observed 2026-08-31 on one asset's Current signals: *"Revert decision
 * needed — Position up 10.14%"*, in amber, beside the word revert. Three
 * signals pointing two ways, because `up` was read straight off the sign of the
 * delta and a search position that RISES is a search position that got worse.
 *
 * So a series whose good direction is DOWN speaks improvement, not arithmetic:
 * **improved** / **worsened**, the same pair the query table and the page
 * decision markdown already use for a position. Everything else keeps plain
 * up/down, where the arrow and the word agree and inventing a second vocabulary
 * would cost more than it buys.
 */
function movementPhrase(delta: number, direction: "up" | "down"): string {
  const magnitude = `${Math.abs(delta).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  if (delta === 0) return "flat";
  if (direction === "down") {
    return `${delta > 0 ? "worsened" : "improved"} ${magnitude}`;
  }
  return `${delta > 0 ? "up" : "down"} ${magnitude}`;
}

/** A watch closes only after reading the outcome predicate registered before
 * the numbers existed. A confirmed decline is therefore a revert DECISION,
 * not a generic anomaly and not proof that an automatic rollback happened. */
function watchWindowClosed(facts: AlertFacts): AlertLanguage {
  const inputs = facts.ruleInputs ?? {};
  const outcome = str(inputs.outcome);
  const metric = str(inputs.metric) ?? facts.metric;
  const integration = str(inputs.integration);
  const reading = record(inputs.reading);
  const delta = num(reading?.delta_pct);
  const label = metricName(metric);
  const movement =
    delta === null ? null : movementPhrase(delta, improvesWhen(integration, metric));
  const measured = movement ? ` — ${label} ${movement}` : "";

  const evidence: AlertEvidence[] = [];
  const refKind = str(inputs.refKind);
  const ref = str(inputs.ref);
  if (ref) {
    evidence.push({
      polarity: "supporting",
      source: "Watched change",
      detail: `${refKind ? `${humanizeMetric(refKind)} ` : ""}${ref}`,
      at: str(inputs.registeredAt),
    });
  }
  if (metric || integration) {
    evidence.push({
      polarity: "supporting",
      source: "Outcome signal",
      detail: [integration, metric, movement].filter(Boolean).join(" · "),
      at: str(inputs.evaluatedAt),
    });
  }

  if (outcome === "kill_confirmed") {
    return {
      headline: `Revert decision needed${measured}`,
      hint: "decide whether to revert the watched change",
      evidence,
    };
  }
  if (outcome === "ship_confirmed") {
    return { headline: `Growth threshold met${measured}`, evidence };
  }
  if (outcome === "unmeasurable") {
    return { headline: `Outcome could not be measured${measured}`, evidence };
  }
  if (outcome === "inconclusive") {
    return { headline: `Outcome remains inconclusive${measured}`, evidence };
  }
  return { headline: rawFallback(facts), evidence };
}

// --- the site checks that find a regression (bead `ro-ujb9.96.6.26`) --------
//
// Each stores a short headline with its values; the figures and the pages
// behind it are its `rule_inputs`, drawn here as label · value rows — the way
// Datadog's monitor status carries the value against its threshold and
// Sentry's issue header its tags — so no row needs a sentence about the rule.

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** A sampled page's path: the site is the row's subject already. */
function pagePath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}

/** One row per named page: the page's path, and what tonight's reading found
 * on it (`marks`), or that it was not re-checked. */
function pageRows(inputs: Record<string, unknown>, urls: readonly string[], marks: "blocking" | "faults"): AlertEvidence[] {
  const pages = Array.isArray(inputs.pages)
    ? inputs.pages.map(record).filter((page): page is Record<string, unknown> => page !== null)
    : [];
  const byUrl = new Map(pages.map((page) => [str(page.url), page]));
  const at = str(inputs.lastObservedAt) ?? str(inputs.evaluatedAt);
  return urls.map((url) => {
    const page = byUrl.get(url);
    const found = page?.read === true ? strings(page[marks]) : [];
    return {
      polarity: "supporting",
      source: pagePath(url),
      detail: page?.read === true ? found.join(", ") : "not re-checked",
      at,
    };
  });
}

/** `hygiene-html-depth` — the home page's served HTML fell below half its norm. */
function htmlDepth(facts: AlertFacts): AlertLanguage {
  const i = facts.ruleInputs ?? {};
  const words = num(i.words);
  const median = num(i.baseline_median);
  const readings = num(i.baseline_readings);
  const ratio = num(i.threshold_ratio);
  const url = str(i.url);
  const at = str(i.lastObservedAt) ?? str(i.evaluatedAt);
  const evidence: AlertEvidence[] = [];
  if (words !== null) evidence.push({ polarity: "supporting", source: "Words served", detail: count(words), at });
  if (median !== null) {
    evidence.push({
      polarity: "supporting",
      source: "Normal · median",
      detail: readings !== null ? `${count(median)} over ${count(readings)} readings` : count(median),
      at: null,
    });
  }
  if (ratio !== null) evidence.push({ polarity: "supporting", source: "Fires at", detail: `${percent(ratio)} of the median`, at: null });
  if (url) evidence.push({ polarity: "supporting", source: "URL checked", detail: url, at });
  if (words === null || median === null) return { headline: rawFallback(facts), evidence };
  return {
    headline: `Home page HTML fell to ${count(words)} words — was ${count(median)}`,
    hint: "the page may now render only in the browser",
    evidence,
  };
}

/** `hygiene-robots-ai` — robots.txt stopped being served, or newly disallows
 * AI crawlers it allowed. */
function robotsAccess(facts: AlertFacts): AlertLanguage {
  const i = facts.ruleInputs ?? {};
  const lost = strings(i.lost_bots);
  const previous = record(i.previous_bots);
  const allowedBefore = previous ? Object.values(previous).filter((allowed) => allowed === true).length : null;
  const status = num(i.http_status);
  const cause = status !== null ? `HTTP ${Math.round(status)}` : (str(i.error) ?? "no response");
  const at = str(i.lastObservedAt) ?? str(i.evaluatedAt);
  const previousOn = str(i.previous_observed_on);
  const url = str(i.url);

  const evidence: AlertEvidence[] = [];
  if (i.robots_vanished === true) evidence.push({ polarity: "supporting", source: "Latest response", detail: cause, at });
  if (lost.length > 0) evidence.push({ polarity: "supporting", source: "Newly disallowed", detail: lost.join(", "), at });
  if (allowedBefore !== null && previous) {
    evidence.push({
      polarity: "supporting",
      source: "Allowed before",
      detail: `${count(allowedBefore)} of ${count(Object.keys(previous).length)} AI crawlers`,
      at: previousOn,
    });
  }
  if (url) evidence.push({ polarity: "supporting", source: "URL checked", detail: url, at });

  if (i.robots_vanished === true) return { headline: `robots.txt no longer served — ${cause}`, evidence };
  if (lost.length === 0) return { headline: rawFallback(facts), evidence };
  const subject = lost.length <= 2 ? lost.join(" and ") : `${count(lost.length)} AI crawlers`;
  return { headline: `${subject} newly blocked by robots.txt`, evidence };
}

/** `hygiene-page-directives` — sampled pages newly carry a noindex, nofollow or
 * nosnippet that robots.txt cannot show. One row per page. */
function pageDirectives(facts: AlertFacts): AlertLanguage {
  const i = facts.ruleInputs ?? {};
  const blocked = strings(i.blocked_urls);
  const sampled = num(i.pages_sampled);
  const evidence = pageRows(i, blocked, "blocking");
  if (blocked.length === 0) return { headline: rawFallback(facts), evidence };
  return {
    headline:
      sampled !== null
        ? `Crawler directives closed ${count(blocked.length)} of ${count(sampled)} sampled pages`
        : `Crawler directives closed ${count(blocked.length)} sampled pages`,
    evidence,
  };
}

/** `hygiene-page-structure` — sampled pages newly lost a title, description,
 * canonical or heading they had. One row per page, its faults as the value. */
function pageStructure(facts: AlertFacts): AlertLanguage {
  const i = facts.ruleInputs ?? {};
  const faulty = strings(i.faulty_urls);
  const sampled = num(i.pages_sampled);
  const evidence = pageRows(i, faulty, "faults");
  if (faulty.length === 0) return { headline: rawFallback(facts), evidence };
  return {
    headline:
      sampled !== null
        ? `Page structure regressed on ${count(faulty.length)} of ${count(sampled)} sampled pages`
        : `Page structure regressed on ${count(faulty.length)} sampled pages`,
    evidence,
  };
}

/** `ga4-quota-pressure` — a property's GA4 token bucket is under a fifth full. */
function ga4Quota(facts: AlertFacts): AlertLanguage {
  const i = facts.ruleInputs ?? {};
  const buckets = Array.isArray(i.pressured)
    ? i.pressured.map(record).filter((bucket): bucket is Record<string, unknown> => bucket !== null)
    : [];
  const tightest = buckets.reduce<Record<string, unknown> | null>(
    (low, bucket) => (low === null || (num(bucket.share) ?? 1) < (num(low.share) ?? 1) ? bucket : low),
    null,
  );
  const share = num(tightest?.share);
  const remaining = num(tightest?.remaining);
  const consumed = num(tightest?.consumed);
  const period = str(tightest?.bucket) === "tokensPerHour" ? "hourly" : "daily";
  const lane = str(i.lane);
  const property = str(i.propertyRef);
  const threshold = num(i.threshold_ratio);
  const at = str(i.lastObservedAt);

  const evidence: AlertEvidence[] = [];
  if (remaining !== null && consumed !== null) {
    evidence.push({ polarity: "supporting", source: "Tokens left", detail: `${count(remaining)} of ${count(remaining + consumed)}`, at });
  }
  if (threshold !== null) evidence.push({ polarity: "supporting", source: "Fires below", detail: percent(threshold), at: null });
  if (lane) evidence.push({ polarity: "supporting", source: "Spent by", detail: OWED_COLLECTOR_LABELS[lane] ?? lane, at: null });
  if (property) evidence.push({ polarity: "supporting", source: "GA4 property", detail: property, at: null });

  if (share === null) return { headline: rawFallback(facts), evidence };
  return {
    headline: `GA4 ${period} quota low — ${percent(share)} left`,
    hint: "collections may fail until it refills",
    evidence,
  };
}

const TRANSLATORS: Record<string, (facts: AlertFacts) => AlertLanguage> = {
  "flow-poisson-low": poissonLow,
  "flow-lowvol-window": lowVolumeWindow,
  "flow-pct-drop": percentDrop,
  "ingest-freshness": ingestFreshness,
  "asset-pull-failed": pullFailed,
  "asset-declared": assetDeclared,
  "hygiene-home-unreachable": (facts) => hygieneFailure(facts, "Home page"),
  "hygiene-sitemap": (facts) => hygieneFailure(facts, "Sitemap"),
  "hygiene-html-depth": htmlDepth,
  "hygiene-robots-ai": robotsAccess,
  "hygiene-page-directives": pageDirectives,
  "hygiene-page-structure": pageStructure,
  "ga4-quota-pressure": ga4Quota,
  "os-egress-down": egressDown,
  "watch-window-closed": watchWindowClosed,
};

/**
 * Turn one stored alert into operator language. A rule this module has never
 * heard of falls back to the words the store already holds — a new rule shipping
 * from the ingest lane degrades to today's rendering, never to a blank row.
 */
export function translateAlert(facts: AlertFacts): AlertLanguage {
  const translate = TRANSLATORS[facts.ruleId];
  return translate ? translate(facts) : { headline: rawFallback(facts), evidence: [] };
}

// --- correlated changes -----------------------------------------------------

/**
 * The changes on this asset's timeline that landed in the window BEFORE the
 * alert fired. Correlation, not causation — the Tower names the coincidence and
 * lets the operator judge it. Sorted most-recent first (nearest the alert).
 */
export function correlateChanges(
  changes: readonly AnnotationItem[],
  firedAt: string,
  windowHours: number = CORRELATION_WINDOW_HOURS,
): AnnotationItem[] {
  const fired = Date.parse(firedAt);
  if (Number.isNaN(fired)) return [];
  const from = fired - windowHours * 3_600_000;
  return changes
    .filter((c) => {
      const at = Date.parse(c.at);
      return !Number.isNaN(at) && at <= fired && at >= from;
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

const KIND_NOUN: Record<AnnotationKind, { one: string; many: string }> = {
  deploy: { one: "deploy", many: "deploys" },
  "model-change": { one: "model change", many: "model changes" },
  config: { one: "config change", many: "config changes" },
  incident: { one: "incident", many: "incidents" },
  "autonomy-change": { one: "automation change", many: "automation changes" },
  external: { one: "external event", many: "external events" },
};

/**
 * The chip's words. One change gets named precisely and dated against the alert
 * ("deploy 14h before") — that specific pairing IS the insight. Several get
 * counted, and mixed kinds collapse to "changes" rather than listing them, which
 * would trade the glance for a paragraph. null when nothing correlates, so the
 * absence of a chip is itself the (silent) answer.
 */
export function changesLabel(
  changes: readonly AnnotationItem[],
  firedAt: string,
  windowHours: number = CORRELATION_WINDOW_HOURS,
): string | null {
  if (changes.length === 0) return null;
  if (changes.length === 1) {
    const only = changes[0]!;
    const noun = KIND_NOUN[only.kind]?.one ?? "change";
    const gap = ageMs(Date.parse(firedAt), only.at);
    return gap === null ? `1 ${noun} before` : `${noun} ${formatAge(gap)} before`;
  }
  const kinds = new Set(changes.map((c) => c.kind));
  const noun =
    kinds.size === 1 ? (KIND_NOUN[changes[0]!.kind]?.many ?? "changes") : "changes";
  return `${changes.length} ${noun} in the ${windowLabel(windowHours)} before`;
}
