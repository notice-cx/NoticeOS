// @vitest-environment node
// The Wall layout contract: the one rule for "can the Wall draw this", the
// default arrangement, and the version history a Save and a Revert produce.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_WALL_LAYOUT,
  EMPTY_WALL_CONFIG,
  RETIRED_WALL_WIDGET_TYPES,
  WALL_LAYOUT_HISTORY_MAX,
  WALL_PRESETS,
  WALL_RETIRED_WARNING,
  WALL_WIDGET_LIBRARY,
  WALL_WIDGET_TYPES,
  isWallColumn,
  nextWallRowId,
  nextWallWidgetId,
  parseWallConfig,
  validateWallLayout,
  wallLayoutNamesRetired,
  wallLayoutWarnings,
  wallLayoutWidgets,
  wallOpRefusal,
  withRevertedWallLayout,
  withSavedWallLayout,
  type WallColumn,
  type WallLayout,
  type WallRow,
  type WallWidget,
} from "@shared/wall-layout";

function row(layout: WallLayout, index: number): WallRow {
  const found = layout.rows[index];
  if (!found) throw new Error(`no row ${index}`);
  return found;
}

function widget(layout: WallLayout, rowIndex: number, index: number): WallWidget {
  const found = row(layout, rowIndex).widgets[index];
  if (!found || isWallColumn(found)) throw new Error(`no widget ${rowIndex}/${index}`);
  return found;
}

/** One of the default body's two columns: the business (the last 24 hours
 * over the site rows) or the side (revenue over the work). */
function column(layout: WallLayout, id: "business" | "side" = "business"): WallColumn {
  const found = row(layout, 2).widgets.find((slot) => slot.id === id);
  if (!found || !isWallColumn(found)) throw new Error(`no column ${id}`);
  return found;
}

/** A widget inside one of the default's columns, by its row there and its place. */
function stacked(layout: WallLayout, id: "business" | "side", rowIndex: number, index: number): WallWidget {
  const found = column(layout, id).rows[rowIndex]?.widgets[index];
  if (!found) throw new Error(`no stacked widget ${id} ${rowIndex}/${index}`);
  return found;
}

function layoutWith(mutate: (layout: WallLayout) => void): WallLayout {
  const copy = JSON.parse(JSON.stringify(DEFAULT_WALL_LAYOUT)) as WallLayout;
  mutate(copy);
  return copy;
}

/** A layout holding only retired widgets. */
const PRE_D28 = {
  version: 1,
  rows: [
    {
      id: "horizon",
      height: "auto",
      widgets: [
        { id: "attention", type: "attention", width: 1.7 },
        { id: "portfolio", type: "portfolio", width: 0.55 },
        { id: "system", type: "system", width: 0.75 },
      ],
    },
    {
      id: "time",
      height: "auto",
      widgets: [
        { id: "clock", type: "clock", width: 0.95 },
        { id: "meetings", type: "meetings", width: 0.9 },
        { id: "countdown", type: "countdown", width: 1.3 },
      ],
    },
    { id: "assets", height: "fill", widgets: [{ id: "assets", type: "assets", width: 1 }] },
  ],
};

