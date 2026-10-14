import { Fragment, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, CircleAlert, CircleDashed, Clock3, ServerCog } from "lucide-react";
import { CONNECTION_LABELS, type SourceKind } from "@shared/connection-status";
import { ageMs, formatAge } from "@shared/freshness";
import { SegmentBar } from "@/components/SegmentBar";
import { eyebrowClass } from "@/components/surface/SectionLabel";
import { FitLabel } from "@/components/viz/FitLabel";
import { cn } from "@/lib/utils";

// Which data feeds work, on which subject, and since when, as one picture:
// rows are subjects (each site, and the System's own parts), columns are
// sources, and a broken feed lights up where it lives. A fresh failure is the
// loudest mark on the screen; one older than a week stays red but steps back
// to an outline, so new breakage always wins the eye.

export type HealthState = "working" | "collecting" | "overdue" | "failing" | "not-connected" | "not-using" | "unknown";

const FROM_SOURCE: Record<SourceKind, HealthState> = {
  working: "working",
  collecting: "collecting",
  "key-accepted": "collecting",
  "not-checked": "collecting",
  overdue: "overdue",
  failing: "failing",
  "not-connected": "not-connected",
  "not-using": "not-using",
  "not-applicable": "not-using",
  unknown: "unknown",
};

/** A source's status (`sourceReadings`) in the grid's seven states: proof not
 * yet in reads as collecting, a source that does not apply as deliberately off. */
export function healthStateOf(kind: SourceKind): HealthState {
  return FROM_SOURCE[kind];
}

export interface HealthColumn {
  id: string;
  /** The full name, on hover and to screen readers. */
  label: string;
  /** What the column header prints. */
  short: string;
}

export interface HealthCell {
  /** The `HealthColumn.id` this reading belongs to. */
  column: string;
  state: HealthState;
  /** When the cell entered this state; null when nobody recorded it. */
  since?: string | null;
  /** The state in the words every other screen uses for this source ("Up",
   * "Key accepted"), when they are more exact than the grid's own word. */
  label?: string;
  /** The store's own sentence about it: a failure's reason, a gap. */
  detail?: string | null;
  href?: string;
}

export interface HealthRow {
  id: string;
  name: string;
  icon?: ReactNode;
  href?: string;
  kind?: "site" | "system";
  /** The row's own parts when they are not the grid's sources (the System's
   * runner, jobs and backups). It draws under its own header, in the same
   * tracks. */
  columns?: readonly HealthColumn[];
  cells: readonly HealthCell[];
}

export interface HealthTally {
  working: number;
  collecting: number;
  failing: number;
  overdue: number;
  unknown: number;
  notConnected: number;
  notUsing: number;
  /** Every cell but the deliberately unused: the sources a subject is meant to have. */
  inPlay: number;
}

type Counted = Exclude<keyof HealthTally, "inPlay">;

const TALLY_FIELD: Record<HealthState, Counted> = {
  working: "working",
  collecting: "collecting",
  failing: "failing",
  overdue: "overdue",
  unknown: "unknown",
  "not-connected": "notConnected",
  "not-using": "notUsing",
};

/** The one count of a set of rows: the header's bar and words, each row's
 * "5 of 7". */
export function healthTally(rows: readonly Pick<HealthRow, "cells">[]): HealthTally {
  const tally: HealthTally = { working: 0, collecting: 0, failing: 0, overdue: 0, unknown: 0, notConnected: 0, notUsing: 0, inPlay: 0 };
  for (const row of rows) {
    for (const cell of row.cells) {
      tally[TALLY_FIELD[cell.state]] += 1;
      if (cell.state !== "not-using") tally.inPlay += 1;
    }
  }
  return tally;
}

/** Bar, legend and words share this order. Not using is a decision rather
 * than a source, so it is never tallied. */
const TALLIED: readonly HealthState[] = ["working", "collecting", "failing", "overdue", "unknown", "not-connected"];

const stateWord = (state: HealthState) => CONNECTION_LABELS[state].toLowerCase();

/** "31 working · 3 failing · 1 overdue · 9 not connected", zero counts left out. */
export function healthTallyWords(tally: HealthTally): string {
  return TALLIED.filter((state) => tally[TALLY_FIELD[state]] > 0)
    .map((state) => `${tally[TALLY_FIELD[state]]} ${stateWord(state)}`)
    .join(" · ");
}

