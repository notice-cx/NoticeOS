// @vitest-environment node
// The Wall layout contract (epic ro-lzmq): the one rule for "can the Wall draw
// this", the default — D28's arrangement since bead ro-trai.11 — and the
// version history a Save and a Revert produce.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_WALL_LAYOUT,
  EMPTY_WALL_CONFIG,
  RETIRED_WALL_WIDGET_TYPES,
  WALL_LAYOUT_HISTORY_MAX,
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

/** The default's column: revenue beside Needs you, over the site rows. */
function column(layout: WallLayout): WallColumn {
  const found = row(layout, 1).widgets[0];
  if (!found || !isWallColumn(found)) throw new Error("no column");
  return found;
}

/** A widget inside the default's column, by its row there and its place. */
function stacked(layout: WallLayout, rowIndex: number, index: number): WallWidget {
  const found = column(layout).rows[rowIndex]?.widgets[index];
  if (!found) throw new Error(`no stacked widget ${rowIndex}/${index}`);
  return found;
}

function layoutWith(mutate: (layout: WallLayout) => void): WallLayout {
  const copy = JSON.parse(JSON.stringify(DEFAULT_WALL_LAYOUT)) as WallLayout;
  mutate(copy);
  return copy;
}

/** A layout saved before D28: only widgets D28 retired. */
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

