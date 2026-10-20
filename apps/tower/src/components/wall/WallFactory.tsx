import { Bot, ChevronRight } from "lucide-react";
import { Fragment, useRef } from "react";
import { useWholeRows } from "@/hooks/useWholeRows";
import type { AgentsWeek } from "@/lib/agents-week";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

// The agents widget: what they are building, what they finished this week and
// what a measured outcome proved, as three figures read left to right, then
// plain lines about the newest work. A count nobody can read is a dash, never
// a zero. On the TV the figures sit under the heading and the lines under
// them, each at its own height and one gap apart; the list takes the height
// left below and draws as many whole lines as fit there. The labels match
// Home's agents module.

const eyebrow = "text-wall-label font-semibold uppercase tracking-widest text-muted-foreground";

const FIGURES: readonly { key: "building" | "shipped" | "proven"; label: string }[] = [
  { key: "building", label: "Building" },
  { key: "shipped", label: "Finished" },
  { key: "proven", label: "Proven" },
];

export function WallFactory({ week }: { week: AgentsWeek }) {
  const listRef = useRef<HTMLUListElement>(null);
  const fit = useWholeRows(listRef, week.latest);
  return (
    <section aria-label="The agents" className="flex h-full min-h-0 min-w-0 flex-col gap-3" data-wall-factory={week.latest.length > 0 ? "lines" : "calm"}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className={eyebrow}>The agents · this week</h2>
        {week.watching > 0 ? (
          <span className="text-wall-micro tabular-nums text-muted-foreground" data-wall-factory-watching="">
            {formatInt(week.watching)} being watched
          </span>
        ) : null}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col gap-3 text-wall-list-line tv:flex-1" data-wall-factory-body="">
        <div className="flex min-w-0 items-center gap-x-3" data-wall-factory-figures="">
          {FIGURES.map(({ key, label }, index) => {
            const value = week[key];
            return (
              <Fragment key={key}>
                {index > 0 ? <ChevronRight aria-hidden className="size-6 shrink-0 text-muted-foreground" /> : null}
                <dl className="flex min-w-0 flex-1 flex-col" data-wall-factory-figure={key}>
                  <dt className="text-wall-micro text-muted-foreground">{label}</dt>
                  <dd className="text-wall-stat font-semibold tabular-nums text-foreground">
                    {value === null ? <span aria-label="Unknown">—</span> : formatInt(value)}
                  </dd>
                </dl>
              </Fragment>
            );
          })}
        </div>
        {week.latest.length === 0 ? (
          <div className="flex items-center gap-3 rounded-lg bg-muted/60 px-4 py-3 text-wall-body text-muted-foreground" data-wall-factory-calm="">
            <Bot className="size-6 shrink-0" aria-hidden />
            Nothing finished yet
          </div>
        ) : (
          <ul ref={listRef} className="flex min-w-0 flex-col gap-2 tv:min-h-0 tv:flex-1 tv:overflow-hidden">
            {week.latest.map((line, index) => {
              const cut = index >= fit;
              return (
                <li
                  key={`${line.title}-${index}`}
                  aria-hidden={cut || undefined}
                  className={cn("flex min-w-0 shrink-0 flex-col rounded-lg bg-muted/60 px-4 py-2", cut && "invisible")}
                  data-wall-factory-line=""
                  data-wall-factory-cut={cut ? "" : undefined}
                >
                  <span className="text-wall-list-line font-semibold [overflow-wrap:anywhere]">
                    {line.title}
                    {line.site ? <span className="font-normal text-muted-foreground"> · {line.site}</span> : null}
                  </span>
                  <span className="text-wall-list-meta text-muted-foreground [overflow-wrap:anywhere]">{line.line}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
