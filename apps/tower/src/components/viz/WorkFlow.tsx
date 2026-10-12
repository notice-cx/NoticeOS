import { CircleCheck, Hand, Hourglass } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

// Work as flow, one row per project around a centre line: what got done this
// week grows left in the win's green, what is still open grows right — in
// progress solid, ready to start lighter, blocked hatched in warn. Both sides
// share one scale, so a project that finishes as much as it holds reads as
// balanced and one whose queue dwarfs its week reads as stuck, before any
// number is read.

export interface WorkFlowRow {
  id: string;
  name: string;
  to?: string;
  /** Closed in the trailing week. */
  done: number;
  inProgress: number;
  /** Open and not blocked: ready to start. */
  ready: number;
  /** Open, waiting on another task. */
  blocked: number;
  /** High-priority work not closed, or null when the snapshot did not measure it. */
  urgent: number | null;
}

/** Waiting on the operator across every project. */
export interface WorkWaiting {
  count: number;
  urgent: number;
  /** Not every project was counted: the figures are lower bounds ("3+"). */
  partial?: boolean;
  /** The task snapshot is old: a zero is not drawn as calm. */
  stale?: boolean;
}

export interface WorkFlowProps {
  rows: readonly WorkFlowRow[];
  /** Waiting on the operator across every project, or null when not read. */
  waiting?: WorkWaiting | null;
  title?: string;
  action?: ReactNode;
  /** For a fixed-height screen: one line of figures, no key, no second line per row. */
  compact?: boolean;
  /** Off where the screen states the same figures in its own answer. */
  figures?: boolean;
  /** The heading's type where the screen has its own eyebrow (the TV's). */
  headingClassName?: string;
  className?: string;
}

/** A project's queue: everything still open, split as the bar draws it. */
export function workQueue(row: Pick<WorkFlowRow, "inProgress" | "ready" | "blocked">): number {
  return row.inProgress + row.ready + row.blocked;
}

/** The one scale both sides of every row share. */
export function workScale(rows: readonly WorkFlowRow[]): number {
  return Math.max(1, ...rows.map((row) => Math.max(row.done, workQueue(row))));
}

