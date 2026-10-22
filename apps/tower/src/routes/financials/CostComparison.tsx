import { costFamilyLabel, type FinancialCostLine, type RecurringCost } from "@shared/financials";
import { useFinancials } from "@/hooks/useFinancials";
import { formatMoney, formatSignedMoney, formatPeriodMonthYear } from "@/lib/format";
import { compareRecordedCosts, costSourceLabel, previousCostPeriod } from "./cost-comparison";

function ComparisonAmounts({ previous, current, difference, currency }: {
  previous: number | null; current: number | null; difference: number | null; currency: string;
}) {
  return <dl className="grid min-w-0 grid-cols-3 gap-2 text-xs tabular-nums">
    {([["Previous", previous], ["Current", current], ["Difference", difference]] as const).map(([label, amount]) => (
      <div key={label} className="min-w-0">
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="m-0 break-words text-foreground">
          {amount === null ? label === "Difference" ? "Unavailable" : "No record" : label === "Difference" ? formatSignedMoney(amount, currency, { cents: true }) : formatMoney(amount, currency, { cents: true })}
        </dd>
      </div>
    ))}
  </dl>;
}

/** Mounted only by the open disclosure; the normal owner-bound month query owns its cache. */
export function CostComparison({ period, lines, recurringCosts }: {
  period: string; lines: readonly FinancialCostLine[]; recurringCosts: readonly RecurringCost[];
}) {
  const previousPeriod = previousCostPeriod(period);
  return previousPeriod === null ? <p className="text-sm text-muted-foreground">Previous month unavailable.</p>
    : <PreviousMonth key={previousPeriod} period={period} previousPeriod={previousPeriod} lines={lines} recurringCosts={recurringCosts} />;
}

function PreviousMonth({ period, previousPeriod, lines, recurringCosts }: {
  period: string; previousPeriod: string; lines: readonly FinancialCostLine[]; recurringCosts: readonly RecurringCost[];
}) {
  const history = useFinancials(previousPeriod);
  const previousLabel = formatPeriodMonthYear(previousPeriod);
  if (history.isError) return <p role="status" data-status-for={`cost-comparison:${previousPeriod}`} className="text-sm text-muted-foreground">Previous month unavailable. Differences cannot be calculated.</p>;
  if (history.isPending || history.isPlaceholderData) return <p role="status" data-status-for={`cost-comparison:${previousPeriod}`} className="text-sm text-muted-foreground">Loading {previousLabel} costs…</p>;
  const data = history.data;
  if (!data || data.empty || data.period !== previousPeriod || !data.periods.includes(previousPeriod)) {
    return <p role="status" data-status-for={`cost-comparison:${previousPeriod}`} className="text-sm text-muted-foreground">No history for {previousLabel}. Differences unavailable.</p>;
  }
  if (data.costLines.length === 0 || lines.length === 0) {
    return <p role="status" data-status-for={`cost-comparison:${previousPeriod}`} className="text-sm text-muted-foreground">No cost records for {data.costLines.length === 0 ? previousLabel : formatPeriodMonthYear(period)}. Differences unavailable.</p>;
  }
  const comparison = compareRecordedCosts(data.costLines, lines);
  return <div className="flex min-w-0 flex-col gap-4 pt-2" data-cost-comparison="">
    <p className="m-0 text-xs text-muted-foreground">
      Previous: {previousLabel}. Current: {formatPeriodMonthYear(period)}.
      {period === data.currentPeriod ? " Month-to-date costs against the complete previous calendar month." : " Recorded costs for two complete calendar months."}
    </p>
    <ul aria-label="Cost changes by source" className="m-0 grid list-none gap-4 p-0">
      {comparison.rows.map((row) => <li key={row.key} className="min-w-0" data-cost-change={row.key}>
        <div className="mb-1.5 min-w-0 break-words text-sm font-medium">
          {costSourceLabel(row.source, [...recurringCosts, ...data.recurringCosts]) ?? "No source"}
          <span className="block text-xs font-normal text-muted-foreground">{costFamilyLabel(row.family)} · {row.currency}</span>
        </div>
        <ComparisonAmounts {...row} />
      </li>)}
    </ul>
    <div className="grid gap-3 border-t border-border/60 pt-3" aria-label="Recorded cost totals">
      {comparison.totals.map((total) => <div key={total.currency}>
        <p className="mb-1.5 mt-0 text-sm font-medium">Total · {total.currency}</p>
        <ComparisonAmounts {...total} />
      </div>)}
    </div>
    <p className="m-0 text-xs text-muted-foreground">Largest recorded differences first. No record means unknown, so added or absent sources have no calculated difference.</p>
  </div>;
}
