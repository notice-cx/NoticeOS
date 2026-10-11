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

export interface WorkFlowProps {
  rows: readonly WorkFlowRow[];
  /** Waiting on the operator across every project, or null when not read. */
  waiting?: { count: number; urgent: number } | null;
  title?: string;
  action?: ReactNode;
  /** For a fixed-height screen: one line of figures, no key, no second line per row. */
  compact?: boolean;
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

export function WorkFlow({ rows, waiting = null, title = "Work", action, compact = false, className }: WorkFlowProps) {
  const scale = workScale(rows);
  const total = rows.reduce(
    (sum, row) => ({ done: sum.done + row.done, inProgress: sum.inProgress + row.inProgress, blocked: sum.blocked + row.blocked, open: sum.open + workQueue(row) }),
    { done: 0, inProgress: 0, blocked: 0, open: 0 },
  );
  const share = (count: number) => `${(count / scale) * 100}%`;

  return (
    <section aria-label={title} data-work-flow="" className={cn("@container flex min-w-0 flex-col gap-4", className)}>
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className={cn("m-0", eyebrowClass)}>{title}</h2>
        {action}
      </header>
      <div className={cn("grid gap-x-6 gap-y-3", compact ? "grid-cols-4" : "grid-cols-2 @xl:grid-cols-4")}>
        <Figure icon={<Hand aria-hidden className="size-4" />} label="Waiting on you" ink={waiting && waiting.count > 0 ? "text-warn" : undefined}>
          {waiting === null ? <span className="text-sm font-medium text-muted-foreground">not read</span> : formatInt(waiting.count)}
          {waiting && waiting.urgent > 0 ? <span className="ms-2 text-sm font-semibold text-error">{formatInt(waiting.urgent)} urgent</span> : null}
        </Figure>
        <Figure label="In progress">{formatInt(total.inProgress)}</Figure>
        <Figure icon={<CircleCheck aria-hidden className="size-4" />} label="Done this week" ink="text-milestone">{formatInt(total.done)}</Figure>
        <Figure icon={<Hourglass aria-hidden className="size-4" />} label="Blocked" ink={total.blocked > 0 ? "text-warn" : undefined}>
          {formatInt(total.blocked)}
          <span className="ms-2 text-sm font-medium text-muted-foreground">of {formatInt(total.open)} open</span>
        </Figure>
      </div>
      <div role="table" aria-label={`${title} by project`} className="flex flex-col">
        <div role="row" className="grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)_minmax(0,1.6fr)] items-end gap-x-3 pb-1.5 text-micro font-medium text-muted-foreground">
          <span role="columnheader">Project</span>
          <span role="columnheader" className="text-end">Done this week</span>
          <span role="columnheader">Still open</span>
        </div>
        {rows.map((row, index) => {
          const queue = workQueue(row);
          const name = (
            <span className="truncate text-sm font-medium text-foreground" title={row.name}>
              {row.name}
            </span>
          );
          return (
            <div
              key={row.id}
              role="row"
              data-work-row={row.id}
              aria-label={`${row.name}: ${row.done} done this week; ${queue} open, ${row.inProgress} in progress, ${row.blocked} blocked${row.urgent ? `, ${row.urgent} high priority` : ""}`}
              className={cn("viz-arrive grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)_minmax(0,1.6fr)] items-center gap-x-3 border-t border-border/40", compact ? "py-1" : "py-2")}
              style={{ "--viz-i": index } as CSSProperties}
            >
              <span role="cell" className="flex min-w-0 flex-col">
                {row.to ? <Link to={row.to} className="min-w-0 truncate rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{name}</Link> : name}
                {row.urgent && !compact ? <span className="text-micro font-semibold text-error">{formatInt(row.urgent)} high priority</span> : null}
              </span>
              <span role="cell" aria-hidden className="flex h-5 items-center justify-end gap-2">
                <span className="text-xs tabular-nums text-milestone">{row.done > 0 ? formatInt(row.done) : ""}</span>
                <span className="flex h-full w-full justify-end">
                  <span className="viz-grow-x viz-from-end h-full rounded-s-sm bg-milestone/80" style={{ width: share(row.done), "--viz-i": index } as CSSProperties} />
                </span>
              </span>
              <span role="cell" aria-hidden className="flex h-5 items-center gap-2 border-s-2 border-foreground/50 ps-0">
                <span className="flex h-full" style={{ width: share(queue) }}>
                  <span className="viz-grow-x h-full bg-foreground" style={{ flexGrow: row.inProgress, flexBasis: 0, "--viz-i": index } as CSSProperties} />
                  <span className="viz-grow-x h-full bg-muted-foreground/45" style={{ flexGrow: row.ready, flexBasis: 0, "--viz-i": index } as CSSProperties} />
                  <span className="viz-grow-x viz-hatch h-full rounded-e-sm border border-warn/60 text-warn" style={{ flexGrow: row.blocked, flexBasis: 0, "--viz-i": index } as CSSProperties} />
                </span>
                <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                  {formatInt(queue)}
                  {row.blocked > 0 ? <span className="text-warn"> · {formatInt(row.blocked)} blocked</span> : null}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <div className={cn("flex flex-wrap gap-x-4 gap-y-1 text-micro text-muted-foreground", compact && "hidden")} aria-hidden>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-xs bg-milestone/80" />done this week</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-xs bg-foreground" />in progress</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-xs bg-muted-foreground/45" />ready to start</span>
        <span className="inline-flex items-center gap-1.5"><span className="viz-hatch h-2 w-3 rounded-xs border border-warn/60 text-warn" />blocked</span>
      </div>
    </section>
  );
}

function Figure({ label, icon, ink, children }: { label: string; icon?: ReactNode; ink?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", ink ?? "text-muted-foreground")}>
        {icon}
        {label}
      </span>
      <span className={cn("text-figure-sm tabular-nums", ink ?? "text-foreground")}>{children}</span>
    </div>
  );
}
