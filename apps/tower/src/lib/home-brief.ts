import type { ConnectionReads } from "@shared/connection-status";
import { ageMs, formatAge } from "@shared/freshness";
import { shiftLabel } from "@shared/surface";
import type { AssetCard, AttentionItem, PortfolioBand, SeriesPoint, SystemBand } from "@shared/wall";
import type { WallFeedItem, WallFeedPayload } from "@shared/wall-feed";
import type { HighlightKind, HighlightSpark } from "@/components/HighlightCard";
import type { AnswerFigure } from "@/components/surface/PageAnswer";
import { formatInt, formatPercent, formatPeriodMonthLong, formatSeriesDate, formatUsd } from "@/lib/format";
import { wallIssues, type WallIssue, type WallIssueCondition, type WallIssueInputs } from "@/lib/wall-issues";
import { monthRevenue, yesterdayTotal } from "@/lib/wall-revenue";
import { withSystemIssues } from "@/lib/wall-system-state";

/**
 * THE MORNING BRIEF (D44, doc 14 § Home): what changed since the operator
 * last looked, as at most five highlight cards, the first the big thing.
 *
 * Nothing here is synthesized. Every card stands for a stored fact the Tower
 * already reads: an open problem (`wallIssues`, the Wall's Needs you list,
 * with the OS's own problems merged in), the month's revenue and its pace
 * (`monthRevenue`, the Wall's revenue band), yesterday's visitors against the
 * same weekday last week (the asset cards' daily users), and the live feed's
 * wins and ships (`/api/wall/feed`, the Wall's feed column). A quiet day is a
 * brief with no cards and a finish line, never an invented highlight.
 *
 * RANKING is severity, then dollars, then kind (doc 14): a broken thing or an
 * error first, warnings next, then money, then people when they moved, then
 * wins, ships and findings. Within a rank the newest first.
 */
export const BRIEF_LIMIT = 5;

/** How far a day's visitors have to move against the same weekday last week
 * before the brief says so. Two percent on a day's traffic is weather. */
export const PEOPLE_MOVED_PERCENT = 10;

export interface BriefCard {
  key: string;
  kind: HighlightKind;
  severity?: "error" | "warn";
  site: string | null;
  assetId: string | null;
  /** One sentence under twelve words. */
  title: string;
  detail: string | null;
  figure?: string;
  spark?: HighlightSpark;
  action?: { label: string; to: string };
  /** Lower first. */
  rank: number;
  /** Newest first within a rank. */
  at: string | null;
  /** The flag this card stands for, when it is an open alert. */
  flagId?: number;
  conditions: WallIssueCondition[];
}

export interface HomeBrief {
  /** At most `BRIEF_LIMIT`, ranked. */
  cards: BriefCard[];
  /** Everything that changed, before the cap. */
  changed: number;
  /** The window's start (the feed's), or null before the feed has answered. */
  since: string | null;
  /** The open problems the cards were drawn from, in Needs you's order. */
  issues: WallIssue[];
  people: PeopleYesterday | null;
}

export interface HomeBriefInputs {
  assets: readonly AssetCard[];
  attention: readonly AttentionItem[];
  portfolio: PortfolioBand;
  system?: SystemBand;
  connections: ConnectionReads;
  calendarState?: WallIssueInputs["calendarState"];
  feed: WallFeedPayload | null;
  nowMs: number;
  /** Where a site's page is, for a card's one action. */
  sitePath: (assetId: string) => string;
}

const RANK = { broken: 0, error: 0, warn: 1, money: 2, people: 3, win: 4, shipped: 5, search: 6 } as const;

/** The feed kinds the brief draws, and as what. Alerts, failures and late
 * reports are OPEN problems and come from `wallIssues` instead; money comes
 * from the projection; collections, reports and saved settings are the OS's
 * own housekeeping and never a highlight. */
const FEED_KIND: Partial<Record<WallFeedItem["kind"], HighlightKind>> = {
  resolved: "win",
  "task-done": "win",
  "source-back": "win",
  deployed: "shipped",
  change: "shipped",
  insights: "search",
};

