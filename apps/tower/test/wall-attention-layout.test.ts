import { describe, expect, it } from "vitest";
import { DEFAULT_WALL_LAYOUT, isWallColumn, parseWallConfig } from "@shared/wall-layout";
import { wallWithAttentionStrip } from "@/lib/wall-attention-layout";

function oldStandard() {
  const layout = structuredClone(DEFAULT_WALL_LAYOUT);
  const body = layout.rows.find(row => row.id === "body")!;
  const [business, side] = body.widgets;
  if (!business || !side || !isWallColumn(business) || !isWallColumn(side)) throw new Error("Missing standard columns");
  const needs = business.rows.splice(1, 1)[0]!;
  side.rows.splice(1, 0, needs);
  return layout;
}

describe("standard attention layout upgrade", () => {
  it("moves only the ticker row and preserves all saved tile and appearance settings", () => {
    const before = oldStandard();
    before.tileTransparency = 70;
    before.weather = { enabled: true, unit: "celsius", location: { mode: "automatic" } };
    const body = before.rows.find(row => row.id === "body")!;
    const business = body.widgets[0]!;
    if (!isWallColumn(business)) throw new Error("Missing business column");
    business.width = 3;
    business.rows[1]!.widgets[0]!.settings = { assets: ["example.com"] };
    const original = structuredClone(before);
    const after = wallWithAttentionStrip(before);
    const columns = after.rows.find(row => row.id === "body")!.widgets;
    expect(columns.map(column => isWallColumn(column) ? column.rows.map(row => row.widgets[0]!.type) : [])).toEqual([["work", "needs", "sites"], ["revenue", "feed"]]);
    expect(after.tileTransparency).toBe(70);
    expect(after.weather).toEqual(before.weather);
    expect(columns[0]!.width).toBe(3);
    expect(isWallColumn(columns[0]!) && columns[0].rows[2]!.widgets[0]!.settings).toEqual({ assets: ["example.com"] });
    expect(before).toEqual(original);
    expect(parseWallConfig({ layout: before, history: [] }).layout).toEqual(before);
  });

  it("leaves custom compositions and an already upgraded layout untouched", () => {
    expect(wallWithAttentionStrip(DEFAULT_WALL_LAYOUT)).toBe(DEFAULT_WALL_LAYOUT);
    const custom = oldStandard();
    const column = custom.rows.find(row => row.id === "body")!.widgets[0]!;
    if (!isWallColumn(column)) throw new Error("Missing column");
    column.rows.reverse();
    expect(wallWithAttentionStrip(custom)).toBe(custom);
  });
});
