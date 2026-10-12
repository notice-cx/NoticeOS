// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WALL_LAYOUT,
  WALL_MAX_ROWS,
  WALL_MAX_WIDGETS_PER_ROW,
  WALL_TV_HEIGHT,
  WALL_WIDTH_MAX,
  WALL_WIDTH_MIN,
  isWallColumn,
  sameWallLayout,
  validateWallLayout,
  wallLayoutWarnings,
  wallLayoutWidgets,
  type WallColumn,
  type WallLayout,
  type WallWidgetType,
} from "@shared/wall-layout";
import {
  WALL_UNDO_LIMIT,
  roundWallWidth,
  wallAddTarget,
  wallCanRedo,
  wallCanUndo,
  wallChangeSummary,
  wallDividerSplit,
  wallDropEdge,
  wallDropPlan,
  wallEditorDirty,
  wallEditorReducer,
  wallEditorRefusal,
  wallEditorState,
  wallEditorWarnings,
  wallLibraryOptions,
  wallMovePlan,
  wallOverflowNote,
  wallPairWidths,
  wallPositionSentence,
  wallShareLabel,
  wallShareWidth,
  wallSlotMinWidth,
  wallSnapShare,
  wallStackChoices,
  wallStackShareSizes,
  wallStackSizes,
  wallTooSmall,
  wallWidgetAt,
  wallWidgetHeightIsGiven,
  wallWidthShare,
  type WallEditorAction,
  type WallEditorState,
  type WallMove,
} from "@/lib/wall-editor";

/**
 * The editor's grammar, with no DOM. Every arrangement is a reducer step or a
 * plan, so every one is checked here; the rendered tests check that a control
 * is wired to the right action. FLAT is five widgets in two plain rows; the
 * columns are exercised on the default itself.
 */

/** The widgets in two plain rows: the top line, then the rest. */
const FLAT: WallLayout = {
  version: 1,
  rows: [
    {
      id: "top",
      height: "auto",
      widgets: [
        { id: "strip", type: "strip", width: 1 },
        { id: "revenue", type: "revenue", width: 1.55 },
        { id: "needs", type: "needs", width: 1 },
      ],
    },
    {
      id: "rest",
      height: "fill",
      widgets: [
        { id: "sites", type: "sites", width: 1 },
        { id: "feed", type: "feed", width: 1 },
      ],
    },
  ],
};

function start(layout: WallLayout = FLAT): WallEditorState {
  return wallEditorState(layout);
}

function run(state: WallEditorState, ...actions: WallEditorAction[]): WallEditorState {
  return actions.reduce(wallEditorReducer, state);
}

/** Every layout an action produces must still be one the Wall could draw. */
function drawable(layout: WallLayout): boolean {
  return validateWallLayout(layout).ok;
}

/** A row of four widgets of one type: never drawable (every type is one of a
 * kind), but the target a full row is — the editor's reach, not the Wall's. */
function fullRow(id: string, type: WallWidgetType = "revenue") {
  return {
    id,
    height: "auto" as const,
    widgets: Array.from({ length: WALL_MAX_WIDGETS_PER_ROW }, (_, i) => ({ id: `${id}-${i}`, type, width: 1 })),
  };
}

const ids = (layout: WallLayout, rowIndex: number) => layout.rows[rowIndex]?.widgets.map((w) => w.id);

/** A column's widgets by row, top to bottom. */
function stack(layout: WallLayout, columnId: string): string[][] | null {
  for (const row of layout.rows) {
    const column = row.widgets.find((slot): slot is WallColumn => isWallColumn(slot) && slot.id === columnId);
    if (column) return column.rows.map((inner) => inner.widgets.map((w) => w.id));
  }
  return null;
}

function column(layout: WallLayout, columnId: string): WallColumn {
  const found = layout.rows.flatMap((row) => row.widgets).find((slot) => slot.id === columnId);
  if (!found || !isWallColumn(found)) throw new Error(`no column ${columnId}`);
  return found;
}

const drop = (layout: WallLayout, widgetId: string, onto: string, edge: "top" | "bottom" | "left" | "right") =>
  wallDropPlan(layout, { kind: "widget", widgetId }, { kind: "widget", widgetId: onto, edge });

const move = (layout: WallLayout, widgetId: string, how: WallMove) => wallMovePlan(layout, widgetId, how);

