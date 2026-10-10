import { Lock } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import type { JsonValue, SettingOp } from "@shared/changeset";
import { fieldToDraft } from "@shared/config-registers";
import { InfoTooltip } from "@/components/InfoTooltip";
import { InlineSaveState, type InlineSave } from "@/components/InlineSaveState";
import { STATE_TONE, type StateTone } from "@/components/StateChip";
import { type FieldSaveOutcome, type FieldUndoOutcome, useFieldConfigSave } from "@/hooks/useConfigSave";
import { CONFIG_READ_ONLY_FALLBACK, useConfigWritable } from "@/hooks/useConfigWritable";
import type { Validated } from "@/lib/knob-validators";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { pillControlClass } from "@/components/ui/pill";
import { cn } from "@/lib/utils";

/** How a knob is edited. Every type buffers a draft and commits it with Save.
 * A toggle option may carry a `tone` so the selected segment is the state
 * display. `validate` returns the value to commit, so its type is `JsonValue`
 * rather than the control's input shape: a declared field's validator can hand
 * back a number, or `null` for an optional field cleared away, from a text box. */
export type KnobControl =
  | { type: "text"; validate: (raw: string) => Validated<JsonValue>; placeholder?: string; mono?: boolean }
  | { type: "number"; validate: (raw: string) => Validated<JsonValue>; step?: string; placeholder?: string }
  | {
      type: "datetime";
      validate: (raw: string) => Validated<string>;
      toDraft: (value: JsonValue) => string;
      min?: string;
      step?: string;
    }
  | { type: "select"; options: { value: string; label: string }[] }
  | {
      type: "toggle";
      onValue: JsonValue;
      offValue: JsonValue;
      onLabel: string;
      offLabel: string;
      onTone?: StateTone;
      offTone?: StateTone;
    };

export interface KnobEditorProps {
  label: string;
  explain?: ReactNode;
  /** Optional background help. Warnings, scope and instructions stay in explain. */
  help?: ReactNode;
  /** Portfolio-wide knobs say so plainly ("Applies to every asset"). */
  scopeNote?: string;
  /** The asset whose page this editor lives on. */
  assetId?: string;
  /** Effective current value; becomes the op's `expect` guard. */
  current: JsonValue;
  format: (v: JsonValue) => string;
  /**
   * Build the op(s) for a chosen value. More than one when a setting is more
   * than one pointer (moving an asset between entities' lists); all land in
   * one changeset and each is inverted for Undo. An empty array is a no-op.
   */
  makeOp: (value: JsonValue) => SettingOp | SettingOp[];
  control: KnobControl;
  /** The changeset slug (and commit subject) for a file-owned knob. */
  slug?: string;
  /** Write the op somewhere else; the component gallery passes a fake. */
  onSave?: (op: SettingOp) => Promise<void>;
  /** The buffered draft as it changes, `null` while the field refuses it. For
   * a caller that previews before the Save; it never changes what is written. */
  onDraft?: (value: JsonValue | null) => void;
  /** The value that landed: called only after the write lane confirmed it,
   * never on a refusal, so a watcher cannot record a change the store does not hold. */
  onSaved?: (value: JsonValue) => void;
  /** A select or toggle that saves the moment a value is picked, with no Save
   * button. Money and alert thresholds keep their explicit Save. */
  autosave?: boolean;
  /** Whether this field also says why it cannot be saved. A page that states
   * it once for every editor passes `false`, and the field shows only its lock. */
  statesReadOnly?: boolean;
  className?: string;
}

function opsOf(built: SettingOp | SettingOp[]): SettingOp[] {
  return Array.isArray(built) ? built : [built];
}

/**
 * One editable setting: label, explainer and scope as `KnobRow`, plus a
 * control and a Save. The outcome is said beside the control, with an Undo
 * that is the same write reversed and guarded by the value just saved. An
 * unavailable configuration store renders the field disabled with a lock.
 */
