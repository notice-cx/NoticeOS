import { HeartPulse } from "lucide-react";
import type { AssetCard } from "@shared/wall";
import { cn } from "@/lib/utils";
import { techHealth, techHealthSummary, type TechFact, type TechFactKey } from "@/lib/tech-health";
import type { WallIssue } from "@/lib/wall-issues";

// The Site health widget: one row per site, five dots for reachable, speed,
// errors, search and code. Only a problem is coloured (red for bad, amber for
// worth a look); a measured fact is a filled neutral dot and an unmeasured one
// a hollow ring, so the state is a shape as well as a colour, and every dot
// carries its word for a screen reader. The worst problem's note sits beside
// its row.

const eyebrow = "text-wall-label font-semibold uppercase tracking-widest text-muted-foreground";

export const WALL_HEALTH_FACTS: readonly { key: TechFactKey; label: string }[] = [
  { key: "reachable", label: "Up" },
  { key: "speed", label: "Speed" },
  { key: "errors", label: "Errors" },
  { key: "search", label: "Search" },
  { key: "code", label: "Code" },
];

const FACT_NAME: Readonly<Record<TechFactKey, string>> = {
  reachable: "Reachable",
  speed: "Speed",
  errors: "Errors",
  search: "Search",
  code: "Code",
};

/** The note a row shows: the first bad fact's, else the first worth a look,
 * and how many other problems the row has. */
export function wallHealthNote(facts: readonly TechFact[]): { note: string; more: number } | null {
  const problems = facts.filter((fact) => fact.state === "bad" || fact.state === "warn");
  const lead = problems.find((fact) => fact.state === "bad") ?? problems[0];
  if (!lead) return null;
  return { note: lead.note ?? lead.word, more: problems.length - 1 };
}

function Dot({ fact }: { fact: TechFact }) {
  return (
    <span role="cell" className="grid place-items-center" data-wall-health-fact={fact.key} data-wall-health-state={fact.state}>
      <span
        aria-hidden
        className={cn(
          "block size-4 rounded-full",
          fact.state === "bad" && "bg-error",
          fact.state === "warn" && "bg-warn",
          fact.state === "ok" && "bg-muted-foreground/45",
          fact.state === "unknown" && "border-2 border-muted-foreground/45",
        )}
      />
      <span className="sr-only">{`${FACT_NAME[fact.key]}: ${fact.word}`}</span>
    </span>
  );
}

export function WallHealth({ assets, issues }: { assets: readonly AssetCard[]; issues: readonly WallIssue[] }) {
  const rows = assets.map((card) => ({ card, health: techHealth(card, issues) }));
  const summary = techHealthSummary(assets, issues);
  return (
    <section aria-label="Site health" className="flex h-full min-h-0 min-w-0 flex-col gap-3" data-wall-health={rows.length > 0 ? "rows" : "calm"}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className={eyebrow}>Site health</h2>
        {summary.measured > 0 ? (
          <span className="text-wall-micro tabular-nums text-muted-foreground" data-wall-health-meta="">
            {summary.fine} of {summary.measured} fine
          </span>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <div className="flex items-center gap-3 rounded-lg bg-muted/60 px-4 py-3 text-wall-body text-muted-foreground">
          <HeartPulse className="size-6 shrink-0" aria-hidden />
          No sites yet
        </div>
      ) : (
        <div
          role="table"
          aria-label="Site health"
          className="grid min-h-0 min-w-0 grid-cols-[minmax(8rem,1fr)_repeat(5,3.75rem)_minmax(0,1.3fr)] content-start gap-x-2 tv:overflow-y-auto"
        >
          <div role="row" className="col-span-full grid grid-cols-subgrid items-end px-3 pb-1">
            <span role="columnheader" className="sr-only">Site</span>
            {WALL_HEALTH_FACTS.map((fact) => (
              <span key={fact.key} role="columnheader" className="text-center text-wall-micro text-muted-foreground">
                {fact.label}
              </span>
            ))}
            <span role="columnheader" className="sr-only">Problem</span>
          </div>
          {rows.map(({ card, health }) => {
            const note = wallHealthNote(health.facts);
            return (
              <div
                key={card.id}
                role="row"
                className="col-span-full grid grid-cols-subgrid items-center border-t border-border/60 px-3 py-2"
                data-wall-health-row={card.id}
                data-wall-health-key={health.key}
              >
                <span role="cell" className="min-w-0 text-wall-list-line font-semibold [overflow-wrap:anywhere]">
                  {card.displayName}
                  <span className="sr-only">{`: ${health.word}`}</span>
                </span>
                {WALL_HEALTH_FACTS.map(({ key }) => {
                  const fact = health.facts.find((candidate) => candidate.key === key);
                  return fact ? <Dot key={key} fact={fact} /> : <span key={key} role="cell" />;
                })}
                <span role="cell" className="min-w-0 text-wall-list-meta text-muted-foreground" data-wall-health-note="">
                  {note ? (
                    <>
                      <span className={health.key === "trouble" ? "text-error" : "text-foreground"}>{note.note}</span>
                      {note.more > 0 ? <span className="tabular-nums"> · +{note.more}</span> : null}
                    </>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