describe("the layout it starts from", () => {
  it("is the saved one, with nothing selected, nothing to save and nothing to undo", () => {
    const state = start(DEFAULT_WALL_LAYOUT);
    expect(state.layout).toBe(DEFAULT_WALL_LAYOUT);
    expect(state.saved).toBe(DEFAULT_WALL_LAYOUT);
    expect(state.selectedId).toBeNull();
    expect(wallEditorDirty(state)).toBe(false);
    expect(wallCanUndo(state)).toBe(false);
    expect(wallCanRedo(state)).toBe(false);
    expect(wallEditorRefusal(state.layout)).toBeNull();
  });

  it("draws a layout saved by the earlier editor exactly as saved: nothing is tidied on the way in", () => {
    // A column of one widget and a column with no row taking its height are
    // both things this editor would tidy away; opening one changes nothing.
    const older: WallLayout = {
      version: 1,
      rows: [
        { id: "a", height: "auto", widgets: [{ id: "column", type: "column", width: 2, rows: [{ id: "r1", height: "auto", widgets: [{ id: "strip", type: "strip", width: 1 }] }] }] },
        { id: "b", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1.4, settings: { assets: ["meadow.example"] } }, { id: "col-2", type: "column", width: 1, rows: [{ id: "r2", height: "auto", widgets: [{ id: "revenue", type: "revenue", width: 1.55 }, { id: "needs", type: "needs", width: 1 }] }, { id: "r3", height: "auto", widgets: [{ id: "work", type: "work", width: 1 }] }] }] },
      ],
    };
    const state = start(older);
    expect(state.layout).toBe(older);
    expect(wallEditorDirty(state)).toBe(false);
    const checked = validateWallLayout(older);
    expect(checked.ok && sameWallLayout(checked.layout, older)).toBe(true);
  });
});

describe("adding a widget", () => {
  it("puts a widget back in the last row with room that suits it, and selects it", () => {
    const without = run(start(), { type: "remove", widgetId: "revenue" });
    const state = run(without, { type: "add", widget: "revenue" });
    const at = wallWidgetAt(state.layout, "revenue");
    expect(at?.row.id).toBe("top");
    expect(at?.index).toBe(2);
    expect(state.selectedId).toBe("revenue");
    expect(drawable(state.layout)).toBe(true);
  });

  it("gives a fresh widget the library's own default width", () => {
    const state = run(start(), { type: "remove", widgetId: "revenue" }, { type: "add", widget: "revenue" });
    expect(wallWidgetAt(state.layout, "revenue")?.widget.width).toBe(1.55);
  });

  it("sends a widget that wants the remaining height to the row that has it", () => {
    const bare: WallLayout = {
      version: 1,
      rows: [
        { id: "top", height: "auto", widgets: [{ id: "strip", type: "strip", width: 1 }] },
        { id: "rest", height: "fill", widgets: [{ id: "needs", type: "needs", width: 1 }] },
      ],
    };
    const state = run(start(bare), { type: "add", widget: "sites" });
    expect(wallWidgetAt(state.layout, "sites")?.row.id).toBe("rest");
  });

  it("puts the loop back beside the strip once its own row has gone with it", () => {
    const without = run(start(DEFAULT_WALL_LAYOUT), { type: "remove", widgetId: "loop" });
    expect(without.layout.rows.map((row) => row.id)).toEqual(["strip", "body"]);
    expect(wallEditorRefusal(without.layout)).toBeNull();
    const state = run(without, { type: "add", widget: "loop" });
    expect(ids(state.layout, 0)).toEqual(["strip", "loop"]);
    expect(drawable(state.layout)).toBe(true);
  });

  it("adds the feed the default leaves out beside its two columns, in the row that takes the remaining height", () => {
    const state = run(start(DEFAULT_WALL_LAYOUT), { type: "add", widget: "feed" });
    expect(ids(state.layout, 2)).toEqual(["business", "side", "feed"]);
    expect(drawable(state.layout)).toBe(true);
  });

  it("grows a row only when no row has room", () => {
    const layout: WallLayout = {
      version: 1,
      rows: [
        {
          id: "r1",
          height: "auto",
          widgets: [
            { id: "strip", type: "strip", width: 1 },
            { id: "revenue", type: "revenue", width: 1 },
            { id: "needs", type: "needs", width: 1 },
            { id: "sites", type: "sites", width: 1 },
          ],
        },
      ],
    };
    expect(wallAddTarget(layout, "feed")).toEqual({ newRow: true });
    const state = run(start(layout), { type: "add", widget: "feed" });
    expect(state.layout.rows).toHaveLength(2);
    expect(ids(state.layout, 1)).toEqual(["feed"]);
  });

  it("has nowhere to put one when every row is full and the Wall holds its six", () => {
    const layout: WallLayout = {
      version: 1,
      rows: Array.from({ length: WALL_MAX_ROWS }, (_, row) => fullRow(`r${row + 1}`)),
    };
    expect(wallAddTarget(layout, "feed")).toBeNull();
    const state = run(start(layout), { type: "add", widget: "feed" });
    expect(state.layout).toBe(layout);
    expect(wallLibraryOptions(layout).find((o) => o.spec.type === "feed")?.disabledReason).toBe("TV full");
  });
});

