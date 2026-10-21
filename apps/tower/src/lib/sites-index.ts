// The Sites index read into the kit's portfolio rows, once: each site's one
// health word, its people a day over the last four weeks, yesterday's money
// against the same weekday a week before, its share of the month so far and
// its data sources, with the orderings the page offers. Every figure comes
// from the derivation Home and the Wall already use; a figure nobody reported
// stays null, never a zero.
import { isRetired } from "@shared/asset-setup";
import type { ConnectionReads } from "@shared/connection-status";
import { sitePath } from "@shared/first-run";
import type { AssetCard, PortfolioBand, SeriesPoint } from "@shared/wall";
import type { AnswerFigure } from "@/components/surface/PageAnswer";
import { sourcesLive, type PortfolioRow, type PortfolioSource } from "@/components/viz/PortfolioRows";
import { formatPercent } from "@/lib/format";
import { peopleYesterday, visitorsFigure } from "@/lib/home-brief";
import { homeMoney, siteDays, yesterdayMoney } from "@/lib/home-money";
import { SITE_HEALTH, siteHealth, type SiteHealth, type SiteHealthKey } from "@/lib/site-health";
import { siteHealthRow } from "@/lib/viz-adapters";
import { completeDays } from "@/lib/wall-sites";
import { hasRevenueSource } from "@/lib/wall-revenue";
import type { WallIssue } from "@/lib/wall-issues";

/** The orderings the page offers. `seed` is the saved site order, the one the
 * sidebar, Home and the Wall draw; `users` keeps the key older links carry. */
export type SitesOrder = "seed" | "health" | "money" | "users" | "name";

/** Worst first: what "Needs you" orders by, and the order the health split
 * and its legend are drawn in. */
export const HEALTH_RANK: Readonly<Record<SiteHealthKey, number>> = {
  "off-track": 4,
  "at-risk": 3,
  "monitor-only": 1,
  "on-track": 0,
  retired: -1,
};

export const HEALTH_KEYS: readonly SiteHealthKey[] = (Object.keys(HEALTH_RANK) as SiteHealthKey[]).sort(
  (a, b) => HEALTH_RANK[b] - HEALTH_RANK[a],
);

/** One site as the comparison reads it: the row the kit draws (its icon is
 * the caller's), and the facts the orderings and filters need beside it. */
export interface SiteLine {
  card: AssetCard;
  health: SiteHealth;
  /** The month's revenue so far, in dollars; null when the site has earned
   * nothing anybody reported. */
  earned: number | null;
  row: Omit<PortfolioRow, "icon">;
}

/** Only the two problem words wear a tone; every other word is quiet. */
function rowTone(key: SiteHealthKey): PortfolioRow["health"]["tone"] {
  return key === "off-track" ? "error" : key === "at-risk" ? "warn" : "quiet";
}

/** A site's sources as the row's pips, from the same cells Home's grid draws. */
function siteSources(card: AssetCard, connections: ConnectionReads, nowMs: number): PortfolioSource[] {
  return siteHealthRow(card, connections, nowMs).cells.map((cell) => ({
    label: card.dataSources.find((source) => source.id === cell.column)?.label ?? cell.column,
    state: cell.state,
  }));
}

