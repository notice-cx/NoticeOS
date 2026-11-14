import { minorToMajorUnits } from "@noticeos/contract/money";
import { STRIPE_REVENUE_SOURCE } from "@noticeos/contract/revenue-sources";
import type { DailyRevenueHistory } from "@shared/daily-revenue";
import { costFamilyLabel, REVENUE_FAMILY_LABEL, type MoneySourceLine } from "@shared/financials";
import type { SeriesPoint } from "@shared/wall";

export interface MoneyChartSource {
  id: string;
  name: string;
  tone: string;
}

const sourceColors = ["text-asset-3", "text-asset-4", "text-asset-5", "text-asset-6"] as const;

function sourceTone(id: string): string {
  const code = Array.from(id).reduce((hash, char) => (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0, 0);
  return sourceColors[code % sourceColors.length]!;
}

export function revenueChartSource(source: string, label: string): MoneyChartSource {
  if (source === STRIPE_REVENUE_SOURCE) return { id: source, name: "Stripe", tone: "text-asset-2" };
  if (source === "mediavine" || source === "mediavine-journey") return { id: source, name: label, tone: source === "mediavine" ? "text-financial-revenue" : "text-asset-1" };
  return { id: source, name: label, tone: sourceTone(source) };
}

export const totalSources = {
  revenue: { id: "total:revenue", name: "Revenue", tone: "text-financial-revenue" },
  cost: { id: "total:cost", name: "Cost", tone: "text-financial-cost" },
} as const satisfies Record<MoneySourceLine["kind"], MoneyChartSource>;

export function ledgerChartSource(line: MoneySourceLine, costName?: string | null): MoneyChartSource {
  if (line.kind === "revenue" && line.source) return revenueChartSource(line.source, line.label ?? line.source);
  const id = JSON.stringify([line.kind, line.source ?? null, line.source ? null : line.family]);
  const name = line.kind === "cost" ? costName ?? line.source ?? costFamilyLabel(line.family)
    : REVENUE_FAMILY_LABEL[line.family] ?? line.family;
  return { id, name, tone: sourceTone(id) };
}

export function chartSources(sources: readonly MoneyChartSource[]): MoneyChartSource[] {
  const unique = [...new Map(sources.map(source => [source.id, source])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const used = new Set<string>();
  const byName = new Map<string, number>();
  for (const source of unique) byName.set(source.name, (byName.get(source.name) ?? 0) + 1);
  return unique.map(source => {
    const tone = used.has(source.tone) ? sourceColors.find(color => !used.has(color)) ?? source.tone : source.tone;
    used.add(tone);
    return { ...source, tone, name: byName.get(source.name)! > 1 ? `${source.name} (${unique.filter(other => other.name === source.name).indexOf(source) + 1})` : source.name };
  });
}

export function dailyChartSources(history: DailyRevenueHistory, from = history.from, to = history.to) {
  const bySource = history.bySource ?? [];
  if (new Set(bySource.map(source => source.currency)).size !== 1 || !history.days.length) return [];
  const reported = new Set(history.days.map(day => day.date));
  const series = bySource.flatMap(source => {
    const points: SeriesPoint[] = source.days
      .filter(day => day.date >= from && day.date <= to && reported.has(day.date))
      .map(day => ({ t: day.date, v: minorToMajorUnits(day.amountMinor, source.currency) }));
    return points.length ? [{ ...revenueChartSource(source.source, source.displayName), points }] : [];
  });
  return chartSources(series).map(source => ({ ...source, points: series.find(one => one.id === source.id)!.points }));
}