/** A version saved with no note is named by what changed. */
describe("the version's description when there is no note", () => {
  it("names what was added, removed and resized", () => {
    const before = run(start(), { type: "remove", widgetId: "feed" }).layout;
    let state = start(before);
    state = run(state, { type: "remove", widgetId: "needs" });
    expect(wallChangeSummary(before, state.layout)).toBe("Removed Needs attention");
    state = run(state, { type: "add", widget: "feed" });
    state = run(state, { type: "widths", widths: { revenue: 1.6 } });
    expect(wallChangeSummary(before, state.layout)).toBe(
      "Added Live feed · removed Needs attention · resized Revenue",
    );
  });

  it("does not call a widget moved because a neighbour left its row", () => {
    const state = run(start(), { type: "remove", widgetId: "strip" });
    expect(wallChangeSummary(FLAT, state.layout)).toBe("Removed Top strip");
  });

  it("names the widget that moved, not the one whose column closed around it", () => {
    const layout = drop(DEFAULT_WALL_LAYOUT, "work", "sites", "top")!.layout;
    expect(wallChangeSummary(DEFAULT_WALL_LAYOUT, layout)).toBe("Moved Work");
  });

  it("names a stack as one move: the widget stacked onto keeps its place", () => {
    const layout = drop(FLAT, "needs", "feed", "bottom")!.layout;
    expect(wallChangeSummary(FLAT, layout)).toBe("Moved Needs attention");
  });

  it("names a row swap as rearranged rows", () => {
    const layout = move(DEFAULT_WALL_LAYOUT, "strip", "down")!;
    expect(wallChangeSummary(DEFAULT_WALL_LAYOUT, layout)).toBe("Rearranged rows");
  });
});

describe("the Add drawer's rows", () => {
  it("shows every widget of the default as placed and offers the two it leaves out, while the write lane still refuses a second", () => {
    expect(wallLibraryOptions(DEFAULT_WALL_LAYOUT).map((o) => [o.spec.type, o.disabledReason])).toEqual([
      ["strip", "On the TV"],
      ["loop", "On the TV"],
      ["timeline", "On the TV"],
      ["sites", "On the TV"],
      ["revenue", "On the TV"],
      ["work", "On the TV"],
      ["needs", null],
      ["feed", null],
    ]);
    const twice: WallLayout = {
      version: 1,
      rows: [{ id: "one", height: "fill", widgets: [{ id: "a", type: "needs", width: 1 }, { id: "b", type: "needs", width: 1 }] }],
    };
    const check = validateWallLayout(twice);
    expect(check.ok ? null : check.reason).toBe("Needs attention can appear only once on the Wall.");
  });

  it("offers a widget again once it is taken off", () => {
    const state = run(start(DEFAULT_WALL_LAYOUT), { type: "remove", widgetId: "work" });
    const options = wallLibraryOptions(state.layout);
    expect(options.filter((o) => o.disabledReason === null).map((o) => o.spec.type)).toEqual(["work", "needs", "feed"]);
  });
});

describe("removing a widget", () => {
  it("takes it out and drops the selection with it", () => {
    const state = run(start(), { type: "select", widgetId: "needs" }, { type: "remove", widgetId: "needs" });
    expect(wallWidgetAt(state.layout, "needs")).toBeNull();
    expect(state.selectedId).toBeNull();
    expect(drawable(state.layout)).toBe(true);
  });

  it("takes an emptied row with it, so a layout is never left with a hole", () => {
    const state = run(start(), { type: "remove", widgetId: "sites" }, { type: "remove", widgetId: "feed" });
    expect(state.layout.rows.map((row) => row.id)).toEqual(["top"]);
    expect(wallEditorRefusal(state.layout)).toBeNull();
  });

  it("keeps a selection that was not the widget removed", () => {
    const state = run(start(), { type: "select", widgetId: "strip" }, { type: "remove", widgetId: "needs" });
    expect(state.selectedId).toBe("strip");
  });

  it("turns a column left with one widget back into that widget, in the column's place and width", () => {
    const state = run(start(DEFAULT_WALL_LAYOUT), { type: "remove", widgetId: "timeline" });
    expect(ids(state.layout, 2)).toEqual(["sites", "side"]);
    expect(state.layout.rows[2]?.widgets[0]).toEqual({ id: "sites", type: "sites", width: 1.4 });
    expect(drawable(state.layout)).toBe(true);
  });
});

