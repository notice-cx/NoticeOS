import { ArrowDown, ArrowUp, Check } from "lucide-react";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

// A reading against its usual range: the range as a shaded band on a track,
// the reading as a marker, and the verdict as a word. "1 vs ~13/day" becomes
// a marker sitting far left of its band, readable before the numbers are.
// The band is the rule's own normal (an alert's baseline), never one drawn
// for the occasion.

export type NormalVerdict = "below" | "within" | "above";

export interface NormalBandProps {
  value: number;
  /** Stored range edges, or just one edge for a one-sided limit. */
  low?: number;
  high?: number;
  /** "API requests yesterday". */
  label: string;
  /** "a day", read after a figure: "13 a day". */
  unit?: string;
  /** The side on which an off-normal reading is bad: `below` paints only a low
   * reading as a problem; `both` paints either side. */
  bad?: "below" | "above" | "both";
  /** Severity of an off-normal reading, as the rule judged it. */
  severity?: "error" | "warn";
  format?: (value: number) => string;
  /** Inside a row that already names the reading: the label is for screen readers only. */
  compact?: boolean;
  /** The reading just arrived: an off-normal marker breathes. Off by default,
   * so a board of readings has one moving thing at most, not one per row. */
  live?: boolean;
  className?: string;
}

export function normalVerdict(value: number, low?: number, high?: number): NormalVerdict {
  return low !== undefined && value < low ? "below" : high !== undefined && value > high ? "above" : "within";
}

const VERDICT_WORD: Record<NormalVerdict, string> = { below: "Below normal", within: "Normal", above: "Above normal" };

export function NormalBand({
  value,
  low,
  high,
  label,
  unit,
  bad = "both",
  severity = "warn",
  format = formatInt,
  compact = false,
  live = false,
  className,
}: NormalBandProps) {
  if (low === undefined && high === undefined) return null;
  const oneSided = low === undefined || high === undefined;
  const edge = low ?? high!;
  const verdict = normalVerdict(value, low, high);
  const verdictWords = oneSided
    ? verdict === "within" ? "Within limit" : verdict === "below" ? "Below limit" : "Above limit"
    : VERDICT_WORD[verdict];
  const problem = verdict !== "within" && (bad === "both" || bad === verdict);
  const span = oneSided ? Math.max(Math.abs(edge - value), Math.abs(edge) * 0.5, 1) : Math.max(high! - low!, 1);
  const min = Math.min(value, low ?? edge) - span * 0.6;
  const max = Math.max(value, high ?? edge) + span * 0.6;
  const floor = Math.min(value, low ?? edge) >= 0 ? Math.max(0, min) : min;
  const at = (reading: number) => `${((reading - floor) / (max - floor)) * 100}%`;
  const Icon = verdict === "below" ? ArrowDown : verdict === "above" ? ArrowUp : Check;
  const ink = problem ? (severity === "error" ? "text-error" : "text-warn") : "text-foreground";
  const suffix = unit ? ` ${unit}` : "";
  const reference = oneSided
    ? `limit ${format(edge)}${suffix}; problematic ${low === undefined ? "above" : "below"} the limit`
    : `usual ${format(low!)} to ${format(high!)}${suffix}`;

  return (
    <div className={cn("flex flex-col gap-1", className)} data-normal-band="" data-verdict={verdict} data-state={problem ? severity : "normal"}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        {compact ? <span className="sr-only">{label}</span> : <span className="text-xs text-muted-foreground">{label}</span>}
        <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium", ink)}>
          <Icon aria-hidden className="size-3.5" />
          {verdictWords}
        </span>
      </div>
      <div
        role="img"
        aria-label={`${label}: ${format(value)}${suffix}, ${verdictWords.toLowerCase()}; ${reference}`}
        className="relative h-6"
      >
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-viz-track" />
        {oneSided ? (
          <span aria-hidden data-normal-limit="" className="absolute top-1/2 h-5 -translate-y-1/2 border-s-2 border-dashed border-muted-foreground" style={{ insetInlineStart: at(edge) }} />
        ) : <span
          aria-hidden
          data-normal-range=""
          className="absolute top-1/2 h-3 -translate-y-1/2 rounded-full border border-muted-foreground/40 bg-muted-foreground/25"
          style={{ insetInlineStart: at(low!), width: `calc(${at(high!)} - ${at(low!)})` }}
        />}
        <span
          aria-hidden
          data-normal-marker=""
          className={cn("absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-current", ink, problem && live && "viz-breathe")}
          style={{ insetInlineStart: at(value) }}
        />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-micro tabular-nums text-muted-foreground" aria-hidden>
        <span className="whitespace-nowrap">
          <span className={cn("text-xs font-semibold", ink)}>{format(value)}</span>
          {suffix}
        </span>
        <span className="text-end">
          {oneSided ? <>limit {format(edge)} · problem {low === undefined ? "above" : "below"}</> : <>usual <span className="whitespace-nowrap">{format(low!)}–{format(high!)}</span></>}
        </span>
      </div>
    </div>
  );
}
