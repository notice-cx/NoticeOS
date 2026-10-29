import { useId, useState } from "react";
import type { JsonValue, SettingOp } from "@shared/changeset";
import type { DashboardConfig } from "@shared/dashboard";
import {
  FOCUS_LIBRARY,
  VIEW_LIBRARY,
  WORKSPACE_VIEW_POINTER,
  viewSpec,
  normalizeViewId,
  type FocusId,
  type ViewChoice,
  type ViewId,
} from "@shared/views";
import { InlineSaveState, type InlineSave } from "@/components/InlineSaveState";
import { Button } from "@/components/ui/button";
import { pillChoiceClass, pillChoiceStateClass } from "@/components/ui/pill";
import { useConfigWritable } from "@/hooks/useConfigWritable";
import { useFieldConfigSave, type FieldUndoOutcome } from "@/hooks/useConfigSave";
import { useView } from "@/hooks/useView";
import { cn } from "@/lib/utils";
import { PanelLock, SettingsPanel } from "@/routes/settings/SettingsPanel";

/**
 * Settings → General's "Your view": the person's own choice of view and what
 * matters most, kept per person in a hosted workspace and in this browser
 * otherwise, saved on each change with Undo beside it, and the workspace's
 * default, a config document only a writable store can change. The view decides what is drawn first, never
 * what exists: Search lists every page in every view.
 */
export function ViewPanel({ dashboard }: { dashboard: DashboardConfig }) {
  return (
    <SettingsPanel id="view" title="Your view" data-settings-view>
      <ViewChoiceRow />
      <FocusRow />
      <WorkspaceDefaultRow dashboard={dashboard} />
    </SettingsPanel>
  );
}

/** One row of the panel, divided from the next by a hairline. */
const ROW = "flex flex-col gap-2 border-b border-border py-3 first:pt-1 last:border-0 last:pb-0";

/**
 * A save of the person's own choice: the screens change at once, and Undo puts
 * back what was stored before, or forgets the choice when nothing was, so the
 * workspace default applies again.
 */
function useChoiceSave() {
  const { choice, source, setChoice, clearChoice } = useView();
  const [save, setSave] = useState<InlineSave>({ state: "idle" });
  function commit(next: ViewChoice) {
    const before = source === "person" ? choice : null;
    setChoice(next);
    setSave({
      state: "saved",
      onUndo: () => {
        if (before) setChoice(before);
        else clearChoice();
        setSave({ state: "idle" });
      },
    });
  }
  return { choice, save, commit };
}

