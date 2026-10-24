// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_WALL_LAYOUT, parseWallConfig, sameWallLayout, validateWallLayout, wallWeatherSettings, withRevertedWallLayout, withSavedWallLayout, type WallWeatherSettings } from "@shared/wall-layout";
import { wallChangeSummary, wallEditorDirty, wallEditorReducer, wallEditorState, wallFullComposition } from "@/lib/wall-editor";

const fixed: WallWeatherSettings = { enabled: true, unit: "celsius", location: { mode: "fixed", name: "Example City", latitude: 12.5, longitude: -45.5 } };

describe("Wall weather configuration", () => {
  it("reads defaults without changing legacy layouts or creating a dirty draft", () => {
    const legacy = structuredClone(DEFAULT_WALL_LAYOUT);
    expect(validateWallLayout(legacy)).toEqual({ ok: true, layout: legacy });
    const defaults = wallWeatherSettings(legacy);
    expect(defaults).toEqual({ enabled: true, unit: "fahrenheit", location: { mode: "automatic" } });
    defaults.enabled = false;
    expect(wallWeatherSettings(legacy).enabled).toBe(true);
    const state = wallEditorState(legacy);
    expect(wallEditorReducer(state, { type: "weather", value: wallWeatherSettings(legacy) })).toEqual(state);
    expect(sameWallLayout(legacy, { ...legacy, weather: wallWeatherSettings(legacy) })).toBe(true);
    expect(legacy).not.toHaveProperty("weather");
  });

  it.each([
    null, {}, { enabled: "yes", unit: "fahrenheit", location: { mode: "automatic" } },
    { ...fixed, unit: "kelvin" }, { ...fixed, location: { mode: "device" } },
    { ...fixed, location: { ...fixed.location, latitude: 91 } },
    { ...fixed, location: { ...fixed.location, longitude: -181 } },
    { ...fixed, location: { ...fixed.location, latitude: NaN } },
    { ...fixed, location: { ...fixed.location, name: " " } },
    { ...fixed, location: { ...fixed.location, name: "x".repeat(161) } },
  ])("rejects malformed weather settings %#", weather => {
    expect(validateWallLayout({ ...DEFAULT_WALL_LAYOUT, weather }).ok).toBe(false);
  });

  it("normalises location fields and copies fixed coordinates through save/revert history", () => {
    const checked = validateWallLayout({ ...DEFAULT_WALL_LAYOUT, weather: { ...fixed, extra: true, location: { ...fixed.location, name: " Example City ", extra: true } } });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.layout.weather).toEqual(fixed);
    const before = { layout: structuredClone(DEFAULT_WALL_LAYOUT), history: [] };
    const saved = withSavedWallLayout(before, checked.layout, "Weather city", "2026-10-24T00:00:00Z");
    expect(parseWallConfig(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    const reverted = withRevertedWallLayout(saved, 0, "2026-10-24T01:00:00Z");
    expect(reverted.layout).toEqual(before.layout);
    expect(reverted.history[0]?.layout.weather).toEqual(fixed);
  });

  it("keeps weather through rearrangement/full composition and exact undo, redo and discard", () => {
    const saved = structuredClone(DEFAULT_WALL_LAYOUT);
    let state = wallEditorState(saved);
    state = wallEditorReducer(state, { type: "weather", value: fixed });
    expect(wallEditorDirty(state)).toBe(true);
    expect(wallChangeSummary(saved, state.layout)).toBe("Updated weather settings");
    expect(wallFullComposition(state.layout).weather).toEqual(fixed);
    const full = wallFullComposition(state.layout);
    full.weather!.location = { mode: "automatic" };
    expect(state.layout.weather).toEqual(fixed);
    const changed = state.layout;
    state = wallEditorReducer(state, { type: "undo" });
    expect(state.layout).toEqual(saved);
    state = wallEditorReducer(state, { type: "redo" });
    expect(state.layout).toEqual(changed);
    state = wallEditorReducer(state, { type: "remove", widgetId: "work" });
    expect(state.layout.weather).toEqual(fixed);
    state = wallEditorReducer(state, { type: "discard" });
    expect(state.layout).toEqual(saved);
  });
});
