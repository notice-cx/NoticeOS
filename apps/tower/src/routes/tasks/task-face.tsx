import { Ban, Check, Circle, CircleDot, CircleHelp, Snowflake, type LucideIcon } from "lucide-react";
import { PRIORITY_BANDS } from "@shared/work";
import { STATE_TONE, StateChip, type StateTone, type StatusSubject } from "@/components/StateChip";
import { TASK_STATUSES, isGate } from "@/lib/task-board-read";
import { cn } from "@/lib/utils";

/**
 * HOW A TASK LOOKS, defined once for every surface that draws one: the Tasks
 * board (`TasksBoard`, on `/tasks` and a site's Tasks tab), the task's own page
 * (`TaskRoute`), and the task rows and counts other screens borrow — Home's
 * Waiting on you, a site's Needs you and the Sites table's Tasks cell (bead
 * `ro-ujb9.240`). A shared route module rather than a registry component,
 * because it composes only task facts, never a layout.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Priority — a rank, never a severity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A TASK'S PRIORITY IS NOT A SEVERITY (doc 14, bead `ro-ujb9.200`). Red and
 * amber say something is failing or needs attention; a top-priority task is
 * neither, and painting it red put it beside a project that could not be read
 * as if the two were the same kind of fact. So priority ranks by INK WEIGHT: a
 * filled `!` at the top band, a ringed `!` at high, and the quiet `◦` below —
 * the bulk of any queue is the default band, and a board where every row is
 * normal has nothing shouting on it.
 */
export interface PriorityFace {
  /** The operator's word for the band: top, high, normal, low, lowest. */
  band: (typeof PRIORITY_BANDS)[number];
  glyph: "!" | "◦";
  /** The mark's ink: filled, ringed in foreground, or muted. */
  ink: string;
  /** Top and high are foreground ink; the default band and below recede. */
  emphasis: "strong" | "quiet";
}

export function priorityFace(priority: number): PriorityFace {
  const band = PRIORITY_BANDS[Math.min(Math.max(Math.trunc(priority), 0), 4)] ?? "normal";
  if (priority <= 0) {
    return { band, glyph: "!", ink: "border-foreground bg-foreground text-background", emphasis: "strong" };
  }
  if (priority === 1) return { band, glyph: "!", ink: "text-foreground", emphasis: "strong" };
  return { band, glyph: "◦", ink: "text-muted-foreground", emphasis: "quiet" };
}

/**
 * The ring every task mark is drawn in — doc 14's row glyph (18px, a 1.5px
 * border, the mark inside) on the board, and the same ring at chip scale on the
 * task page's header, so one mark never has two geometries.
 */
export function markRingClass(size: "row" | "chip"): string {
  return cn(
    "grid shrink-0 place-items-center rounded-full border-current font-semibold leading-none",
    size === "row" ? "size-4.5 border-[1.5px] text-[11px]" : "size-3.5 border text-[9px]",
  );
}

/** A task's priority as its mark. */
export function PriorityMark({ priority, size = "row", className }: { priority: number; size?: "row" | "chip"; className?: string }) {
  const face = priorityFace(priority);
  return (
    <span
      aria-hidden
      title={`Priority — ${face.band}`}
      data-priority-mark={face.band}
      className={cn(markRingClass(size), face.ink, className)}
    >
      {face.glyph}
    </span>
  );
}

/**
 * HOW MANY TASKS ARE TOP OR HIGH PRIORITY — "3 urgent" — in the ink those two
 * bands' marks wear: foreground, weighted, never an attention hue. The Sites
 * table draws it beside `PriorityBar`, whose top segments are the same ink, so
 * the count and the bar read as one fact.
 */
