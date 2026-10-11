import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { clsx } from "clsx";
import { Banknote, ChevronsLeft, CircleAlert, CircleCheck, Trophy, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { formatAge } from "@shared/freshness";
import { SEVERITY_SHAPE } from "@/components/SeverityDot";
import { cn } from "@/lib/utils";

// What happened when, on one time axis that ends at now. One row per site
// (and the System); an open problem is a bar from its onset to the NOW line,
// so a failure from 37 minutes ago is a stub at the right edge and one from 67
// days ago a long quiet bar clipped at the left with its age written on it.
// Point events are glyphs on their row; marks closer than a glyph's width share
// a count bubble. "Since you last looked" is a dashed rule, not a sentence.
//
// Everything is placed in shares of the window (percent), so the drawing
// follows its own box; the measured width only decides what fits: whether a
// label sits inside its bar, which marks group, how many ticks the axis takes.
//
// Classes are joined with `clsx`, not `cn`: tailwind-merge takes `text-micro`
// for a colour and would drop it beside one.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The width the layout assumes before (or without) a measurement. */
const FALLBACK_WIDTH = 560;
/** Text widths are estimated, never measured: an average glyph at text-xs. */
const CHAR_PX = 6.4;
/** A span shorter than this on screen is drawn this wide; its age says the truth. */
const MIN_BAR_PX = 6;
/** Marks whose centres are closer than this share one bubble. */
const CLUSTER_PX = 20;
const ROW_GAP_PX = 8;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type TimelineSeverity = "error" | "warn";
export type TimelineEventKind = "problem" | "resolved" | "shipped" | "win" | "money" | "people" | "note";

export interface TimelineLane {
  id: string;
  label: string;
  icon?: ReactNode;
  href?: string;
}

export interface TimelineSpan {
  id: string;
  lane: string;
  /** Onset; null when nobody can tell, drawn from the left edge and said as "since an unknown time". */
  from: string | null;
  /** When it closed; null while it is still open. */
  to: string | null;
  severity: TimelineSeverity;
  label: string;
  href?: string;
}

export interface TimelineEvent {
  id: string;
  lane: string;
  at: string;
  kind: TimelineEventKind;
  /** A problem's severity; ignored on other kinds. */
  severity?: TimelineSeverity;
  label: string;
  href?: string;
}

export interface EventTimelineProps {
  lanes: readonly TimelineLane[];
  spans?: readonly TimelineSpan[];
  events?: readonly TimelineEvent[];
  window: { from: string; to: string };
  nowMs: number;
  /** A dashed rule with its label, e.g. "Since you last looked · 6 PM yesterday". */
  marker?: { at: string; label: string };
  /** One row, no name column: every item on a single track (a site page's header). */
  compact?: boolean;
  /** The clock the axis is read on (the saved OS time zone); the runtime's own when absent. */
  timeZone?: string;
  ariaLabel: string;
  className?: string;
}

// ── Clock ────────────────────────────────────────────────────────────────

interface ClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

const clocks = new Map<string, Intl.DateTimeFormat>();

function clockFormat(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let format = clocks.get(key);
  if (!format) {
    const options: Intl.DateTimeFormatOptions = {
      hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
    };
    try {
      format = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
    } catch {
      // A zone this runtime cannot resolve reads on the runtime's own clock rather than on none.
      format = new Intl.DateTimeFormat("en-US", options);
    }
    clocks.set(key, format);
  }
  return format;
}

function clockParts(ms: number, timeZone: string | undefined): ClockParts {
  const parts = clockFormat(timeZone).formatToParts(new Date(ms));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
    hour: Number(value("hour")) % 24,
    minute: Number(value("minute")),
    weekday: value("weekday"),
  };
}

/** Days since 1970-01-01 of a calendar date, so two dates compare by subtraction. */
function serialDay(parts: ClockParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / DAY;
}

function zoneOffsetMs(ms: number, timeZone: string | undefined): number {
  const p = clockParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / MINUTE) * MINUTE;
}

/** Midnight of a calendar date on `timeZone`'s clock. Across a DST change the
 * offset at the guess and at the answer differ; the second reading holds. */
function zonedMidnight(year: number, month: number, day: number, timeZone: string | undefined): number {
  const wall = Date.UTC(year, month - 1, day);
  return wall - zoneOffsetMs(wall - zoneOffsetMs(wall, timeZone), timeZone);
}

