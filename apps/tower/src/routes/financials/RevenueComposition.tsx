import { sumMoneyFigures } from "@noticeos/contract/money";
import { useId, type CSSProperties } from "react";
import { REVENUE_FAMILY_LABEL, type FinancialRevenueLine } from "@shared/financials";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { formatMoney, formatPeriodMonthLong } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A revenue family in the page's words; an unknown one as the ledger files it. */
export function revenueFamilyLabel(family: string): string {
  return REVENUE_FAMILY_LABEL[family] ?? family;
}

/**
 * The revenue side of the month, by source: each source ranked by what it
 * earned, its bar the share of the month's revenue in the same currency, with
 * its family in words. A source's name is its vocabulary row's; a row booked
 * with no source is named by its family.
 */
export function RevenueComposition({
  lines,
  period,
  className,
}: {
  lines: readonly FinancialRevenueLine[];
  period: string;
  className?: string;
}) {
  const id = useId();
  const total = sumMoneyFigures(lines.map((line) => ({ currency: line.currency, revenue: line.amount, cost: 0, net: line.amount })));
  const ranked = [...lines].sort((a, b) => b.amount - a.amount);
  return (
    <section aria-labelledby={id} data-revenue-composition="" className={cn("@container flex min-w-0 flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-border/70", className)}>
      <SectionLabel
        id={id}
        title="By source"
        caption={<span className="tabular-nums">{formatMoney(total.revenue, total.currency, { cents: true })} in {formatPeriodMonthLong(period)}</span>}
      />
      <ul className="m-0 grid list-none gap-x-10 gap-y-3.5 p-0 @2xl:grid-cols-2">
        {ranked.map((line, index) => {
          const share = total.currency !== null && total.currency === line.currency && total.revenue > 0 ? Math.max(0, line.amount) / total.revenue : null;
          const family = revenueFamilyLabel(line.family);
          const label = line.label ?? line.source ?? family;
          return (
            <li key={`${line.family}:${line.source ?? "none"}:${line.currency}`} className="flex min-w-0 flex-col gap-1.5" data-revenue-line={line.source ?? ""}>
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 break-words text-sm font-medium text-foreground" title={label}>
                  {label}
                  {line.rows > 1 ? <span className="ms-1.5 text-xs font-normal tabular-nums text-muted-foreground">×{line.rows}</span> : null}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-foreground">{formatMoney(line.amount, line.currency, { cents: true })}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2.5">
                <span aria-hidden className="h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-viz-track">
                  {share !== null ? (
                    <span className="viz-grow-x block h-full rounded-full bg-financial-revenue" style={{ width: `${Math.max(2, share * 100)}%`, "--viz-i": index } as CSSProperties} />
                  ) : null}
                </span>
                <span className="shrink-0 text-micro whitespace-nowrap text-muted-foreground" data-revenue-family={line.family}>{family}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