const DAY_MS = 86_400_000;
/** A failure older than this stays red but quiet. */
const QUIET_AFTER_MS = 7 * DAY_MS;

export interface HealthProblem {
  row: HealthRow;
  column: HealthColumn;
  cell: HealthCell;
  /** How long it has been in this state; null when the start was not recorded. */
  ageMs: number | null;
}

type ResolvedRow = HealthRow & { columns: readonly HealthColumn[]; cells: readonly HealthCell[] };

/** Each row's cells in its columns' order. A column the row has no reading for
 * is unknown, never a blank. */
function resolveRows(rows: readonly HealthRow[], columns: readonly HealthColumn[]): ResolvedRow[] {
  return rows.map((row) => {
    const own = row.columns ?? columns;
    return {
      ...row,
      columns: own,
      cells: own.map((column) => row.cells.find((cell) => cell.column === column.id) ?? { column: column.id, state: "unknown" }),
    };
  });
}

/** Fresh failures, then failures of unknown age, then week-old ones, then
 * overdue; youngest first within each, so new breakage leads. */
function problemRank(problem: HealthProblem): number {
  const { ageMs: age } = problem;
  if (problem.cell.state === "failing") return age === null ? 1 : age >= QUIET_AFTER_MS ? 2 : 0;
  return age === null ? 4 : 3;
}

function problemsOf(rows: readonly ResolvedRow[], nowMs: number): HealthProblem[] {
  const found = rows.flatMap((row) =>
    row.cells.flatMap((cell, index) =>
      cell.state === "failing" || cell.state === "overdue"
        ? [{ row, column: row.columns[index]!, cell, ageMs: ageMs(nowMs, cell.since) }]
        : [],
    ),
  );
  return found.sort((a, b) => problemRank(a) - problemRank(b) || (a.ageMs ?? 0) - (b.ageMs ?? 0));
}

/** Every failing and overdue cell, the one to name first at the head. */
export function healthProblems(rows: readonly HealthRow[], columns: readonly HealthColumn[], nowMs: number): HealthProblem[] {
  return problemsOf(resolveRows(rows, columns), nowMs);
}

function problemParts(problem: HealthProblem): { where: string; joint: string; status: string } {
  const where = `${problem.column.label} on ${problem.row.name}`;
  const state = stateWord(problem.cell.state);
  return problem.ageMs === null
    ? { where, joint: " is ", status: state }
    : { where, joint: ", ", status: `${state} ${formatAge(problem.ageMs)}` };
}

/** "Uptime on Summit, failing 37m". */
export function problemSentence(problem: HealthProblem): string {
  const { where, joint, status } = problemParts(problem);
  return `${where}${joint}${status}`;
}

/** "Failing since 6h ago"; a failure or a lateness with no recorded start says so. */
function stateSince(cell: HealthCell, nowMs: number): string {
  const word = cell.label ?? CONNECTION_LABELS[cell.state];
  const age = ageMs(nowMs, cell.since);
  if (age !== null) return `${word} since ${formatAge(age)} ago`;
  return cell.state === "failing" || cell.state === "overdue" ? `${word}, since unknown` : word;
}

/** The cell's whole story in one line: its accessible name and its tooltip. */
export function cellSentence(row: Pick<HealthRow, "name">, column: HealthColumn, cell: HealthCell, nowMs: number): string {
  return [row.name, column.label, stateSince(cell, nowMs), cell.detail].filter(Boolean).join(" · ");
}

// --- drawing ------------------------------------------------------------------

type Look = HealthState | "failing-quiet";

function lookOf(state: HealthState, age: number | null): Look {
  return state === "failing" && age !== null && age >= QUIET_AFTER_MS ? "failing-quiet" : state;
}

/** The wide grid's mark. Only a fresh failure is solid. */
const TILE: Record<Look, string> = {
  // Calm: a working cell recedes to a quiet slot so the failing ones carry the colour.
  working: "bg-healthy-soft text-healthy group-data-[calm]/grid:bg-muted/40 group-data-[calm]/grid:text-healthy/70",
  collecting: "border border-healthy/50 text-healthy",
  overdue: "border border-warn/45 bg-warn-soft text-warn",
  failing: "bg-error text-error-foreground",
  "failing-quiet": "border border-error/70 text-error",
  "not-connected": "viz-hatch border border-border text-muted-foreground",
  "not-using": "text-muted-foreground",
  unknown: "border border-dashed border-muted-foreground/50 text-muted-foreground",
};

