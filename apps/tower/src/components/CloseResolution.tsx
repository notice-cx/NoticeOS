import { useId, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import { CheckCheck, ChevronDown, CircleSlash, Copy, Lock, SearchX } from "lucide-react";
import { TASK_RESOLUTION_LABELS, TASK_RESOLUTIONS, type TaskResolution } from "@noticeos/contract/task-resolution";
import { isTaskId } from "@shared/tasks";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { pillChoiceClass, pillChoiceStateClass } from "@/components/ui/pill";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { focusFirstMenuItem, roveMenuFocus } from "@/lib/menu-keys";
import { cn } from "@/lib/utils";

/** A close where nothing shipped. */
export type NotDone = Exclude<TaskResolution, "done">;
/** The four, in the order every surface lists them. */
export const NOT_DONE: readonly NotDone[] = TASK_RESOLUTIONS.filter((resolution): resolution is NotDone => resolution !== "done");

/** Each close where nothing shipped wears a glyph beside its words; none has a colour of its own. */
export const RESOLUTION_GLYPH: Readonly<Record<NotDone, ComponentType<{ className?: string }>>> = {
  "wont-do": CircleSlash,
  duplicate: Copy,
  "cant-reproduce": SearchX,
  "already-handled": CheckCheck,
};

/**
 * The five ways a close ends, as one row of chips, Done first: a radio group
 * whose arrow keys move the pick. Every chip keeps its border and its ring, so
 * a press never reflows the row; the picked one fills, and its ring with it.
 */
export function ResolutionChips({
  value,
  onChange,
  disabled = false,
  className,
}: {
  value: TaskResolution;
  /** `byKey` when an arrow key moved the pick, so focus stays on the chips. */
  onChange: (resolution: TaskResolution, byKey: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const chips = useRef<(HTMLButtonElement | null)[]>([]);
  function step(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = TASK_RESOLUTIONS.length - 1;
    const to = event.key === "Home" ? 0
      : event.key === "End" ? last
        : event.key === "ArrowRight" || event.key === "ArrowDown" ? (index === last ? 0 : index + 1)
          : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index === 0 ? last : index - 1)
            : null;
    if (to === null) return;
    event.preventDefault();
    onChange(TASK_RESOLUTIONS[to]!, true);
    chips.current[to]?.focus();
  }
  return (
    <div role="radiogroup" aria-label="How it ended" className={cn("flex flex-wrap gap-1.5", className)} data-resolution-chips="">
      {TASK_RESOLUTIONS.map((resolution, index) => {
        const picked = resolution === value;
        return (
          <button
            key={resolution}
            ref={(node) => { chips.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={picked}
            tabIndex={picked ? 0 : -1}
            disabled={disabled}
            className={cn(
              pillChoiceClass,
              pillChoiceStateClass(picked),
              "py-1.5 motion-safe:transition-[background-color,border-color,color,transform] motion-safe:active:scale-[0.97]",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
            data-resolution={resolution}
            data-resolution-picked={picked ? "" : undefined}
            onClick={() => onChange(resolution, false)}
            onKeyDown={(event) => step(event, index)}
          >
            <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full border-[1.5px] border-current", picked && "bg-current")} />
            {TASK_RESOLUTION_LABELS[resolution]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The four closes where nothing shipped, as a menu beside a row's other verbs:
 * a press on one hands it back, and the caller opens its one-line note. With a
 * reason it cannot be pressed, and the reason is written beside it.
 */
export function CloseAsMenu({
  onPick,
  subject,
  disabledReason = null,
  describedBy,
  className,
}: {
  onPick: (resolution: NotDone) => void;
  /** What closes, as the menu names it to a screen reader: the task's title. */
  subject: string;
  /** Why it cannot be pressed here, or null. */
  disabledReason?: string | null;
  /** The id of the text that already states `disabledReason`, which is then not written again. */
  describedBy?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ownReason = useId();
  const disabled = disabledReason !== null;
  const reasonId = describedBy ?? ownReason;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
            aria-haspopup="menu"
            disabled={disabled}
            aria-describedby={disabled ? reasonId : undefined}
            data-close-as-trigger=""
          >
            Close as
            <ChevronDown aria-hidden className={cn("motion-safe:transition-transform", open && "rotate-180")} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          role="menu"
          aria-label={`Close ${subject} as`}
          align="end"
          className="w-52 p-1.5"
          onKeyDown={roveMenuFocus}
          onOpenAutoFocus={focusFirstMenuItem}
          data-close-as-menu=""
        >
          {NOT_DONE.map((resolution) => {
            const Glyph = RESOLUTION_GLYPH[resolution];
            return (
              <button
                key={resolution}
                type="button"
                role="menuitem"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm text-foreground outline-none",
                  "hover:bg-muted focus-visible:bg-muted max-sm:min-h-11 motion-safe:active:scale-[0.98] motion-safe:transition-transform",
                )}
                onClick={() => {
                  setOpen(false);
                  onPick(resolution);
                }}
                data-close-as={resolution}
              >
                <Glyph className="size-4 shrink-0 text-muted-foreground" />
                {TASK_RESOLUTION_LABELS[resolution]}
              </button>
            );
          })}
        </PopoverContent>
      </Popover>
      {disabled && describedBy === undefined ? (
        <span id={ownReason} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-close-as-reason="">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          {disabledReason}
        </span>
      ) : null}
    </span>
  );
}

/** What a close where nothing shipped sends: the person's note, and the other task a duplicate names. */
export interface CloseAsInput {
  note?: string;
  duplicateOf?: string;
}

/**
 * The one line a close where nothing shipped takes: its resolution named, a
 * Note, and for a duplicate the other task's id first. Enter sends, Escape
 * steps back; the caller's send carries the Undo.
 */
export function CloseNoteForm({
  id,
  resolution,
  onSend,
  onCancel,
  named = true,
  autoFocus = true,
  className,
}: {
  /** The task that closes, which a duplicate cannot name as its other task. */
  id: string;
  resolution: NotDone;
  onSend: (close: CloseAsInput) => void;
  onCancel: () => void;
  /** Whether the line names its resolution: a row does, beside chips that already show it the page does not. */
  named?: boolean;
  /** Typing starts in the line, unless the pick that opened it was made from the keyboard on the chips. */
  autoFocus?: boolean;
  className?: string;
}) {
  const ids = useId();
  const [note, setNote] = useState("");
  const [other, setOther] = useState("");
  const duplicate = resolution === "duplicate";
  const otherId = other.trim();
  const ready = !duplicate || (isTaskId(otherId) && otherId !== id);
  const Glyph = RESOLUTION_GLYPH[resolution];

  function send() {
    if (!ready) return;
    const words = note.trim();
    onSend({ ...(words === "" ? {} : { note: words }), ...(duplicate ? { duplicateOf: otherId } : {}) });
  }

  return (
    <form
      className={cn("flex flex-wrap items-center gap-2", className)}
      data-task-form="close-as"
      data-close-resolution={resolution}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onCancel();
      }}
    >
      {named ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-foreground" data-close-as-named="">
          <Glyph className="size-4 text-muted-foreground" aria-hidden />
          {TASK_RESOLUTION_LABELS[resolution]}
        </span>
      ) : null}
      {duplicate ? (
        <span className="flex items-center gap-2">
          <label htmlFor={`${ids}-other`} className="shrink-0 text-xs font-medium text-muted-foreground">
            Duplicate of
          </label>
          <input
            id={`${ids}-other`}
            type="text"
            // The id is what this close needs first; typing starts there.
            autoFocus={autoFocus}
            spellCheck={false}
            autoCapitalize="off"
            className={cn(fieldClass, "h-8 w-36 font-mono text-xs")}
            value={other}
            onChange={(event) => setOther(event.target.value)}
            aria-invalid={otherId !== "" && !ready ? true : undefined}
            data-close-duplicate-of=""
          />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 basis-56 items-center gap-2">
        <label htmlFor={`${ids}-note`} className="shrink-0 text-xs font-medium text-muted-foreground">
          Note
        </label>
        <input
          id={`${ids}-note`}
          type="text"
          autoFocus={autoFocus && !duplicate}
          className={cn(fieldClass, "h-8 min-w-0 flex-1")}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          data-close-note=""
        />
      </span>
      <span className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!ready} data-task-confirm="close-as">
          Close task
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </span>
    </form>
  );
}
