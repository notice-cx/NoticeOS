// The Wall's live feed contract: what `GET /api/wall/feed` returns (bead
// `ro-trai.6`, docs/14-design.md § Feed). Shared by the Worker that unions
// the store's events and the Wall column that draws them, so the shape and the
// rules the two halves agree on (window, fold gap, cap) are stated once.
//
// Every line is a stored event. Nothing here is synthesized: a feed with
// nothing in its window says so, it never invents activity to look alive.

/** The closed vocabulary, one entry per kind of line (docs/25 § Feed). */
export const WALL_FEED_KINDS = [
  "task-done",
  "task-filed",
  "alert",
  "resolved",
  "source-failed",
  "source-back",
  "job-failed",
  "collected",
  "revenue",
  "cost",
  "insights",
  "report",
  "deployed",
  "change",
  "setting-saved",
] as const;

export type WallFeedKind = (typeof WALL_FEED_KINDS)[number];

/** Token names only (doc 14): recorded success is `healthy`, a failure
 * `error`, an alert its own severity, money its series identity, the rest
 * neutral ink. The glyph carries the kind, so colour is never alone. */
export type WallFeedTone = "healthy" | "error" | "warn" | "info" | "revenue" | "cost" | "neutral";

/** The kind's word, shown in capitals above the line. */
export const WALL_FEED_LABEL: Readonly<Record<WallFeedKind, string>> = {
  "task-done": "Task done",
  "task-filed": "New task",
  alert: "Alert",
  resolved: "Resolved",
  "source-failed": "Source failed",
  "source-back": "Source back",
  "job-failed": "Job failed",
  collected: "Collected",
  revenue: "Revenue",
  cost: "Cost",
  insights: "Insights",
  report: "Nightly report",
  deployed: "Deployed",
  change: "Change",
  "setting-saved": "Setting saved",
};

export interface WallFeedItem {
  /** `<source>:<row id>`, stable across polls, so the column animates only a
   * line it has not drawn before. A folded line carries its newest member's. */
  id: string;
  /** ISO instant of the newest event the line stands for. */
  at: string;
  kind: WallFeedKind;
  /** The kind's word; an annotation's own kind word for a `change`. */
  label: string;
  /** The asset the line is about, or null for a portfolio-wide line. */
  asset: string | null;
  /** That asset's display name — named whenever there is one. */
  site: string | null;
  /** One sentence, at most `WALL_FEED_MAX_WORDS` words. */
  text: string;
  /** How many stored events the line folds; 1 for a single event. */
  count: number;
  tone: WallFeedTone;
}

export interface WallFeedPayload {
  generatedAt: string;
  /** The window's start: 6 PM yesterday in the OS time zone. */
  since: string;
  /** Newest first, at most `limit` lines. */
  items: WallFeedItem[];
  limit: number;
}

/** Lines fetched per poll (docs/25: at most 50). */
export const WALL_FEED_LIMIT = 50;
/** Same-kind events closer than this fold into one line. */
export const WALL_FEED_FOLD_MS = 15 * 60_000;
/** The column's poll. */
export const WALL_FEED_POLL_MS = 30_000;
/** A line older than this drops to muted ink. */
export const WALL_FEED_AGED_MS = 12 * 3_600_000;
/** How long a new line keeps its arrival tint. */
export const WALL_FEED_TINT_MS = 2 * 60_000;
/** At most one arrival this often; a burst queues. */
export const WALL_FEED_ARRIVAL_GAP_MS = 2_000;
/** The slide-in. */
export const WALL_FEED_SLIDE_MS = 240;
/** A line's word budget (the UX gate's label budget). */
export const WALL_FEED_MAX_WORDS = 12;
/** The local hour the window opens at, the evening before. */
export const WALL_FEED_WINDOW_HOUR = 18;
/** The rows the TV's feed column draws — its 952 px body at about 70 px a row
 * (docs/25 § Budget) — and so the most the one-column Wall on a portrait
 * tablet or a phone lists, newest first (bead ro-trai.31): the evening's
 * whole feed there ran the page 5,850 px tall. */
export const WALL_FEED_TV_ROWS = 12;

/** Words in a line, as the budget counts them. */
export function feedWordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

/** `text` cut to the word budget, marked with an ellipsis when cut. */
export function feedSentence(text: string, max = WALL_FEED_MAX_WORDS): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(" ");
  return `${words.slice(0, max).join(" ").replace(/[,.;:—–-]+$/, "")}…`;
}

/** Offset of `timeZone` from UTC at `atMs`, in milliseconds. */
function zoneOffsetMs(timeZone: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(atMs));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return local - Math.floor(atMs / 1000) * 1000;
}

/**
 * The feed's window start: 6 PM on the day before `now`'s calendar date in
 * `timeZone` (the saved `os_time_zone`), as an ISO instant. A zone name the
 * runtime cannot resolve falls back to UTC rather than to no window.
 */
export function feedWindowStart(now: Date, timeZone: string): string {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(now);
  } catch {
    zone = "UTC";
  }
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d - 1, WALL_FEED_WINDOW_HOUR, 0, 0);
  const first = wall - zoneOffsetMs(zone, wall);
  // Across a DST change the offset at the guess and at the answer differ;
  // the second reading is the one in force at 6 PM.
  const second = wall - zoneOffsetMs(zone, first);
  return new Date(second).toISOString();
}
