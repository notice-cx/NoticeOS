// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_WALL_LAYOUT, DEFAULT_WALL_TV_PREVIEW, parseWallConfig, sameWallLayout, validateWallLayout, wallTvViewport, withRevertedWallLayout, withSavedWallLayout, type WallTvPreview } from "@shared/wall-layout";
import { wallChangeSummary, wallEditorReducer, wallEditorState, wallFullComposition } from "@/lib/wall-editor";
import { tvPresetOf, tvPreviewOf } from "@/lib/wall-tv-presets";

const preview = (): WallTvPreview => structuredClone(DEFAULT_WALL_TV_PREVIEW);
const selected = () => ({ ...preview(), selectedId: "4k-200" });
const check = (tvPreview: unknown) => validateWallLayout({ ...DEFAULT_WALL_LAYOUT, tvPreview });

describe("TV preview profiles", () => {
  it("resolves five defaults without changing an old stored layout", () => {
    const original = structuredClone(DEFAULT_WALL_LAYOUT);
    expect(tvPreviewOf(original).presets).toHaveLength(5);
    expect(tvPresetOf(original)).toMatchObject({ id: "1080p-100", width: 1920, height: 1080, scale: 100 });
    expect(validateWallLayout(original)).toEqual({ ok: true, layout: original });
    expect(parseWallConfig({ layout: original, history: [] }).layout).not.toHaveProperty("tvPreview");
    expect(original).not.toHaveProperty("tvPreview");
  });

  it("calculates CSS viewport sizes from physical pixels and scaling", () => {
    expect(DEFAULT_WALL_TV_PREVIEW.presets.map(wallTvViewport)).toEqual([
      { width: 1920, height: 1080 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 2560, height: 1440 }, { width: 1280, height: 720 },
    ]);
    expect(wallTvViewport({ id: "custom", name: "Custom", width: 1920, height: 1080, scale: 175 })).toEqual({ width: 1097, height: 617 });
  });

  it("retains profile names, stable ids, order and selected metadata exactly", () => {
    const tvPreview = { selectedId: "custom", presets: [{ id: "custom", name: " Desk display ", width: 640, height: 360, scale: 200 }] };
    const layout = { ...DEFAULT_WALL_LAYOUT, tvPreview };
    expect(check(tvPreview)).toEqual({ ok: true, layout });
    expect(tvPresetOf(layout).name).toBe(" Desk display ");
    expect(sameWallLayout(DEFAULT_WALL_LAYOUT, { ...DEFAULT_WALL_LAYOUT, tvPreview: preview() })).toBe(false);
    expect(sameWallLayout({ ...DEFAULT_WALL_LAYOUT, tvPreview: preview() }, { ...DEFAULT_WALL_LAYOUT, tvPreview: selected() })).toBe(false);
  });

  it.each([
    null, {}, { selectedId: "missing", presets: preview().presets }, { selectedId: "custom", presets: [] },
    { selectedId: "1080p-100", presets: [...preview().presets, preview().presets[0]] },
    { selectedId: "tv-0", presets: Array.from({ length: 13 }, (_, index) => ({ ...preview().presets[0], id: `tv-${index}` })) },
  ])("rejects malformed lists and selection: %j", value => { expect(check(value).ok).toBe(false); });

  it.each([
    { id: "Bad id" }, { id: "a".repeat(33) }, { name: " " }, { name: "a".repeat(61) },
    { width: 639 }, { width: 7681 }, { width: 1920.5 }, { height: 359 }, { height: 4321 }, { height: Infinity },
    { scale: 49 }, { scale: 301 }, { scale: 100.5 }, { width: 640, height: 360, scale: 201 },
  ])("rejects invalid profile fields: %j", patch => {
    const preset = { ...preview().presets[0]!, ...patch };
    expect(check({ selectedId: preset.id, presets: [preset] }).ok).toBe(false);
  });

  it("edits profiles through Undo, Redo and saved history without losing calibration", () => {
    const original = { ...structuredClone(DEFAULT_WALL_LAYOUT), tileTransparency: 50 };
    const state = wallEditorReducer(wallEditorState(original), { type: "tv-preview", value: selected() });
    expect(state.layout.tvPreview).toEqual(selected());
    expect(state.layout.tileTransparency).toBe(50);
    expect(wallEditorReducer(state, { type: "undo" }).layout).toEqual(original);
    expect(wallEditorReducer(wallEditorReducer(state, { type: "undo" }), { type: "redo" }).layout).toEqual(state.layout);
    expect(wallChangeSummary(original, state.layout)).toBe("Updated TV preview settings");
    const saved = withSavedWallLayout({ layout: original, history: [] }, state.layout, "Select TV", "2026-10-24T00:00:00Z");
    expect(parseWallConfig(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(withRevertedWallLayout(saved, 0, "2026-10-24T01:00:00Z").layout).toEqual(original);
    expect(wallEditorReducer(state, { type: "discard" }).layout).toEqual(original);
  });

  it("preserves profiles through full composition and tile edits, and rejects invalid reducer values", () => {
    const layout = { ...structuredClone(DEFAULT_WALL_LAYOUT), tvPreview: selected() };
    expect(wallFullComposition(layout).tvPreview).toEqual(layout.tvPreview);
    const state = wallEditorState(layout);
    expect(wallEditorReducer(state, { type: "settings", widgetId: "sites", settings: { rowBackground: false } }).layout.tvPreview).toEqual(layout.tvPreview);
    expect(wallEditorReducer(state, { type: "tv-preview", value: { ...selected(), selectedId: "missing" } })).toBe(state);
    expect(DEFAULT_WALL_TV_PREVIEW.selectedId).toBe("1080p-100");
  });
});
