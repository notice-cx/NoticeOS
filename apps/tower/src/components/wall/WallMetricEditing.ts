import { createContext, createElement, useContext, type ReactNode } from "react";
import type { WallMetricTile } from "@shared/wall-layout";

export interface MetricTileSelection { widgetId: string; tileId: string; assetId?: string }
export interface WallMetricEditing {
  selection: MetricTileSelection | null;
  onSelect: (selection: MetricTileSelection) => void;
  disabled?: boolean;
  focusAssetId?: string;
  onReorder?: (sourceTileId: string, targetTileId: string) => void;
}

interface MetricScope { widgetId: string; editing?: WallMetricEditing }
interface MetricBinding { tile: WallMetricTile; assetId?: string; configured?: boolean }
const Scope = createContext<MetricScope | null>(null);
const Binding = createContext<MetricBinding | null>(null);

export function WallMetricScope({ children, ...scope }: MetricScope & { children: ReactNode }) {
  return createElement(Scope.Provider, { value: scope }, children);
}

export function WallMetricBinding({ children, ...binding }: MetricBinding & { children: ReactNode }) {
  return createElement(Binding.Provider, { value: binding }, children);
}

export function useWallMetricBinding() {
  const scope = useContext(Scope);
  const binding = useContext(Binding);
  const selection = binding && scope ? { widgetId: scope.widgetId, tileId: binding.tile.id, ...(binding.assetId ? { assetId: binding.assetId } : {}) } : null;
  const editing = scope?.editing;
  const selected = !!selection && editing?.selection?.widgetId === selection.widgetId && editing.selection.tileId === selection.tileId && editing.selection.assetId === selection.assetId;
  const related = !!selection && !selected && editing?.selection?.widgetId === selection.widgetId && editing.selection.tileId === selection.tileId;
  return { binding, selection, editing, selected, related };
}
