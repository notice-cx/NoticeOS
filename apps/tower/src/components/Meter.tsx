import { cn } from "@/lib/utils";

export interface MeterProps {
  value: number;
  max: number;
  className?: string;
  /** Accessible label, e.g. "spend today vs daily cap". */
  ariaLabel?: string;
}

/** A token-driven progress bar (SYSTEM spend-today vs cap). Neutral fill until
 * it exceeds the cap — going over budget IS needs-attention, so it turns amber. */
export function Meter({ value, max, className, ariaLabel }: MeterProps) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const over = max > 0 && value > max;
  return (
    <div
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className={cn("h-full rounded-full", over ? "bg-warn" : "bg-foreground/70")}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
