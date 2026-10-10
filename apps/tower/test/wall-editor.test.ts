// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WALL_LAYOUT,
  WALL_MAX_ROWS,
  WALL_MAX_WIDGETS_PER_ROW,
  WALL_TV_HEIGHT,
  WALL_WIDTH_MAX,
  WALL_WIDTH_MIN,
  sameWallLayout,
  validateWallLayout,
  wallLayoutWidgets,
  type WallLayout,
  type WallWidgetType,
} from "@shared/wall-layout";
import {
  canNudge,
  canStack,
  roundWallWidth,
  wallAddTarget,
  wallChangeSummary,
  wallEditorDirty,
  wallEditorReducer,
  wallEditorRefusal,
  wallEditorState,
  wallEditorWarnings,
  wallLibraryOptions,
  wallOverflowNote,
  wallWidgetAt,
  wallWidthShare,
  type WallEditorAction,
  type WallEditorState,
} from "@/lib/wall-editor";

/**
 * The editor's grammar, with no DOM. Every arrangement is a reducer step, so
 * every one is checked here; the rendered tests check that a control is wired
 * to the right action. The grammar is exercised on FLAT (the five widgets in
 * two plain rows) and the column on the default itself.
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

/** Every layout an action produces must still be one the Wall could draw, or
 * the refusal has to be a sentence — never a crash and never a silent no-op. */
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

