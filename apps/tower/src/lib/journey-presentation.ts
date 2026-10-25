import { journeyDefinitionId, type JourneyDefinition, type JourneyFunnelResult, type JourneyPeriod } from "@noticeos/contract/journeys";

export interface JourneyReading {
  counts: number[];
  rate: number | null;
  largestLoss: number | null;
  reason: string | null;
  visitors: number | null;
  visitorReason: string | null;
  rateBasis: "visitors" | "entrants";
}

/** Ordered completion and reach use distinct, explicitly labelled denominators. */
export function journeyReading(definition: JourneyDefinition, period: JourneyPeriod | null): JourneyReading {
  const missing = { counts: [], rate: null, largestLoss: null, visitors: null, visitorReason: null, rateBasis: "entrants" as const };
  if (definition.kind === "exploration") return { ...missing, reason: "Session paths require separate collection." };
  if (!period) return { ...missing, reason: "No ordered report has been collected for this period." };
  if (!period.complete || period.quality !== "complete") return { ...missing, reason: period.reason ?? (period.quality === "sampled" ? "This report is sampled. Conversion comparisons are unavailable." : "This period has no complete ordered report.") };
  if (period.steps.length !== definition.steps.length || period.steps.some((step, i) => step.id !== definition.steps[i]?.id || step.users === null || step.users < 0 || (i > 0 && step.users > (period.steps[i - 1]?.users ?? -1)))) {
    return { ...missing, reason: "These step counts cannot be compared." };
  }
  const counts = period.steps.map((step) => step.users!);
  const baseline = period.visitors;
  const visitors = baseline?.quality === "complete" && baseline.users !== null && Number.isSafeInteger(baseline.users) && baseline.users >= counts[0]! ? baseline.users : null;
  const visitorReason = visitors !== null ? null : baseline?.reason ?? (baseline?.quality === "sampled" ? "The visitor total is sampled." : baseline ? "The visitor total cannot be compared with this journey." : "Visitor totals were not collected for this report.");
  const denominator = visitors ?? counts[0]!;
  let largestLoss: number | null = null;
  for (let i = 1; i < counts.length; i++) if (counts[i - 1]! - counts[i]! > 0 && (largestLoss === null || counts[i - 1]! - counts[i]! > counts[largestLoss - 1]! - counts[largestLoss]!)) largestLoss = i;
  return { counts, visitors, visitorReason, rateBasis: visitors === null ? "entrants" : "visitors", rate: denominator > 0 ? counts.at(-1)! / denominator * 100 : null, largestLoss, reason: counts[0] === 0 ? "No people entered this journey in this period." : null };
}

export function matchingJourneyResult(definition: JourneyDefinition, results: readonly JourneyFunnelResult[]): JourneyFunnelResult | null {
  return results.find((result) => result.journeyId === definition.id && result.definitionId === journeyDefinitionId(definition)) ?? null;
}

export function previousJourneyWeek(period: JourneyPeriod, weeks: readonly JourneyPeriod[]): JourneyPeriod | null {
  const before = new Date(`${period.startDate}T00:00:00Z`).getTime() - 86_400_000;
  return weeks.find((week) => new Date(`${week.endDate}T00:00:00Z`).getTime() === before) ?? null;
}

export function journeyComparison(definition: JourneyDefinition, period: JourneyPeriod | null, prior: JourneyPeriod | null): number | null {
  if (!period || !prior) return null;
  const span = (p: JourneyPeriod) => Date.parse(p.endDate) - Date.parse(p.startDate);
  if (span(period) !== span(prior) || Date.parse(period.startDate) - Date.parse(prior.endDate) !== 86_400_000) return null;
  const reading = journeyReading(definition, period);
  const earlier = journeyReading(definition, prior);
  if (reading.rateBasis !== earlier.rateBasis) return null;
  const current = reading.rate;
  const before = earlier.rate;
  return current === null || before === null ? null : current - before;
}

export function journeyStepContinuation(definition: JourneyDefinition, period: JourneyPeriod | null, index: number): number | null {
  const counts = journeyReading(definition, period).counts;
  return index > 0 && counts[index] !== undefined && (counts[index - 1] ?? 0) > 0 ? counts[index]! / counts[index - 1]! * 100 : null;
}

export function journeyStepChange(definition: JourneyDefinition, period: JourneyPeriod | null, prior: JourneyPeriod | null, index: number): number | null {
  if (journeyComparison(definition, period, prior) === null) return null;
  const rate = journeyStepContinuation(definition, period, index);
  const before = journeyStepContinuation(definition, prior, index);
  return rate === null || before === null ? null : rate - before;
}

export function journeyWindow(definition: JourneyDefinition): string {
  const limits = definition.steps.slice(1).map((step) => step.withinSeconds).filter((value): value is number => value !== undefined);
  if (limits.length === 0) return "In order · no step time limit";
  const label = (seconds: number) => seconds % 86_400 === 0 ? `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}` : seconds % 3_600 === 0 ? `${seconds / 3_600} hours` : `${seconds} seconds`;
  return limits.every((value) => value === limits[0]) && limits.length === definition.steps.length - 1 ? `In order · each next step within ${label(limits[0]!)}` : "In order · step time limits in Definition";
}

/** Reach shares the funnel's visitor or entrant denominator at every step. */
export function journeyStepReach(definition: JourneyDefinition, period: JourneyPeriod | null, index: number): number | null {
  const reading = journeyReading(definition, period);
  const count = reading.counts[index];
  const denominator = reading.visitors ?? reading.counts[0] ?? 0;
  return count === undefined || denominator <= 0 ? null : count / denominator * 100;
}

export function journeyStepReachChange(definition: JourneyDefinition, period: JourneyPeriod | null, prior: JourneyPeriod | null, index: number): number | null {
  if (journeyComparison(definition, period, prior) === null) return null;
  const rate = journeyStepReach(definition, period, index);
  const before = journeyStepReach(definition, prior, index);
  return rate === null || before === null ? null : rate - before;
}

/** Rounded bounds keep small percentage changes visible without hiding the scale. */
export function journeyRateDomain(rates: readonly (number | null)[]): { min: number; max: number; ticks: number[] } {
  const values = rates.filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0 && value <= 100);
  if (values.length === 0 || values.every((value) => value === 0)) return { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const low = Math.min(...values), high = Math.max(...values);
  const spread = high - low;
  const padding = spread > 0 ? spread * 0.12 : high * 0.05;
  const target = (spread + padding * 2) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const step = [1, 2, 2.5, 5, 10].map((size) => size * magnitude).reduce((best, size) => Math.abs(size - target) < Math.abs(best - target) ? size : best);
  const rounded = (value: number) => Number(value.toPrecision(12));
  const min = rounded(Math.max(0, Math.floor((low - padding) / step) * step));
  const max = rounded(Math.min(100, Math.ceil((high + padding) / step) * step));
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => rounded(min + index * step));
  return { min, max, ticks };
}
