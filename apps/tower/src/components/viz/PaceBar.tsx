import type { CSSProperties } from "react";
import { formatPercent, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

// Progress through a period, against the last one: the period so far as a
// filled bar, where the last period stood on the same day as a marker on it,
// the last period's whole total as the end of a ruled track, and a projection
// (when there is one) as a dashed run past the fill. "Are we on track this
// month" is then a position, not arithmetic.

export interface PaceBarProps {
  /** The period so far. */
  value: number;
  /** "Oct so far". */
  label: string;
  /** The last period at the same point, or null when it cannot be compared. */
  previousAtSameDay: number | null;
  /** The last period's whole total, or null when it is not known. */
  previousTotal: number | null;
  /** "Sep". */
  previousLabel: string;
  /** Where the period is heading, or null when no projection stands. */
  projected?: number | null;
  /** The series' identity ink: `text-financial-revenue`. */
  tone: string;
  format?: (value: number) => string;
  /** Off where the figure is already printed large beside the bar. */
  showValue?: boolean;
  className?: string;
}

export function PaceBar({
  value,
  label,
  previousAtSameDay,
  previousTotal,
  previousLabel,
  projected = null,
  tone,
  format = (amount) => formatUsd(amount),
  showValue = true,
  className,
}: PaceBarProps) {
  const top = Math.max(value, previousTotal ?? 0, projected ?? 0, 1) * 1.04;
  const at = (amount: number) => `${Math.min(100, (amount / top) * 100)}%`;
  const ahead = paceVerdict(value, previousAtSameDay);

  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-pace-bar="" data-pace={ahead?.direction ?? "unknown"}>
      <div
        role="img"
        aria-label={paceSummary({ value, label, previousAtSameDay, previousTotal, previousLabel, projected, format })}
        className={cn("relative h-7", tone)}
      >
        {/* The track runs to the last period's total: the whole of last month is the ruler. */}
        <span aria-hidden className="absolute inset-y-2 start-0 end-0 rounded-full bg-viz-track" />
        {projected !== null && projected > value ? (
          <span
            aria-hidden
            data-pace-projection=""
            className="absolute inset-y-2 rounded-e-full border border-dashed border-current/60 bg-current/10"
            style={{ insetInlineStart: at(value), width: `calc(${at(projected)} - ${at(value)})` }}
          />
        ) : null}
        <span
          aria-hidden
          data-pace-fill=""
          className="viz-grow-x viz-glow absolute inset-y-2 start-0 rounded-full bg-current"
          style={{ width: at(value) } as CSSProperties}
        />
        {previousAtSameDay !== null ? (
          <span aria-hidden data-pace-marker="" className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-foreground" style={{ insetInlineStart: at(previousAtSameDay) }} />
        ) : null}
        {previousTotal !== null ? (
          <span aria-hidden data-pace-total="" className="absolute inset-y-1 w-px -translate-x-1/2 bg-muted-foreground" style={{ insetInlineStart: at(previousTotal) }} />
        ) : null}
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs tabular-nums text-muted-foreground" aria-hidden>
        <span className="whitespace-nowrap">
          {showValue ? <>{label} <span className="font-medium text-foreground">{format(value)}</span></> : null}
          {previousAtSameDay !== null ? (
            <>
              {showValue ? " · " : null}
              <span className="me-1 inline-block h-2.5 w-0.5 rounded-full bg-foreground align-middle" />
              {previousLabel} by today {format(previousAtSameDay)}
            </>
          ) : null}
        </span>
        <span className="whitespace-nowrap">
          {projected !== null ? <>heading for <span className="font-medium text-foreground">{format(projected)}</span> · </> : null}
          {previousTotal !== null ? `${previousLabel} total ${format(previousTotal)}` : `${previousLabel} total not known`}
        </span>
      </div>
    </div>
  );
}

export interface PaceVerdict {
  direction: "ahead" | "behind" | "level";
  percent: number;
}

/** How far the period so far is from the last one at the same point, or null
 * when there is nothing to compare against. */
export function paceVerdict(value: number, previousAtSameDay: number | null): PaceVerdict | null {
  if (previousAtSameDay === null || previousAtSameDay <= 0) return null;
  const percent = ((value - previousAtSameDay) / previousAtSameDay) * 100;
  return { direction: Math.abs(percent) < 0.5 ? "level" : percent > 0 ? "ahead" : "behind", percent };
}

export function paceSummary({
  value,
  label,
  previousAtSameDay,
  previousTotal,
  previousLabel,
  projected,
  format,
}: Pick<PaceBarProps, "value" | "label" | "previousAtSameDay" | "previousTotal" | "previousLabel"> & {
  projected: number | null;
  format: (value: number) => string;
}): string {
  const verdict = paceVerdict(value, previousAtSameDay);
  const parts = [`${label} ${format(value)}`];
  if (verdict) {
    parts.push(
      verdict.direction === "level"
        ? `level with ${previousLabel} at the same day`
        : `${formatPercent(Math.abs(verdict.percent))}% ${verdict.direction} of ${previousLabel} at the same day (${format(previousAtSameDay!)})`,
    );
  } else {
    parts.push(`no ${previousLabel} figure to compare`);
  }
  if (projected !== null) parts.push(`heading for ${format(projected)}`);
  if (previousTotal !== null) parts.push(`${previousLabel} total ${format(previousTotal)}`);
  return parts.join("; ");
}