describe("the layout it starts from", () => {
  it("is the saved one, with nothing selected and nothing to save", () => {
    const state = start(DEFAULT_WALL_LAYOUT);
    expect(state.layout).toBe(DEFAULT_WALL_LAYOUT);
    expect(state.saved).toBe(DEFAULT_WALL_LAYOUT);
    expect(state.selectedId).toBeNull();
    expect(wallEditorDirty(state)).toBe(false);
    expect(wallEditorRefusal(state.layout)).toBeNull();
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

  it("puts the feed taken off the default back beside the column, where it was", () => {
    const without = run(start(DEFAULT_WALL_LAYOUT), { type: "remove", widgetId: "feed" });
    const state = run(without, { type: "add", widget: "feed" });
    expect(sameWallLayout(state.layout, DEFAULT_WALL_LAYOUT)).toBe(true);
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
    // The library says so as a state in the Add button's place.
    expect(wallLibraryOptions(layout).find((o) => o.spec.type === "feed")?.disabledReason).toBe("TV full");
  });
});

/** A version saved with no note is named by what changed. */
describe("the version's description when there is no note", () => {
  it("names what was added, removed and resized", () => {
    const before = run(start(), { type: "remove", widgetId: "feed" }).layout;
    let state = start(before);
    state = run(state, { type: "remove", widgetId: "needs" });
    expect(wallChangeSummary(before, state.layout)).toBe("Removed Needs you");
    state = run(state, { type: "add", widget: "feed" });
    state = run(state, { type: "width", widgetId: "revenue", width: 1.6 });
    expect(wallChangeSummary(before, state.layout)).toBe(
      "Added Live feed · removed Needs you · resized Revenue",
    );
  });

  it("does not call a widget moved because a neighbour left its row", () => {
    const state = run(start(), { type: "remove", widgetId: "strip" });
    expect(wallChangeSummary(FLAT, state.layout)).toBe("Removed Top strip");
  });

  it("names a nudge as a move and a row change as rearranged rows", () => {
    const nudged = run(start(), { type: "nudge", widgetId: "revenue", direction: "left" });
    expect(wallChangeSummary(FLAT, nudged.layout)).toContain("oved");
    const rows = run(start(), { type: "move-row", rowId: "rest", direction: "up" });
    expect(wallChangeSummary(FLAT, rows.layout)).toBe("Rearranged rows");
  });
});

describe("the library panel's rows", () => {
  it("shows every widget of the default as placed, while the write lane still refuses a second", () => {
    expect(wallLibraryOptions(DEFAULT_WALL_LAYOUT).map((o) => o.disabledReason)).toEqual(
      Array(5).fill("On the TV"),
    );
    // The write lane's own refusal is unchanged: a layout with two reaches it
    // only by hand, and gets the validator's sentence.
    const twice: WallLayout = {
      version: 1,
      rows: [
        {
          id: "one",
          height: "fill",
          widgets: [
            { id: "a", type: "needs", width: 1 },
            { id: "b", type: "needs", width: 1 },
          ],
        },
      ],
    };
    const check = validateWallLayout(twice);
    expect(check.ok ? null : check.reason).toBe("Needs you can appear only once on the Wall.");
  });

  it("offers a widget again once it is taken off", () => {
    const state = run(start(DEFAULT_WALL_LAYOUT), { type: "remove", widgetId: "feed" });
    const options = wallLibraryOptions(state.layout);
    expect(options.filter((o) => o.disabledReason === null).map((o) => o.spec.type)).toEqual(["feed"]);
  });

  it("lists every type the contract has, in its order", () => {
    expect(wallLibraryOptions(DEFAULT_WALL_LAYOUT).map((o) => o.spec.type)).toEqual([
      "strip",
      "revenue",
      "needs",
      "sites",
      "feed",
    ]);
  });
});

describe("removing a widget", () => {
  it("takes it out and drops the selection with it", () => {
    const state = run(
      start(),
      { type: "select", widgetId: "needs" },
      { type: "remove", widgetId: "needs" },
    );
    expect(wallWidgetAt(state.layout, "needs")).toBeNull();
    expect(state.selectedId).toBeNull();
    expect(drawable(state.layout)).toBe(true);
  });

  it("leaves the row it emptied, and the validator says the row is empty", () => {
    const state = run(
      start(),
      { type: "remove", widgetId: "sites" },
      { type: "remove", widgetId: "feed" },
    );
    expect(state.layout.rows).toHaveLength(2);
    expect(wallEditorRefusal(state.layout)).toBe("Row 2 needs at least one widget.");
  });

  it("keeps a selection that was not the widget removed", () => {
    const state = run(
      start(),
      { type: "select", widgetId: "strip" },
      { type: "remove", widgetId: "needs" },
    );
    expect(state.selectedId).toBe("strip");
  });
});

describe("width", () => {
  it("lands on the step grid however the arithmetic drifted", () => {
    const state = run(start(), { type: "width", widgetId: "strip", width: 0.25 + 0.05 * 3 });
    expect(wallWidgetAt(state.layout, "strip")?.widget.width).toBe(0.4);
    expect(drawable(state.layout)).toBe(true);
  });

  it("clamps to the contract's bounds rather than producing a layout nobody can save", () => {
    expect(roundWallWidth(-4)).toBe(WALL_WIDTH_MIN);
    expect(roundWallWidth(99)).toBe(WALL_WIDTH_MAX);
    const state = run(start(), { type: "width", widgetId: "strip", width: 99 });
    expect(drawable(state.layout)).toBe(true);
  });

  it("is read as the share of the row it actually takes", () => {
    const row = FLAT.rows[0]!;
    // 1.55 of 1 + 1.55 + 1 = 3.55
    expect(Math.round(wallWidthShare(row, "revenue"))).toBe(44);
    expect(Math.round(wallWidthShare(row, "strip"))).toBe(28);
    expect(wallWidthShare(row, "not-here")).toBe(0);
  });
});

describe("the site filter", () => {
  it("is written on the widget and taken off again", () => {
    const filtered = run(start(), {
      type: "settings",
      widgetId: "sites",
      settings: { assets: ["meadow.example"] },
    });
    expect(wallWidgetAt(filtered.layout, "sites")?.widget.settings).toEqual({
      assets: ["meadow.example"],
    });
    expect(drawable(filtered.layout)).toBe(true);

    const cleared = run(filtered, { type: "settings", widgetId: "sites", settings: undefined });
    expect(wallWidgetAt(cleared.layout, "sites")?.widget).not.toHaveProperty("settings");
    expect(drawable(cleared.layout)).toBe(true);
  });

  // An empty list is inferred, not refused: it is the answer unticking the
  // last box gives, "every site", so the widget simply carries no filter.
  it("an empty list reads as every site: the widget drops its filter", () => {
    const state = run(start(), {
      type: "settings",
      widgetId: "sites",
      settings: { assets: [] },
    });
    expect(wallEditorRefusal(state.layout)).toBeNull();
    const sites = wallLayoutWidgets(state.layout).find((w) => w.id === "sites");
    expect(sites?.settings).toBeUndefined();
  });
});

describe("arranging by drag", () => {
  it("moves a widget into another row at the index it was dropped on", () => {
    const state = run(start(), { type: "move", widgetId: "feed", toRowId: "top", toIndex: 1 });
    expect(ids(state.layout, 0)).toEqual(["strip", "feed", "revenue", "needs"]);
    expect(ids(state.layout, 1)).toEqual(["sites"]);
    expect(drawable(state.layout)).toBe(true);
  });

  it("moves rightwards inside one row to the place the operator aimed at", () => {
    const state = run(start(), { type: "move", widgetId: "strip", toRowId: "top", toIndex: 3 });
    expect(ids(state.layout, 0)).toEqual(["revenue", "needs", "strip"]);
  });

  it("will not drop a fifth widget into a full row", () => {
    const full: WallLayout = {
      version: 1,
      rows: [
        {
          id: "full",
          height: "auto",
          widgets: [
            { id: "strip", type: "strip", width: 1 },
            { id: "revenue", type: "revenue", width: 1 },
            { id: "needs", type: "needs", width: 1 },
            { id: "feed", type: "feed", width: 1 },
          ],
        },
        { id: "rest", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] },
      ],
    };
    const state = run(start(full), { type: "move", widgetId: "sites", toRowId: "full", toIndex: 0 });
    expect(state.layout).toBe(full);
  });

  it("ignores a drop on a row that is not there", () => {
    const state = run(start(), { type: "move", widgetId: "strip", toRowId: "nowhere", toIndex: 0 });
    expect(state.layout).toBe(FLAT);
  });
});

describe("arranging by button", () => {
  it("swaps with the neighbour on the left and back again", () => {
    const left = run(start(), { type: "nudge", widgetId: "revenue", direction: "left" });
    expect(ids(left.layout, 0)).toEqual(["revenue", "strip", "needs"]);
    const back = run(left, { type: "nudge", widgetId: "revenue", direction: "right" });
    expect(ids(back.layout, 0)).toEqual(["strip", "revenue", "needs"]);
  });

  it("moves up into the same place in the row above", () => {
    const state = run(start(), { type: "nudge", widgetId: "sites", direction: "up" });
    expect(ids(state.layout, 0)).toEqual(["sites", "strip", "revenue", "needs"]);
  });

  it("clamps the place to a shorter row rather than leaving a gap", () => {
    const state = run(
      start({
        version: 1,
        rows: [
          { id: "top", height: "auto", widgets: [{ id: "strip", type: "strip", width: 1 }] },
          {
            id: "rest",
            height: "fill",
            widgets: [
              { id: "revenue", type: "revenue", width: 1 },
              { id: "needs", type: "needs", width: 1 },
              { id: "sites", type: "sites", width: 1 },
            ],
          },
        ],
      }),
      { type: "nudge", widgetId: "sites", direction: "up" },
    );
    expect(ids(state.layout, 0)).toEqual(["strip", "sites"]);
  });

  it("says which directions are dead, so a button can be disabled", () => {
    expect(canNudge(FLAT, "strip", "left")).toBe(false);
    expect(canNudge(FLAT, "strip", "up")).toBe(false);
    expect(canNudge(FLAT, "strip", "right")).toBe(true);
    expect(canNudge(FLAT, "strip", "down")).toBe(true);
    expect(canNudge(FLAT, "sites", "down")).toBe(false);
  });

  it("cannot nudge into a full row", () => {
    const layout: WallLayout = {
      version: 1,
      rows: [fullRow("full"), { id: "rest", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] }],
    };
    expect(canNudge(layout, "sites", "up")).toBe(false);
  });
});

