import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  TASK_CARD_LIMITS,
  TASK_MEASURABILITIES,
  TASK_MEASURABILITY_LABELS,
  TASK_REVENUE_FAMILIES,
  TASK_REVENUE_FAMILY_LABELS,
  isTaskMeasurability,
  isTaskRevenueFamily,
  taskCardOf,
  taskCardProblem,
  type TaskCard,
  type TaskMeasurability,
  type TaskRevenueFamily,
} from "@noticeos/contract/task-card";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { pillChoiceClass, pillChoiceStateClass } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

/**
 * A task's card as a form: the figures as the operator types them (dollars,
 * a percent, minutes, days), checked by the contract's own `taskCardProblem`
 * so the page refuses exactly what the task tools refuse.
 */

/** The card's fields as typed. Numbers stay text until the save, so a blank
 * field is a missing figure and never a zero. */
export interface CardDraft {
  valuePerMonth: string;
  /** A percent, 1–99. */
  likelihood: string;
  reviewMinutes: string;
  daysToSignal: string;
  measurability: TaskMeasurability;
  revenueFamily: TaskRevenueFamily | "";
  killState: string;
  killDate: string;
  note: string;
}

export type CardDraftField = keyof CardDraft | "form";

export interface CardDraftProblem {
  field: CardDraftField;
  /** What the field must be, in the form's units. */
  message: string;
}

export const LIKELIHOOD_PRESETS = [30, 55, 75, 90] as const;
export const SIGNAL_PRESETS = [
  { label: "2 weeks", days: 14 },
  { label: "4 weeks", days: 28 },
  { label: "8 weeks", days: 56 },
] as const;

/** The draft a card opens as; a new card claims no figure it was not given,
 * and is "Not measurable" until somebody says how it will be measured. */
export function cardDraft(card: TaskCard | null): CardDraft {
  return {
    valuePerMonth: card ? String(card.valuePerMonth) : "",
    likelihood: card ? String(Math.round(card.likelihood * 10_000) / 100) : "",
    reviewMinutes: card ? String(card.reviewMinutes) : "",
    daysToSignal: card ? String(card.daysToSignal) : "",
    measurability: card?.measurability ?? "unmeasured",
    revenueFamily: card?.revenueFamily ?? "",
    killState: card?.kill?.state ?? "",
    killDate: card?.kill?.date ?? "",
    note: card?.note ?? "",
  };
}

/** The contract's field names (`card.kill.date`) as this form's fields. */
const FIELD_OF: Readonly<Record<string, CardDraftField>> = {
  "card.valuePerMonth": "valuePerMonth",
  "card.likelihood": "likelihood",
  "card.reviewMinutes": "reviewMinutes",
  "card.daysToSignal": "daysToSignal",
  "card.measurability": "measurability",
  "card.revenueFamily": "revenueFamily",
  "card.kill": "killState",
  "card.kill.state": "killState",
  "card.kill.date": "killDate",
  "card.note": "note",
};

function figure(text: string): number | undefined {
  return text.trim() === "" ? undefined : Number(text);
}

/**
 * The card a draft makes, or the first field at fault and its rule. The
 * figures the form does not show (build minutes, durability) are carried over
 * from the card it edits; who recorded it and when are stamped by the writer
 * that stores it, so the card sent carries neither.
 */
export function cardFromDraft(
  draft: CardDraft,
  previous: TaskCard | null,
): { card: TaskCard; problem: null } | { card: null; problem: CardDraftProblem } {
  const percent = figure(draft.likelihood);
  const candidate: Record<string, unknown> = {
    valuePerMonth: figure(draft.valuePerMonth),
    likelihood: percent === undefined ? undefined : Number((percent / 100).toFixed(4)),
    reviewMinutes: figure(draft.reviewMinutes),
    daysToSignal: figure(draft.daysToSignal),
    measurability: draft.measurability,
  };
  if (previous?.buildMinutes !== undefined) candidate.buildMinutes = previous.buildMinutes;
  if (previous?.durability !== undefined) candidate.durability = previous.durability;
  if (draft.revenueFamily !== "") candidate.revenueFamily = draft.revenueFamily;
  if (draft.killState.trim() !== "" || draft.killDate !== "") {
    candidate.kill = { state: draft.killState.trim(), date: draft.killDate };
  }
  if (draft.note.trim() !== "") candidate.note = draft.note.trim();
  const problem = taskCardProblem(candidate);
  if (problem !== null) {
    return { card: null, problem: { field: FIELD_OF[problem.field] ?? "form", message: problemMessage(problem.field, problem.rule) } };
  }
  const card = taskCardOf(candidate);
  return card === null
    ? { card: null, problem: { field: "form", message: "Must be a card the task tools accept" } }
    : { card, problem: null };
}

