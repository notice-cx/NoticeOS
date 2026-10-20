import { Tv } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Link, useBlocker } from "react-router-dom";
import type { FileJsonSetOp, JsonValue } from "@shared/changeset";
import type { DashboardConfig } from "@shared/dashboard";
import { siteDisplayOf } from "@shared/site-display";
import {
  EMPTY_WALL_CONFIG,
  WALL_LAYOUT_POINTER,
  WALL_PRESETS,
  WALL_RETIRED_WARNING,
  nextWallWidgetId,
  parseWallConfig,
  wallLayoutWidgets,
  withRevertedWallLayout,
  withSavedWallLayout,
  type WallConfig,
  type WallLayout,
  type WallWidgetType,
} from "@shared/wall-layout";
import { DEFAULT_VIEW } from "@shared/views";
import { PageHeader } from "@/components/PageHeader";
import { ReadFailed } from "@/components/ReadFailed";
import { PageSkeleton } from "@/components/Skeleton";
import { SavesPaused } from "@/components/SavesPaused";
import { SiteOrder } from "./wall-edit/SiteOrder";
import { WallLibraryPanel } from "@/components/wall/WallLibraryPanel";
import { WallPreview } from "@/components/wall/WallPreview";
import { WallToolbar, type WallEditorPanel } from "@/components/wall/WallToolbar";
import { WallVersions } from "@/components/wall/WallVersions";
import { WallWidgetPanel } from "@/components/wall/WallWidgetPanel";
import { Button } from "@/components/ui/button";
import { useCalendarUpcoming } from "@/hooks/useCalendarUpcoming";
import { calendarReadState } from "@/lib/meetings";
import { useConfigSave } from "@/hooks/useConfigSave";
import { useConfigWritable } from "@/hooks/useConfigWritable";
import { useConnections } from "@/hooks/useConnections";
import { useGa4Realtime } from "@/hooks/useGa4Realtime";
import { useNow } from "@/hooks/useNow";
import { useWall } from "@/hooks/useWall";
import {
  wallCanRedo,
  wallCanUndo,
  wallChangeSummary,
  wallDropPlan,
  wallEditorDirty,
  wallEditorReducer,
  wallEditorRefusal,
  wallEditorState,
  wallEditorWarnings,
  wallMovePlan,
  wallOverflowNote,
  wallWidgetWhere,
  type WallDragSource,
  type WallDropTarget,
  type WallMove,
} from "@/lib/wall-editor";

/** The configuration document and the slug its save carries. */
const OWNER = "config/tower.json";
const SLUG = "wall-layout";

/**
 * What the store holds at `/wall`, and what the editor draws for it. The raw
 * value is the Save's `expect`, because the concurrency guard compares against
 * what is in the file, not a normalization of it. No layout saved is `null`
 * whichever way the store spells it (`scripts/config-documents.mjs`
 * `readsAsUnsaved`). A saved layout the Tower refused reaches this page as the
 * default drawn in its place, with the value as stored in
 * `dashboard.refused.wall` as the guard: a Save guarded by the default would
 * be refused by a store that never held it. With nothing saved, the editor
 * starts from the workspace view's preset, as the TV draws it.
 */
export function readWallConfig(dashboard: DashboardConfig): {
  raw: JsonValue;
  config: WallConfig;
  refused: string | null;
} {
  const shown = (dashboard as { wall?: JsonValue }).wall ?? null;
  const refusedByStore = dashboard.refused?.wall ?? null;
  const raw = refusedByStore ? (refusedByStore.saved as JsonValue) : shown;
  try {
    const config = shown === null
      ? { layout: WALL_PRESETS[dashboard.view?.default ?? DEFAULT_VIEW], history: [] }
      : parseWallConfig(shown);
    return { raw, config, refused: refusedByStore?.reason ?? null };
  } catch (err) {
    // The Worker has read it already, so this is the belt: a layout that
    // reached the browser undrawable is named rather than replaced with a
    // default that would then be saved OVER the operator's file unguarded.
    return {
      raw,
      config: EMPTY_WALL_CONFIG,
      refused: err instanceof Error ? err.message : "The saved layout could not be read.",
    };
  }
}

