import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "./render";
import type { WallWidget } from "@shared/wall-layout";
import { SiteRows } from "@/components/wall/SiteRows";
import { WallWork } from "@/components/wall/WallWork";
import { RevenueHero } from "@/components/wall/RevenueHero";
import { WallMetricScope } from "@/components/wall/WallMetricEditing";
import { WALL_FIXTURE_NOW, wallFixturePayload, wallFixtureRealtime } from "../e2e/wall-fixture";

const nowMs = Date.parse(WALL_FIXTURE_NOW);
const data = () => wallFixturePayload();
const portfolio: WallWidget = { id: "portfolio", type: "sites", width: 1, settings: { metrics: [
  { id: "counts", source: "product-counts", display: "multi", size: "wide" },
  { id: "live", source: "momentum", display: "number", size: "narrow", title: "People now", icon: false },
  { id: "trend", source: "four-weeks", display: "compare", size: "standard", reference: false, axes: false },
] } };

function rows(widget = portfolio) {
  return <SiteRows assets={data().assets} issues={[]} ga4Realtime={wallFixtureRealtime()} nowMs={nowMs} widget={widget} />;
}

describe("configured Wall metrics", () => {
  it("preserves saved positions for individual product counters", () => {
    const asset = data().assets.find(asset => asset.counters?.cards.length)!;
    const card = asset.counters!.cards[0]!;
    const widget: WallWidget = { id: "portfolio", type: "sites", width: 1, settings: { metrics: [
      { id: "count", source: "product-count", metricKey: card.metric, display: "number", size: "standard" },
      { id: "live", source: "momentum", display: "momentum", size: "standard" },
    ] } };
    const { container } = render(<SiteRows assets={[asset]} issues={[]} ga4Realtime={wallFixtureRealtime()} nowMs={nowMs} widget={widget} />);
    expect([...container.querySelectorAll("[data-wall-metric]")].map(tile => tile.getAttribute("data-wall-metric"))).toEqual(["count", "live"]);
  });
  it("applies one portfolio template to asset-specific readings and reserves the same tracks when product counts are absent", () => {
    const { container } = render(rows());
    const assetRows = [...container.querySelectorAll<HTMLElement>("[data-site-row]")];
    expect(new Set(assetRows.map(row => row.style.getPropertyValue("--wall-metric-tracks"))).size).toBe(1);
    for (const row of assetRows) {
      expect(row.firstElementChild).toHaveAttribute("data-site-name");
      expect(row.querySelectorAll("[data-wall-metric-cell]")).toHaveLength(3);
      const tiles = [...row.querySelectorAll("[data-wall-metric]")];
      expect(tiles.slice(0, 2).map(tile => tile.getAttribute("data-wall-metric"))).toEqual(["live", "trend"]);
      const live = row.querySelector('[data-wall-metric="live"]')!;
      expect(live).toHaveAttribute("data-metric-size", "narrow");
      expect(live.querySelector("h3")).toHaveTextContent("People now");
      expect(live.querySelector("h3 svg")).toBeNull();
      expect(live.querySelector(".wall-metric-bars")).toBeNull();
    }
    const mosaic = container.querySelector('[data-site-row="mosaic.example"]')!;
    expect(mosaic.querySelector('[data-live-count]')).toHaveTextContent("21");
    expect(mosaic.querySelector('[data-wall-metric="counts"]')).not.toBeNull();
    const missing = assetRows.find(row => !row.querySelector('[data-wall-metric="counts"]'));
    expect(missing).toBeDefined();
    expect(Number(missing!.style.getPropertyValue("--wall-metric-tail-share"))).toBeLessThan(1);
    expect(mosaic).toHaveStyle({ "--wall-metric-tail-share": "1" });
    expect(container.querySelector("button")).toBeNull();
  });

  it("removes the reference line and marks hidden axes while keeping the current series", () => {
    const { container } = render(rows());
    const trend = container.querySelector('[data-site-row="mosaic.example"] [data-wall-metric="trend"]')!;
    expect(trend).toHaveAttribute("data-metric-axes", "hidden");
    expect(trend.querySelector("[data-prior-weeks]")).toBeNull();
    expect(trend.querySelector("[data-trend-line]")).not.toBeNull();
  });

  it("selects the exact asset tile only when the editing context is supplied", () => {
    const onSelect = vi.fn();
    const { getByRole } = render(<WallMetricScope widgetId="portfolio" editing={{ selection: { widgetId: "portfolio", tileId: "live", assetId: "mosaic.example" }, onSelect }}>{rows()}</WallMetricScope>);
    const button = getByRole("button", { name: "Edit People now for mosaic.example" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(getByRole("button", { name: "Edit People now for plume.example" }).closest(".wall-metric")).toHaveAttribute("data-metric-related");
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith({ widgetId: "portfolio", tileId: "live", assetId: "mosaic.example" });
  });

  it("reorders only matching widget drags and leaves passive tiles without drag controls", () => {
    const onReorder = vi.fn();
    const { getAllByRole } = render(<WallMetricScope widgetId="portfolio" editing={{ selection: null, onSelect: vi.fn(), onReorder }}>{rows()}</WallMetricScope>);
    const buttons = getAllByRole("button");
    const from = buttons.find(button => button.getAttribute("data-wall-metric-select") === "live")!;
    const to = buttons.find(button => button.getAttribute("data-wall-metric-select") === "trend")!;
    const store: Record<string, string> = {};
    const transfer = { setData: (type: string, value: string) => { store[type] = value; }, getData: (type: string) => store[type] ?? "", get types() { return Object.keys(store); }, effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(from, { dataTransfer: transfer });
    fireEvent.dragOver(to, { dataTransfer: transfer });
    fireEvent.drop(to, { dataTransfer: transfer });
    expect(onReorder).toHaveBeenCalledWith("live", "trend");
    expect(store["text/plain"]).toBe("portfolio\nlive");
    onReorder.mockClear();
    fireEvent.drop(to, { dataTransfer: { getData: () => "", types: ["text/plain"] } });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("renders a selected product count with its own label and preserves unknown readings", () => {
    const payload = data();
    const asset = payload.assets.find(asset => asset.counters?.cards.length)!;
    const card = asset.counters!.cards[0]!;
    card.value = null;
    const widget: WallWidget = { id: "portfolio", type: "sites", width: 1, settings: { metrics: [{ id: "count", source: "product-count", metricKey: card.metric, display: "number", size: "standard" }] } };
    const { container } = render(<SiteRows assets={[asset]} issues={[]} nowMs={nowMs} widget={widget} />);
    expect(container.querySelector('[data-wall-metric="count"]')).toHaveAccessibleName(card.label);
    expect(container.querySelector('[aria-label="Unavailable"]')).not.toBeNull();
    expect(container.querySelector(".wall-metric-value")).not.toHaveTextContent("0");
  });

  it("uses the configured work order and converts cumulative totals to number displays without inventing history", () => {
    const payload = data();
    const widget: WallWidget = { id: "work", type: "work", width: 1, settings: { metrics: [
      { id: "done", source: "done", display: "number", size: "narrow", title: "Completed" },
      { id: "blocked", source: "blocked", display: "number", size: "wide" },
    ] } };
    const { container } = render(<WallWork assets={payload.assets} operator={payload.operator} nowMs={nowMs} widget={widget} />);
    expect([...container.querySelectorAll("[data-wall-metric]")].map(tile => tile.getAttribute("data-wall-metric"))).toEqual(["done", "blocked"]);
    expect(container.querySelector('[data-wall-metric="done"]')).toHaveAccessibleName("Completed");
    expect(container.querySelector(".wall-metric-plot")).toBeNull();
  });

  it("removes the revenue reference from the plotted data and preserves the expanded tile", () => {
    const payload = data();
    const widget: WallWidget = { id: "revenue", type: "revenue", width: 1, settings: { metrics: [{ id: "income", source: "revenue", display: "cumulative", size: "wide", reference: false, title: "Income" }] } };
    const { container } = render(<RevenueHero assets={payload.assets} portfolio={payload.portfolio} nowMs={nowMs} widget={widget} />);
    const tile = container.querySelector('[data-wall-metric="income"]');
    expect(tile).toHaveAccessibleName("Income");
    expect(tile).toHaveAttribute("data-metric-expanded");
    expect(tile?.querySelector("[data-metric-previous-total]")).toBeNull();
    expect(tile?.querySelector(".wall-metric-chart svg")).not.toBeNull();
  });
});
