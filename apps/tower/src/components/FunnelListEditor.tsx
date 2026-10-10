import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { POSTHOG_FUNNEL_LIMITS, type PosthogFunnel } from "@noticeos/contract/configuration";
import type { SettingOp } from "@shared/changeset";
import { InlineSaveState, type InlineSave } from "@/components/InlineSaveState";
import { StateChip } from "@/components/StateChip";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { type FieldUndoOutcome, useConfigSave, useFieldConfigSave } from "@/hooks/useConfigSave";
import { useConfigWritable } from "@/hooks/useConfigWritable";
import { cn } from "@/lib/utils";

// Edits a list whose rows each hold their own ordered sub-list: a PostHog
// funnel is a name and 2-10 ordered steps, each an event optionally pinned to
// a page path. It buffers the whole list, judges it with the register field's
// own rule, and writes it as one `file-json-set`, so funnels are never
// half-saved and Undo restores the whole list.

interface DraftStep {
  event: string;
  path: string;
}
interface DraftFunnel {
  id: string;
  name: string;
  /** False until the operator types into the id box: until then the id
   * follows the name, so a new funnel needs no second thing typed. */
  idTouched: boolean;
  steps: DraftStep[];
}

export interface FunnelListEditorProps {
  label?: string;
  explain?: ReactNode;
  /** The asset whose page this lives on, for its data hook. */
  assetId?: string;
  /** The funnels the file holds now, or `null` when the key is absent. */
  current: readonly PosthogFunnel[] | null;
  /** The field's own rule: a sentence, or `null` when the list may be saved. */
  refusal: (value: unknown) => string | null;
  /** The op a Save writes for this list (it carries the guard). */
  makeOp: (value: PosthogFunnel[]) => SettingOp;
  /** Changeset slug and commit subject. */
  slug?: string;
  /** Write somewhere else — the component gallery passes a fake. */
  onSave?: (op: SettingOp) => Promise<void>;
  /**
   * The project's saved funnels, read from the connected account. Given, the
   * list is picked rather than typed and each change saves at once with Undo.
   * Absent (the account cannot be read), the typed editor is the way in.
   */
  saved?: readonly PosthogFunnel[];
}

function editableFunnels(funnels: readonly PosthogFunnel[] | null): DraftFunnel[] {
  return (funnels ?? []).map((funnel) => ({
    id: funnel.id,
    name: funnel.name,
    idTouched: true,
    steps: funnel.steps.map((step) => ({ event: step.event, path: step.path ?? "" })),
  }));
}

/** The draft as the file would hold it: trimmed, and an empty path left out. */
export function funnelsFromDraft(draft: readonly DraftFunnel[]): PosthogFunnel[] {
  return draft.map((funnel) => ({
    id: funnel.id.trim(),
    name: funnel.name.trim(),
    steps: funnel.steps.map((step) =>
      step.path.trim() === "" ? { event: step.event.trim() } : { event: step.event.trim(), path: step.path.trim() },
    ),
  }));
}

/** A short kebab-case id from a funnel's name. */
function idFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, POSTHOG_FUNNEL_LIMITS.idMaxLength);
}