export function WorkFlow({ rows, waiting = null, title = "Work", action, compact = false, figures = true, headingClassName, className }: WorkFlowProps) {
  const scale = workScale(rows);
  const total = rows.reduce(
    (sum, row) => ({ done: sum.done + row.done, inProgress: sum.inProgress + row.inProgress, blocked: sum.blocked + row.blocked, open: sum.open + workQueue(row) }),
    { done: 0, inProgress: 0, blocked: 0, open: 0 },
  );
  const share = (count: number) => `${(count / scale) * 100}%`;
  // No project's snapshot is no count at all, never three zeros.
  const counted = rows.length > 0;
  const unread = <span className="text-sm font-medium text-muted-foreground">not read</span>;

  return (
    <section aria-label={title} data-work-flow="" className={cn("@container flex min-w-0 flex-col gap-4", className)}>
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className={cn("m-0", headingClassName ?? eyebrowClass)}>{title}</h2>
        {action}
      </header>
      {figures ? <div className={cn("grid gap-x-6 gap-y-3", compact ? "grid-cols-4" : "grid-cols-2 @xl:grid-cols-4")}>
        <Figure icon={<Hand aria-hidden className="size-4" />} label="Your decisions" ink={waiting && waiting.count > 0 ? "text-warn" : undefined} condition="human-gates">
          <WaitingFigure waiting={waiting} />
        </Figure>
        <Figure label="In progress">{counted ? formatInt(total.inProgress) : unread}</Figure>
        <Figure icon={<CircleCheck aria-hidden className="size-4" />} label="Done this week" ink="text-milestone">{counted ? formatInt(total.done) : unread}</Figure>
        <Figure icon={<Hourglass aria-hidden className="size-4" />} label="Blocked" ink={total.blocked > 0 ? "text-warn" : undefined}>
          {counted ? (
            <>
              {formatInt(total.blocked)}
              <span className="ms-2 text-sm font-medium text-muted-foreground">of {formatInt(total.open)} open</span>
            </>
          ) : unread}
        </Figure>
      </div> : null}
      {/* One grid for the whole table, each row a subgrid of it: the name
          column is as wide as the longest name (up to half the table), so no
          name is cut and every row's bars start on the same line. */}
      {counted ? <div role="table" aria-label={`${title} by project`} className="grid grid-cols-[fit-content(45%)_minmax(0,1fr)_minmax(0,1.6fr)] gap-x-3">
        <div role="row" className="col-span-3 grid grid-cols-subgrid items-end pb-1.5 text-micro font-medium text-muted-foreground">
          <span role="columnheader">Project</span>
          <span role="columnheader" className="text-end">Done this week</span>
          <span role="columnheader">Still open</span>
        </div>
        {rows.map((row, index) => {
          const queue = workQueue(row);
          const name = (
            <span className="text-sm font-medium text-foreground" title={row.name}>
              {row.name}
            </span>
          );
          return (
            <div
              key={row.id}
              role="row"
              data-work-row={row.id}
              aria-label={`${row.name}: ${row.done} done this week; ${queue} open, ${row.inProgress} in progress, ${row.blocked} blocked${row.urgent ? `, ${row.urgent} high priority` : ""}`}
              className={cn("viz-arrive col-span-3 grid grid-cols-subgrid items-start border-t border-border/40 @md:items-center", compact ? "py-1" : "py-2")}
              style={{ "--viz-i": index } as CSSProperties}
            >
              <span role="cell" className="flex min-w-0 flex-col">
                {row.to ? <Link to={row.to} className="min-w-0 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{name}</Link> : name}
                {row.urgent && !compact ? <span className="text-micro font-semibold text-error">{formatInt(row.urgent)} high priority</span> : null}
              </span>
              <span role="cell" aria-hidden className="flex h-5 items-center justify-end gap-2">
                <span className="text-xs tabular-nums text-milestone">{row.done > 0 ? formatInt(row.done) : ""}</span>
                <span className="flex h-full w-full justify-end">
                  <span className="viz-grow-x viz-from-end h-full rounded-s-sm bg-milestone/80" style={{ width: share(row.done), "--viz-i": index } as CSSProperties} />
                </span>
              </span>
              {/* Every row's bar is drawn on one track that leaves room for the
                  longest count (in ems, so the TV's larger type keeps its room),
                  so the count follows its own bar and the biggest queue still fits; too narrow for that, the count
                  drops under the bar. */}
              <span
                role="cell"
                aria-hidden
                className="flex min-w-0 flex-col gap-0.5 border-s-2 border-foreground/50 text-xs @md:flex-row @md:items-center @md:gap-[0.5em]"
                style={{ "--share": queue / scale } as CSSProperties}
              >
                <span className="flex h-5 w-[calc(var(--share)*100%)] shrink-0 @md:w-[calc(var(--share)*(100%_-_11em))]">
                  <span className="viz-grow-x h-full bg-foreground" style={{ flexGrow: row.inProgress, flexBasis: 0, "--viz-i": index } as CSSProperties} />
                  <span className="viz-grow-x h-full bg-muted-foreground/45" style={{ flexGrow: row.ready, flexBasis: 0, "--viz-i": index } as CSSProperties} />
                  <span className="viz-grow-x viz-hatch h-full rounded-e-sm border border-warn/60 text-warn" style={{ flexGrow: row.blocked, flexBasis: 0, "--viz-i": index } as CSSProperties} />
                </span>
                <span className="ps-1 text-xs tabular-nums text-muted-foreground @md:whitespace-nowrap @md:ps-0">
                  {formatInt(queue)}
                  {row.blocked > 0 ? <> <span className="text-warn @md:whitespace-nowrap">· {formatInt(row.blocked)} blocked</span></> : null}
                </span>
              </span>
            </div>
          );
        })}
      </div> : null}
      <div className={cn("flex flex-wrap gap-x-4 gap-y-1 text-micro text-muted-foreground", (compact || !counted) && "hidden")} aria-hidden>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-xs bg-milestone/80" />done this week</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-xs bg-foreground" />in progress</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-xs bg-muted-foreground/45" />ready to start</span>
        <span className="inline-flex items-center gap-1.5"><span className="viz-hatch h-2 w-3 rounded-xs border border-warn/60 text-warn" />blocked</span>
      </div>
    </section>
  );
}

/** A count only where the snapshot earned it: an unread inbox says so, a
 * partial one is a lower bound, and a zero from a partial or old snapshot is
 * never drawn as calm. */
function WaitingFigure({ waiting }: { waiting: WorkWaiting | null }) {
  const quiet = "text-sm font-medium text-muted-foreground";
  if (waiting === null) return <span className={quiet}>not read</span>;
  const more = waiting.partial ? "+" : "";
  if (waiting.count === 0 && (waiting.partial || waiting.stale)) {
    return <span className={quiet}>{waiting.partial ? "unknown" : "stale"}</span>;
  }
  return (
    <>
      {formatInt(waiting.count)}{more}
      {waiting.urgent > 0 ? <span className="ms-2 text-sm font-semibold text-error">{formatInt(waiting.urgent)}{more} urgent</span> : null}
    </>
  );
}

function Figure({ label, icon, ink, condition, children }: { label: string; icon?: ReactNode; ink?: string; condition?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-material-condition={condition}>
      <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", ink ?? "text-muted-foreground")}>
        {icon}
        {label}
      </span>
      <span className={cn("text-figure-sm tabular-nums", ink ?? "text-foreground")}>{children}</span>
    </div>
  );
}