describe("rows", () => {
  it("adds one, and the validator asks for a widget in it", () => {
    const state = run(start(), { type: "add-row" });
    expect(state.layout.rows).toHaveLength(3);
    expect(state.layout.rows[2]?.id).toBe("row-3");
    expect(wallEditorRefusal(state.layout)).toBe("Row 3 needs at least one widget.");
  });

  it("stops at the Wall's six", () => {
    let state = start();
    for (let i = 0; i < 10; i += 1) state = run(state, { type: "add-row" });
    expect(state.layout.rows).toHaveLength(WALL_MAX_ROWS);
  });

  it("removes an empty row and refuses a full one", () => {
    const withEmpty = run(start(), { type: "add-row" });
    const removed = run(withEmpty, { type: "remove-row", rowId: "row-3" });
    expect(removed.layout.rows).toHaveLength(2);
    const kept = run(start(), { type: "remove-row", rowId: "top" });
    expect(kept.layout.rows).toHaveLength(2);
  });

  it("reorders", () => {
    const state = run(start(), { type: "move-row", rowId: "rest", direction: "up" });
    expect(state.layout.rows.map((r) => r.id)).toEqual(["rest", "top"]);
    const back = run(state, { type: "move-row", rowId: "rest", direction: "down" });
    expect(back.layout.rows.map((r) => r.id)).toEqual(["top", "rest"]);
  });

  it("does not walk a row off either end", () => {
    const up = run(start(), { type: "move-row", rowId: "top", direction: "up" });
    expect(up.layout.rows.map((r) => r.id)).toEqual(["top", "rest"]);
    const down = run(start(), { type: "move-row", rowId: "rest", direction: "down" });
    expect(down.layout.rows.map((r) => r.id)).toEqual(["top", "rest"]);
  });

  it("moves the remaining height to one row and only one", () => {
    const state = run(start(), { type: "fill-row", rowId: "top" });
    expect(state.layout.rows.map((r) => r.height)).toEqual(["fill", "auto"]);
    expect(drawable(state.layout)).toBe(true);
  });

  it("takes the remaining height away when the row that has it is named again", () => {
    const state = run(start(), { type: "fill-row", rowId: "rest" });
    expect(state.layout.rows.every((r) => r.height === "auto")).toBe(true);
    expect(wallEditorWarnings(state.layout)).toContain("Bottom of the TV left empty");
  });
});