export function FunnelListEditor({
  label = "Funnels",
  explain,
  assetId,
  current,
  refusal,
  makeOp,
  slug,
  onSave,
  saved: fromAccount,
}: FunnelListEditorProps) {
  const headingId = useId();
  const save = useConfigSave();
  const { writable, reason } = useConfigWritable();
  const readOnly = !onSave && !writable;
  const [draft, setDraft] = useState<DraftFunnel[]>(() => editableFunnels(current));
  const [saving, setSaving] = useState(false);
  const saved = useMemo(() => JSON.stringify(current ?? []), [current]);
  // A save elsewhere (or this one landing) replaces the draft with the file.
  useEffect(() => setDraft(editableFunnels(JSON.parse(saved) as PosthogFunnel[])), [saved]);

  const value = funnelsFromDraft(draft);
  const changed = JSON.stringify(value) !== saved;
  const problem = refusal(value);

  const update = (index: number, change: (funnel: DraftFunnel) => DraftFunnel) =>
    setDraft((funnels) => funnels.map((funnel, i) => (i === index ? change(funnel) : funnel)));
  const moveStep = (index: number, from: number, to: number) =>
    update(index, (funnel) => {
      const steps = [...funnel.steps];
      const [step] = steps.splice(from, 1);
      steps.splice(to, 0, step!);
      return { ...funnel, steps };
    });

  async function commit() {
    if (problem !== null || !changed) return;
    const op = makeOp(value);
    setSaving(true);
    try {
      if (onSave) await onSave(op);
      else await save({ ops: [op], label, slug });
    } finally {
      setSaving(false);
    }
  }

  if (readOnly) {
    return (
      <section className="flex flex-col gap-2 py-3" aria-labelledby={headingId} data-funnel-editor={assetId}>
        <h4 id={headingId} className="text-sm font-medium text-foreground">
          {label}
        </h4>
        {value.length === 0 ? (
          <p className="flex items-center gap-2">
            <StateChip tone="na" label="No funnels · report skipped" subject={`field:funnels:${assetId ?? ""}`} />
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs text-foreground">
            {value.map((funnel) => (
              <li key={funnel.id}>
                <span className="font-medium">{funnel.name}</span>{" "}
                <span className="font-mono text-muted-foreground">
                  {funnel.steps.map((step) => (step.path ? `${step.event} ${step.path}` : step.event)).join(" → ")}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs leading-snug text-muted-foreground" data-funnel-editor-read-only>
          {reason ?? "Settings cannot be saved right now."}
        </p>
      </section>
    );
  }

  if (fromAccount !== undefined) {
    return (
      <PickedFunnels
        headingId={headingId}
        label={label}
        assetId={assetId}
        current={current ?? []}
        saved={fromAccount}
        refusal={refusal}
        makeOp={makeOp}
        slug={slug}
        onSave={onSave}
      />
    );
  }

  const disabled = saving;
  return (
    <section className="flex flex-col gap-3 py-3" aria-labelledby={headingId} data-funnel-editor={assetId}>
      <div className="flex flex-col gap-0.5">
        <h4 id={headingId} className="text-sm font-medium text-foreground">
          {label}
        </h4>
        {explain ? <span className="text-xs leading-snug text-muted-foreground">{explain}</span> : null}
      </div>

      {/* The empty list as the state it causes, with Add funnel below as the way out. */}
      {draft.length === 0 ? (
        <p className="flex items-center gap-2" data-funnel-empty>
          <StateChip tone="na" label="No funnels · report skipped" subject={`field:funnels:${assetId ?? ""}`} />
        </p>
      ) : null}

      <ol className="flex flex-col gap-3">
        {draft.map((funnel, index) => (
          <li
            key={index}
            className="flex flex-col gap-2 rounded-md border border-border p-3"
            data-funnel={funnel.id || `new-${index + 1}`}
          >
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 basis-full flex-col gap-1 text-xs text-muted-foreground sm:basis-0 sm:flex-1">
                Funnel name
                <input
                  className={cn(fieldClass, "w-full")}
                  value={funnel.name}
                  disabled={disabled}
                  placeholder="Calculator"
                  onChange={(event) => {
                    const name = event.target.value;
                    update(index, (f) => ({ ...f, name, id: f.idTouched ? f.id : idFromName(name) }));
                  }}
                  data-funnel-name
                />
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground sm:w-40 sm:flex-none">
                Id
                <input
                  className={cn(fieldClass, "w-full font-mono text-xs")}
                  value={funnel.id}
                  disabled={disabled}
                  placeholder="calculator"
                  onChange={(event) => update(index, (f) => ({ ...f, id: event.target.value, idTouched: true }))}
                  data-funnel-id
                />
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => setDraft((funnels) => funnels.filter((_, i) => i !== index))}
                data-funnel-remove
              >
                <Trash2 aria-hidden />
                Remove funnel
              </Button>
            </div>

            <ol className="flex flex-col gap-2" aria-label={`Steps of ${funnel.name || "this funnel"}`}>
              {funnel.steps.map((step, stepIndex) => (
                <li key={stepIndex} className="flex flex-wrap items-center gap-2" data-funnel-step={stepIndex + 1}>
                  <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{stepIndex + 1}.</span>
                  {/* On a phone the event, the path and the controls take a
                      line each; from `sm` up they share one. */}
                  <input
                    className={cn(fieldClass, "min-w-0 flex-1 basis-[calc(100%-2rem)] font-mono text-xs sm:basis-0")}
                    value={step.event}
                    disabled={disabled}
                    placeholder="event name, e.g. $pageview"
                    aria-label={`Step ${stepIndex + 1} event`}
                    onChange={(event) =>
                      update(index, (f) => ({
                        ...f,
                        steps: f.steps.map((s, i) => (i === stepIndex ? { ...s, event: event.target.value } : s)),
                      }))
                    }
                    data-funnel-step-event
                  />
                  <input
                    className={cn(fieldClass, "ml-8 min-w-0 flex-1 basis-[calc(100%-2rem)] font-mono text-xs sm:ml-0 sm:basis-0")}
                    value={step.path}
                    disabled={disabled}
                    placeholder="page path (optional), e.g. /calculator"
                    aria-label={`Step ${stepIndex + 1} page path`}
                    onChange={(event) =>
                      update(index, (f) => ({
                        ...f,
                        steps: f.steps.map((s, i) => (i === stepIndex ? { ...s, path: event.target.value } : s)),
                      }))
                    }
                    data-funnel-step-path
                  />
                  <div className="ml-8 flex gap-1 sm:ml-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={disabled || stepIndex === 0}
                      aria-label={`Move step ${stepIndex + 1} up`}
                      onClick={() => moveStep(index, stepIndex, stepIndex - 1)}
                      data-funnel-step-up
                    >
                      <ArrowUp aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={disabled || stepIndex === funnel.steps.length - 1}
                      aria-label={`Move step ${stepIndex + 1} down`}
                      onClick={() => moveStep(index, stepIndex, stepIndex + 1)}
                      data-funnel-step-down
                    >
                      <ArrowDown aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={disabled}
                      aria-label={`Remove step ${stepIndex + 1}`}
                      onClick={() => update(index, (f) => ({ ...f, steps: f.steps.filter((_, i) => i !== stepIndex) }))}
                      data-funnel-step-remove
                    >
                      <X aria-hidden />
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || funnel.steps.length >= POSTHOG_FUNNEL_LIMITS.maxSteps}
                onClick={() => update(index, (f) => ({ ...f, steps: [...f.steps, { event: "", path: "" }] }))}
                data-funnel-add-step
              >
                <Plus aria-hidden />
                Add step
              </Button>
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || draft.length >= POSTHOG_FUNNEL_LIMITS.maxFunnels}
          onClick={() =>
            setDraft((funnels) => [
              ...funnels,
              { id: "", name: "", idTouched: false, steps: [{ event: "", path: "" }, { event: "", path: "" }] },
            ])
          }
          data-funnel-add
        >
          <Plus aria-hidden />
          Add funnel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={disabled || !changed || problem !== null}
          onClick={() => void commit()}
          data-funnel-save
        >
          {saving ? "Saving…" : "Save funnels"}
        </Button>
        {changed ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => setDraft(editableFunnels(current))}
            data-funnel-discard
          >
            Discard changes
          </Button>
        ) : null}
      </div>
      {changed && problem !== null ? (
        <p className="text-xs text-error" role="alert" data-funnel-problem>
          {problem}
        </p>
      ) : null}
    </section>
  );
}

/** One funnel's steps on one line: `$pageview /pricing → purchase`. */
function stepLine(funnel: PosthogFunnel): string {
  return funnel.steps.map((step) => (step.path ? `${step.event} ${step.path}` : step.event)).join(" → ");
}

/**
 * The funnels picked from the project's saved ones: defined once in PostHog,
 * chosen here, never retyped. Each change is one write of the whole list. A
 * funnel the project no longer holds stays listed and removable; the picker
 * offers only what is not on the list yet.
 */
function PickedFunnels({
  headingId,
  label,
  assetId,
  current,
  saved,
  refusal,
  makeOp,
  slug,
  onSave,
}: {
  headingId: string;
  label: string;
  assetId?: string;
  current: readonly PosthogFunnel[];
  saved: readonly PosthogFunnel[];
  refusal: (value: unknown) => string | null;
  makeOp: (value: PosthogFunnel[]) => SettingOp;
  slug?: string;
  onSave?: (op: SettingOp) => Promise<void>;
}) {
  const saveField = useFieldConfigSave();
  const [outcome, setOutcome] = useState<{ kind: "saved"; undo: () => Promise<FieldUndoOutcome> } | { kind: "refused"; refusal: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const onList = new Set(current.map((funnel) => funnel.id));
  const addable = saved.filter((funnel) => !onList.has(funnel.id));
  const full = current.length >= POSTHOG_FUNNEL_LIMITS.maxFunnels;

  async function write(next: PosthogFunnel[], what: string) {
    const problem = refusal(next);
    if (problem !== null) {
      setOutcome({ kind: "refused", refusal: problem });
      return;
    }
    const op = makeOp(next);
    setSaving(true);
    setOutcome(null);
    try {
      if (onSave) {
        await onSave(op);
        setOutcome({ kind: "saved", undo: async () => ({ undone: true }) });
      } else {
        const result = await saveField({ ops: [op], label: `${label}: ${what}`, slug });
        setOutcome(result.saved ? { kind: "saved", undo: result.undo } : { kind: "refused", refusal: result.refusal });
      }
    } finally {
      setSaving(false);
    }
  }

  async function undo() {
    if (outcome?.kind !== "saved") return;
    setUndoing(true);
    try {
      const back = await outcome.undo();
      setOutcome(back.undone ? null : { kind: "refused", refusal: back.refusal });
    } finally {
      setUndoing(false);
    }
  }

  const state: InlineSave = saving
    ? { state: "saving" }
    : outcome?.kind === "saved"
      ? { state: "saved", undoing, onUndo: () => void undo() }
      : outcome?.kind === "refused"
        ? { state: "refused", refusal: outcome.refusal }
        : { state: "idle" };
  return (
    <section className="flex flex-col gap-2 py-3" aria-labelledby={headingId} data-funnel-editor={assetId} data-funnel-mode="picked">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={headingId} className="text-sm font-medium text-foreground">
          {label}
        </h4>
        <InlineSaveState save={state} subject={`field:funnels:${assetId ?? ""}`} />
      </div>
      {current.length === 0 ? (
        <p className="flex items-center gap-2" data-funnel-empty>
          <StateChip tone="na" label="No funnels · report skipped" subject={`field:funnels:${assetId ?? ""}`} />
        </p>
      ) : (
        <ul className="flex flex-col overflow-hidden rounded-md border border-border">
          {current.map((funnel) => (
            <li key={funnel.id} className="flex min-h-11 items-center gap-3 border-t border-border px-3 py-1.5 first:border-t-0" data-funnel={funnel.id}>
              <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-3">
                <span className="truncate text-sm font-medium text-foreground">{funnel.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{stepLine(funnel)}</span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={saving || undoing}
                aria-label={`Remove funnel ${funnel.name}`}
                onClick={() => void write(current.filter((entry) => entry.id !== funnel.id), `${funnel.name} removed`)}
                data-funnel-remove
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {addable.length > 0 && !full ? (
        <select
          aria-label="Add funnel"
          className={cn(fieldClass, "h-11 max-w-full self-start sm:h-9")}
          value=""
          disabled={saving || undoing}
          onChange={(event) => {
            const funnel = addable.find((entry) => entry.id === event.target.value);
            if (funnel) void write([...current, funnel], `${funnel.name} added`);
          }}
          data-funnel-pick
        >
          <option value="">Add funnel</option>
          {addable.map((funnel) => (
            <option key={funnel.id} value={funnel.id}>
              {funnel.name}
            </option>
          ))}
        </select>
      ) : null}
    </section>
  );
}