/** The narrow strip's mark: shape as well as ink, since a dot has no room
 * for a glyph (circle working, square overdue, diamond failing). Hatching
 * reads as a slash at this size, so not connected is an empty ring here. */
const DOT: Record<Look, string> = {
  working: "size-2.5 rounded-full bg-healthy",
  collecting: "size-2.5 rounded-full border-2 border-healthy",
  overdue: "size-2.5 rounded-xs bg-warn",
  failing: "size-3 rotate-45 rounded-xs bg-error",
  "failing-quiet": "size-2.5 rotate-45 rounded-xs border-2 border-error",
  "not-connected": "size-2.5 rounded-full border border-muted-foreground/60",
  "not-using": "size-1 rounded-full bg-muted-foreground/40",
  unknown: "grid size-3.5 place-items-center rounded-full border border-dashed border-muted-foreground/70 text-muted-foreground",
};

const FILL: Record<HealthState, string> = {
  working: "bg-healthy",
  collecting: "bg-healthy/45",
  failing: "bg-error",
  overdue: "bg-warn",
  unknown: "bg-muted-foreground/60",
  "not-connected": "viz-hatch text-muted-foreground",
  "not-using": "bg-muted-foreground/30",
};

const INK: Record<HealthState, string> = {
  working: "text-healthy",
  collecting: "text-healthy",
  failing: "text-error",
  overdue: "text-warn",
  unknown: "text-muted-foreground",
  "not-connected": "text-muted-foreground",
  "not-using": "text-muted-foreground",
};

function TileMark({ look, age }: { look: Look; age: string | null }) {
  switch (look) {
    case "working":
      return <Check className="size-3.5" strokeWidth={2.75} aria-hidden />;
    case "collecting":
      return (
        <span className="viz-breathe grid place-items-center rounded-full">
          <CircleDashed className="size-3.5" strokeWidth={2.5} aria-hidden />
        </span>
      );
    case "overdue":
      return (
        <>
          <Clock3 className="size-3.5 shrink-0" strokeWidth={2.5} aria-hidden />
          {age ? <span className="text-xs font-medium tabular-nums">{age}</span> : null}
        </>
      );
    case "failing":
      return (
        <>
          {/* The age is the mark when the column is narrow; the glyph joins it
              when there is room, and stands alone when no start was recorded. */}
          <CircleAlert className={cn("size-4 shrink-0", age && "hidden @3xl:block")} strokeWidth={2.5} aria-hidden />
          {age ? <span className="text-sm font-semibold tabular-nums">{age}</span> : null}
        </>
      );
    case "failing-quiet":
      return (
        <>
          <CircleAlert className={cn("size-3.5 shrink-0", age && "hidden @3xl:block")} strokeWidth={2.25} aria-hidden />
          {age ? <span className="text-xs font-medium tabular-nums">{age}</span> : null}
        </>
      );
    case "not-connected":
      return null;
    case "not-using":
      return <span className="size-1 rounded-full bg-muted-foreground/40" />;
    case "unknown":
      return <span className="text-xs font-semibold">?</span>;
  }
}

/** A place focus can stand: a row, and a column or -1 for the row's own name. */
interface Target {
  r: number;
  c: number;
}

const targetKey = ({ r, c }: Target) => `${r}:${c}`;

function parseTarget(key: string | undefined): Target | null {
  const match = key?.match(/^(\d+):(-?\d+)$/);
  return match ? { r: Number(match[1]), c: Number(match[2]) } : null;
}

/** The grid's arrow-key walk: one tab stop for the whole grid, and the
 * arrows, Home and End move inside it. */