describe("what the operator is told beside Save", () => {
  it("warns about squeezed site rows without refusing them", () => {
    const state = run(start(), { type: "fill-row", rowId: "top" });
    expect(wallEditorRefusal(state.layout)).toBeNull();
    expect(wallEditorWarnings(state.layout)).toContain("Sites squeezed into a fixed-height row");
  });

  it("says nothing about a layout it cannot draw — the refusal is the message", () => {
    const state = run(start(), { type: "add-row" });
    expect(wallEditorWarnings(state.layout)).toEqual([]);
  });

  it("counts the pixels a layout runs past the TV, and stays quiet when it fits", () => {
    expect(wallOverflowNote(WALL_TV_HEIGHT + 128)).toBe("This layout runs 128 px past the TV.");
    expect(wallOverflowNote(WALL_TV_HEIGHT)).toBeNull();
    expect(wallOverflowNote(0)).toBeNull();
    expect(wallOverflowNote(Number.NaN)).toBeNull();
  });
});

describe("dirty, discard and save", () => {
  it("is dirty after a change and clean again once discarded", () => {
    const changed = run(start(), { type: "remove", widgetId: "needs" });
    expect(wallEditorDirty(changed)).toBe(true);
    const discarded = run(changed, { type: "reset", layout: changed.saved });
    expect(wallEditorDirty(discarded)).toBe(false);
    expect(discarded.layout).toBe(FLAT);
  });

  it("is clean again once the write lands, without redrawing anything", () => {
    const changed = run(start(), { type: "remove", widgetId: "needs" });
    const saved = run(changed, { type: "saved", layout: changed.layout });
    expect(wallEditorDirty(saved)).toBe(false);
    expect(saved.layout).toBe(changed.layout);
  });

  it("drops a selection the new saved layout no longer holds", () => {
    const state = run(start(), { type: "select", widgetId: "needs" });
    const reset = run(state, {
      type: "reset",
      layout: { version: 1, rows: [{ id: "one", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] }] },
    });
    expect(reset.selectedId).toBeNull();
  });

  it("keeps a selection the new saved layout still holds", () => {
    const state = run(start(), { type: "select", widgetId: "sites" });
    const reset = run(state, { type: "reset", layout: DEFAULT_WALL_LAYOUT });
    expect(reset.selectedId).toBe("sites");
  });
});

