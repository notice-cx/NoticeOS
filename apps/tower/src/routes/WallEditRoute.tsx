import { Check, TriangleAlert, Tv } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Link, useBlocker } from "react-router-dom";
import type { FileJsonSetOp, JsonValue } from "@shared/changeset";
import type { DashboardConfig } from "@shared/dashboard";
import {
  EMPTY_WALL_CONFIG,
  WALL_LAYOUT_POINTER,
  WALL_RETIRED_WARNING,
  parseWallConfig,
  wallLayoutWidgets,
  withRevertedWallLayout,
  withSavedWallLayout,
  type WallConfig,
} from "@shared/wall-layout";
import { PageHeader } from "@/components/PageHeader";
import { ReadFailed } from "@/components/ReadFailed";
import { StateChip } from "@/components/StateChip";
import { SavesPaused } from "@/components/SavesPaused";
import { SiteOrder } from './wall-edit/SiteOrder';
import { WallLibraryPanel } from "@/components/wall/WallLibraryPanel";
import { WallPreview } from "@/components/wall/WallPreview";
import { WallRowsPanel } from "@/components/wall/WallRowsPanel";
import { WallVersions } from "@/components/wall/WallVersions";
import { WallWidgetPanel } from "@/components/wall/WallWidgetPanel";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { useCalendarUpcoming } from "@/hooks/useCalendarUpcoming";
import { useConfigSave } from "@/hooks/useConfigSave";
import { useConfigWritable } from "@/hooks/useConfigWritable";
import { useConnections } from "@/hooks/useConnections";
import { useGa4Realtime } from "@/hooks/useGa4Realtime";
import { useNow } from "@/hooks/useNow";
import { useWall } from "@/hooks/useWall";
import { cn } from "@/lib/utils";
import {
  wallChangeSummary,
  wallEditorDirty,
  wallEditorReducer,
  wallEditorRefusal,
  wallEditorState,
  wallEditorWarnings,
  wallOverflowNote,
} from "@/lib/wall-editor";

/** The configuration document and the slug its save carries. */
const OWNER = "config/tower.json";
const SLUG = "wall-layout";

/**
 * What the store holds at `/wall`, and what the editor draws for it.
 *
 * The RAW value is the Save's `expect`, because the concurrency guard has to
 * compare against what is in the file rather than against a normalization of
 * it. The PARSED value is what the editor draws. A `config/tower.json` with no
 * layout saved carries `null` there or no `/wall` at all; the payload reads
 * both as none, so the guard is `null`, and the write lane takes `null` at a
 * declared document for "not saved yet" whichever way the store spells it
 * (`scripts/config-documents.mjs` `readsAsUnsaved`, bead `ro-nuz9`).
 *
 * A SAVED LAYOUT THE TOWER REFUSED (bead `ro-trai.45`) reaches this page as the
 * default drawn in its place, plus the versions saved with it that still read;
 * the value as stored rides beside it in `dashboard.refused.wall`, and that is
 * the guard — a Save built on the default and guarded by it would be refused
 * as "Changed elsewhere" by a store that never held the default.
 */
