import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Lock, Star } from "lucide-react";
import {
  TASK_CHOICE_LIMITS,
  choiceName,
  type TaskChoiceKey,
  type TaskChoiceOption,
  type TaskChoices,
} from "@noticeos/contract/task-choices";
import { fieldClass } from "@/components/ui/field";
import { pillChoiceStateClass, pillControlClass } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

/** The options in the order they are drawn: the recommended one first, then
 * the rest in key order. */
export function choiceOrder(choices: TaskChoices): readonly TaskChoiceOption[] {
  return [...choices.options.filter((option) => option.recommended), ...choices.options.filter((option) => !option.recommended)];
}

/** One option's box, live or inert: a 44 px target at least, full width in a
 * column on a phone. */
const optionBox = "flex min-h-11 w-full min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2 text-start";

// Full height, so options side by side end on one line.
const liveOption = cn(
  optionBox,
  pillControlClass,
  "group/option h-full bg-card text-foreground hover:border-foreground/30 hover:bg-muted/60 active:bg-muted",
  "motion-safe:transition-[background-color,border-color,transform] motion-safe:active:scale-[0.99]",
  "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-card",
);

/**
 * A question and one button per option: the recommended option first with a
 * star and the word Recommended, each option's detail under its label, then a
 * one-line Note and whatever the caller seats beside it (the free-text Answer
 * and Dismiss). A press hands the option and the note to `onChoose`; the
 * caller's call carries the Undo.
 *
 * With `chosen` the options are a record: nothing to press, the chosen one
 * filled. With `disabledReason` they are drawn as buttons that cannot be
 * pressed, and the reason is written under them unless `describedBy` names
 * where it already is.
 */
export function ChoiceButtons({
  choices,
  chosen = null,
  onChoose,
  disabledReason = null,
  describedBy,
  footer,
  className,
}: {
  choices: TaskChoices;
  /** The option a person picked: the options become a record. */
  chosen?: TaskChoiceKey | null;
  onChoose?: (option: TaskChoiceKey, note: string | undefined) => void;
  /** Why the options cannot be pressed here, or null. */
  disabledReason?: string | null;
  /** The id of the text that already states `disabledReason`. */
  describedBy?: string;
  /** Seated after the Note: the other verbs on the same ask. */
  footer?: ReactNode;
  className?: string;
}) {
  const ids = useId();
  const [note, setNote] = useState("");
  const options = choiceOrder(choices);
  const questionId = `${ids}-question`;
  const disabled = disabledReason !== null || onChoose === undefined;
  const reasonId = disabledReason !== null && describedBy === undefined ? `${ids}-reason` : undefined;
  const pointsAt = disabledReason === null ? undefined : describedBy ?? reasonId;

  const question = (
    <p id={questionId} className="m-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]" data-choice-question="">
      {choices.question}
    </p>
  );
  // Two or three side by side when the space holds them, one column on a phone.
  const grid = "m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-2 p-0";

  if (chosen !== null) {
    return (
      <div role="group" aria-labelledby={questionId} className={cn("flex min-w-0 flex-col gap-2", className)} data-choice-buttons="chosen">
        {question}
        <ul className={grid}>
          {options.map((option, index) => {
            const picked = option.key === chosen;
            return (
              <li
                key={option.key}
                className={cn(optionBox, "viz-arrive", pillChoiceStateClass(picked), !picked && "hover:bg-transparent")}
                style={{ "--viz-i": index } as CSSProperties}
                data-choice-option={option.key}
                data-choice-chosen={picked ? "" : undefined}
                aria-current={picked ? "true" : undefined}
              >
                <OptionFace option={option} state={picked ? "chosen" : "other"} />
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div role="group" aria-labelledby={questionId} className={cn("flex min-w-0 flex-col gap-2", className)} data-choice-buttons={disabled ? "inert" : "live"}>
      {question}
      <ul className={grid}>
        {options.map((option, index) => {
          const detailId = `${ids}-${option.key}`;
          const said = [option.recommended ? `${detailId}-recommended` : null, option.detail ? `${detailId}-detail` : null, pointsAt ?? null]
            .filter(Boolean).join(" ");
          return (
            <li key={option.key} className="viz-arrive min-w-0" style={{ "--viz-i": index } as CSSProperties}>
              <button
                type="button"
                className={cn(liveOption, option.recommended ? "border-foreground/40" : "border-border")}
                disabled={disabled}
                aria-label={choiceName(option.key, option.label)}
                aria-describedby={said === "" ? undefined : said}
                data-choice-option={option.key}
                data-choice-recommended={option.recommended ? "" : undefined}
                onClick={() => {
                  if (disabled) return;
                  onChoose?.(option.key, note.trim() === "" ? undefined : note.trim());
                  setNote("");
                }}
              >
                <OptionFace option={option} state={option.recommended ? "recommended" : "live"} detailId={detailId} />
              </button>
            </li>
          );
        })}
      </ul>
      {!disabled || footer ? (
        <div className="flex flex-wrap items-center gap-2">
          {!disabled ? (
            <span className="flex min-w-0 flex-1 basis-56 items-center gap-2">
              <label htmlFor={`${ids}-note`} className="shrink-0 text-xs font-medium text-muted-foreground">
                Note
              </label>
              <input
                id={`${ids}-note`}
                type="text"
                className={cn(fieldClass, "h-8 min-w-0 flex-1")}
                maxLength={TASK_CHOICE_LIMITS.note}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                data-choice-note=""
              />
            </span>
          ) : null}
          {footer}
        </div>
      ) : null}
      {reasonId ? (
        <p id={reasonId} className="m-0 inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-choice-reason="">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          {disabledReason}
        </p>
      ) : null}
    </div>
  );
}

/** What an option shows: its key in a ring, its label, Recommended with a
 * star on the one recommended, and its detail. A chosen option's ring is
 * filled and a tick follows its label. */
function OptionFace({ option, state, detailId }: {
  option: TaskChoiceOption;
  state: "live" | "recommended" | "chosen" | "other";
  detailId?: string;
}) {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "mt-px grid size-5 shrink-0 place-items-center rounded-full border-[1.5px] text-micro font-semibold leading-none",
          state === "chosen" ? "border-primary bg-primary text-primary-foreground"
            : state === "recommended" ? "border-foreground text-foreground"
              : "border-current text-muted-foreground group-hover/option:text-foreground motion-safe:transition-colors",
        )}
      >
        {option.key}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className={cn("flex min-w-0 items-start gap-1.5 text-sm font-medium [overflow-wrap:anywhere]", state === "other" ? "text-muted-foreground" : "text-foreground")}>
          <span className="min-w-0">{option.label}</span>
          {state === "chosen" ? <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" /> : null}
        </span>
        {option.recommended ? (
          <span id={detailId ? `${detailId}-recommended` : undefined} className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-choice-recommended-caption="">
            <Star aria-hidden className="size-3 shrink-0 fill-current" />
            Recommended
          </span>
        ) : null}
        {option.detail ? (
          <span id={detailId ? `${detailId}-detail` : undefined} className="whitespace-pre-line text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">
            {option.detail}
          </span>
        ) : null}
      </span>
      {state === "chosen" ? <span className="sr-only">Chosen</span> : null}
    </>
  );
}
