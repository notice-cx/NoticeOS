import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, type CSSProperties } from "react";
import { WALL_TV_WIDTH, WALL_TV_HEIGHT, wallMetricTiles, wallWidgetSpec, wallTvViewport, type WallTvPreset, type WallWidget } from "@shared/wall-layout";
import { WallCanvas, type WallCanvasProps } from "@/components/WallCanvas";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import { filterWallAssets, wallOnTv } from "@/lib/wall-widgets";
import { wallViewportScreen } from "@/lib/wall-screen";
import type { WallMetricEditing } from "./WallMetricEditing";
import "./WallMetricFocus.css";

export interface WallMetricFocusProps extends Omit<WallCanvasProps, "layout" | "editing" | "metricEditing"> {
  tileTransparency?: number;
  tileSurfaces?: boolean;
  tvPreset?: WallTvPreset;
  widget: WallWidget;
  metricEditing: WallMetricEditing;
  onBack: () => void;
  onAsset: (id: string) => void;
}

/** Focus changes the preview viewport, never the saved row or asset filter. */
export function WallMetricFocus({ widget, metricEditing, onBack, onAsset, tileTransparency, tileSurfaces, tvPreset, ...canvas }: WallMetricFocusProps) {
  const viewport = tvPreset ? wallTvViewport(tvPreset) : { width: WALL_TV_WIDTH, height: WALL_TV_HEIGHT };
  const screen = wallViewportScreen(viewport.width, viewport.height);
  const assets = filterWallAssets(wallOnTv(canvas.data).data.assets, widget.settings);
  const selectedAsset = assets.find(asset => asset.id === metricEditing.focusAssetId) ?? assets[0];
  const preview = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tile = preview.current?.querySelector<HTMLElement>("[data-metric-selected]");
    tile?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [metricEditing.selection?.tileId]);
  return <section className="flex min-w-0 flex-col gap-4" data-wall-row-focus={widget.id}>
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3"><Button type="button" size="sm" variant="ghost" onClick={onBack}><ArrowLeft className="size-4" />Full Wall</Button><h2 className="text-base font-semibold">{wallWidgetSpec(widget.type).label}</h2></div>
      {widget.type === "sites" ? <label className="flex min-w-0 max-w-full items-center gap-2 text-sm text-muted-foreground">Preview asset<select aria-label="Preview asset" className={cn(fieldClass, "h-9 min-w-0 max-w-full flex-1 text-foreground")} value={selectedAsset?.id ?? ""} onChange={event => onAsset(event.target.value)}>{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.displayName}</option>)}</select></label> : null}
    </header>
    <div ref={preview} className="min-w-0 overflow-x-auto rounded-lg" data-wall-focus-preview>
    <div className="wall-root wall-metric-focus-preview" data-theme="dark" data-wall-screen data-wall-compact={screen.compact || undefined} data-wall-scaled={screen.scale < 1 || undefined} style={{ width: `${screen.width}px`, minHeight: 0, padding: '1rem', "--wall-scale": screen.scale, "--wall-render-zoom": screen.zoom, "--wall-viewport-height": `${viewport.height}px`, "--focus-tile-count": wallMetricTiles(widget).length } as CSSProperties}>
      <WallCanvas {...canvas} layout={{ version: 1, ...(tileTransparency !== undefined ? { tileTransparency } : {}), ...(tileSurfaces !== undefined ? { tileSurfaces } : {}), rows: [{ id: "focused-row", height: "auto", widgets: [{ ...widget, width: 1, settings: { ...widget.settings, metrics: wallMetricTiles(widget) } }] }] }} metricEditing={{ ...metricEditing, focusAssetId: selectedAsset?.id }} />
    </div>
    </div>
    <p className="text-xs text-muted-foreground">{widget.type === "sites" ? "One arrangement for every asset. Each row keeps its own values." : "The same tiles appear on the Wall."} Drag tiles to reorder, or use Move left and Move right.</p>
  </section>;
}