describe("widths and the site filter", () => {
  it("lands a width on the step grid however the arithmetic drifted", () => {
    const state = run(start(), { type: "widths", widths: { strip: 0.25 + 0.05 * 3 } });
    expect(wallWidgetAt(state.layout, "strip")?.widget.width).toBe(0.4);
    expect(drawable(state.layout)).toBe(true);
  });

  it("clamps to the contract's bounds rather than producing a layout nobody can save", () => {
    expect(roundWallWidth(-4)).toBe(WALL_WIDTH_MIN);
    expect(roundWallWidth(99)).toBe(WALL_WIDTH_MAX);
    const state = run(start(), { type: "widths", widths: { strip: 99 } });
    expect(drawable(state.layout)).toBe(true);
  });

  it("sets a column's width by its id, as a divider between columns does", () => {
    const state = run(start(DEFAULT_WALL_LAYOUT), { type: "widths", widths: { business: 1.2, side: 1.2 } });
    expect(column(state.layout, "business").width).toBe(1.2);
    expect(column(state.layout, "side").width).toBe(1.2);
  });

  it("is read as the share of the row it actually takes", () => {
    const row = FLAT.rows[0]!;
    expect(Math.round(wallWidthShare(row, "revenue"))).toBe(44);
    expect(Math.round(wallWidthShare(row, "strip"))).toBe(28);
    expect(wallWidthShare(row, "not-here")).toBe(0);
  });

  it("writes the site filter on the widget and takes it off again; an empty one is every site", () => {
    const filtered = run(start(), { type: "settings", widgetId: "sites", settings: { assets: ["meadow.example"] } });
    expect(wallWidgetAt(filtered.layout, "sites")?.widget.settings).toEqual({ assets: ["meadow.example"] });
    const cleared = run(filtered, { type: "settings", widgetId: "sites", settings: { assets: [] } });
    expect(wallWidgetAt(cleared.layout, "sites")?.widget).not.toHaveProperty("settings");
    expect(drawable(cleared.layout)).toBe(true);
  });
});

// Dropping onto a widget's top or bottom edge stacks the two in one column.
describe("dropping onto a top or bottom edge", () => {
  it("stacks into the target's column, above it, keeping the moved widget's own row", () => {
    const plan = drop(DEFAULT_WALL_LAYOUT, "work", "sites", "top")!;
    expect(stack(plan.layout, "business")).toEqual([["timeline"], ["work"], ["sites"]]);
    // The side column is left with revenue alone, so it becomes revenue again.
    expect(plan.layout.rows[2]?.widgets.map((w) => w.id)).toEqual(["business", "revenue"]);
    expect(plan.line).toEqual({ anchor: "widget", id: "sites", edge: "top" });
    expect(plan.widgetId).toBe("work");
    // One row still takes the column's remaining height: the site rows'.
    expect(column(plan.layout, "business").rows.map((r) => r.height)).toEqual(["auto", "auto", "fill"]);
    expect(drawable(plan.layout)).toBe(true);
  });

  it("makes a plain widget a column of the two, in its own place and width", () => {
    const plan = drop(FLAT, "needs", "feed", "bottom")!;
    const made = plan.layout.rows[1]?.widgets[1];
    expect(made && isWallColumn(made) ? made.width : null).toBe(1);
    expect(made && isWallColumn(made) ? made.rows.map((r) => r.widgets.map((w) => w.id)) : null).toEqual([["feed"], ["needs"]]);
    // The feed wants the height left over, so its row takes it.
    expect(made && isWallColumn(made) ? made.rows.map((r) => r.height) : null).toEqual(["fill", "auto"]);
    expect(ids(plan.layout, 0)).toEqual(["strip", "revenue"]);
    expect(drawable(plan.layout)).toBe(true);
  });

  it("stacks above a whole row of a column when that row holds several widgets", () => {
    const layout: WallLayout = {
      version: 1,
      rows: [{ id: "body", height: "fill", widgets: [{ id: "business", type: "column", width: 3, rows: [
        { id: "money", height: "auto", widgets: [{ id: "revenue", type: "revenue", width: 1.55 }, { id: "needs", type: "needs", width: 1 }] },
        { id: "sites", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] },
      ] }, { id: "feed", type: "feed", width: 1 }] }],
    };
    const plan = drop(layout, "feed", "needs", "top")!;
    expect(plan.line).toEqual({ anchor: "row", id: "money", edge: "top" });
    expect(stack(plan.layout, "business")).toEqual([["feed"], ["revenue", "needs"], ["sites"]]);
  });

  it("refuses a seventh widget in one column", () => {
    const tall: WallLayout = {
      version: 1,
      rows: [
        { id: "a", height: "fill", widgets: [{ id: "column", type: "column", width: 1, rows: (["strip", "loop", "timeline", "sites", "revenue", "work"] as const).map((type) => ({ id: `r-${type}`, height: "auto" as const, widgets: [{ id: type, type, width: 1 }] })) }] },
        { id: "b", height: "auto", widgets: [{ id: "needs", type: "needs", width: 1 }] },
      ],
    };
    expect(drop(tall, "needs", "sites", "top")).toBeNull();
  });
});