describe("the default layout is D28 (docs/14-design.md § Regions)", () => {
  it("is the strip, then a column of revenue beside Needs you over the sites, beside the feed", () => {
    expect(DEFAULT_WALL_LAYOUT.rows.map((r) => [r.id, r.height])).toEqual([
      ["strip", "auto"],
      ["body", "fill"],
    ]);
    expect(row(DEFAULT_WALL_LAYOUT, 0).widgets.map((w) => [w.type, w.width])).toEqual([["strip", 1]]);
    // The body: the column at 3.1 beside the feed at 1 (≈1,390 px to 440 px).
    expect(row(DEFAULT_WALL_LAYOUT, 1).widgets.map((w) => [w.type, w.width])).toEqual([
      ["column", 3.1],
      ["feed", 1],
    ]);
    expect(column(DEFAULT_WALL_LAYOUT).rows.map((r) => [r.id, r.height, r.widgets.map((w) => [w.type, w.width])])).toEqual([
      ["money", "auto", [["revenue", 1.55], ["needs", 1]]],
      ["sites", "fill", [["sites", 1]]],
    ]);
  });

  it("validates, normalises to itself and raises no warning", () => {
    const check = validateWallLayout(DEFAULT_WALL_LAYOUT);
    expect(check).toEqual({ ok: true, layout: DEFAULT_WALL_LAYOUT });
    expect(wallLayoutWarnings(DEFAULT_WALL_LAYOUT)).toEqual([]);
  });

  it("uses every widget the library declares exactly once, at the weight a fresh one gets", () => {
    const placed = wallLayoutWidgets(DEFAULT_WALL_LAYOUT);
    expect(placed.map((w) => w.type).sort()).toEqual([...WALL_WIDGET_TYPES].sort());
    for (const type of WALL_WIDGET_TYPES) {
      expect(WALL_WIDGET_LIBRARY[type].unique).toBe(true);
      // Taking a widget off and adding it back puts back the same Wall.
      expect(WALL_WIDGET_LIBRARY[type].defaultWidth).toBe(placed.find((w) => w.type === type)?.width);
    }
  });

  it("offers none of the widgets D28 retired", () => {
    expect(WALL_WIDGET_TYPES).toEqual(["strip", "revenue", "needs", "sites", "feed"]);
    for (const type of RETIRED_WALL_WIDGET_TYPES) {
      expect(Object.keys(WALL_WIDGET_LIBRARY)).not.toContain(type);
    }
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

  it("a widget D28 retired, when a fresh layout names one", () => {
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
          (stacked(l, 0, 0) as { settings: unknown }).settings = { assets: ["meals.example"] };
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'Revenue has no "assets" setting.' });
    // An empty filter is inferred as "every asset" rather than refused (bead
    // `ro-ujb9.96.6.17`) — the answer the editor gives when the last box is
    // unticked — and the drawn widget carries no filter at all.
    const emptied = validateWallLayout(
      layoutWith((l) => {
        stacked(l, 1, 0).settings = { assets: [] };
      }),
    );
    expect(emptied.ok).toBe(true);
    expect(emptied.ok ? stacked(emptied.layout, 1, 0).settings : "refused").toBeUndefined();
    expect(
      validateWallLayout(
        layoutWith((l) => {
          stacked(l, 1, 0).settings = { assets: ["meals.example", "meals.example"] };
        }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("twice") });
  });

  it("accepts an asset filter on the two per-site widgets and keeps its order", () => {
    const check = validateWallLayout(
      layoutWith((l) => {
        stacked(l, 0, 1).settings = { assets: ["nosh.example", "meals.example"] };
        stacked(l, 1, 0).settings = { assets: ["meals.example"] };
      }),
    );
    expect(check).toMatchObject({ ok: true });
    if (check.ok) {
      expect(stacked(check.layout, 0, 1).settings).toEqual({ assets: ["nosh.example", "meals.example"] });
    }
  });

  it("validates and serializes per-site pulse choices, including none", () => {
    const choices = { "meals.example": ["leads", "accounts"], "nosh.example": [] };
    const layout = layoutWith((l) => { stacked(l, 1, 0).settings = { assets: ["meals.example"], pulseMetrics: choices }; });
    const check = validateWallLayout(layout);
    expect(check.ok).toBe(true);
    if (check.ok) expect(stacked(check.layout, 1, 0).settings).toEqual({ assets: ["meals.example"], pulseMetrics: choices });
    const roundTrip = validateWallLayout(JSON.parse(JSON.stringify(layout)));
    expect(roundTrip).toEqual(check);
  });

  it("refuses malformed pulse choices and refuses them on unrelated widgets", () => {
    for (const pulseMetrics of [[], { "meals.example": "accounts" }, { "meals.example": [""] }, { "meals.example": ["leads", "leads"] }, { "bad id": ["leads"] }]) {
      const layout = layoutWith((l) => { (stacked(l, 1, 0) as { settings: unknown }).settings = { pulseMetrics }; });
      expect(validateWallLayout(layout).ok).toBe(false);
    }
    const layout = layoutWith((l) => { stacked(l, 0, 1).settings = { pulseMetrics: { "meals.example": ["leads"] } }; });
    expect(validateWallLayout(layout)).toMatchObject({ ok: false, reason: 'Needs you has no "pulseMetrics" setting.' });
  });
});

describe("warnings leave the decision with the operator", () => {
  it("names an empty bottom, squeezed fill widgets, and a missing Sites or Needs you widget", () => {
    const noFill = layoutWith((l) => void (row(l, 1).height = "auto"));
    expect(wallLayoutWarnings(noFill)).toEqual([
      "Bottom of the TV left empty",
      "Sites squeezed into a fixed-height row",
      "Live feed squeezed into a fixed-height row",
    ]);
    const bare: WallLayout = {
      version: 1,
      rows: [{ id: "top", height: "fill", widgets: [{ id: "strip", type: "strip", width: 1 }] }],
    };
    expect(wallLayoutWarnings(bare)).toEqual(["No sites on the TV", "No alerts on the TV"]);
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

// Bead ro-trai.11: a Wall saved before D28 names retired widgets. It still
// reads — never refused, never blank — as the D28 default, and the value as
// saved rides beside it for the editor's Save guard and its one warning.
describe("a layout saved before D28", () => {
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

  it("reads as the D28 default, keeps the drawable versions, and carries the save as it was", () => {
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

  it("marks only the history when the current layout is D28's own", () => {
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
    const next = withSavedWallLayout(config, layoutWith((l) => void (row(l, 1).widgets[1]!.width = 1.2)), "Wider feed", "2026-09-23T12:00:00.000Z");
    expect(next).not.toHaveProperty("retired");
    // What the TV drew before the Save — the default — is the version retired.
    expect(next.history[0]).toEqual({ savedAt: "2026-09-23T12:00:00.000Z", reason: "Wider feed", layout: DEFAULT_WALL_LAYOUT });
  });

  it("names its state in one editor warning", () => {
    expect(WALL_RETIRED_WARNING.split(" ").length).toBeLessThanOrEqual(12);
  });
});

describe("the write doors (wallOpRefusal)", () => {
  const op = (pointer: string, value: unknown) => ({ kind: "file-json-set", file: "config/tower.json", pointer, value });

  it("take back a pre-D28 config whole — an Undo — but refuse a fresh layout that names a retired widget", () => {
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
  const wider = layoutWith((l) => void (row(l, 1).widgets[1]!.width = 2));

  it("a Save retires the current layout to the top of the history", () => {
    const next = withSavedWallLayout(EMPTY_WALL_CONFIG, wider, "Feed needed more room", t0);
    expect(next.layout).toEqual(wider);
    expect(next.history).toEqual([{ savedAt: t0, reason: "Feed needed more room", layout: DEFAULT_WALL_LAYOUT }]);
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
      const layout = layoutWith((l) => void (row(l, 1).widgets[1]!.width = 1 + n * 0.05));
      config = withSavedWallLayout(config, layout, `step ${n}`, t0);
    }
    expect(config.history).toHaveLength(WALL_LAYOUT_HISTORY_MAX);
  });

  it("hands out ids nothing else uses, a column's rows included", () => {
    expect(nextWallWidgetId(DEFAULT_WALL_LAYOUT, "strip")).toBe("strip-2");
    expect(nextWallWidgetId(DEFAULT_WALL_LAYOUT, "column")).toBe("column");
    expect(nextWallRowId(DEFAULT_WALL_LAYOUT)).toBe("row-5");
  });
});

// Bead ro-trai.2 (docs/14-design.md § Regions): a column stacks rows inside a
// row, one level deep, so one widget can run the full height beside several —
// the default's own body.
describe("a column slot", () => {
  const refusal = (mutate: (layout: WallLayout) => void) => {
    const check = validateWallLayout(layoutWith(mutate));
    return check.ok ? "accepted" : check.reason;
  };

  it("holds rows of widgets, and lists them in reading order", () => {
    expect(wallLayoutWidgets(DEFAULT_WALL_LAYOUT).map((w) => w.id)).toEqual([
      "strip",
      "revenue",
      "needs",
      "sites",
      "feed",
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
    expect(refusal((l) => void (column(l).rows = []))).toBe("Row 2, column 1 needs at least one row.");
    expect(refusal((l) => void (column(l).rows[0]!.widgets = []))).toBe(
      "Row 2, column 1, row 1 needs at least one widget.",
    );
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
    ).toBe('Row 2, column 1, row 1, widget 1 repeats the widget id "revenue".');
  });

  it("warns when a fill widget in a column cannot stretch", () => {
    const squeezed = layoutWith((l) => void (column(l).rows[1]!.height = "auto"));
    expect(wallLayoutWarnings(squeezed)).toEqual(["Sites squeezed into a fixed-height row"]);
  });

  it("loads a saved D28 layout without columns unchanged", () => {
    const saved = {
      layout: {
        version: 1,
        rows: [
          {
            id: "top",
            height: "auto",
            widgets: [
              { id: "needs", type: "needs", width: 2, settings: { assets: ["nosh.example"] } },
              { id: "revenue", type: "revenue", width: 0.75 },
            ],
          },
          { id: "sites", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] },
        ],
      },
      history: [{ savedAt: "2026-09-05T10:00:00.000Z", reason: "Needs you wider", layout: DEFAULT_WALL_LAYOUT }],
    };
    const before = JSON.stringify(saved);
    const config = parseWallConfig(saved);
    expect(JSON.stringify(config)).toBe(before);
    expect(config).not.toHaveProperty("retired");
    expect(wallLayoutWidgets(config.layout).map((w) => w.id)).toEqual(["needs", "revenue", "sites"]);
  });
});