export function KnobEditor({
  label,
  explain,
  help,
  scopeNote,
  assetId,
  current,
  makeOp,
  control,
  slug,
  onSave,
  onDraft,
  onSaved,
  autosave = false,
  statesReadOnly = true,
  className,
}: KnobEditorProps) {
  const fieldId = useId();
  const saveField = useFieldConfigSave();
  const { writable, reason } = useConfigWritable();
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<
    | { kind: "saved"; undo: () => Promise<FieldUndoOutcome>; from: JsonValue }
    | { kind: "refused"; refusal: string }
    | null
  >(null);
  const [undoing, setUndoing] = useState(false);
  // What a save or its Undo just wrote, shown until the page's own read
  // catches up; otherwise the field would sit "unsaved" for the second a
  // refresh takes.
  const [landed, setLanded] = useState<{ value: JsonValue; while: JsonValue } | null>(null);
  const [generation, setGeneration] = useState(0);
  const shown = landed !== null && Object.is(landed.while, current) ? landed.value : current;
  useEffect(() => {
    if (landed !== null && !Object.is(landed.while, current)) setLanded(null);
  }, [current, landed]);

  // `every` rather than `[0]`: a setting whose current value writes no op
  // still needs the configuration store.
  const isFileKnob = opsOf(makeOp(current)).every((op) => op.kind === "file-json-set");
  // Asset columns have their own write lane; documents need a ready config store.
  const readOnly = isFileKnob && !writable;

  /** The one write, or the gallery's fake writer, whose way back is the
   * previous value handed to the same writer and whose throw is a refusal. */
  async function write(ops: SettingOp[], from: JsonValue): Promise<FieldSaveOutcome> {
    if (!onSave) return saveField({ ops, slug, label });
    try {
      for (const op of ops) await onSave(op);
    } catch (err) {
      return { saved: false, refusal: err instanceof Error ? err.message : "Could not save" };
    }
    return {
      saved: true,
      undo: async () => {
        for (const op of opsOf(makeOp(from))) await onSave(op);
        return { undone: true };
      },
    };
  }

  async function commit(value: JsonValue) {
    setSaving(true);
    setOutcome(null);
    try {
      const from = shown;
      const result = await write(opsOf(makeOp(value)), from);
      if (!result.saved) {
        setOutcome({ kind: "refused", refusal: result.refusal });
        return false;
      }
      setOutcome({ kind: "saved", undo: result.undo, from });
      setLanded({ value, while: current });
      // Only what actually landed is announced.
      onSaved?.(value);
      return true;
    } finally {
      setSaving(false);
    }
  }

  async function undo() {
    if (outcome?.kind !== "saved") return;
    setUndoing(true);
    try {
      const back = await outcome.undo();
      if (back.undone) {
        setLanded({ value: outcome.from, while: current });
        setOutcome(null);
        // The control re-seeds from the value put back, not from its own draft.
        setGeneration((n) => n + 1);
      } else {
        setOutcome({ kind: "refused", refusal: back.refusal });
      }
    } finally {
      setUndoing(false);
    }
  }

  const inlineSave: InlineSave = saving
    ? { state: "saving" }
    : outcome?.kind === "saved"
      ? { state: "saved", undoing, onUndo: () => void undo() }
      : outcome?.kind === "refused"
        ? { state: "refused", refusal: outcome.refusal }
        : { state: "idle" };

  return (
    <div
      className={cn(
        "flex flex-col gap-2 border-b border-border py-3 last:border-0",
        className,
      )}
      data-knob-editor={assetId ?? undefined}
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <label htmlFor={fieldId} className="text-sm font-medium text-foreground">
              {label}
            </label>
            {help ? <InfoTooltip label={`About ${label.toLowerCase()}`}>{help}</InfoTooltip> : null}
            {readOnly && !statesReadOnly ? (
              // The page says why once; the field shows the state as a lock.
              <span className="inline-flex items-center text-muted-foreground" data-knob-locked>
                <Lock aria-hidden className="size-3.5" />
                <span className="sr-only">Saves paused</span>
              </span>
            ) : null}
          </div>
          {explain ? (
            <span className="text-xs leading-snug text-muted-foreground">{explain}</span>
          ) : null}
          {scopeNote ? (
            <span className="text-xs font-medium text-muted-foreground">{scopeNote}</span>
          ) : null}
        </div>
      </div>

      <Control
        key={generation}
        fieldId={fieldId}
        control={control}
        current={shown}
        disabled={readOnly || saving || undoing}
        saving={saving}
        onCommit={commit}
        onDraft={onDraft}
        autosave={autosave}
        status={<InlineSaveState save={inlineSave} subject={`field:${assetId ?? "portfolio"}:${label}`} />}
      />
      {readOnly && statesReadOnly ? (
        <span className="text-xs leading-snug text-muted-foreground" data-knob-read-only>
          {reason ?? CONFIG_READ_ONLY_FALLBACK}
        </span>
      ) : null}
    </div>
  );
}

