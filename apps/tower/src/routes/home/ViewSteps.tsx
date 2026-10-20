import { useCallback, useId, useState, type CSSProperties } from "react";
import type { SettingOp } from "@shared/changeset";
import { FOCUS_LIBRARY, VIEW_LIBRARY, WORKSPACE_VIEW_POINTER, type FocusId, type ViewId } from "@shared/views";
import { Button } from "@/components/ui/button";
import { pillChoiceStateClass, pillControlClass } from "@/components/ui/pill";
import { useFieldConfigSave } from "@/hooks/useConfigSave";
import { useConfigWritable } from "@/hooks/useConfigWritable";
import { useView } from "@/hooks/useView";
import { cn } from "@/lib/utils";

/** One option's box: a 44 px target at least, its label over its detail. */
const optionBox = cn(
  "flex h-full min-h-11 w-full min-w-0 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-start",
  pillControlClass,
  "motion-safe:transition-colors",
);

const grid = "m-0 grid list-none gap-2 p-0";

/**
 * The two questions above the first run's steps: which view describes the
 * person, then, unless they picked Everything, what matters most. Drawn until
 * the person has a choice of their own; ignoring them leaves the screens in
 * the workspace's view, so the site steps never wait on them.
 */
export function ViewQuestions() {
  const { source, workspaceDefault, setChoice } = useView();
  const saveWorkspaceDefault = useWorkspaceViewDefault(workspaceDefault);
  // The view picked here while its focus question is open: picking stores the
  // choice at once, so the stored source alone would end the block early.
  const [picked, setPicked] = useState<ViewId | null>(null);
  const headingId = useId();

  if (picked === null && source === "person") return null;

  function pickView(view: ViewId) {
    setChoice({ view, focus: [] });
    saveWorkspaceDefault(view);
    // Everything draws every module already, so there is nothing to put first.
    if (view !== "everything") setPicked(view);
  }

  function finish(view: ViewId, focus: FocusId[]) {
    setChoice({ view, focus });
    setPicked(null);
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-foreground/40 p-4"
      data-first-run-question={picked === null ? "view" : "focus"}
    >
      <h3 id={headingId} className="m-0 text-sm font-semibold text-foreground">
        {picked === null ? "Which describes you?" : "What matters most?"}
      </h3>
      {picked === null ? (
        <ViewChoices onPick={pickView} labelledBy={headingId} />
      ) : (
        <FocusChoices onDone={(focus) => finish(picked, focus)} labelledBy={headingId} />
      )}
    </section>
  );
}

/** The view question's options: one press per view. */
function ViewChoices({ onPick, labelledBy }: { onPick: (view: ViewId) => void; labelledBy: string }) {
  return (
    <ul className={cn(grid, "grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))]")} aria-labelledby={labelledBy}>
      {VIEW_LIBRARY.map((spec, index) => (
        <li key={spec.id} className="viz-arrive min-w-0" style={{ "--viz-i": index } as CSSProperties}>
          <button
            type="button"
            className={cn(optionBox, "border-border bg-card text-foreground hover:border-foreground/30 hover:bg-muted/60 active:bg-muted")}
            data-view-choice={spec.id}
            onClick={() => onPick(spec.id)}
          >
            <span className="text-sm font-medium">{spec.label}</span>
            <span className="text-xs text-muted-foreground">{spec.detail}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The focus question's options: any number of picks, kept in the order
 * picked, then Continue; Skip keeps none. */
function FocusChoices({ onDone, labelledBy }: { onDone: (focus: FocusId[]) => void; labelledBy: string }) {
  const [picked, setPicked] = useState<FocusId[]>([]);
  const toggle = (id: FocusId) =>
    setPicked((now) => (now.includes(id) ? now.filter((one) => one !== id) : [...now, id]));
  return (
    <div className="flex flex-col gap-3">
      <ul className={cn(grid, "grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))]")} aria-labelledby={labelledBy}>
        {FOCUS_LIBRARY.map((spec, index) => {
          const on = picked.includes(spec.id);
          return (
            <li key={spec.id} className="viz-arrive min-w-0" style={{ "--viz-i": index } as CSSProperties}>
              <button
                type="button"
                aria-pressed={on}
                className={cn(optionBox, pillChoiceStateClass(on))}
                data-focus-choice={spec.id}
                onClick={() => toggle(spec.id)}
              >
                <span className={cn("text-sm font-medium", !on && "text-foreground")}>{spec.label}</span>
                <span className="text-xs text-muted-foreground">{spec.detail}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" data-focus-continue="" onClick={() => onDone(picked)}>
          Continue
        </Button>
        <Button type="button" size="sm" variant="ghost" data-focus-skip="" onClick={() => onDone([])}>
          Skip
        </Button>
      </div>
    </div>
  );
}

/**
 * The first answer on a fresh install also becomes the workspace's default
 * view, which new people and the TV start from: one guarded write of
 * `config/tower.json` `/view`, only while none is saved and config can be
 * written. Its outcome is not shown and never holds back the person's own
 * choice, which is already stored.
 */
function useWorkspaceViewDefault(saved: ViewId | null): (view: ViewId) => void {
  const { writable } = useConfigWritable();
  const save = useFieldConfigSave();
  return useCallback(
    (view: ViewId) => {
      if (saved !== null || !writable) return;
      const op: SettingOp = { kind: "file-json-set", file: "config/tower.json", pointer: WORKSPACE_VIEW_POINTER, expect: null, value: { default: view } };
      void save({ ops: [op], slug: "view", label: "View" }).catch(() => undefined);
    },
    [saved, writable, save],
  );
}
