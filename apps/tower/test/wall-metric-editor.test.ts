// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseWallConfig, validateWallLayout, wallMetricTiles, withRevertedWallLayout, withSavedWallLayout, type WallLayout, type WallMetricTile, type WallWidget } from '@shared/wall-layout';
import { addWallMetricTile, moveWallMetricTile, removeWallMetricTile, resetWallMetricTiles, updateWallMetricTile } from '@/lib/wall-metric-editor';
import { wallEditorReducer, wallEditorState, wallFullComposition } from '@/lib/wall-editor';

const widget: WallWidget = { id: 'sites', type: 'sites', width: 1, settings: { assets: ['example.com'], pulseMetrics: { 'example.com': ['orders'] } } };
function layout(value: WallWidget = widget): WallLayout { return { version: 1, rows: [{ id: 'main', height: 'auto', widgets: [value] }] }; }
function checked(metrics: unknown, type = 'sites') { return validateWallLayout({ ...layout(), rows: [{ id: 'main', height: 'auto', widgets: [{ ...widget, type, settings: { metrics } }] }] }); }

describe('Wall metric templates', () => {
  it('preserves the shared Portfolio row background choice through settings, parsing and history', () => {
    const original = layout();
    const sites: WallWidget = { ...widget, settings: { ...widget.settings, rowBackground: false } };
    const changed = layout(sites);
    expect(validateWallLayout(changed)).toEqual({ ok: true, layout: changed });
    expect(validateWallLayout(layout({ ...sites, settings: { ...sites.settings, rowBackground: true } })).ok).toBe(true);
    const saved = withSavedWallLayout({ layout: original, history: [] }, changed, 'Hide row backgrounds', '2026-10-23T00:00:00Z');
    expect(parseWallConfig(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    const reverted = withRevertedWallLayout(saved, 0, '2026-10-23T01:00:00Z');
    expect(reverted.layout).toEqual(original);
    expect(reverted.history[0]!.layout).toEqual(changed);
    const state = wallEditorReducer(wallEditorState(changed), { type: 'settings', widgetId: 'sites', settings: updateWallMetricTile(sites, 'today', { title: 'Visitors' }) });
    expect(state.layout.rows[0]!.widgets[0]).toMatchObject({ settings: { rowBackground: false, assets: ['example.com'], pulseMetrics: { 'example.com': ['orders'] } } });
    expect(wallEditorReducer(state, { type: 'undo' }).layout).toEqual(changed);
  });

  it('rejects non-boolean row backgrounds and row settings on other sections', () => {
    for (const rowBackground of [null, 0, 1, 'false', [], {}]) {
      expect(validateWallLayout({ ...layout(), rows: [{ id: 'main', height: 'auto', widgets: [{ ...widget, settings: { rowBackground } }] }] }).ok).toBe(false);
    }
    for (const type of ['work', 'revenue', 'health']) {
      expect(validateWallLayout({ ...layout(), rows: [{ id: 'main', height: 'auto', widgets: [{ ...widget, type, settings: { rowBackground: false } }] }] }).ok).toBe(false);
    }
  });
  it('changes source without retaining unsupported saved details', () => {
    const original: WallWidget = { ...widget, settings: { ...widget.settings, metrics: [{ id: 'tile', source: 'today', display: 'compare', size: 'wide', reference: true, axes: true, icon: false }] } };
    const settings = updateWallMetricTile(original, 'tile', { source: 'asset-work' });
    expect(settings.metrics).toEqual([{ id: 'tile', source: 'asset-work', display: 'multi', size: 'standard', icon: false }]);
    expect(settings.assets).toEqual(original.settings!.assets);
    expect(original.settings!.metrics![0]!.reference).toBe(true);
    const work: WallWidget = { id: 'work', type: 'work', width: 1 };
    expect(updateWallMetricTile(work, 'done', { reference: false }).metrics!.find(tile => tile.source === 'done')!.reference).toBe(false);
  });

  it('changes legacy geometry only through one explicit full-composition action and restores it with Undo', () => {
    const legacy = layout({ ...widget, settings: updateWallMetricTile(widget, 'today', { title: 'Visits' }) });
    const before = structuredClone(legacy);
    let state = wallEditorState(legacy);
    expect(state.layout).toEqual(before);
    const full = wallFullComposition(state.layout);
    const findSites = (value: WallLayout): WallWidget | undefined => value.rows.flatMap(row => row.widgets.flatMap(slot => slot.type === 'column' ? slot.rows.flatMap(inner => inner.widgets) : [slot])).find(item => item.type === 'sites');
    expect(findSites(full)!.settings).toEqual(findSites(before)!.settings);
    expect(legacy).toEqual(before);
    state = wallEditorReducer(state, { type: 'replace', layout: full });
    expect(state.past).toHaveLength(1);
    state = wallEditorReducer(state, { type: 'undo' });
    expect(state.layout).toEqual(before);
    const originalSettings = findSites(before)!.settings!;
    state = wallEditorReducer(state, { type: 'settings', widgetId: 'sites', settings: { ...originalSettings, assets: [] } });
    expect(findSites(state.layout)!.settings).toEqual({ metrics: originalSettings.metrics, pulseMetrics: originalSettings.pulseMetrics });
    findSites(full)!.settings!.assets!.push('other.example.com');
    expect(findSites(legacy)!.settings!.assets).toEqual(['example.com']);
  });
  it('resolves defaults without changing legacy documents or returning shared tiles', () => {
    const before = JSON.stringify(layout());
    const tiles = wallMetricTiles(widget);
    expect(tiles.map((tile) => tile.source)).toEqual(['momentum', 'today', 'four-weeks', 'asset-work', 'product-counts']);
    tiles[0]!.title = 'Changed';
    expect(wallMetricTiles(widget)[0]!.title).toBeUndefined();
    expect(JSON.stringify(parseWallConfig({ layout: layout(), history: [] }).layout)).toBe(before);
    expect(JSON.stringify(layout())).toBe(before);
  });

  it('keeps unrelated settings and anchors aggregate counts during add and reorder', () => {
    const settings = addWallMetricTile(widget, 'product-count', 'orders');
    const added = { ...widget, settings };
    expect(settings.assets).toEqual(widget.settings!.assets);
    expect(settings.pulseMetrics).toEqual(widget.settings!.pulseMetrics);
    expect(settings.metrics!.at(-2)).toMatchObject({ source: 'product-count', metricKey: 'orders' });
    expect(settings.metrics!.at(-1)!.source).toBe('product-counts');
    expect(moveWallMetricTile(added, 'product-counts', -1)).toEqual(settings);
    expect(addWallMetricTile(added, 'product-count', 'orders')).toEqual(settings);
    settings.assets!.push('other.example.com');
    expect(widget.settings!.assets).toEqual(['example.com']);
  });

  it('saves, reverts and undoes tile edits with independent settings objects', () => {
    const initial = layout();
    let state = wallEditorState(initial);
    const settings = updateWallMetricTile(widget, 'today', { title: 'Visits today', display: 'number' });
    state = wallEditorReducer(state, { type: 'settings', widgetId: widget.id, settings });
    const edited = state.layout;
    state = wallEditorReducer(state, { type: 'undo' });
    expect(state.layout).toEqual(initial);
    state = wallEditorReducer(state, { type: 'redo' });
    expect(state.layout).toEqual(edited);
    const saved = withSavedWallLayout({ layout: initial, history: [] }, edited, 'Adjust visits', '2026-10-23T00:00:00Z');
    expect(parseWallConfig(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(withRevertedWallLayout(saved, 0, '2026-10-23T01:00:00Z').layout).toEqual(initial);
    expect(resetWallMetricTiles({ ...widget, settings })).toEqual(widget.settings);
    expect(removeWallMetricTile(widget, 'today').metrics!.some((tile) => tile.source === 'today')).toBe(false);
  });

  it('rejects duplicate ids, duplicate sources, unknown settings and unsupported combinations', () => {
    const tile: WallMetricTile = { id: 'today', source: 'today', display: 'compare', size: 'standard' };
    for (const metrics of [
      [tile, tile], [tile, { ...tile, id: 'other' }], [{ ...tile, source: 'decisions' }],
      [{ ...tile, display: 'cumulative' }], [{ ...tile, size: 'huge' }], [{ ...tile, icon: 'yes' }],
      [{ ...tile, title: 'x'.repeat(81) }], [{ ...tile, surprise: true }],
      [{ ...tile, source: 'product-count', display: 'number' }],
      [{ id: 'counts', source: 'product-counts', display: 'multi', size: 'standard' }, tile],
    ]) expect(checked(metrics).ok).toBe(false);
    expect(checked([], 'revenue').ok).toBe(false);
    expect(checked([{ id: 'revenue', source: 'revenue', display: 'cumulative', size: 'narrow' }], 'revenue').ok).toBe(false);
    expect(checked([{ id: 'revenue', source: 'revenue', display: 'cumulative', size: 'standard' }], 'revenue').ok).toBe(false);
    expect(checked([{ id: 'revenue', source: 'revenue', display: 'cumulative', size: 'wide' }], 'revenue').ok).toBe(true);
    expect(checked([{ id: 'revenue', source: 'revenue', display: 'number', size: 'standard' }], 'revenue').ok).toBe(true);
    const revenue: WallWidget = { id: 'revenue', type: 'revenue', width: 1 };
    expect(updateWallMetricTile(revenue, 'revenue', { size: 'standard' })).toEqual({});
    expect(checked([{ id: 'done', source: 'done', display: 'cumulative', size: 'narrow' }], 'work').ok).toBe(false);
    expect(checked([tile], 'feed').ok).toBe(false);
  });
});