function hourName(hour: number): string {
  if (hour === 0) return "Midnight";
  if (hour === 12) return "Noon";
  return `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
}

function clockName(p: ClockParts): string {
  if (p.minute === 0) return hourName(p.hour);
  return `${p.hour % 12 || 12}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "AM" : "PM"}`;
}

/** "2:23 PM today", "9 PM yesterday", "Mon 9 PM", "Aug 5": as near as the reader needs. */
function whenName(ms: number, nowMs: number, timeZone: string | undefined): string {
  const p = clockParts(ms, timeZone);
  const now = clockParts(nowMs, timeZone);
  const days = serialDay(now) - serialDay(p);
  if (days === 0) return `${clockName(p)} today`;
  if (days === 1) return `${clockName(p)} yesterday`;
  if (days > 1 && days < 7) return `${p.weekday} ${clockName(p)}`;
  return `${MONTHS[p.month - 1]} ${p.day}${p.year === now.year ? "" : `, ${p.year}`}`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** The age said in full, for a screen reader: "37 minutes", "6 hours", "67 days". */
function spokenAge(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / MINUTE);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  return plural(Math.floor(hours / 24), "day");
}

function agoPhrase(ms: number): string {
  if (ms < 0) return `in ${spokenAge(ms)}`;
  return ms < MINUTE ? "just now" : `${spokenAge(ms)} ago`;
}

function capitalised(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

// ── Scale ────────────────────────────────────────────────────────────────

export type TimelineUnit = "hour" | "day";

export interface TimelineTick {
  ms: number;
  /** Share of the window, 0 at its start and 1 at its end. */
  x: number;
  label: string;
  /** A day's (or a month's) first tick, ruled a little stronger. */
  major: boolean;
}

export interface TimelineScale {
  fromMs: number;
  toMs: number;
  unit: TimelineUnit;
  /** Hours (unit hour) or days (unit day) between ticks; 28 means the first of each month. */
  step: number;
  /** Where an instant falls as a share of the window; not clamped. */
  x: (ms: number) => number;
  ticks: TimelineTick[];
}

export interface TimelineScaleInput {
  from: string | number;
  to: string | number;
  timeZone?: string;
  /** The plot's width in pixels: it decides how many ticks fit. */
  width?: number;
}

const HOUR_STEPS = [1, 2, 3, 6, 12, 24] as const;
const DAY_STEPS = [1, 2, 7, 14] as const;
/** The room a tick label needs: an hour's name ("Midnight") is wider than a day's ("Sat 10"). */
const TICK_PX: Record<TimelineUnit, number> = { hour: 96, day: 64 };

function instant(value: string | number): number {
  return typeof value === "number" ? value : Date.parse(value);
}

/**
 * The time → x mapping and the axis's ticks. Up to 48 hours the ticks are
 * clock hours on `timeZone` ("6 PM", "Midnight", "6 AM", "Noon"), every 1, 2,
 * 3, 6 or 12 hours, the finest that fits; longer windows tick at local
 * midnights, every day, every other day, on Mondays, every other Monday, or on
 * the first of the month.
 */
export function timelineScale({ from, to, timeZone, width = FALLBACK_WIDTH }: TimelineScaleInput): TimelineScale {
  const fromMs = instant(from);
  const toMs = instant(to);
  const span = Math.max(MINUTE, toMs - fromMs);
  const x = (ms: number) => (ms - fromMs) / span;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return { fromMs, toMs, unit: "hour", step: 1, x, ticks: [] };
  const unit: TimelineUnit = span <= 48 * HOUR ? "hour" : "day";
  const fits = Math.max(2, Math.floor((width > 0 ? width : FALLBACK_WIDTH) / TICK_PX[unit]));
  const ticks: TimelineTick[] = [];

  if (unit === "hour") {
    const step = HOUR_STEPS.find((hours) => span / (hours * HOUR) <= fits) ?? 24;
    // Quarter hours, so a half- or three-quarter-hour zone still lands on its own :00.
    const quarter = 15 * MINUTE;
    for (let ms = Math.ceil(fromMs / quarter) * quarter; ms <= toMs; ms += quarter) {
      const p = clockParts(ms, timeZone);
      if (p.minute !== 0 || p.hour % step !== 0) continue;
      ticks.push({ ms, x: x(ms), label: hourName(p.hour), major: p.hour === 0 });
    }
    return { fromMs, toMs, unit, step, x, ticks };
  }

  const days = span / DAY;
  const step = DAY_STEPS.find((every) => days / every <= fits) ?? 28;
  const months = Math.max(1, Math.ceil(days / 30 / fits));
  const start = clockParts(fromMs, timeZone);
  for (let offset = 0; offset <= Math.ceil(days) + 1; offset += 1) {
    const ms = zonedMidnight(start.year, start.month, start.day + offset, timeZone);
    if (ms < fromMs) continue;
    if (ms > toMs) break;
    const p = clockParts(ms, timeZone);
    const serial = serialDay(p);
    // 1970-01-01 was a Thursday: (serial + 3) % 7 is 0 on a Monday.
    const keep = step === 28
      ? p.day === 1 && (p.month - 1) % months === 0
      : step >= 7
        ? (serial + 3) % 7 === 0 && Math.floor((serial + 3) / 7) % (step / 7) === 0
        : serial % step === 0;
    if (!keep) continue;
    const label = step <= 2 ? `${p.weekday} ${p.day}` : step === 28 ? MONTHS[p.month - 1]! : `${MONTHS[p.month - 1]} ${p.day}`;
    ticks.push({ ms, x: x(ms), label, major: p.day === 1 });
  }
  return { fromMs, toMs, unit, step, x, ticks };
}

// ── Layout ───────────────────────────────────────────────────────────────

export type TimelineSpanState = "open" | "long-standing" | "unknown-start" | "closed";
export type TimelineLaneState = "error" | "warn" | "quiet";
type Placement = "inside" | "before" | "hidden";

export interface PlacedSpan {
  span: TimelineSpan;
  x1: number;
  x2: number;
  state: TimelineSpanState;
  /** What the bar says about its age: "37m", "since 67d", "start unknown"; empty once closed. */
  age: string;
  /** The mark's accessible name. */
  name: string;
  /** The tooltip's second line. */
  detail: string;
  labelAt: Placement;
  ageAt: Placement;
  /** The sub-row inside its lane: overlapping spans stack. */
  row: number;
  /** The newest open error on the timeline: the one thing it leads with. */
  lead: boolean;
}

export interface PlacedEvent {
  event: TimelineEvent;
  x: number;
  name: string;
  detail: string;
}

export interface TimelineMarkGroup {
  key: string;
  x: number;
  events: PlacedEvent[];
  /** A bubble's accessible name; the event's own name when it stands alone. */
  name: string;
}

export interface PlacedLane {
  lane: TimelineLane;
  state: TimelineLaneState;
  spanRows: number;
  spans: PlacedSpan[];
  groups: TimelineMarkGroup[];
}

export interface EventTimelineLayout {
  scale: TimelineScale;
  nowX: number;
  markerX: number | null;
  lanes: PlacedLane[];
}

const SEVERITY_WORD: Record<TimelineSeverity, string> = { error: "Error", warn: "Warning" };
const KIND_WORD: Record<TimelineEventKind, string> = {
  problem: "Problem", resolved: "Resolved", shipped: "Shipped", win: "Win", money: "Money", people: "People", note: "Note",
};
const STATE_RANK: Record<TimelineLaneState, number> = { error: 0, warn: 1, quiet: 2 };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const textPx = (text: string) => text.length * CHAR_PX;

/** Open before closed, errors before warnings, the newest onset first: the
 * order the eye should take, and so the order sub-rows are filled in. */
function spanPriority(a: PlacedSpan, b: PlacedSpan): number {
  const closed = Number(a.state === "closed") - Number(b.state === "closed");
  if (closed !== 0) return closed;
  if (a.span.severity !== b.span.severity) return a.span.severity === "error" ? -1 : 1;
  const onset = (p: PlacedSpan) => (p.span.from === null ? Number.NEGATIVE_INFINITY : Date.parse(p.span.from));
  return onset(b) - onset(a);
}

/** Where a bar's label and age go: inside when they fit, else to the bar's
 * left when there is room (a fresh stub at the NOW line), else only on hover. */
function place(p: PlacedSpan, width: number): void {
  const bar = (p.x2 - p.x1) * width;
  const label = textPx(p.span.label) + 24;
  const age = p.age ? textPx(p.age) + 12 : 0;
  if (p.state === "long-standing" || p.state === "unknown-start") {
    p.ageAt = bar >= age + 24 ? "inside" : "hidden";
    p.labelAt = bar >= age + 72 ? "inside" : "hidden";
    return;
  }
  const room = p.x1 * width - ROW_GAP_PX;
  if (bar >= label + age) {
    p.labelAt = "inside";
    p.ageAt = age ? "inside" : "hidden";
  } else if (age && bar >= age + 8) {
    p.ageAt = "inside";
    p.labelAt = room >= label ? "before" : bar >= age + 80 ? "inside" : "hidden";
  } else if (room >= label + age) {
    p.labelAt = "before";
    p.ageAt = age ? "before" : "hidden";
  } else {
    p.labelAt = "hidden";
    p.ageAt = age && room >= age ? "before" : "hidden";
  }
}

/** Overlapping spans take their own sub-row; a label printed before its bar
 * counts as part of what it occupies. Returns the number of sub-rows. */
function packRows(spans: PlacedSpan[], width: number): number {
  const rows: [number, number][][] = [];
  for (const p of spans) {
    const label = p.labelAt === "before" ? textPx(p.span.label) + 24 : 0;
    const age = p.ageAt === "before" ? textPx(p.age) + 12 : 0;
    const left = p.x1 * width - label - age;
    const right = Math.max(p.x2 * width, p.x1 * width + 24);
    let row = rows.findIndex((taken) => taken.every(([a, b]) => right + ROW_GAP_PX <= a || left >= b + ROW_GAP_PX));
    if (row === -1) row = rows.push([]) - 1;
    rows[row]!.push([left, right]);
    p.row = row;
  }
  return rows.length;
}

/** Marks closer than a glyph share one bubble; a run of them stops growing at
 * twice that, so one bubble never swallows an afternoon. */
function groupMarks(marks: PlacedEvent[], width: number, laneLabel: (id: string) => string, nowMs: number, timeZone: string | undefined): TimelineMarkGroup[] {
  const sorted = [...marks].sort((a, b) => a.x - b.x);
  const runs: PlacedEvent[][] = [];
  for (const mark of sorted) {
    const run = runs.at(-1);
    if (run && (mark.x - run.at(-1)!.x) * width < CLUSTER_PX && (mark.x - run[0]!.x) * width < CLUSTER_PX * 2) run.push(mark);
    else runs.push([mark]);
  }
  return runs.map((run) => {
    const first = run[0]!;
    const last = run.at(-1)!;
    const midMs = (Date.parse(first.event.at) + Date.parse(last.event.at)) / 2;
    return {
      key: run.map((mark) => mark.event.id).join(" "),
      x: (first.x + last.x) / 2,
      events: run,
      name: run.length === 1
        ? first.name
        : `${run.length} events on ${laneLabel(first.event.lane)} around ${whenName(midMs, nowMs, timeZone)}`,
    };
  });
}

/**
 * Everything the drawing needs, from plain inputs: which rows show and in what
 * order, where each span and mark falls, what each one is called, and how
 * marks group at `plotWidth`. A row with nothing in the window is left out;
 * rows with an open error come first, then an open warning, then the rest in
 * the order given.
 */
export function layoutEventTimeline(props: EventTimelineProps, plotWidth: number): EventTimelineLayout {
  const { lanes, spans = [], events = [], window: range, nowMs, marker, compact = false, timeZone } = props;
  const width = plotWidth > 0 ? plotWidth : FALLBACK_WIDTH;
  const scale = timelineScale({ from: range.from, to: range.to, timeZone, width });
  const { fromMs, toMs } = scale;
  const nowX = clamp01(scale.x(nowMs));
  const markerMs = marker ? Date.parse(marker.at) : Number.NaN;
  const markerX = markerMs >= fromMs && markerMs <= toMs ? scale.x(markerMs) : null;

  const declared = new Map(lanes.map((lane) => [lane.id, lane]));
  // An item naming a row nobody declared still shows, under its own id.
  const laneFor = (id: string): TimelineLane => declared.get(id) ?? { id, label: id };
  const laneLabel = (id: string) => laneFor(id).label;
  const trackOf = (id: string) => (compact ? "" : id);
  const order: string[] = compact ? [""] : lanes.map((lane) => lane.id);
  const bySpan = new Map<string, PlacedSpan[]>();
  const byMark = new Map<string, PlacedEvent[]>();
  const track = <T,>(map: Map<string, T[]>, id: string) => {
    const key = trackOf(id);
    if (!order.includes(key)) order.push(key);
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    return list;
  };

  for (const span of spans) {
    const startMs = span.from === null ? Number.NaN : Date.parse(span.from);
    const closedMs = span.to === null ? nowMs : Date.parse(span.to);
    if (Number.isNaN(closedMs)) continue;
    const endMs = Math.min(closedMs, nowMs);
    const unknown = Number.isNaN(startMs);
    if (endMs < fromMs || (!unknown && startMs > toMs)) continue;
    const state: TimelineSpanState = span.to !== null ? "closed" : unknown ? "unknown-start" : startMs < fromMs ? "long-standing" : "open";
    const x2 = clamp01(scale.x(endMs));
    const x1 = Math.max(0, Math.min(unknown ? 0 : clamp01(scale.x(startMs)), x2 - MIN_BAR_PX / width));
    const age = state === "open" ? formatAge(nowMs - startMs)
      : state === "long-standing" ? `since ${formatAge(nowMs - startMs)}`
        : state === "unknown-start" ? "start unknown" : "";
    const tail = state === "closed"
      ? `resolved ${agoPhrase(nowMs - endMs)}${unknown ? "" : ` after ${spokenAge(endMs - startMs)}`}`
      : unknown ? "since an unknown time" : `since ${spokenAge(nowMs - startMs)} ago`;
    const detail = state === "closed"
      ? unknown ? `Resolved ${whenName(endMs, nowMs, timeZone)}` : `${capitalised(whenName(startMs, nowMs, timeZone))} to ${whenName(endMs, nowMs, timeZone)}`
      : unknown ? "Started at an unknown time" : `Since ${whenName(startMs, nowMs, timeZone)} · ${formatAge(nowMs - startMs)}`;
    track(bySpan, span.lane).push({
      span, x1, x2, state, age, detail,
      name: `${laneLabel(span.lane)} · ${span.label} · ${tail}`,
      labelAt: "hidden", ageAt: "hidden", row: 0, lead: false,
    });
  }

  for (const event of events) {
    const at = Date.parse(event.at);
    if (Number.isNaN(at) || at < fromMs || at > toMs) continue;
    track(byMark, event.lane).push({
      event,
      x: scale.x(at),
      name: `${laneLabel(event.lane)} · ${event.label} · ${agoPhrase(nowMs - at)}`,
      detail: `${capitalised(whenName(at, nowMs, timeZone))} · ${at > nowMs ? "ahead" : `${formatAge(nowMs - at)} ago`}`,
    });
  }

  const lead = [...bySpan.values()].flat()
    .filter((p) => p.state === "open" && p.span.severity === "error")
    .sort((a, b) => Date.parse(b.span.from ?? "") - Date.parse(a.span.from ?? ""))[0];
  if (lead) lead.lead = true;

  const placed: PlacedLane[] = [];
  for (const key of order) {
    const laneSpans = (bySpan.get(key) ?? []).sort(spanPriority);
    const marks = byMark.get(key) ?? [];
    if (laneSpans.length === 0 && marks.length === 0) continue;
    for (const p of laneSpans) place(p, width);
    const open = laneSpans.filter((p) => p.state !== "closed");
    const state: TimelineLaneState = open.some((p) => p.span.severity === "error") ? "error" : open.length > 0 ? "warn" : "quiet";
    const firstId = laneSpans[0]?.span.lane ?? marks[0]?.event.lane ?? "";
    placed.push({
      lane: compact ? lanes[0] ?? laneFor(firstId) : laneFor(key),
      state,
      spanRows: packRows(laneSpans, width),
      spans: laneSpans,
      groups: groupMarks(marks, width, laneLabel, nowMs, timeZone),
    });
  }
  placed.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);
  return { scale, nowX, markerX, lanes: placed };
}

// ── Drawing ──────────────────────────────────────────────────────────────

const pct = (share: number) => `${(share * 100).toFixed(3)}%`;

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(Math.round(node.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

interface OpenMark {
  key: string;
  pinned: boolean;
}

/** One mark's label is open at a time: on hover, on focus, or pinned by a
 * press until Escape, a press elsewhere or a second press. */
function useOpenMark() {
  const [open, setOpen] = useState<OpenMark | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const mark = event.target instanceof Element ? event.target.closest("[data-mark-key]") : null;
      if (mark?.getAttribute("data-mark-key") !== open.key) setOpen(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);

  const handlers = (key: string) => ({
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;
      clear();
      setOpen((current) => (current?.pinned && current.key !== key ? current : { key, pinned: current?.key === key && current.pinned }));
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      if (event.currentTarget.contains(document.activeElement)) return;
      clear();
      timer.current = setTimeout(() => setOpen((current) => (current?.pinned ? current : null)), 120);
    },
    onFocus: () => {
      clear();
      setOpen((current) => (current?.key === key ? current : { key, pinned: false }));
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      setOpen((current) => (current?.key === key ? null : current));
    },
  });
  const toggle = (key: string) => setOpen((current) => (current?.key === key && current.pinned ? null : { key, pinned: true }));
  return { open, handlers, toggle };
}

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Trigger({ href, name, className, style, describedBy, expanded, controls, onPress, children }: {
  href?: string;
  name: string;
  className: string;
  style?: CSSProperties;
  describedBy?: string;
  expanded?: boolean;
  controls?: string;
  onPress: () => void;
  children: ReactNode;
}) {
  if (href) {
    return (
      <Link to={href} aria-label={name} aria-describedby={describedBy} className={className} style={style}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" aria-label={name} aria-describedby={describedBy} aria-expanded={expanded} aria-controls={controls}
      className={className} style={style} onClick={onPress}>
      {children}
    </button>
  );
}

function Panel({ id, role, label, below, align, children }: {
  id: string;
  role: "tooltip" | "group";
  label?: string;
  below: boolean;
  align: "start" | "centre" | "end";
  children: ReactNode;
}) {
  return (
    <div id={id} role={role} aria-label={label} data-event-timeline-panel
      className={clsx(
        "absolute z-30 grid w-max max-w-64 gap-0.5 rounded-md border border-border bg-card px-3 py-2 text-left text-xs leading-snug text-foreground shadow-raised",
        below ? "top-full mt-1.5" : "bottom-full mb-1.5",
        align === "start" ? "left-0" : align === "end" ? "right-0" : "left-1/2 -translate-x-1/2",
      )}>
      {children}
    </div>
  );
}

function alignFor(x: number): "start" | "centre" | "end" {
  return x > 0.75 ? "end" : x < 0.25 ? "start" : "centre";
}

/** The fill and the ink of a bar, by what it is: a fresh error is the loudest
 * thing on the screen, a warning amber, an old or closed problem quiet. */
function barTone(p: PlacedSpan): { fill: string; ink: string; quiet: boolean } {
  const error = p.span.severity === "error";
  if (p.state === "open") {
    return error
      ? { fill: clsx("bg-error text-error", p.lead && "viz-glow"), ink: "text-error-foreground", quiet: false }
      : { fill: "bg-warn-soft ring-1 ring-inset ring-warn/55", ink: "text-warn", quiet: false };
  }
  if (p.state === "closed") return { fill: error ? "bg-error/25" : "bg-warn/25", ink: "text-muted-foreground", quiet: true };
  return {
    fill: error ? "bg-error-soft ring-1 ring-inset ring-error/35" : "bg-warn-soft ring-1 ring-inset ring-warn/35",
    ink: error ? "text-error" : "text-warn",
    quiet: true,
  };
}

function SpanMark({ p, index, below, open, panelId, bind, onPress }: {
  p: PlacedSpan;
  index: number;
  below: boolean;
  open: boolean;
  panelId: string;
  bind: ReturnType<ReturnType<typeof useOpenMark>["handlers"]>;
  onPress: () => void;
}) {
  const tone = barTone(p);
  const clipped = p.state === "long-standing" || p.state === "unknown-start";
  const Shape = SEVERITY_SHAPE[p.span.severity];
  const rounding = clsx(clipped ? "rounded-l-sm" : "rounded-l-full", p.state === "closed" ? "rounded-r-full" : "rounded-r-sm");
  const before = p.labelAt === "before" || p.ageAt === "before";
  return (
    <div data-span={p.span.id} data-state={p.state} data-severity={p.span.severity} data-mark-key={p.span.id} {...bind}
      className="absolute inset-y-0.5" style={{ left: pct(p.x1), width: pct(p.x2 - p.x1) }}>
      <Trigger href={p.span.href} name={p.name} describedBy={open ? panelId : undefined} onPress={onPress}
        className={clsx("group/span absolute inset-y-0 right-0 flex w-full min-w-6 items-center", rounding, tone.quiet && "opacity-80", FOCUS)}>
        <span aria-hidden className={clsx("viz-grow-x absolute inset-0", rounding, tone.fill)}
          style={{ "--viz-i": index } as CSSProperties} />
        {clipped ? (
          p.state === "unknown-start"
            ? <span aria-hidden className={clsx("viz-hatch absolute inset-y-0 left-0 w-6 rounded-l-sm", tone.ink)} />
            : null
        ) : null}
        <span aria-hidden className={clsx("viz-arrive relative flex h-full min-w-0 flex-1 items-center gap-1 px-2 text-xs font-medium", tone.ink)}
          style={{ "--viz-i": index } as CSSProperties}>
          {clipped && p.ageAt === "inside" ? (
            <>
              {p.state === "long-standing" ? <ChevronsLeft className="size-3.5 shrink-0" strokeWidth={2.5} /> : null}
              <span className="shrink-0 whitespace-nowrap tabular-nums" data-span-age>{p.age}</span>
              {p.labelAt === "inside" ? <span className="shrink-0 opacity-60">·</span> : null}
            </>
          ) : p.labelAt === "inside" ? <Shape className="size-3.5 shrink-0" strokeWidth={2.5} /> : null}
          {p.labelAt === "inside" ? <span className="min-w-0 truncate">{p.span.label}</span> : null}
          <span className="flex-1" />
          {!clipped && p.ageAt === "inside" ? <span className="shrink-0 whitespace-nowrap tabular-nums font-semibold" data-span-age>{p.age}</span> : null}
          {p.state === "closed" && (p.x2 - p.x1) > 0 ? <CircleCheck className="size-3.5 shrink-0 text-healthy" strokeWidth={2.5} /> : null}
        </span>
        {before ? (
          <span aria-hidden data-span-label-before
            className={clsx("viz-arrive absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap text-xs",
              p.state === "open" ? (p.span.severity === "error" ? "font-medium text-error" : "text-warn") : "text-muted-foreground")}
            style={{ "--viz-i": index } as CSSProperties}>
            {p.labelAt === "before" ? p.span.label : null}
            {p.labelAt === "before" && p.ageAt === "before" ? " · " : null}
            {p.ageAt === "before" ? <span className="tabular-nums font-semibold" data-span-age>{p.age}</span> : null}
          </span>
        ) : null}
      </Trigger>
      {open ? (
        <Panel id={panelId} role="tooltip" below={below} align={p.x2 > 0.75 ? "end" : "start"}>
          <span className="font-medium">{p.span.label}</span>
          <span className="tabular-nums text-muted-foreground">{p.detail}</span>
        </Panel>
      ) : null}
    </div>
  );
}

/** A point event's glyph: a shape per kind, so none is told apart by colour alone. */
function Glyph({ kind, severity }: { kind: TimelineEventKind; severity?: TimelineSeverity }) {
  if (kind === "note") return <span aria-hidden className="h-3.5 w-0.5 rounded-full bg-muted-foreground" />;
  const disc = "relative flex size-5 items-center justify-center rounded-full ring-1 ring-inset";
  const icon = "size-3";
  switch (kind) {
    case "problem": {
      if (!severity) return <span aria-hidden className={clsx(disc, "bg-muted text-muted-foreground ring-border")}><CircleAlert className={icon} strokeWidth={2.5} /></span>;
      const Shape = SEVERITY_SHAPE[severity];
      return (
        <span aria-hidden className={clsx(disc, severity === "error" ? "bg-error-soft text-error ring-error/50" : "bg-warn-soft text-warn ring-warn/50")}>
          <Shape className={icon} strokeWidth={2.5} />
        </span>
      );
    }
    case "resolved":
      return <span aria-hidden className={clsx(disc, "bg-healthy-soft text-healthy ring-healthy/45")}><CircleCheck className={icon} strokeWidth={2.5} /></span>;
    case "win":
      return <span aria-hidden className={clsx(disc, "bg-card text-milestone ring-milestone/55")}><Trophy className={icon} strokeWidth={2.5} /></span>;
    case "money":
      return <span aria-hidden className={clsx(disc, "bg-card text-financial-revenue ring-financial-revenue/50")}><Banknote className={icon} strokeWidth={2.5} /></span>;
    case "people":
      return <span aria-hidden className={clsx(disc, "bg-card text-traffic ring-traffic/50")}><Users className={icon} strokeWidth={2.5} /></span>;
    case "shipped":
      return <span aria-hidden className={clsx(disc, "bg-card ring-border")}><span className="size-2 rotate-45 rounded-xs bg-foreground" /></span>;
  }
}

function eventWord(event: TimelineEvent): string {
  return event.kind === "problem" && event.severity ? SEVERITY_WORD[event.severity] : KIND_WORD[event.kind];
}

function MarkGroup({ group, index, below, open, panelId, bind, onPress }: {
  group: TimelineMarkGroup;
  index: number;
  below: boolean;
  open: boolean;
  panelId: string;
  bind: ReturnType<ReturnType<typeof useOpenMark>["handlers"]>;
  onPress: () => void;
}) {
  const single = group.events.length === 1 ? group.events[0]! : null;
  const worst = group.events.some((m) => m.event.kind === "problem" && m.event.severity === "error") ? "error"
    : group.events.some((m) => m.event.kind === "problem" && m.event.severity === "warn") ? "warn" : null;
  return (
    <div data-mark-key={group.key} {...bind}
      data-event={single ? single.event.id : undefined} data-kind={single?.event.kind}
      data-event-cluster={single ? undefined : group.events.length} data-events={single ? undefined : group.key}
      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: pct(group.x) }}>
      <Trigger href={single?.event.href} name={group.name} onPress={onPress}
        describedBy={single && open ? panelId : undefined}
        expanded={single ? undefined : open} controls={single || !open ? undefined : panelId}
        className={clsx("viz-arrive relative flex size-6 items-center justify-center rounded-full", FOCUS)}
        style={{ "--viz-i": index } as CSSProperties}>
        {single ? <Glyph kind={single.event.kind} severity={single.event.severity} /> : (
          <span aria-hidden className={clsx("flex size-6 items-center justify-center rounded-full text-micro font-semibold tabular-nums ring-2 ring-card",
            worst === "error" ? "bg-error text-error-foreground" : worst === "warn" ? "bg-warn text-warn-foreground" : "bg-foreground text-background")}>
            {group.events.length}
          </span>
        )}
      </Trigger>
      {open && single ? (
        <Panel id={panelId} role="tooltip" below={below} align={alignFor(group.x)}>
          <span className="text-micro font-medium uppercase tracking-wide text-muted-foreground">{eventWord(single.event)}</span>
          <span className="font-medium">{single.event.label}</span>
          <span className="tabular-nums text-muted-foreground">{single.detail}</span>
        </Panel>
      ) : null}
      {open && !single ? (
        <Panel id={panelId} role="group" label={group.name} below={below} align={alignFor(group.x)}>
          <span className="text-micro font-medium uppercase tracking-wide text-muted-foreground">{group.events.length} events</span>
          <ul className="grid gap-1.5 pt-1">
            {group.events.map((mark) => (
              <li key={mark.event.id} className="flex items-start gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center"><Glyph kind={mark.event.kind} severity={mark.event.severity} /></span>
                <span className="grid min-w-0">
                  {mark.event.href ? (
                    <Link to={mark.event.href} className={clsx("font-medium underline-offset-4 hover:underline", FOCUS)}>{mark.event.label}</Link>
                  ) : <span className="font-medium">{mark.event.label}</span>}
                  <span className="tabular-nums text-muted-foreground">{mark.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

/** Ticks, the "since you last looked" band and rule, and the NOW line, ruled
 * through a row's own padding so they read as one line from top to bottom.
 * `bare` keeps only the band and NOW, under a sentence no rule may cross. */
function Furniture({ layout, bare = false }: { layout: EventTimelineLayout; bare?: boolean }) {
  const { scale, nowX, markerX } = layout;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 -inset-y-2">
      {markerX !== null && markerX < nowX ? (
        <span className="absolute inset-y-0 bg-muted/40" style={{ left: pct(markerX), width: pct(nowX - markerX) }} />
      ) : null}
      {bare ? null : scale.ticks.map((tick) => (
        <span key={tick.ms} className={clsx("absolute inset-y-0 w-px", tick.major ? "bg-muted-foreground/25" : "bg-viz-grid")}
          style={{ left: pct(tick.x) }} />
      ))}
      {markerX !== null && !bare ? (
        <span className="absolute inset-y-0 border-l border-dashed border-muted-foreground/60" style={{ left: pct(markerX) }} />
      ) : null}
      <span data-now className="absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 rounded-full bg-foreground" style={{ left: pct(nowX) }} />
    </div>
  );
}

function LaneName({ lane, state }: { lane: TimelineLane; state: TimelineLaneState }) {
  const Shape = state === "quiet" ? null : SEVERITY_SHAPE[state];
  const text = (
    <span className={clsx("truncate text-sm", state === "quiet" ? "text-muted-foreground" : "font-medium text-foreground")}>{lane.label}</span>
  );
  return (
    <div data-lane-label title={lane.label}
      className="flex h-7 min-w-0 items-center gap-1.5 @min-[30rem]:w-32 @min-[30rem]:shrink-0">
      {Shape ? <Shape aria-hidden className={clsx("size-3.5 shrink-0", state === "error" ? "text-error" : "text-warn")} strokeWidth={2.5} /> : null}
      {lane.icon ? <span aria-hidden className="flex shrink-0 text-muted-foreground">{lane.icon}</span> : null}
      {lane.href ? (
        <Link to={lane.href} className={clsx("flex min-h-6 min-w-0 items-center rounded-sm hover:underline underline-offset-4", FOCUS)}>{text}</Link>
      ) : text}
    </div>
  );
}

/**
 * Horizontal rows on a shared time axis, NOW at the right. Sizes itself by its
 * own width: below 30rem a row's name sits above its track instead of beside
 * it. The drawing is also given as a visually hidden list, so a screen reader
 * hears every item once, in the order the eye takes them.
 */
export function EventTimeline(props: EventTimelineProps) {
  const { lanes, spans, events, window: range, nowMs, marker, compact = false, timeZone, ariaLabel, className } = props;
  const plot = useRef<HTMLDivElement>(null);
  const width = useWidth(plot);
  const layout = useMemo(
    () => layoutEventTimeline({ lanes, spans, events, window: range, nowMs, marker, compact, timeZone, ariaLabel }, width),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a window or marker is read by value, not identity
    [lanes, spans, events, range.from, range.to, nowMs, marker?.at, compact, timeZone, width],
  );
  const { open, handlers, toggle } = useOpenMark();
  const uid = useId();
  const plotWidth = width > 0 ? width : FALLBACK_WIDTH;
  const offset = compact ? "" : "@min-[30rem]:ml-35";
  const half = Math.ceil(layout.lanes.length / 2);
  let spanIndex = 0;
  let markIndex = 0;
  let panel = 0;

  // A tick label never runs into "Now": half its own width plus the word's.
  const ticks = layout.scale.ticks.filter((tick) => tick.x > layout.nowX || (layout.nowX - tick.x) * plotWidth >= textPx(tick.label) / 2 + 40);

  return (
    <div role="group" aria-label={ariaLabel} data-event-timeline data-compact={compact || undefined} data-unit={layout.scale.unit}
      className={cn("@container w-full", className)}>
      <ul className="sr-only" data-event-timeline-list>
        {marker && layout.markerX !== null ? <li>{marker.label}</li> : null}
        {layout.lanes.length === 0 ? <li>Nothing recorded since {whenName(layout.scale.fromMs, nowMs, timeZone)}</li> : null}
        {layout.lanes.flatMap(({ spans: placed, groups }) => [
          ...placed.map((p) => <li key={`s:${p.span.id}`}>{SEVERITY_WORD[p.span.severity]}: {p.name}</li>),
          ...groups.flatMap((group) => group.events)
            .sort((a, b) => Date.parse(b.event.at) - Date.parse(a.event.at))
            .map((m) => <li key={`e:${m.event.id}`}>{eventWord(m.event)}: {m.name}</li>),
        ])}
      </ul>

      {marker && layout.markerX !== null ? (
        <div aria-hidden data-marker className={clsx("relative h-5", offset)}>
          <span className="absolute inset-y-0 border-l border-dashed border-muted-foreground/60" style={{ left: pct(layout.markerX) }} />
          <span className={clsx("absolute bottom-1 whitespace-nowrap text-micro font-medium text-muted-foreground",
            layout.markerX > 0.55 ? "-translate-x-full pr-1.5" : "pl-1.5")} style={{ left: pct(layout.markerX) }}>
            {marker.label}
          </span>
        </div>
      ) : null}

      <div className="divide-y divide-viz-grid">
        {layout.lanes.length === 0 ? (
          <div data-state="empty" className="relative py-2">
            <div className={clsx("relative", offset)}>
              <Furniture layout={layout} bare />
              <p className="relative flex h-7 items-center text-xs text-muted-foreground">
                Nothing recorded since {whenName(layout.scale.fromMs, nowMs, timeZone)}
              </p>
            </div>
          </div>
        ) : layout.lanes.map((placed, laneIndex) => {
          const below = laneIndex < half;
          const subRows = Array.from({ length: placed.spanRows }, (_, row) => placed.spans.filter((p) => p.row === row));
          return (
            <div key={placed.lane.id} data-lane={placed.lane.id} data-state={placed.state}
              className={clsx("flex flex-col gap-1.5 py-2", !compact && "@min-[30rem]:flex-row @min-[30rem]:gap-3")}>
              {compact ? null : <LaneName lane={placed.lane} state={placed.state} />}
              <div className="relative min-w-0 flex-1">
                <Furniture layout={layout} />
                {subRows.map((row, rowIndex) => (
                  <div key={rowIndex} className="relative h-7">
                    {row.map((p) => {
                      const key = p.span.id;
                      const panelId = `${uid}-p${panel++}`;
                      return (
                        <SpanMark key={key} p={p} index={spanIndex++} below={below} open={open?.key === key}
                          panelId={panelId} bind={handlers(key)} onPress={() => toggle(key)} />
                      );
                    })}
                  </div>
                ))}
                {placed.groups.length > 0 ? (
                  <div className="relative h-7">
                    <span aria-hidden className="absolute left-0 top-1/2 h-px bg-viz-grid" style={{ width: pct(layout.nowX) }} />
                    {placed.groups.map((group) => {
                      const panelId = `${uid}-p${panel++}`;
                      return (
                        <MarkGroup key={group.key} group={group} index={markIndex++} below={below} open={open?.key === group.key}
                          panelId={panelId} bind={handlers(group.key)} onPress={() => toggle(group.key)} />
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <div ref={plot} aria-hidden data-axis className={clsx("relative h-5", offset)}>
        {ticks.map((tick) => {
          const edge = tick.x * plotWidth < 20 ? "start" : (1 - tick.x) * plotWidth < 20 ? "end" : "centre";
          return (
            <span key={tick.ms} data-tick={tick.label}
              className={clsx("absolute top-1 whitespace-nowrap text-micro tabular-nums",
                tick.major ? "font-medium text-foreground" : "text-muted-foreground",
                edge === "centre" ? "-translate-x-1/2" : edge === "end" ? "-translate-x-full" : "")}
              style={{ left: pct(tick.x) }}>
              {tick.label}
            </span>
          );
        })}
        <span data-now-label className={clsx("absolute top-1 whitespace-nowrap text-xs font-semibold text-foreground",
          layout.nowX < 0.1 ? "pl-1.5" : "-translate-x-full pr-1.5")} style={{ left: pct(layout.nowX) }}>
          Now
        </span>
      </div>
    </div>
  );
}
