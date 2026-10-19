import { ChevronRight, Signpost } from "lucide-react";
import type { AssetCard, CardFunnelDrop } from "@shared/wall";
import { formatInt } from "@/lib/format";

// Visitors by channel: the portfolio's visits summed by channel across the
// sites, as bars on one shared scale with each channel's share, then the one
// funnel step that loses the most people. The bars are drawn in one ink, so
// the channel's name and figures carry the meaning.

const eyebrow = "text-wall-label font-semibold uppercase tracking-widest text-muted-foreground";

/** Channels drawn before the rest fold into one "Other" bar. */
export const WALL_CHANNEL_ROWS = 6;

export interface PortfolioChannel {
  channel: string;
  sessions: number;
  /** Share of the portfolio's visits, 0–1. */
  share: number;
}

/** Every card's channel rows summed by channel, largest first, the tail past
 * `WALL_CHANNEL_ROWS` folded into "Other". Null when no card carries a split. */
export function portfolioChannels(cards: readonly AssetCard[]): { rows: PortfolioChannel[]; total: number } | null {
  const sums = new Map<string, number>();
  let read = false;
  for (const card of cards) {
    if (!card.channels) continue;
    read = true;
    for (const row of card.channels.rows) {
      if (!Number.isFinite(row.sessions) || row.sessions < 0) continue;
      sums.set(row.channel, (sums.get(row.channel) ?? 0) + row.sessions);
    }
  }
  if (!read) return null;
  const total = [...sums.values()].reduce((sum, value) => sum + value, 0);
  const sorted = [...sums.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const head = sorted.length > WALL_CHANNEL_ROWS ? sorted.slice(0, WALL_CHANNEL_ROWS - 1) : sorted;
  const rest = sorted.slice(head.length);
  let entries = head;
  if (rest.length > 0) {
    const tail = rest.reduce((sum, [, value]) => sum + value, 0);
    entries = head.some(([channel]) => channel === "Other")
      ? head.map(([channel, value]): [string, number] => [channel, channel === "Other" ? value + tail : value])
      : [...head, ["Other", tail]];
  }
  return {
    rows: entries.map(([channel, sessions]) => ({ channel, sessions, share: total > 0 ? sessions / total : 0 })),
    total,
  };
}

export interface FunnelDropPick {
  site: string;
  funnel: string;
  drop: CardFunnelDrop;
}

/** The funnel step across every site that loses the most people; with no
 * counts, the step with the lowest share going on. */
export function largestFunnelDrop(cards: readonly AssetCard[]): FunnelDropPick | null {
  let best: FunnelDropPick | null = null;
  const worse = (a: CardFunnelDrop, b: CardFunnelDrop) => {
    if (a.lostPeople !== null || b.lostPeople !== null) return (a.lostPeople ?? -1) > (b.lostPeople ?? -1);
    return (a.stepConversion ?? 2) < (b.stepConversion ?? 2);
  };
  for (const card of cards) {
    const funnel = card.product?.funnel;
    const drop = funnel?.largestDrop;
    if (!funnel || !drop) continue;
    if (best === null || worse(drop, best.drop)) best = { site: card.displayName, funnel: funnel.name, drop };
  }
  return best;
}

export function WallChannels({ assets }: { assets: readonly AssetCard[] }) {
  const channels = portfolioChannels(assets);
  const drop = largestFunnelDrop(assets);
  const top = Math.max(0, ...(channels?.rows.map((row) => row.share) ?? []));
  return (
    <section aria-label="Visitors by channel" className="flex min-w-0 flex-col gap-3" data-wall-channels={channels ? "bars" : "calm"}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className={eyebrow}>Visitors by channel</h2>
        {channels ? (
          <span className="text-wall-micro tabular-nums text-muted-foreground" data-wall-channels-total="">
            {formatInt(channels.total)} visits
          </span>
        ) : null}
      </div>
      {channels === null || channels.rows.length === 0 ? (
        <div className="flex items-center gap-3 rounded-lg bg-muted/60 px-4 py-3 text-wall-body text-muted-foreground" data-wall-channels-calm="">
          <Signpost className="size-6 shrink-0" aria-hidden />
          No channel split yet
        </div>
      ) : (
        <ol className="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-2">
          {channels.rows.map((row) => (
            <li key={row.channel} className="col-span-full grid grid-cols-subgrid items-center" data-wall-channel={row.channel}>
              <span className="min-w-0 truncate text-wall-list-line font-semibold" title={row.channel}>{row.channel}</span>
              <span aria-hidden className="h-3 w-full overflow-hidden rounded-full bg-viz-track">
                <span
                  className="block h-full rounded-full bg-spark viz-grow-x"
                  style={{ width: `${top > 0 ? Math.max(2, (row.share / top) * 100) : 0}%` }}
                />
              </span>
              <span className="text-right text-wall-list-label tabular-nums text-muted-foreground">{formatInt(row.sessions)}</span>
              <span className="w-[4ch] text-right text-wall-list-label font-semibold tabular-nums">{Math.round(row.share * 100)}%</span>
            </li>
          ))}
        </ol>
      )}
      {drop ? (
        <div className="flex min-w-0 flex-col gap-1 rounded-lg bg-muted/60 px-4 py-2.5" data-wall-funnel-drop="">
          <span className="text-wall-micro text-muted-foreground [overflow-wrap:anywhere]">
            Largest drop · {drop.site} · {drop.funnel}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-wall-list-line font-semibold">
            <span className="[overflow-wrap:anywhere]">{drop.drop.fromStep}</span>
            <ChevronRight aria-hidden className="size-5 shrink-0 text-muted-foreground" />
            <span className="sr-only">{" to "}</span>
            <span className="[overflow-wrap:anywhere]">{drop.drop.toStep}</span>
          </span>
          <span className="text-wall-list-meta tabular-nums text-muted-foreground">
            {[
              drop.drop.lostPeople !== null ? `${formatInt(drop.drop.lostPeople)} ${drop.drop.lostPeople === 1 ? "person" : "people"} left` : null,
              drop.drop.stepConversion !== null ? `${Math.round(drop.drop.stepConversion * 100)}% went on` : null,
            ].filter((part): part is string => part !== null).join(" · ") || "Not counted yet"}
          </span>
        </div>
      ) : null}
    </section>
  );
}
