/**
 * The Wall editor's state, with no DOM in it: every arrangement the operator
 * can make at `/wall/edit` is a pure function of a `WallLayout` and one
 * action. The preview is the real Wall renderer (`WallCanvas`), so this owns
 * how a layout is changed, never how it is drawn. The validator is not
 * reimplemented here: `validateWallLayout` is the one rule for "can the Wall
 * draw this". A drop or a move the Wall could not draw is refused before it
 * happens (its plan is null, so no landing line is drawn and no menu item is
 * offered); anything else that would leave a layout undrawable darkens Save
 * with the validator's own sentence.
 *
 * The grammar is a row of stacks. A top-level row holds slots side by side; a
 * slot is one widget, or a column stacking rows of widgets. Every move is a
 * drop: onto a widget's top or bottom edge (stack with it), its left or right
 * edge (a new column beside it), or a gap between rows (a new row). The Move
 * menu's items are the same drops, named, so a keyboard reaches every place a
 * pointer can.
 */

import {
  DEFAULT_WALL_LAYOUT,
  WALL_MAX_ROWS,
  WALL_MAX_WIDGETS_PER_ROW,
  WALL_PRESETS,
  WALL_TV_HEIGHT,
  WALL_WIDGET_LIBRARY,
  WALL_WIDGET_TYPES,
  WALL_WIDTH_MAX,
  WALL_WIDTH_MIN,
  WALL_WIDTH_STEP,
  isWallColumn,
  nextWallRowId,
  nextWallWidgetId,
  sameWallLayout,
  validateWallLayout,
  wallLayoutWarnings,
  wallLayoutWidgets,
  wallRowPlaces,
  type WallColumn,
  type WallColumnRow,
  type WallLayout,
  type WallRow,
  type WallSlot,
  type WallWidget,
  type WallWidgetSettings,
  type WallWidgetSpec,
  type WallWidgetType,
} from "@shared/wall-layout";
import { VIEW_LIBRARY, type ViewId } from "@shared/views";

export interface WallEditorState {
  /** What the operator is composing — what the preview draws. */
  layout: WallLayout;
  /** The layout the file holds. Discard restores it; dirty compares against it. */
  saved: WallLayout;
  /** Which widget the settings pane is for. */
  selectedId: string | null;
  /** Layouts Undo goes back to, oldest first. */
  past: WallLayout[];
  /** Layouts Redo goes forward to, nearest first. */
  future: WallLayout[];
  /** The gesture the last recorded change belonged to: a divider drag's many
   * steps are one Undo. */
  gesture: string | null;
}

/** What is being dragged: a widget on the Wall, or one from the Add drawer. */
export type WallDragSource =
  | { kind: "widget"; widgetId: string }
  | { kind: "new"; widget: WallWidgetType };

export type WallDropEdge = "top" | "bottom" | "left" | "right";

/**
 * Where a drag lands: an edge of a widget, or the gap before top-level row
 * `index` (`index` equal to the row count is the gap below the last row).
 */
export type WallDropTarget =
  | { kind: "widget"; widgetId: string; edge: WallDropEdge }
  /** The outer left or right edge of a top-level slot: a new column beside it. */
  | { kind: "slot"; slotId: string; edge: "left" | "right" }
  | { kind: "gap"; index: number };

/**
 * Where the landing line is drawn, on the layout as it is now: an edge of a
 * widget, of a top-level slot (a column), of a row (a column's row of several
 * widgets), or across a gap between rows.
 */
export type WallDropLine =
  | { anchor: "widget" | "slot" | "row"; id: string; edge: WallDropEdge }
  | { anchor: "gap"; index: number };

export interface WallDropPlan {
  /** The layout the drop produces, tidied. */
  layout: WallLayout;
  /** The widget that moved or arrived. */
  widgetId: string;
  line: WallDropLine;
}

/** The Move menu's items, each a drop with a name. */
export type WallMove =
  | "up"
  | "down"
  | "left"
  | "right"
  | "own-column"
  | "row-above"
  | "row-below"
  | { under: string };

export type WallEditorAction =
  /** Place a widget from the library at `wallAddTarget`'s spot. */
  | { type: "add"; widget: WallWidgetType }
  | { type: "remove"; widgetId: string }
  | { type: "select"; widgetId: string | null }
  | { type: "settings"; widgetId: string; settings: WallWidgetSettings | undefined }
  | { type: "transparency"; value: number; gesture?: string }
  /** A drag's landing, from the Wall or from the Add drawer. */
  | { type: "drop"; source: WallDragSource; target: WallDropTarget }
  /** One Move menu item, or its keyboard shortcut. */
  | { type: "move"; widgetId: string; move: WallMove }
  /** Widths by slot or widget id: a divider's drag or a size preset. */
  | { type: "widths"; widths: Record<string, number>; gesture?: string }
  /** Height weights by row id; null takes one off. */
  | { type: "sizes"; sizes: Record<string, number | null>; gesture?: string }
  /** This row takes the height its siblings leave; every sibling fits its content. */
  | { type: "fill"; rowId: string }
  /** This row fits its content. */
  | { type: "fit"; rowId: string }
  | { type: "undo" }
  | { type: "redo" }
  /** Back to the saved layout, as one more step Undo can take back. */
  | { type: "discard" }
  /** Start from another layout (a view's preset): one step Undo takes back,
   * unsaved until Save. */
  | { type: "replace"; layout: WallLayout }
  /** A newly saved layout arriving from the poll, or a Revert. */
  | { type: "reset"; layout: WallLayout }
  /** The write landed: what is on screen is now what the file holds. */
  | { type: "saved"; layout: WallLayout };

/** How many steps Undo keeps. */
export const WALL_UNDO_LIMIT = 100;

/** An explicit full-Wall arrangement retains each existing section's settings. */
export function wallFullComposition(layout: WallLayout): WallLayout {
  const settings = new Map(wallLayoutWidgets(layout).map((widget) => [widget.type, widget.settings]));
  const full = structuredClone(DEFAULT_WALL_LAYOUT);
  if (layout.tileTransparency !== undefined) full.tileTransparency = layout.tileTransparency;
  for (const widget of wallLayoutWidgets(full)) {
    const current = settings.get(widget.type);
    if (current !== undefined) widget.settings = structuredClone(current);
  }
  return full;
}

export function wallEditorState(saved: WallLayout): WallEditorState {
  return { layout: saved, saved, selectedId: null, past: [], future: [], gesture: null };
}

/** A width on the step grid, inside the bounds. Float addition drifts — a
 * quarter plus three steps is 0.39999999999999997 — and `isWallWidth` refuses
 * anything off the grid, so every arithmetic result comes back through here. */