// Dropping onto a left or right edge makes a new column beside it.
describe("dropping onto a left or right edge", () => {
  it("takes half of the slot it lands beside", () => {
    const plan = drop(FLAT, "feed", "revenue", "right")!;
    expect(plan.layout.rows[0]?.widgets.map((w) => [w.id, w.width])).toEqual([
      ["strip", 1], ["revenue", 0.8], ["feed", 0.8], ["needs", 1],
    ]);
    expect(plan.line).toEqual({ anchor: "widget", id: "revenue", edge: "right" });
    expect(drawable(plan.layout)).toBe(true);
  });

  it("only reorders, every width kept, among the row's own widgets", () => {
    const plan = drop(FLAT, "strip", "needs", "right")!;
    expect(plan.layout.rows[0]?.widgets.map((w) => [w.id, w.width])).toEqual([
      ["revenue", 1.55], ["needs", 1], ["strip", 1],
    ]);
  });

  it("splits a widget out of a column into a column of its own beside it", () => {
    const plan = drop(DEFAULT_WALL_LAYOUT, "timeline", "sites", "left")!;
    expect(plan.line).toEqual({ anchor: "slot", id: "business", edge: "left" });
    expect(plan.layout.rows[2]?.widgets.map((w) => [w.id, w.width])).toEqual([
      ["timeline", 0.7], ["sites", 0.7], ["side", 1],
    ]);
    expect(drawable(plan.layout)).toBe(true);
  });

  it("will not put a fifth widget in a row", () => {
    const layout: WallLayout = {
      version: 1,
      rows: [fullRow("full", "revenue"), { id: "other", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] }],
    };
    expect(drop(layout, "sites", "full-1", "left")).toBeNull();
  });
});

describe("dropping between rows", () => {
  it("starts a new row there", () => {
    const plan = wallDropPlan(FLAT, { kind: "widget", widgetId: "needs" }, { kind: "gap", index: 2 })!;
    expect(plan.layout.rows.map((row) => row.widgets.map((w) => w.id))).toEqual([["strip", "revenue"], ["sites", "feed"], ["needs"]]);
    expect(plan.line).toEqual({ anchor: "gap", index: 2 });
  });

  it("moves a widget alone in its row with its row, id and height kept", () => {
    const plan = wallDropPlan(DEFAULT_WALL_LAYOUT, { kind: "widget", widgetId: "strip" }, { kind: "gap", index: 2 })!;
    expect(plan.layout.rows.map((row) => row.id)).toEqual(["loop", "strip", "body"]);
    for (const index of [0, 1]) {
      expect(wallDropPlan(DEFAULT_WALL_LAYOUT, { kind: "widget", widgetId: "strip" }, { kind: "gap", index })).toBeNull();
    }
  });

  it("refuses a seventh row", () => {
    const six: WallLayout = {
      version: 1,
      rows: (["strip", "loop", "timeline", "sites", "revenue", "work"] as const).map((type) => ({ id: `r-${type}`, height: type === "sites" ? "fill" as const : "auto" as const, widgets: [{ id: type, type, width: 1 }] })),
    };
    expect(wallDropPlan(six, { kind: "new", widget: "needs" }, { kind: "gap", index: 6 })).toBeNull();
    // Moving one of the six into a gap is fine: its own row goes.
    expect(wallDropPlan(six, { kind: "widget", widgetId: "strip" }, { kind: "gap", index: 6 })).not.toBeNull();
  });
});

describe("dropping a widget from the Add drawer", () => {
  it("places a new one where the line says, and names it", () => {
    const plan = wallDropPlan(DEFAULT_WALL_LAYOUT, { kind: "new", widget: "feed" }, { kind: "widget", widgetId: "work", edge: "right" })!;
    expect(plan.widgetId).toBe("feed");
    expect(plan.layout.rows[2]?.widgets.map((w) => [w.id, w.width])).toEqual([["business", 1.4], ["side", 0.5], ["feed", 0.5]]);
    expect(drawable(plan.layout)).toBe(true);
  });

  it("refuses a second of a one-of-a-kind widget", () => {
    expect(wallDropPlan(DEFAULT_WALL_LAYOUT, { kind: "new", widget: "sites" }, { kind: "gap", index: 0 })).toBeNull();
  });
});

describe("drops that do nothing", () => {
  it("refuses a widget dropped on itself, or back where it is", () => {
    expect(drop(FLAT, "strip", "strip", "left")).toBeNull();
    expect(drop(FLAT, "strip", "revenue", "left")).toBeNull();
    expect(drop(DEFAULT_WALL_LAYOUT, "timeline", "sites", "top")).toBeNull();
  });
});

