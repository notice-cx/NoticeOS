import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { CircleHelp, Lock } from "lucide-react";
import { Link } from "react-router-dom";
import { formatInt, formatSeriesDate } from "@/lib/format";
import { cn } from "@/lib/utils";

// Every project on one time axis around today: what finished (dots at each
// close), what is moving (a green run from its start to today), what waits on
// the operator (a warn run from the day it was asked), what is held (hollow
// circles just past today) and what is set ahead (a parked task's wake-up, a
// kill date), with a dashed track from today to the last of them. Marks are
// placed in shares of the axis, so the drawing follows its box; the measured
// width only decides where a label goes so that no two labels overlap.

const DAY_MS = 86_400_000;
/** The axis width assumed before (or without) a measurement: the box's minimum less the label column. */
const FALLBACK_TRACK_PX = 720;
/** Labels are estimated, never measured: an average glyph at text-micro. */
const CHAR_PX = 6.2;
/** Two labels on one side closer than this are a collision. */
const LABEL_GAP_PX = 12;
/** How far past today the held tasks' circles sit, and the step between them. */
const BLOCKED_OFFSET_PX = 12;
const BLOCKED_STEP_PX = 12;
const BLOCKED_DRAWN = 3;

export type JourneyTone = "warn" | "urgent" | "healthy" | "muted" | "foreground";

const TONE: Record<JourneyTone, string> = {
  warn: "text-warn",
  urgent: "text-urgent",
  healthy: "text-healthy",
  muted: "text-muted-foreground",
  foreground: "text-foreground",
};

export interface JourneyRow {
  id: string;
  title: string;
  href?: string;
  /** The site's mark, drawn before the title. */
  mark?: ReactNode;
  /** The site's name, for the row's spoken summary. */
  site?: string;
  /** Where the project stands, in its colour, under the title. */
  state: { label: string; tone: JourneyTone };
  /** When each finished task closed. */
  done: readonly string[];
  /** Each task in progress and when it started. */
  inProgress: readonly { title: string; from: string }[];
  /** The task waiting on the operator, from the day it was asked. */
  waiting: { title: string; from: string; verb: "approve" | "answer" | "choose" } | null;
  blocked: number;
  /** Parked tasks and the day each asks to be looked at again. */
  parked: readonly { title: string; until: string }[];
  killDate: string | null;
}

export interface ProjectJourneysProps {
  rows: readonly JourneyRow[];
  nowMs: number;
  /** The Monday this week started on, on the installation's clock; else the UTC week. */
  weekStart?: string | null;
  /** Today's date on the installation's clock; else the UTC date. */
  today?: string | null;
  /** Weeks drawn on each side of today. */
  weeks?: number;
  ariaLabel?: string;
  className?: string;
}

export interface JourneyScale {
  fromMs: number;
  toMs: number;
  /** Where an instant falls, as a share of the axis (0–100), or null outside it. */
  x: (ms: number) => number | null;
  ticks: { day: string; x: number }[];
  nowX: number;
}

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  return Number.isFinite(parsed) ? parsed : null;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The UTC Monday of an instant's week. */
function utcMonday(ms: number): string {
  const date = new Date(ms);
  const back = (date.getUTCDay() + 6) % 7;
  return utcDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - back));
}

/** The axis: `weeks` either side of now, a tick on every Monday it holds. */
export function journeyScale(nowMs: number, weekStart: string | null | undefined, weeks = 4): JourneyScale {
  const span = weeks * 7 * DAY_MS;
  const fromMs = nowMs - span;
  const toMs = nowMs + span;
  const x = (ms: number) => (ms < fromMs || ms > toMs ? null : ((ms - fromMs) / (toMs - fromMs)) * 100);
  const monday = Date.parse(`${weekStart && /^\d{4}-\d{2}-\d{2}$/.test(weekStart) ? weekStart : utcMonday(nowMs)}T00:00:00Z`);
  const ticks: { day: string; x: number }[] = [];
  for (let k = -weeks - 1; k <= weeks + 1; k += 1) {
    const at = monday + k * 7 * DAY_MS;
    const share = x(at);
    if (share !== null) ticks.push({ day: utcDay(at), x: share });
  }
  return { fromMs, toMs, x, ticks, nowX: 50 };
}