export function roundWallWidth(value: number): number {
  const clamped = Math.min(WALL_WIDTH_MAX, Math.max(WALL_WIDTH_MIN, value));
  return Number((Math.round(clamped / WALL_WIDTH_STEP) * WALL_WIDTH_STEP).toFixed(2));
}

/** Where a widget sits. */
export interface WallWidgetPlace {
  /** Index of its row among its siblings: the layout's rows, or its column's. */
  rowIndex: number;
  /** Index among its row's slots. */
  index: number;
  row: WallRow | WallColumnRow;
  widget: WallWidget;
  /** The column it is stacked in and the top-level row holding that; null at the top. */
  column: WallColumn | null;
  parent: WallRow | null;
}

/** Where a widget sits, or null when the layout does not hold it. */
export function wallWidgetAt(layout: WallLayout, widgetId: string): WallWidgetPlace | null {
  for (const { row, index: rowIndex, column, parent } of wallRowPlaces(layout)) {
    const index = row.widgets.findIndex((w) => w.id === widgetId);
    const widget = row.widgets[index];
    if (widget && !isWallColumn(widget)) return { rowIndex, index, row, widget, column, parent };
  }
  return null;
}

/** A widget's place in the grammar of stacks. */
interface Spot {
  /** Its top-level row. */
  rowIndex: number;
  row: WallRow;
  /** The top-level slot holding it: itself, or its column. */
  slotIndex: number;
  slot: WallSlot;
  column: WallColumn | null;
  /** Its row inside the column, when it is in one. */
  innerIndex: number;
  inner: WallColumnRow | null;
  /** Its index among the widgets of its own row (the column's row, or the top-level row). */
  index: number;
  widget: WallWidget;
}

function spotOf(layout: WallLayout, widgetId: string): Spot | null {
  for (const [rowIndex, row] of layout.rows.entries()) {
    for (const [slotIndex, slot] of row.widgets.entries()) {
      if (!isWallColumn(slot)) {
        if (slot.id === widgetId) {
          return { rowIndex, row, slotIndex, slot, column: null, innerIndex: 0, inner: null, index: slotIndex, widget: slot };
        }
        continue;
      }
      for (const [innerIndex, inner] of slot.rows.entries()) {
        const index = inner.widgets.findIndex((w) => w.id === widgetId);
        const widget = inner.widgets[index];
        if (widget) return { rowIndex, row, slotIndex, slot, column: slot, innerIndex, inner, index, widget };
      }
    }
  }
  return null;
}

/**
 * Where a freshly added widget lands.
 *
 * The row taking the remaining height is the one that STRETCHES, so it is where
 * a widget designed for it belongs and the last place anything else should land
 * — a short widget in it gets stretched, and a tall one anywhere else gets
 * squeezed (`wallLayoutWarnings` says so out loud). Hence two passes: the
 * preferred kind of row first, any row with space after it, and only when
 * nothing has space does the layout grow a row. Within a kind it is the LAST
 * row, because an operator adding a widget expects it beside the ones already
 * there rather than on a new line.
 */
export function wallAddTarget(
  layout: WallLayout,
  type: WallWidgetType,
): { rowId: string; index: number } | { newRow: true } | null {
  const spec = WALL_WIDGET_LIBRARY[type];
  const hasRoom = (row: WallRow) => row.widgets.length < WALL_MAX_WIDGETS_PER_ROW;
  const lastWith = (predicate: (row: WallRow) => boolean) => {
    for (let i = layout.rows.length - 1; i >= 0; i -= 1) {
      const row = layout.rows[i];
      if (row && hasRoom(row) && predicate(row)) return { rowId: row.id, index: row.widgets.length };
    }
    return null;
  };
  const preferred = spec.prefersFill
    ? lastWith((row) => row.height === "fill")
    : lastWith((row) => row.height !== "fill");
  return preferred ?? lastWith(() => true) ?? (layout.rows.length < WALL_MAX_ROWS ? { newRow: true } : null);
}

export interface WallLibraryOption {
  spec: WallWidgetSpec;
  /** Why Add is not offered, as a STATE the row shows in place of the button —
   * "On the TV" or "TV full" — or null when it is offered. */
  disabledReason: string | null;
}

/** A one-of-a-kind widget that is already placed. */
export const WALL_WIDGET_PLACED = "On the TV";
/** Every row is at its widget limit and the Wall at its row limit. */
export const WALL_FULL = "TV full";

/**
 * The Add drawer's rows, in the contract's order. A refused Add shows why in
 * place of the button: "On the TV" for a one-of-a-kind widget already placed,
 * and "TV full" when every row holds `WALL_MAX_WIDGETS_PER_ROW` and there are
 * `WALL_MAX_ROWS`.
 */
export function wallLibraryOptions(layout: WallLayout): WallLibraryOption[] {
  const present = new Set(wallLayoutWidgets(layout).map((w) => w.type));
  return WALL_WIDGET_TYPES.map((type) => {
    const spec = WALL_WIDGET_LIBRARY[type];
    if (spec.unique && present.has(type)) return { spec, disabledReason: WALL_WIDGET_PLACED };
    if (wallAddTarget(layout, type) === null) return { spec, disabledReason: WALL_FULL };
    return { spec, disabledReason: null };
  });
}

/**
 * What changed between the saved layout and this one, in a few words: the
 * version's description when the operator writes no note. "Moved" means a
 * widget changed row, or changed place among the widgets its row kept; a
 * neighbour arriving or leaving does not move it. "Resized" covers its own
 * width, its column's width and its row's height.
 */
