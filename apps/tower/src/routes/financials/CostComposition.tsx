import { sumMoneyFigures } from "@noticeos/contract/money";
import { useId, useState, type CSSProperties } from "react";
import { PROVENANCE_LABEL, costFamilyLabel, type CostProvenance, type FinancialCostLine, type RecurringCost } from "@shared/financials";
import { ChevronRight } from "lucide-react";
import { CostComparison } from "./CostComparison";
import { costSourceLabel } from "./cost-comparison";
import { StateChip, type StateChipProps, type StatusSubject } from "@/components/StateChip";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { formatMoney, formatPeriodMonthLong } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * How a cost figure came to be known, as a glyph. All four faces stay in the
 * quiet half of the palette: provenance is not severity. They separate on
 * weight and on the dot's shape rather than on hue, so the ladder reads the
 * same on a grayscale screen, from measured down to unaccounted-for.
 */
const PROVENANCE_CHIP: Readonly<Record<CostProvenance, Pick<StateChipProps, "tone" | "dot" | "attention">>> = Object.freeze({
  metered: { tone: "neutral", dot: "solid" },
  stated: { tone: "affirmative", dot: "solid" },
  amortized: { tone: "na", dot: "solid" },
  unclassified: { tone: "na", dot: "hollow", attention: true },
});

function ProvenanceChip({ provenance, subject }: { provenance: CostProvenance; subject: StatusSubject }) {
  const face = PROVENANCE_CHIP[provenance];
  return <StateChip subject={subject} label={PROVENANCE_LABEL[provenance]} tone={face.tone} dot={face.dot} attention={face.attention ?? false} />;
}

/**
 * The cost side of the month's equation, opened up: each line ranked by what
 * it costs, its length the share of the month's cost, with what it is for and
 * how the figure came to be known. Neutral ink throughout: a cost is not a
 * verdict, and only a line with no source asks to be looked at.
 */
export function CostComposition({
  lines,
  recurringCosts,
  period,
  className,
}: {
  lines: readonly FinancialCostLine[];
  recurringCosts: readonly RecurringCost[];
  period: string;
  className?: string;
}) {
  const id = useId();
  const comparisonId = useId();
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const total = sumMoneyFigures(lines.map((line) => ({ currency: line.currency, revenue: 0, cost: line.amount, net: -line.amount })));
  const ranked = [...lines].sort((a, b) => b.amount - a.amount);
  return (
    <section aria-labelledby={id} data-cost-composition="" className={cn("@container flex min-w-0 flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-border/70", className)}>
      <SectionLabel
        id={id}
        title="Where the cost goes"
        caption={<span className="tabular-nums">{formatMoney(total.cost, total.currency, { cents: true })} in {formatPeriodMonthLong(period)}</span>}
      />
      <ul className="m-0 grid list-none gap-x-10 gap-y-3.5 p-0 @2xl:grid-cols-2">
        {ranked.map((line, index) => {
          const share = total.currency !== null && total.currency === line.currency && total.cost ? line.amount / total.cost : null;
          // A line with no source is named by what it is for; its chip says the rest.
          const named = costSourceLabel(line.source, recurringCosts);
          const family = costFamilyLabel(line.family);
          const label = named ?? family;
          return (
            <li key={`${line.family}:${line.source ?? "none"}:${line.currency}`} className="flex min-w-0 flex-col gap-1.5" data-cost-line={line.source ?? ""} data-cost-line-family={line.family}>
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0 break-words text-sm font-medium text-foreground" title={label} data-cost-source={line.source ?? ""}>
                  {label}
                  {line.rows > 1 ? <span className="ms-1.5 text-xs font-normal tabular-nums text-muted-foreground">×{line.rows}</span> : null}
                </span>
                <span className="shrink-0 text-sm tabular-nums text-foreground">{formatMoney(line.amount, line.currency, { cents: true })}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2.5">
                <span aria-hidden className="h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-viz-track">
                  {share !== null ? (
                    <span className="viz-grow-x block h-full rounded-full bg-foreground/45" style={{ width: `${Math.max(2, share * 100)}%`, "--viz-i": index } as CSSProperties} />
                  ) : null}
                </span>
                {named !== null ? <span className="shrink-0 text-micro whitespace-nowrap text-muted-foreground" data-cost-family={line.family}>{family}</span> : null}
                <span className="shrink-0" data-cost-type="">
                  <ProvenanceChip provenance={line.provenance} subject={`cost:${line.family}:${line.source ?? "none"}`} />
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-border/60 pt-2">
        <button
          type="button"
          aria-expanded={comparisonOpen}
          aria-controls={comparisonId}
          onClick={() => setComparisonOpen((open) => !open)}
          className="flex min-h-11 w-full items-center gap-2 rounded-md text-start text-sm font-medium outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight aria-hidden className={cn("size-4 shrink-0", comparisonOpen && "rotate-90")} />
          Compare with previous month
        </button>
        <div id={comparisonId}>
          {comparisonOpen ? <CostComparison key={period} period={period} lines={lines} recurringCosts={recurringCosts} /> : null}
        </div>
      </div>
    </section>
  );
}