function ViewChoiceRow() {
  const name = useId();
  const { choice, save, commit } = useChoiceSave();
  return (
    <div className={ROW}>
      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="sr-only">What do you want to focus on?</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {VIEW_LIBRARY.map((spec) => {
            const checked = spec.id === choice.view;
            return (
              <label
                key={spec.id}
                data-view-option={spec.id}
                data-checked={checked || undefined}
                className={cn(
                  "flex cursor-pointer flex-col gap-1 rounded-md border px-3 py-2 transition-colors",
                  "has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring",
                  pillChoiceStateClass(checked),
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={spec.id}
                  checked={checked}
                  onChange={() => commit({ view: spec.id, focus: choice.focus })}
                  className="sr-only"
                />
                <span className={cn("text-sm font-medium", checked ? "text-primary" : "text-foreground")}>
                  {spec.label}
                </span>
                <span className="text-xs leading-snug text-muted-foreground">{spec.detail}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <InlineSaveState save={save} subject="field:Your view" className="self-start" />
    </div>
  );
}

/** The picks in the order they were made, as their labels. */
function focusLabels(focus: readonly FocusId[]): string {
  const labels = focus.map((id) => FOCUS_LIBRARY.find((spec) => spec.id === id)?.label).filter(Boolean);
  return labels.length > 0 ? labels.join(" · ") : "Nothing picked";
}

function FocusRow() {
  const { choice, save, commit } = useChoiceSave();
  const [open, setOpen] = useState(false);
  function toggle(id: FocusId) {
    const focus = choice.focus.includes(id) ? choice.focus.filter((one) => one !== id) : [...choice.focus, id];
    commit({ view: choice.view, focus });
  }
  return (
    <div className={ROW} data-settings-focus>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">At the top of Home</span>
          <span className="text-xs text-muted-foreground" data-focus-value>
            {focusLabels(choice.focus)}
          </span>
        </div>
        <Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Done" : "Change"}
        </Button>
      </div>
      {open ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="What matters most?">
          {FOCUS_LIBRARY.map((spec) => {
            const picked = choice.focus.includes(spec.id);
            return (
              <button
                key={spec.id}
                type="button"
                aria-pressed={picked}
                data-focus-option={spec.id}
                title={spec.detail}
                onClick={() => toggle(spec.id)}
                className={cn(pillChoiceClass, pillChoiceStateClass(picked))}
              >
                {spec.label}
              </button>
            );
          })}
        </div>
      ) : null}
      <InlineSaveState save={save} subject="field:At the top of Home" className="self-start" />
    </div>
  );
}

const TOWER_FILE = "config/tower.json";

/**
 * The view new people start from. One write of the whole document
 * at `/view`, guarded by what the settings read holds there (a refused saved
 * value included, so a fix saves over it), and Undo is that write reversed.
 */
function WorkspaceDefaultRow({ dashboard }: { dashboard: DashboardConfig }) {
  const { writable } = useConfigWritable();
  const saveField = useFieldConfigSave();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<
    | { kind: "saved"; undo: () => Promise<FieldUndoOutcome> }
    | { kind: "refused"; refusal: string }
    | null
  >(null);
  const [undoing, setUndoing] = useState(false);

  const saved = dashboard.view ? normalizeViewId(dashboard.view.default) : null;
  const expect: JsonValue = dashboard.view
    ? { default: dashboard.view.default }
    : ((dashboard.refused?.view?.saved as JsonValue | undefined) ?? null);

  async function choose(id: ViewId) {
    setPending(true);
    setOutcome(null);
    const op: SettingOp = {
      kind: "file-json-set",
      file: TOWER_FILE,
      pointer: WORKSPACE_VIEW_POINTER,
      expect,
      value: { default: id },
    };
    try {
      const result = await saveField({ ops: [op], slug: "view", label: "Workspace default" });
      if (result.saved) {
        setOutcome({ kind: "saved", undo: result.undo });
        setOpen(false);
      } else {
        setOutcome({ kind: "refused", refusal: result.refusal });
      }
    } finally {
      setPending(false);
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

  const save: InlineSave = pending
    ? { state: "saving" }
    : outcome?.kind === "saved"
      ? { state: "saved", undoing, onUndo: () => void undo() }
      : outcome?.kind === "refused"
        ? { state: "refused", refusal: outcome.refusal }
        : { state: "idle" };

  return (
    <div className={ROW} data-workspace-view={saved ?? "none"}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1 text-sm font-medium text-foreground">
            Workspace default · for new people
            {writable ? null : <PanelLock data-workspace-view-locked />}
          </span>
          <span className="text-xs text-muted-foreground" data-workspace-view-value>
            {viewSpec(saved ?? "overview").label}
          </span>
        </div>
        {writable ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={open}
            disabled={pending || undoing}
            onClick={() => setOpen(!open)}
            data-workspace-view-change
          >
            {open ? "Cancel" : "Change"}
          </Button>
        ) : null}
      </div>
      {writable && open ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Workspace default">
          {VIEW_LIBRARY.map((spec) => {
            const picked = spec.id === (saved ?? "overview");
            return (
              <button
                key={spec.id}
                type="button"
                aria-pressed={picked}
                disabled={pending || picked}
                data-workspace-view-option={spec.id}
                onClick={() => void choose(spec.id)}
                className={cn(pillChoiceClass, pillChoiceStateClass(picked))}
              >
                {spec.label}
              </button>
            );
          })}
        </div>
      ) : null}
      <InlineSaveState save={save} subject="field:Workspace default" className="self-start" />
    </div>
  );
}