function step(rows: readonly ResolvedRow[], from: Target, key: string, toCorner: boolean): Target | null {
  const row = rows[from.r];
  if (!row) return null;
  const first = (r: ResolvedRow) => (r.href ? -1 : 0);
  const last = row.columns.length - 1;
  switch (key) {
    case "ArrowRight":
      return from.c < last ? { r: from.r, c: from.c + 1 } : null;
    case "ArrowLeft":
      return from.c > first(row) ? { r: from.r, c: from.c - 1 } : null;
    case "ArrowDown":
    case "ArrowUp": {
      const r = from.r + (key === "ArrowDown" ? 1 : -1);
      const next = rows[r];
      if (!next) return null;
      return { r, c: from.c < 0 ? first(next) : Math.min(from.c, next.columns.length - 1) };
    }
    case "Home":
      return toCorner ? { r: 0, c: first(rows[0]!) } : { r: from.r, c: first(row) };
    case "End": {
      if (!toCorner) return { r: from.r, c: last };
      const r = rows.length - 1;
      return { r, c: rows[r]!.columns.length - 1 };
    }
    default:
      return null;
  }
}

interface Band {
  columns: readonly HealthColumn[];
  kind: "site" | "system";
  /** Index of the band's first row. */
  first: number;
  rows: ResolvedRow[];
  /** Grid line of the band's header; its rows follow it. */
  line: number;
}

/** Consecutive rows that share their columns draw under one header. */
function bandsOf(rows: readonly ResolvedRow[]): Band[] {
  const bands: Band[] = [];
  let line = 1;
  rows.forEach((row, r) => {
    const last = bands.at(-1);
    if (last && last.columns.length === row.columns.length && last.columns.every((column, i) => column.id === row.columns[i]!.id)) {
      last.rows.push(row);
      line += 1;
      return;
    }
    bands.push({ columns: row.columns, kind: row.kind ?? "site", first: r, rows: [row], line });
    line += 2;
  });
  return bands;
}

const TOOLTIP_ALIGN = { start: "left-0", center: "left-1/2 -translate-x-1/2", end: "right-0" } as const;

interface CellViewProps {
  row: ResolvedRow;
  column: HealthColumn;
  cell: HealthCell;
  nowMs: number;
  at: Target;
  tabbable: boolean;
  active: boolean;
  align: keyof typeof TOOLTIP_ALIGN;
  register: (key: string, element: HTMLElement | null) => void;
  onEnter: (at: Target) => void;
  onLeave: (at: Target) => void;
  onFocusTarget: (at: Target) => void;
}

function CellView({ row, column, cell, nowMs, at, tabbable, active, align, register, onEnter, onLeave, onFocusTarget }: CellViewProps) {
  const age = ageMs(nowMs, cell.since);
  const look = lookOf(cell.state, age);
  const key = targetKey(at);
  const frame = {
    ref: (element: HTMLElement | null) => register(key, element),
    "aria-label": cellSentence(row, column, cell, nowMs),
    tabIndex: tabbable ? 0 : -1,
    "data-health-target": key,
    onFocus: () => onFocusTarget(at),
    onBlur: () => onLeave(at),
    onPointerEnter: () => onEnter(at),
    onPointerLeave: () => onLeave(at),
    className:
      "relative grid h-6 w-5 place-items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring @2xl:h-10 @2xl:w-full",
  };
  const body = (
    <>
      <span aria-hidden className={cn("@2xl:hidden", DOT[look])}>
        {look === "unknown" ? <span className="text-micro leading-none font-semibold">?</span> : null}
      </span>
      <span
        aria-hidden
        className={cn("hidden size-full items-center justify-center gap-1 rounded-lg transition-colors @2xl:flex", TILE[look])}
      >
        <TileMark look={look} age={age === null ? null : formatAge(age)} />
      </span>
      {active ? (
        <span
          aria-hidden
          data-health-tooltip
          className={cn(
            "pointer-events-none absolute bottom-full z-20 mb-2 grid w-max max-w-64 gap-0.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-left text-xs text-card-foreground shadow-lg",
            TOOLTIP_ALIGN[align],
          )}
        >
          <span className="font-medium">
            {row.name} · {column.label}
          </span>
          <span className={INK[cell.state]}>{stateSince(cell, nowMs)}</span>
          {cell.detail ? <span className="text-muted-foreground">{cell.detail}</span> : null}
        </span>
      ) : null}
    </>
  );
  return (
    <div
      role="gridcell"
      data-health-cell={`${row.id}:${column.id}`}
      data-state={cell.state}
      data-quiet={look === "failing-quiet" ? "" : undefined}
      className="flex min-w-0 justify-center"
    >
      {cell.href ? (
        <Link to={cell.href} {...frame}>
          {body}
        </Link>
      ) : (
        <span role="img" {...frame}>
          {body}
        </span>
      )}
    </div>
  );
}

