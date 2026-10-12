import { Bot } from "lucide-react";
import type { WallAgents as WallAgentsData } from "@shared/wall";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

// The Agents widget: who closed the most in the last 7 days, one row per
// agent and model, each with its place, a bar on one shared scale and the
// count, and what the agents hold now. The leader wears the win ink; the
// place is a number as well as a colour.

const eyebrow = "text-wall-label font-semibold uppercase tracking-widest text-muted-foreground";

export function WallAgents({ agents }: { agents: WallAgentsData | null | undefined }) {
  const standings = agents?.standings ?? [];
  const top = Math.max(1, ...standings.map((entry) => entry.closed));
  return (
    <section aria-label="Agents" className="flex min-w-0 flex-col gap-3" data-wall-agents={standings.length > 0 ? "rows" : "calm"}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className={eyebrow}>Agents · 7 days</h2>
        {agents ? (
          <span className="text-wall-micro tabular-nums text-muted-foreground" data-wall-agents-meta="">
            {formatInt(agents.closed)} closed · {formatInt(agents.inProgress)} in hand
          </span>
        ) : null}
      </div>
      {standings.length === 0 ? (
        <div className="flex items-center gap-3 rounded-lg bg-muted/60 px-4 py-3 text-wall-body text-muted-foreground" data-wall-agents-calm="">
          <Bot className="size-6 shrink-0" aria-hidden />
          No agent has named its model yet
        </div>
      ) : (
        <ol className="flex min-w-0 flex-col gap-2">
          {standings.map((entry, index) => (
            <li key={`${entry.id}-${entry.model ?? ""}`} data-wall-agent={entry.id}
              className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg bg-muted/60 px-4 py-2.5">
              <span className={cn("grid size-7 place-items-center rounded-md text-wall-list-meta font-bold tabular-nums",
                index === 0 ? "bg-milestone text-milestone-foreground" : "bg-background/60 text-foreground")}>{index + 1}</span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-wall-list-line font-semibold [overflow-wrap:anywhere]">
                  {entry.id}{entry.model ? <span className="font-normal text-muted-foreground"> · {entry.model}</span> : null}
                </span>
                <span aria-hidden className="h-1.5 w-full overflow-hidden rounded-full bg-viz-track">
                  <span className={cn("block h-full rounded-full viz-grow-x", index === 0 ? "bg-milestone" : "bg-spark")}
                    style={{ width: `${Math.max(4, (entry.closed / top) * 100)}%` }} />
                </span>
              </span>
              <span className="text-wall-list-label font-semibold tabular-nums">{formatInt(entry.closed)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
