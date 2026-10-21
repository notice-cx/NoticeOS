// Why a task is worth doing, as data: the hypothesis card of docs/04. A task
// carries it in its metadata under `noticeos_card` (task-metadata.mts). The
// task tools validate a new card with `taskCardProblem`, the Tower's composer
// writes the same shape, and every reader goes through `readTaskCard`, which
// answers null for anything else, so a hand-edited or older value never ranks
// a task on a figure it does not hold. The card stays editable until the task
// first closes as done: the server then keeps it as it stood under
// `noticeos_card_shipped` (`readTaskCardShipped`), and no writer edits the
// card of a task that carries one, so grading reads the prediction it shipped
// with.
//
// `scoreTaskCard` is policy v1.0, the one formula the docs state:
//
//   score = (likelihood × valuePerMonth × durability) / costUsd / max(weeksToSignal, 2)
//
// costUsd prices the operator's review minutes at the installation's rate
// (`operator_rate_usd_per_min`); build minutes are shown beside it, not
// priced, because no installation records an inference rate yet. A task
// without a card has no score and is listed, never ranked.
//
// Authored TypeScript: `pnpm generate` writes the `.mjs` and `.d.mts`
// beside it.

import { TASK_METADATA } from "./task-metadata.mjs";

/** The version written beside every score, so a ranking can be re-read. */
export const TASK_CARD_POLICY = "v1.0";

/** How the change will be measured (docs/03's tiers, in the operator's words). */
export const TASK_MEASURABILITIES = Object.freeze(["cohort", "holdout", "unmeasured"] as const);
export type TaskMeasurability = (typeof TASK_MEASURABILITIES)[number];
export const TASK_MEASURABILITY_LABELS: Readonly<Record<TaskMeasurability, string>> = Object.freeze({
  cohort: "Cohort test",
  holdout: "Holdout",
  unmeasured: "Not measurable",
});

/** The ledger's revenue families (docs/02). */
export const TASK_REVENUE_FAMILIES = Object.freeze(["ads", "affiliate", "subs", "licensing"] as const);
export type TaskRevenueFamily = (typeof TASK_REVENUE_FAMILIES)[number];
export const TASK_REVENUE_FAMILY_LABELS: Readonly<Record<TaskRevenueFamily, string>> = Object.freeze({
  ads: "Ads",
  affiliate: "Affiliate",
  subs: "Subscriptions",
  licensing: "Licensing",
});

export const TASK_CARD_LIMITS = Object.freeze({
  /** USD a month, either sign: a loss avoided is a positive value for the task that avoids it. */
  valuePerMonth: { min: -1_000_000, max: 1_000_000 },
  likelihood: { min: 0.01, max: 0.99 },
  reviewMinutes: { min: 0, max: 100_000 },
  buildMinutes: { min: 0, max: 1_000_000 },
  daysToSignal: { min: 1, max: 730 },
  durability: { min: 0.5, max: 1.2 },
  killState: 300,
  note: 600,
  by: 120,
  /** The shortest horizon the score discounts by: two weeks (docs/04). */
  horizonFloorWeeks: 2,
});

export interface TaskKillCriterion {
  /** The state that, still true on `date`, parks the task and closes it out. */
  readonly state: string;
  /** A calendar date, `YYYY-MM-DD`. */
  readonly date: string;
}

export interface TaskCard {
  /** Predicted change in ledger value, USD a month. */
  readonly valuePerMonth: number;
  /** Probability the change pays off, 0.01–0.99. */
  readonly likelihood: number;
  /** The operator's minutes to review and decide. */
  readonly reviewMinutes: number;
  /** Agent or builder minutes, shown but not priced. */
  readonly buildMinutes?: number;
  /** Days until the ledger shows whether it worked. */
  readonly daysToSignal: number;
  readonly measurability: TaskMeasurability;
  readonly revenueFamily?: TaskRevenueFamily;
  /** The forecastability multiplier F, 0.5–1.2; 1 when absent. */
  readonly durability?: number;
  readonly kill?: TaskKillCriterion;
  /** The causal path in a line: why the money moves. */
  readonly note?: string;
  /** Who recorded the card and when, written by whoever stores it. */
  readonly by?: string;
  readonly at?: string;
}

