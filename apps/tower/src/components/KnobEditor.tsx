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

/** How a knob is edited. Every type buffers a draft and commits it with Save:
 * one interaction model, and one moment where something is written.
 * A toggle option may carry a `tone` so the SELECTED segment carries the state's
 * meaning color+dot — the control IS the state display (doc 14 "one
 * representation per fact"), so there is no separate state chip. */
// `validate` returns the value to COMMIT, so its type is `JsonValue` rather
// than the control's input shape: a hand-written validator that narrows to a
// string or a number is still assignable, and a DECLARED field's validator
// (`validateRegisterField`, bead `ro-vu8d.4`) can hand back the number an
// `integer` column wants — or `null` for an optional field cleared away — from
// the same text box. Widened rather than split, so there is still one buffered
// input and one Save.
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
  /** The asset whose page this editor lives on (store ops + per-asset pull rows). */
  assetId?: string;
  /** Effective current value — becomes the op's `expect` (concurrency guard). */
  current: JsonValue;
  /** Display formatter for the value (used in the archive-facing op and, where
   * a control cannot show it, in the field's own copy). */
  format: (v: JsonValue) => string;
  /**
   * Build the op for a chosen value (bakes in file/pointer or asset/column +
   * expect).
   *
   * MAY BE MORE THAN ONE (2026-09-05, bead `ro-aodz`), because one setting is
   * not always one pointer: which entity owns an asset is stored as the asset's
   * id on that entity's list, so choosing a different entity takes it off one
   * row and puts it on another. Two ops in ONE changeset — an asset that left
   * one entity and never reached the other is a state nobody asked for — and
   * `useConfigSave` inverts each of them, so the Undo is still exact.
   *
   * An EMPTY array is a no-op: picking the value that is already saved writes
   * nothing rather than committing an identity change.
   */
  makeOp: (value: JsonValue) => SettingOp | SettingOp[];
  control: KnobControl;
  /** The changeset slug (and commit subject) for a file-owned knob. */
  slug?: string;
  /** Write the op somewhere else. The component gallery passes a fake, so the
   * demos are real controls that never touch the operator's repo. */
  onSave?: (op: SettingOp) => Promise<void>;
  /**
   * The buffered draft, as it changes — `null` while it is a value the field
   * itself refuses.
   *
   * For the one caller that must react BEFORE the Save: the alert-rule tuner
   * (bead `ro-u072`), whose whole job is docs/15 principle 1 — show what this
   * value would have done, then ask. It reads the draft rather than owning the
   * control, so there is still exactly one editable-setting component and one
   * Save behaviour in the Tower. It never changes what is written: only
   * {@link KnobEditorProps.makeOp} does that, and only on Save.
   */
  onDraft?: (value: JsonValue | null) => void;
  /**
   * The value that just LANDED — called only after the write lane confirmed it,
   * and never when the lane refused.
   *
   * The other caller that needs it is the alert-rule tuner (bead `ro-van6`),
   * which records `disposition='tune'` on the alert the panel was opened from.
   * That record has to follow the actual change: a flag marked tuned because a
   * Save was attempted would feed the false-positive rate with edits that never
   * happened. It is a notification and nothing more — it cannot change or
   * prevent what was written, which only {@link KnobEditorProps.makeOp} does.
   */
  onSaved?: (value: JsonValue) => void;
  /**
   * A select or toggle that saves the moment a value is picked — no Save
   * button. For a low-risk single field (the operator's timezone); money and
   * alert thresholds keep their explicit Save (GitLab Pajamas: never autosave
   * financial data). Either way the outcome is said beside the field.
   */
  autosave?: boolean;
  /**
   * Whether this field also SAYS why it cannot be saved when the deployment's
   * saves are paused (bead `ro-p8qq`). A page that states it once for every
   * editor on it (`SavesPaused`) passes `false`, and the field then shows only
   * its lock — the same fact under five fields was five statuses for one
   * subject on one screen (doc 21 principle 3b).
   */
  statesReadOnly?: boolean;
  className?: string;
}

/**
 * One EDITABLE setting (docs/15 principle 10 made two-way): the same label +
 * explainer + scope as KnobRow, plus a control and a Save.
 *
 * IT WRITES (since D18, bead `ro-pbzu.5`). Until 2026-09-04 this component
 * staged an op into a browser-local cart, and the operator exported it and ran
 * `pnpm config:apply` in a terminal to make anything happen — high-friction
 * pseudo-settings (doc 19 finding 18). Save now applies configuration documents
 * and asset columns through the database write lane (D22).
 *
 * ITS OUTCOME IS SAID BESIDE IT, EVERYWHERE (beads `ro-ujb9.96.6.3`,
 * `ro-ujb9.96.7.12`; D30). "Saved" and an Undo, or "Not saved" and why, next to
 * the control the operator just used (`InlineSaveState`, GitLab Pajamas —
 * docs/briefs/2026-09-23-inline-save.md#prior-art) rather than in a corner
 * toast. There is no other mode: every setting, present and future, gets the
 * same save, the same Undo and the same refusal for free. The way back is
 * that Undo — the same write reversed and guarded by the value just saved —
 * not a confirm before the fact (principle 5).
 *
 * A configuration store that is unavailable renders its fields disabled with
 * a lock, and — unless the page says it once for all of them — the reason.
 */
/** Whatever `makeOp` answered, as the list a Save writes. One op is the common
 * case and stays spelled as one at every call site. */
