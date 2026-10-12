import { Check, History, Plus, Redo2, TriangleAlert, Undo2 } from "lucide-react";
import { StateChip } from "@/components/StateChip";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/** Which drawer the side of the editor shows. */
export type WallEditorPanel = "widget" | "add" | "versions";

export interface WallToolbarProps {
  dirty: boolean;
  /** Why the saved layout was refused, while nothing has replaced it. */
  replacing: string | null;
  /** Why the saved countdown was refused. */
  countdownRefused: string | null;
  onCountdown: () => void;
  refusal: string | null;
  warnings: string[];
  overflow: string | null;
  note: string;
  /** What the version will be called if no note is written. */
  summary: string | null;
  saving: boolean;
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  panel: WallEditorPanel;
  onPanel: (panel: WallEditorPanel) => void;
  /** How many saved versions there are to go back to. */
  versions: number;
  onNote: (value: string) => void;
  onSubmit: () => void;
  onDiscard: () => void;
}

/** ⌘ on a Mac, Ctrl elsewhere: the one modifier the shortcuts name. */
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform) ? "⌘" : "Ctrl+";

/**
 * The editor's one bar, above the television: Add a widget, Undo and Redo,
 * the saved versions, then the layout's state and Save. A refusal darkens
 * Save with the reason; a warning leaves it live. While the saved layout is
 * one the Tower refused, Save is live without a change, because saving the
 * default as drawn (or a Revert) is how the store gets a layout back.
 */
export function WallToolbar({
  dirty,
  replacing,
  countdownRefused,
  onCountdown,
  refusal,
  warnings,
  overflow,
  note,
  summary,
  saving,
  disabled,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  panel,
  onPanel,
  versions,
  onNote,
  onSubmit,
  onDiscard,
}: WallToolbarProps) {
  const notes = [...warnings, ...(overflow ? [overflow] : [])];
  const canSave = !disabled && (dirty || replacing !== null) && refusal === null && !saving;
  const state = dirty ? "unsaved" : replacing !== null ? "refused" : "saved";
  const toggle = (which: WallEditorPanel) => onPanel(panel === which ? "widget" : which);
  return (
    <div className="flex flex-col gap-2 border border-border bg-card p-2" data-wall-save-bar data-wall-toolbar>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant={panel === "add" ? "default" : "outline"}
          size="sm"
          aria-expanded={panel === "add"}
          aria-controls="wall-add-drawer"
          disabled={disabled}
          onClick={() => toggle("add")}
        >
          <Plus className="size-4" />
          Add a widget
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || !canUndo}
          onClick={onUndo}
          title={`Undo (${MOD}Z)`}
          aria-keyshortcuts="Meta+Z Control+Z"
        >
          <Undo2 className="size-4" />
          Undo
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || !canRedo}
          onClick={onRedo}
          title={`Redo (${MOD}Shift+Z)`}
          aria-keyshortcuts="Meta+Shift+Z Control+Shift+Z Control+Y"
        >
          <Redo2 className="size-4" />
          Redo
        </Button>
        <Button
          type="button"
          variant={panel === "versions" ? "default" : "ghost"}
          size="sm"
          aria-expanded={panel === "versions"}
          aria-controls="wall-versions-drawer"
          onClick={() => toggle("versions")}
        >
          <History className="size-4" />
          Versions
          <span className="tabular-nums opacity-70" data-wall-version-count>{versions}</span>
        </Button>

        {/* Below a desk's width the state and Save take a line of their own. */}
        <div className="flex min-w-0 basis-full flex-wrap items-center justify-end gap-1.5 lg:flex-1 lg:basis-auto lg:flex-nowrap">
          {/* The save's state in markup, as InlineSaveState draws a field's: the
              flow gate reads a Save as landed only when this says `saved` for
              wall:layout. */}
          <span className="shrink-0" data-save-state={state}>
            {state === "unsaved" ? (
              <StateChip label="Unsaved changes" tone="caution" subject="wall:layout" />
            ) : state === "refused" ? (
              <StateChip
                label="Saved layout refused"
                tone="critical"
                glyph={<TriangleAlert className="size-3" aria-hidden />}
                title={replacing ?? undefined}
                subject="wall:layout"
              />
            ) : (
              <StateChip
                label="On the TV"
                tone="affirmative"
                glyph={<Check className="size-3" aria-hidden />}
                subject="wall:layout"
              />
            )}
          </span>
          {countdownRefused !== null ? (
            <button
              type="button"
              className="shrink-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onCountdown}
              data-wall-countdown-refused
            >
              <StateChip
                label="Saved countdown refused"
                tone="critical"
                glyph={<TriangleAlert className="size-3" aria-hidden />}
                title={countdownRefused}
                subject="wall:countdown"
              />
            </button>
          ) : null}
          {dirty ? (
            <input
              type="text"
              aria-label="Version note"
              value={note}
              maxLength={200}
              disabled={disabled || saving}
              placeholder={summary ?? "Version note"}
              onChange={(event) => onNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (canSave) onSubmit();
              }}
              className={cn(fieldClass, "h-8 w-full min-w-0 flex-1 basis-40 lg:max-w-80")}
            />
          ) : null}
          <Button type="button" size="sm" disabled={!canSave} onClick={onSubmit}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={disabled || !dirty || saving} onClick={onDiscard}>
            Discard
          </Button>
        </div>
      </div>

      {refusal ? (
        <p className="px-1 text-xs leading-snug text-error" data-wall-refusal>
          {refusal}
        </p>
      ) : null}
      {/* Each warning is a state the TV will be in, drawn as a caution chip;
          its fix is on the TV or in the widget's settings. */}
      {notes.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-1">
          {notes.map((text) => (
            <span key={text} data-wall-warning>
              <StateChip label={text} tone="caution" subject="wall:layout" />
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