export function wallChangeSummary(before: WallLayout, after: WallLayout): string {
  if ((before.tileTransparency ?? 0) !== (after.tileTransparency ?? 0) && sameWallLayout({ ...before, tileTransparency: 0 }, { ...after, tileTransparency: 0 })) return `Tile transparency ${after.tileTransparency ?? 0}%`;
  // A layout that is exactly a view's preset was started from it.
  const preset = sameWallLayout(before, after) ? undefined : wallPresetOf(after);
  if (preset) return `Started from ${preset.label}`;
  /** Where a widget is: its top-level row, its column there (if any), its
   * order among that container's widgets, and the size it is given. */
  type Place = { widget: WallWidget; rowId: string; columnId: string | null; order: string[]; box: string };
  const places = (layout: WallLayout) => {
    const found = new Map<string, Place>();
    for (const row of layout.rows) {
      const plain = row.widgets.filter((slot): slot is WallWidget => !isWallColumn(slot));
      for (const widget of plain) {
        found.set(widget.id, { widget, rowId: row.id, columnId: null, order: row.widgets.map((s) => s.id), box: JSON.stringify([widget.width, null, null, row.size ?? null]) });
      }
      for (const column of row.widgets.filter(isWallColumn)) {
        const order = column.rows.flatMap((inner) => inner.widgets.map((w) => w.id));
        for (const inner of column.rows) {
          for (const widget of inner.widgets) {
            const own = inner.widgets.length > 1 ? widget.width : null;
            found.set(widget.id, {
              widget,
              rowId: row.id,
              columnId: column.id,
              order,
              box: JSON.stringify([column.width, inner.size ?? null, own, row.size ?? null]),
            });
          }
        }
      }
    }
    return found;
  };
  const was = places(before);
  const now = places(after);
  const columnsBefore = new Set(before.rows.flatMap((row) => row.widgets.filter(isWallColumn).map((c) => c.id)));
  const columnsAfter = new Set(after.rows.flatMap((row) => row.widgets.filter(isWallColumn).map((c) => c.id)));
  /** The same place: the same container, or one that only came or went
   * around it — a column made in its place, or emptied down to it. */
  const samePlace = (prior: Place, place: Place) => {
    if (prior.rowId !== place.rowId) return false;
    if (prior.columnId === place.columnId) return true;
    const wrapped = prior.columnId === null && place.columnId !== null && !columnsBefore.has(place.columnId);
    const unwrapped = place.columnId === null && prior.columnId !== null && !columnsAfter.has(prior.columnId);
    return wrapped || unwrapped;
  };
  const label = (widget: WallWidget) => WALL_WIDGET_LIBRARY[widget.type].label;
  const added = [...now.values()].filter((p) => !was.has(p.widget.id)).map((p) => label(p.widget));
  const removed = [...was.values()].filter((p) => !now.has(p.widget.id)).map((p) => label(p.widget));
  const moved: string[] = [];
  const resized: string[] = [];
  const filtered: string[] = [];
  for (const [id, place] of now) {
    const prior = was.get(id);
    if (!prior) continue;
    // The neighbours that stayed in this container: one arriving, leaving,
    // or stacking with it does not move the rest.
    const kept = (order: string[]) =>
      order.filter((other) => {
        const a = was.get(other);
        const b = now.get(other);
        return a !== undefined && b !== undefined && a.rowId === prior.rowId && a.columnId === prior.columnId &&
          b.rowId === place.rowId && b.columnId === place.columnId;
      });
    const relocated = !samePlace(prior, place) ||
      (prior.columnId === place.columnId && kept(prior.order).indexOf(id) !== kept(place.order).indexOf(id));
    if (relocated) moved.push(label(place.widget));
    else if (prior.box !== place.box) resized.push(label(place.widget));
    if (JSON.stringify(prior.widget.settings ?? null) !== JSON.stringify(place.widget.settings ?? null)) {
      filtered.push(label(place.widget));
    }
  }
  const rowShape = (layout: WallLayout) => layout.rows.map((row) => `${row.id}:${row.height}`).join(",");
  const parts = [
    added.length ? `added ${added.join(", ")}` : null,
    removed.length ? `removed ${removed.join(", ")}` : null,
    moved.length ? `moved ${moved.join(", ")}` : null,
    resized.length ? `resized ${resized.join(", ")}` : null,
    filtered.length ? `filtered ${filtered.join(", ")}` : null,
    rowShape(before) !== rowShape(after) ? "rearranged rows" : null,
    (before.tileTransparency ?? 0) !== (after.tileTransparency ?? 0) ? `tile transparency ${after.tileTransparency ?? 0}%` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return "Layout changed";
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The editor's Start from choices: each founder view's preset, by the
 * view's own label, in the views' order. */
export function wallPresetOptions(): { view: ViewId; label: string; layout: WallLayout }[] {
  return VIEW_LIBRARY.map((spec) => ({ view: spec.id, label: spec.label, layout: WALL_PRESETS[spec.id] }));
}

/** The view whose preset this layout is, or null. */
export function wallPresetOf(layout: WallLayout): { view: ViewId; label: string } | null {
  const found = wallPresetOptions().find((option) => sameWallLayout(option.layout, layout));
  return found ? { view: found.view, label: found.label } : null;
}

/** The sentence under Save when the Wall could not draw this, or null. */
export function wallEditorRefusal(layout: WallLayout): string | null {
  const check = validateWallLayout(layout);
  return check.ok ? null : check.reason;
}

/** The observations beside Save. A drawable layout can still be a poor Wall. */
export function wallEditorWarnings(layout: WallLayout): string[] {
  return validateWallLayout(layout).ok ? wallLayoutWarnings(layout) : [];
}

export function wallEditorDirty(state: WallEditorState): boolean {
  return !sameWallLayout(state.layout, state.saved);
}

export function wallCanUndo(state: WallEditorState): boolean {
  return state.past.length > 0;
}

export function wallCanRedo(state: WallEditorState): boolean {
  return state.future.length > 0;
}

/**
 * What a widget takes of its own row, as the operator reads it.
 *
 * Widths are weights (the contract's header says why), and a weight is not a
 * number anybody can picture — 1.7 means nothing until you know what it is 1.7
 * OF. The percentage is what the row actually gives it.
 */
export function wallWidthShare(row: WallRow | WallColumnRow, widgetId: string): number {
  const slots: readonly WallSlot[] = row.widgets;
  const total = slots.reduce((sum, w) => sum + w.width, 0);
  if (total <= 0) return 0;
  const widget = slots.find((w) => w.id === widgetId);
  return widget ? (widget.width / total) * 100 : 0;
}

/**
 * The fit check. The preview draws at the TV's own 1920×1080, so its measured
 * content height answers "would this fit" directly. It warns and never
 * blocks: the operator's TV may be taller, and the kiosk clips rather than
 * scrolls by design (index.css).
 */
export function wallOverflowNote(contentHeightPx: number): string | null {
  const over = Math.round(contentHeightPx - WALL_TV_HEIGHT);
  if (!Number.isFinite(over) || over <= 0) return null;
  return `This layout runs ${over} px past the TV.`;
}

// ── sizes ─────────────────────────────────────────────────────────────────

/** The shares a divider snaps to and a size preset offers, of the row (or,
 * for a stacked widget's height, of the column). */
export const WALL_SHARE_PRESETS: readonly { share: number; label: string }[] = [
  { share: 1 / 4, label: "¼" },
  { share: 1 / 3, label: "⅓" },
  { share: 1 / 2, label: "½" },
  { share: 2 / 3, label: "⅔" },
  { share: 3 / 4, label: "¾" },
];

/**
 * Conservative divider floors in TV pixels, measured with the synthetic
 * six-site Wall. They keep dragging usable; actual clipping depends on the
 * current content and is measured separately by the preview.
 */
export const WALL_WIDGET_MIN_PX: Readonly<Record<WallWidgetType, { width: number; height: number }>> = {
  strip: { width: 800, height: 72 },
  loop: { width: 900, height: 56 },
  timeline: { width: 720, height: 100 },
  sites: { width: 880, height: 360 },
  revenue: { width: 432, height: 324 },
  work: { width: 340, height: 260 },
  needs: { width: 260, height: 160 },
  feed: { width: 336, height: 300 },
  agents: { width: 288, height: 200 },
  // Five dots and a short note per site.
  health: { width: 480, height: 200 },
  factory: { width: 288, height: 160 },
  channels: { width: 352, height: 180 },
  // At 1920×1080, with the fixture's five decisions and three held tasks of
  // 72 to 92 characters, it draws whole from 780 × 519 px, its least area
  // (784 is 49 rem). Narrower, its titles take more lines and the area grows.
  next: { width: 784, height: 519 },
};

/** The preset a fraction lands on when it is within `tolerance` of one. */
export function wallSnapShare(share: number, tolerance = 0.02): { share: number; label: string | null } {
  for (const preset of WALL_SHARE_PRESETS) {
    if (Math.abs(share - preset.share) <= tolerance) return preset;
  }
  return { share, label: null };
}

/** "⅓" when a share is one of the presets, else "38%". */
export function wallShareLabel(share: number): string {
  const preset = WALL_SHARE_PRESETS.find((p) => Math.abs(p.share - share) < 0.012);
  return preset ? preset.label : `${Math.round(share * 100)}%`;
}

/**
 * The edge of a widget a drop lands on: the one the pointer is nearest,
 * measured as a fraction of the widget's own width or height. Absolute
 * distance would hand a long thin widget (the strip, the loop) its top and
 * bottom nearly everywhere; relative distance cuts every widget into four
 * triangles corner to corner.
 */
export function wallDropEdge(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
): WallDropEdge {
  const fx = rect.width > 0 ? (x - rect.left) / rect.width : 0.5;
  const fy = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;
  const distances: [WallDropEdge, number][] = [
    ["top", fy],
    ["bottom", 1 - fy],
    ["left", fx],
    ["right", 1 - fx],
  ];
  return distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best))[0];
}