describe("the Move menu", () => {
  it("steps down through a column, the widget keeping its row's height", () => {
    const layout = move(DEFAULT_WALL_LAYOUT, "revenue", "down")!;
    expect(stack(layout, "side")).toEqual([["work"], ["revenue"]]);
    expect(column(layout, "side").rows.map((r) => r.height)).toEqual(["fill", "auto"]);
  });

  it("steps up out of the top of a column into a row of its own", () => {
    const layout = move(DEFAULT_WALL_LAYOUT, "timeline", "up")!;
    expect(layout.rows.map((row) => row.widgets.map((w) => w.id))).toEqual([["strip"], ["loop"], ["timeline"], ["sites", "side"]]);
  });

  it("takes a widget alone in its row up or down with its row, and stops at the ends", () => {
    expect(move(DEFAULT_WALL_LAYOUT, "strip", "down")?.rows.map((row) => row.id)).toEqual(["loop", "strip", "body"]);
    expect(move(DEFAULT_WALL_LAYOUT, "strip", "up")).toBeNull();
  });

  it("steps left into the neighbouring column at the same height", () => {
    const layout = move(DEFAULT_WALL_LAYOUT, "revenue", "left")!;
    expect(stack(layout, "business")).toEqual([["revenue"], ["timeline"], ["sites"]]);
    expect(layout.rows[2]?.widgets.map((w) => w.id)).toEqual(["business", "work"]);
  });

  it("swaps places with a single widget beside a single widget", () => {
    expect(move(FLAT, "revenue", "left")?.rows[0]?.widgets.map((w) => w.id)).toEqual(["revenue", "strip", "needs"]);
    expect(move(FLAT, "strip", "left")).toBeNull();
  });

  it("stacks a single widget onto a single widget beside a stacked one", () => {
    const layout = move(DEFAULT_WALL_LAYOUT, "work", "right")!;
    expect(layout.rows[2]?.widgets.map((w) => w.id)).toEqual(["business", "revenue", "work"]);
  });

  it("takes a widget into a column of its own beside its column", () => {
    const layout = move(DEFAULT_WALL_LAYOUT, "work", "own-column")!;
    expect(layout.rows[2]?.widgets.map((w) => [w.id, w.width])).toEqual([["business", 1.4], ["revenue", 0.5], ["work", 0.5]]);
    expect(move(FLAT, "strip", "own-column")).toBeNull();
  });

  it("takes a widget into a new row above or below its own", () => {
    expect(move(DEFAULT_WALL_LAYOUT, "sites", "row-below")?.rows.map((row) => row.widgets.map((w) => w.id))).toEqual([
      ["strip"], ["loop"], ["timeline", "side"], ["sites"],
    ]);
    expect(move(FLAT, "needs", "row-above")?.rows.map((row) => row.widgets.map((w) => w.id))).toEqual([
      ["needs"], ["strip", "revenue"], ["sites", "feed"],
    ]);
    expect(move(DEFAULT_WALL_LAYOUT, "strip", "row-below")).toBeNull();
  });

  it("stacks a widget under any other one it names", () => {
    const layout = move(DEFAULT_WALL_LAYOUT, "work", { under: "strip" })!;
    expect(layout.rows[0]?.widgets[0]?.type).toBe("column");
    expect(wallStackChoices(DEFAULT_WALL_LAYOUT, "work").map((w) => w.id)).toEqual(["strip", "loop", "timeline", "sites"]);
  });

  it("leaves every layout drawable, from every widget, in every direction", () => {
    const moves: WallMove[] = ["up", "down", "left", "right", "own-column", "row-above", "row-below"];
    for (const layout of [FLAT, DEFAULT_WALL_LAYOUT]) {
      for (const widget of wallLayoutWidgets(layout)) {
        for (const how of moves) {
          const next = move(layout, widget.id, how);
          if (next) expect(drawable(next), `${widget.id} ${String(how)}`).toBe(true);
        }
      }
    }
  });

  it("says where the widget is, for the announcement", () => {
    expect(wallPositionSentence(DEFAULT_WALL_LAYOUT, "revenue")).toBe("Revenue: row 3 of 3, column 2 of 2, 1 of 2 in its column");
    expect(wallPositionSentence(FLAT, "needs")).toBe("Needs attention: row 1 of 2, column 3 of 3");
  });
});

describe("undo and redo", () => {
  it("goes back through every change and forward again", () => {
    const a = run(start(DEFAULT_WALL_LAYOUT), { type: "move", widgetId: "revenue", move: "left" });
    const b = run(a, { type: "remove", widgetId: "loop" });
    const back = run(b, { type: "undo" });
    expect(back.layout).toBe(a.layout);
    const first = run(back, { type: "undo" });
    expect(first.layout).toBe(DEFAULT_WALL_LAYOUT);
    expect(wallCanUndo(first)).toBe(false);
    const again = run(first, { type: "redo" }, { type: "redo" });
    expect(again.layout).toBe(b.layout);
    expect(wallCanRedo(again)).toBe(false);
  });

  it("forgets what Redo had once something new is done", () => {
    const state = run(start(), { type: "remove", widgetId: "needs" }, { type: "undo" }, { type: "remove", widgetId: "strip" });
    expect(wallCanRedo(state)).toBe(false);
  });

  it("takes a whole divider drag back in one step", () => {
    const state = run(
      start(DEFAULT_WALL_LAYOUT),
      { type: "widths", widths: { business: 1.3, side: 1.1 }, gesture: "g1" },
      { type: "widths", widths: { business: 1.2, side: 1.2 }, gesture: "g1" },
      { type: "widths", widths: { business: 1.1, side: 1.3 }, gesture: "g1" },
    );
    expect(state.past).toHaveLength(1);
    expect(run(state, { type: "undo" }).layout).toBe(DEFAULT_WALL_LAYOUT);
  });

  it("records nothing for a change that changes nothing", () => {
    const state = run(start(), { type: "widths", widths: { strip: 1 } }, { type: "select", widgetId: "strip" });
    expect(wallCanUndo(state)).toBe(false);
  });

  it("can take a Discard back", () => {
    const changed = run(start(), { type: "remove", widgetId: "needs" });
    const discarded = run(changed, { type: "discard" });
    expect(discarded.layout).toBe(FLAT);
    expect(wallEditorDirty(discarded)).toBe(false);
    expect(run(discarded, { type: "undo" }).layout).toBe(changed.layout);
  });

  it("keeps its steps when the same saved layout arrives again, and starts afresh on a new one", () => {
    const changed = run(start(), { type: "remove", widgetId: "needs" }, { type: "undo" });
    expect(run(changed, { type: "reset", layout: FLAT }).future).toHaveLength(1);
    expect(run(changed, { type: "reset", layout: DEFAULT_WALL_LAYOUT }).future).toHaveLength(0);
  });

  it("keeps at most its limit of steps", () => {
    let state = start();
    for (let i = 0; i < WALL_UNDO_LIMIT + 10; i += 1) {
      state = run(state, { type: "widths", widths: { strip: i % 2 === 0 ? 1.5 : 1 } });
    }
    expect(state.past).toHaveLength(WALL_UNDO_LIMIT);
  });
});

