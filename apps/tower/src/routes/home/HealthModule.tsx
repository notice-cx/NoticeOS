import { Link } from "react-router-dom";
import { sitePath } from "@shared/first-run";
import type { AssetCard } from "@shared/wall";
import { InfoTooltip } from "@/components/InfoTooltip";
import { PropertyFavicon } from "@/components/PropertyFavicon";
import { SectionLabel } from "@/components/surface/SectionLabel";
import { techHealth, type TechFact, type TechFactKey, type TechHealth } from "@/lib/tech-health";
import { cn } from "@/lib/utils";
import type { WallIssue } from "@/lib/wall-issues";

/** Each fact's column header, in the order `techHealth` lists the facts. */
export const FACT_LABEL: Readonly<Record<TechFactKey, string>> = {
  reachable: "Up",
  speed: "Speed",
  errors: "Errors",
  search: "Search",
  code: "Code",
};

const FACT_KEYS = Object.keys(FACT_LABEL) as TechFactKey[];

/** A fact's dot. Only a problem is coloured; a fine fact is neutral ink and an
 * unmeasured one an empty dashed ring, never a colour of its own. */
export function FactDot({ fact, site }: { fact: TechFact; site: string }) {
  const label = FACT_LABEL[fact.key];
  return (
    <InfoTooltip
      label={`${site}, ${label}: ${fact.word}`}
      trigger={
        <>
          <span
            aria-hidden
            data-fact-dot={fact.state}
            className={cn(
              "block size-4.5 rounded-full",
              fact.state === "bad"
                ? "bg-error"
                : fact.state === "warn"
                  ? "bg-warn"
                  : fact.state === "ok"
                    ? "bg-muted-foreground/30"
                    : "border-[1.5px] border-dashed border-muted-foreground/60",
            )}
          />
          <span className="sr-only">{fact.word}</span>
        </>
      }
      className="no-underline"
    >
      <span className="font-semibold text-foreground">{label} · {fact.word}</span>
      {fact.note ? <span>{fact.note}</span> : null}
    </InfoTooltip>
  );
}

/** The words beside a row: its problems, or that it is fine, or that nothing
 * about it is measured yet. */
export function healthNote(health: TechHealth): string {
  if (health.key === "unknown") return "Still setting up · nothing measured yet";
  const notes = health.facts.flatMap((fact) => (fact.note ? [fact.note] : []));
  return notes.length > 0 ? notes.join(" · ") : "Fine";
}

const ROW = "grid grid-cols-[minmax(0,1fr)_repeat(5,1.75rem)] items-center gap-x-2 @2xl:grid-cols-[minmax(8rem,14rem)_repeat(5,2.25rem)_minmax(0,1fr)]";

/**
 * Every listed site's technical health as one grid: a row per site, five dots
 * (up, speed, errors, search, code) under one header, and the row's problems
 * in words beside it.
 */
export function HealthModule({ cards, issues }: { cards: readonly AssetCard[]; issues: readonly WallIssue[] }) {
  return (
    <section aria-label="Site health" className="flex flex-col gap-3 rounded-xl bg-card p-5 ring-1 ring-border/70" data-home-site-health="">
      <SectionLabel title="Site health" />
      <div className="@container flex flex-col">
        <div aria-hidden className={cn(ROW, "pb-1 text-micro text-muted-foreground")}>
          <span />
          {FACT_KEYS.map((key) => (
            <span key={key} className="text-center" data-fact-header={key}>{FACT_LABEL[key]}</span>
          ))}
          <span className="hidden @2xl:block" />
        </div>
        <ul className="m-0 flex list-none flex-col p-0">
          {cards.map((card) => {
            const health = techHealth(card, issues);
            const note = healthNote(health);
            const problem = health.key === "trouble" || health.key === "watch";
            return (
              <li key={card.id} className={cn(ROW, "gap-y-1 border-t border-border/60 py-2")} data-site-health-row={card.id} data-tech-health={health.key}>
                <Link to={sitePath(card)} className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground underline-offset-4 hover:underline">
                  <PropertyFavicon domain={card.id} icons={card.icons} displayName={card.displayName} />
                  <span className="min-w-0 break-words">{card.displayName}</span>
                </Link>
                {FACT_KEYS.map((key) => {
                  const fact = health.facts.find((candidate) => candidate.key === key)!;
                  return (
                    <span key={key} className="flex justify-center" data-fact={key}>
                      <FactDot fact={fact} site={card.displayName} />
                    </span>
                  );
                })}
                <span
                  className={cn("col-span-full text-xs @2xl:col-span-1", problem ? "text-foreground" : "text-muted-foreground")}
                  data-site-health-note=""
                >
                  {note}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="m-0 text-xs text-muted-foreground">
        From the hourly home-page check, what visitors’ browsers recorded, four weeks of visits from search and each site’s code report.
      </p>
    </section>
  );
}