/** A stretch along one axis: where it starts and how long it is. */
export interface WallSpan {
  start: number;
  size: number;
}

/**
 * Where the divider after `items[index]` lands when the pointer is at
 * `pointer` along their track (a row's widgets side by side, or a column's
 * rows): snapped when the widgets before it would take within a step of a
 * preset share of the track's widgets, and kept clear of either neighbour's
 * minimum (never below the size it already has, so a layout already under a
 * minimum is not jerked). Shares are of the widgets' own space, the gaps
 * between them left out, so a divider at "½" leaves two equal widgets.
 * Answers the first neighbour's part of the pair, both neighbours' shares,
 * and the preset it snapped to.
 */
export function wallDividerSplit({
  items,
  index,
  pointer,
  minFirst = 0,
  minSecond = 0,
  snap = true,
}: {
  items: readonly WallSpan[];
  index: number;
  pointer: number;
  minFirst?: number;
  minSecond?: number;
  snap?: boolean;
}): { ratio: number; firstShare: number; secondShare: number; snapped: string | null } {
  const first = items[index];
  const second = items[index + 1];
  if (!first || !second) return { ratio: 0.5, firstShare: 0, secondShare: 0, snapped: null };
  const gap = Math.max(0, second.start - (first.start + first.size));
  const pair = first.size + second.size;
  const total = items.reduce((sum, item) => sum + item.size, 0) || 1;
  const before = items.slice(0, index).reduce((sum, item) => sum + item.size, 0);
  let a = pointer - gap / 2 - first.start;
  let snapped: string | null = null;
  if (snap) {
    const preset = wallSnapShare((before + a) / total, 0.025);
    if (preset.label) {
      a = preset.share * total - before;
      snapped = preset.label;
    }
  }
  const low = Math.min(minFirst, first.size);
  const high = pair - Math.min(minSecond, second.size);
  // Both already under their minimums: neither may block the other, or the
  // divider could not move at all.
  const pinned = first.size < minFirst && second.size < minSecond;
  if (!pinned && low <= high) {
    const clamped = Math.min(high, Math.max(low, a));
    if (Math.abs(clamped - a) > 0.5) snapped = null;
    a = clamped;
  }
  return { ratio: pair > 0 ? a / pair : 0.5, firstShare: a / total, secondShare: (pair - a) / total, snapped };
}

/**
 * Is this widget's height given to it rather than its content's? Only then
 * can it be drawn too short: its top-level row takes the remaining height,
 * and in a column its own row does too, or has a size.
 */
export function wallWidgetHeightIsGiven(layout: WallLayout, widgetId: string): boolean {
  const spot = spotOf(layout, widgetId);
  if (!spot || (spot.row.height !== "fill" && spot.row.size === undefined)) return false;
  return !spot.inner || spot.inner.height === "fill" || spot.inner.size !== undefined;
}

/** The narrowest a slot (a widget, or a column of them) stays legible at. */
export function wallSlotMinWidth(slot: WallSlot): number {
  if (!isWallColumn(slot)) return WALL_WIDGET_MIN_PX[slot.type].width;
  return Math.max(0, ...slot.rows.map((row) => row.widgets.reduce((sum, w) => sum + WALL_WIDGET_MIN_PX[w.type].width, 0)));
}

/** The shortest a column's row stays legible at: its tallest widget's minimum. */
export function wallRowMinHeight(row: WallRow | WallColumnRow): number {
  return Math.max(0, ...row.widgets.map((slot) => isWallColumn(slot)
    ? slot.rows.reduce((sum, inner) => sum + wallRowMinHeight(inner), 0)
    : WALL_WIDGET_MIN_PX[slot.type].height));
}

/**
 * Two neighbours' widths after their divider moves: together they keep the
 * weight they had, and `ratio` of it goes to the first.
 */
export function wallPairWidths(first: number, second: number, ratio: number): [number, number] {
  const total = first + second;
  const a = roundWallWidth(total * Math.min(1, Math.max(0, ratio)));
  return [a, roundWallWidth(total - a)];
}

/**
 * The width that gives one slot `share` of its row while the others keep
 * theirs. Null when it is alone in the row, where every share is the whole.
 */
export function wallShareWidth(slots: readonly WallSlot[], slotId: string, share: number): number | null {
  const others = slots.filter((slot) => slot.id !== slotId).reduce((sum, slot) => sum + slot.width, 0);
  if (others <= 0 || share <= 0 || share >= 1) return null;
  return roundWallWidth((share * others) / (1 - share));
}

/** The weight a column row has in its column's shared height: its size, 1 for
 * the fill row, none for a row that fits its content. */
function rowWeight(row: WallRow | WallColumnRow): number | null {
  if (row.size !== undefined) return row.size;
  return row.height === "fill" ? 1 : null;
}

/**
 * The height weights after the divider between `column.rows[index]` and the
 * row below it moves, from the rows' drawn heights: the pair keeps the pixels
 * it had between them and `ratio` of them goes to the upper row. Every other
 * row that already shares the column's height keeps its pixels, so the new
 * weights are scaled to theirs; a row that fits its content keeps doing so.
 */
