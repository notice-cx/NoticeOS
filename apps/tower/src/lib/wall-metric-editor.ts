import {
  validateWallLayout, wallMetricSpec, wallMetricTiles,
  type WallMetricSource, type WallMetricTile, type WallWidget, type WallWidgetSettings,
} from '../../shared/wall-layout';

function withTiles(widget: WallWidget, metrics: WallMetricTile[]): WallWidgetSettings {
  const settings = { ...structuredClone(widget.settings ?? {}), metrics };
  const check = validateWallLayout({ version: 1, rows: [{ id: 'metrics', height: 'auto', widgets: [{ ...widget, settings }] }] });
  return check.ok ? settings : structuredClone(widget.settings ?? {});
}

export function addWallMetricTile(widget: WallWidget, source: WallMetricSource, metricKey?: string): WallWidgetSettings {
  const metrics = wallMetricTiles(widget);
  const spec = wallMetricSpec(source);
  const taken = new Set(metrics.map((tile) => tile.id));
  let id: string = source;
  for (let n = 2; taken.has(id); n += 1) id = `${source}-${n}`;
  const tile: WallMetricTile = { id, source, display: spec.defaultDisplay, size: spec.defaultSize, ...(metricKey === undefined ? {} : { metricKey }) };
  const last = metrics.findIndex((entry) => entry.source === 'product-counts');
  metrics.splice(last < 0 ? metrics.length : last, 0, tile);
  return withTiles(widget, metrics);
}

export function updateWallMetricTile(widget: WallWidget, id: string, patch: Partial<Omit<WallMetricTile, 'id'>>): WallWidgetSettings {
  return withTiles(widget, wallMetricTiles(widget).map((tile) => {
    if (tile.id !== id) return tile;
    if (patch.source === undefined || patch.source === tile.source) return { ...tile, ...patch };
    const spec = wallMetricSpec(patch.source);
    const next: WallMetricTile = { ...tile, display: spec.defaultDisplay, size: spec.defaultSize, ...patch };
    for (const key of ['reference', 'axes', 'icon'] as const) {
      if (!spec[key]) delete next[key];
    }
    if (next.source !== 'product-count') delete next.metricKey;
    return next;
  }));
}

export function removeWallMetricTile(widget: WallWidget, id: string): WallWidgetSettings {
  return withTiles(widget, wallMetricTiles(widget).filter((tile) => tile.id !== id));
}

export function moveWallMetricTile(widget: WallWidget, id: string, direction: -1 | 1): WallWidgetSettings {
  const metrics = wallMetricTiles(widget);
  const index = metrics.findIndex((tile) => tile.id === id);
  const next = index + direction;
  if (index >= 0 && next >= 0 && next < metrics.length) [metrics[index], metrics[next]] = [metrics[next]!, metrics[index]!];
  return withTiles(widget, metrics);
}

export function resetWallMetricTiles(widget: WallWidget): WallWidgetSettings {
  const settings = structuredClone(widget.settings ?? {});
  delete settings.metrics;
  return settings;
}
