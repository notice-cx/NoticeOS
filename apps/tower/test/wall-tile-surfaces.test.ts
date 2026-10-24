// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_WALL_LAYOUT, parseWallConfig, sameWallLayout, validateWallLayout, withRevertedWallLayout, withSavedWallLayout } from "@shared/wall-layout";
import { wallChangeSummary, wallEditorReducer, wallEditorState, wallFullComposition } from "@/lib/wall-editor";

describe("Wall tile surfaces", () => {
  it("keeps old layouts unchanged and treats absent surfaces as shown", () => {
    expect(parseWallConfig({ layout: DEFAULT_WALL_LAYOUT, history: [] }).layout).not.toHaveProperty("tileSurfaces");
    expect(sameWallLayout(DEFAULT_WALL_LAYOUT, { ...DEFAULT_WALL_LAYOUT, tileSurfaces: true })).toBe(true);
    expect(sameWallLayout(DEFAULT_WALL_LAYOUT, { ...DEFAULT_WALL_LAYOUT, tileSurfaces: false })).toBe(false);
  });
  it.each([null, 0, 1, "false", {}])("rejects invalid surface state %j", tileSurfaces => {
    expect(validateWallLayout({ ...DEFAULT_WALL_LAYOUT, tileSurfaces }).ok).toBe(false);
  });
  it("preserves transparency through toggle, Undo, Redo, composition and saved versions", () => {
    const original = { ...structuredClone(DEFAULT_WALL_LAYOUT), tileTransparency: 50 };
    const off = wallEditorReducer(wallEditorState(original), { type: "surfaces", value: false });
    expect(off.layout).toMatchObject({ tileTransparency: 50, tileSurfaces: false });
    expect(wallChangeSummary(original, off.layout)).toBe("Tile backgrounds and borders hidden");
    expect(wallEditorReducer(off, { type: "undo" }).layout).toEqual(original);
    expect(wallEditorReducer(wallEditorReducer(off, { type: "undo" }), { type: "redo" }).layout).toEqual(off.layout);
    expect(wallFullComposition(off.layout).tileSurfaces).toBe(false);
    const saved = withSavedWallLayout({ layout: original, history: [] }, off.layout, "Hide surfaces", "2026-10-24T00:00:00Z");
    expect(parseWallConfig(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(withRevertedWallLayout(saved, 0, "2026-10-24T01:00:00Z").layout).toEqual(original);
    expect(wallEditorReducer(off, { type: "surfaces", value: true }).layout).toMatchObject({ tileTransparency: 50, tileSurfaces: true });
  });
});
