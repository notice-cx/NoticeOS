/**
 * The Wall editor's state, with no DOM in it (bead `ro-lzmq.2`).
 *
 * Every arrangement the operator can make at `/wall/edit` — add, remove, widen,
 * filter, drag, nudge, and the row operations — is a pure function of a
 * `WallLayout` and one action. The route holds this in a `useReducer` and draws
 * it; nothing here knows about React, and `apps/tower/test/wall-editor.test.ts`
 * exercises the whole grammar without rendering anything.
 *
 * That split is deliberate rather than tidy. The preview is the REAL Wall
 * renderer (`WallCanvas`, bead `ro-lzmq.1`), so the editor cannot own a second
 * idea of how a layout is drawn; what it owns is how a layout is CHANGED. Those
 * are two different questions and they are answered in two different files.
 *
 * THE VALIDATOR IS NOT REIMPLEMENTED HERE. `validateWallLayout` in
 * `apps/tower/shared/wall-layout.ts` is the one rule for "can the Wall draw
 * this", read by the write lane before it writes and by this editor before it
 * offers Save. Actions here therefore do NOT refuse: an action that produces a
 * layout the Wall cannot draw produces it, Save goes dark, and the validator's
 * own sentence says why. An editor that silently declined a move would be a
 * second, quieter rule the operator could not read.
 */