export interface JourneyLabel {
  key: string;
  text: string;
  /** Where the label's mark sits, in px along the axis. */
  px: number;
  /** Drawn under the track, over it, or left out because both sides are taken. */
  side: "below" | "above" | null;
  /** Right-aligned at its mark when it would run past the axis's end. */
  align: "start" | "end";
}

/**
 * Each label beside its mark, under the track unless the label before it on
 * that side is in the way, then over it; a label with both sides taken is left
 * out (its words stay in the row's spoken summary and the mark's title).
 */
export function placeJourneyLabels(labels: readonly { key: string; text: string; px: number }[], trackPx: number): JourneyLabel[] {
  const ends: Record<"below" | "above", number> = { below: Number.NEGATIVE_INFINITY, above: Number.NEGATIVE_INFINITY };
  return [...labels].sort((a, b) => a.px - b.px).map((label) => {
    const width = label.text.length * CHAR_PX;
    const align: JourneyLabel["align"] = label.px + width > trackPx ? "end" : "start";
    const start = align === "start" ? label.px : label.px - width;
    const end = start + width;
    const side = start >= ends.below + LABEL_GAP_PX ? "below" : start >= ends.above + LABEL_GAP_PX ? "above" : null;
    if (side) ends[side] = end;
    return { ...label, side, align };
  });
}

function days(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / DAY_MS));
}

interface PlacedRow {
  done: number[];
  inProgress: { from: number; title: string }[];
  waiting: { from: number; clipped: boolean; title: string; verb: "approve" | "answer" | "choose"; days: number } | null;
  blocked: number;
  parked: { x: number; until: string; title: string }[];
  kill: { x: number; date: string } | null;
  /** Where the dashed track from today ends. */
  futureX: number | null;
  /** Where the solid track up to today starts. */
  pastX: number | null;
  labels: JourneyLabel[];
}

/** One row's marks on the axis and its labels placed. */
export function layoutJourney(row: JourneyRow, scale: JourneyScale, nowMs: number, trackPx: number): PlacedRow {
  const at = (value: string | null | undefined) => {
    const ms = parseMs(value);
    return ms === null ? null : scale.x(ms);
  };
  /** A future date beyond the axis sits at its end, its label saying the day. */
  const ahead = (value: string) => {
    const ms = parseMs(value);
    if (ms === null) return null;
    return ms > scale.toMs ? 100 : Math.max(scale.nowX, scale.x(ms) ?? scale.nowX);
  };
  const done = row.done.flatMap((iso) => {
    const x = at(iso);
    return x === null ? [] : [x];
  });
  const inProgress = row.inProgress.flatMap((task) => {
    const ms = parseMs(task.from);
    if (ms === null) return [];
    return [{ from: Math.max(0, scale.x(Math.min(ms, nowMs)) ?? 0), title: task.title }];
  });
  const askedMs = parseMs(row.waiting?.from);
  const waiting = row.waiting && askedMs !== null
    ? { from: Math.max(0, scale.x(Math.min(askedMs, nowMs)) ?? 0), clipped: askedMs < scale.fromMs, title: row.waiting.title, verb: row.waiting.verb, days: days(askedMs, nowMs) }
    : null;
  const parked = row.parked.flatMap((task) => {
    const x = ahead(task.until);
    return x === null ? [] : [{ x, until: task.until.slice(0, 10), title: task.title }];
  });
  const killX = row.killDate ? ahead(row.killDate) : null;
  const kill = row.killDate && killX !== null ? { x: killX, date: row.killDate.slice(0, 10) } : null;
  const toPx = (share: number) => (share / 100) * trackPx;
  const blockedEnd = row.blocked > 0 ? toPx(scale.nowX) + BLOCKED_OFFSET_PX + (Math.min(row.blocked, BLOCKED_DRAWN) - 1) * BLOCKED_STEP_PX : null;
  const future = [...parked.map((p) => p.x), ...(kill ? [kill.x] : [])];
  const futureX = future.length > 0 ? Math.max(...future) : blockedEnd !== null ? (blockedEnd / trackPx) * 100 : null;
  const past = [...done, ...inProgress.map((task) => task.from), ...(waiting ? [waiting.from] : [])];
  const pastX = past.length > 0 ? Math.min(...past, scale.nowX) : null;

  const labels = [
    ...(waiting ? [{ key: "waiting", text: `${waiting.title} · waiting ${formatInt(waiting.days)}d`, px: toPx(waiting.from) }] : []),
    ...(row.blocked > 0 ? [{ key: "blocked", text: `${formatInt(row.blocked)} blocked`, px: toPx(scale.nowX) + BLOCKED_OFFSET_PX }] : []),
    ...parked.map((task, index) => ({ key: `parked-${index}`, text: `parked until ${formatSeriesDate(task.until)}`, px: toPx(task.x) })),
    ...(kill ? [{ key: "kill", text: `Kill date ${formatSeriesDate(kill.date)}`, px: toPx(kill.x) }] : []),
  ];
  return { done, inProgress, waiting, blocked: row.blocked, parked, kill, futureX, pastX, labels: placeJourneyLabels(labels, trackPx) };
}

