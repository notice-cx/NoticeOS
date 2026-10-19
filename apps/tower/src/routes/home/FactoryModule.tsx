import { Fragment } from "react";
import type { AssetCard } from "@shared/wall";
import type { WorkPayload } from "@shared/work";
import { AGENTS_ROUTE } from "@/components/nav-items";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { agentsWeek } from "@/lib/agents-week";
import { formatInt } from "@/lib/format";

const NOT_COUNTED = "not counted yet";

/**
 * The agents' week as a line from work started to work proven: what they are
 * building, what they finished this week, and the sites whose newest bet
 * worked, then the newest few things they did, one line each.
 */
export function FactoryModule({ cards, work, nowMs }: { cards: readonly AssetCard[]; work: WorkPayload | null; nowMs: number }) {
  const week = agentsWeek(cards, work, nowMs);
  const figures = [
    { key: "building", label: "Building", value: week.building },
    { key: "finished", label: "Finished", value: week.shipped },
    { key: "proven", label: "Proven to work", value: week.proven },
  ];
  return (
    <section aria-label="The agents this week" className="flex h-full flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-border/70" data-home-factory="">
      <SectionLabel
        title="The agents · this week"
        caption={week.watching > 0 ? `${formatInt(week.watching)} being watched` : undefined}
        action={{ label: "Agents →", to: AGENTS_ROUTE }}
      />
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        {figures.map((figure, index) => (
          <Fragment key={figure.key}>
            {index > 0 ? <span aria-hidden className="pb-1 text-figure-sm text-muted-foreground">›</span> : null}
            <div className="flex flex-col gap-0.5" data-factory-figure={figure.key}>
              <span className="text-xs text-muted-foreground">{figure.label}</span>
              <span>
                {figure.value === null ? (
                  <span className="text-sm text-muted-foreground">{NOT_COUNTED}</span>
                ) : (
                  <span className="text-figure-sm tabular-nums text-foreground">{formatInt(figure.value)}</span>
                )}
              </span>
            </div>
          </Fragment>
        ))}
      </div>
      {week.latest.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-factory-latest="">
          {week.latest.map((line, index) => (
            <li key={`${line.title}-${index}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="text-foreground">{line.title}</span>
              <span className="text-xs text-muted-foreground">
                {line.site ? `${line.site} · ` : ""}
                {line.line}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
