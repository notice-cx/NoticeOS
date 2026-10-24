// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_WALL_TV_PREVIEW, parseWallConfig, validateWallLayout, wallLayoutWidgets, withRevertedWallLayout, withSavedWallLayout, type WallLayout } from "@shared/wall-layout";
import { WALL_WIDGET_MIN_PX, wallEditorReducer, wallEditorState, wallFullComposition } from "@/lib/wall-editor";

const saved: WallLayout = {
  version: 1,
  tileTransparency: 50,
  tileSurfaces: false,
  tvPreview: structuredClone(DEFAULT_WALL_TV_PREVIEW),
  weather: { enabled: false, unit: "celsius", location: { mode: "automatic" } },
  rows: [
    { id: "strip", height: "auto", widgets: [{ id: "strip", type: "strip", width: 1 }] },
    { id: "body", height: "fill", widgets: [
      { id: "business", type: "column", width: 3.25, rows: [
        { id: "work", height: "auto", widgets: [{ id: "work", type: "work", width: 1 }] },
        { id: "sites", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1, settings: { assets: ["example.com"], rowBackground: false, pulseMetrics: { "example.com": ["orders"] }, metrics: [{ id: "today", source: "today", display: "number", size: "wide" }] } }] },
      ] },
      { id: "side", type: "column", width: 1, rows: [
        { id: "money", height: "auto", widgets: [{ id: "revenue", type: "revenue", width: 1.55 }] },
        { id: "needs", height: "auto", widgets: [{ id: "needs", type: "needs", width: 1, settings: { assets: ["example.com"] } }] },
        { id: "feed", height: "fill", widgets: [{ id: "feed", type: "feed", width: 1 }] },
      ] },
    ] },
  ],
};

describe("attention ticker layout compatibility", () => {
  it("parses existing attention-card placement and history without moving or rewriting it", () => {
    const config = { layout: saved, history: [{ layout: saved, reason: "Saved arrangement", savedAt: "2026-10-24T00:00:00Z" }] };
    expect(validateWallLayout(saved)).toEqual({ ok: true, layout: saved });
    expect(parseWallConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
  });

  it("moves attention only through explicit full composition and retains settings plus exact Undo/history", () => {
    const before = structuredClone(saved);
    const full = wallFullComposition(saved);
    const find = (layout: WallLayout, type: string) => wallLayoutWidgets(layout).find(widget => widget.type === type)!;
    const business = full.rows[1]!.widgets[0]!;
    const side = full.rows[1]!.widgets[1]!;
    expect(business.type === "column" && business.rows.map(row => row.id)).toEqual(["work", "needs", "sites"]);
    expect(side.type === "column" && side.rows.map(row => [row.id, row.height])).toEqual([["money", "auto"], ["feed", "fill"]]);
    expect(full).toMatchObject({ tileTransparency: saved.tileTransparency, tileSurfaces: saved.tileSurfaces, tvPreview: saved.tvPreview, weather: saved.weather });
    expect(find(full, "sites").settings).toEqual(find(saved, "sites").settings);
    expect(find(full, "needs").settings).toEqual(find(saved, "needs").settings);
    const changed = wallEditorReducer(wallEditorState(saved), { type: "replace", layout: full });
    expect(changed.past).toHaveLength(1);
    expect(wallEditorReducer(changed, { type: "undo" }).layout).toEqual(saved);
    const config = withSavedWallLayout({ layout: saved, history: [] }, full, "Use ticker layout", "2026-10-24T01:00:00Z");
    expect(withRevertedWallLayout(config, 0, "2026-10-24T02:00:00Z").layout).toEqual(saved);
    find(full, "needs").settings!.assets!.push("other.example.com");
    expect(saved).toEqual(before);
  });

  it("uses a single-line ticker floor without changing the saved row height grammar", () => {
    expect(WALL_WIDGET_MIN_PX.needs).toEqual({ width: 260, height: 40 });
    const stretched = structuredClone(saved);
    const side = stretched.rows[1]!.widgets[1]!;
    if (side.type !== "column") throw new Error("Expected saved side column");
    side.rows[1]!.height = "fill";
    side.rows[2]!.height = "auto";
    expect(validateWallLayout(stretched).ok).toBe(true);
  });
});