/** The row in words, for a reader who cannot see the marks. */
function rowSummary(row: JourneyRow, placed: PlacedRow): string {
  const parts = [
    `${row.title}${row.site ? `, ${row.site}` : ""}: ${row.state.label}`,
    placed.done.length > 0 ? `${formatInt(placed.done.length)} done in these weeks` : null,
    placed.inProgress.length > 0 ? `${formatInt(placed.inProgress.length)} in progress` : null,
    placed.waiting ? `${placed.waiting.title} waiting on you ${formatInt(placed.waiting.days)} days` : null,
    row.blocked > 0 ? `${formatInt(row.blocked)} blocked` : null,
    ...placed.parked.map((task) => `${task.title} parked until ${formatSeriesDate(task.until)}`),
    placed.kill ? `kill date ${formatSeriesDate(placed.kill.date)}` : null,
  ];
  return parts.filter(Boolean).join(". ");
}

/** The axis's width, measured from the box once it has one. */
function useTrackWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(FALLBACK_TRACK_PX);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const measured = entry?.contentRect.width ?? 0;
      if (measured > 0) setWidth(measured);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** A share of the axis as a `left`, inside the box that holds the label column. */
function acrossBox(share: number, px = 0): string {
  return `calc(var(--journey-label) + (100% - var(--journey-label)) * ${share / 100}${px ? ` + ${px}px` : ""})`;
}

const LABEL_COLUMN = "[--journey-label:160px] sm:[--journey-label:260px]";

/**
 * Every project on one time axis, weeks back and ahead of today, today ruled
 * through every row and the weeks ahead tinted. Inside its own box that
 * scrolls sideways on a narrow screen; a legend under it names each mark.
 */