export function wallStackSizes(
  column: { rows: readonly (WallRow | WallColumnRow)[] },
  heightsPx: readonly number[],
  index: number,
  ratio: number,
): Record<string, number> {
  const upper = column.rows[index];
  const lower = column.rows[index + 1];
  if (!upper || !lower) return {};
  const pair = (heightsPx[index] ?? 0) + (heightsPx[index + 1] ?? 0);
  if (pair <= 0) return {};
  const upperPx = pair * Math.min(1, Math.max(0, ratio));
  const others = column.rows
    .map((row, i) => ({ row, px: heightsPx[i] ?? 0, weight: rowWeight(row) }))
    .filter((entry, i) => i !== index && i !== index + 1 && entry.weight !== null);
  const otherWeight = others.reduce((sum, entry) => sum + (entry.weight ?? 0), 0);
  const otherPx = others.reduce((sum, entry) => sum + entry.px, 0);
  // Pixels per unit of weight: the other sharing rows' own, or the pair's
  // when nothing else shares, so the pair's weights add up to two.
  const unit = otherWeight > 0 && otherPx > 0 ? otherPx / otherWeight : pair / 2;
  const sharing = [{ row: upper, px: upperPx }, { row: lower, px: pair - upperPx }, ...others];
  const bounded = sharing.every(({ px }) => px / unit >= WALL_WIDTH_MIN && px / unit <= WALL_WIDTH_MAX);
  // A small pair above a large fill row can fall below the weight floor.
  // Rescale the whole sharing run before rounding, keeping its drawn ratios
  // and using the full grid range for the best pixel precision.
  const normalizedUnit = bounded ? unit : Math.max(...sharing.map(({ px }) => px)) / WALL_WIDTH_MAX;
  return Object.fromEntries((bounded ? sharing.slice(0, 2) : sharing)
    .map(({ row, px }) => [row.id, roundWallWidth(px / normalizedUnit)]));
}

/**
 * Height weights that give one column row `share` of the column's height,
 * the others sharing the rest in proportion to the weight they had (1 for a
 * row that fitted its content). The weights add up to three, so a third, a
 * half and two thirds all land on the step grid.
 */
