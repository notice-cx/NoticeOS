// Which Wall a screen gets, by its SHAPE (bead ro-trai.31, operator
// 2026-09-23, docs/14-design.md § Laptop, tablet and phone).
//
// A 13-inch MacBook Air in Chrome is about 1470×830 CSS px — the TV's 16:9 at
// 77 % of its size — so it gets the TV's layout, drawn smaller, not a phone's.
// Every landscape screen at least 1024 px wide (a laptop, a landscape tablet, a
// desk monitor, the TV) draws the TV layout at ONE scale: the TV's 1920×1080
// box fitted into the screen, `min(width / 1920, height / 1080)`, never above
// the TV's own size. The small type keeps a readable floor (index.css, § THE
// TV LAYOUT, SCALED). Anything else — a portrait tablet, a phone — keeps the
// one-column stack.
//
// The same idea the Wall editor's preview already uses (a 1920×1080 box scaled
// into a pane), and how a TV dashboard is scaled onto a smaller screen by the
// products the Wall is measured against (docs/artifacts/wall-build-2026-09-23/
// laptop/README.md § Prior art).

import { WALL_TV_HEIGHT, WALL_TV_WIDTH } from "@shared/wall-layout";

/** The narrowest landscape screen that draws the TV layout: a landscape tablet. */
export const WALL_TV_LAYOUT_MIN_WIDTH = 1024;

export interface WallScreen {
  /** `tv`: the D28 arrangement, scaled. `stack`: one column (docs/25). */
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
