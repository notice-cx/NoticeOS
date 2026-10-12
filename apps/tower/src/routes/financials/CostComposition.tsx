import { sumMoneyFigures } from "@noticeos/contract/money";
import { useId, type CSSProperties } from "react";
import { PROVENANCE_LABEL, type CostProvenance, type FinancialCostLine, type RecurringCost } from "@shared/financials";
import { integrationLabel } from "@shared/integrations";
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
 * Where a cost line came from, named the way the operator names it: the
 * subscription's own label, the provider's product name for a metered bill,
 * "Domain orders" for the amortized terms. The store's keys are how the rows
 * are filed, not how anyone says them.
 */
function costSourceLabel(source: string | null, recurringCosts: readonly RecurringCost[]): string | null {
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
          const label = named ?? line.family;
          return (
            <li key={`${line.family}:${line.source ?? "none"}:${line.currency}`} className="flex min-w-0 flex-col gap-1.5" data-cost-line={line.source ?? ""}>
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
                {named !== null ? <span className="shrink-0 text-micro whitespace-nowrap text-muted-foreground" data-cost-family="">{line.family}</span> : null}
                <span className="shrink-0" data-cost-type="">
                  <ProvenanceChip provenance={line.provenance} subject={`cost:${line.family}:${line.source ?? "none"}`} />
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
