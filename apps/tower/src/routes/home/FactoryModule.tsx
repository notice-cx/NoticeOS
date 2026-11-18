import { Link } from "react-router-dom";
import type { AssetCard } from "@shared/wall";
import type { WorkPayload } from "@shared/work";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { agentsWeek } from "@/lib/agents-week";
import { formatInt } from "@/lib/format";
import { taskPath } from "@/lib/task-path";

/** Recorded outcomes and task evidence, below the activity statistics. */
export function FactoryModule({ cards, work, nowMs }: { cards: readonly AssetCard[]; work: WorkPayload | null; nowMs: number }) {
  const week = agentsWeek(cards, work, nowMs);
  const hasWatches = cards.some((card) => card.watches?.latest || (card.watches?.open ?? 0) > 0);
  if (!hasWatches && week.latest.length === 0) return null;
  return (
    <section aria-label="Work outcomes" className="flex flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-inset ring-border" data-home-factory="">
      <SectionLabel title="Work outcomes"
        caption={hasWatches ? `${formatInt(week.proven)} confirmed · ${formatInt(week.watching)} being watched` : undefined}
      />
      {week.latest.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-factory-latest="">
          {week.latest.map((line, index) => (
            <li key={`${line.title}-${index}`} className="flex flex-wrap items-baseline gap-x-2 text-sm" data-factory-task={line.task}>
              {line.task ? (
                <Link to={taskPath(line.task)} className="text-foreground underline-offset-4 hover:underline">{line.title}</Link>
              ) : (
                <span className="text-foreground">{line.title}</span>
              )}
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
