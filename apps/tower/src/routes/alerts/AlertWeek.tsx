import type { AlertHistoryRow } from "@shared/alert-history";
import type { AssetCard, AttentionItem } from "@shared/wall";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { EventTimeline } from "@/components/viz/EventTimeline";
import { useSitePath } from "@/hooks/useSitePath";
import { ALERT_WEEK_MS, alertTimeline, siteOrder } from "@/lib/alerts-board";
import { cn } from "@/lib/utils";

/**
 * The answer drawn: the last seven days on one axis that ends at now, a row
 * per site, every open alert a bar from its onset to now and what settled
 * this week a quiet closed bar. An alert older than the week is clipped at
 * the left edge with its age on it, the same week after which the board
 * folds it. It is the portfolio's, like the sentence above it: the filters
 * narrow the list, not the picture.
 */
export function AlertWeek({
  open,
  settled,
  assets,
  nowMs,
  openHref,
}: {
  open: readonly AttentionItem[];
  settled: readonly AlertHistoryRow[];
  assets: readonly AssetCard[];
  nowMs: number;
  /** Where an open alert's bar goes: its own row on the board. */
  openHref: (item: AttentionItem) => string;
}) {
  const sitePath = useSitePath();
  const timeline = alertTimeline(open, settled, {
    nowMs,
    // The board's order, so the picture and the list lead with the same site.
    order: siteOrder(open, assets.map((asset) => ({ id: asset.id, label: asset.displayName }))),
    sitePath,
    openHref,
    settledHref: (row) => `/alerts/history?asset=${encodeURIComponent(row.asset.id)}`,
  });
  if (timeline.spans.length === 0) return null;
  const cards = new Map(assets.map((asset) => [asset.id, asset]));
  const lanes = timeline.lanes.map((lane) => {
    const card = cards.get(lane.id);
    return {
      ...lane,
      icon: <PropertyFavicon domain={lane.id} icons={card?.icons} displayName={card?.displayName ?? lane.label} className="size-4" />,
    };
  });
  return (
    <section aria-label="The last 7 days" data-alert-week="" className="rounded-xl bg-card px-5 pb-3 pt-4 ring-1 ring-border/70">
      <h2 className={cn("m-0 pb-1", eyebrowClass)}>Last 7 days</h2>
      <EventTimeline
        lanes={lanes}
        spans={timeline.spans}
        window={{ from: new Date(nowMs - ALERT_WEEK_MS).toISOString(), to: new Date(nowMs).toISOString() }}
        nowMs={nowMs}
        ariaLabel="Open and settled alerts over the last 7 days"
        className="[--timeline-name:10rem]"
      />
    </section>
  );
}