export function homeBrief(inputs: HomeBriefInputs): HomeBrief {
  const { assets, attention, portfolio, system, connections, calendarState, feed, nowMs, sitePath } = inputs;
  const issues = withSystemIssues(wallIssues({ assets, attention, connections, calendarState, nowMs }), system, nowMs);
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const cards: BriefCard[] = [];

  for (const issue of issues) {
    const broken = issue.key.startsWith("source-") || issue.key.startsWith("system-") || issue.key === "calendar-read";
    const asset = issue.assets.length === 1 ? issue.assets[0]! : null;
    const age = issue.since ? ageMs(nowMs, issue.since) : null;
    cards.push({
      key: issue.key,
      kind: broken ? "broken" : "alert",
      severity: issue.severity,
      site: issue.site,
      assetId: asset,
      title: issue.line,
      detail: age === null ? null : `since ${formatAge(age)} ago`,
      action: asset && byId.has(asset)
        ? { label: "Look", to: sitePath(asset) }
        : broken
          ? { label: "Look", to: "/health" }
          : { label: "Look", to: "/alerts" },
      rank: broken ? RANK.broken : RANK[issue.severity],
      at: issue.since,
      flagId: issue.flagId,
      conditions: issue.conditions,
    });
  }

  const money = moneyCard(portfolio, assets, nowMs);
  if (money) cards.push(money);

  const people = peopleYesterday(assets);
  if (people && people.changePercent !== null && Math.abs(people.changePercent) >= PEOPLE_MOVED_PERCENT) {
    const up = people.changePercent > 0;
    cards.push({
      key: "people-yesterday",
      kind: "people",
      site: null,
      assetId: null,
      title: `Visitors ${up ? "up" : "down"} ${formatPercent(Math.abs(people.changePercent))}% on the same day last week`,
      detail: `${formatInt(people.total)} yesterday · ${formatInt(people.previous!)} a week before`,
      spark: { data: people.series, tone: "traffic", area: true, label: "Visitors a day, last two weeks" },
      action: assets.length === 1 ? { label: "Look", to: sitePath(assets[0]!.id) } : { label: "Sites", to: "/assets" },
      rank: RANK.people,
      at: people.date,
      conditions: [],
    });
  }

  let fromFeed = 0;
  for (const item of feed?.items ?? []) {
    const kind = FEED_KIND[item.kind];
    if (!kind) continue;
    fromFeed += 1;
    const age = ageMs(nowMs, item.at);
    cards.push({
      key: `feed-${item.id}`,
      kind,
      site: item.site,
      assetId: item.asset,
      title: item.text,
      detail: `${item.count > 1 ? `${formatInt(item.count)} together · ` : ""}${age === null ? "" : `${formatAge(age)} ago`}`.replace(/ · $/, "") || null,
      action: item.asset && byId.has(item.asset) ? { label: "Open", to: sitePath(item.asset) } : undefined,
      rank: RANK[kind === "win" ? "win" : kind === "shipped" ? "shipped" : "search"],
      at: item.at,
      conditions: [],
    });
  }

  cards.sort((a, b) => a.rank - b.rank || Date.parse(b.at ?? "") - Date.parse(a.at ?? "") || a.key.localeCompare(b.key));
  return {
    cards: cards.slice(0, BRIEF_LIMIT),
    changed: issues.length + fromFeed + (people && people.changePercent !== null && Math.abs(people.changePercent) >= PEOPLE_MOVED_PERCENT ? 1 : 0),
    since: feed?.since ?? null,
    issues,
    people,
  };
}

/** The month's money as one card: the pace while there is one, else the
 * month so far and why there is no pace yet (a new installation's first
 * weeks). Null when no site has a revenue source. */