describe("heights", () => {
  it("gives the remaining height to one top-level row and takes it from the other", () => {
    const state = run(start(), { type: "fill", rowId: "top" });
    expect(state.layout.rows.map((row) => row.height)).toEqual(["fill", "auto"]);
    expect(run(state, { type: "fit", rowId: "top" }).layout.rows.map((row) => row.height)).toEqual(["auto", "auto"]);
  });

  it("fills one of a column's rows, taking the column back to fill and fit", () => {
    const sized = run(start(DEFAULT_WALL_LAYOUT), { type: "sizes", sizes: { timeline: 1, sites: 2 } });
    expect(column(sized.layout, "business").rows.map((r) => r.size)).toEqual([1, 2]);
    const filled = run(sized, { type: "fill", rowId: "timeline" });
    expect(column(filled.layout, "business").rows.map((r) => [r.height, r.size])).toEqual([["fill", undefined], ["auto", undefined]]);
    expect(drawable(filled.layout)).toBe(true);
  });

  it("takes a size off a row", () => {
    const sized = run(start(DEFAULT_WALL_LAYOUT), { type: "sizes", sizes: { timeline: 1 } }, { type: "sizes", sizes: { timeline: null } });
    expect(column(sized.layout, "business").rows[0]).not.toHaveProperty("size");
  });

  it("gives a stacked widget a share of its column", () => {
    const business = column(DEFAULT_WALL_LAYOUT, "business");
    expect(wallStackShareSizes(business, "timeline", 1 / 3)).toEqual({ timeline: 1, sites: 2 });
    expect(wallStackShareSizes(business, "timeline", 1 / 2)).toEqual({ timeline: 1.5, sites: 1.5 });
  });

  it("turns a stacked divider's drag into weights that keep the other rows' heights", () => {
    const business = column(DEFAULT_WALL_LAYOUT, "business");
    expect(wallStackSizes(business, [120, 680], 0, 0.5)).toEqual({ timeline: 1, sites: 1 });
    const three: WallColumn = {
      id: "c",
      type: "column",
      width: 1,
      rows: [
        { id: "a", height: "auto", widgets: [{ id: "needs", type: "needs", width: 1 }] },
        { id: "b", height: "fill", widgets: [{ id: "work", type: "work", width: 1 }] },
        { id: "c", height: "auto", size: 2, widgets: [{ id: "feed", type: "feed", width: 1 }] },
      ],
    };
    expect(wallStackSizes(three, [100, 300, 400], 0, 0.25)).toEqual({ a: 0.5, b: 1.5 });
  });

  it("knows when a widget's height is given rather than its content's", () => {
    expect(wallWidgetHeightIsGiven(DEFAULT_WALL_LAYOUT, "sites")).toBe(true);
    expect(wallWidgetHeightIsGiven(DEFAULT_WALL_LAYOUT, "timeline")).toBe(false);
    expect(wallWidgetHeightIsGiven(DEFAULT_WALL_LAYOUT, "strip")).toBe(false);
  });
});