/**
 * `/wall/edit`: the Wall's editor. The television is the stage (`WallCanvas`
 * at 1920×1080, scaled to the pane and the window): widgets are dragged and
 * dropped on it, its dividers resized, and every change can be undone. The
 * side shows the selected widget's settings, the Add drawer or the saved
 * versions. Save is one write: the layout plus its history is one value at one
 * pointer, through `useConfigSave`.
 */
export function WallEditRoute() {
  const { data, isError, error, isFetching, refetch } = useWall();
  const upcoming = useCalendarUpcoming();
  const realtime = useGa4Realtime();
  const { credentials, items } = useConnections();
  // The canvas ticks its own clock and countdown every second (WallSeconds);
  // everything else here reads in minutes, as on the TV.
  const now = useNow();
  const save = useConfigSave();
  const { writable } = useConfigWritable();

  const dashboard = data?.dashboard;
  const { raw, config, refused } = useMemo(
    () => (dashboard ? readWallConfig(dashboard) : { raw: null, config: EMPTY_WALL_CONFIG, refused: null }),
    [dashboard],
  );
  const countdownRefused = dashboard?.refused?.countdown ?? null;

  const [state, dispatch] = useReducer(wallEditorReducer, config.layout, wallEditorState);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [reverting, setReverting] = useState<number | null>(null);
  const [overflow, setOverflow] = useState<string | null>(null);
  const [panel, setPanel] = useState<WallEditorPanel>("widget");
  const [flashId, setFlashId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  /** The widget a change just moved or brought, and whether focus follows it. */
  const [landed, setLanded] = useState<{ widgetId: string; verb: string; focus: boolean } | null>(null);

  const dirty = wallEditorDirty(state);
  const refusal = wallEditorRefusal(state.layout);
  // A saved layout that named a retired widget is drawn as the default: one
  // chip says so until a Save replaces it.
  const warnings = [
    ...(config.retired?.replaced ? [WALL_RETIRED_WARNING] : []),
    ...wallEditorWarnings(state.layout),
  ];

  /**
   * The document this page just wrote, and the payload it wrote it over.
   * After a Save the payload still carries the old document until its
   * refetch, so until a newer payload arrives `saved` is what this page wrote:
   * the next Save or Revert builds on it and is guarded by it, or a second
   * Save inside that beat would be refused by the operator's own first one.
   * Any newer payload is the store's answer and wins.
   */
  const [written, setWritten] = useState<{ over: WallConfig; config: WallConfig } | null>(null);
  const pending = written !== null && written.over === config ? written.config : null;
  const saved = pending ?? config;
  // The store holds a layout the Tower refused, and nothing this page wrote
  // has replaced it yet: the TV draws the default, and a Save, even of the
  // default as drawn, is what puts a readable layout back.
  const replacing = refused !== null && pending === null;

  // The payload polls every 60s. Adopting a layout that arrived while the
  // operator is mid-arrangement would delete their work under their hands, so a
  // new saved value is taken ONLY when there is nothing to lose.
  useEffect(() => {
    if (dirty || pending) return;
    dispatch({ type: "reset", layout: config.layout });
  }, [config.layout, dirty, pending]);

  // After a move: say where the widget went, ring it briefly, and give focus
  // back to it when the change came from the keyboard or the Move menu.
  useEffect(() => {
    if (!landed) return;
    const place = wallWidgetWhere(state.layout, landed.widgetId);
    if (place) setAnnouncement(`${place.label} ${landed.verb} ${place.where}`);
    setFlashId(landed.widgetId);
    if (landed.focus) {
      document.querySelector<HTMLElement>(`[data-wall-edit-widget="${landed.widgetId}"]`)?.focus({ preventScroll: true });
    }
    setLanded(null);
    const clear = window.setTimeout(() => setFlashId(null), 900);
    return () => window.clearTimeout(clear);
  }, [landed, state.layout]);

  const disabled = !writable || saving || reverting !== null;

  const undo = useCallback(() => {
    dispatch({ type: "undo" });
    setAnnouncement("Undone");
  }, []);
  const redo = useCallback(() => {
    dispatch({ type: "redo" });
    setAnnouncement("Redone");
  }, []);

  // ⌘Z and ⇧⌘Z (Ctrl on other systems) anywhere on the page but in a field,
  // where they keep undoing the typing.
  useEffect(() => {
    if (disabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled, undo, redo]);

  const onMeasure = useCallback((height: number) => {
    setOverflow(wallOverflowNote(height));
  }, []);

  const select = (widgetId: string | null) => {
    dispatch({ type: "select", widgetId });
    if (widgetId) setPanel("widget");
  };

  const drop = (source: WallDragSource, target: WallDropTarget) => {
    const plan = wallDropPlan(state.layout, source, target);
    if (!plan) return;
    dispatch({ type: "drop", source, target });
    setPanel("widget");
    setLanded({ widgetId: plan.widgetId, verb: source.kind === "new" ? "added to" : "moved to", focus: false });
  };

  const move = (widgetId: string, how: WallMove) => {
    if (!wallMovePlan(state.layout, widgetId, how)) return;
    dispatch({ type: "move", widgetId, move: how });
    setLanded({ widgetId, verb: "moved to", focus: true });
  };

  const add = (widget: WallWidgetType) => {
    const id = nextWallWidgetId(state.layout, widget);
    dispatch({ type: "add", widget });
    setPanel("widget");
    setLanded({ widgetId: id, verb: "added to", focus: false });
  };

  const start = (layout: WallLayout, label: string) => {
    dispatch({ type: "replace", layout });
    setAnnouncement(`Started from ${label}`);
  };

  const remove = (widgetId: string) => {
    const place = wallWidgetWhere(state.layout, widgetId);
    dispatch({ type: "remove", widgetId });
    if (place) setAnnouncement(`${place.label} removed`);
  };

  const write = useCallback(
    async (next: WallConfig, label: string) => {
      const op: FileJsonSetOp = {
        kind: "file-json-set",
        file: OWNER,
        pointer: WALL_LAYOUT_POINTER,
        // The guard compares against what the store holds: what this page just
        // wrote, else what it read. A saved layout naming a retired widget
        // reaches this page as the default drawn in its place, so the value as
        // saved rides beside it (`retired.saved`); a refused one's is `raw`.
        expect: pending
          ? (pending as unknown as JsonValue)
          : config.retired
            ? (config.retired.saved as JsonValue)
            : raw,
        value: next as unknown as JsonValue,
      };
      const landedSave = await save({ ops: [op], label, slug: SLUG });
      if (landedSave) setWritten({ over: config, config: next });
      return landedSave;
    },
    [config, pending, raw, save],
  );

  async function submit() {
    if (!(dirty || replacing) || refusal) return;
    // With no note, the version is described by what changed.
    const words = note.trim() || wallChangeSummary(state.saved, state.layout);
    setSaving(true);
    const next = withSavedWallLayout(saved, state.layout, words, new Date().toISOString());
    const ok = await write(next, "TV layout").finally(() => setSaving(false));
    if (!ok) return;
    // The layout on screen IS the saved one now; saying so here means the Save
    // button goes quiet immediately rather than when the payload catches up.
    dispatch({ type: "saved", layout: state.layout });
    setNote("");
  }

  async function revert(index: number) {
    setReverting(index);
    const next = withRevertedWallLayout(saved, index, new Date().toISOString());
    const ok = await write(next, "TV layout").finally(() => setReverting(null));
    if (!ok) return;
    dispatch({ type: "reset", layout: next.layout });
  }

  return (
    <div className="mx-auto flex w-full max-w-[1760px] flex-col gap-3 p-4 md:p-6">
      <LeaveGuard when={dirty} />
      {/* No description line: the toolbar's state ("On the TV" / "Unsaved")
          is the fact. */}
      <PageHeader
        title="TV layout"
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/wall">
              <Tv className="size-4" />
              Open the TV
            </Link>
          </Button>
        }
      />

      {!data ? (
        // A failed first read is the desk's one failure state, never a
        // sentence of this page's own.
        isError ? (
          <ReadFailed title="Couldn't load the TV layout" subject="read:tv-layout" error={error} retrying={isFetching} onRetry={() => void refetch()} />
        ) : (
          <PageSkeleton subject="read:tv-layout" shape="board" />
        )
      ) : (
        <>
          <SavesPaused />

          <WallToolbar
            dirty={dirty}
            replacing={replacing ? refused : null}
            countdownRefused={countdownRefused?.reason ?? null}
            onCountdown={() => {
              // The countdown's form is the strip's settings panel.
              const strip = wallLayoutWidgets(state.layout).find((w) => w.type === "strip");
              if (strip) select(strip.id);
            }}
            refusal={refusal}
            warnings={warnings}
            overflow={overflow}
            note={note}
            summary={dirty ? wallChangeSummary(state.saved, state.layout) : null}
            saving={saving}
            disabled={disabled}
            canUndo={wallCanUndo(state)}
            canRedo={wallCanRedo(state)}
            onUndo={undo}
            onRedo={redo}
            panel={panel}
            onPanel={setPanel}
            versions={saved.history.length}
            onNote={setNote}
            onSubmit={() => void submit()}
            onDiscard={() => {
              setNote("");
              dispatch({ type: "discard" });
            }}
          />

          {/* The television and the side, one column below a wide screen. */}
          <div className="flex flex-col gap-4 xl:grid xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start" data-wall-editor>
            <WallPreview
              layout={state.layout}
              data={data}
              meetings={upcoming.data}
              calendarState={calendarReadState(upcoming)}
              ga4Realtime={realtime.data}
              ga4RealtimeError={realtime.isError}
              connections={{ credentials, items }}
              nowMs={now}
              selectedId={state.selectedId}
              onSelect={select}
              onRemove={remove}
              onDrop={drop}
              onMove={move}
              onWidths={(widths, gesture) => dispatch({ type: "widths", widths, gesture })}
              onSizes={(sizes, gesture) => dispatch({ type: "sizes", sizes, gesture })}
              flashId={flashId}
              disabled={disabled}
              fitHeight
              onMeasure={onMeasure}
            />

            <div className="flex min-w-0 flex-col gap-4" data-wall-side>
              {panel === "add" ? (
                <WallLibraryPanel
                  layout={state.layout}
                  disabled={disabled}
                  onAdd={add}
                  onStart={start}
                  onClose={() => setPanel("widget")}
                />
              ) : panel === "versions" ? (
                <WallVersions
                  history={saved.history}
                  nowMs={now}
                  reverting={reverting}
                  disabled={disabled}
                  onRevert={(index) => void revert(index)}
                  onClose={() => setPanel("widget")}
                />
              ) : (
                <WallWidgetPanel
                  layout={state.layout}
                  selectedId={state.selectedId}
                  assets={data.assets}
                  display={siteDisplayOf(data)}
                  countdown={data.dashboard.countdown}
                  countdownRefused={countdownRefused}
                  nowMs={now}
                  disabled={disabled}
                  onSelect={select}
                  onSettings={(widgetId, settings) => dispatch({ type: "settings", widgetId, settings })}
                  onWidths={(widths) => dispatch({ type: "widths", widths })}
                  onSizes={(sizes) => dispatch({ type: "sizes", sizes })}
                  onHeight={(rowId, height) => dispatch({ type: height, rowId })}
                  onMove={move}
                  onRemove={remove}
                />
              )}
              <SiteOrder assets={data.assets} disabled={!writable} />
            </div>
          </div>
          {/* Where a move put the widget, for a screen reader; the ring on
              the TV says it to the eye. */}
          <p role="status" aria-live="polite" className="sr-only" data-status-for="readout:wall-arrange">
            {announcement}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Leaving with something unsaved asks first: react-router's blocker inside the
 * desk, the browser's `beforeunload` when the tab closes. A child component
 * because `useBlocker` needs a data router; this keeps the route free of it.
 */
function LeaveGuard({ when }: { when: boolean }) {
  const blocker = useBlocker(when);

  useEffect(() => {
    if (!when) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [when]);

  useEffect(() => {
    if (blocker.state !== "blocked") return;
    // One question, in the browser's own dialog: this page has no modal of its
    // own and inventing one for a two-way question would be a component the
    // registry has nothing like and nowhere else to use.
    const leave = window.confirm("Leave without saving the TV layout?");
    if (leave) blocker.proceed();
    else blocker.reset();
  }, [blocker]);

  return null;
}

export default WallEditRoute;
