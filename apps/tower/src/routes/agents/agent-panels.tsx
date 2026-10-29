import { Flame, Timer, Trophy, Zap } from "lucide-react";
import { formatHours, type AgentAward, type ModelStats } from "@noticeos/contract/agent-stats";
import { AgentMark } from "@/components/AgentMark";
import { EmptyState } from "@/components/EmptyState";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The page's panels share one frame: flat, on a hairline ring. */
export const PANEL = "flex min-w-0 flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-border/70";

/** Active model groups: recent closes, work in progress or blocked work. */
export function WorkerRows({ workers, emphasis }: { workers: readonly ModelStats[]; emphasis?: "blocked" | "inHand" }) {
  const ordered = emphasis ? [...workers].sort((a, b) => b[emphasis] - a[emphasis] || a.name.localeCompare(b.name)) : workers;
  const ceiling = Math.max(1, ...workers.flatMap(worker => worker.days));
  return (
    <section aria-label="Who's working" data-agent-rows="" className={PANEL}>
      <h2 className={cn("m-0", eyebrowClass)}>Who's working</h2>
      <p className="m-0 text-xs text-muted-foreground">Grouped by model · active now or closed in the last 7 days</p>
      {workers.length === 0 ? <EmptyState size="sm" title="No work in progress or closed in the last 7 days" /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-micro uppercase text-muted-foreground">
              <tr><th scope="col" className="pb-2">Model</th><th scope="col" className="pb-2 text-right">In progress</th><th scope="col" className="px-3 pb-2">Closed, 7 days</th><th scope="col" className="pb-2 text-right">Claim to close</th><th scope="col" className="pl-3 pb-2 text-right">Blocked</th></tr>
            </thead>
            <tbody>
              {ordered.map(worker => (
                <tr key={worker.id} data-agent-row={worker.id} className="border-t border-border/70">
                  <th scope="row" className="py-3 pr-3 font-semibold text-foreground">
                    <span className="flex min-w-0 items-center gap-2.5"><AgentMark name={worker.name} /><span>{worker.name}</span></span>
                  </th>
                  <td className="py-3 text-right tabular-nums">{formatInt(worker.inHand)}</td>
                  <td className="px-3 py-3"><span className="flex items-center gap-2"><span className="font-semibold tabular-nums" data-agent-week={worker.week}>{formatInt(worker.week)}</span><DayTicks days={worker.days} ceiling={ceiling} label={`${worker.name}: closed a day, last 7 days`} /></span></td>
                  <td className="whitespace-nowrap py-3 text-right tabular-nums">{worker.medianHours === null ? <span className="text-muted-foreground">not yet</span> : formatHours(worker.medianHours)}</td>
                  <td className={cn("py-3 pl-3 text-right tabular-nums", worker.blocked ? "font-semibold text-warn" : "text-muted-foreground")}>{worker.blocked ? formatInt(worker.blocked) : "none"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Seven days of closes as a strip: yesterday in the win ink, today outlined while it counts. */
function DayTicks({ days, ceiling, label }: { days: readonly number[]; ceiling: number; label: string }) {
  return (
    <span role="img" aria-label={`${label}: ${days.join(", ")}`} className="flex h-6 w-[4.5rem] items-end gap-0.5 text-milestone">
      {days.map((count, index) => {
        const today = index === days.length - 1;
        return (
          <span key={index} aria-hidden className={cn("w-full rounded-t-[2px]",
            count === 0 ? "h-0.5 bg-muted-foreground/40" : today ? "outline-1 -outline-offset-1 outline-dashed outline-current" : index === days.length - 2 ? "bg-current" : "bg-spark/50")}
            style={count === 0 ? undefined : { height: `${Math.max(15, (count / ceiling) * 100)}%` }} />
        );
      })}
    </span>
  );
}

// --- the contest --------------------------------------------------------------------

const AWARD_ICON = { most: Trophy, fastest: Zap, streak: Flame, urgent: Timer } as const;

/** The last seven days' awards, one figure each. */
export function AgentTrophies({ trophies }: { trophies: readonly AgentAward[] }) {
  return (
    <section aria-label="Leaders" data-agent-trophies="" className={PANEL}>
      <h2 className={cn("m-0", eyebrowClass)}>Leaders · last 7 days</h2>
      {trophies.length === 0 ? <EmptyState size="sm" title="No agent closed a task in the last 7 days" /> : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
          {trophies.map((trophy, index) => {
            const Icon = AWARD_ICON[trophy.key];
            return (
              <div key={trophy.key} data-agent-trophy={trophy.key} className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-muted/50 p-3">
                <span className={cn("flex items-center gap-1.5", eyebrowClass)}>
                  <Icon aria-hidden className={cn("size-3.5", index === 0 ? "text-milestone" : "text-muted-foreground")} />{trophy.award}
                </span>
                <span className="text-figure-sm font-semibold leading-none tabular-nums text-foreground">
                  {trophy.value}
                  {trophy.detail ? <span className="ms-1.5 text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">{trophy.detail}</span> : null}
                </span>
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                  <AgentMark name={trophy.holder} size="small" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{trophy.holder}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
