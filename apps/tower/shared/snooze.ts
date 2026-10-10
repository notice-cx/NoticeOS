// The snooze vocabulary: how long an alert may be quiet, shared by the browser
// that offers the choice and the Worker that enforces it.

/** The furthest an alert may be pushed out, in days. Past a quarter the honest
 * action is Resolve or Mark read, not silence with no end in sight. */
export const SNOOZE_MAX_DAYS = 90;

/** One entry on the snooze menu. */
export interface SnoozePreset {
  readonly days: number;
  readonly label: string;
}

/** The three horizons an operator picks without thinking, plus the date picker
 * the menu offers beside them for everything else. */
export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
  { days: 1, label: "1 day" },
  { days: 3, label: "3 days" },
  { days: 7, label: "1 week" },
];

/** Why a requested snooze was refused. The browser branches on these codes;
 * the API returns them verbatim in `{ error }`. */
export type SnoozeRejection =
  | "snooze_until_invalid"
  | "snooze_until_past"
  | "snooze_until_too_far";

export type SnoozeCheck =
  | { ok: true; until: string }
  | { ok: false; reason: SnoozeRejection };

const DAY_MS = 86_400_000;

/** The instant `days` from `fromIso` — how a preset becomes a stored date. */
export function snoozeUntilFromDays(fromIso: string, days: number): string {
  return new Date(new Date(fromIso).getTime() + days * DAY_MS).toISOString();
}

/** A calendar date from `<input type="date">` as the instant the alert
 * returns: the start of that day, so "until the 10th" shows it on the 10th.
 * Null for anything that is not a `YYYY-MM-DD` date. */
export function snoozeUntilFromDate(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** The earliest date the picker may offer: tomorrow. A snooze that ends today
 * is not a snooze, and the Worker refuses it (`snooze_until_past`). */
export function earliestSnoozeDate(nowIso: string): string {
  return snoozeUntilFromDays(nowIso, 1).slice(0, 10);
}

/** The latest date the picker may offer — {@link SNOOZE_MAX_DAYS} out. */
export function latestSnoozeDate(nowIso: string): string {
  return snoozeUntilFromDays(nowIso, SNOOZE_MAX_DAYS).slice(0, 10);
}

/** Is this a date the store may hold as `flags.snooze_until`? The caller stores
 * `check.until`, never the raw field, so every stored horizon is a full ISO
 * instant. */
export function checkSnoozeUntil(until: unknown, nowIso: string): SnoozeCheck {
  if (typeof until !== "string" || until.length === 0) {
    return { ok: false, reason: "snooze_until_invalid" };
  }
  const at = new Date(until);
  const atMs = at.getTime();
  if (Number.isNaN(atMs)) return { ok: false, reason: "snooze_until_invalid" };
  const nowMs = new Date(nowIso).getTime();
  if (atMs <= nowMs) return { ok: false, reason: "snooze_until_past" };
  if (atMs > nowMs + SNOOZE_MAX_DAYS * DAY_MS) {
    return { ok: false, reason: "snooze_until_too_far" };
  }
  return { ok: true, until: at.toISOString() };
}

/** Has a recorded snooze run out? The read side of `worker/flag-scope.ts`: an
 * expired snooze is an open alert still carrying the disposition, so it reads
 * "came back", not "snoozed". Unsnooze ends the snooze now rather than erasing
 * it, so one predicate covers both. */
export function snoozeEnded(
  snoozeUntil: string | null | undefined,
  nowMs: number,
): boolean {
  if (!snoozeUntil) return false;
  const at = new Date(snoozeUntil).getTime();
  return !Number.isNaN(at) && at <= nowMs;
}