// A widget goes into a column and comes back out, and a column is a
// container: it never outlives the last widget in it.
describe("stacking in a column", () => {
  const columnOf = (layout: WallLayout, rowId: string) => {
    const slot = layout.rows.find((r) => r.id === rowId)?.widgets.find((w) => w.type === "column");
    return slot && slot.type === "column" ? slot : null;
  };
  const stackedIds = (layout: WallLayout, rowId: string) =>
    columnOf(layout, rowId)?.rows.map((r) => r.widgets.map((w) => w.id));

  it("wraps a widget in a column in its own place and at its own width", () => {
    const state = run(start(), { type: "stack", widgetId: "revenue" });
    expect(columnOf(state.layout, "top")).toMatchObject({ id: "column", width: 1.55 });
    expect(stackedIds(state.layout, "top")).toEqual([["revenue"]]);
    expect(ids(state.layout, 0)).toEqual(["strip", "column", "needs"]);
    expect(wallWidgetAt(state.layout, "revenue")?.column?.id).toBe("column");
    expect(drawable(state.layout)).toBe(true);
  });

  it("stacks a second widget of the same row under the first", () => {
    const state = run(start(), { type: "stack", widgetId: "revenue" }, { type: "stack", widgetId: "needs" });
    expect(stackedIds(state.layout, "top")).toEqual([["revenue"], ["needs"]]);
    expect(ids(state.layout, 0)).toEqual(["strip", "column"]);
    expect(drawable(state.layout)).toBe(true);
  });

  it("puts a dropped widget into the column row it lands on", () => {
    const stacked = run(start(), { type: "stack", widgetId: "revenue" });
    const innerRow = columnOf(stacked.layout, "top")!.rows[0]!.id;
    const state = run(stacked, { type: "move", widgetId: "feed", toRowId: innerRow, toIndex: 1 });
    expect(columnOf(state.layout, "top")?.rows[0]?.widgets.map((w) => w.id)).toEqual(["revenue", "feed"]);
    expect(ids(state.layout, 1)).toEqual(["sites"]);
    expect(drawable(state.layout)).toBe(true);
  });

  it("takes a widget back out, and the emptied column goes with it", () => {
    const stacked = run(start(), { type: "stack", widgetId: "revenue" });
    expect(canStack(stacked.layout, "revenue")).toBe(true);
    const out = run(stacked, { type: "stack", widgetId: "revenue" });
    expect(out.layout).toEqual(FLAT);
    expect(wallEditorDirty(out)).toBe(false);
  });

  it("takes one widget out beside the column and keeps the rest stacked", () => {
    const stacked = run(
      start(),
      { type: "stack", widgetId: "revenue" },
      { type: "stack", widgetId: "needs" },
      { type: "stack", widgetId: "revenue" },
    );
    expect(ids(stacked.layout, 0)).toEqual(["strip", "column", "revenue"]);
    expect(stackedIds(stacked.layout, "top")).toEqual([["needs"]]);
    expect(drawable(stacked.layout)).toBe(true);
  });

  it("gives a column row its column's remaining height, and only there", () => {
    const stacked = run(start(), { type: "stack", widgetId: "revenue" }, { type: "stack", widgetId: "needs" });
    const inner = columnOf(stacked.layout, "top")!.rows[1]!.id;
    const state = run(stacked, { type: "fill-row", rowId: inner });
    expect(columnOf(state.layout, "top")?.rows.map((r) => r.height)).toEqual(["auto", "fill"]);
    // The Wall's own fill row is untouched by a column's.
    expect(state.layout.rows.map((r) => r.height)).toEqual(["auto", "fill"]);
    expect(drawable(state.layout)).toBe(true);
  });

  it("nudges up and down among the column's own rows", () => {
    const stacked = run(start(), { type: "stack", widgetId: "revenue" }, { type: "stack", widgetId: "needs" });
    expect(canNudge(stacked.layout, "revenue", "up")).toBe(false);
    const state = run(stacked, { type: "nudge", widgetId: "needs", direction: "up" });
    expect(stackedIds(state.layout, "top")).toEqual([["needs", "revenue"]]);
  });

  it("counts every stacked widget as on the Wall", () => {
    const state = run(start(), { type: "stack", widgetId: "revenue" });
    const revenue = wallLibraryOptions(state.layout).find((o) => o.spec.type === "revenue");
    expect(revenue?.disabledReason).toBe("On the TV");
    // The neighbours kept their places; only the stacked widget moved.
    expect(wallChangeSummary(FLAT, state.layout)).toBe("Moved Revenue · rearranged rows");
  });

  it("takes the site rows out of the default's column, beside it, in one press", () => {
    const state = run(start(DEFAULT_WALL_LAYOUT), { type: "stack", widgetId: "sites" });
    expect(ids(state.layout, 1)).toEqual(["business", "sites", "feed"]);
    expect(stackedIds(state.layout, "body")).toEqual([["revenue", "needs"]]);
  });
});
