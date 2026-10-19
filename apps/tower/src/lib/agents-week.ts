// The agents' week in four counts and up to three lines: what they are
// building, what they finished this week, what was proven to work, what is
// still being watched. Read by Home; nothing here fetches.

import type { WatchOutcome } from "@shared/asset-detail";
import type { AssetCard, CardWatches } from "@shared/wall";
import { sumWorkWeeks, type WorkPayload } from "@shared/work";
import { evidenceParts } from "@/lib/agent-work";

export interface AgentsWeekLine {
  title: string;
  /** The site's name; null when the line is about no one site. */
  site: string | null;
  line: string;
}

export interface AgentsWeek {
  /** Tasks in progress across the sites with a task project; null when none has one. */
  building: number | null;
  /** Done so far this week; null when any counted project cannot say. */
  shipped: number | null;
  /** Sites whose newest settled bet worked. */
  proven: number;
  /** Bets still being watched, across every site. */
  watching: number;
  latest: AgentsWeekLine[];
}

export const AGENTS_WEEK_LINES = 3;

const DAY_MS = 86_400_000;

/** Each settled outcome in plain words. */
export const OUTCOME_WORDS: Readonly<Record<WatchOutcome, string>> = {
  ship_confirmed: "Worked",
  kill_confirmed: "Did not help",
  inconclusive: "Changed nothing",
  unmeasurable: "Could not be measured",
};

function pendingLine(nextCheckDate: string | null, nowMs: number): string {
  if (nextCheckDate === null) return "Still being watched";
  const today = Date.parse(new Date(nowMs).toISOString().slice(0, 10));
  const days = Math.round((Date.parse(nextCheckDate.slice(0, 10)) - today) / DAY_MS);
  if (!Number.isFinite(days) || days <= 0) return "We'll know soon";
  return `We'll know in ${days} ${days === 1 ? "day" : "days"}`;
}

function watchLine(latest: NonNullable<CardWatches["latest"]>, nowMs: number): string {
  return latest.outcome === null ? pendingLine(latest.nextCheckDate, nowMs) : OUTCOME_WORDS[latest.outcome];
}

/** A close's evidence as the line under it: its prose, else "Done" when it
 * cites only commits and links. */
function evidenceLine(evidence: string): string {
  const text = evidenceParts(evidence).filter((part) => part.kind === "text").map((part) => part.text);
  return text.length > 0 ? text.join(" · ") : "Done";
}

export function agentsWeek(cards: readonly AssetCard[], work: WorkPayload | null, nowMs: number): AgentsWeek {
  const withWork = cards.filter((card) => card.work !== null);
  const building = withWork.length === 0 ? null : withWork.reduce((sum, card) => sum + card.work!.inProgress, 0);
  // A site without a task project has no work to count; one with a project
  // but no week is unknown, and makes the total unknown.
  const shipped = sumWorkWeeks(withWork.map((card) => card.work!.weeks))?.done.now ?? null;

  let proven = 0;
  let watching = 0;
  const dated: (AgentsWeekLine & { at: number })[] = [];
  const pending: AgentsWeekLine[] = [];
  for (const card of cards) {
    const watches = card.watches;
    if (!watches) continue;
    watching += watches.open;
    const latest = watches.latest;
    if (!latest) continue;
    if (latest.outcome === "ship_confirmed" && latest.closedAt !== null) proven += 1;
    const row = { title: "Latest bet", site: card.displayName, line: watchLine(latest, nowMs) };
    const at = latest.outcome !== null && latest.closedAt !== null ? Date.parse(latest.closedAt) : Number.NaN;
    if (Number.isFinite(at)) dated.push({ ...row, at });
    else pending.push(row);
  }

  const names = new Map(cards.map((card) => [card.id, card.displayName]));
  for (const project of work?.projects ?? []) {
    for (const event of project.recentWork ?? []) {
      if (event.kind !== "closed" || event.resolution !== undefined) continue;
      const evidence = event.evidence?.trim();
      const at = Date.parse(event.at);
      if (!evidence || !Number.isFinite(at)) continue;
      dated.push({ title: event.title, site: names.get(project.asset) ?? project.name, line: evidenceLine(evidence), at });
    }
  }

  dated.sort((a, b) => b.at - a.at);
  const latest = [...dated.map(({ at: _at, ...line }) => line), ...pending].slice(0, AGENTS_WEEK_LINES);
  return { building, shipped, proven, watching, latest };
}
