// A site's technical health as five plain facts and one word. Home and the
// TV read it; nothing here fetches. Each fact is measured or it is unknown:
// a site that sends no reading is "not measured yet", never "fine".

import { UPTIME_LANE_ID } from "@shared/integrations";
import { isRetired } from "@shared/asset-setup";
import type { AssetCard } from "@shared/wall";
import type { StateTone } from "@/components/StateChip";
import { alertMark, type WallIssue } from "@/lib/wall-issues";
import { fourWeeks } from "@/lib/wall-sites";

export type TechFactKey = "reachable" | "speed" | "errors" | "search" | "code";
export type TechFactState = "ok" | "warn" | "bad" | "unknown";

export interface TechFact {
  key: TechFactKey;
  state: TechFactState;
  /** A word or two for the fact's value. */
  word: string;
  /** The one sentence shown beside a problem; null when the fact is fine. */
  note: string | null;
}

export type TechHealthKey = "fine" | "watch" | "trouble" | "unknown";

export interface TechHealth {
  key: TechHealthKey;
  word: string;
  tone: StateTone;
  facts: TechFact[];
}

export const TECH_HEALTH: Readonly<Record<TechHealthKey, { word: string; tone: StateTone }>> = {
  fine: { word: "Fine", tone: "affirmative" },
  watch: { word: "Worth a look", tone: "caution" },
  trouble: { word: "In trouble", tone: "critical" },
  unknown: { word: "Not measured yet", tone: "na" },
};

const NOT_MEASURED = "not measured yet";
const TOO_EARLY = "too early to tell";

/** A drop in search visits this large over four weeks is worth a look. */
export const SEARCH_DROP_PERCENT = 10;
/** Code growing this much in about a month is worth a look. */
export const CODE_GROWTH_PERCENT = 25;

// The issue list carries an alert's mark, not its rule id; the mark is
// derived from the rule id in one place, so it is matched through that place.
const mark = (ruleId: string) => alertMark({ ruleId, ruleInputs: null, metric: null, kind: "anomaly", message: "" });
const HOME_DOWN_MARK = mark("hygiene-home-unreachable");
const SITEMAP_MARK = mark("hygiene-sitemap");
const UPTIME_FAILING_KEY = `source-${UPTIME_LANE_ID}`;

const unknown = (key: TechFactKey, word = NOT_MEASURED): TechFact => ({ key, state: "unknown", word, note: null });

function reachable(card: AssetCard, mine: readonly WallIssue[]): TechFact {
  if (mine.some((issue) => issue.mark === HOME_DOWN_MARK)) {
    return { key: "reachable", state: "bad", word: "Down", note: "The home page did not load" };
  }
  const slot = card.dataSources.find((source) => source.id === UPTIME_LANE_ID);
  if (mine.some((issue) => issue.key === UPTIME_FAILING_KEY) || slot?.state === "degraded") {
    return { key: "reachable", state: "warn", word: "Not checked lately", note: "The uptime check has not run lately" };
  }
  return slot?.state === "live" ? { key: "reachable", state: "ok", word: "Up", note: null } : unknown("reachable");
}

function speed(card: AssetCard): TechFact {
  const product = card.product;
  if (!product || product.speed === "not-collected") return unknown("speed");
  if (product.speed === "fired") return { key: "speed", state: "warn", word: "Slow", note: "Slow for 1 in 4 visitors" };
  if (product.worstSpeed === "poor") return { key: "speed", state: "warn", word: "Slow", note: "Slow for some visitors" };
  if (product.speed === "not-enough-data") return unknown("speed", "too few visits yet");
  return { key: "speed", state: "ok", word: product.worstSpeed === "needs-improvement" ? "OK" : "Fast", note: null };
}

function errors(card: AssetCard): TechFact {
  const product = card.product;
  if (!product || product.errors === "not-collected") return unknown("errors");
  const people = product.errorPeople;
  if (product.errors === "fired" || product.jsErrorFinding) {
    const note =
      people !== null && people > 0
        ? `${people.toLocaleString("en-US")} ${people === 1 ? "person" : "people"} hit an error`
        : "Some people hit an error";
    return { key: "errors", state: "warn", word: "Some", note };
  }
  if (product.errors === "not-enough-data") return unknown("errors", "too few visits yet");
  return { key: "errors", state: "ok", word: people !== null && people > 0 ? "Few" : "None", note: null };
}

function search(card: AssetCard, mine: readonly WallIssue[]): TechFact {
  if (mine.some((issue) => issue.mark === SITEMAP_MARK)) {
    return { key: "search", state: "warn", word: "Sitemap failing", note: "Search engines cannot read its sitemap" };
  }
  const weeks = fourWeeks(card.searchClicks);
  if (weeks === null) return unknown("search");
  const change = weeks.change;
  if (change === null) return unknown("search", TOO_EARLY);
  if (change.percent <= -SEARCH_DROP_PERCENT) {
    return { key: "search", state: "warn", word: "Falling", note: "Fewer people found it in search" };
  }
  return { key: "search", state: "ok", word: change.percent >= SEARCH_DROP_PERCENT ? "Growing" : "Steady", note: null };
}

function code(card: AssetCard): TechFact {
  const codebase = card.codebase;
  if (!codebase) return unknown("code");
  const growth = codebase.growthPercent30d;
  if (growth === null) return unknown("code", TOO_EARLY);
  if (growth >= CODE_GROWTH_PERCENT) {
    const days = codebase.comparedDays ?? 30;
    return { key: "code", state: "warn", word: "Growing fast", note: `Grew ${Math.round(growth)}% in ${days} days` };
  }
  return { key: "code", state: "ok", word: "Steady", note: null };
}

/** Sites nobody measures yet or any more: every fact is unknown. */
function unmeasured(status: string): boolean {
  return isRetired(status) || status === "pre-launch";
}

export function techHealth(card: AssetCard, issues: readonly WallIssue[]): TechHealth {
  const mine = issues.filter((issue) => issue.assets.includes(card.id));
  const facts: TechFact[] = unmeasured(card.status)
    ? (["reachable", "speed", "errors", "search", "code"] as const).map((key) => unknown(key))
    : [reachable(card, mine), speed(card), errors(card), search(card, mine), code(card)];
  const key: TechHealthKey = facts.some((fact) => fact.state === "bad")
    ? "trouble"
    : facts.some((fact) => fact.state === "warn")
      ? "watch"
      : facts.every((fact) => fact.state === "unknown")
        ? "unknown"
        : "fine";
  return { key, ...TECH_HEALTH[key], facts };
}

export interface TechHealthSummary {
  /** Sites whose word is "fine". */
  fine: number;
  /** Sites with at least one measured fact: the "of N" in "4 of 5 sites are fine". */
  measured: number;
  /** The site most in need of a look, trouble before watch, in card order;
   * null when none is. */
  lead: { card: AssetCard; health: TechHealth } | null;
}

export function techHealthSummary(cards: readonly AssetCard[], issues: readonly WallIssue[]): TechHealthSummary {
  let fine = 0;
  let measured = 0;
  let trouble: TechHealthSummary["lead"] = null;
  let watch: TechHealthSummary["lead"] = null;
  for (const card of cards) {
    const health = techHealth(card, issues);
    if (health.key === "unknown") continue;
    measured += 1;
    if (health.key === "fine") fine += 1;
    else if (health.key === "trouble") trouble ??= { card, health };
    else watch ??= { card, health };
  }
  return { fine, measured, lead: trouble ?? watch };
}
