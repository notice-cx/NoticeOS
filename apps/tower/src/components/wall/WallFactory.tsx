import { Bot, ChevronRight } from "lucide-react";
import { Fragment } from "react";
import type { AgentsWeek } from "@/lib/agents-week";
import { formatInt } from "@/lib/format";

// The agents widget: what they are building, what they finished this week and
// what a measured outcome proved, as three figures read left to right, then up
// to three plain lines about the newest work. A count nobody can read is a
// dash, never a zero. On the TV the figures and the lines share the widget's
// height. The labels match Home's agents module.

const eyebrow = "text-wall-label font-semibold uppercase tracking-widest text-muted-foreground";

const FIGURES: readonly { key: "building" | "shipped" | "proven"; label: string }[] = [
  { key: "building", label: "Building" },
  { key: "shipped", label: "Finished" },
  { key: "proven", label: "Proven" },
];

export function WallFactory({ week }: { week: AgentsWeek }) {
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
      <div className="flex min-w-0 items-center gap-x-3 tv:flex-1" data-wall-factory-figures="">
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
        <ul className="flex min-w-0 flex-col gap-2 tv:min-h-0 tv:flex-[2]">
          {week.latest.map((line, index) => (
            <li key={`${line.title}-${index}`} className="flex min-w-0 flex-col rounded-lg bg-muted/60 px-4 py-2 tv:flex-1 tv:justify-center" data-wall-factory-line="">
              <span className="text-wall-list-line font-semibold [overflow-wrap:anywhere]">
                {line.title}
                {line.site ? <span className="font-normal text-muted-foreground"> · {line.site}</span> : null}
              </span>
              <span className="text-wall-list-meta text-muted-foreground [overflow-wrap:anywhere]">{line.line}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
