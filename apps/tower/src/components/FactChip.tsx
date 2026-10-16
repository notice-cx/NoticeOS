import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, CornerDownLeft, LoaderCircle } from "lucide-react";
import { Link } from "react-router-dom";
import { fieldClass } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** One choice in a fact's editor: its stored value, its word, and the mark
 * the fact draws for it (a status glyph, a priority mark). */
export interface FactChoice {
  value: string;
  label: string;
  mark?: ReactNode;
}

/** How a fact is edited: pick one of its choices (and, where the list cannot
 * hold every value, type another), type a free value, or pick a date. */
export type FactEditor =
  | {
      kind: "choice";
      value: string;
      choices: readonly FactChoice[];
      /** A typed value beside the list: its input's name and hint. */
      other?: { label: string; placeholder?: string; mono?: boolean };
    }
  | { kind: "text"; value: string; inputLabel?: string; placeholder?: string; mono?: boolean }
  | {
      kind: "date";
      /** `YYYY-MM-DD`, or empty for none. */
      value: string;
      presets?: readonly { label: string; value: string }[];
      /** The choice that clears the date, offered while one is set. */
      clearLabel?: string;
    };

export interface FactChipProps {
  /** What the fact is ("Status"): the editor's name. */
  label: string;
  /** The value in words, for the press's name: "Status: In progress". */
  valueText: string;
  /** The value as it is drawn. */
  children: ReactNode;
  /** Where the value leads. With an editor the chip splits: the value is the
   * link and a chevron beside it opens the editor. */
  to?: string;
  /** Without one, or without `onSave`, the chip is a plain fact. */
  editor?: FactEditor;
  /** Writes the value; false when the write was refused. */
  onSave?: (next: string) => Promise<boolean> | boolean;
  /** No write permission here: the same chip as a plain fact. */
  readOnly?: boolean;
  /** A value that is an absence ("Nobody"), drawn in muted ink. */
  quiet?: boolean;
  className?: string;
}

/** The chip's box, shared by the label chips that sit beside fact chips. */
export const factChipClass =
  "inline-flex min-h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-0.5 text-left text-xs font-medium text-foreground";

const pressable = cn(
  "group outline-none hover:border-foreground/30 hover:bg-muted/60 active:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring",
  "data-[state=open]:border-ring/60 data-[state=open]:bg-muted max-sm:min-h-11",
  "motion-safe:transition-[background-color,border-color,transform] motion-safe:active:scale-[0.97]",
);

/**
 * A fact drawn as its value, sized to its content, that edits where it is
 * read: a press opens a small editor, a choice or Enter saves at once (the
 * caller's save carries the Undo), Escape or a press outside leaves it as it
 * was. Without write permission it is the same chip with nothing to press.
 */
