import type { ReactNode } from "react";
import type { SeriesPointOrGap } from "@shared/surface";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { Sparkline, type SeriesTone } from "@/components/surface/Sparkline";
import { cn } from "@/lib/utils";

/** The same static map `KpiStrip` uses, and for the same reason: Tailwind reads
 * source text, so a class assembled at runtime generates no CSS. doc 14's
 * strips are rows of five or six; a phone gets two. */
const COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 sm:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
  6: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6",
};

export interface SmallMultipleStripProps {
  children: ReactNode;
  columns?: number;
  className?: string;
}

/**
 * A row of comparable measures in ONE bordered strip (doc 14).
 *
 * *Registry justification:* the asset page drew five product-use figures as
 * five separate cards, each with its own border, heading and subtitle — five
 * boundaries around five numbers that are only interesting beside each other.
 * The strip is the boundary; the cells are hairlines. It carries the border
 * `KpiStrip` deliberately does not, because a small-multiple row stands on its
 * own under a section eyebrow rather than fusing to a chart.
 */
export function SmallMultipleStrip({
  children,
  columns = 5,
  className,
}: SmallMultipleStripProps) {
  return (
    <div
      className={cn(
        "grid gap-px overflow-hidden rounded-[10px] border border-border bg-border/60",
        COLUMNS[columns] ?? COLUMNS[5],
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface SmallMultipleProps {
  label: ReactNode;
  /** Pre-formatted — the one figure this cell is about. */
  value: ReactNode;
  /** The headline's own unit/window, not its comparison. */
  valueCaption?: ReactNode;
  /** Explicit comparison, including its window or denominator. */
  secondary?: ReactNode;
  secondaryBelow?: boolean;
  spark?: readonly SeriesPointOrGap[];
  sparkAverage?: boolean;
  /** Visible quantity and date range for a standalone trend. */
  sparkCaption?: ReactNode;
  sparkTone?: SeriesTone;
  format?: (value: number) => string;
  className?: string;
}

/**
 * One cell of a `SmallMultipleStrip`: a label, a figure, what it is against,
 * and the shape behind it. The sparkline is full-width and filled here — at
 * this size the area is what makes five cells comparable at a glance, which is
 * the whole reason they are drawn as a row rather than a list.
 */
export function SmallMultiple({
  label,
  value,
  valueCaption,
  secondary,
  secondaryBelow = false,
  spark,
  sparkAverage = true,
  sparkCaption,
  sparkTone = "neutral",
  format,
  className,
}: SmallMultipleProps) {
  return (
    <div className={cn("grid content-start gap-1 bg-card p-4", className)}>
      <span className={eyebrowClass}>
        {label}
      </span>
      <span className="text-xl font-semibold tabular-nums text-foreground">
        {value}
        {valueCaption ? <span className="ms-1.5 text-xs font-medium text-muted-foreground">{valueCaption}</span> : null}
        {secondary && !secondaryBelow ? (
          <span className="ms-1.5 text-xs font-medium tracking-normal text-muted-foreground">
            {secondary}
          </span>
        ) : null}
      </span>
      {secondary && secondaryBelow ? <div className="text-xs tabular-nums text-muted-foreground">{secondary}</div> : null}
      {spark && spark.length > 0 ? (
        <Sparkline
          data={spark}
          size="wide"
          tone={sparkTone}
          area
          average={sparkAverage}
          readout
          format={format}
          ariaLabel={`${typeof label === "string" ? label : "measure"} trend`}
          className="mt-1"
        />
      ) : null}
      {sparkCaption ? <div className="text-xs tabular-nums text-muted-foreground">{sparkCaption}</div> : null}
    </div>
  );
}