/** The field at fault, as a caller names it (`card.likelihood`), and what it must be. */
export interface TaskCardProblem {
  readonly field: string;
  readonly rule: string;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const FIELDS = ["valuePerMonth", "likelihood", "reviewMinutes", "buildMinutes", "daysToSignal", "measurability",
  "revenueFamily", "durability", "kill", "note", "by", "at"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numberProblem(value: unknown, field: string, range: { min: number; max: number }, whole = false): TaskCardProblem | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return { field, rule: "a number" };
  if (whole && !Number.isInteger(value)) return { field, rule: "a whole number" };
  if (value < range.min || value > range.max) return { field, rule: `between ${range.min} and ${range.max}` };
  return null;
}

function textProblem(value: unknown, field: string, max: number): TaskCardProblem | null {
  if (typeof value !== "string") return { field, rule: "text" };
  if (!value.trim()) return { field, rule: "empty" };
  if (value.length > max) return { field, rule: `at most ${max} characters; this one has ${value.length}` };
  if (CONTROL.test(value) || /[\r\n]/u.test(value)) return { field, rule: "one line" };
  return null;
}

function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/** Why a value is not a card a task may carry, or null when it is one. */
export function taskCardProblem(value: unknown): TaskCardProblem | null {
  if (!isRecord(value)) return { field: "card", rule: "an object with valuePerMonth, likelihood, reviewMinutes, daysToSignal and measurability" };
  const extra = Object.keys(value).find((key) => !(FIELDS as readonly string[]).includes(key));
  if (extra !== undefined) return { field: `card.${extra}`, rule: `not a field of a card, which takes ${FIELDS.join(", ")}` };
  const L = TASK_CARD_LIMITS;
  return numberProblem(value.valuePerMonth, "card.valuePerMonth", L.valuePerMonth)
    ?? numberProblem(value.likelihood, "card.likelihood", L.likelihood)
    ?? numberProblem(value.reviewMinutes, "card.reviewMinutes", L.reviewMinutes)
    ?? (value.buildMinutes === undefined ? null : numberProblem(value.buildMinutes, "card.buildMinutes", L.buildMinutes))
    ?? numberProblem(value.daysToSignal, "card.daysToSignal", L.daysToSignal, true)
    ?? (isTaskMeasurability(value.measurability) ? null
      : { field: "card.measurability", rule: `one of ${TASK_MEASURABILITIES.join(", ")}` })
    ?? (value.revenueFamily === undefined || isTaskRevenueFamily(value.revenueFamily) ? null
      : { field: "card.revenueFamily", rule: `one of ${TASK_REVENUE_FAMILIES.join(", ")}` })
    ?? (value.durability === undefined ? null : numberProblem(value.durability, "card.durability", L.durability))
    ?? killProblem(value.kill)
    ?? (value.note === undefined ? null : textProblem(value.note, "card.note", L.note))
    ?? (value.by === undefined ? null : textProblem(value.by, "card.by", L.by))
    ?? (value.at === undefined ? null : typeof value.at === "string" && Number.isFinite(Date.parse(value.at)) ? null
      : { field: "card.at", rule: "an instant, as ISO 8601" });
}

function killProblem(value: unknown): TaskCardProblem | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return { field: "card.kill", rule: "an object with state and date" };
  const extra = Object.keys(value).find((key) => key !== "state" && key !== "date");
  if (extra !== undefined) return { field: `card.kill.${extra}`, rule: "not a field of kill, which takes state and date" };
  const state = textProblem(value.state, "card.kill.state", TASK_CARD_LIMITS.killState);
  if (state) return state;
  if (typeof value.date !== "string" || !isCalendarDate(value.date)) return { field: "card.kill.date", rule: "a calendar date, YYYY-MM-DD" };
  return null;
}

export function isTaskMeasurability(value: unknown): value is TaskMeasurability {
  return typeof value === "string" && (TASK_MEASURABILITIES as readonly string[]).includes(value);
}

