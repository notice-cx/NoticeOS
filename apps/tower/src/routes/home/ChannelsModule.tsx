import type { CSSProperties } from "react";
import type { AssetCard, CardFunnelDrop, CardFunnelStep } from "@shared/wall";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { FunnelBars, type FunnelStep } from "@/components/viz/FunnelBars";
import { formatInt, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Rows drawn before the rest are summed into "Other". */
export const CHANNEL_ROWS = 5;

export interface ChannelShare {
  channel: string;
  sessions: number;
  /** This channel's share of every listed site's visits, 0–1. */
  share: number;
}

/**
 * Every listed site's visits by channel, summed by the channel's name, largest
 * first, with everything past the first five as one "Other" row. Null when no
 * site carries the split; shares are of the summed visits, never an average
 * of each site's shares.
 */
export function channelShares(cards: readonly AssetCard[]): ChannelShare[] | null {
  const sums = new Map<string, number>();
  let carried = false;
  for (const card of cards) {
    if (!card.channels) continue;
    carried = true;
    for (const row of card.channels.rows) sums.set(row.channel, (sums.get(row.channel) ?? 0) + row.sessions);
  }
  if (!carried) return null;
  const total = [...sums.values()].reduce((sum, value) => sum + value, 0);
  const share = (sessions: number) => (total > 0 ? sessions / total : 0);
  const ranked = [...sums.entries()]
    .map(([channel, sessions]) => ({ channel, sessions }))
    .sort((a, b) => b.sessions - a.sessions || a.channel.localeCompare(b.channel));
  const shown = ranked.slice(0, CHANNEL_ROWS).map((row) => ({ ...row, share: share(row.sessions) }));
  const rest = ranked.slice(CHANNEL_ROWS).reduce((sum, row) => sum + row.sessions, 0);
  return rest > 0 ? [...shown, { channel: "Other", sessions: rest, share: share(rest) }] : shown;
}

export interface WorstFunnel {
  site: string;
  name: string;
  drop: CardFunnelDrop;
  /** Every step in order; empty when the payload carried none. */
  steps: readonly CardFunnelStep[];
}

/** The declared funnel losing the most people at one step, across the listed
 * sites; a drop whose loss is unknown ranks below every counted one. */
export function worstFunnel(cards: readonly AssetCard[]): WorstFunnel | null {
  let worst: WorstFunnel | null = null;
  for (const card of cards) {
    const funnel = card.product?.funnel;
    if (!funnel?.largestDrop) continue;
    const lost = funnel.largestDrop.lostPeople ?? -1;
    if (worst === null || lost > (worst.drop.lostPeople ?? -1)) {
      worst = { site: card.displayName, name: funnel.name, drop: funnel.largestDrop, steps: funnel.steps ?? [] };
    }
  }
  return worst;
}

/** The two steps' counts, back from the people lost and the share that went
 * on; null when the reading did not carry both. */
function stepCounts(drop: CardFunnelDrop): { from: number; to: number } | null {
  const { lostPeople, stepConversion } = drop;
  if (lostPeople === null || stepConversion === null || stepConversion >= 1) return null;
  const from = Math.round(lostPeople / (1 - stepConversion));
  return { from, to: from - lostPeople };
}

/** The index of the step the most people leave before: the first step pair
 * whose labels are the drop's; null when the steps do not name it. */
export function dropStepIndex(worst: WorstFunnel): number | null {
  for (let index = 1; index < worst.steps.length; index++) {
    if (worst.steps[index - 1]!.label === worst.drop.fromStep && worst.steps[index]!.label === worst.drop.toStep) return index;
  }
  return null;
}

/** Every step of the funnel as bars, the step after the biggest drop in the
 * warning colour; the two steps around the drop when the payload carried no
 * steps. The drop's pair keeps the keys `from` and `to`. */
function funnelSteps(worst: WorstFunnel): FunnelStep[] | null {
  const at = dropStepIndex(worst);
  if (at !== null && worst.steps.length > 2) {
    return worst.steps.map((step, index) => ({
      key: index === at ? "to" : index === at - 1 ? "from" : `step-${index + 1}`,
      label: step.label,
      value: step.people,
      fill: index === at ? "bg-warn" : undefined,
    }));
  }
  const counts = stepCounts(worst.drop);
  return counts
    ? [
        { key: "from", label: worst.drop.fromStep, value: counts.from },
        { key: "to", label: worst.drop.toStep, value: counts.to, fill: "bg-warn" },
      ]
    : null;
}

function FunnelSide({ cards }: { cards: readonly AssetCard[] }) {
  const worst = worstFunnel(cards);
  if (!worst) {
    const read = cards.some((card) => card.product);
    return (
      <p className="m-0 text-sm text-muted-foreground" data-channels-funnel="none">
        {read ? "No funnel declared yet" : "Not joined yet"}
      </p>
    );
  }
  const steps = funnelSteps(worst);
  const whole = steps !== null && steps.length > 2;
  const between = whole ? `“${worst.drop.fromStep}” and “${worst.drop.toStep}”` : "these two steps";
  const sentence =
    worst.drop.lostPeople !== null
      ? `${formatInt(worst.drop.lostPeople)} ${worst.drop.lostPeople === 1 ? "person left" : "people left"} between ${between}.`
      : `The most people leave between ${between}.`;
  return (
    <div className="flex flex-col gap-2" data-channels-funnel={worst.name}>
      <span className="text-xs text-muted-foreground">
        {worst.site} · {worst.name}
      </span>
      {steps ? (
        <FunnelBars
          steps={steps}
          shares
          ariaLabel={whole ? `${worst.name}: every step, the one where the most people leave coloured` : `${worst.name}: the step where the most people leave`}
        />
      ) : (
        <p className="m-0 text-sm text-foreground">
          {worst.drop.fromStep} › {worst.drop.toStep}
        </p>
      )}
      <p className="m-0 text-sm text-foreground">{sentence}</p>
    </div>
  );
}

/**
 * Where visitors came from across the listed sites, each channel as its share
 * of the total, beside the one funnel that loses the most people at a step.
 */
export function ChannelsModule({ cards }: { cards: readonly AssetCard[] }) {
  const shares = channelShares(cards);
  return (
    <section aria-label="Where visitors come from" className="grid content-start gap-5 rounded-xl bg-card p-5 ring-1 ring-border/70 @container" data-home-channels="">
      <SectionLabel title="Where visitors come from · 4 weeks" />
      <div className="grid gap-5 @2xl:grid-cols-2">
        {shares === null || shares.length === 0 ? (
          <p className="m-0 text-sm text-muted-foreground" data-channels-empty="">Not joined yet</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-channels="">
            {shares.map((row, index) => (
              <li
                key={`${row.channel}:${index}`}
                className="grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)_3rem] items-center gap-3 text-xs"
                data-channel={row.channel}
                data-channel-share={row.share.toFixed(4)}
              >
                <span className="min-w-0 break-words text-foreground">{row.channel}</span>
                <span aria-hidden className="h-2 overflow-hidden rounded-full bg-viz-track">
                  <span
                    className={cn("viz-grow-x block h-full rounded-full", index === 0 ? "bg-traffic" : "bg-foreground/40")}
                    style={{ width: `${Math.max(2, Math.min(100, row.share * 100))}%`, "--viz-i": index } as CSSProperties}
                  />
                </span>
                <span className="text-end text-sm font-semibold tabular-nums text-foreground">{formatPercent(row.share * 100)}%</span>
              </li>
            ))}
          </ul>
        )}
        <FunnelSide cards={cards} />
      </div>
    </section>
  );
}