describe("the default layout", () => {
  it("is the strip and the loop, then the last 24 hours over the sites beside revenue over the work", () => {
    expect(DEFAULT_WALL_LAYOUT.rows.map((r) => [r.id, r.height])).toEqual([
      ["strip", "auto"],
      ["loop", "auto"],
      ["body", "fill"],
    ]);
    expect(row(DEFAULT_WALL_LAYOUT, 0).widgets.map((w) => [w.type, w.width])).toEqual([["strip", 1]]);
    expect(row(DEFAULT_WALL_LAYOUT, 1).widgets.map((w) => [w.type, w.width])).toEqual([["loop", 1]]);
    // The body: the business column at 1.4 beside the side column at 1.
    expect(row(DEFAULT_WALL_LAYOUT, 2).widgets.map((w) => [w.id, w.type, w.width])).toEqual([
      ["business", "column", 1.4],
      ["side", "column", 1],
    ]);
    const shape = (id: "business" | "side") =>
      column(DEFAULT_WALL_LAYOUT, id).rows.map((r) => [r.id, r.height, r.widgets.map((w) => [w.type, w.width])]);
    expect(shape("business")).toEqual([
      ["timeline", "auto", [["timeline", 1]]],
      ["sites", "fill", [["sites", 1]]],
    ]);
    expect(shape("side")).toEqual([
      ["money", "auto", [["revenue", 1.55]]],
      ["work", "fill", [["work", 1]]],
    ]);
  });

  it("validates, normalises to itself and raises no warning", () => {
    const check = validateWallLayout(DEFAULT_WALL_LAYOUT);
    expect(check).toEqual({ ok: true, layout: DEFAULT_WALL_LAYOUT });
    expect(wallLayoutWarnings(DEFAULT_WALL_LAYOUT)).toEqual([]);
  });

  it("places each of its widgets once, at the weight a fresh one gets, and leaves Needs attention and the feed in the library", () => {
    const placed = wallLayoutWidgets(DEFAULT_WALL_LAYOUT);
    expect(placed.map((w) => w.type)).toEqual(["strip", "loop", "timeline", "sites", "revenue", "work"]);
    for (const widget of placed) {
      expect(WALL_WIDGET_LIBRARY[widget.type].unique).toBe(true);
      // Taking a widget off and adding it back puts back the same weight.
      expect(WALL_WIDGET_LIBRARY[widget.type].defaultWidth).toBe(widget.width);
    }
    for (const type of ["needs", "feed", "agents"] as const) {
      expect(placed.some((w) => w.type === type)).toBe(false);
      expect(WALL_WIDGET_TYPES).toContain(type);
    }
  });

  it("stacks on a phone as the operator reads: the money, the sites, what is broken, what waits on the operator, the work and who did it, the loop last", () => {
    const order = [...WALL_WIDGET_TYPES].sort((a, b) => WALL_WIDGET_LIBRARY[a].stackOrder - WALL_WIDGET_LIBRARY[b].stackOrder);
    expect(order).toEqual(["strip", "revenue", "sites", "timeline", "needs", "next", "work", "agents", "feed", "loop", "health", "factory", "channels"]);
  });

  it("offers none of the retired widgets", () => {
    expect(WALL_WIDGET_TYPES).toEqual([
      "strip", "loop", "timeline", "sites", "revenue", "work", "needs", "feed", "agents", "health", "factory", "channels", "next",
    ]);
    for (const type of RETIRED_WALL_WIDGET_TYPES) {
      expect(Object.keys(WALL_WIDGET_LIBRARY)).not.toContain(type);
    }
  });
});

describe("the founder views' presets", () => {
  it("draws the default for Everything", () => {
    expect(WALL_PRESETS.everything).toBe(DEFAULT_WALL_LAYOUT);
  });

  it.each(["business", "product", "everything"] as const)("%s validates and normalises to itself", (view) => {
    expect(validateWallLayout(WALL_PRESETS[view])).toEqual({ ok: true, layout: WALL_PRESETS[view] });
  });

  it("business: the strip, Next up across the TV, then site health over revenue beside Needs attention over the agents", () => {
    const layout = WALL_PRESETS.business;
    expect(layout.rows.map((r) => [r.id, r.height])).toEqual([["strip", "auto"], ["next", "auto"], ["body", "fill"]]);
    // Alone in its row, at the content's height: the TV's full width is where Next up is shortest.
    expect(row(layout, 1).widgets).toEqual([{ id: "next", type: "next", width: 1 }]);
    const [a, b] = row(layout, 2).widgets as WallColumn[];
    expect(a?.width).toBe(1.4);
    expect(a?.rows.flatMap((inner) => inner.widgets.map((w) => w.type))).toEqual(["health", "revenue"]);
    expect(b?.rows.flatMap((inner) => inner.widgets.map((w) => w.type))).toEqual(["needs", "factory"]);
    expect(wallLayoutWarnings(layout)).toEqual([]);
  });

  it("product: the strip, then revenue over channels beside the sites over the work", () => {
    const layout = WALL_PRESETS.product;
    expect(layout.rows.map((r) => [r.id, r.height])).toEqual([["strip", "auto"], ["body", "fill"]]);
    const [a, b] = row(layout, 1).widgets as WallColumn[];
    expect(a?.rows.flatMap((inner) => inner.widgets.map((w) => w.type))).toEqual(["revenue", "channels"]);
    expect(b?.rows.flatMap((inner) => inner.widgets.map((w) => w.type))).toEqual(["sites", "work"]);
    // Sites and work both stretch, sharing the column by weight: neither is squeezed.
    expect(wallLayoutWarnings(layout).filter((warning) => warning.includes("squeezed"))).toEqual([]);
  });
});