export function FactChip({ label, valueText, children, to, editor, onSave, readOnly = false, quiet = false, className }: FactChipProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const editable = editor !== undefined && onSave !== undefined && !readOnly;
  const face = (
    // Keyed by the value, so a new value arrives rather than swaps.
    <span key={valueText} className={cn("viz-arrive inline-flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]", quiet && "text-muted-foreground")}>
      {children}
    </span>
  );

  async function save(next: string) {
    setOpen(false);
    // Choosing the value it already has is not an edit.
    if (!editable || saving || next === editor.value) return;
    setSaving(true);
    try {
      await onSave?.(next);
    } finally {
      setSaving(false);
    }
  }

  if (!editable) {
    return to ? (
      <Link to={to} data-fact-chip="link" className={cn(factChipClass, pressable, className)}>{face}</Link>
    ) : (
      <span data-fact-chip="plain" className={cn(factChipClass, className)}>{face}</span>
    );
  }

  const spinner = saving ? <LoaderCircle aria-hidden className="size-3 shrink-0 motion-safe:animate-spin" /> : null;
  const chevron = (
    <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground group-hover:text-foreground motion-safe:transition-transform group-data-[state=open]:rotate-180" />
  );
  const name = valueText === "" ? label : `${label}: ${valueText}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {to ? (
        <span data-fact-chip="split" aria-busy={saving || undefined} className={cn(factChipClass, "gap-0 p-0", className)}>
          <Link to={to} className={cn("inline-flex min-h-7 min-w-0 items-center gap-1.5 rounded-s-full py-0.5 ps-2.5 pe-2", pressable, "border-0")}>
            {face}
          </Link>
          <PopoverTrigger
            type="button"
            aria-label={`Change ${label.toLowerCase()}`}
            aria-haspopup="dialog"
            className={cn("inline-flex min-h-7 items-center gap-1 self-stretch rounded-e-full border-s border-border ps-1.5 pe-2", pressable, "border-y-0 border-e-0")}
          >
            {spinner}
            {chevron}
          </PopoverTrigger>
        </span>
      ) : (
        <PopoverTrigger
          type="button"
          aria-label={name}
          aria-haspopup="dialog"
          aria-busy={saving || undefined}
          data-fact-chip="editable"
          className={cn(factChipClass, pressable, className)}
        >
          {face}
          {spinner ?? chevron}
        </PopoverTrigger>
      )}
      <PopoverContent
        side="bottom"
        align="start"
        aria-label={label}
        className="w-auto min-w-44 max-w-[min(20rem,calc(100vw-2rem))] p-1.5"
        onOpenAutoFocus={(event) => {
          // The chosen option, else the first, else the input.
          event.preventDefault();
          const panel = event.currentTarget as HTMLElement | null;
          (panel?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
            ?? panel?.querySelector<HTMLElement>('[role="option"], input'))?.focus();
        }}
        data-fact-editor={label}
      >
        {editor.kind === "choice" ? (
          <ChoiceEditor label={label} editor={editor} onPick={(next) => void save(next)} />
        ) : editor.kind === "text" ? (
          <TypedValue
            label={editor.inputLabel ?? label}
            initial={editor.value}
            placeholder={editor.placeholder}
            mono={editor.mono}
            onCommit={(next) => void save(next)}
          />
        ) : (
          <DateEditor label={label} editor={editor} onPick={(next) => void save(next)} />
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Up and down move between the options, Home and End to either end. */
function roveOptions(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
  if (options.length === 0) return;
  event.preventDefault();
  const at = options.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "Home" ? 0
      : event.key === "End" ? options.length - 1
        : event.key === "ArrowDown" ? (at + 1) % options.length
          : (at - 1 + options.length) % options.length;
  options[next]?.focus();
}

function Option({ choice, selected, onPick }: { choice: FactChoice; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-value={choice.value}
      onClick={onPick}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground outline-none max-sm:min-h-11",
        "hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        selected && "font-medium",
      )}
    >
      {choice.mark ? <span aria-hidden className="flex w-4 shrink-0 justify-center">{choice.mark}</span> : null}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{choice.label}</span>
      {selected ? <Check aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /> : <span aria-hidden className="size-3.5 shrink-0" />}
    </button>
  );
}

function ChoiceEditor({ label, editor, onPick }: {
  label: string;
  editor: Extract<FactEditor, { kind: "choice" }>;
  onPick: (value: string) => void;
}) {
  // A stored value the list does not name is offered as itself, never reset.
  const known = editor.choices.some((choice) => choice.value === editor.value);
  const choices = known ? editor.choices : [{ value: editor.value, label: editor.value || "Not set" }, ...editor.choices];
  return (
    <div className="flex flex-col gap-1">
      <div role="listbox" aria-label={label} className="flex flex-col" onKeyDown={roveOptions}>
        {choices.map((choice) => (
          <Option
            key={choice.value}
            choice={choice}
            selected={choice.value === editor.value}
            onPick={() => onPick(choice.value)}
          />
        ))}
      </div>
      {editor.other ? (
        <div className="border-t border-border px-0.5 pt-1.5">
          <TypedValue label={editor.other.label} initial="" placeholder={editor.other.placeholder} mono={editor.other.mono} onCommit={onPick} />
        </div>
      ) : null}
    </div>
  );
}

/** A free value: Enter writes it, Escape closes the editor without a write. */
function TypedValue({ label, initial, placeholder, mono, onCommit }: {
  label: string;
  initial: string;
  placeholder?: string;
  mono?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <div className="relative flex min-w-56 items-center">
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        enterKeyHint="done"
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          onCommit(draft.trim());
        }}
        className={cn(fieldClass, "w-full pe-8", mono && "font-mono text-xs")}
      />
      <CornerDownLeft aria-hidden className="pointer-events-none absolute end-2 size-3.5 text-muted-foreground" />
    </div>
  );
}

function DateEditor({ label, editor, onPick }: {
  label: string;
  editor: Extract<FactEditor, { kind: "date" }>;
  onPick: (value: string) => void;
}) {
  const [draft, setDraft] = useState(editor.value);
  const presets = editor.presets ?? [];
  return (
    <div className="flex flex-col gap-1">
      {presets.length > 0 || (editor.value !== "" && editor.clearLabel) ? (
        <div role="listbox" aria-label={label} className="flex flex-col" onKeyDown={roveOptions}>
          {presets.map((preset) => (
            <Option
              key={preset.value}
              choice={{ value: preset.value, label: preset.label, mark: undefined }}
              selected={preset.value === editor.value}
              onPick={() => onPick(preset.value)}
            />
          ))}
          {editor.value !== "" && editor.clearLabel ? (
            <Option choice={{ value: "", label: editor.clearLabel }} selected={false} onPick={() => onPick("")} />
          ) : null}
        </div>
      ) : null}
      <div className="border-t border-border px-0.5 pt-1.5">
        <input
          type="date"
          aria-label="Date"
          value={draft}
          enterKeyHint="done"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (draft !== "") onPick(draft);
          }}
          className={cn(fieldClass, "w-full tabular-nums")}
        />
      </div>
    </div>
  );
}
