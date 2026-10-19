// With nothing saved at `/wall`, the TV and its editor draw the workspace
// view's preset; a saved layout always wins. The editor's Start from puts a
// preset on the stage as one unsaved step.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DashboardConfig } from "@shared/dashboard";
import { DEFAULT_WALL_LAYOUT, WALL_PRESETS, type WallConfig, type WallLayout } from "@shared/wall-layout";
import { WallLibraryPanel } from "@/components/wall/WallLibraryPanel";
import { drawnLayout } from "@/routes/WallRoute";
import { readWallConfig } from "@/routes/WallEditRoute";

const SAVED: WallLayout = {
  version: 1,
  rows: [{ id: "only", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] }],
};
const SAVED_CONFIG: WallConfig = { layout: SAVED, history: [] };

describe("the TV with nothing saved", () => {
  it("draws the workspace view's preset", () => {
    expect(drawnLayout({ view: { default: "business" } })).toBe(WALL_PRESETS.business);
    expect(drawnLayout({ view: { default: "product" } })).toBe(WALL_PRESETS.product);
    expect(drawnLayout({ view: { default: "everything" } })).toBe(DEFAULT_WALL_LAYOUT);
  });

  it("draws Everything's, the default, when no view is set", () => {
    expect(drawnLayout({})).toBe(DEFAULT_WALL_LAYOUT);
  });

  it("draws a saved layout whatever the view", () => {
    expect(drawnLayout({ wall: SAVED_CONFIG, view: { default: "business" } })).toEqual(SAVED);
  });
});

describe("the editor with nothing saved", () => {
  const dashboard = (over: Partial<DashboardConfig>): DashboardConfig => ({ ...over });

  it("starts from the workspace view's preset, unguarded by any saved value", () => {
    const read = readWallConfig(dashboard({ view: { default: "product" } }));
    expect(read.config).toEqual({ layout: WALL_PRESETS.product, history: [] });
    expect(read.raw).toBeNull();
    expect(read.refused).toBeNull();
  });

  it("starts from the default with no view set", () => {
    expect(readWallConfig(dashboard({})).config.layout).toBe(DEFAULT_WALL_LAYOUT);
  });

  it("keeps a saved layout whatever the view", () => {
    const read = readWallConfig(dashboard({ wall: SAVED_CONFIG, view: { default: "business" } }));
    expect(read.config.layout).toEqual(SAVED);
    expect(read.raw).toEqual(SAVED_CONFIG);
  });
});

describe("Start from in the Add drawer", () => {
  it("offers each view's preset by its label, the one on the TV checked and not offered", () => {
    const onStart = vi.fn();
    render(<WallLibraryPanel layout={DEFAULT_WALL_LAYOUT} onAdd={() => {}} onStart={onStart} />);
    fireEvent.click(screen.getByRole("button", { name: "Start from" }));
    const menu = screen.getByRole("menu", { name: "Start from" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["I run the business", "I build the product", "Everything"]);
    expect(items[2]).toHaveProperty("disabled", true);
    fireEvent.click(items[0]!);
    expect(onStart).toHaveBeenCalledWith(WALL_PRESETS.business, "I run the business");
    expect(screen.queryByRole("menu", { name: "Start from" })).toBeNull();
  });

  it("is not offered when the drawer cannot save", () => {
    render(<WallLibraryPanel layout={DEFAULT_WALL_LAYOUT} onAdd={() => {}} onStart={() => {}} disabled />);
    expect(screen.getByRole("button", { name: "Start from" })).toHaveProperty("disabled", true);
  });
});
