// Which Wall a screen gets, by its shape. Every landscape screen at least
// 1024 px wide draws the TV layout at one scale: the TV's 1920×1080 box fitted
// into the screen, `min(width / 1920, height / 1080)`, never above the TV's
// own size. The small type keeps a readable floor (index.css, § The TV
// layout, scaled). Anything else keeps the one-column stack.

import { WALL_TV_HEIGHT, WALL_TV_WIDTH } from "@shared/wall-layout";

/** The narrowest landscape screen that draws the TV layout: a landscape tablet. */
export const WALL_TV_LAYOUT_MIN_WIDTH = 1024;

export interface WallScreen {
  /** `tv`: the TV's arrangement, scaled. `stack`: one column. */
  layout: "tv" | "stack";
  /** How much of its TV size the TV layout is drawn at; 1 on the TV and above,
   * and on the one-column stack, which is not scaled. */
  scale: number;
}

/** The one rule: the screen's shape picks the layout, its size the scale. */
export function wallScreen(width: number, height: number): WallScreen {
  const landscape = width > height;
  if (!landscape || width < WALL_TV_LAYOUT_MIN_WIDTH) return { layout: "stack", scale: 1 };
  return { layout: "tv", scale: Math.min(1, width / WALL_TV_WIDTH, height / WALL_TV_HEIGHT) };
}
