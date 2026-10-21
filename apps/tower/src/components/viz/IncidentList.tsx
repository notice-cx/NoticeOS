import { ChevronRight, CircleAlert, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ageMs, formatAge } from "@shared/freshness";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

// Open problems ranked by consequence, in one panel: what broke since the
// operator last looked leads, what is still open follows, and what has been
// open for over a week folds into one line so a 67-day-old fault never shouts
// as loud as a 37-minute-old one. Each row carries its evidence (the reading
// against its normal, or its recent series) where a sentence used to be.

export interface Incident {
  key: string;
  severity: "error" | "warn";
  title: string;
  /** The site's name, or "System". */
  site: string;
  /** When it began, as far as the store can tell. */
  since: string | null;
  to?: string;
  /** The reading behind it, drawn small on the row's right. */
  evidence?: ReactNode;
}

export type IncidentGroup = "new" | "open" | "long-standing";

/** Which group a problem belongs to: new after the marker, long-standing after
 * `longDays`, otherwise still open. An unknown onset is "open", never "new". */
export function incidentGroup(incident: Pick<Incident, "since">, nowMs: number, marker: string | null, longDays = 7): IncidentGroup {
  if (incident.since === null) return "open";
  const age = ageMs(nowMs, incident.since) ?? 0;
  if (age >= longDays * 86_400_000) return "long-standing";
  if (marker !== null && incident.since >= marker) return "new";
  return "open";
}

/** Errors before warnings, then newest first; unknown onsets last. */
export function rankIncidents<T extends Pick<Incident, "severity" | "since">>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    if (a.since === b.since) return 0;
    if (a.since === null) return 1;
    if (b.since === null) return -1;
    return b.since.localeCompare(a.since);
  });
}

const GROUP_TITLE: Record<IncidentGroup, string> = { new: "New since you last looked", open: "Still open", "long-standing": "Open for over a week" };

export interface IncidentListProps {
  items: Incident[];
  nowMs: number;
  /** When the operator last looked; problems after it are "new". */
  marker?: string | null;
  title?: string;
  action?: { label: string; to: string };
  /** Shown when nothing is open. */
  empty?: ReactNode;
  /** Home overview: at most three issues, with full details on Alerts. */
  compact?: boolean;
  className?: string;
}

export function IncidentList({ items, nowMs, marker = null, title = "Problems", action, empty = "Nothing is broken.", compact = false, className }: IncidentListProps) {
  const [showOld, setShowOld] = useState(false);
  const ranked = rankIncidents(items);
  const groups = (["new", "open", "long-standing"] as const).map((group) => ({
    group,
    rows: ranked.filter((item) => incidentGroup(item, nowMs, marker) === group),
  }));
  const errors = items.filter((item) => item.severity === "error").length;
  const warnings = items.length - errors;

  return (
    <section aria-label={title} data-incident-list="" className={cn("flex min-w-0 flex-col rounded-xl bg-card ring-1 ring-border/70", className)}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-5 pb-3 pt-4">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className={cn("m-0 whitespace-nowrap", eyebrowClass)}>{title}</h2>
          {items.length > 0 ? (
            <span className="flex flex-wrap items-baseline gap-x-2 text-sm tabular-nums">
              {errors > 0 ? <span className="whitespace-nowrap font-semibold text-error">{formatInt(errors)} broken</span> : null}
              {warnings > 0 ? <span className="whitespace-nowrap font-semibold text-warn">{formatInt(warnings)} at risk</span> : null}
            </span>
          ) : null}
        </div>
        {action ? (
          <Link to={action.to} className="whitespace-nowrap text-xs font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            {action.label}
          </Link>
        ) : null}
      </header>
      {items.length === 0 ? (
        <p className="m-0 border-t border-border/60 px-5 py-4 text-sm text-muted-foreground">{empty}</p>
      ) : compact ? (
        <>
          <ul className="m-0 list-none border-t border-border/60 p-0">
            {ranked.slice(0, 3).map((row, index) => (
              <IncidentRow key={row.key} incident={row} nowMs={nowMs} quiet={false} fresh={incidentGroup(row, nowMs, marker) === "new"} index={index} compact />
            ))}
          </ul>
          {items.length > 3 ? <p className="m-0 border-t border-border/60 px-5 py-2.5 text-xs text-muted-foreground">Showing 3 of {formatInt(items.length)} problems</p> : null}
        </>
      ) : (
        groups.map(({ group, rows }) => {
          if (rows.length === 0) return null;
          const folded = group === "long-standing" && !showOld;
          return (
            <div key={group} data-incident-group={group} className="border-t border-border/60">
              {group === "long-standing" ? (
                <button
                  type="button"
                  aria-expanded={!folded}
                  onClick={() => setShowOld((value) => !value)}
                  className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-0.5 px-5 py-2.5 text-start text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 self-center motion-safe:transition-transform", !folded && "rotate-90")} />
                  <span className="whitespace-nowrap font-medium">
                    {GROUP_TITLE[group]} <span className="tabular-nums">· {formatInt(rows.length)}</span>
                  </span>
                  {folded ? <span className="col-start-2">{rows.map((row) => `${row.title} on ${row.site}`).join(" · ")}</span> : null}
                </button>
              ) : (
                <h3 className="m-0 px-5 pb-1 pt-2.5 text-micro font-medium text-muted-foreground">{GROUP_TITLE[group]}</h3>
              )}
              {folded ? null : (
                <ul className="m-0 list-none p-0">
                  {rows.map((row, index) => (
                    <IncidentRow key={row.key} incident={row} nowMs={nowMs} quiet={group === "long-standing"} fresh={group === "new"} index={index} />
                  ))}
                </ul>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}

function IncidentRow({ incident, nowMs, quiet, fresh, index, compact = false }: { incident: Incident; nowMs: number; quiet: boolean; fresh: boolean; index: number; compact?: boolean }) {
  const Glyph = incident.severity === "error" ? CircleAlert : TriangleAlert;
  const ink = incident.severity === "error" ? "text-error" : "text-warn";
  const age = incident.since ? formatAge(ageMs(nowMs, incident.since)) : null;
  const label = `${incident.site} · ${incident.title}${age ? ` · since ${age} ago` : ""}`;
  const content = (
    <>
      <span aria-hidden className={cn("absolute inset-y-2 start-0 w-0.5 rounded-full bg-current", ink, quiet && "opacity-40")} />
      <Glyph aria-hidden className={cn("size-4 shrink-0", ink, quiet && "opacity-60")} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={cn("text-sm font-medium", compact && "line-clamp-2 [overflow-wrap:anywhere]", quiet ? "text-muted-foreground" : "text-foreground")} title={incident.title}>
          {incident.title}
        </span>
        <span className="text-micro text-muted-foreground">{incident.site}</span>
      </span>
      {incident.evidence && !compact ? <span className="hidden w-40 shrink-0 @md:block">{incident.evidence}</span> : null}
      <span className={cn("flex w-12 shrink-0 flex-col items-end tabular-nums", quiet && "opacity-70")}>
        <span className={cn("text-sm font-semibold", fresh ? ink : "text-foreground")}>{age ?? "?"}</span>
      </span>
    </>
  );
  const row = "relative grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 px-5 py-2.5";
  return (
    <li data-incident={incident.key} data-state={incident.severity} className="viz-arrive @container" style={{ ["--viz-i" as string]: index }}>
      {incident.to ? (
        <Link to={incident.to} aria-label={label} className={cn(row, "outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}>
          {content}
        </Link>
      ) : (
        <div aria-label={label} className={row}>{content}</div>
      )}
    </li>
  );
}