function readWallConfig(dashboard: DashboardConfig): {
  raw: JsonValue;
  config: WallConfig;
  refused: string | null;
} {
  const shown = (dashboard as { wall?: JsonValue }).wall ?? null;
  const refusedByStore = dashboard.refused?.wall ?? null;
  const raw = refusedByStore ? (refusedByStore.saved as JsonValue) : shown;
  try {
    return { raw, config: parseWallConfig(shown), refused: refusedByStore?.reason ?? null };
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
 * `/wall/edit` — the Wall is composed here (bead `ro-lzmq.2`, docs/15 flow D).
 *
 * IT IS A DESK PAGE, INSIDE THE SHELL. `/wall` stays the television: read-only,
 * outside the shell, with no edit affordance anywhere on it, which is flow D's
 * oldest rule and is pinned by a test. The two are reached from each other and
 * from nowhere else that could be pointed at a TV.
 *
 * THE PREVIEW IS THE RENDERER. `WallPreview` draws `WallCanvas` at 1920×1080
 * and scales it; there is no second layout engine, so what is arranged here is
 * what the television shows.
 *
 * SAVE IS ONE WRITE (D18). The whole layout plus its history is one value at one
 * pointer, so a save is a single `file-json-set` on `config/tower.json` at
 * `/wall`, guarded by the value the page was rendered from, through the same
 * `useConfigSave` every other setting uses — one guarded store write and
 * one Undo in the toast. A note is optional (bead `ro-ujb9.96.6.12`): with
 * none, the version is described by what changed (`wallChangeSummary`), so the
 * history still reads six weeks later and Save is one press.
 */
export function WallEditRoute() {
  const { data, isError, error, isFetching, refetch } = useWall();
  const upcoming = useCalendarUpcoming();
  const realtime = useGa4Realtime();
  const { credentials, items } = useConnections();
  const now = useNow(1_000);
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

  const dirty = wallEditorDirty(state);
  const refusal = wallEditorRefusal(state.layout);
  // A saved layout that named a retired widget is drawn as the default (bead
  // `ro-trai.11`): one chip says so until a Save replaces it.
  const warnings = [
    ...(config.retired?.replaced ? [WALL_RETIRED_WARNING] : []),
    ...wallEditorWarnings(state.layout),
  ];

  /**
   * The document this page just wrote, and the payload it wrote it over.
   *
   * After a Save the payload still carries the OLD document until its
   * refetch. Until a newer payload arrives, `saved` is what this page wrote:
   * the effect below must not put the operator's arrangement back the way it
   * was, and the NEXT Save or Revert builds on it and is guarded by it (bead
   * `ro-nuz9`) — built on the stale payload, a second Save inside that beat was
   * refused as "Changed elsewhere" by the operator's own first one. Any newer
   * payload is the store's answer and wins, an Undo from the toast included.
   */
  const [written, setWritten] = useState<{ over: WallConfig; config: WallConfig } | null>(null);
  const pending = written !== null && written.over === config ? written.config : null;
  const saved = pending ?? config;
  // The store holds a layout the Tower refused, and nothing this page wrote
  // has replaced it yet: the TV draws the default, and a Save — even of the
  // default as drawn — is what puts a readable layout back (bead `ro-trai.45`).
  const replacing = refused !== null && pending === null;

  // The payload polls every 60s. Adopting a layout that arrived while the
  // operator is mid-arrangement would delete their work under their hands, so a
  // new saved value is taken ONLY when there is nothing to lose.
  useEffect(() => {
    if (dirty || pending) return;
    dispatch({ type: "reset", layout: config.layout });
  }, [config.layout, dirty, pending]);

  const onMeasure = useCallback((height: number) => {
    setOverflow(wallOverflowNote(height));
  }, []);

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
      const landed = await save({ ops: [op], label, slug: SLUG });
      if (landed) setWritten({ over: config, config: next });
      return landed;
    },
    [config, pending, raw, save],
  );

  async function submit() {
    if (!(dirty || replacing) || refusal) return;
    // THE NOTE IS OPTIONAL (Grafana's save; docs/briefs/2026-09-23-ux-prior-art.md
    // #arrange-wall). With none, the version is described by what changed, so
    // the history still reads six weeks later without a question in the way.
    const words = note.trim() || wallChangeSummary(state.saved, state.layout);
    setSaving(true);
    const next = withSavedWallLayout(saved, state.layout, words, new Date().toISOString());
    const landed = await write(next, "TV layout").finally(() => setSaving(false));
    if (!landed) return;
    // The layout on screen IS the saved one now; saying so here means the Save
    // button goes quiet immediately rather than when the payload catches up.
    dispatch({ type: "saved", layout: state.layout });
    setNote("");
  }

  async function revert(index: number) {
    setReverting(index);
    const next = withRevertedWallLayout(saved, index, new Date().toISOString());
    const landed = await write(next, "TV layout").finally(() => setReverting(null));
    if (!landed) return;
    dispatch({ type: "reset", layout: next.layout });
  }

  const disabled = !writable || saving || reverting !== null;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-4 md:p-6">
      <LeaveGuard when={dirty} />
      {/* No description line: the save bar's state ("On the TV" / "Unsaved")
          is the fact it used to explain (bead `ro-ujb9.96.6.12`). */}
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
        // A failed first read is the desk's one failure state (bead
        // `ro-ujb9.242`), never a sentence of this page's own.
        isError ? (
          <ReadFailed title="Couldn't load the TV layout" subject="read:tv-layout" error={error} retrying={isFetching} onRetry={() => void refetch()} />
        ) : (
          <div className="grid min-h-[40vh] place-items-center text-sm text-muted-foreground">Loading…</div>
        )
      ) : (
        <>
          <SavesPaused />

          {/* Three panes on a wide screen, one column below it (D17's phone
              rule): the library, the television, and whatever is selected. The
              preview keeps the middle because it is the thing being changed. */}
          <div className="flex flex-col gap-4 xl:grid xl:grid-cols-[14rem_minmax(0,1fr)_19rem] xl:items-start">
            <WallLibraryPanel
              layout={state.layout}
              disabled={disabled}
              onAdd={(widget) => dispatch({ type: "add", widget })}
            />

            <div className="flex min-w-0 flex-col gap-4">
              <WallPreview
                layout={state.layout}
                data={data}
                meetings={upcoming.data}
                ga4Realtime={realtime.data}
                ga4RealtimeError={realtime.isError}
                connections={{ credentials, items }}
                nowMs={now}
                selectedId={state.selectedId}
                onSelect={(widgetId) => dispatch({ type: "select", widgetId })}
                onRemove={(widgetId) => dispatch({ type: "remove", widgetId })}
                onMove={(widgetId, toRowId, toIndex) =>
                  dispatch({ type: "move", widgetId, toRowId, toIndex })
                }
                onMeasure={onMeasure}
              />

              <SaveBar
                dirty={dirty}
                replacing={replacing ? refused : null}
                countdownRefused={countdownRefused?.reason ?? null}
                onCountdown={() => {
                  // The countdown's form is the strip's settings panel.
                  const strip = wallLayoutWidgets(state.layout).find((w) => w.type === "strip");
                  if (strip) dispatch({ type: "select", widgetId: strip.id });
                }}
                refusal={refusal}
                warnings={warnings}
                overflow={overflow}
                note={note}
                summary={dirty ? wallChangeSummary(state.saved, state.layout) : null}
                saving={saving}
                disabled={disabled}
                onNote={setNote}
                onSubmit={() => void submit()}
                onDiscard={() => {
                  setNote("");
                  dispatch({ type: "reset", layout: config.layout });
                }}
              />

              <WallRowsPanel
                layout={state.layout}
                disabled={disabled}
                onAddRow={() => dispatch({ type: "add-row" })}
                onRemoveRow={(rowId) => dispatch({ type: "remove-row", rowId })}
                onMoveRow={(rowId, direction) => dispatch({ type: "move-row", rowId, direction })}
                onFillRow={(rowId) => dispatch({ type: "fill-row", rowId })}
                onMove={(widgetId, toRowId, toIndex) =>
                  dispatch({ type: "move", widgetId, toRowId, toIndex })
                }
              />
              <SiteOrder assets={data.assets} disabled={!writable} />
            </div>

            <div className="flex min-w-0 flex-col gap-4">
              <WallWidgetPanel
                layout={state.layout}
                selectedId={state.selectedId}
                assets={data.assets}
                countdown={data.dashboard.countdown}
                countdownRefused={countdownRefused}
                nowMs={now}
                disabled={disabled}
                onSelect={(widgetId) => dispatch({ type: "select", widgetId })}
                onWidth={(widgetId, width) => dispatch({ type: "width", widgetId, width })}
                onSettings={(widgetId, settings) =>
                  dispatch({ type: "settings", widgetId, settings })
                }
                onNudge={(widgetId, direction) => dispatch({ type: "nudge", widgetId, direction })}
                onStack={(widgetId) => dispatch({ type: "stack", widgetId })}
                onRemove={(widgetId) => dispatch({ type: "remove", widgetId })}
              />
              <WallVersions
                history={saved.history}
                nowMs={now}
                reverting={reverting}
                disabled={disabled}
                onRevert={(index) => void revert(index)}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Save, and everything the operator should read before pressing it.
 *
 * ONE PRESS (bead `ro-ujb9.96.6.12`; docs/briefs/2026-09-23-ux-prior-art.md
 * #arrange-wall). Save used to open a second step — a "Why this layout" field
 * with a paragraph under it and a second "Save the layout" button. Grafana's
 * save takes an optional description and keeps versions as the safety net, and
 * so does this: the note field sits beside Save while there is something to
 * save, its placeholder is the change summary the version will carry if the
 * operator writes nothing, and Enter or Save writes.
 *
 * THE REFUSAL AND THE WARNINGS ARE DIFFERENT THINGS and are drawn as different
 * things: a refusal is the Wall saying it cannot draw this, so Save is dark and
 * the sentence is the reason; a warning is the Wall saying this is a poor idea,
 * so Save is live and the sentence is beside it. The fit note is a warning of
 * the same kind — it is the operator's television, and a measurement is not a
 * veto.
 *
 * A SAVED LAYOUT THE TOWER REFUSED IS THE SAVE'S STATE, not a paragraph above
 * the page (bead `ro-trai.45`): the chip that says "On the TV" says instead
 * that what is saved was refused, the validator's sentence on hover, and Save
 * is live without a change, because saving the default as drawn — or a Revert
 * to a version that still reads — is how the store gets a layout back. A
 * refused countdown is its own chip beside it, and takes the operator to the
 * strip's form that saves it.
 */
function SaveBar({
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
  onNote,
  onSubmit,
  onDiscard,
}: {
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
  onNote: (value: string) => void;
  onSubmit: () => void;
  onDiscard: () => void;
}) {
  const notes = [...warnings, ...(overflow ? [overflow] : [])];
  const canSave = !disabled && (dirty || replacing !== null) && refusal === null && !saving;
  const state = dirty ? "unsaved" : replacing !== null ? "refused" : "saved";
  return (
    <div className="flex flex-col gap-2 border border-border bg-card p-3" data-wall-save-bar>
      <div className="flex flex-wrap items-center gap-2">
        {/* The save's state in markup, as InlineSaveState draws a field's:
            the flow gate reads a Save as landed only when this says `saved`
            for wall:layout (bead `ro-nuz9`). */}
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
            className={cn(fieldClass, "min-w-0 flex-1 basis-48")}
          />
        ) : null}
        <Button type="button" disabled={!canSave} onClick={onSubmit}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" disabled={disabled || !dirty || saving} onClick={onDiscard}>
          Discard
        </Button>
      </div>

      {refusal ? (
        <p className="text-xs leading-snug text-error" data-wall-refusal>
          {refusal}
        </p>
      ) : null}
      {/* Each warning is a STATE the TV will be in, drawn as a caution chip
          (bead `ro-ujb9.96.6.17`); its fix is a control already on the page —
          a row's "Remaining height", the library's Add. */}
      {notes.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {notes.map((note) => (
            <span key={note} data-wall-warning>
              <StateChip label={note} tone="caution" subject="wall:layout" />
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Leaving with something unsaved asks first.
 *
 * TWO EXITS, TWO MECHANISMS. Navigating inside the desk is react-router's
 * blocker, which can actually stop and ask; closing the tab is the browser's
 * own `beforeunload`, which cannot be worded by us and only ever produces the
 * browser's generic prompt. Both are hung on the same one fact, so there is no
 * way out of this page that quietly drops an arrangement.
 *
 * It is a child component because `useBlocker` needs a data router, and this
 * keeps the whole route out of that dependency.
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