export function UrgentCount({ count }: { count: number }) {
  return (
    <span
      className={cn("font-medium", priorityFace(1).ink)}
      title="Top- or high-priority tasks (P0 and P1) across everything not closed."
      data-urgent-count=""
    >
      {count} urgent
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// An ask — a row waiting on the operator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A ROW WAITING ON THE OPERATOR, wherever it is listed: the Tasks board's
 * Waiting on you, Home's, and a site's Needs you (bead `ro-ujb9.240`). Its
 * register comes from what it IS, not from its priority (doc 14): every ask is
 * `warn` at every band, a top one too, and a gate keeps the `△` that says it is
 * holding other work. Priority is the list's ORDER, never the row's colour —
 * Home used to ring a top-priority ask red, beside real failures, while the same
 * row was amber one click later on `/tasks`.
 */
export interface AskFace {
  tone: "warn";
  glyph: "!" | "△";
}

export function askFace(task: Parameters<typeof isGate>[0]): AskFace {
  return { tone: "warn", glyph: isGate(task) ? "△" : "!" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Status — one glyph, one tone, one word, on every surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A TASK'S LIFE, read left to right: an empty circle nobody has taken, a circle
 * with something in it, a barred circle, a parked snowflake, a tick (bead
 * `ro-ujb9.202`). The board's State column, its row mark and the task page's
 * header chip all draw a status from here, so a task reads the same one click
 * apart — they used to be two vocabularies, and a closed task was green on the
 * board and grey on its page.
 *
 * A CLOSED TASK WEARS NO GREEN. Doc 14 keeps the healthy token for evidenced
 * health, and closing records a decision, not a proven outcome
 * (the task-key chain): the outcome is read later, in a watch
 * window carrying the task's id. Only Blocked is an attention tone, because
 * only Blocked is a problem.
 */
const STATUS_LOOK: Readonly<Record<(typeof TASK_STATUSES)[number]["key"], { icon: LucideIcon; tone: StateTone }>> = {
  open: { icon: Circle, tone: "neutral" },
  "in-progress": { icon: CircleDot, tone: "affirmative" },
  blocked: { icon: Ban, tone: "caution" },
  parked: { icon: Snowflake, tone: "na" },
  closed: { icon: Check, tone: "na" },
};

export interface StatusFace {
  /** The board's filter key (`in-progress`), or `unknown`. */
  key: string;
  /** What `bd` stores (`in_progress`). */
  stored: string;
  /** The operator's word. */
  label: string;
  icon: LucideIcon;
  tone: StateTone;
}

/**
 * A stored status as its face. `bd` accepts statuses this build has never heard
 * of, so an unknown one renders as ITSELF behind a question mark rather than
 * being forced into one of the five.
 */
export function statusFace(stored: string): StatusFace {
  const known = TASK_STATUSES.find((status) => status.stored === stored);
  if (!known) return { key: "unknown", stored, label: stored, icon: CircleHelp, tone: "neutral" };
  return { key: known.key, stored: known.stored, label: known.label, ...STATUS_LOOK[known.key] };
}

/** A status as its glyph alone, in the status's ink: the dependency list on a
 * task page, and the lead of the board's State cell. */
export function TaskStatusGlyph({ status, className }: { status: string; className?: string }) {
  const face = statusFace(status);
  const Icon = face.icon;
  return (
    <Icon
      role="img"
      aria-label={`State — ${face.label}`}
      data-task-status-glyph={face.key}
      className={cn("size-3.5 shrink-0", STATE_TONE[face.tone].text, className)}
    />
  );
}

/** A status compact — glyph and word in the status's ink, no pill — for a
 * table cell, where a chip per row would be heavier than the fact (doc 14). */
export function TaskStatusMark({ status }: { status: string }) {
  const face = statusFace(status);
  return (
    <span className="inline-flex items-center gap-1.5">
      <TaskStatusGlyph status={status} />
      <span className={cn("text-xs", STATE_TONE[face.tone].text)} data-task-status={face.key}>
        {face.label}
      </span>
    </span>
  );
}

/** A status as the task page's header chip: the same glyph, tone and word. */
export function TaskStatusChip({ status, subject, className }: { status: string; subject: StatusSubject; className?: string }) {
  const face = statusFace(status);
  const Icon = face.icon;
  return (
    <StateChip
      className={className}
      subject={subject}
      tone={face.tone}
      title={face.key === "unknown" ? `A status this build does not know: ${status}.` : undefined}
      glyph={<Icon className="size-3.5" data-task-status-glyph={face.key} />}
      label={<span data-task-status={face.key}>{face.label}</span>}
    />
  );
}

/** A closed or parked task's row mark: its status glyph in the priority mark's
 * ring, so a finished row reads the same as its State cell. */
export function RestingMark({ status, className }: { status: string; className?: string }) {
  const face = statusFace(status);
  const Icon = face.icon;
  return (
    <span
      aria-hidden
      title={face.label}
      data-task-rest-mark={face.key}
      className={cn(markRingClass("row"), STATE_TONE[face.tone].text, className)}
    >
      <Icon className="size-2.5" strokeWidth={3} />
    </span>
  );
}