interface RowHeadProps {
  row: ResolvedRow;
  problems: readonly HealthProblem[];
  at: Target;
  tabbable: boolean;
  register: (key: string, element: HTMLElement | null) => void;
  onFocusTarget: (at: Target) => void;
}

function RowHead({ row, problems, at, tabbable, register, onFocusTarget }: RowHeadProps) {
  const tally = healthTally([row]);
  const key = targetKey(at);
  const monogram = [...row.name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <div role="rowheader" className="flex min-w-0 items-center gap-2.5 ps-1.5 pe-2">
      {/* A row's own icon is drawn bare; only a glyph or a monogram standing
          in for one sits on a tile. */}
      <span aria-hidden className="grid size-6 shrink-0 place-items-center text-xs font-semibold text-muted-foreground">
        {row.icon ?? (
          <span className="grid size-5 place-items-center rounded-[22%] bg-muted">
            {row.kind === "system" ? <ServerCog className="size-3.5" /> : monogram}
          </span>
        )}
      </span>
      <span className="grid min-w-0 gap-0.5">
        {row.href ? (
          <Link
            to={row.href}
            ref={(element) => register(key, element)}
            tabIndex={tabbable ? 0 : -1}
            data-health-target={key}
            onFocus={() => onFocusTarget(at)}
            title={row.name}
            className="block rounded-sm text-sm leading-6 font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {row.name}
          </Link>
        ) : (
          <span title={row.name} className="block text-sm leading-6 font-medium text-foreground">
            {row.name}
          </span>
        )}
        <span data-health-live className={cn("items-center gap-1.5", problems.length > 0 ? "hidden @2xl:flex" : "flex")}>
          <span className="text-micro whitespace-nowrap tabular-nums text-muted-foreground">
            {tally.inPlay === 0 ? (
              "none in use"
            ) : (
              <>
                {tally.working} of {tally.inPlay}
                <span className="sr-only"> working</span>
              </>
            )}
          </span>
          {tally.inPlay > 0 ? (
            <span aria-hidden className="h-1 w-8 overflow-hidden rounded-full bg-viz-track">
              <span className="block h-full rounded-full bg-healthy" style={{ width: `${(tally.working / tally.inPlay) * 100}%` }} />
            </span>
          ) : null}
        </span>
        {problems.length > 0 ? (
          <span data-health-row-problems className="flex min-w-0 flex-wrap gap-x-2 @2xl:hidden">
            {problems.map((problem) => {
              const Glyph = problem.cell.state === "failing" ? CircleAlert : Clock3;
              return (
                <span key={problem.column.id} className={cn("inline-flex items-center gap-1 whitespace-nowrap", INK[problem.cell.state])}>
                  <Glyph className="size-3 shrink-0" strokeWidth={2.5} aria-hidden />
                  <span className="text-micro font-medium tabular-nums">
                    {problem.column.short}
                    {problem.ageMs === null ? "" : ` ${formatAge(problem.ageMs)}`}
                  </span>
                </span>
              );
            })}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function Headline({ problems, tally }: { problems: readonly HealthProblem[]; tally: HealthTally }) {
  const [first] = problems;
  if (!first) {
    if (tally.unknown > 0) {
      return (
        <p data-health-headline="unknown" className="m-0 flex items-center gap-1.5 text-sm text-muted-foreground">
          <span aria-hidden className="grid size-4 place-items-center rounded-full border border-dashed border-current text-micro font-semibold">
            ?
          </span>
          {tally.unknown} unknown
        </p>
      );
    }
    if (tally.inPlay === 0) return null;
    return (
      <p data-health-headline="clear" className="m-0 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Check className="size-4 text-healthy" strokeWidth={2.75} aria-hidden />
        Nothing failing or overdue
      </p>
    );
  }
  const Glyph = first.cell.state === "failing" ? CircleAlert : Clock3;
  const { where, joint, status } = problemParts(first);
  // "failing 37m" wraps as one, never as "failing" and a stray "37m".
  const sentence = (
    <>
      {where}
      {joint}
      <span className="whitespace-nowrap">{status}</span>
    </>
  );
  const more = problems.length - 1;
  return (
    <p
      data-health-headline={first.cell.state}
      className="m-0 flex min-w-0 items-start gap-2 text-base font-semibold text-foreground @2xl:text-lg"
    >
      <Glyph className={cn("mt-0.5 size-5 shrink-0 @2xl:mt-1", INK[first.cell.state])} strokeWidth={2.5} aria-hidden />
      <span className="min-w-0">
        {first.cell.href ? (
          <Link
            to={first.cell.href}
            className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {sentence}
          </Link>
        ) : (
          sentence
        )}
        {more > 0 ? <span className="ms-2 text-sm font-normal whitespace-nowrap text-muted-foreground">and {more} more</span> : null}
      </span>
    </p>
  );
}

export interface HealthGridProps {
  rows: readonly HealthRow[];
  /** The sources, in column order; a row with its own `columns` overrides them. */
  columns: readonly HealthColumn[];
  nowMs: number;
  title?: ReactNode;
  /** The header's one link out, at its right. */
  action?: ReactNode;
  /** Shown in place of the grid when there are no rows. */
  empty?: ReactNode;
  /** Working cells recede to quiet slots, leaving colour to the problems. */
  calm?: boolean;
  className?: string;
}

/**
 * Subjects × sources, each cell a state with its age. Rows keep the given
 * order, so an operator learns where each site sits. From about 640px of its
 * own width it draws the full grid under column headers; below that each row
 * is its name, a strip of state marks in the same tracks, and its problems
 * named. Hovering or focusing a cell lights its row and column and shows its
 * story; the grid is one tab stop, walked with the arrow keys.
 */
export function HealthGrid({ rows, columns, nowMs, title = "Data sources", action, empty = "No sites yet", calm = false, className }: HealthGridProps) {
  const titleId = useId();
  const resolved = useMemo(() => resolveRows(rows, columns), [rows, columns]);
  const tally = useMemo(() => healthTally(resolved), [resolved]);
  const problems = useMemo(() => problemsOf(resolved, nowMs), [resolved, nowMs]);
  const bands = useMemo(() => bandsOf(resolved), [resolved]);
  const width = Math.max(1, ...resolved.map((row) => row.columns.length));
  const [active, setActive] = useState<Target | null>(null);
  const [roving, setRoving] = useState<Target | null>(null);
  const targets = useRef(new Map<string, HTMLElement>());

  const valid = (at: Target | null): at is Target => {
    const row = at ? resolved[at.r] : undefined;
    return !!at && !!row && (at.c === -1 ? !!row.href : at.c >= 0 && at.c < row.columns.length);
  };
  // The tab stop starts on the problem the header names.
  const lead = problems[0];
  const leadAt: Target = lead
    ? { r: resolved.findIndex((row) => row.id === lead.row.id), c: lead.row.columns?.findIndex((column) => column.id === lead.column.id) ?? 0 }
    // With nothing failing, the first row that has a cell; a grid whose rows
    // are all empty still keeps one tab stop.
    : { r: Math.max(0, resolved.findIndex((row) => row.columns.length > 0)), c: 0 };
  const tabStop = valid(roving) ? roving : leadAt;

  const register = (key: string, element: HTMLElement | null) => {
    if (element) targets.current.set(key, element);
    else targets.current.delete(key);
  };
  const onEnter = (at: Target) => setActive(at);
  const onLeave = (at: Target) => setActive((current) => (current && targetKey(current) === targetKey(at) ? null : current));
  const onFocusTarget = (at: Target) => {
    setRoving(at);
    setActive(at.c >= 0 ? at : null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      setActive(null);
      return;
    }
    if (!(event.target instanceof HTMLElement)) return;
    const from = parseTarget(event.target.dataset.healthTarget);
    const next = from ? step(resolved, from, event.key, event.ctrlKey || event.metaKey) : null;
    if (!next) return;
    event.preventDefault();
    targets.current.get(targetKey(next))?.focus();
  };

  const activeBand = active ? bands.find((band) => active.r >= band.first && active.r < band.first + band.rows.length) : undefined;
  const words = healthTallyWords(tally);

  return (
    <div data-health-grid data-calm={calm ? "" : undefined} className={cn("group/grid @container grid gap-4", className)}>
      <div className="grid gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="grid min-w-0 gap-1.5">
            <h2 id={titleId} className={cn("m-0", eyebrowClass)}>
              {title}
            </h2>
            <Headline problems={problems} tally={tally} />
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
        {tally.inPlay > 0 ? (
          <div className="grid gap-2">
            <SegmentBar
              ariaLabel={words}
              className="h-2"
              segments={TALLIED.map((state) => ({ name: state, value: tally[TALLY_FIELD[state]], fill: FILL[state] }))}
            />
            <ul aria-hidden data-health-tally className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs text-muted-foreground">
              {TALLIED.filter((state) => tally[TALLY_FIELD[state]] > 0).map((state) => (
                <li key={state} data-tally={state} className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <span className={cn("size-2.5 rounded-xs", FILL[state], state === "not-connected" && "border border-muted-foreground/50")} />
                  <span className="font-medium tabular-nums text-foreground">{tally[TALLY_FIELD[state]]}</span>
                  {stateWord(state)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {resolved.length === 0 ? (
        <p data-health-empty className="m-0 text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <div
          role="grid"
          aria-labelledby={titleId}
          onKeyDown={onKeyDown}
          style={{ "--health-columns": width } as CSSProperties}
          className="grid grid-cols-[minmax(0,--spacing(56))_repeat(var(--health-columns),--spacing(5))] gap-x-0.5 gap-y-1 @2xl:grid-cols-[minmax(--spacing(32),--spacing(52))_repeat(var(--health-columns),minmax(0,1fr))] @2xl:gap-x-1.5"
        >
          {active && activeBand ? (
            <span
              aria-hidden
              data-health-crosshair
              className="pointer-events-none rounded-lg bg-muted/60"
              style={{ gridColumn: active.c + 2, gridRow: `${activeBand.line} / span ${activeBand.rows.length + 1}` }}
            />
          ) : null}
          {bands.map((band, b) => (
            <Fragment key={band.line}>
              <div
                role="row"
                data-health-header
                className={cn("col-span-full grid grid-cols-subgrid items-end", b > 0 && "mt-2 border-t border-viz-grid pt-3")}
                style={{ gridRow: band.line }}
              >
                <span role="columnheader" className="min-w-0">
                  <span className="sr-only">{band.kind === "system" ? "System" : "Site"}</span>
                </span>
                {band.columns.map((column, c) => {
                  const lit = activeBand === band && active?.c === c;
                  return (
                    <span
                      key={column.id}
                      role="columnheader"
                      title={column.label}
                      data-active={lit ? "" : undefined}
                      className={cn(
                        "hidden px-0.5 pb-1 text-xs font-medium transition-colors @2xl:block",
                        lit ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      <FitLabel aria-hidden className="text-center">{column.short}</FitLabel>
                      <span className="sr-only">{column.label}</span>
                    </span>
                  );
                })}
              </div>
              {band.rows.map((row, i) => {
                const r = band.first + i;
                const lit = active?.r === r;
                const head: Target = { r, c: -1 };
                return (
                  <div
                    key={row.id}
                    role="row"
                    data-health-row={row.id}
                    data-kind={row.kind ?? "site"}
                    data-active={lit ? "" : undefined}
                    className={cn(
                      "viz-arrive col-span-full grid grid-cols-subgrid items-center rounded-lg py-1 transition-colors",
                      lit && "bg-muted/60",
                    )}
                    style={{ gridRow: band.line + 1 + i, "--viz-i": r } as CSSProperties}
                  >
                    <RowHead
                      row={row}
                      problems={problems.filter((problem) => problem.row.id === row.id)}
                      at={head}
                      tabbable={targetKey(tabStop) === targetKey(head)}
                      register={register}
                      onFocusTarget={onFocusTarget}
                    />
                    {row.cells.map((cell, c) => {
                      const at: Target = { r, c };
                      const third = row.columns.length / 3;
                      return (
                        <CellView
                          key={cell.column}
                          row={row}
                          column={row.columns[c]!}
                          cell={cell}
                          nowMs={nowMs}
                          at={at}
                          tabbable={targetKey(tabStop) === targetKey(at)}
                          active={!!active && targetKey(active) === targetKey(at)}
                          align={c < third ? "start" : c >= third * 2 ? "end" : "center"}
                          register={register}
                          onEnter={onEnter}
                          onLeave={onLeave}
                          onFocusTarget={onFocusTarget}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
