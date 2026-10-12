import type { CSSProperties, ReactNode } from "react";
import { formatInt, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

// A count that narrows step by step, as bars on one ruler: tracked → inside
// the top 20 → top 10 → top 3, pitched → opened → replied → won. Each bar is
// its step's share of the first, so where the count falls away is a length
// before it is a number; the figure rides the end of its row with its share
// of the step before. A step nobody measured is a hatched track, never a zero.

export interface FunnelStep {
  key: string;
  label: ReactNode;
  /** null: not measured, drawn hatched with `note` saying why. */
  value: number | null;
  /** A short qualifier after the figure: "of 5 checked", "not checked". */
  note?: ReactNode;
  /** The fill's token class; neutral ink by default. */
  fill?: string;
  marks?: Record<`data-${string}`, string>;
}

export interface FunnelBarsProps {
  steps: readonly FunnelStep[];
  /** The ruler's full length; the first step's value by default. */
  max?: number;
  format?: (value: number) => string;
  /** Print each step's share of the step before beside its figure. */
  shares?: boolean;
  /** What the funnel shows, for a reader who cannot see the bars. */
  ariaLabel: string;
  className?: string;
}

export function FunnelBars({ steps, max, format = formatInt, shares = false, ariaLabel, className }: FunnelBarsProps) {
  const top = Math.max(max ?? steps.find((step) => step.value !== null)?.value ?? 0, 1);
  return (
    <ol aria-label={ariaLabel} data-funnel-bars="" className={cn("@container m-0 grid list-none gap-2 p-0", className)}>
      {steps.map((step, index) => {
        const before = index === 0 ? null : steps[index - 1]!.value;
        const share = shares && step.value !== null && before !== null && before > 0 ? step.value / before : null;
        return (
          <li
            key={step.key}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 @md:grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)_minmax(5.5rem,auto)]"
            data-funnel-step={step.key}
            {...step.marks}
          >
            <span className="min-w-0 text-xs text-foreground">{step.label}</span>
            <span aria-hidden className={cn("col-span-2 row-start-2 h-2 overflow-hidden rounded-full @md:col-span-1 @md:row-start-auto", step.value === null ? "text-muted-foreground/50 viz-hatch" : "bg-viz-track")}>
              {step.value !== null && step.value > 0 ? (
                <span
                  className={cn("viz-grow-x block h-full rounded-full", step.fill ?? "bg-foreground/50")}
                  style={{ width: `${Math.max(2, Math.min(100, (step.value / top) * 100))}%`, "--viz-i": index } as CSSProperties}
                />
              ) : null}
            </span>
            <span className="col-start-2 row-start-1 flex items-baseline justify-end gap-1.5 whitespace-nowrap text-xs tabular-nums text-muted-foreground @md:col-start-auto @md:row-start-auto">
              <span className="text-sm font-semibold text-foreground">{step.value === null ? "—" : format(step.value)}</span>
              {step.note ? <span>{step.note}</span> : null}
              {share !== null ? <span>{formatPercent(share * 100)}%</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
