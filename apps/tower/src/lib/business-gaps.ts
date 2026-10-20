// What the portfolio is missing as a business: sites that earn nothing,
// sites nothing measures, and the opportunities the newest readings found.
// One ranked list, capped, read by Home; nothing here fetches.

import { isRetired } from "@shared/asset-setup";
import { NIGHTLY_REPORT_LANE_ID, UPTIME_LANE_ID } from "@shared/integrations";
import { cardHasMoney, type AssetCard } from "@shared/wall";
import { hasRevenueSource } from "@/lib/wall-revenue";

export interface BusinessGap {
  /** Stable across renders: the gap's kind and its site. */
  key: string;
  /** The site the gap is about; null for one about the whole portfolio. */
  siteId: string | null;
  title: string;
  detail: string | null;
}

export const BUSINESS_GAP_LIMIT = 8;

/** Slots that are not a feed of visitor or search data. */
const NOT_ANALYTICS: ReadonlySet<string> = new Set([NIGHTLY_REPORT_LANE_ID, UPTIME_LANE_ID]);

/**
 * Finding keys that read as an opportunity, in rank order. A key matches
 * itself or a key it prefixes with "-" (one funnel's drop is
 * `posthog-funnel-drop-<funnel>`).
 */
export const OPPORTUNITY_FINDINGS: readonly string[] = [
  "concentration-risk",
  "search-striking-distance",
  "dataforseo-ranking-opportunity",
  "dataforseo-opportunity",
  "ai-referral-floor",
  "posthog-funnel-drop",
  "prune-candidates",
];

function opportunityRank(findingKey: string): number {
  return OPPORTUNITY_FINDINGS.findIndex((key) => findingKey === key || findingKey.startsWith(`${key}-`));
}

function earnsNothing(card: AssetCard): boolean {
  // A site not launched yet is expected to earn nothing.
  return card.status !== "pre-launch" && !hasRevenueSource(card) && !cardHasMoney(card);
}

function hasNoDataFeeds(card: AssetCard): boolean {
  const feeds = card.dataSources.filter((source) => !NOT_ANALYTICS.has(source.id));
  return feeds.length > 0 && feeds.every((source) => source.state === "needs-setup");
}

/** Ranked: money first, then what nothing measures, then the readings'
 * opportunities; within a rank, the sites in card order. Retired sites are
 * left out. */
export function businessGaps(cards: readonly AssetCard[]): BusinessGap[] {
  const sites = cards.filter((card) => !isRetired(card.status));
  const gaps: BusinessGap[] = [];
  for (const card of sites) {
    if (!earnsNothing(card)) continue;
    gaps.push({
      key: `earns-nothing:${card.id}`,
      siteId: card.id,
      title: `${card.displayName} earns nothing`,
      detail: "Connect an income source, or mark it as free",
    });
  }
  for (const card of sites) {
    if (!hasNoDataFeeds(card)) continue;
    gaps.push({
      key: `no-data-feeds:${card.id}`,
      siteId: card.id,
      title: `${card.displayName} has no data feeds`,
      detail: "Connect visitor and search data to measure it",
    });
  }
  for (const card of sites) {
    if (card.work !== null) continue;
    gaps.push({
      key: `no-task-project:${card.id}`,
      siteId: card.id,
      title: `${card.displayName} has no task project`,
      detail: "Connect one so work on it is tracked",
    });
  }
  for (const card of sites) {
    // Absent is an older payload, which cannot say; only null is "none sent".
    if (card.codebase !== null) continue;
    gaps.push({
      key: `no-code-report:${card.id}`,
      siteId: card.id,
      title: `${card.displayName} sends no code report`,
      detail: "Add it to the nightly report to track how the code grows",
    });
  }
  const found = sites.flatMap((card, order) =>
    (card.findings ?? [])
      .map((finding) => ({ card, order, finding, rank: opportunityRank(finding.key) }))
      .filter((entry) => entry.rank >= 0),
  );
  found.sort((a, b) => a.rank - b.rank || a.order - b.order);
  for (const { card, finding } of found) {
    gaps.push({
      key: `finding:${card.id}:${finding.key}`,
      siteId: card.id,
      title: finding.title,
      detail: card.displayName,
    });
  }
  return gaps.slice(0, BUSINESS_GAP_LIMIT);
}