function opsOf(built: SettingOp | SettingOp[]): SettingOp[] {
  return Array.isArray(built) ? built : [built];
}

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
  // The outcome beside the field: the way back and the value it goes back to,
  // or the refusal the field says itself.
  const [outcome, setOutcome] = useState<
    | { kind: "saved"; undo: () => Promise<FieldUndoOutcome>; from: JsonValue }
    | { kind: "refused"; refusal: string }
    | null
  >(null);
  const [undoing, setUndoing] = useState(false);
  // What a save or its Undo just wrote, shown until the page's own read
  // catches up — without it the field would sit "unsaved" (or show the value
  // the operator just took away) for the second a refresh takes.
  const [landed, setLanded] = useState<{ value: JsonValue; while: JsonValue } | null>(null);
  const [generation, setGeneration] = useState(0);
  const shown = landed !== null && Object.is(landed.while, current) ? landed.value : current;
  // Once the read has moved, it is the truth again: the override is spent.
  useEffect(() => {
    if (landed !== null && !Object.is(landed.while, current)) setLanded(null);
  }, [current, landed]);

  // `every` rather than `[0]`: a setting whose current value writes NO op (the
  // entity an asset already belongs to) still needs the configuration store.
  const isFileKnob = opsOf(makeOp(current)).every((op) => op.kind === "file-json-set");
  // Asset columns have their own write lane; documents need a ready config store.
  const readOnly = isFileKnob && !writable;

  /** The one write: `useFieldConfigSave` (the config door and its audit), or
   * the gallery's fake writer, whose way back is the previous value handed to
   * the same writer and whose throw is a refusal — so every state is
   * demonstrable without touching the repo. */
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
        // Said beside the field, and nothing downstream hears of a change the
        // store does not hold.
        setOutcome({ kind: "refused", refusal: result.refusal });
        return false;
      }
      setOutcome({ kind: "saved", undo: result.undo, from });
      setLanded({ value, while: current });
      // Only what actually landed is announced: telling a watcher about a
      // refusal would have them record a change the store does not hold.
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
        // Refused (somebody else moved it since): said here, where the Undo was.
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
              // The page says why once (`SavesPaused`); the field shows the
              // state as a lock, and says it to a screen reader.
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
  /** Pick-to-save: a choice commits at once and there is no Save button. */
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

/** The Save every control shares: the same word, the same disabled rule (nothing
 * to write), and the same pending label, so "did that save?" never depends on
 * which kind of field it was. */
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
      {/* "Saving…" is said once, by the state beside the field. */}
      Save
    </Button>
  );
}

/** Toggle / select: pick, then Save. The control shows the pending choice, so
 * there is still one representation of the value (doc 14) — it is simply the
 * one the operator is about to write. */
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

  // The store or the file moved underneath us (a poll, a save elsewhere): the
  // field follows reality rather than holding a choice made against an old one.
  useEffect(() => {
    setDraft(current);
    onDraft?.(current);
  }, [current]);

  function choose(value: JsonValue) {
    setDraft(value);
    onDraft?.(value);
    if (!autosave || value === current) return;
    // Pick-to-save: the choice IS the commit. A refused one puts the field
    // back on the stored value rather than showing a choice nothing holds.
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
          // A select is as wide as its LONGEST option. The Google pickers list
          // "label — account (ref)" and grew to 1,039px on a 390px phone
          // (bead `ro-ujb9.79`); capped here the way the text box beside it
          // already is, the chosen option clips and the native list shows it whole.
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

/** A two-state segmented control (the sole state display for a boolean knob). The
 * SELECTED segment carries the state's meaning color + dot (doc 14) when a tone is
 * given, so no separate state chip is needed. */
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
            /* THE BOX IS ON THE CONTAINER, so a segment reads `ui/pill.ts`'s
               control contract and not its box (bead `ro-s4rg`): a border and a
               radius here would draw a second pill inside the one above. The
               contract is what it was missing — the floor `ro-md80` gave every
               `<Button>` never reached this hand-rolled control, so a toggle
               knob was 30px under a thumb on /settings and every asset page. */
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

/** Text / number / local-datetime editor: buffers a draft, validates on Save (or
 * Enter), shows the reason inline when invalid. Re-seeds from the current value
 * when it changes underneath. */
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
  /**
   * A STORED VALUE AS THE TEXT THIS INPUT SEEDS WITH — the parse's inverse, not
   * `String()` (bead `ro-hem5`).
   *
   * `validateRegisterField` behind a declared knob hands the draft to
   * `fieldFromDraft`, so what seeds the box has to be what that would read back.
   * `String()` agrees for a string, an enum, a date and an integer — every knob
   * declared in `scripts/config-registers.mjs` TODAY, which is why this was not
   * a live defect — and disagrees for every other declared type: a `string-list`
   * seeds `"a,b"` where the parse writes `"a, b"`, a boolean and an object seed
   * text the parse cannot round-trip at all. The failure would have been a row
   * saving something the operator never typed, on the first boolean or list knob
   * somebody declares.
   *
   * `datetime` keeps its own `toDraft`, which is a CONTROL format — what
   * `<input type="datetime-local">` will accept — rather than a value format.
   */
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
    // Local validation is unchanged by the write lane: a value the field knows
    // is wrong never becomes a request, let alone a commit.
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
      {/* Wraps only while an inline status is showing, so every toast-mode
          caller keeps the exact row it had. */}
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
            // A watcher hears the VALIDATED value, or `null` while the field
            // holds something it would refuse — so nothing downstream ever
            // renders a preview of a value that could not be saved.
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
