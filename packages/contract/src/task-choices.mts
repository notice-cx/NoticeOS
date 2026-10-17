// A task that waits on a person's pick carries its options as data, so the
// Tower draws one button per option and records which one was chosen. The task
// tools validate a new set with `taskChoicesProblem`, the server stores it in
// the task's metadata under `noticeos_choices` (task-metadata.mts), and the
// choose operation writes the pick under `noticeos_choice`. Every reader goes
// through `readTaskChoices` and `readTaskChoice`, which answer null for
// anything else, so a hand-edited or older value never draws a broken button.
//
// Authored TypeScript: `pnpm generate` writes the `.mjs` and `.d.mts`
// beside it.

import { TASK_METADATA } from "./task-metadata.mjs";

/** The keys options take, in the order they are shown. */
export const TASK_CHOICE_KEYS = Object.freeze(["a", "b", "c", "d", "e", "f"] as const);
export type TaskChoiceKey = (typeof TASK_CHOICE_KEYS)[number];

export const TASK_CHOICE_LIMITS = Object.freeze({
  question: 400,
  label: 120,
  detail: 600,
  /** The person's note beside a pick. */
  note: 2000,
  fewest: 2,
  most: TASK_CHOICE_KEYS.length,
});

export interface TaskChoiceOption {
  readonly key: TaskChoiceKey;
  /** One line: the words on the option's button. */
  readonly label: string;
  readonly detail?: string;
  /** On exactly one option of a set. */
  readonly recommended?: true;
}

export interface TaskChoices {
  readonly question: string;
  readonly options: readonly TaskChoiceOption[];
}

/** A person's pick, as the choose operation records it. */
export interface TaskChoice {
  readonly option: TaskChoiceKey;
  /** The option's label when it was chosen. */
  readonly label: string;
  /** The person who chose. */
  readonly by: string;
  readonly at: string;
  readonly note?: string;
}

/** The field at fault, as a caller names it (`choices.options[1].key`), and
 * what it must be. */
export interface TaskChoicesProblem {
  readonly field: string;
  readonly rule: string;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textProblem(value: unknown, field: string, max: number, oneLine: boolean): TaskChoicesProblem | null {
  if (typeof value !== "string") return { field, rule: "text" };
  if (!value.trim()) return { field, rule: "empty" };
  if (value.length > max) return { field, rule: `at most ${max} characters; this one has ${value.length}` };
  if (CONTROL.test(value)) return { field, rule: "a control character; tab and line breaks are the only ones allowed" };
  if (oneLine && /[\r\n]/u.test(value)) return { field, rule: "one line" };
  return null;
}

/** Why a value is not a set of choices a task may carry, or null when it is
 * one: a question and two to six options keyed a, b, c… in the order shown,
 * each with a one-line label and an optional detail, exactly one marked
 * `recommended: true`. */
export function taskChoicesProblem(value: unknown): TaskChoicesProblem | null {
  if (!isRecord(value)) return { field: "choices", rule: "an object with question and options" };
  const extra = Object.keys(value).find((key) => key !== "question" && key !== "options");
  if (extra !== undefined) return { field: `choices.${extra}`, rule: "not a field of choices, which takes question and options" };
  const question = textProblem(value.question, "choices.question", TASK_CHOICE_LIMITS.question, false);
  if (question) return question;
  const options = value.options;
  if (!Array.isArray(options) || options.length < TASK_CHOICE_LIMITS.fewest || options.length > TASK_CHOICE_LIMITS.most) {
    return { field: "choices.options", rule: `${TASK_CHOICE_LIMITS.fewest} to ${TASK_CHOICE_LIMITS.most} options` };
  }
  let recommended = 0;
  for (const [index, option] of options.entries()) {
    const at = `choices.options[${index}]`;
    if (!isRecord(option)) return { field: at, rule: "an object with key and label" };
    const unknown = Object.keys(option).find((key) => !["key", "label", "detail", "recommended"].includes(key));
    if (unknown !== undefined) return { field: `${at}.${unknown}`, rule: "not a field of an option, which takes key, label, detail and recommended" };
    const key = TASK_CHOICE_KEYS[index]!;
    if (option.key !== key) return { field: `${at}.key`, rule: `${key}: keys run a, b, c… in the order the options are shown` };
    const label = textProblem(option.label, `${at}.label`, TASK_CHOICE_LIMITS.label, true);
    if (label) return label;
    if (option.detail !== undefined) {
      const detail = textProblem(option.detail, `${at}.detail`, TASK_CHOICE_LIMITS.detail, false);
      if (detail) return detail;
    }
    if (option.recommended !== undefined && typeof option.recommended !== "boolean") return { field: `${at}.recommended`, rule: "true or false" };
    if (option.recommended === true) recommended += 1;
  }
  if (recommended !== 1) return { field: "choices.options", rule: `exactly one option with recommended: true; these have ${recommended}` };
  return null;
}

/** A set that passes `taskChoicesProblem`, as it is stored: plain frozen data,
 * `recommended` only on the one option. Null for anything else. */
export function taskChoicesOf(value: unknown): TaskChoices | null {
  if (taskChoicesProblem(value) !== null) return null;
  const row = value as { question: string; options: { key: TaskChoiceKey; label: string; detail?: string; recommended?: boolean }[] };
  return Object.freeze({
    question: row.question,
    options: Object.freeze(row.options.map((option) => Object.freeze({
      key: option.key,
      label: option.label,
      ...(option.detail === undefined ? {} : { detail: option.detail }),
      ...(option.recommended === true ? { recommended: true as const } : {}),
    }))),
  });
}

/** A task's choices, from its metadata; null when it carries none. */
export function readTaskChoices(metadata: unknown): TaskChoices | null {
  return isRecord(metadata) ? taskChoicesOf(metadata[TASK_METADATA.choices.name]) : null;
}

/** A recorded pick, read strictly; null for anything else. */
export function taskChoiceOf(value: unknown): TaskChoice | null {
  if (!isRecord(value)) return null;
  const { option, label, by, at, note } = value;
  if (typeof option !== "string" || !(TASK_CHOICE_KEYS as readonly string[]).includes(option)) return null;
  if (typeof label !== "string" || !label.trim() || typeof by !== "string" || !by.trim()) return null;
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return null;
  if (note !== undefined && (typeof note !== "string" || !note.trim())) return null;
  return Object.freeze({ option: option as TaskChoiceKey, label, by, at, ...(note === undefined ? {} : { note }) });
}

/** The pick a task carries, from its metadata; null until a person chooses. */
export function readTaskChoice(metadata: unknown): TaskChoice | null {
  return isRecord(metadata) ? taskChoiceOf(metadata[TASK_METADATA.choice.name]) : null;
}

/** An option as a sentence names it: "(b) Keep the old page". */
export function choiceName(option: TaskChoiceKey, label: string): string {
  return `(${option}) ${label}`;
}
