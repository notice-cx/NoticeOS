// @vitest-environment node
// Which Wall a screen gets, by its shape.
import { describe, expect, it } from "vitest";
import { WALL_TV_LAYOUT_MIN_WIDTH, wallScreen, wallViewportScreen } from "@/lib/wall-screen";

describe("wallScreen", () => {
  it('uses one projection policy for preview and actual CSS viewports', () => {
    expect(wallViewportScreen(1920, 1080)).toMatchObject({ width: 1920, height: 1080, zoom: 1, kiosk: true, compact: false });
    expect(wallViewportScreen(3840, 2160)).toMatchObject({ width: 2560, height: 1440, zoom: 1.5, kiosk: true });
    expect(wallViewportScreen(1280, 720)).toMatchObject({ width: 1920, height: 1080, zoom: 2 / 3, scale: 2 / 3, compact: true, kiosk: false });
    expect(wallViewportScreen(390, 844)).toMatchObject({ width: 390, height: 844, zoom: 1, layout: 'stack', compact: false, kiosk: false });
  });
  it("draws the TV its own layout at its own size", () => {
    expect(wallScreen(1920, 1080)).toEqual({ layout: "tv", scale: 1 });
    // Bigger screens are not blown up: the 4K kiosk has its own zoom (index.css).
    expect(wallScreen(3840, 2160)).toEqual({ layout: "tv", scale: 1 });
  });

  it("draws a laptop the TV's layout, fitted to the screen by one scale", () => {
    // A 13-inch MacBook Air in Chrome: the TV at 77 %.
    expect(wallScreen(1470, 830)).toEqual({ layout: "tv", scale: 1470 / 1920 });
    expect(wallScreen(1280, 720)).toEqual({ layout: "tv", scale: 1280 / 1920 });
    // 16:10 fits by its width; a desk window shorter than the TV by its height.
    expect(wallScreen(1440, 900)).toEqual({ layout: "tv", scale: 0.75 });
    expect(wallScreen(1920, 960)).toEqual({ layout: "tv", scale: 960 / 1080 });
  });

  it("draws a landscape tablet the TV's layout, down to 1024 px wide", () => {
    expect(wallScreen(1024, 768)).toEqual({ layout: "tv", scale: 1024 / 1920 });
    expect(wallScreen(WALL_TV_LAYOUT_MIN_WIDTH - 1, 700).layout).toBe("stack");
  });

  it("keeps the one column for a portrait tablet and a phone, unscaled", () => {
    expect(wallScreen(768, 1024)).toEqual({ layout: "stack", scale: 1 });
    expect(wallScreen(1024, 1366)).toEqual({ layout: "stack", scale: 1 });
    expect(wallScreen(390, 844)).toEqual({ layout: "stack", scale: 1 });
    // A phone on its side is still a phone.
    expect(wallScreen(844, 390)).toEqual({ layout: "stack", scale: 1 });
    // A square window is not landscape.
    expect(wallScreen(1100, 1100).layout).toBe("stack");
  });
});
