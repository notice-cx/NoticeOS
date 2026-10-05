import type { AssetCard, CounterCard } from "@shared/wall";
import type { WallWidgetSettings } from "@shared/wall-layout";

export type WallPulseMetrics = WallWidgetSettings["pulseMetrics"];

/** The editor and TV resolve an absent choice the same way; [] means none. */
export function selectedPulseMetrics(asset: AssetCard, choices: WallPulseMetrics): readonly string[] {
  return choices && Object.hasOwn(choices, asset.id)
    ? choices[asset.id]!
    : asset.counters?.defaultMetrics ?? [];
}

/** Keep a saved choice editable if its source stops reporting that metric. */
export function availablePulseCounters(asset: AssetCard, choices: WallPulseMetrics): CounterCard[] {
  const cards = asset.counters?.cards ?? [];
  const known = new Set(cards.map((card) => card.metric));
  return [...cards, ...selectedPulseMetrics(asset, choices).filter((metric) => !known.has(metric)).map((metric) => ({
    metric, label: metric, value: null, observedAt: null, source: null,
  }))];
}

export function visiblePulseCounters(asset: AssetCard, choices: WallPulseMetrics): CounterCard[] {
  const cards = new Map((asset.counters?.cards ?? []).map((card) => [card.metric, card]));
  return selectedPulseMetrics(asset, choices).flatMap((metric) => {
    const card = cards.get(metric);
    return card?.value != null ? [card] : [];
  });
}
