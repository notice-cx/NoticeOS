import { DEFAULT_WALL_TV_PREVIEW, type WallLayout, type WallTvPreset, type WallTvPreview } from "@shared/wall-layout";

/** Defaults are resolved for display without adding fields to saved layouts. */
export function tvPreviewOf(layout: WallLayout): WallTvPreview {
  return layout.tvPreview ?? DEFAULT_WALL_TV_PREVIEW;
}

export function tvPresetOf(layout: WallLayout): WallTvPreset {
  const preview = tvPreviewOf(layout);
  return preview.presets.find(preset => preset.id === preview.selectedId) ?? preview.presets[0]!;
}
