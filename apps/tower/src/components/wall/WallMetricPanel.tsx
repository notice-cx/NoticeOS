import { useId, useState } from "react";
import { ArrowLeft, ArrowRight, Expand, Plus, Trash2 } from "lucide-react";
import type { AssetCard } from "@shared/wall";
import { wallMetricSources, wallMetricSpec, wallMetricTiles, type WallMetricSource, type WallMetricTile, type WallWidget, type WallWidgetSettings } from "@shared/wall-layout";
import { addWallMetricTile, moveWallMetricTile, removeWallMetricTile, updateWallMetricTile } from "@/lib/wall-metric-editor";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface WallMetricPanelProps {
  widget: WallWidget;
  selectedTileId: string | null;
  assets: readonly AssetCard[];
  disabled?: boolean;
  focused: boolean;
  layout?: "bottom" | "side";
  onFocus: () => void;
  onSelectTile: (id: string) => void;
  onSettings: (settings: WallWidgetSettings) => void;
  onSectionSettings?: () => void;
}

const DISPLAY_LABELS = { number: "Number", momentum: "Momentum", compare: "Comparison", multi: "Multiple values", cumulative: "Cumulative" };
const FIELD_CLASS = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function WallMetricPanel({ widget, selectedTileId, assets, disabled = false, focused, layout = "side", onFocus, onSelectTile, onSettings, onSectionSettings }: WallMetricPanelProps) {
  const prefix = useId();
  const [adding, setAdding] = useState(false);
  const tiles = wallMetricTiles(widget);
  const tile = tiles.find(item => item.id === selectedTileId);
  const spec = tile ? wallMetricSpec(tile.source) : null;
  const sources = wallMetricSources(widget.type);
  const counters = [...new Map(assets.flatMap(asset => asset.counters?.cards ?? []).map(card => [card.metric, card])).values()];
  const options = tiles.length >= 8 ? [] : sources.flatMap<{ source: WallMetricSource; metricKey: string | undefined; label: string }>(source => source === "product-count"
    ? counters.filter(card => !tiles.some(item => item.source === source && item.metricKey === card.metric)).map(card => ({ source, metricKey: card.metric, label: card.label }))
    : tiles.some(item => item.source === source) ? [] : [{ source, metricKey: undefined, label: wallMetricSpec(source).label }]);
  const patch = (value: Partial<Omit<WallMetricTile, "id">>) => { if (tile) onSettings(updateWallMetricTile(widget, tile.id, value)); };
  const index = tile ? tiles.indexOf(tile) : -1;
  const editableSources = sources.filter(source => source !== "product-counts" || index === tiles.length - 1).filter(source => source !== "product-count" || tile?.source === "product-count").filter(source => source === tile?.source || !tiles.some(item => item.source === source));

  return <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4" data-wall-metric-panel={widget.id} data-panel-layout={layout}>
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2"><h2 className="truncate text-sm font-semibold">{tile?.title || spec?.label || "Row tiles"}</h2>{widget.type === "sites" ? <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">Shared · Portfolio</span> : null}</div>
      <div className="flex items-center gap-2"><Button type="button" variant="ghost" size="sm" onClick={onFocus}>{focused ? <ArrowLeft className="size-4" /> : <Expand className="size-4" />}{focused ? "Back to Wall" : "Focus on row"}</Button>{onSectionSettings ? <Button type="button" variant="ghost" size="sm" onClick={onSectionSettings}>Row settings</Button> : null}</div>
    </header>
    {tile && spec ? <div className={cn("grid gap-4", layout === "bottom" && "lg:grid-cols-3")}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-xs font-medium" htmlFor={`${prefix}-metric`}>Metric<select id={`${prefix}-metric`} className={FIELD_CLASS} disabled={disabled || tile.source === "product-count"} value={tile.source} onChange={event => patch({ source: event.target.value as WallMetricSource, display: wallMetricSpec(event.target.value as WallMetricSource).defaultDisplay, size: wallMetricSpec(event.target.value as WallMetricSource).defaultSize, metricKey: undefined })}>{editableSources.map(source => <option key={source} value={source}>{wallMetricSpec(source).label}</option>)}</select></label>
        {tile.source === "product-count" ? <label className="flex flex-col gap-1.5 text-xs font-medium" htmlFor={`${prefix}-counter`}>Product count<select id={`${prefix}-counter`} className={FIELD_CLASS} disabled={disabled} value={tile.metricKey} onChange={event => patch({ metricKey: event.target.value })}>{tile.metricKey && !counters.some(card => card.metric === tile.metricKey) ? <option value={tile.metricKey}>{tile.metricKey}</option> : null}{counters.filter(card => card.metric === tile.metricKey || !tiles.some(item => item.source === "product-count" && item.metricKey === card.metric)).map(card => <option key={card.metric} value={card.metric}>{card.label}</option>)}</select></label> : null}
        <label className="flex flex-col gap-1.5 text-xs font-medium" htmlFor={`${prefix}-display`}>Display<select id={`${prefix}-display`} className={FIELD_CLASS} disabled={disabled} value={tile.display} onChange={event => patch({ display: event.target.value as WallMetricTile["display"], ...(event.target.value === "cumulative" ? tile.source === "revenue" ? { size: "wide" } : tile.size === "narrow" ? { size: "standard" } : {} : {}) })}>{spec.displays.map(display => <option key={display} value={display}>{DISPLAY_LABELS[display]}</option>)}</select></label>
      </div>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-xs font-medium" htmlFor={`${prefix}-title`}>Title<input id={`${prefix}-title`} className={FIELD_CLASS} disabled={disabled} value={tile.title ?? ""} placeholder={spec.label} maxLength={80} onChange={event => patch({ title: event.target.value || undefined })} /></label>
        <fieldset className="flex flex-col gap-1.5"><legend className="mb-1.5 text-xs font-medium">Width</legend><div className="flex gap-1">{spec.sizes.filter(size => tile.display !== "cumulative" || (tile.source === "revenue" ? size === "wide" : size !== "narrow")).map(size => <Button key={size} type="button" variant={tile.size === size ? "default" : "outline"} size="sm" className="flex-1 capitalize" aria-pressed={tile.size === size} disabled={disabled} onClick={() => patch({ size })}>{size}</Button>)}</div></fieldset>
      </div>
      <div className="flex flex-col justify-between gap-4">
        <div className="flex flex-wrap gap-x-4 gap-y-2">{([['icon', 'Icon', spec.icon], ['reference', 'Reference', spec.reference && (tile.display === 'compare' || tile.display === 'cumulative')], ['axes', 'Axes', spec.axes && tile.display !== 'number' && tile.display !== 'multi']] as const).filter(([, , supported]) => supported).map(([key, label]) => <label key={key} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={tile[key] !== false} disabled={disabled} onChange={event => patch({ [key]: event.target.checked })} />{label}</label>)}</div>
        <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={disabled || index <= 0 || tile.source === "product-counts"} onClick={() => onSettings(moveWallMetricTile(widget, tile.id, -1))}><ArrowLeft className="size-4" />Move left</Button><Button type="button" variant="outline" size="sm" disabled={disabled || index >= tiles.length - 1 || tile.source === "product-counts" || tiles[index + 1]?.source === "product-counts"} onClick={() => onSettings(moveWallMetricTile(widget, tile.id, 1))}><ArrowRight className="size-4" />Move right</Button><Button type="button" variant="ghost" size="sm" disabled={disabled || widget.type === "revenue"} onClick={() => { onSettings(removeWallMetricTile(widget, tile.id)); const next = tiles[index + 1] ?? tiles[index - 1]; if (next) onSelectTile(next.id); }}><Trash2 className="size-4" />Remove tile</Button></div>
      </div>
    </div> : <p className="text-sm text-muted-foreground">Select a tile in the preview to edit it.</p>}
    <footer className="flex flex-col gap-3 border-t border-border pt-3"><div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={disabled || options.length === 0} aria-expanded={adding} onClick={() => setAdding(value => !value)}><Plus className="size-4" />Add tile</Button>{tiles.map(item => <Button key={item.id} type="button" size="sm" variant={item.id === selectedTileId ? "default" : "ghost"} aria-pressed={item.id === selectedTileId} onClick={() => onSelectTile(item.id)}>{item.title || (item.source === "product-count" ? counters.find(card => card.metric === item.metricKey)?.label ?? item.metricKey : wallMetricSpec(item.source).label)}</Button>)}</div>{adding ? <div className="flex flex-wrap gap-2" aria-label="Available tiles">{options.map(option => <Button key={`${option.source}:${option.metricKey ?? ''}`} type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { const settings = addWallMetricTile(widget, option.source, option.metricKey); onSettings(settings); const added = settings.metrics?.find(item => !tiles.some(current => current.id === item.id)); if (added) onSelectTile(added.id); setAdding(false); }}><Plus className="size-3" />{option.label}</Button>)}</div> : null}</footer>
  </section>;
}