// --- the control renderers -------------------------------------------------
function Control({
  fieldId,
  control,
  current,
  disabled,
  saving,
  onCommit,
  onDraft,
  autosave,
  status,
}: {
  fieldId: string;
  control: KnobControl;
  current: JsonValue;
  disabled: boolean;
  saving: boolean;
  onCommit: (value: JsonValue) => Promise<boolean>;
  onDraft?: (value: JsonValue | null) => void;
  autosave: boolean;
  /** The inline save state, drawn after the Save button on the same row. */
  status: ReactNode;
}) {
  if (control.type === "toggle" || control.type === "select") {
    return (
      <ChoiceInput
        fieldId={fieldId}
        control={control}
        current={current}
        disabled={disabled}
        saving={saving}
        onCommit={onCommit}
        onDraft={onDraft}
        autosave={autosave}
        status={status}
      />
    );
  }
  return (
    <BufferedInput
      fieldId={fieldId}
      control={control}
      current={current}
      disabled={disabled}
      saving={saving}
      onCommit={onCommit}
      onDraft={onDraft}
      status={status}
    />
  );
}

/** The Save every control shares, dead until there is something to write. */
function SaveButton({
  dirty,
  saving,
  disabled,
  onClick,
}: {
  dirty: boolean;
  saving: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={disabled || saving || !dirty}
    >
      Save
    </Button>
  );
}