export function ProjectJourneys({ rows, nowMs, weekStart = null, today = null, weeks = 4, ariaLabel = "Projects over time", className }: ProjectJourneysProps) {
  const scale = journeyScale(nowMs, weekStart, weeks);
  const [trackRef, trackPx] = useTrackWidth();
  const todayDay = today && /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : utcDay(nowMs);
  // A tick's label runs right from its line; one that would reach today's
  // label, which is centred on today, gives way to it.
  const todayText = `Today · ${formatSeriesDate(todayDay)}`;
  const todayHalfPx = (todayText.length * 7) / 2 + LABEL_GAP_PX / 2;
  const tickShown = (tick: { day: string; x: number }) => {
    const offset = ((tick.x - scale.nowX) / 100) * trackPx;
    const width = formatSeriesDate(tick.day).length * CHAR_PX + 4;
    return offset >= 0 ? offset >= todayHalfPx : -offset >= todayHalfPx + width;
  };
  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)} data-project-journeys={rows.length}>
      <div className="overflow-x-auto rounded-xl ring-1 ring-border/70" data-journeys-scroll="">
        <section aria-label={ariaLabel} className={cn("relative min-w-[980px] bg-card", LABEL_COLUMN)}>
          {/* The weeks ahead, a few percent lighter. */}
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 bg-muted/40" style={{ left: acrossBox(scale.nowX) }} data-journeys-future="" />
          {scale.ticks.map((tick) => (
            <span key={tick.day} aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-viz-grid" style={{ left: acrossBox(tick.x) }} data-journeys-week={tick.day} />
          ))}
          <span aria-hidden className="pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 rounded-full bg-foreground" style={{ left: acrossBox(scale.nowX) }} data-journeys-today="" />

          <div className="relative grid grid-cols-[var(--journey-label)_minmax(0,1fr)]">
            <div aria-hidden className="h-9" />
            <div ref={trackRef} aria-hidden className="relative h-9 text-micro tabular-nums text-muted-foreground">
              {scale.ticks.map((tick) => !tickShown(tick) ? null : (
                <span key={tick.day} className="absolute top-2.5 whitespace-nowrap ps-1" style={{ left: `${tick.x}%` }} data-journeys-tick={tick.day}>
                  {formatSeriesDate(tick.day)}
                </span>
              ))}
              <span className="absolute top-2 z-20 -translate-x-1/2 whitespace-nowrap rounded-sm bg-card px-1.5 text-xs font-semibold text-foreground" style={{ left: `${scale.nowX}%` }} data-journeys-today-label="">
                {todayText}
              </span>
            </div>

            {rows.map((row) => (
              <JourneyLine key={row.id} row={row} placed={layoutJourney(row, scale, nowMs, trackPx)} nowX={scale.nowX} trackPx={trackPx} />
            ))}
          </div>
        </section>
      </div>
      <JourneyLegend />
    </div>
  );
}

