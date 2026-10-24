// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_WALL_LAYOUT, parseWallConfig, sameWallLayout, validateWallLayout, withRevertedWallLayout, withSavedWallLayout, type WallLayout } from '@shared/wall-layout';
import { wallChangeSummary, wallEditorDirty, wallEditorReducer, wallEditorState, wallFullComposition, type WallEditorAction } from '@/lib/wall-editor';

function layout(tileTransparency?: number): WallLayout {
  return { version: 1, rows: [{ id: 'main', height: 'auto', widgets: [{ id: 'sites', type: 'sites', width: 1 }, { id: 'revenue', type: 'revenue', width: 1 }] }], ...(tileTransparency === undefined ? {} : { tileTransparency }) };
}

describe('Wall tile transparency', () => {
  it.each([-1, 101, .5, NaN, Infinity, '50', null, true, {}, []])('rejects invalid transparency %s', value => {
    expect(validateWallLayout({ ...layout(), tileTransparency: value }).ok).toBe(false);
  });

  it.each([0, 40, 100])('round-trips transparency %s through parsing, saving and version history', value => {
    const initial = layout();
    const changed = layout(value);
    expect(validateWallLayout(changed)).toEqual({ ok: true, layout: changed });
    const config = withSavedWallLayout({ layout: initial, history: [] }, changed, 'Adjust tile background', '2026-10-23T00:00:00Z');
    expect(parseWallConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
    if (value > 0) {
      expect(withRevertedWallLayout(config, 0, '2026-10-23T01:00:00Z').layout).toEqual(initial);
      const reverted = withRevertedWallLayout(config, 0, '2026-10-23T01:00:00Z');
      expect(reverted.history[0]!.layout.tileTransparency).toBe(value);
    } else expect(config.history).toEqual([]);
  });

  it('preserves legacy absence while treating explicit zero as the same visible layout', () => {
    const initial = layout();
    expect(parseWallConfig({ layout: initial, history: [] }).layout).toEqual(initial);
    expect(sameWallLayout(initial, layout(0))).toBe(true);
    expect(sameWallLayout(initial, layout(1))).toBe(false);
    const state = wallEditorReducer(wallEditorState(initial), { type: 'transparency', value: 0 });
    expect(state.layout.tileTransparency).toBeUndefined();
    expect(wallEditorDirty(state)).toBe(false);
    expect(state.past).toEqual([]);
  });

  it('groups slider changes into one undo step and restores saved values on discard/reset', () => {
    const initial = layout(15);
    let state = wallEditorState(initial);
    for (const value of [20, 40, 70]) state = wallEditorReducer(state, { type: 'transparency', value, gesture: 'slider-1' });
    expect(state.layout.tileTransparency).toBe(70);
    expect(state.past).toHaveLength(1);
    expect(wallChangeSummary(initial, state.layout)).toBe('Tile transparency 70%');
    state = wallEditorReducer(state, { type: 'undo' });
    expect(state.layout).toEqual(initial);
    state = wallEditorReducer(state, { type: 'redo' });
    expect(state.layout.tileTransparency).toBe(70);
    state = wallEditorReducer(state, { type: 'discard' });
    expect(state.layout).toEqual(initial);
    state = wallEditorReducer(state, { type: 'reset', layout: layout(90) });
    expect(state.layout.tileTransparency).toBe(90);
  });

  it('keeps calibration through rearrangements and the explicit full composition', () => {
    let state = wallEditorState(layout(65));
    const actions: WallEditorAction[] = [
      { type: 'widths', widths: { sites: 2 } },
      { type: 'move', widgetId: 'sites', move: 'right' },
      { type: 'add', widget: 'health' },
      { type: 'remove', widgetId: 'revenue' },
      { type: 'fill', rowId: 'main' },
    ];
    for (const action of actions) {
      state = wallEditorReducer(state, action);
      expect(state.layout.tileTransparency).toBe(65);
    }
    expect(wallFullComposition(state.layout).tileTransparency).toBe(65);
    expect(wallFullComposition(layout()).tileTransparency).toBeUndefined();
    expect(DEFAULT_WALL_LAYOUT.tileTransparency).toBeUndefined();
    expect(wallEditorReducer(state, { type: 'transparency', value: 100.1 })).toBe(state);
  });
});
