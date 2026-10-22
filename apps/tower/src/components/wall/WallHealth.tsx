import { HeartPulse } from "lucide-react";
import type { CSSProperties } from "react";
import type { AssetCard } from "@shared/wall";
import { cn } from "@/lib/utils";
import { rowFacts, techHealth, techHealthSummary, type TechFact, type TechFactKey } from "@/lib/tech-health";
import type { WallIssue } from "@/lib/wall-issues";

// The Site health widget: one row per site, five dots for reachable, speed,
// errors, search and code. Only a problem is coloured (red for bad, amber for
// worth a look); a measured fact is a filled neutral dot and an unmeasured one
// a hollow ring, so the state is a shape as well as a colour, and every dot
// carries its word for a screen reader. The worst problem's note sits beside
// its row. On the TV the rows share the widget's height and the type and dots
// grow with them, up to the TV's stat size (`--wall-health-*` in index.css).

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

/** The note a row shows: the first bad fact's, else the first worth a look
 * (a late report before the dots' facts, `rowFacts`), and how many other
 * problems the row has. */
export function wallHealthNote(facts: readonly Pick<TechFact, "state" | "word" | "note">[]): { note: string; more: number } | null {
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
          "block size-(--wall-health-dot) rounded-full",
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

export function WallHealth({ assets, issues, nowMs = null }: { assets: readonly AssetCard[]; issues: readonly WallIssue[]; nowMs?: number | null }) {
  const rows = assets.map((card) => ({ card, health: techHealth(card, issues, nowMs) }));
  const summary = techHealthSummary(assets, issues, nowMs);
  return (
    <section
      aria-label="Asset health"
      className="flex h-full min-h-0 min-w-0 flex-col gap-3"
      style={{ "--health-rows": Math.max(rows.length, 1) } as CSSProperties}
      data-wall-health={rows.length > 0 ? "rows" : "calm"}
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className={eyebrow}>Asset health</h2>
        {summary.measured > 0 ? (
          <span className="text-wall-micro tabular-nums text-muted-foreground" data-wall-health-meta="">
            {summary.fine} of {summary.measured} fine
          </span>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <div className="flex items-center gap-3 rounded-lg bg-muted/60 px-4 py-3 text-wall-body text-muted-foreground">
          <HeartPulse className="size-6 shrink-0" aria-hidden />
          No assets yet
        </div>
      ) : (
        <div
          role="table"
          aria-label="Asset health"
          className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(8rem,1fr)_repeat(5,3.75rem)_minmax(0,1.3fr)] content-start gap-x-2 tv:grid-rows-[auto] tv:auto-rows-[minmax(min-content,1fr)] tv:content-stretch tv:overflow-y-auto"
          data-wall-health-table=""
        >
          {/* The site and problem headers are empty cells holding their word
              for a screen reader: an `sr-only` cell leaves the grid's flow and
              would pull every visible header one column left of its dots. */}
          <div role="row" className="col-span-full grid grid-cols-subgrid items-end px-3 pb-1">
            <span role="columnheader">
              <span className="sr-only">Asset</span>
            </span>
            {WALL_HEALTH_FACTS.map((fact) => (
              <span key={fact.key} role="columnheader" className="text-center text-[length:var(--wall-health-head)] leading-tight text-muted-foreground">
                {fact.label}
              </span>
            ))}
            <span role="columnheader">
              <span className="sr-only">Problem</span>
            </span>
          </div>
          {rows.map(({ card, health }) => {
            const note = wallHealthNote(rowFacts(health));
            return (
              <div
                key={card.id}
                role="row"
                className="col-span-full grid grid-cols-subgrid items-center border-t border-border/60 px-3 py-2"
                data-wall-health-row={card.id}
                data-wall-health-key={health.key}
              >
                <span role="cell" className="min-w-0 text-[length:var(--wall-health-name)] leading-tight font-semibold [overflow-wrap:anywhere]">
                  {card.displayName}
                  <span className="sr-only">{`: ${health.word}`}</span>
                </span>
                {WALL_HEALTH_FACTS.map(({ key }) => {
                  const fact = health.facts.find((candidate) => candidate.key === key);
                  return fact ? <Dot key={key} fact={fact} /> : <span key={key} role="cell" />;
                })}
                <span role="cell" className="min-w-0 text-[length:var(--wall-health-note)] leading-snug text-muted-foreground" data-wall-health-note="">
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
