import { CircleCheck, Hand, Hourglass } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { weekMove, type WeekMove, type WorkWeeks } from "@shared/work";
import { DeltaChip } from "@/components/DeltaChip";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { PaceBar } from "@/components/viz/PaceBar";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

// Work as flow, one row per project around a centre line: what got done this
// week grows left in the win's green, last week's done as a dashed outline
// under it, and what is still open grows right — in progress solid, ready to
// start lighter, blocked hatched in warn. Both sides share one scale, so a
// project that finishes as much as it holds reads as balanced and one whose
// queue dwarfs its week reads as stuck, before any number is read. Each figure
// above carries its move over the week, and done this week is drawn against
// last week's on one bar.

export interface WorkFlowRow {
  id: string;
  name: string;
  to?: string;
  /** Closed this week. */
  done: number;
  /** Closed last week, all seven days; absent or null when not known. */
  doneLastWeek?: number | null;
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
  /** The shown projects' weeks summed (`sumWorkWeeks`): each figure's move and
   * last week's done. Null or absent draws the figures alone. */
  weeks?: WorkWeeks | null;
  title?: string;
  action?: ReactNode;
  /** For a fixed-height screen: one line of figures, no key, no second line per row. */
  compact?: boolean;
  /** Compact only: the rows a box too short for every project draws, the
   * rest counted on one line under them ("+2 more projects"). All when absent. */
  shownRows?: number;
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

/** The one scale both sides of every row share, last week's done included. */
export function workScale(rows: readonly WorkFlowRow[]): number {
  return Math.max(1, ...rows.map((row) => Math.max(row.done, row.doneLastWeek ?? 0, workQueue(row))));
}

/** How far into the week today is, in words: "3 days in". */
export function weekDaysIn(daysIn: number): string {
  return `${daysIn} ${daysIn === 1 ? "day" : "days"} in`;
}

/** What a state's figure is compared with, and what a week's closes are. */
export const A_WEEK_AGO = "a week ago";
export const LAST_WEEK_BY_TODAY = "last week by today";

/**
 * A work figure's move as the kit's change chip: the arrow and the count, what
 * it is compared with in words, and how many entered the state over the week.
 * The tone follows the figure's better direction (`weekMove`); the arrow and
 * the words carry it without the colour. Nothing is drawn when the earlier
 * reading is unknown.
 */
export function WorkWeekChip({ move, against, added = null, className }: {
  move: WeekMove | null;
  against: string;
  added?: number | null;
  className?: string;
}) {
  if (!move) return null;
  const tone = move.verdict === "good" ? "positive" : move.verdict === "bad" ? "negative" : "neutral";
  const level = move.by === 0;
  const meaning = level ? `Level with ${against}` : `${formatInt(Math.abs(move.by))} ${move.by > 0 ? "more" : "fewer"} than ${against}`;
  return (
    <span className={cn("inline-flex flex-wrap items-baseline gap-x-1.5 text-xs tabular-nums", className)} data-week-move={move.verdict}>
      {/* A level week is said in words: a dash beside a zero reads as minus. */}
      <DeltaChip value={move.by} render={(size) => (level ? "level" : formatInt(size))} tone={tone} meaning={meaning} className="text-xs font-semibold" />
      <span className="text-muted-foreground">{level ? "with" : "vs"} {against}</span>
      {added !== null && added > 0 ? <span className="whitespace-nowrap text-muted-foreground" data-week-added="">· {formatInt(added)} added</span> : null}
    </span>
  );
}

/** "+2 more projects": the rows a short box leaves out, as its last line says it. */
export function moreProjects(count: number): string {
  return `+${formatInt(count)} more ${count === 1 ? "project" : "projects"}`;
}

/**
 * How many project rows a compact box draws: every row when they all fit
 * under what is above them, else as many as fit with one row's height left
 * for the line that counts the rest. In the box's own pixels: its height,
 * where the first row starts, and one row's height (its border included).
 */
export function workRowsThatFit({ height, top, row, rows }: { height: number; top: number; row: number; rows: number }): number {
  if (row <= 0 || top + rows * row <= height + 0.5) return rows;
  return Math.max(0, Math.min(rows, Math.floor((height - top - row + 0.5) / row)));
}

export function WorkFlow({ rows, waiting = null, weeks = null, title = "Work", action, compact = false, shownRows, figures = true, headingClassName, className }: WorkFlowProps) {
  const scale = workScale(rows);
  const total = rows.reduce(
    (sum, row) => ({ done: sum.done + row.done, inProgress: sum.inProgress + row.inProgress, blocked: sum.blocked + row.blocked, open: sum.open + workQueue(row) }),
    { done: 0, inProgress: 0, blocked: 0, open: 0 },
  );
  const share = (count: number) => `${(count / scale) * 100}%`;
  // No project's snapshot is no count at all, never three zeros.
  const counted = rows.length > 0;
  const unread = <span className="text-sm font-medium text-muted-foreground">not read</span>;
  // A figure is compared only when it is a whole count: a lower bound or an
  // old inbox has no move to state.
  const waitingMove = waiting && !waiting.partial && !waiting.stale ? weekMove("waiting", waiting.count, weeks?.waiting.before ?? null) : null;
  const done = weeks?.done ?? null;
  const doneMove = counted && done?.now != null ? weekMove("done", total.done, done.before) : null;
  const lastWeek = counted && done ? done.lastWeek : null;
  const lastWeekShown = rows.some((row) => (row.doneLastWeek ?? 0) > 0);
  // A fixed-height screen keeps each move to one line: how many entered a
  // state stays in the chip's words on the desk only.
  const added = (count: number | null | undefined) => (compact ? null : count ?? null);
  const drawn = compact && shownRows !== undefined ? rows.slice(0, shownRows) : rows;
  const hidden = rows.length - drawn.length;
  // On a fixed-height screen wide enough for it (80 rem, the TV's tile under
  // the site rows), the heading and the four figures are one band.
  const band = compact && figures;

  return (
    <section aria-label={title} data-work-flow="" className={cn("@container flex min-w-0 flex-col", compact ? "gap-2" : "gap-4", className)}>
      <div className={cn(band ? "flex flex-col gap-2 @7xl:flex-row @7xl:items-start @7xl:justify-between @7xl:gap-x-10" : "contents")} data-work-band={band ? "" : undefined}>
        <header className={cn("flex flex-wrap items-baseline justify-between gap-3", band && "@7xl:shrink-0 @7xl:flex-col @7xl:items-start @7xl:gap-1")}>
          <h2 className={cn("m-0", headingClassName ?? eyebrowClass)}>{title}</h2>
          {action}
        </header>
        {/* On a fixed-height screen each figure takes its own width, so a
            move's words stay on one line beside the others. */}
        {figures ? <div className={cn("grid gap-x-6 gap-y-3", compact ? "grid-cols-2 @md:grid-cols-[repeat(4,minmax(0,auto))] @md:justify-between @7xl:flex-1" : "grid-cols-2 @xl:grid-cols-4")}>
          <Figure icon={<Hand aria-hidden className="size-4" />} label="Your decisions" ink={waiting && waiting.count > 0 ? "text-warn" : undefined} condition="human-gates" compact={compact}
            change={<WorkWeekChip move={waitingMove} against={A_WEEK_AGO} added={added(weeks?.waiting.added)} />}>
            <WaitingFigure waiting={waiting} />
          </Figure>
          <Figure label="In progress" compact={compact}
            change={counted ? <WorkWeekChip move={weekMove("inProgress", total.inProgress, weeks?.inProgress.before ?? null)} against={A_WEEK_AGO} added={added(weeks?.inProgress.added)} /> : null}>
            {counted ? formatInt(total.inProgress) : unread}
          </Figure>
          <Figure icon={<CircleCheck aria-hidden className="size-4" />} label="Done this week" ink="text-milestone" compact={compact}
            change={<WorkWeekChip move={doneMove} against={LAST_WEEK_BY_TODAY} />}>
            {counted ? formatInt(total.done) : unread}
          </Figure>
          <Figure icon={<Hourglass aria-hidden className="size-4" />} label="Blocked" ink={total.blocked > 0 ? "text-warn" : undefined} compact={compact}
            change={counted ? <WorkWeekChip move={weekMove("blocked", total.blocked, weeks?.blocked.before ?? null)} against={A_WEEK_AGO} added={added(weeks?.blocked.added)} /> : null}>
            {counted ? (
              <>
                {formatInt(total.blocked)}
                <span className="ms-2 text-sm font-medium text-muted-foreground">of {formatInt(total.open)} open</span>
              </>
            ) : unread}
          </Figure>
        </div> : null}
      </div>
      {/* The two weeks as one bar: this week's done so far filled, where
          last week stood by today marked, last week's whole done the end of
          the ruled track. On a fixed-height screen its words sit beside it. */}
      {figures && lastWeek !== null ? (
        <div data-work-weeks="">
          <PaceBar
            value={total.done}
            label="Done this week"
            previousAtSameDay={done?.before ?? null}
            previousTotal={lastWeek}
            previousLabel="Done last week"
            tone="text-milestone"
            format={formatInt}
            showValue={false}
            inline={compact}
          />
        </div>
      ) : null}
      {/* One grid for the whole table, each row a subgrid of it: the name
          column is as wide as the longest name (up to half the table), so no
          name is cut and every row's bars start on the same line. */}
      {counted ? <div role="table" aria-label={`${title} by project`} className="grid grid-cols-[fit-content(45%)_minmax(0,1fr)_minmax(0,1.6fr)] gap-x-3">
        <div role="row" className="col-span-3 grid grid-cols-subgrid items-end pb-1.5 text-micro font-medium text-muted-foreground">
          <span role="columnheader">Project</span>
          <span role="columnheader" className="text-end">Done this week</span>
          <span role="columnheader">Still open</span>
        </div>
        {drawn.map((row, index) => {
          const queue = workQueue(row);
          const name = (
            // On a fixed-height screen the name's line is the bar's height,
            // so the row is as tall as its bar and no taller.
            <span className={cn("font-medium text-foreground", compact ? "text-wall-row" : "text-sm")} title={row.name}>
              {row.name}
            </span>
          );
          return (
            <div
              key={row.id}
              role="row"
              data-work-row={row.id}
              aria-label={`${row.name}: ${row.done} done this week${row.doneLastWeek != null ? `, ${row.doneLastWeek} last week` : ""}; ${queue} open, ${row.inProgress} in progress, ${row.blocked} blocked${row.urgent ? `, ${row.urgent} high priority` : ""}`}
              className={cn("viz-arrive col-span-3 grid grid-cols-subgrid items-start border-t border-border/40 @md:items-center", !compact && "py-2")}
              style={{ "--viz-i": index } as CSSProperties}
            >
              <span role="cell" className="flex min-w-0 flex-col">
                {row.to ? <Link to={row.to} className="min-w-0 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{name}</Link> : name}
                {row.urgent && !compact ? <span className="text-micro font-semibold text-error">{formatInt(row.urgent)} high priority</span> : null}
              </span>
              <span role="cell" aria-hidden className="flex h-5 items-center justify-end gap-2">
                <span className="text-xs tabular-nums text-milestone">{row.done > 0 ? formatInt(row.done) : ""}</span>
                {/* Last week's done, when known, is a dashed outline under
                    this week's bar, on the same scale. */}
                <span className="flex h-full w-full flex-col items-end justify-center gap-0.5">
                  <span className={cn("viz-grow-x viz-from-end rounded-s-sm bg-milestone/80", row.doneLastWeek != null ? "h-3" : "h-full")} style={{ width: share(row.done), "--viz-i": index } as CSSProperties} />
                  {row.doneLastWeek != null && row.doneLastWeek > 0 ? (
                    <span data-work-last-week={row.doneLastWeek} className="viz-grow-x viz-from-end h-1.5 rounded-s-sm border border-dashed border-milestone/70" style={{ width: share(row.doneLastWeek), "--viz-i": index } as CSSProperties} />
                  ) : null}
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
        {/* A box too short for every row draws whole rows and counts the
            rest here, one row tall: never a cut row or a scroll bar. */}
        {hidden > 0 ? (
          <div role="row" data-work-more={hidden} className="col-span-3 grid grid-cols-subgrid border-t border-border/40">
            <span role="cell" className="col-span-3 text-wall-row text-muted-foreground tabular-nums">{moreProjects(hidden)}</span>
          </div>
        ) : null}
      </div> : null}
      <div className={cn("flex flex-wrap gap-x-4 gap-y-1 text-micro text-muted-foreground", (compact || !counted) && "hidden")} aria-hidden>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-xs bg-milestone/80" />done this week</span>
        {lastWeekShown ? <span className="inline-flex items-center gap-1.5"><span className="h-2 w-3 rounded-xs border border-dashed border-milestone/70" />done last week</span> : null}
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

function Figure({ label, icon, ink, condition, compact = false, change, children }: { label: string; icon?: ReactNode; ink?: string; condition?: string; compact?: boolean; change?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-material-condition={condition} data-work-figure={label}>
      <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", ink ?? "text-muted-foreground")}>
        {icon}
        {label}
      </span>
      {/* In the TV's one band the move sits on the figure's line. */}
      <span className={cn("flex flex-col gap-0.5", compact && "@7xl:flex-row @7xl:items-baseline @7xl:gap-x-2.5 @7xl:whitespace-nowrap")} data-work-figure-value="">
        <span className={cn("text-figure-sm tabular-nums", ink ?? "text-foreground")}>{children}</span>
        {change}
      </span>
    </div>
  );
}