/** A rule as the line under its field. The likelihood is typed as a percent,
 * so its range is said in percent. */
function problemMessage(field: string, rule: string): string {
  if (rule === "empty") return "Required";
  if (field === "card.likelihood" && rule.startsWith("between")) {
    const { min, max } = TASK_CARD_LIMITS.likelihood;
    return `Must be between ${Math.round(min * 100)} and ${Math.round(max * 100)}`;
  }
  return `Must be ${rule}`;
}

/** The form under "Why it ranks": Save writes the card, Cancel or Escape
 * leaves it as it was. A field's rule is shown under it once Save is pressed,
 * and follows the typing from then on. */
export function TaskCardForm({
  card,
  onSave,
  onCancel,
}: {
  card: TaskCard | null;
  /** Writes the card; false when the write was refused. */
  onSave: (next: TaskCard) => Promise<boolean>;
  onCancel: () => void;
}) {
  const initial = useMemo(() => cardDraft(card), [card]);
  const [draft, setDraft] = useState<CardDraft>(initial);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const result = cardFromDraft(draft, card);
  const problem = tried ? result.problem : null;
  const unchanged = (Object.keys(initial) as (keyof CardDraft)[]).every((key) => draft[key] === initial[key]);
  const set = <K extends keyof CardDraft>(key: K, value: CardDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const fault = (field: CardDraftField) => problem?.field === field;
  const problemId = `${id}-problem`;
  const invalid = (field: CardDraftField) => fault(field)
    ? { "aria-invalid": true as const, "aria-describedby": problemId }
    : {};
  const rule = (field: CardDraftField) => fault(field) ? (
    <p id={problemId} className="m-0 text-xs text-error" data-card-problem={field}>{problem?.message}</p>
  ) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (result.card === null || saving || unchanged) return;
    setSaving(true);
    try {
      await onSave(result.card);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      aria-label="Why it ranks"
      data-task-form="card"
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <div className="grid min-w-0 gap-x-4 gap-y-3 sm:grid-cols-2">
        <Labelled label="Predicted change a month">
          <Affixed suffix="USD">
            <input
              type="number"
              inputMode="decimal"
              step="any"
              autoFocus
              aria-label="Predicted change a month"
              value={draft.valuePerMonth}
              onChange={(event) => set("valuePerMonth", event.target.value)}
              className={cn(fieldClass, "min-w-0 flex-1 tabular-nums")}
              {...invalid("valuePerMonth")}
            />
          </Affixed>
          {rule("valuePerMonth")}
        </Labelled>

        <Group legend="Likely to pay off">
          <div className="flex flex-wrap items-center gap-1.5">
            {LIKELIHOOD_PRESETS.map((percent) => {
              const picked = figure(draft.likelihood) === percent;
              return (
                <button key={percent} type="button" aria-pressed={picked} onClick={() => set("likelihood", String(percent))}
                  className={cn(pillChoiceClass, pillChoiceStateClass(picked), "tabular-nums")}>
                  {percent}%
                </button>
              );
            })}
            <Affixed suffix="%">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={99}
                aria-label="Likely to pay off, in percent"
                value={draft.likelihood}
                onChange={(event) => set("likelihood", event.target.value)}
                className={cn(fieldClass, "w-20 tabular-nums")}
                {...invalid("likelihood")}
              />
            </Affixed>
          </div>
          {rule("likelihood")}
        </Group>

        <Labelled label="Your minutes to review">
          <Affixed suffix="min">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              aria-label="Your minutes to review"
              value={draft.reviewMinutes}
              onChange={(event) => set("reviewMinutes", event.target.value)}
              className={cn(fieldClass, "min-w-0 flex-1 tabular-nums")}
              {...invalid("reviewMinutes")}
            />
          </Affixed>
          {rule("reviewMinutes")}
        </Labelled>

        <Group legend="Signal in">
          <div className="flex flex-wrap items-center gap-1.5">
            {SIGNAL_PRESETS.map((preset) => {
              const picked = figure(draft.daysToSignal) === preset.days;
              return (
                <button key={preset.days} type="button" aria-pressed={picked} onClick={() => set("daysToSignal", String(preset.days))}
                  className={cn(pillChoiceClass, pillChoiceStateClass(picked))}>
                  {preset.label}
                </button>
              );
            })}
            <Affixed suffix="days">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                aria-label="Signal in, in days"
                value={draft.daysToSignal}
                onChange={(event) => set("daysToSignal", event.target.value)}
                className={cn(fieldClass, "w-20 tabular-nums")}
                {...invalid("daysToSignal")}
              />
            </Affixed>
          </div>
          {rule("daysToSignal")}
        </Group>

        <Labelled label="Measured as">
          <select
            aria-label="Measured as"
            value={draft.measurability}
            onChange={(event) => {
              if (isTaskMeasurability(event.target.value)) set("measurability", event.target.value);
            }}
            className={cn(fieldClass, "w-full")}
            {...invalid("measurability")}
          >
            {TASK_MEASURABILITIES.map((value) => (
              <option key={value} value={value}>{TASK_MEASURABILITY_LABELS[value]}</option>
            ))}
          </select>
          {rule("measurability")}
        </Labelled>

        <Labelled label="Revenue family">
          <select
            aria-label="Revenue family"
            value={draft.revenueFamily}
            onChange={(event) => {
              const value = event.target.value;
              set("revenueFamily", isTaskRevenueFamily(value) ? value : "");
            }}
            className={cn(fieldClass, "w-full")}
            {...invalid("revenueFamily")}
          >
            <option value="">Not recorded</option>
            {TASK_REVENUE_FAMILIES.map((value) => (
              <option key={value} value={value}>{TASK_REVENUE_FAMILY_LABELS[value]}</option>
            ))}
          </select>
          {rule("revenueFamily")}
        </Labelled>

        <Group legend="Kill criterion" className="sm:col-span-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <input
              type="text"
              aria-label="Kill if still true"
              placeholder="Sign-ups under 20 a week"
              value={draft.killState}
              maxLength={TASK_CARD_LIMITS.killState}
              onChange={(event) => set("killState", event.target.value)}
              className={cn(fieldClass, "min-w-0 flex-1 basis-56")}
              {...invalid("killState")}
            />
            <input
              type="date"
              aria-label="Kill date"
              value={draft.killDate}
              onChange={(event) => set("killDate", event.target.value)}
              className={cn(fieldClass, "tabular-nums")}
              {...invalid("killDate")}
            />
          </div>
          {rule("killState")}
          {rule("killDate")}
        </Group>

        <Labelled label="Note" className="sm:col-span-2">
          <input
            type="text"
            aria-label="Note"
            placeholder="Why the money moves"
            value={draft.note}
            maxLength={TASK_CARD_LIMITS.note}
            onChange={(event) => set("note", event.target.value)}
            className={cn(fieldClass, "w-full")}
            {...invalid("note")}
          />
          {rule("note")}
        </Labelled>
      </div>
      {rule("form")}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={saving || unchanged}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const LABEL = "text-xs font-medium text-muted-foreground";

function Labelled({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className={LABEL}>{label}</span>
      {children}
    </label>
  );
}

function Group({ legend, className, children }: { legend: string; className?: string; children: ReactNode }) {
  return (
    <fieldset className={cn("m-0 flex min-w-0 flex-col gap-1 border-0 p-0", className)}>
      <legend className={cn(LABEL, "mb-1 p-0")}>{legend}</legend>
      {children}
    </fieldset>
  );
}

/** A field with its unit after it, a step lighter. */
function Affixed({ suffix, children }: { suffix: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {children}
      <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>
    </span>
  );
}