export function isTaskRevenueFamily(value: unknown): value is TaskRevenueFamily {
  return typeof value === "string" && (TASK_REVENUE_FAMILIES as readonly string[]).includes(value);
}

/** A card that passes `taskCardProblem`, as it is stored: plain frozen data
 * with no absent field present. Null for anything else. */
export function taskCardOf(value: unknown): TaskCard | null {
  if (taskCardProblem(value) !== null) return null;
  const row = value as Record<string, unknown>;
  const card: Record<string, unknown> = {
    valuePerMonth: row.valuePerMonth,
    likelihood: row.likelihood,
    reviewMinutes: row.reviewMinutes,
    daysToSignal: row.daysToSignal,
    measurability: row.measurability,
  };
  for (const key of ["buildMinutes", "revenueFamily", "durability", "note", "by", "at"] as const) {
    if (row[key] !== undefined) card[key] = row[key];
  }
  if (row.kill !== undefined) {
    const kill = row.kill as Record<string, unknown>;
    card.kill = Object.freeze({ state: kill.state, date: kill.date });
  }
  return Object.freeze(card) as unknown as TaskCard;
}

/** The card a task's metadata holds, or null when it holds none it can read. */
export function readTaskCard(metadata: unknown): TaskCard | null {
  if (!isRecord(metadata)) return null;
  return taskCardOf(metadata[TASK_METADATA.card.name]);
}

/** A card as it stood when its task first closed as done. */
export interface TaskCardShipped {
  readonly card: TaskCard;
  /** The close that shipped it, as the task records its close time. */
  readonly closedAt: string;
  /** The commit hash the close reason names, when it names one. */
  readonly commit?: string;
}

const COMMIT = /^[0-9a-f]{7,64}$/u;

/** A shipped card as it is stored: plain frozen data, or null for anything
 * that is not one. */
export function taskCardShippedOf(value: unknown): TaskCardShipped | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "card" && key !== "closedAt" && key !== "commit")) return null;
  const card = taskCardOf(value.card);
  const { closedAt, commit } = value;
  if (card === null || typeof closedAt !== "string" || closedAt.length > 64 || !Number.isFinite(Date.parse(closedAt))) return null;
  if (commit === undefined) return Object.freeze({ card, closedAt });
  if (typeof commit !== "string" || !COMMIT.test(commit)) return null;
  return Object.freeze({ card, closedAt, commit });
}

/** The card a task shipped with, or null when its metadata holds none it can read. */
export function readTaskCardShipped(metadata: unknown): TaskCardShipped | null {
  if (!isRecord(metadata)) return null;
  return taskCardShippedOf(metadata[TASK_METADATA.cardShipped.name]);
}

export interface TaskCardScore {
  /** Policy v1.0's score; higher ranks first. */
  readonly score: number;
  /** The operator's review minutes at the installation's rate, USD. */
  readonly costUsd: number;
  /** The horizon the score discounts by: weeks to signal, never under the floor. */
  readonly horizonWeeks: number;
  /** likelihood × valuePerMonth × durability: the expected change a month, USD. */
  readonly expectedPerMonth: number;
  readonly policy: typeof TASK_CARD_POLICY;
}

/** Policy v1.0 over one card. The rate is USD per operator minute
 * (`operator_rate_usd_per_min`); a zero or missing rate prices a minute at one
 * cent so a free review never divides by zero and still ranks below a paid one. */
export function scoreTaskCard(card: TaskCard, { operatorRateUsdPerMin }: { operatorRateUsdPerMin: number }): TaskCardScore {
  const rate = Number.isFinite(operatorRateUsdPerMin) && operatorRateUsdPerMin > 0 ? operatorRateUsdPerMin : 0.01;
  const costUsd = Math.max(card.reviewMinutes, 1) * rate;
  const horizonWeeks = Math.max(card.daysToSignal / 7, TASK_CARD_LIMITS.horizonFloorWeeks);
  const expectedPerMonth = card.likelihood * card.valuePerMonth * (card.durability ?? 1);
  return Object.freeze({
    score: expectedPerMonth / costUsd / horizonWeeks,
    costUsd,
    horizonWeeks,
    expectedPerMonth,
    policy: TASK_CARD_POLICY,
  });
}
