import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { SeriesPoint } from "@shared/wall";
import { DeltaChip, performanceTone } from "@/components/DeltaChip";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { Sparkline } from "@/components/surface/Sparkline";
import { formatInt, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

// The sites side by side, one full-width row each, every row ruled to the same
// columns so the eye runs down a column to compare: the site, its people over
// the last weeks as a line, yesterday's money with its change, its share of the
// month, and how many of its data sources are live. The health word is quiet
// unless it is a problem. A row is wide on purpose: a name never wraps, and a
// squeezed column drops before a name does.

export interface PortfolioSource {
  /** Source label for the tooltip: "Bing". */
  label: string;
  state: "working" | "collecting" | "overdue" | "failing" | "not-connected" | "not-using" | "unknown";
}

export interface PortfolioRow {
  id: string;
  name: string;
  icon?: ReactNode;
  to?: string;
  health: { word: string; tone: "quiet" | "warn" | "error" };
  /** People a day over the recent weeks; empty when nothing reported yet. */
  people: readonly SeriesPoint[];
  peopleProvisionalFrom?: string | null;
  /** The latest settled day's people, or null. */
  peopleLatest: number | null;
  /** Yesterday's revenue, or null when the site earns nothing or has not reported. */
  revenue: number | null;
  /** Signed percent against the same weekday last week; null when not comparable. */
  revenueChange?: number | null;
  /** This site's share of the month's revenue so far, 0–1; null when no revenue. */
  share: number | null;
  sources: readonly PortfolioSource[];
}

export interface PortfolioRowsProps {
  rows: PortfolioRow[];
  formatMoney: (value: number) => string;
  title?: string;
  action?: { label: string; to: string };
  /** Off where a health grid on the same screen already draws each source. */
  showSources?: boolean;
  className?: string;
}

/** The ruled columns, with and without the sources column; literal so the
 * stylesheet generator sees every one. */
const COLUMNS = {
  sources: "grid-cols-[minmax(8rem,1fr)_6rem] @lg:grid-cols-[minmax(9rem,1.3fr)_minmax(7rem,1fr)_6rem_5rem] @3xl:grid-cols-[minmax(10rem,1.4fr)_minmax(8rem,1.2fr)_7rem_6rem_5rem]",
  plain: "grid-cols-[minmax(8rem,1fr)_6rem] @lg:grid-cols-[minmax(9rem,1.3fr)_minmax(7rem,1fr)_6rem] @3xl:grid-cols-[minmax(10rem,1.4fr)_minmax(8rem,1.2fr)_7rem_7rem]",
} as const;

const SOURCE_FILL: Record<PortfolioSource["state"], string> = {
  working: "bg-healthy",
  collecting: "bg-healthy/50",
  overdue: "bg-warn",
  failing: "bg-error",
  "not-connected": "bg-muted-foreground/30",
  "not-using": "bg-transparent ring-1 ring-inset ring-muted-foreground/30",
  unknown: "bg-transparent ring-1 ring-inset ring-dashed ring-muted-foreground/50",
};

/** Live of the sources a site owes (anything it does not use is left out). */
export function sourcesLive(sources: readonly PortfolioSource[]): { live: number; owed: number; failing: number } {
  const owed = sources.filter((source) => source.state !== "not-using");
  return {
    live: owed.filter((source) => source.state === "working" || source.state === "collecting").length,
    owed: owed.length,
    failing: owed.filter((source) => source.state === "failing").length,
  };
}

export function PortfolioRows({ rows, formatMoney, title = "Sites", action, showSources = true, className }: PortfolioRowsProps) {
  return (
    <section aria-label={title} data-portfolio-rows="" className={cn("@container flex min-w-0 flex-col rounded-xl bg-card ring-1 ring-border/70", className)}>
      <header className="flex items-baseline justify-between gap-3 px-5 pb-2 pt-4">
        <div className="flex items-baseline gap-3">
          <h2 className={cn("m-0", eyebrowClass)}>{title}</h2>
          <span className="text-sm tabular-nums text-muted-foreground">{formatInt(rows.length)}</span>
        </div>
        {action ? (
          <Link to={action.to} className="whitespace-nowrap text-xs font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            {action.label}
          </Link>
        ) : null}
      </header>
      <div role="table" aria-label={title} className="flex flex-col">
        <div role="row" className={cn("grid gap-x-4 border-b border-border/60 px-5 pb-1.5 text-micro font-medium text-muted-foreground", COLUMNS[showSources ? "sources" : "plain"])}>
          <span role="columnheader">Site</span>
          <span role="columnheader" className="hidden @lg:block">People a day</span>
          <span role="columnheader" className="text-end">Yesterday</span>
          <span role="columnheader" className="hidden @3xl:block">Share of month</span>
          {showSources ? <span role="columnheader" className="hidden text-end @lg:block">Sources</span> : null}
        </div>
        {rows.map((row, index) => (
          <SiteRow key={row.id} row={row} formatMoney={formatMoney} index={index} showSources={showSources} />
        ))}
      </div>
    </section>
  );
}

function SiteRow({ row, formatMoney, index, showSources }: { row: PortfolioRow; formatMoney: (value: number) => string; index: number; showSources: boolean }) {
  const { live, owed, failing } = sourcesLive(row.sources);
  const name = (
    <span className="flex min-w-0 items-center gap-2.5">
      {row.icon ? <span className="shrink-0">{row.icon}</span> : null}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground" title={row.name}>{row.name}</span>
        <span
          className={cn(
            "truncate text-micro",
            row.health.tone === "error" ? "font-semibold text-error" : row.health.tone === "warn" ? "font-semibold text-warn" : "text-muted-foreground",
          )}
        >
          {row.health.word}
        </span>
      </span>
    </span>
  );
  return (
    <div
      role="row"
      data-portfolio-row={row.id}
      className={cn("viz-arrive grid items-center gap-x-4 border-b border-border/40 px-5 py-2.5 last:border-b-0 hover:bg-muted/30", COLUMNS[showSources ? "sources" : "plain"])}
      style={{ ["--viz-i" as string]: index }}
    >
      <span role="cell" className="min-w-0">
        {row.to ? (
          <Link to={row.to} className="block min-w-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">{name}</Link>
        ) : name}
      </span>
      <span role="cell" className="hidden min-w-0 items-center gap-2 @lg:flex">
        {row.people.length >= 3 ? (
          <>
            <Sparkline
              data={row.people}
              tone="traffic"
              area
              average={false}
              provisionalFrom={row.peopleProvisionalFrom ?? null}
              ariaLabel={`${row.name}: people a day`}
              size="wide"
              className="min-w-0 flex-1"
            />
            <span className="w-12 shrink-0 text-end text-xs tabular-nums text-foreground">{row.peopleLatest === null ? "" : formatInt(row.peopleLatest)}</span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">no visitors reported</span>
        )}
      </span>
      <span role="cell" className="flex flex-col items-end tabular-nums">
        {row.revenue === null ? (
          <span className="text-xs text-muted-foreground">no revenue</span>
        ) : (
          <>
            <span className="text-sm font-semibold text-foreground">{formatMoney(row.revenue)}</span>
            {row.revenueChange != null ? (
              <DeltaChip
                value={row.revenueChange}
                render={(n) => `${formatPercent(n)}%`}
                tone={performanceTone(row.revenueChange)}
                meaning={`${formatPercent(Math.abs(row.revenueChange))}% ${row.revenueChange >= 0 ? "up" : "down"} on the same day last week`}
                className="text-micro"
              />
            ) : null}
          </>
        )}
      </span>
      <span role="cell" className="hidden items-center gap-2 @3xl:flex">
        {row.share === null ? (
          <span className="sr-only">no revenue</span>
        ) : (
          <>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-viz-track">
              <span className="viz-grow-x block h-full rounded-full bg-financial-revenue" style={{ width: `${Math.max(2, row.share * 100)}%`, ["--viz-i" as string]: index }} />
            </span>
            <span className="w-9 shrink-0 text-end text-micro tabular-nums text-muted-foreground">{formatPercent(row.share * 100)}%</span>
          </>
        )}
      </span>
{showSources ? (
            <span role="cell" className="hidden items-center justify-end gap-1.5 @lg:flex" aria-label={`${live} of ${owed} data sources live${failing ? `, ${failing} failing` : ""}`}>
        <span aria-hidden className="flex gap-0.5">
          {row.sources.map((source) => (
            <span key={source.label} title={`${source.label}: ${source.state.replace("-", " ")}`} className={cn("h-3 w-1.5 rounded-xs", SOURCE_FILL[source.state])} />
          ))}
        </span>
        <span aria-hidden className={cn("w-8 text-end text-micro tabular-nums", failing ? "font-semibold text-error" : "text-muted-foreground")}>
          {live}/{owed}
        </span>
      </span>
      ) : null}
    </div>
  );
}
