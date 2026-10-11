import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { DeltaChip, performanceTone } from "@/components/DeltaChip";
import { formatPercent } from "@/lib/format";
import { useTweenedNumber } from "@/lib/use-tweened-number";
import { cn } from "@/lib/utils";

// A figure at tile scale with everything that makes it readable at a glance:
// what it measures and over which window, the figure, how it compares with a
// named baseline, its recent history, and one context line. The top rule says
// the tile's role on the screen (context, a problem, a win, money, people), so
// a row of tiles reads as an argument rather than a row of equal boxes.

export type StatRole = "context" | "problem" | "warning" | "good" | "money" | "people";

const RULE: Record<StatRole, string> = {
  context: "before:bg-foreground/25",
  problem: "before:bg-error",
  warning: "before:bg-warn",
  good: "before:bg-milestone",
  money: "before:bg-financial-revenue",
  people: "before:bg-traffic",
};

const FIGURE_INK: Partial<Record<StatRole, string>> = {
  problem: "text-error",
  warning: "text-warn",
};

export interface StatComparison {
  /** Signed percent change; null when only an absolute change is known. */
  percent: number | null;
  /** Signed absolute change, formatted by the tile's `format`. */
  change: number;
  /** The baseline in words: "vs Tue last week", "vs usual". */
  against: string;
  /** Which direction is good; `none` colours nothing. */
  improvement?: "up" | "down" | "none";
  /** False when the two sides cannot be compared: no colour, no number. */
  comparable?: boolean;
}

export interface StatTileProps {
  /** The measure and its window: "Revenue, yesterday". */
  label: string;
  /** The figure as a number, so it can count to a new reading; null names an absence. */
  value: number | null;
  format: (value: number) => string;
  /** Why there is no figure, in the operator's words: "not reported yet". */
  absent?: string;
  /** A qualifier set a step lighter after the figure: "est.", "of 38". */
  note?: ReactNode;
  comparison?: StatComparison | null;
  /** The recent history (a `BarStrip` or `Sparkline`). */
  history?: ReactNode;
  /** One line of context; bold the key values in it. */
  context?: ReactNode;
  role?: StatRole;
  size?: "display" | "figure";
  /** The whole tile opens this. */
  to?: string;
  className?: string;
}

export function StatTile({
  label,
  value,
  format,
  absent = "not reported yet",
  note,
  comparison,
  history,
  context,
  role = "context",
  size = "figure",
  to,
  className,
}: StatTileProps) {
  const body = (
    <>
      <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {value === null ? (
          <span className="text-sm font-medium text-muted-foreground" data-stat-absent="">
            {absent}
          </span>
        ) : (
          <TweenedFigure value={value} format={format} className={cn(size === "display" ? "text-display" : "text-figure", "tabular-nums", FIGURE_INK[role] ?? "text-foreground")} />
        )}
        {value !== null && note ? <span className="text-sm font-medium text-muted-foreground">{note}</span> : null}
        {value !== null && comparison ? <Comparison comparison={comparison} format={format} /> : null}
      </span>
      {history ? <div className="mt-1">{history}</div> : null}
      {context ? <span className="text-xs leading-snug text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">{context}</span> : null}
    </>
  );

  const shell = cn(
    "relative flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-lg bg-card p-4 ring-1 ring-border/70",
    "before:absolute before:inset-x-0 before:top-0 before:h-0.5",
    RULE[role],
    className,
  );
  const marks = { "data-stat": label, "data-stat-role": role };
  return to ? (
    <Link to={to} {...marks} className={cn(shell, "outline-none hover:ring-foreground/30 focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-shadow")}>
      {body}
    </Link>
  ) : (
    <div {...marks} className={shell}>
      {body}
    </div>
  );
}

/** Counts to a new reading; cents count as whole cents, so money tweens too. */
function TweenedFigure({ value, format, className }: { value: number; format: (value: number) => string; className?: string }) {
  const hundredths = useTweenedNumber(Math.round(value * 100));
  return (
    <span className={className} data-stat-figure="">
      {format(hundredths / 100)}
    </span>
  );
}

function Comparison({ comparison, format }: { comparison: StatComparison; format: (value: number) => string }) {
  const { percent, change, against, improvement = "up", comparable = true } = comparison;
  if (!comparable) {
    return <span className="text-xs font-medium text-muted-foreground">not comparable {against}</span>;
  }
  const magnitude = percent ?? change;
  const good = improvement === "none" ? 0 : improvement === "up" ? Math.sign(magnitude) : -Math.sign(magnitude);
  const tone = percent === null || good === 0 ? "neutral" : performanceTone(good * Math.abs(percent));
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <DeltaChip
        value={magnitude}
        render={(n) => (percent === null ? format(n) : `${formatPercent(n)}%`)}
        tone={tone}
        meaning={`${percent === null ? format(Math.abs(change)) : `${formatPercent(Math.abs(percent))}%`} ${magnitude >= 0 ? "up" : "down"} ${against}`}
        className="text-xs"
      />
      <span className="text-xs text-muted-foreground">{against}</span>
    </span>
  );
}