export function siteLines(
  assets: readonly AssetCard[],
  portfolio: PortfolioBand,
  issues: readonly WallIssue[],
  connections: ConnectionReads,
  nowMs: number,
): SiteLine[] {
  // The share is of the whole portfolio's month, whatever the page narrows to.
  const bySite = homeMoney(portfolio, assets)?.bySite ?? [];
  const total = bySite.reduce((sum, site) => sum + site.amount, 0);
  return assets.map((card) => {
    const health = siteHealth(card, issues);
    const yesterday = hasRevenueSource(card) ? yesterdayMoney([card], nowMs, siteDays(card)) : null;
    const earned = bySite.find((site) => site.id === card.id)?.amount ?? null;
    return {
      card,
      health,
      earned,
      row: {
        id: card.id,
        name: card.displayName,
        to: sitePath(card),
        health: { word: health.word, tone: rowTone(health.key) },
        people: card.activeUsers.series,
        peopleProvisionalFrom: card.activeUsers.provisionalFrom,
        peopleLatest: completeDays(card.activeUsers).at(-1)?.v ?? null,
        peopleChange: weekOnWeek(completeDays(card.activeUsers)),
        revenue: yesterday?.amount ?? null,
        revenueChange: yesterday?.changePercent ?? null,
        share: earned !== null && total > 0 ? earned / total : null,
        sources: siteSources(card, connections, nowMs),
      },
    };
  });
}

/** The latest settled day against the same weekday a week before, as a signed
 * percent; null when that day is missing or was zero. */
export function weekOnWeek(days: readonly SeriesPoint[]): number | null {
  const latest = days.at(-1);
  if (!latest) return null;
  const weekBefore = new Date(Date.parse(`${latest.t}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  const before = days.find((day) => day.t === weekBefore);
  if (!before || before.v <= 0) return null;
  return ((latest.v - before.v) / before.v) * 100;
}

/** Descending, with a figure nobody reported last whichever way the numbers run. */
function unknownLast(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

const failing = (line: SiteLine) => sourcesLive(line.row.sources).failing;

/** Each ordering, worst or largest first; the stable sort leaves ties in the
 * saved order. Money is the month so far, then yesterday. */
const COMPARE: Record<Exclude<SitesOrder, "seed">, (a: SiteLine, b: SiteLine) => number> = {
  health: (a, b) =>
    HEALTH_RANK[b.health.key] - HEALTH_RANK[a.health.key] ||
    b.card.openError - a.card.openError ||
    b.card.openWarn - a.card.openWarn ||
    failing(b) - failing(a),
  money: (a, b) => unknownLast(a.earned, b.earned) || unknownLast(a.row.revenue, b.row.revenue),
  users: (a, b) => unknownLast(a.row.peopleLatest, b.row.peopleLatest),
  name: (a, b) => a.row.name.localeCompare(b.row.name),
};

/** Retired sites sit at the foot of every ordering, as the sidebar keeps them. */
const retiredLast = (a: SiteLine, b: SiteLine) => Number(isRetired(a.card.status)) - Number(isRetired(b.card.status));

export function orderSites(lines: readonly SiteLine[], order: SitesOrder): SiteLine[] {
  const compare = order === "seed" ? null : COMPARE[order];
  return [...lines].sort((a, b) => retiredLast(a, b) || (compare ? compare(a, b) : 0));
}

/** How many sites wear each health word, worst first, leaving out the words
 * no site wears. A retired site is in no part: nobody watches it. */
export function healthSplit(lines: readonly SiteLine[]): { key: SiteHealthKey; word: string; count: number }[] {
  return HEALTH_KEYS.filter((key) => key !== "retired").map((key) => ({
    key,
    word: SITE_HEALTH[key].word,
    count: lines.filter((line) => line.health.key === key).length,
  })).filter((part) => part.count > 0);
}

/** The sites a count of who needs the operator is taken over: every listed
 * site but a retired one. */
export function watchedLines(lines: readonly SiteLine[]): SiteLine[] {
  return lines.filter((line) => !isRetired(line.card.status));
}

/** Yesterday's visitors across the sites, with the change on the same weekday
 * a week before when both days were reported. */
export function visitorsAnswerFigure(assets: readonly AssetCard[]): AnswerFigure | null {
  const figure = visitorsFigure(assets);
  const change = peopleYesterday(assets)?.changePercent ?? null;
  if (!figure || change === null) return figure;
  return { ...figure, note: `${change >= 0 ? "↑" : "↓"} ${formatPercent(Math.abs(change))}%` };
}
