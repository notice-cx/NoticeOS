// The snooze vocabulary — the ONE definition of how long an alert may be
// quiet, shared by the browser that offers the choice and the Worker that
// validates it (docs/15 flow E, "snooze til date").
//
// It lives in `shared/` rather than in either side because a horizon the
// browser enforces and the Worker does not is not a rule, it is a suggestion;
// and two copies of "90 days" drift the first time one of them is edited.

/**
 * The furthest an alert may be pushed out, in days.
 *
 * A snooze is a promise to look at something later, so it has to be short
 * enough that "later" arrives while the condition still matters. Ninety days is
 * a quarter — past that the honest action is Resolve (the issue is gone) or
 * Mark read (the rule is noise and should be tuned), not silence with no end in
 * sight. The cap is what keeps "muting without a reason doesn't exist"
 * (docs/15-E) true in practice rather than only in the note field.
 */
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

/**
 * A calendar date from `<input type="date">` as the instant the alert returns.
 *
 * "Until the 10th" means the operator expects to see it again ON the 10th, so
 * the snooze ends at the start of that day rather than its end. Returns null
 * for anything that is not a `YYYY-MM-DD` date, which is the browser handing
 * the Worker something it will refuse anyway.
 */
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

/**
 * Is this a date the store may hold as `flags.snooze_until`?
 *
 * Normalizes as it validates: the caller stores `check.until`, never the raw
 * request field, so every stored horizon is a full ISO instant regardless of
 * which affordance produced it.
 */
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

/**
 * Has a recorded snooze run out?
 *
 * The read side's half of the rule the SQL in `worker/flag-scope.ts` states:
 * an expired snooze is an OPEN alert whose row still carries the disposition
 * that quieted it, so a surface rendering that row has to say "came back" and
 * not "snoozed". Unsnooze uses the same mechanism — it ends the snooze now
 * rather than erasing it — which is why one predicate covers both.
 */
export function snoozeEnded(
  snoozeUntil: string | null | undefined,
  nowMs: number,
): boolean {
  if (!snoozeUntil) return false;
  const at = new Date(snoozeUntil).getTime();
  return !Number.isNaN(at) && at <= nowMs;
}
