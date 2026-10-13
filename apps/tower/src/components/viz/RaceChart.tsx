import { useState, type ReactNode } from "react";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

// A running total per contestant over one window, racing to now: each step is
// one finished unit, so the steepest climb is the fastest pace and the line
// that ends highest leads. The leader wears the win ink, everyone else
// neutral; each line is named at its end with its place, and Replay draws the
// window again from its start. Lines and steps are drawn to scale; only the
// names move apart where two ends would collide.

export interface RaceEntry {
  key: string;
  /** Who, as the page names them: "claude · Opus 5.5". */
  name: string;
  /** A decorative mark beside the name, such as the agent's maker's. */
  mark?: ReactNode;
  /** Each finished unit's instant, ms. */
  at: readonly number[];
  /** The figure the place is decided by, when it is not the count. */
  score?: number;
}

export interface RaceChartProps {
  entries: readonly RaceEntry[];
  /** The window, ms. */
  from: number;
  to: number;
  /** One unit: "task". */
  unit: string;
  /** Day labels along the axis, `[ms, label]`. */
  ticks: readonly (readonly [number, string])[];
  ariaLabel: string;
  className?: string;
}

const W = 1000;
const H = 400;

export function RaceChart({ entries, from, to, unit, ticks, ariaLabel, className }: RaceChartProps) {
  const [round, setRound] = useState(0);
  const ranked = [...entries].sort((a, b) => (b.score ?? b.at.length) - (a.score ?? a.at.length) || b.at.length - a.at.length);
  const top = Math.max(1, ...ranked.map((entry) => entry.at.length));
  const x = (ms: number) => ((Math.min(Math.max(ms, from), to) - from) / Math.max(1, to - from)) * W;
  const y = (count: number) => H - (count / top) * (H - 8);
  // End labels sit at their line's height, nudged apart by at least a line.
  const ends = ranked.map((entry) => ({ key: entry.key, at: (entry.at.length / top) * 100 }));
  for (let index = 1; index < ends.length; index++) ends[index]!.at = Math.min(ends[index]!.at, ends[index - 1]!.at - 18);
  const plural = (n: number) => `${formatInt(n)} ${n === 1 ? unit : `${unit}s`}`;
  // A mark takes room from the name, so marked names get a wider column.
  const marked = ranked.some((entry) => entry.mark !== undefined);

  return (
    <div className={cn("@container/race flex flex-col gap-2", className)} data-race-chart="">
      <div className="flex min-h-0 flex-1 gap-3">
        <div role="img" aria-label={`${ariaLabel}: ${ranked.map((entry, index) => `${index + 1}. ${entry.name}, ${plural(entry.at.length)}`).join("; ") || "nothing finished yet"}`}
          className="relative min-h-52 min-w-0 flex-1">
          <svg key={round} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
            {ticks.map(([ms]) => (
              <line key={ms} x1={x(ms)} x2={x(ms)} y1={0} y2={H} className="stroke-viz-grid" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
            ))}
            <line x1={0} x2={W} y1={H} y2={H} className="stroke-viz-grid" vectorEffect="non-scaling-stroke" />
            {[...ranked].reverse().map((entry) => {
              const place = ranked.indexOf(entry);
              let d = `M0,${y(0)}`;
              entry.at.forEach((ms, index) => { d += ` H${x(ms).toFixed(1)} V${y(index + 1).toFixed(1)}`; });
              d += ` H${x(to).toFixed(1)}`;
              return (
                <path key={entry.key} d={d} fill="none" pathLength={1} data-race-line={entry.key}
                  className={cn("viz-draw", place === 0 ? "stroke-milestone" : place === 1 ? "stroke-foreground/70" : "stroke-foreground/40")}
                  strokeWidth={place === 0 ? 3 : 2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              );
            })}
          </svg>
        </div>
        <div aria-hidden className={cn("relative shrink-0", marked ? "w-48" : "w-40")} data-race-names="">
          {ranked.map((entry, index) => (
            <span key={entry.key} className="absolute inset-x-0 flex -translate-y-1/2 items-start gap-1.5" style={{ top: `${100 - Math.max(ends[index]!.at, -10)}%` }}>
              <span className={cn("grid size-[18px] shrink-0 place-items-center rounded-[5px] text-micro font-bold tabular-nums",
                index === 0 ? "bg-milestone text-milestone-foreground" : "bg-muted text-foreground")}>{index + 1}</span>
              {entry.mark}
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="text-xs font-semibold text-foreground [overflow-wrap:anywhere]">{entry.name}</span>
                <span className="text-micro tabular-nums text-muted-foreground">{plural(entry.at.length)}</span>
              </span>
            </span>
          ))}
        </div>
      </div>
      <div className={cn("flex items-center gap-3", marked ? "pr-[12.75rem]" : "pr-[10.75rem]")}>
        <div aria-hidden className="relative h-4 min-w-0 flex-1 text-micro text-muted-foreground">
          {ticks.map(([ms, label], index) => (
            // A narrow chart names every other day.
            <span key={ms} className={cn("absolute -translate-x-1/2 whitespace-nowrap", index % 2 === 1 && "hidden @xl/race:inline")}
              style={{ left: `${(x(ms) / W) * 100}%` }}>{label}</span>
          ))}
        </div>
      </div>
      <button type="button" onClick={() => setRound((n) => n + 1)} className="self-start text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" data-race-replay="">
        Replay the week
      </button>
    </div>
  );
}