describe("dividers and size presets", () => {
  it("keeps a pair's total weight as its divider moves", () => {
    expect(wallPairWidths(1.4, 1, 0.5)).toEqual([1.2, 1.2]);
    expect(wallPairWidths(1, 1, 0.25)).toEqual([0.5, 1.5]);
  });

  it("gives one slot a preset share of its row, the others keeping theirs", () => {
    const top = FLAT.rows[0]!.widgets;
    const width = wallShareWidth(top, "strip", 1 / 3)!;
    expect(width).toBe(1.25);
    expect(Math.abs(width / (width + 2.55) - 1 / 3)).toBeLessThan(0.012);
    expect(wallShareWidth([{ id: "only", type: "strip", width: 1 }], "only", 1 / 2)).toBeNull();
  });

  it("snaps to a preset share when within a step, and names it", () => {
    expect(wallSnapShare(0.34)).toEqual({ share: 1 / 3, label: "⅓" });
    expect(wallSnapShare(0.4).label).toBeNull();
    expect(wallShareLabel(0.5)).toBe("½");
    expect(wallShareLabel(0.38)).toBe("38%");
  });

  it("splits at the pointer, snaps to halves of the widgets' own space, and stops at a minimum", () => {
    const items = [{ start: 0, size: 600 }, { start: 620, size: 400 }];
    // Pointer at 505: the first widget would take 495 of 1000 — a half.
    const half = wallDividerSplit({ items, index: 0, pointer: 505 });
    expect(half.snapped).toBe("½");
    expect(half.ratio).toBeCloseTo(0.5);
    expect(wallShareLabel(half.firstShare)).toBe("½");
    const free = wallDividerSplit({ items, index: 0, pointer: 410 });
    expect(free.snapped).toBeNull();
    expect(free.ratio).toBeCloseTo(0.4);
    const stopped = wallDividerSplit({ items, index: 0, pointer: 100, minFirst: 300 });
    expect(stopped.ratio).toBeCloseTo(0.3);
    expect(stopped.snapped).toBeNull();
  });

  it("knows the narrowest a column stays legible at: its widest row's widgets side by side", () => {
    expect(wallSlotMinWidth(column(DEFAULT_WALL_LAYOUT, "business"))).toBe(880);
  });

  it("names a widget drawn below its legible size, and never a short one whose content sets its height", () => {
    expect(wallTooSmall("sites", { width: 600, height: 800 }, true)).toBe("narrow");
    expect(wallTooSmall("sites", { width: 1000, height: 200 }, true)).toBe("short");
    expect(wallTooSmall("sites", { width: 1000, height: 200 }, false)).toBeNull();
    expect(wallTooSmall("feed", { width: 400, height: 900 }, true)).toBeNull();
  });
});

describe("the edge a drop lands on", () => {
  it("is the nearest edge as a share of the widget, so a long thin widget still has sides", () => {
    const strip = { left: 0, top: 0, width: 1800, height: 60 };
    expect(wallDropEdge(strip, 90, 30)).toBe("left");
    expect(wallDropEdge(strip, 1750, 30)).toBe("right");
    expect(wallDropEdge(strip, 900, 10)).toBe("top");
    expect(wallDropEdge(strip, 900, 55)).toBe("bottom");
  });
});

describe("what the operator is told beside Save", () => {
  it("warns about squeezed site rows without refusing them", () => {
    const state = run(start(), { type: "fill", rowId: "top" });
    expect(wallEditorRefusal(state.layout)).toBeNull();
    expect(wallEditorWarnings(state.layout)).toContain("Sites squeezed into a fixed-height row");
  });

  it("does not call a sized row inside a stretching column squeezed", () => {
    const sized = run(start(DEFAULT_WALL_LAYOUT), { type: "sizes", sizes: { timeline: 1, sites: 1 } });
    const unfilled = run(sized, { type: "fit", rowId: "sites" });
    expect(column(unfilled.layout, "business").rows[1]?.size).toBeUndefined();
    expect(wallLayoutWarnings(sized.layout)).toEqual([]);
  });

  it("counts the pixels a layout runs past the TV, and stays quiet when it fits", () => {
    expect(wallOverflowNote(WALL_TV_HEIGHT + 128)).toBe("This layout runs 128 px past the TV.");
    expect(wallOverflowNote(WALL_TV_HEIGHT)).toBeNull();
    expect(wallOverflowNote(0)).toBeNull();
    expect(wallOverflowNote(Number.NaN)).toBeNull();
  });
});

describe("dirty and save", () => {
  it("is dirty after a change and clean again once the write lands, without redrawing anything", () => {
    const changed = run(start(), { type: "remove", widgetId: "needs" });
    expect(wallEditorDirty(changed)).toBe(true);
    const saved = run(changed, { type: "saved", layout: changed.layout });
    expect(wallEditorDirty(saved)).toBe(false);
    expect(saved.layout).toBe(changed.layout);
  });

  it("drops a selection the new saved layout no longer holds, and keeps one it does", () => {
    const state = run(start(), { type: "select", widgetId: "needs" });
    expect(run(state, { type: "reset", layout: DEFAULT_WALL_LAYOUT }).selectedId).toBeNull();
    const sites = run(start(), { type: "select", widgetId: "sites" });
    expect(run(sites, { type: "reset", layout: DEFAULT_WALL_LAYOUT }).selectedId).toBe("sites");
  });

  it("selects what a drop or a move brought", () => {
    const dropped = run(start(DEFAULT_WALL_LAYOUT), { type: "drop", source: { kind: "new", widget: "needs" }, target: { kind: "gap", index: 0 } });
    expect(dropped.selectedId).toBe("needs");
    const moved = run(start(DEFAULT_WALL_LAYOUT), { type: "move", widgetId: "work", move: "own-column" });
    expect(moved.selectedId).toBe("work");
  });
});
