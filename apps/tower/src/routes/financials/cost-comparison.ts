import { majorToMinorUnits, minorToMajorUnits } from "@noticeos/contract/money";
import { PERIOD_PATTERN, type FinancialCostLine, type RecurringCost } from "@shared/financials";
import { integrationLabel } from "@shared/integrations";

export function previousCostPeriod(period: string): string | null {
  if (!PERIOD_PATTERN.test(period)) return null;
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5));
  if (month === 1 && year === 0) return null;
  return month === 1 ? `${String(year - 1).padStart(4, "0")}-12` : `${period.slice(0, 4)}-${String(month - 1).padStart(2, "0")}`;
}

export function costSourceLabel(source: string | null, recurringCosts: readonly RecurringCost[]): string | null {
  if (source === null) return null;
  if (source.startsWith("recurring:")) {
    const id = source.slice("recurring:".length);
    return recurringCosts.find((cost) => cost.id === id)?.label ?? id;
  }
  if (source.startsWith("metered:")) {
    const id = source.slice("metered:".length);
    return integrationLabel(id, id);
  }
  if (source === "domains") return "Domain orders";
  return source;
}

export interface CostChange {
  key: string;
  source: string | null;
  family: string;
  currency: string;
  previous: number | null;
  current: number | null;
  difference: number | null;
}

function recordedMinor(lines: readonly FinancialCostLine[], currency: string): number | null {
  if (lines.length === 0 || lines.some((line) => line.rows <= 0)) return null;
  const amounts = lines.map((line) => majorToMinorUnits(line.amount, currency));
  if (amounts.some((amount) => !Number.isSafeInteger(amount))) return null;
  const total = amounts.reduce((sum, amount) => sum + BigInt(amount), 0n);
  return total >= -BigInt(Number.MAX_SAFE_INTEGER) && total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

function amounts(previousLines: readonly FinancialCostLine[], currentLines: readonly FinancialCostLine[], currency: string) {
  const previous = recordedMinor(previousLines, currency);
  const current = recordedMinor(currentLines, currency);
  const difference = previous !== null && current !== null && Number.isSafeInteger(current - previous) ? current - previous : null;
  const major = (value: number | null) => value === null ? null : minorToMajorUnits(value, currency);
  return { previous: major(previous), current: major(current), difference: major(difference) };
}

/** Absence is not evidence of zero. Only two recorded amounts support a source difference. */
export function compareRecordedCosts(previous: readonly FinancialCostLine[], current: readonly FinancialCostLine[]) {
  const groups = new Map<string, { line: FinancialCostLine; previous: FinancialCostLine[]; current: FinancialCostLine[] }>();
  for (const [side, lines] of [["previous", previous], ["current", current]] as const) {
    for (const line of lines) {
      const key = JSON.stringify([line.source, line.family, line.currency]);
      const group = groups.get(key) ?? { line, previous: [], current: [] };
      group[side].push(line);
      groups.set(key, group);
    }
  }
  const rows: CostChange[] = [...groups].map(([key, group]) => ({
    key, source: group.line.source, family: group.line.family, currency: group.line.currency,
    ...amounts(group.previous, group.current, group.line.currency),
  }));
  rows.sort((a, b) => {
    if (a.difference === null && b.difference !== null) return 1;
    if (b.difference === null && a.difference !== null) return -1;
    return Math.abs(b.difference ?? 0) - Math.abs(a.difference ?? 0) || a.key.localeCompare(b.key);
  });
  const currencies = [...new Set([...previous, ...current].map((line) => line.currency))].sort();
  const totals = currencies.map((currency) => ({ currency, ...amounts(
    previous.filter((line) => line.currency === currency), current.filter((line) => line.currency === currency), currency,
  ) }));
  return { rows, totals };
}