function JourneyLine({ row, placed, nowX, trackPx }: { row: JourneyRow; placed: PlacedRow; nowX: number; trackPx: number }) {
  const Glyph = placed.waiting?.verb === "approve" ? Lock : CircleHelp;
  const pos = (share: number, px = 0): CSSProperties => ({ left: px ? `calc(${share}% + ${px}px)` : `${share}%` });
  return (
    <>
      <div className="flex min-w-0 flex-col justify-center gap-0.5 border-t border-border py-2 pe-3 ps-3" data-journey-row={row.id}>
        <span className="flex min-w-0 items-start gap-1.5 text-sm font-medium text-foreground">
          {row.mark ? <span className="mt-0.5 shrink-0">{row.mark}</span> : null}
          {row.href ? (
            <Link to={row.href} className="min-w-0 [overflow-wrap:anywhere] underline-offset-4 hover:underline">{row.title}</Link>
          ) : <span className="min-w-0 [overflow-wrap:anywhere]">{row.title}</span>}
        </span>
        <span className={cn("text-xs", TONE[row.state.tone])} data-journey-state="">{row.state.label}</span>
        <span className="sr-only">{rowSummary(row, placed)}</span>
      </div>
      <div aria-hidden className="relative h-[76px] border-t border-border" data-journey-track={row.id}>
        {placed.pastX !== null && placed.pastX < nowX ? (
          <span className="absolute top-1/2 h-px -translate-y-1/2 bg-border" style={{ left: `${placed.pastX}%`, width: `${nowX - placed.pastX}%` }} />
        ) : null}
        {placed.futureX !== null && placed.futureX > nowX ? (
          <span className="absolute top-1/2 -translate-y-1/2 border-t border-dashed border-muted-foreground/60" style={{ left: `${nowX}%`, width: `${placed.futureX - nowX}%` }} data-journey-planned="" />
        ) : null}
        {placed.done.map((x, index) => (
          <span key={`done-${index}`} className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/80" style={pos(x)} data-journey-mark="done" />
        ))}
        {placed.inProgress.map((task, index) => (
          <span key={`moving-${index}`}>
            <span className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-healthy/70" style={{ left: `${task.from}%`, width: `${Math.max(0, nowX - task.from)}%` }} data-journey-mark="in-progress" title={task.title} />
            <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-healthy" style={pos(task.from)} />
          </span>
        ))}
        {placed.waiting ? (
          <>
            <span className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-warn/60" style={{ left: `${placed.waiting.from}%`, width: `${Math.max(0, nowX - placed.waiting.from)}%` }} data-journey-mark="waiting" title={placed.waiting.title} />
            <span className="absolute top-1/2 grid size-4 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-card text-warn" style={pos(placed.waiting.from)} data-journey-asked={placed.waiting.verb}>
              <Glyph className="size-3.5" />
            </span>
          </>
        ) : null}
        {Array.from({ length: Math.min(placed.blocked, BLOCKED_DRAWN) }, (_, index) => (
          <span key={`blocked-${index}`} className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-warn bg-card" style={pos(nowX, BLOCKED_OFFSET_PX + index * BLOCKED_STEP_PX)} data-journey-mark="blocked" />
        ))}
        {placed.parked.map((task, index) => (
          <span key={`parked-${index}`} className="viz-hatch absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-viz-track text-muted-foreground ring-1 ring-muted-foreground/50" style={pos(task.x)} data-journey-mark="parked" title={task.title} />
        ))}
        {placed.kill ? (
          <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-muted-foreground bg-card" style={pos(placed.kill.x)} data-journey-mark="kill" />
        ) : null}
        {placed.labels.map((label) => label.side === null ? null : (
          <span
            key={label.key}
            className={cn(
              "absolute whitespace-nowrap text-micro leading-4 tabular-nums",
              label.key === "waiting" || label.key === "blocked" ? "text-warn" : "text-muted-foreground",
              label.side === "below" ? "top-[calc(50%+9px)]" : "bottom-[calc(50%+9px)]",
              label.align === "end" && "-translate-x-full",
            )}
            style={{ left: `${(label.px / trackPx) * 100}%` }}
            data-journey-label={label.key}
            data-side={label.side}
          >
            {label.text}
          </span>
        ))}
      </div>
    </>
  );
}

/** What each mark is, once, under the box. */
function JourneyLegend() {
  const item = "inline-flex items-center gap-1.5";
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0 text-xs text-muted-foreground" data-journeys-legend="">
      <li className={item}><span aria-hidden className="size-1.5 rounded-full bg-foreground/80" />Done</li>
      <li className={item}><span aria-hidden className="relative flex h-2.5 w-5 items-center"><span className="h-1.5 w-full rounded-full bg-healthy/70" /><span className="absolute left-0 size-2.5 rounded-full bg-healthy" /></span>In progress</li>
      <li className={item}><span aria-hidden className="h-2 w-5 rounded-full bg-warn/60" />Waiting on you, from the day it was asked</li>
      <li className={item}><span aria-hidden className="size-2.5 rounded-full border-2 border-warn" />Blocked</li>
      <li className={item}><span aria-hidden className="w-5 border-t border-dashed border-muted-foreground/60" />Planned</li>
      <li className={item}><span aria-hidden className="viz-hatch size-3 rounded-full bg-viz-track text-muted-foreground ring-1 ring-muted-foreground/50" />Parked</li>
    </ul>
  );
}