function moneyCard(portfolio: PortfolioBand, assets: readonly AssetCard[], nowMs: number): BriefCard | null {
  const model = monthRevenue(portfolio, assets);
  if (!model) return null;
  const yesterday = yesterdayTotal(assets, nowMs);
  const month = formatPeriodMonthLong(model.period);
  const yesterdayWords = yesterday && yesterday.amount !== null && !yesterday.mixedBasis
    ? `yesterday ${formatUsd(yesterday.amount, { cents: true })} est.`
    : null;
  if (model.pace) {
    const { pace } = model;
    const change = pace.changePercent === null
      ? ""
      : pace.changePercent === 0
        ? ", level with last month"
        : `, ${pace.changePercent > 0 ? "up" : "down"} ${formatPercent(Math.abs(pace.changePercent))}%`;
    const actual = pace.points.filter((point) => !point.projected).map((point) => ({ t: point.date, v: point.cumulative }));
    return {
      key: "money-pace",
      kind: "money",
      site: null,
      assetId: null,
      title: `${month} on pace for ${formatUsd(pace.projected)}${change}`,
      detail: [yesterdayWords, `${pace.daysLeft} ${pace.daysLeft === 1 ? "day" : "days"} left`].filter(Boolean).join(" · "),
      spark: actual.length >= 2
        ? { data: actual, tone: "revenue", area: true, format: (value) => formatUsd(value), label: `${month} revenue so far, by day` }
        : undefined,
      action: { label: "Money", to: "/financials" },
      rank: RANK.money,
      at: null,
      conditions: [],
    };
  }
  return {
    key: "money-so-far",
    kind: "money",
    site: null,
    assetId: null,
    title: model.revenue === null ? `${month} revenue not reported yet` : `${month} revenue so far ${formatUsd(model.revenue)}`,
    detail: [yesterdayWords, model.waiting].filter(Boolean).join(" · ") || null,
    action: { label: "Money", to: "/financials" },
    rank: RANK.money,
    at: null,
    conditions: [],
  };
}

export interface PeopleYesterday {
  /** The latest settled day any site reported. */
  date: string;
  total: number;
  /** The same weekday a week before, over the sites that reported both days. */
  previous: number | null;
  changePercent: number | null;
  /** The last fourteen settled days, summed across sites. */
  series: SeriesPoint[];
}

/** Yesterday's visitors across the sites: the latest day every provider has
 * finished counting, never a provisional one, summed over the sites that
 * reported it. Missing is left out, never a zero. */
export function peopleYesterday(assets: readonly AssetCard[]): PeopleYesterday | null {
  const settled = assets.map((asset) => {
    const { series, provisionalFrom } = asset.activeUsers;
    return series.filter((point) => provisionalFrom === null || point.t < provisionalFrom);
  }).filter((series) => series.length > 0);
  if (settled.length === 0) return null;
  const date = settled.map((series) => series.at(-1)!.t).sort().at(-1)!;
  const previousDate = shiftLabel(date, -7);
  let total = 0;
  let previous = 0;
  let both = 0;
  const byDate = new Map<string, number>();
  for (const series of settled) {
    const index = new Map(series.map((point) => [point.t, point.v]));
    const today = index.get(date);
    if (today === undefined) continue;
    total += today;
    const before = index.get(previousDate);
    if (before !== undefined) {
      previous += before;
      both += 1;
    }
    for (const point of series) byDate.set(point.t, (byDate.get(point.t) ?? 0) + point.v);
  }
  const series = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-14).map(([t, v]) => ({ t, v }));
  const comparable = both > 0 && previous > 0;
  return {
    date,
    total,
    previous: comparable ? previous : null,
    changePercent: comparable ? ((total - previous) / previous) * 100 : null,
    series,
  };
}

/** The word for the hour, on the reader's own clock. */
export function greeting(nowMs: number): string {
  const hour = new Date(nowMs).getHours();
  return hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** The month's money as one figure, the same derivation Home's brief and the
 * Wall use: the pace while there is one, else the month so far, else nothing.
 * "October pace $1,310 ↑ 16%". */
export function monthFigure(portfolio: PortfolioBand, assets: readonly AssetCard[]): AnswerFigure | null {
  const money = monthRevenue(portfolio, assets);
  if (!money) return null;
  const month = formatSeriesDate(`${money.period}-01`).replace(/\s\d+$/, "");
  if (money.pace) {
    const change = money.pace.changePercent;
    return {
      label: `${month} pace`,
      value: formatUsd(money.pace.projected),
      note: change === null ? undefined : `${change >= 0 ? "↑" : "↓"} ${formatPercent(Math.abs(change))}%`,
      mark: "month-figure",
    };
  }
  return money.revenue === null ? null : { label: `${month} so far`, value: formatUsd(money.revenue), mark: "month-figure" };
}

/** Yesterday's visitors across the sites as one figure, or nothing. */
export function visitorsFigure(assets: readonly AssetCard[]): AnswerFigure | null {
  const people = peopleYesterday(assets);
  return people ? { label: "Visitors yesterday", value: formatInt(people.total), mark: "visitors-figure" } : null;
}