describe("the three widgets the views brought", () => {
  it.each(["health", "factory", "channels"] as const)("%s is one of a kind, never hides, and has a floor", (type) => {
    const spec = WALL_WIDGET_LIBRARY[type];
    expect(spec.unique).toBe(true);
    expect(spec.hidesWhenEmpty).toBe(false);
    expect(spec.minWidthRem).toBeGreaterThan(0);
  });

  it("filters health and channels by site, and the agents not at all", () => {
    expect(WALL_WIDGET_LIBRARY.health.settings).toEqual(["assets"]);
    expect(WALL_WIDGET_LIBRARY.channels.settings).toEqual(["assets"]);
    expect(WALL_WIDGET_LIBRARY.factory.settings).toEqual([]);
  });

  it("counts site health as sites and as alerts on the TV", () => {
    const layout: WallLayout = { version: 1, rows: [{ id: "one", height: "fill", widgets: [{ id: "health", type: "health", width: 1 }] }] };
    expect(wallLayoutWarnings(layout)).toEqual([]);
  });
});

describe("validateWallLayout refuses, in the operator's words", () => {
  it("a widget type the Wall does not have", () => {
    const check = validateWallLayout(
      layoutWith((l) => {
        (widget(l, 0, 0) as { type: string }).type = "weather";
      }),
    );
    expect(check).toMatchObject({ ok: false, reason: expect.stringContaining("weather") });
  });

  it("a retired widget, when a fresh layout names one", () => {
    const check = validateWallLayout(
      layoutWith((l) => {
        (widget(l, 0, 0) as { type: string }).type = "attention";
      }),
    );
    expect(check).toMatchObject({ ok: false, reason: 'Row 1, widget 1 is a widget the Wall no longer draws: "attention".' });
  });

  it("a unique widget twice", () => {
    const check = validateWallLayout(
      layoutWith((l) => {
        row(l, 0).widgets.push({ id: "sites-2", type: "sites", width: 1 });
      }),
    );
    expect(check).toMatchObject({ ok: false, reason: "Sites can appear only once on the Wall." });
  });

  it("two rows that both take the remaining height", () => {
    const check = validateWallLayout(
      layoutWith((l) => {
        row(l, 0).height = "fill";
      }),
    );
    expect(check).toMatchObject({ ok: false, reason: "Only one row can take the remaining height." });
  });

  it("a width off the step grid or outside the bounds", () => {
    expect(validateWallLayout(layoutWith((l) => void (widget(l, 0, 0).width = 0.1)))).toMatchObject({ ok: false });
    expect(validateWallLayout(layoutWith((l) => void (widget(l, 0, 0).width = 1.333)))).toMatchObject({ ok: false });
    expect(validateWallLayout(layoutWith((l) => void (widget(l, 0, 0).width = 1.35)))).toMatchObject({ ok: true });
  });

  it("a setting the widget does not honour, and a malformed asset filter", () => {
    expect(
      validateWallLayout(
        layoutWith((l) => {
          (stacked(l, "side", 0, 0) as { settings: unknown }).settings = { assets: ["meadow.example"] };
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'Revenue has no "assets" setting.' });
    // An empty filter is inferred as "every asset" rather than refused (the
    // answer the editor gives when the last box is unticked), and the drawn
    // widget carries no filter at all.
    const emptied = validateWallLayout(
      layoutWith((l) => {
        stacked(l, "business", 1, 0).settings = { assets: [] };
      }),
    );
    expect(emptied.ok).toBe(true);
    expect(emptied.ok ? stacked(emptied.layout, "business", 1, 0).settings : "refused").toBeUndefined();
    expect(
      validateWallLayout(
        layoutWith((l) => {
          stacked(l, "business", 1, 0).settings = { assets: ["meadow.example", "meadow.example"] };
        }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("twice") });
  });

  it("accepts an asset filter on the per-site widgets and keeps its order", () => {
    const check = validateWallLayout(
      layoutWith((l) => {
        stacked(l, "business", 0, 0).settings = { assets: ["northwind.example", "meadow.example"] };
        stacked(l, "side", 1, 0).settings = { assets: ["meadow.example"] };
        stacked(l, "business", 1, 0).settings = { assets: ["meadow.example"] };
      }),
    );
    expect(check).toMatchObject({ ok: true });
    if (check.ok) {
      expect(stacked(check.layout, "business", 0, 0).settings).toEqual({ assets: ["northwind.example", "meadow.example"] });
      expect(stacked(check.layout, "side", 1, 0).settings).toEqual({ assets: ["meadow.example"] });
    }
    // The loop is the whole portfolio's cycle: it narrows to no site.
    expect(
      validateWallLayout(layoutWith((l) => void ((row(l, 1).widgets[0] as WallWidget).settings = { assets: ["meadow.example"] }))),
    ).toMatchObject({ ok: false, reason: 'The loop has no "assets" setting.' });
  });

  it("validates and serializes per-site pulse choices, including none", () => {
    const choices = { "meadow.example": ["leads", "accounts"], "northwind.example": [] };
    const layout = layoutWith((l) => { stacked(l, "business", 1, 0).settings = { assets: ["meadow.example"], pulseMetrics: choices }; });
    const check = validateWallLayout(layout);
    expect(check.ok).toBe(true);
    if (check.ok) expect(stacked(check.layout, "business", 1, 0).settings).toEqual({ assets: ["meadow.example"], pulseMetrics: choices });
    const roundTrip = validateWallLayout(JSON.parse(JSON.stringify(layout)));
    expect(roundTrip).toEqual(check);
  });

  it("refuses malformed pulse choices and refuses them on unrelated widgets", () => {
    for (const pulseMetrics of [[], { "meadow.example": "accounts" }, { "meadow.example": [""] }, { "meadow.example": ["leads", "leads"] }, { "bad id": ["leads"] }]) {
      const layout = layoutWith((l) => { (stacked(l, "business", 1, 0) as { settings: unknown }).settings = { pulseMetrics }; });
      expect(validateWallLayout(layout).ok).toBe(false);
    }
    const layout = layoutWith((l) => { stacked(l, "business", 0, 0).settings = { pulseMetrics: { "meadow.example": ["leads"] } }; });
    expect(validateWallLayout(layout)).toMatchObject({ ok: false, reason: 'Last 24 hours has no "pulseMetrics" setting.' });
  });
});

describe("warnings leave the decision with the operator", () => {
  it("names an empty bottom, squeezed fill widgets, and a missing Sites or problems widget", () => {
    const noFill = layoutWith((l) => void (row(l, 2).height = "auto"));
    expect(wallLayoutWarnings(noFill)).toEqual([
      "Bottom of the TV left empty",
      "Sites squeezed into a fixed-height row",
      "Work squeezed into a fixed-height row",
    ]);
    const bare: WallLayout = {
      version: 1,
      rows: [{ id: "top", height: "fill", widgets: [{ id: "strip", type: "strip", width: 1 }] }],
    };
    expect(wallLayoutWarnings(bare)).toEqual(["No sites on the TV", "No alerts on the TV"]);
    // Either the timeline or Needs attention puts the problems on the TV.
    const withNeeds: WallLayout = {
      version: 1,
      rows: [{ id: "top", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }, { id: "needs", type: "needs", width: 1 }] }],
    };
    expect(wallLayoutWarnings(withNeeds)).toEqual([]);
  });
});

describe("parseWallConfig", () => {
  it("is the default when the file has no wall", () => {
    expect(parseWallConfig(undefined)).toBe(EMPTY_WALL_CONFIG);
  });

  it("throws the validator's sentence for an undrawable saved layout", () => {
    expect(() => parseWallConfig({ layout: { version: 1, rows: [] } })).toThrow(
      "config/tower.json wall.layout: A layout needs at least one row.",
    );
  });
});

// A Wall naming retired widgets still reads, never refused, never blank, as
// the default, and the value as saved rides beside it for the editor's Save
// guard and its one warning.
describe("a layout naming retired widgets", () => {
  const saved = {
    layout: PRE_D28,
    history: [
      { savedAt: "2026-09-05T10:00:00.000Z", reason: "Alerts wider", layout: PRE_D28 },
      {
        savedAt: "2026-09-04T10:00:00.000Z",
        reason: "Sites only",
        layout: { version: 1, rows: [{ id: "only", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] }] },
      },
    ],
  };

  it("reads as the default, keeps the drawable versions, and carries the save as it was", () => {
    const before = JSON.stringify(saved);
    const config = parseWallConfig(saved);
    expect(config.layout).toEqual(DEFAULT_WALL_LAYOUT);
    // A version naming a retired widget could only be reverted to the default.
    expect(config.history.map((version) => version.reason)).toEqual(["Sites only"]);
    expect(config.retired).toEqual({ saved, replaced: true });
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("finds a retired widget stacked inside a column too", () => {
    expect(wallLayoutNamesRetired(PRE_D28)).toBe(true);
    expect(wallLayoutNamesRetired(DEFAULT_WALL_LAYOUT)).toBe(false);
    const hidden = layoutWith((l) => {
      (column(l).rows[1]!.widgets[0] as { type: string }).type = "assets";
    });
    expect(wallLayoutNamesRetired(hidden)).toBe(true);
    expect(parseWallConfig({ layout: hidden, history: [] }).layout).toEqual(DEFAULT_WALL_LAYOUT);
    // Anything that is not a layout at all is not a retired one.
    expect(wallLayoutNamesRetired(null)).toBe(false);
    expect(wallLayoutNamesRetired({ rows: "x" })).toBe(false);
  });

  it("marks only the history when the current layout is the default itself", () => {
    const config = parseWallConfig({ layout: DEFAULT_WALL_LAYOUT, history: saved.history });
    expect(config.layout).toEqual(DEFAULT_WALL_LAYOUT);
    expect(config.retired?.replaced).toBe(false);
    expect(config.history).toHaveLength(1);
  });

  it("reads the same when the Worker's parse is read again in the browser", () => {
    const once = parseWallConfig(saved);
    const twice = parseWallConfig(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });

  it("is replaced by the first Save, which writes no retired marker", () => {
    const config = parseWallConfig(saved);
    const next = withSavedWallLayout(config, layoutWith((l) => void (row(l, 2).widgets[1]!.width = 1.2)), "Wider side", "2026-09-23T12:00:00.000Z");
    expect(next).not.toHaveProperty("retired");
    // What the TV drew before the Save — the default — is the version retired.
    expect(next.history[0]).toEqual({ savedAt: "2026-09-23T12:00:00.000Z", reason: "Wider side", layout: DEFAULT_WALL_LAYOUT });
  });

  it("names its state in one editor warning", () => {
    expect(WALL_RETIRED_WARNING.split(" ").length).toBeLessThanOrEqual(12);
  });
});

describe("the write doors (wallOpRefusal)", () => {
  const op = (pointer: string, value: unknown) => ({ kind: "file-json-set", file: "config/tower.json", pointer, value });

  it("take back an old config whole — an Undo — but refuse a fresh layout that names a retired widget", () => {
    expect(wallOpRefusal(op("/wall", { layout: PRE_D28, history: [] }), "op 1")).toBeNull();
    expect(wallOpRefusal(op("/wall/layout", PRE_D28), "op 1")).toContain("a widget the Wall no longer draws");
  });

  it("refuse the read-side retired marker", () => {
    expect(
      wallOpRefusal(op("/wall", { layout: DEFAULT_WALL_LAYOUT, history: [], retired: { saved: null, replaced: true } }), "op 1"),
    ).toBe("op 1: config/tower.json /wall.retired is set when the layout is read, never saved.");
  });
});

describe("versions", () => {
  const t0 = "2026-09-05T10:00:00.000Z";
  const t1 = "2026-09-05T11:00:00.000Z";
  const wider = layoutWith((l) => void (row(l, 2).widgets[1]!.width = 2));

  it("a Save retires the current layout to the top of the history", () => {
    const next = withSavedWallLayout(EMPTY_WALL_CONFIG, wider, "Work needed more room", t0);
    expect(next.layout).toEqual(wider);
    expect(next.history).toEqual([{ savedAt: t0, reason: "Work needed more room", layout: DEFAULT_WALL_LAYOUT }]);
  });

  it("saving the same layout is not a version", () => {
    expect(withSavedWallLayout(EMPTY_WALL_CONFIG, DEFAULT_WALL_LAYOUT, "no-op", t0)).toBe(EMPTY_WALL_CONFIG);
  });

  it("a Revert is a Save of an older version, so it can itself be undone", () => {
    const saved = withSavedWallLayout(EMPTY_WALL_CONFIG, wider, "wider", t0);
    const reverted = withRevertedWallLayout(saved, 0, t1);
    expect(reverted.layout).toEqual(DEFAULT_WALL_LAYOUT);
    expect(reverted.history[0]).toEqual({
      savedAt: t1,
      reason: `Reverted to the layout saved ${t0}`,
      layout: wider,
    });
    expect(reverted.history).toHaveLength(2);
  });

  it("the history is capped", () => {
    let config = EMPTY_WALL_CONFIG;
    for (let n = 0; n < WALL_LAYOUT_HISTORY_MAX + 5; n += 1) {
      const layout = layoutWith((l) => void (row(l, 2).widgets[1]!.width = 1 + n * 0.05));
      config = withSavedWallLayout(config, layout, `step ${n}`, t0);
    }
    expect(config.history).toHaveLength(WALL_LAYOUT_HISTORY_MAX);
  });

  it("hands out ids nothing else uses, a column's rows included", () => {
    expect(nextWallWidgetId(DEFAULT_WALL_LAYOUT, "strip")).toBe("strip-2");
    expect(nextWallWidgetId(DEFAULT_WALL_LAYOUT, "column")).toBe("column");
    expect(nextWallRowId(DEFAULT_WALL_LAYOUT)).toBe("row-8");
  });
});

// A column stacks rows inside a row, one level deep, so stacks can stand side
// by side: the default's own body.
describe("a column slot", () => {
  const refusal = (mutate: (layout: WallLayout) => void) => {
    const check = validateWallLayout(layoutWith(mutate));
    return check.ok ? "accepted" : check.reason;
  };

  it("holds rows of widgets, and lists them in reading order", () => {
    expect(wallLayoutWidgets(DEFAULT_WALL_LAYOUT).map((w) => w.id)).toEqual([
      "strip",
      "loop",
      "timeline",
      "sites",
      "revenue",
      "work",
    ]);
  });

  it("refuses a column inside a column", () => {
    expect(
      refusal((l) => {
        const inner = { id: "inner", type: "column", width: 1, rows: [] };
        (column(l).rows[0]!.widgets as unknown[]).push(inner);
      }),
    ).toBe("A column cannot hold another column.");
  });

  it("refuses an empty column, and a column row with no widget", () => {
    expect(refusal((l) => void (column(l).rows = []))).toBe("Row 3, column 1 needs at least one row.");
    expect(refusal((l) => void (column(l).rows[0]!.widgets = []))).toBe(
      "Row 3, column 1, row 1 needs at least one widget.",
    );
    expect(refusal((l) => void (column(l, "side").rows = []))).toBe("Row 3, column 2 needs at least one row.");
  });

  it("refuses two rows in one column that both take its remaining height", () => {
    expect(refusal((l) => void (column(l).rows[0]!.height = "fill"))).toBe(
      "Only one row in a column can take the remaining height.",
    );
  });

  it("refuses a one-of-a-kind widget used twice across a column and its row", () => {
    expect(
      refusal((l) => {
        row(l, 0).widgets.push({ id: "sites-2", type: "sites", width: 1 });
      }),
    ).toBe("Sites can appear only once on the Wall.");
    expect(
      refusal((l) => {
        row(l, 0).widgets.push({ id: "revenue", type: "feed", width: 1 });
      }),
    ).toBe('Row 3, column 2, row 1, widget 1 repeats the widget id "revenue".');
  });

  it("warns when a fill widget in a column cannot stretch", () => {
    const squeezed = layoutWith((l) => void (column(l).rows[1]!.height = "auto"));
    expect(wallLayoutWarnings(squeezed)).toEqual(["Sites squeezed into a fixed-height row"]);
    const work = layoutWith((l) => void (column(l, "side").rows[1]!.height = "auto"));
    expect(wallLayoutWarnings(work)).toEqual(["Work squeezed into a fixed-height row"]);
  });

  it("takes a height weight on a column's row, on the width's grid, and nowhere else", () => {
    const sized = layoutWith((l) => {
      column(l).rows[0]!.size = 1;
      column(l).rows[1]!.size = 2.5;
    });
    const check = validateWallLayout(sized);
    expect(check.ok ? column(check.layout).rows.map((r) => r.size) : check.reason).toEqual([1, 2.5]);
    // Normalised like a width: the value written is the value accepted.
    const drifted = validateWallLayout(layoutWith((l) => void (column(l).rows[0]!.size = 0.25 + 0.05 * 3)));
    expect(drifted.ok ? column(drifted.layout).rows[0]?.size : null).toBe(0.4);
    expect(refusal((l) => void (column(l).rows[0]!.size = 0.1))).toBe(
      "Row 3, column 1, row 1 needs a size between 0.25 and 12 in steps of 0.05.",
    );
    expect(refusal((l) => void ((row(l, 0) as WallRow & { size?: number }).size = 1))).toBe(
      "Row 1 can take a size only inside a column.",
    );
  });

  it("keeps a layout saved without sizes byte for byte, columns included", () => {
    const saved = { layout: DEFAULT_WALL_LAYOUT, history: [] };
    const before = JSON.stringify(saved);
    expect(JSON.stringify(parseWallConfig(JSON.parse(before)))).toBe(before);
    expect(wallOpRefusal({ kind: "file-json-set", file: "config/tower.json", pointer: "/wall", value: saved }, "op 1")).toBeNull();
  });

  it("does not call a sized row inside a stretching column squeezed", () => {
    const sized = layoutWith((l) => {
      column(l).rows[1]!.height = "auto";
      column(l).rows[1]!.size = 2;
    });
    expect(wallLayoutWarnings(sized)).toEqual([]);
  });

  it("loads a saved default layout without columns unchanged", () => {
    const saved = {
      layout: {
        version: 1,
        rows: [
          {
            id: "top",
            height: "auto",
            widgets: [
              { id: "needs", type: "needs", width: 2, settings: { assets: ["northwind.example"] } },
              { id: "revenue", type: "revenue", width: 0.75 },
            ],
          },
          { id: "sites", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] },
        ],
      },
      history: [{ savedAt: "2026-09-05T10:00:00.000Z", reason: "Needs attention wider", layout: DEFAULT_WALL_LAYOUT }],
    };
    const before = JSON.stringify(saved);
    const config = parseWallConfig(saved);
    expect(JSON.stringify(config)).toBe(before);
    expect(config).not.toHaveProperty("retired");
    expect(wallLayoutWidgets(config.layout).map((w) => w.id)).toEqual(["needs", "revenue", "sites"]);
  });
});