/** Toggle / select: pick, then Save. The control shows the pending choice. */
function ChoiceInput({
  fieldId,
  control,
  current,
  disabled,
  saving,
  onCommit,
  onDraft,
  autosave,
  status,
}: {
  fieldId: string;
  control: Extract<KnobControl, { type: "select" | "toggle" }>;
  current: JsonValue;
  disabled: boolean;
  saving: boolean;
  onCommit: (value: JsonValue) => Promise<boolean>;
  onDraft?: (value: JsonValue | null) => void;
  autosave: boolean;
  status: ReactNode;
}) {
  const [draft, setDraft] = useState<JsonValue>(current);

  // The value moved underneath us: the field follows reality.
  useEffect(() => {
    setDraft(current);
    onDraft?.(current);
  }, [current]);

  function choose(value: JsonValue) {
    setDraft(value);
    onDraft?.(value);
    if (!autosave || value === current) return;
    // A refused pick goes back to the stored value.
    void onCommit(value).then((landed) => {
      if (landed) return;
      setDraft(current);
      onDraft?.(current);
    });
  }

  const dirty = draft !== current;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {control.type === "toggle" ? (
        <Segmented
          options={[
            { value: control.onValue, label: control.onLabel, tone: control.onTone },
            { value: control.offValue, label: control.offLabel, tone: control.offTone },
          ]}
          value={draft}
          disabled={disabled}
          onChange={choose}
        />
      ) : (
        <select
          id={fieldId}
          value={String(draft)}
          disabled={disabled}
          onChange={(e) => choose(e.target.value)}
          // A select is as wide as its longest option; capped, the chosen
          // option clips and the native list shows it whole.
          className={cn(fieldClass, "min-w-0 max-w-full")}
        >
          {control.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {autosave ? null : (
        <SaveButton
          dirty={dirty}
          saving={saving}
          disabled={disabled}
          onClick={() => {
            void onCommit(draft);
          }}
        />
      )}
      {status}
    </div>
  );
}

/** A two-state segmented control, the sole state display for a boolean knob. */
function Segmented({
  options,
  value,
  disabled,
  onChange,
}: {
  options: { value: JsonValue; label: string; tone?: StateTone }[];
  value: JsonValue;
  disabled: boolean;
  onChange: (v: JsonValue) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border">
      {options.map((o, i) => {
        const active = o.value === value;
        const tone = o.tone ? STATE_TONE[o.tone] : null;
        return (
          <button
            key={String(o.value)}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            /* The box is on the container, so a segment takes `ui/pill.ts`'s
               control contract and not its box. */
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1 text-sm transition-colors disabled:opacity-60",
              pillControlClass,
              i > 0 && "border-l border-border",
              active
                ? tone
                  ? cn("font-medium", tone.chip)
                  : "bg-foreground/10 font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted",
            )}
            aria-pressed={active}
          >
            {active && tone ? (
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
            ) : null}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Text / number / local-datetime editor: buffers a draft, validates on Save
 * or Enter, re-seeds when the current value changes underneath. */
function BufferedInput({
  fieldId,
  control,
  current,
  disabled,
  saving,
  onCommit,
  onDraft,
  status,
}: {
  fieldId: string;
  control: Extract<KnobControl, { type: "text" | "number" | "datetime" }>;
  current: JsonValue;
  disabled: boolean;
  saving: boolean;
  onCommit: (value: JsonValue) => Promise<boolean>;
  onDraft?: (value: JsonValue | null) => void;
  status: ReactNode;
}) {
  // The seed is the parse's inverse (`fieldToDraft`), never `String()`: what
  // seeds the box must be what `fieldFromDraft` reads back. `datetime` keeps
  // its own `toDraft`, a control format for `<input type="datetime-local">`.
  const seed = (value: JsonValue) =>
    control.type === "datetime" ? control.toDraft(value) : fieldToDraft(value);
  const [draft, setDraft] = useState(() => seed(current));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(seed(current));
    setError(null);
    onDraft?.(current);
  }, [current]);

  function submit() {
    // A value the field knows is wrong never becomes a request.
    const result = control.validate(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    void onCommit(result.value);
  }

  const dirty = draft !== seed(current);

  return (
    <div className="flex flex-col gap-1">
      <div className={cn("flex items-center gap-2", status != null && "flex-wrap")}>
        <input
          id={fieldId}
          type={
            control.type === "number"
              ? "number"
              : control.type === "datetime"
                ? "datetime-local"
                : "text"
          }
          inputMode={control.type === "number" ? "decimal" : undefined}
          step={
            control.type === "number" || control.type === "datetime"
              ? control.step
              : undefined
          }
          min={control.type === "datetime" ? control.min : undefined}
          placeholder={control.type === "datetime" ? undefined : control.placeholder}
          value={draft}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
            // A watcher hears the validated value, or `null` while the field
            // holds something it would refuse.
            if (onDraft) {
              const parsed = control.validate(e.target.value);
              onDraft(parsed.ok ? parsed.value : null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          className={cn(
            fieldClass,
            "w-64 max-w-full",
            error ? "border-error" : "border-border",
            control.type === "text" && control.mono && "font-mono text-xs",
          )}
          aria-invalid={error ? true : undefined}
        />
        <SaveButton dirty={dirty} saving={saving} disabled={disabled} onClick={submit} />
        {status}
      </div>
      {error ? <span className="text-xs text-error">{error}</span> : null}
    </div>
  );
}