export function wallStackShareSizes(column: WallColumn, rowId: string, share: number): Record<string, number> {
  const others = column.rows.filter((row) => row.id !== rowId);
  if (others.length === 0 || !column.rows.some((row) => row.id === rowId)) return {};
  const weights = others.map((row) => rowWeight(row) ?? 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return Object.fromEntries([
    [rowId, roundWallWidth(3 * share)],
    ...others.map((row, i) => [row.id, roundWallWidth((3 * (1 - share) * (weights[i] ?? 1)) / total)]),
  ]);
}

// ── arranging ────────────────────────────────────────────────────────────

/** A deep copy to mutate; a layout is plain JSON. */
function copy(layout: WallLayout): WallLayout {
  return JSON.parse(JSON.stringify(layout)) as WallLayout;
}

/** A row id no other row uses, the ones added since the copy was made included. */
function freshRowId(layout: WallLayout): string {
  return nextWallRowId(layout);
}

/** A widget or row that prefers the height left over. */
function holdsStretcher(widgets: readonly WallSlot[]): boolean {
  return widgets.some((slot) =>
    isWallColumn(slot)
      ? slot.rows.some((inner) => holdsStretcher(inner.widgets))
      : WALL_WIDGET_LIBRARY[slot.type].prefersFill,
  );
}

/**
 * After a structural change: an emptied column row goes, an emptied column
 * goes, a column left holding one widget becomes that widget again in the
 * column's place and width, and an emptied row goes. A level that lost the
 * row taking its remaining height gives it to its last row holding a widget
 * that wants it, so moving the site rows does not leave the TV's bottom bare.
 */
function tidy(layout: WallLayout): WallLayout {
  const rows: WallRow[] = [];
  for (const row of layout.rows) {
    const slots: WallSlot[] = [];
    for (const slot of row.widgets) {
      if (!isWallColumn(slot)) {
        slots.push(slot);
        continue;
      }
      const inner = slot.rows.filter((r) => r.widgets.length > 0);
      const only = inner.length === 1 ? inner[0] : undefined;
      const lone = only && only.widgets.length === 1 ? only.widgets[0] : undefined;
      if (lone) {
        slots.push({ ...lone, width: slot.width });
      } else if (inner.length > 0) {
        slots.push({ ...slot, rows: withFill(inner) });
      }
    }
    if (slots.length > 0) rows.push({ ...row, widgets: slots });
  }
  return { ...layout, rows: withFill(rows) };
}

/** One level's rows with a fill row restored when it lost it and a row there wants one. */
function withFill<R extends WallRow | WallColumnRow>(rows: R[]): R[] {
  const shares = rows.some((row) => row.height === "fill" || ("size" in row && row.size !== undefined));
  if (shares) return rows;
  let last = -1;
  rows.forEach((row, i) => {
    if (holdsStretcher(row.widgets)) last = i;
  });
  if (last === -1) return rows;
  return rows.map((row, i) => (i === last ? { ...row, height: "fill" as const } : row));
}

/** What `take` hands back: the widget, and its column row when it was alone
 * in it — a widget moving inside or between columns keeps its row's height. */
interface Taken {
  widget: WallWidget;
  ownRow: WallColumnRow | null;
  /** The row it left: a top-level row, or a column's row. */
  fromRowId: string | null;
}

/** Lift a widget out of a copy, leaving empties for `tidy`. */
function take(layout: WallLayout, widgetId: string): Taken | null {
  const spot = spotOf(layout, widgetId);
  if (!spot) return null;
  if (!spot.column || !spot.inner) {
    spot.row.widgets.splice(spot.slotIndex, 1);
    return { widget: spot.widget, ownRow: null, fromRowId: spot.row.id };
  }
  if (spot.inner.widgets.length === 1) {
    const ownRow = { ...spot.inner, widgets: [spot.widget] };
    spot.inner.widgets = [];
    return { widget: spot.widget, ownRow, fromRowId: spot.inner.id };
  }
  spot.inner.widgets.splice(spot.index, 1);
  return { widget: spot.widget, ownRow: null, fromRowId: spot.inner.id };
}

/**
 * A column row to hold a widget arriving in a stack: its own row when it had
 * one, keeping its height, unless the column it joins already has a row
 * taking the remaining height, which stays the one.
 */
function arrivingRow(layout: WallLayout, taken: Taken, into: WallColumn | null): WallColumnRow {
  if (!taken.ownRow) return { id: freshRowId(layout), height: "auto", widgets: [{ ...taken.widget }] };
  const filled = into?.rows.some((row) => row.id !== taken.ownRow?.id && row.widgets.length > 0 && row.height === "fill");
  return filled && taken.ownRow.height === "fill" ? { ...taken.ownRow, height: "auto" } : taken.ownRow;
}

/** Halve a slot's width to make room beside it; the newcomer gets the other half. */
function split(width: number): number {
  return roundWallWidth(width / 2);
}

/** The rows that are not empty: an emptied row is about to go. */
function liveRowCount(layout: WallLayout): number {
  return layout.rows.filter((row) => row.widgets.length > 0).length;
}

/** The widget a drag brings, lifted out of `next`, or made for a new one. */
function bring(next: WallLayout, source: WallDragSource): Taken | null {
  if (source.kind === "widget") return take(next, source.widgetId);
  const spec = WALL_WIDGET_LIBRARY[source.widget];
  if (spec.unique && wallLayoutWidgets(next).some((w) => w.type === source.widget)) return null;
  return {
    widget: { id: nextWallWidgetId(next, source.widget), type: source.widget, width: roundWallWidth(spec.defaultWidth) },
    ownRow: null,
    fromRowId: null,
  };
}

/** Is this left or right edge between two widgets of the same column row? */
function innerEdge(edge: WallDropEdge, index: number, count: number): boolean {
  return (edge === "left" && index > 0) || (edge === "right" && index < count - 1);
}

/**
 * What a drop does, or null when it does nothing or is not allowed: a drop
 * onto the widget itself, into a full row, a sixth row or a seventh stacked
 * widget, a second one-of-a-kind widget, or anything that leaves the Wall
 * undrawable when it was drawable before. The editor draws the landing line
 * only where this answers, so the line is the promise.
 */
export function wallDropPlan(layout: WallLayout, source: WallDragSource, target: WallDropTarget): WallDropPlan | null {
  if (target.kind === "widget" && source.kind === "widget" && source.widgetId === target.widgetId) return null;
  const sourceSpot = source.kind === "widget" ? spotOf(layout, source.widgetId) : null;
  if (source.kind === "widget" && !sourceSpot) return null;

  const next = copy(layout);
  let line: WallDropLine;
  let arrived: WallWidget;

  if (target.kind === "gap") {
    if (target.index < 0 || target.index > layout.rows.length) return null;
    // A widget alone in its row moves with its row, so a drop into the gap
    // beside its own row changes nothing and the row keeps its id and height.
    const lonely = sourceSpot && !sourceSpot.column && sourceSpot.row.widgets.length === 1 ? sourceSpot : null;
    if (lonely && (target.index === lonely.rowIndex || target.index === lonely.rowIndex + 1)) return null;
    const taken = bring(next, source);
    if (!taken) return null;
    if (!lonely && liveRowCount(next) >= WALL_MAX_ROWS) return null;
    arrived = taken.widget;
    const row: WallRow = lonely
      ? { ...lonely.row, widgets: [arrived] }
      : { id: freshRowId(next), height: "auto", widgets: [arrived] };
    next.rows.splice(target.index, 0, row);
    line = { anchor: "gap", index: target.index };
  } else if (target.kind === "slot") {
    const slotBefore = layout.rows.flatMap((row) => row.widgets).find((slot) => slot.id === target.slotId);
    if (!slotBefore) return null;
    const taken = bring(next, source);
    if (!taken) return null;
    arrived = taken.widget;
    if (!besideSlot(next, target.slotId, target.edge, taken)) return null;
    line = { anchor: isWallColumn(slotBefore) ? "slot" : "widget", id: target.slotId, edge: target.edge };
  } else {
    const { edge } = target;
    const before = spotOf(layout, target.widgetId);
    if (!before) return null;
    const taken = bring(next, source);
    if (!taken) return null;
    arrived = taken.widget;
    const at = spotOf(next, target.widgetId);
    if (!at) return null;

    if (edge === "top" || edge === "bottom") {
      const below = edge === "bottom";
      if (at.column && at.inner) {
        // Stack in its column: a row of its own above or below the target's row.
        if (at.column.rows.filter((r) => r.widgets.length > 0).length >= WALL_MAX_ROWS) return null;
        at.column.rows.splice(at.innerIndex + (below ? 1 : 0), 0, arrivingRow(next, taken, at.column));
        line = before.inner && before.inner.widgets.length > 1
          ? { anchor: "row", id: before.inner.id, edge }
          : { anchor: "widget", id: target.widgetId, edge };
      } else {
        // A plain slot becomes a column of the two, in its place and width.
        const targetRow: WallColumnRow = { id: freshRowId(next), height: "auto", widgets: [at.widget] };
        const reserved: WallLayout = { ...next, rows: [...next.rows, { id: targetRow.id, height: "auto", widgets: [] }] };
        const arriving = arrivingRow(reserved, taken, null);
        const column: WallColumn = {
          id: nextWallWidgetId(next, "column"),
          type: "column",
          width: at.widget.width,
          rows: below ? [targetRow, arriving] : [arriving, targetRow],
        };
        at.row.widgets.splice(at.slotIndex, 1, column);
        line = { anchor: "widget", id: target.widgetId, edge };
      }
    } else if (at.column && at.inner && before.inner && innerEdge(edge, before.index, before.inner.widgets.length)) {
      // Between two widgets sharing a column's row: it joins that row.
      if (at.inner.widgets.length >= WALL_MAX_WIDGETS_PER_ROW) return null;
      const reorder = taken.fromRowId === at.inner.id;
      const width = reorder ? arrived.width : split(at.widget.width);
      if (!reorder) at.widget.width = width;
      at.inner.widgets.splice(at.index + (edge === "right" ? 1 : 0), 0, { ...arrived, width });
      line = { anchor: "widget", id: target.widgetId, edge };
    } else {
      // A new column beside the target's own top-level slot.
      if (!besideSlot(next, at.slot.id, edge, taken)) return null;
      line = isWallColumn(before.slot)
        ? { anchor: "slot", id: before.slot.id, edge }
        : { anchor: "widget", id: before.slot.id, edge };
    }
  }

  const tidied = tidy(next);
  if (sameWallLayout(tidied, layout)) return null;
  if (validateWallLayout(layout).ok && !validateWallLayout(tidied).ok) return null;
  return { layout: tidied, widgetId: arrived.id, line };
}

/**
 * Put a widget into a top-level row as a slot of its own, beside the slot
 * with this id. Reordering among the row's own slots keeps every width;
 * arriving from anywhere else takes half of the slot it lands beside.
 */
function besideSlot(next: WallLayout, slotId: string, edge: WallDropEdge, taken: Taken): boolean {
  for (const row of next.rows) {
    const index = row.widgets.findIndex((slot) => slot.id === slotId);
    const slot = row.widgets[index];
    if (!slot) continue;
    if (row.widgets.length >= WALL_MAX_WIDGETS_PER_ROW) return false;
    const reorder = taken.fromRowId === row.id;
    const width = reorder ? taken.widget.width : split(slot.width);
    if (!reorder) slot.width = width;
    row.widgets.splice(index + (edge === "right" ? 1 : 0), 0, { ...taken.widget, width });
    return true;
  }
  return false;
}

/** Swap a widget with its neighbour in its own row, every width kept. */
function swapInRow(layout: WallLayout, widgetId: string, step: -1 | 1): WallLayout | null {
  const next = copy(layout);
  const spot = spotOf(next, widgetId);
  if (!spot) return null;
  const list: WallSlot[] = spot.inner ? spot.inner.widgets : spot.row.widgets;
  const from = spot.inner ? spot.index : spot.slotIndex;
  const to = from + step;
  if (to < 0 || to >= list.length) return null;
  const [moved] = list.splice(from, 1);
  if (!moved) return null;
  list.splice(to, 0, moved);
  return next;
}

/**
 * The layout one Move menu item produces, or null when it cannot move the
 * widget (the item is disabled). Up and down step through the widget's
 * column, then out of it into a row of its own; a widget alone in its row
 * takes the row with it. Left and right step to the neighbouring column,
 * joining it at the same height, or swap places with a neighbour that is a
 * single widget beside a single widget.
 */
export function wallMovePlan(layout: WallLayout, widgetId: string, move: WallMove): WallLayout | null {
  const spot = spotOf(layout, widgetId);
  if (!spot) return null;
  const self: WallDragSource = { kind: "widget", widgetId };
  const drop = (target: WallDropTarget) => wallDropPlan(layout, self, target)?.layout ?? null;
  const onWidget = (id: string | undefined, edge: WallDropEdge) => (id ? drop({ kind: "widget", widgetId: id, edge }) : null);
  const { column, inner, rowIndex, row } = spot;
  const aloneInRow = !column && row.widgets.length === 1;

  if (typeof move === "object") return onWidget(move.under, "bottom");
  switch (move) {
    case "up":
    case "down": {
      const up = move === "up";
      if (column && inner) {
        if (inner.widgets.length > 1) {
          const sibling = inner.widgets.find((w) => w.id !== widgetId);
          return onWidget(sibling?.id, up ? "top" : "bottom");
        }
        const neighbour = column.rows[spot.innerIndex + (up ? -1 : 1)];
        if (neighbour) return onWidget(neighbour.widgets[0]?.id, up ? "top" : "bottom");
        return drop({ kind: "gap", index: rowIndex + (up ? 0 : 1) });
      }
      if (aloneInRow) {
        const to = rowIndex + (up ? -1 : 2);
        return to < 0 || to > layout.rows.length ? null : drop({ kind: "gap", index: to });
      }
      return drop({ kind: "gap", index: rowIndex + (up ? 0 : 1) });
    }
    case "left":
    case "right": {
      const step = move === "left" ? -1 : 1;
      if (inner && inner.widgets.length > 1 && innerEdge(move, spot.index, inner.widgets.length)) {
        return swapInRow(layout, widgetId, step);
      }
      if (!column) return swapInRow(layout, widgetId, step);
      const neighbour = row.widgets[spot.slotIndex + step];
      if (!neighbour) return drop({ kind: "slot", slotId: column.id, edge: move });
      if (!isWallColumn(neighbour)) return onWidget(neighbour.id, spot.innerIndex === 0 ? "top" : "bottom");
      // Join the neighbouring column at the same height, or under its last row.
      const level = Math.min(spot.innerIndex, neighbour.rows.length - 1);
      const there = neighbour.rows[level]?.widgets[0];
      return onWidget(there?.id, spot.innerIndex < neighbour.rows.length ? "top" : "bottom");
    }
    case "own-column":
      return column ? drop({ kind: "slot", slotId: column.id, edge: "right" }) : null;
    case "row-above":
      return aloneInRow ? null : drop({ kind: "gap", index: rowIndex });
    case "row-below":
      return aloneInRow ? null : drop({ kind: "gap", index: rowIndex + 1 });
  }
}

/** Where a widget is, in words: its row, its column in that row, and its
 * place in a stack — "row 3 of 3, column 2 of 2, 1 of 2 in its column". */
export function wallWidgetWhere(layout: WallLayout, widgetId: string): { label: string; where: string } | null {
  const spot = spotOf(layout, widgetId);
  if (!spot) return null;
  const label = WALL_WIDGET_LIBRARY[spot.widget.type].label;
  const where = `row ${spot.rowIndex + 1} of ${layout.rows.length}, column ${spot.slotIndex + 1} of ${spot.row.widgets.length}`;
  if (!spot.column) return { label, where };
  const stacked = spot.column.rows.flatMap((r) => r.widgets.map((w) => w.id));
  return { label, where: `${where}, ${stacked.indexOf(widgetId) + 1} of ${stacked.length} in its column` };
}

/**
 * What a widget, a column or a column's row is called on screen: a widget by
 * its name, a column or a row by the widgets in it — "Last 24 hours and
 * Sites".
 */
export function wallSlotName(layout: WallLayout, id: string): string {
  const names = (widgets: readonly WallWidget[]) => {
    const labels = widgets.map((w) => WALL_WIDGET_LIBRARY[w.type].label);
    return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : labels[0] ?? "";
  };
  for (const { row } of wallRowPlaces(layout)) {
    if (row.id === id) return names(row.widgets.flatMap(slot => isWallColumn(slot) ? slot.rows.flatMap(inner => inner.widgets) : [slot]));
    for (const slot of row.widgets) {
      if (slot.id !== id) continue;
      return isWallColumn(slot) ? names(slot.rows.flatMap((inner) => inner.widgets)) : WALL_WIDGET_LIBRARY[slot.type].label;
    }
  }
  return "";
}

/** "Revenue: row 3 of 3, column 2 of 2": a widget's name with its place. */
export function wallPositionSentence(layout: WallLayout, widgetId: string): string | null {
  const place = wallWidgetWhere(layout, widgetId);
  return place ? `${place.label}: ${place.where}` : null;
}

/** Every widget but this one, in reading order: what "Stack under" offers. */
export function wallStackChoices(layout: WallLayout, widgetId: string): WallWidget[] {
  return wallLayoutWidgets(layout).filter(
    (widget) => widget.id !== widgetId && wallMovePlan(layout, widgetId, { under: widget.id }) !== null,
  );
}

/** The top-level slot holding a widget — itself, or its column — and that slot's row. */
export function wallSlotOf(layout: WallLayout, widgetId: string): { slot: WallSlot; row: WallRow } | null {
  const spot = spotOf(layout, widgetId);
  return spot ? { slot: spot.slot, row: spot.row } : null;
}

function setWidths(layout: WallLayout, widths: Record<string, number>): WallLayout {
  const next = copy(layout);
  for (const row of next.rows) {
    for (const slot of row.widgets) {
      const width = widths[slot.id];
      if (width !== undefined) slot.width = roundWallWidth(width);
      if (!isWallColumn(slot)) continue;
      for (const inner of slot.rows) {
        for (const widget of inner.widgets) {
          const own = widths[widget.id];
          if (own !== undefined) widget.width = roundWallWidth(own);
        }
      }
    }
  }
  return next;
}

function setSizes(layout: WallLayout, sizes: Record<string, number | null>): WallLayout {
  const next = copy(layout);
  for (const { row } of wallRowPlaces(next)) {
    if (!(row.id in sizes)) continue;
    const size = sizes[row.id];
    if (size === null || size === undefined) delete row.size;
    else row.size = roundWallWidth(size);
  }
  return next;
}

/** Fill or fit one row among its siblings: the layout's rows, or its column's. */
function setHeight(layout: WallLayout, rowId: string, height: "fill" | "fit"): WallLayout {
  const next = copy(layout);
  if (next.rows.some((row) => row.id === rowId)) {
    next.rows = next.rows.map((row) => {
      const { size: _size, ...rest } = row;
      if (height === "fill") return { ...rest, height: row.id === rowId ? "fill" : "auto" };
      return row.id === rowId ? { ...rest, height: "auto" } : row;
    });
    return next;
  }
  for (const row of next.rows) {
    for (const slot of row.widgets) {
      if (!isWallColumn(slot) || !slot.rows.some((inner) => inner.id === rowId)) continue;
      slot.rows = slot.rows.map((inner) => {
        const { size: _size, ...rest } = inner;
        if (height === "fill") {
          // Filling takes the column back to fill-and-fit: weights would
          // otherwise go on sharing the height the fill row is to take.
          return { ...rest, height: inner.id === rowId ? "fill" : "auto" };
        }
        return inner.id === rowId ? { ...rest, height: "auto" } : inner;
      });
    }
  }
  return next;
}

/** Record a change: the layout before it goes on the Undo stack, unless it is
 * one more step of the gesture already recorded. */
function commit(state: WallEditorState, layout: WallLayout, extra: Partial<WallEditorState> = {}, gesture?: string): WallEditorState {
  if (sameWallLayout(layout, state.layout)) return { ...state, ...extra };
  const continuing = gesture !== undefined && gesture === state.gesture;
  return {
    ...state,
    ...extra,
    layout,
    past: continuing ? state.past : [...state.past, state.layout].slice(-WALL_UNDO_LIMIT),
    future: [],
    gesture: gesture ?? null,
  };
}

/** A selection survives a layout change only when the widget is still there. */
function keepSelection(layout: WallLayout, selectedId: string | null): string | null {
  return selectedId && wallWidgetAt(layout, selectedId) ? selectedId : null;
}

export function wallEditorReducer(
  state: WallEditorState,
  action: WallEditorAction,
): WallEditorState {
  switch (action.type) {
    case "add": {
      const target = wallAddTarget(state.layout, action.widget);
      if (!target) return state;
      const spec = WALL_WIDGET_LIBRARY[action.widget];
      const widget: WallWidget = {
        id: nextWallWidgetId(state.layout, action.widget),
        type: action.widget,
        width: roundWallWidth(spec.defaultWidth),
      };
      if ("newRow" in target) {
        const row: WallRow = { id: nextWallRowId(state.layout), height: "auto", widgets: [widget] };
        return commit(state, tidy({ ...state.layout, rows: [...state.layout.rows, row] }), { selectedId: widget.id });
      }
      const next = copy(state.layout);
      next.rows.find((row) => row.id === target.rowId)?.widgets.splice(target.index, 0, widget);
      return commit(state, tidy(next), { selectedId: widget.id });
    }
    case "remove": {
      const next = copy(state.layout);
      if (!take(next, action.widgetId)) return state;
      return commit(state, tidy(next), {
        selectedId: state.selectedId === action.widgetId ? null : state.selectedId,
      });
    }
    case "select":
      return { ...state, selectedId: action.widgetId };
    case "transparency":
      if (!Number.isInteger(action.value) || action.value < 0 || action.value > 100) return state;
      return commit(state, { ...state.layout, tileTransparency: action.value }, {}, action.gesture);
    case "settings": {
      const next = copy(state.layout);
      const spot = spotOf(next, action.widgetId);
      if (!spot) return state;
      // An empty asset filter is no filter: the widget shows every asset, and
      // the layout says so by carrying none.
      const settings = action.settings === undefined ? undefined : structuredClone(action.settings);
      if (settings?.assets?.length === 0) delete settings.assets;
      if (settings === undefined || Object.keys(settings).length === 0) delete spot.widget.settings;
      else spot.widget.settings = settings;
      return commit(state, next);
    }
    case "drop": {
      const plan = wallDropPlan(state.layout, action.source, action.target);
      return plan ? commit(state, plan.layout, { selectedId: plan.widgetId }) : state;
    }
    case "move": {
      const layout = wallMovePlan(state.layout, action.widgetId, action.move);
      return layout ? commit(state, layout, { selectedId: action.widgetId }) : state;
    }
    case "widths":
      return commit(state, setWidths(state.layout, action.widths), {}, action.gesture);
    case "sizes":
      return commit(state, setSizes(state.layout, action.sizes), {}, action.gesture);
    case "fill":
    case "fit":
      return commit(state, setHeight(state.layout, action.rowId, action.type));
    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        ...state,
        layout: previous,
        past: state.past.slice(0, -1),
        future: [state.layout, ...state.future],
        gesture: null,
        selectedId: keepSelection(previous, state.selectedId),
      };
    }
    case "redo": {
      const [following, ...rest] = state.future;
      if (!following) return state;
      return {
        ...state,
        layout: following,
        past: [...state.past, state.layout].slice(-WALL_UNDO_LIMIT),
        future: rest,
        gesture: null,
        selectedId: keepSelection(following, state.selectedId),
      };
    }
    case "discard":
      return commit(state, state.saved, { selectedId: keepSelection(state.saved, state.selectedId) });
    case "replace":
      return commit(state, action.layout, { selectedId: keepSelection(action.layout, state.selectedId) });
    case "reset": {
      // The same saved layout again (the poll, or Undo back to clean) keeps
      // the history; a different one starts it afresh.
      const same = sameWallLayout(action.layout, state.saved);
      return {
        layout: action.layout,
        saved: action.layout,
        selectedId: keepSelection(action.layout, state.selectedId),
        past: same ? state.past : [],
        future: same ? state.future : [],
        gesture: null,
      };
    }
    case "saved":
      return { ...state, saved: action.layout };
    default:
      return state;
  }
}