import {
  WALL_MAX_ROWS,
  WALL_MAX_WIDGETS_PER_ROW,
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

export interface WallEditorState {
  /** What the operator is composing — what the preview draws. */
  layout: WallLayout;
  /** The layout the file holds. Discard restores it; dirty compares against it. */
  saved: WallLayout;
  /** Which widget the settings pane is for. */
  selectedId: string | null;
}

export type WallEditorAction =
  /** Place a widget from the library. Its target is `wallAddTarget`'s. */
  | { type: "add"; widget: WallWidgetType }
  | { type: "remove"; widgetId: string }
  | { type: "select"; widgetId: string | null }
  | { type: "width"; widgetId: string; width: number }
  | { type: "settings"; widgetId: string; settings: WallWidgetSettings | undefined }
  /** A drag's landing: this widget, into that row, before that index. */
  | { type: "move"; widgetId: string; toRowId: string; toIndex: number }
  /** The keyboard's half of the same move. */
  | { type: "nudge"; widgetId: string; direction: WallNudge }
  /** Stack this widget in a column, or take it out of the one it is in. */
  | { type: "stack"; widgetId: string }
  | { type: "add-row" }
  | { type: "remove-row"; rowId: string }
  | { type: "move-row"; rowId: string; direction: "up" | "down" }
  /** Give this row the remaining height, or clear it by naming the row that has it. */
  | { type: "fill-row"; rowId: string }
  /** Discard, or a newly saved layout arriving from the poll. */
  | { type: "reset"; layout: WallLayout }
  /** The write landed: what is on screen is now what the file holds. */
  | { type: "saved"; layout: WallLayout };

export type WallNudge = "left" | "right" | "up" | "down";

export function wallEditorState(saved: WallLayout): WallEditorState {
  return { layout: saved, saved, selectedId: null };
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

/**
 * Where a freshly added widget lands.
 *
 * The row taking the remaining height is the one that STRETCHES, so it is where
 * a widget designed for it belongs and the last place anything else should land
 * — an Assets grid in the horizon gets squeezed (`wallLayoutWarnings` says so
 * out loud), and a clock in the fill row gets stretched to half the screen.
 * Hence two passes: the preferred kind of row first, any row with space after
 * it, and only when nothing has space does the layout grow a row. Within a kind
 * it is the LAST row, because an operator adding a second clock expects it
 * beside the first rather than on a new line.
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
 * The library panel's rows, in the contract's order.
 *
 * A refused Add shows WHY in place of the button, as a state rather than a
 * sentence (bead `ro-ujb9.96.6.12`): "On the TV" for a one-of-a-kind widget
 * already placed — the preview beside it shows where — and "TV full" when
 * every row holds `WALL_MAX_WIDGETS_PER_ROW` and there are `WALL_MAX_ROWS`.
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
 * What changed between the saved layout and this one, in a few words — the
 * version's description when the operator writes no note (bead
 * `ro-ujb9.96.6.12`). Grafana makes a save's message optional and shows the
 * difference instead; a history reads without anyone having to write it.
 *
 * "Moved" means a widget changed row, or changed place among the widgets its
 * row kept — a neighbour arriving or leaving does not move it.
 */
export function wallChangeSummary(before: WallLayout, after: WallLayout): string {
  type Place = { widget: WallWidget; rowId: string; order: string[] };
  const places = (layout: WallLayout) =>
    new Map<string, Place>(
      wallRowPlaces(layout).flatMap(({ row }) => {
        const slots: readonly WallSlot[] = row.widgets;
        return slots
          .filter((slot): slot is WallWidget => !isWallColumn(slot))
          .map((widget) => [widget.id, { widget, rowId: row.id, order: slots.map((w) => w.id) }] as const);
      }),
    );
  const was = places(before);
  const now = places(after);
  const label = (widget: WallWidget) => WALL_WIDGET_LIBRARY[widget.type].label;
  const added = [...now.values()].filter((p) => !was.has(p.widget.id)).map((p) => label(p.widget));
  const removed = [...was.values()].filter((p) => !now.has(p.widget.id)).map((p) => label(p.widget));
  const moved: string[] = [];
  const resized: string[] = [];
  const filtered: string[] = [];
  for (const [id, place] of now) {
    const prior = was.get(id);
    if (!prior) continue;
    // The neighbours that stayed in this row: one arriving, leaving, or
    // stacking into a column in its place does not move the rest.
    const kept = (order: string[]) =>
      order.filter((other) => was.get(other)?.rowId === prior.rowId && now.get(other)?.rowId === place.rowId);
    if (prior.rowId !== place.rowId || kept(prior.order).indexOf(id) !== kept(place.order).indexOf(id)) {
      moved.push(label(place.widget));
    }
    if (prior.widget.width !== place.widget.width) resized.push(label(place.widget));
    if (JSON.stringify(prior.widget.settings ?? null) !== JSON.stringify(place.widget.settings ?? null)) {
      filtered.push(label(place.widget));
    }
  }
  const rowShape = (layout: WallLayout) =>
    wallRowPlaces(layout).map(({ row }) => `${row.id}:${row.height}`).join(",");
  const parts = [
    added.length ? `added ${added.join(", ")}` : null,
    removed.length ? `removed ${removed.join(", ")}` : null,
    moved.length ? `moved ${moved.join(", ")}` : null,
    resized.length ? `resized ${resized.join(", ")}` : null,
    filtered.length ? `filtered ${filtered.join(", ")}` : null,
    rowShape(before) !== rowShape(after) ? "rearranged rows" : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return "Layout changed";
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
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

/**
 * What a widget takes of its own row, as the operator reads it.
 *
 * Widths are weights (the contract's header says why), and a weight is not a
 * number anybody can picture — 1.7 means nothing until you know what it is 1.7
 * OF. The percentage is what the row actually gives it, so moving the control
 * moves a figure the operator can check against the preview beside it.
 */
export function wallWidthShare(row: WallRow | WallColumnRow, widgetId: string): number {
  const total = row.widgets.reduce((sum, w) => sum + w.width, 0);
  if (total <= 0) return 0;
  const widget = row.widgets.find((w) => w.id === widgetId);
  return widget ? (widget.width / total) * 100 : 0;
}

/**
 * The fit check (docs/15 flow D). The preview draws at the TV's own 1920×1080,
 * so its measured content height answers "would this fit" directly.
 *
 * It WARNS and never blocks: the operator's TV may be taller than ours, they
 * may not care about the bottom of the assets grid, and the kiosk clips rather
 * than scrolls by design (index.css). A layout nobody can save because a
 * measurement said so would be the editor overruling its owner.
 */
export function wallOverflowNote(contentHeightPx: number): string | null {
  const over = Math.round(contentHeightPx - WALL_TV_HEIGHT);
  if (!Number.isFinite(over) || over <= 0) return null;
  return `This layout runs ${over} px past the TV.`;
}

/**
 * Every row's slots through one function — the top-level rows and the rows
 * inside columns alike, since a move or a width does not care which it is in.
 * A column row only ever receives and returns widgets (`WallColumnRow`).
 */
function mapEveryRow(layout: WallLayout, edit: (slots: WallSlot[], rowId: string) => WallSlot[]): WallLayout {
  return {
    ...layout,
    rows: layout.rows.map((row) => ({
      ...row,
      widgets: edit(row.widgets, row.id).map((slot) =>
        isWallColumn(slot)
          ? {
              ...slot,
              rows: slot.rows.map((inner) => ({
                ...inner,
                widgets: edit(inner.widgets, inner.id).filter((w): w is WallWidget => !isWallColumn(w)),
              })),
            }
          : slot,
      ),
    })),
  };
}

/**
 * A column is a container, not a placeholder: a column row left with no
 * widget goes, and a column left with no row goes with it. That is what takes a
 * widget out of a column in one press, and it keeps every editor action from
 * leaving an empty column the validator would then refuse.
 */
function pruneColumns(layout: WallLayout): WallLayout {
  return {
    ...layout,
    rows: layout.rows.map((row) => ({
      ...row,
      widgets: row.widgets.flatMap((slot): WallSlot[] => {
        if (!isWallColumn(slot)) return [slot];
        const rows = slot.rows.filter((inner) => inner.widgets.length > 0);
        return rows.length > 0 ? [{ ...slot, rows }] : [];
      }),
    })),
  };
}

function replaceWidget(
  layout: WallLayout,
  widgetId: string,
  update: (widget: WallWidget) => WallWidget,
): WallLayout {
  return mapEveryRow(layout, (slots) =>
    slots.map((slot) => (slot.id === widgetId && !isWallColumn(slot) ? update(slot) : slot)),
  );
}

/** Lift a widget out, and hand back the layout without it plus the widget.
 * Empty columns are NOT pruned here, so a move can still land in the row it
 * left; the caller prunes once the widget is back down. */
function withoutWidget(
  layout: WallLayout,
  widgetId: string,
): { layout: WallLayout; widget: WallWidget } | null {
  const at = wallWidgetAt(layout, widgetId);
  if (!at) return null;
  return {
    layout: mapEveryRow(layout, (slots) => slots.filter((slot) => slot.id !== widgetId)),
    widget: at.widget,
  };
}

/** Put a widget into the row with this id, wherever that row sits. */
function insertSlot(
  layout: WallLayout,
  widget: WallWidget,
  rowId: string,
  index: number,
): WallLayout {
  return mapEveryRow(layout, (slots, id) => {
    if (id !== rowId) return slots;
    const next = [...slots];
    next.splice(Math.max(0, Math.min(index, next.length)), 0, widget);
    return next;
  });
}

function moveWidget(
  layout: WallLayout,
  widgetId: string,
  toRowId: string,
  toIndex: number,
): WallLayout {
  const from = wallWidgetAt(layout, widgetId);
  if (!from) return layout;
  const target = wallRowPlaces(layout).find(({ row }) => row.id === toRowId)?.row;
  if (!target) return layout;
  // A row already holding its four is not a landing place. This is the one
  // guard here, and it exists because the alternative is not a refusal the
  // operator can read but a fifth widget in a row that then cannot be saved
  // until they work out which of the five to take out again.
  if (target.id !== from.row.id && target.widgets.length >= WALL_MAX_WIDGETS_PER_ROW) {
    return layout;
  }
  const lifted = withoutWidget(layout, widgetId);
  if (!lifted) return layout;
  // Removing the widget first shifts every later index in its own row down by
  // one, so a move to the right inside one row lands where the operator aimed.
  const index =
    target.id === from.row.id && toIndex > from.index ? toIndex - 1 : toIndex;
  return pruneColumns(insertSlot(lifted.layout, lifted.widget, toRowId, index));
}

/**
 * Stack a widget in a column, or take it out of one (bead `ro-trai.2`).
 *
 * At the top level it joins its row's column as a new row at the bottom — or,
 * with no column in the row, becomes one in its own place, at its own width.
 * Inside a column it comes out into the row holding the column, just after
 * it. Every other arrangement is the ordinary move: a widget dropped on a
 * column row joins it.
 */
function stack(layout: WallLayout, widgetId: string): WallLayout {
  const at = wallWidgetAt(layout, widgetId);
  if (!at) return layout;
  if (at.column && at.parent) {
    const columnId = at.column.id;
    const leavesColumn = at.column.rows.length === 1 && at.row.widgets.length === 1;
    if (!leavesColumn && at.parent.widgets.length >= WALL_MAX_WIDGETS_PER_ROW) return layout;
    const after = at.parent.widgets.findIndex((slot) => slot.id === columnId) + 1;
    const lifted = withoutWidget(layout, widgetId);
    if (!lifted) return layout;
    return pruneColumns(insertSlot(lifted.layout, lifted.widget, at.parent.id, after));
  }
  const slots: readonly WallSlot[] = at.row.widgets;
  const column = slots.find(isWallColumn);
  const inner: WallColumnRow = { id: nextWallRowId(layout), height: "auto", widgets: [at.widget] };
  if (column) {
    if (column.rows.length >= WALL_MAX_ROWS) return layout;
    const lifted = withoutWidget(layout, widgetId);
    if (!lifted) return layout;
    return {
      ...lifted.layout,
      rows: lifted.layout.rows.map((row) => ({
        ...row,
        widgets: row.widgets.map((slot) =>
          slot.id === column.id && isWallColumn(slot) ? { ...slot, rows: [...slot.rows, inner] } : slot,
        ),
      })),
    };
  }
  const wrapped: WallColumn = {
    id: nextWallWidgetId(layout, "column"),
    type: "column",
    width: at.widget.width,
    rows: [inner],
  };
  return {
    ...layout,
    rows: layout.rows.map((row) => ({
      ...row,
      widgets: row.widgets.map((slot) => (slot.id === widgetId ? wrapped : slot)),
    })),
  };
}

/** Can Stack move anything? The button reads it, so a full row or column
 * disables it rather than pressing into nothing. */
export function canStack(layout: WallLayout, widgetId: string): boolean {
  return !sameWallLayout(stack(layout, widgetId), layout);
}

function nudge(layout: WallLayout, widgetId: string, direction: WallNudge): WallLayout {
  const at = wallWidgetAt(layout, widgetId);
  if (!at) return layout;
  if (direction === "left" || direction === "right") {
    const toIndex = direction === "left" ? at.index - 1 : at.index + 2;
    if (direction === "left" && at.index === 0) return layout;
    if (direction === "right" && at.index === at.row.widgets.length - 1) return layout;
    return moveWidget(layout, widgetId, at.row.id, toIndex);
  }
  // Up and down stay among the widget's own siblings: the layout's rows, or
  // the rows of the column it is stacked in.
  const toRowIndex = direction === "up" ? at.rowIndex - 1 : at.rowIndex + 1;
  const target = (at.column ? at.column.rows : layout.rows)[toRowIndex];
  if (!target) return layout;
  // Into the same column it left, as far as the shorter row allows: a widget
  // that was third stays third where there is a third place.
  return moveWidget(layout, widgetId, target.id, Math.min(at.index, target.widgets.length));
}

/** Can this nudge move anything? The buttons read it, so a dead direction is
 * disabled rather than silently doing nothing. */
export function canNudge(layout: WallLayout, widgetId: string, direction: WallNudge): boolean {
  return !sameWallLayout(nudge(layout, widgetId, direction), layout);
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
        const row: WallRow = {
          id: nextWallRowId(state.layout),
          height: "auto",
          widgets: [widget],
        };
        return {
          ...state,
          layout: { ...state.layout, rows: [...state.layout.rows, row] },
          selectedId: widget.id,
        };
      }
      return {
        ...state,
        layout: insertSlot(state.layout, widget, target.rowId, target.index),
        selectedId: widget.id,
      };
    }
    case "remove": {
      const lifted = withoutWidget(state.layout, action.widgetId);
      if (!lifted) return state;
      return {
        ...state,
        layout: pruneColumns(lifted.layout),
        selectedId: state.selectedId === action.widgetId ? null : state.selectedId,
      };
    }
    case "select":
      return { ...state, selectedId: action.widgetId };
    case "width":
      return {
        ...state,
        layout: replaceWidget(state.layout, action.widgetId, (w) => ({
          ...w,
          width: roundWallWidth(action.width),
        })),
      };
    case "settings":
      return {
        ...state,
        layout: replaceWidget(state.layout, action.widgetId, (w) => {
          // An empty asset filter is no filter (bead `ro-ujb9.96.6.17`): the
          // widget shows every asset, and the layout says so by carrying none.
          if (action.settings === undefined || action.settings.assets?.length === 0) {
            const { settings: _dropped, ...rest } = w;
            return rest;
          }
          return { ...w, settings: action.settings };
        }),
      };
    case "move":
      return {
        ...state,
        layout: moveWidget(state.layout, action.widgetId, action.toRowId, action.toIndex),
      };
    case "nudge":
      return { ...state, layout: nudge(state.layout, action.widgetId, action.direction) };
    case "stack":
      return { ...state, layout: stack(state.layout, action.widgetId) };
    case "add-row": {
      if (state.layout.rows.length >= WALL_MAX_ROWS) return state;
      const row: WallRow = { id: nextWallRowId(state.layout), height: "auto", widgets: [] };
      return { ...state, layout: { ...state.layout, rows: [...state.layout.rows, row] } };
    }
    case "remove-row": {
      const row = state.layout.rows.find((r) => r.id === action.rowId);
      // Only an EMPTY row goes: taking a full one would delete widgets through
      // a control whose label says nothing about them.
      if (!row || row.widgets.length > 0) return state;
      return {
        ...state,
        layout: { ...state.layout, rows: state.layout.rows.filter((r) => r.id !== action.rowId) },
      };
    }
    case "move-row": {
      const index = state.layout.rows.findIndex((r) => r.id === action.rowId);
      if (index === -1) return state;
      const to = action.direction === "up" ? index - 1 : index + 1;
      if (to < 0 || to >= state.layout.rows.length) return state;
      const rows = [...state.layout.rows];
      const [moved] = rows.splice(index, 1);
      if (!moved) return state;
      rows.splice(to, 0, moved);
      return { ...state, layout: { ...state.layout, rows } };
    }
    case "fill-row": {
      // A row inside a column toggles among its column's rows only: the column
      // is its own little Wall, with at most one row taking its remaining height.
      const place = wallRowPlaces(state.layout).find(({ row }) => row.id === action.rowId);
      if (place?.column) {
        const column = place.column;
        const clearingInner = place.row.height === "fill";
        return {
          ...state,
          layout: {
            ...state.layout,
            rows: state.layout.rows.map((row) => ({
              ...row,
              widgets: row.widgets.map((slot) =>
                slot.id === column.id && isWallColumn(slot)
                  ? {
                      ...slot,
                      rows: slot.rows.map((inner) => ({
                        ...inner,
                        height: !clearingInner && inner.id === action.rowId ? ("fill" as const) : ("auto" as const),
                      })),
                    }
                  : slot,
              ),
            })),
          },
        };
      }
      const current = state.layout.rows.find((r) => r.height === "fill");
      // Naming the row that already has it takes it away, so the control is one
      // toggle per row rather than a toggle plus a "no row" option nobody would
      // find. Every other row goes back to auto in the same move: the contract
      // allows exactly one, and two would be a refusal the operator caused by
      // pressing one button.
      const clearing = current?.id === action.rowId;
      return {
        ...state,
        layout: {
          ...state.layout,
          rows: state.layout.rows.map((row) => ({
            ...row,
            height: !clearing && row.id === action.rowId ? "fill" : "auto",
          })),
        },
      };
    }
    case "reset":
      return {
        layout: action.layout,
        saved: action.layout,
        selectedId: wallWidgetAt(action.layout, state.selectedId ?? "") ? state.selectedId : null,
      };
    case "saved":
      return { ...state, saved: action.layout };
    default:
      return state;
  }
}
