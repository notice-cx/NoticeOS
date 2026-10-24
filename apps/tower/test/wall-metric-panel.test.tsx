import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "./render";
import { WallMetricPanel } from "@/components/wall/WallMetricPanel";
import type { WallWidget } from "@shared/wall-layout";

const initial: WallWidget = { id: "sites", type: "sites", width: 1 };
function Editor({ focused = false }: { focused?: boolean }) {
  const [widget, setWidget] = useState(initial);
  const [selected, setSelected] = useState<string | null>("today");
  return <><WallMetricPanel widget={widget} assets={[]} selectedTileId={selected} focused={focused} layout="bottom" onFocus={vi.fn()} onSelectTile={setSelected} onSettings={settings => setWidget({ ...widget, settings })} /><output data-testid="settings">{JSON.stringify(widget.settings)}</output></>;
}

describe("Wall tile controls", () => {
  it("changes only shared row appearance and preserves tile and asset settings", () => {
    const settings = { assets: ["example.com"], pulseMetrics: { "example.com": ["accounts"] }, metrics: [{ id: "today", source: "today" as const, display: "compare" as const, size: "standard" as const }] };
    const changed = vi.fn();
    render(<WallMetricPanel widget={{ ...initial, settings }} selectedTileId="today" assets={[]} focused onFocus={vi.fn()} onSelectTile={vi.fn()} onSettings={changed} />);
    fireEvent.click(screen.getByRole("switch", { name: "Row separators" }));
    expect(changed).toHaveBeenCalledWith({ ...settings, rowBackground: false });
  });
  it("requires the wide layout for cumulative revenue and restores both widths for Number", () => {
    function RevenueEditor() {
      const [widget, setWidget] = useState<WallWidget>({ id: "revenue", type: "revenue", width: 1, settings: { metrics: [{ id: "revenue", source: "revenue", display: "number", size: "standard" }] } });
      return <><WallMetricPanel widget={widget} selectedTileId="revenue" assets={[]} focused={false} onFocus={vi.fn()} onSelectTile={vi.fn()} onSettings={settings => setWidget({ ...widget, settings })} /><output data-testid="revenue-settings">{JSON.stringify(widget.settings)}</output></>;
    }
    render(<RevenueEditor />);
    expect(screen.getByRole("button", { name: "standard" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Display"), { target: { value: "cumulative" } });
    expect(screen.getByTestId("revenue-settings")).toHaveTextContent('"display":"cumulative","size":"wide"');
    expect(screen.queryByRole("button", { name: "standard" })).toBeNull();
    expect(screen.getByRole("button", { name: "wide" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("Display"), { target: { value: "number" } });
    fireEvent.click(screen.getByRole("button", { name: "standard" }));
    expect(screen.getByTestId("revenue-settings")).toHaveTextContent('"display":"number","size":"standard"');
  });
  it("offers compatible displays and edits the selected tile without dropping other settings", () => {
    render(<Editor />);
    expect(screen.getByText("Shared · Portfolio")).toBeVisible();
    const display = screen.getByLabelText("Display");
    expect([...display.querySelectorAll("option")].map(option => option.textContent)).toEqual(["Comparison", "Number"]);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Visitors today" } });
    fireEvent.click(screen.getByRole("button", { name: "wide" }));
    expect(screen.getByTestId("settings")).toHaveTextContent('"title":"Visitors today"');
    expect(screen.getByTestId("settings")).toHaveTextContent('"size":"wide"');
    fireEvent.change(display, { target: { value: "number" } });
    expect(screen.queryByLabelText("Reference")).toBeNull();
    expect(screen.queryByLabelText("Axes")).toBeNull();
  });

  it("changes metrics with compatible defaults and pins product counts last", () => {
    const change = vi.fn();
    const widget: WallWidget = { ...initial, settings: { assets: ["example"], metrics: [{ id: "tile", source: "today", display: "compare", size: "wide" }, { id: "counts", source: "product-counts", display: "multi", size: "standard" }] } };
    const view = render(<WallMetricPanel widget={widget} assets={[]} selectedTileId="tile" focused={false} onFocus={vi.fn()} onSelectTile={vi.fn()} onSettings={change} />);
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "momentum" } });
    expect(change.mock.lastCall?.[0]).toMatchObject({ assets: ["example"], metrics: [{ id: "tile", source: "momentum", display: "momentum", size: "standard" }, { id: "counts", source: "product-counts" }] });
    expect(screen.getByRole("button", { name: "Move right" })).toBeDisabled();
    view.rerender(<WallMetricPanel widget={widget} assets={[]} selectedTileId="counts" focused={false} onFocus={vi.fn()} onSelectTile={vi.fn()} onSettings={change} />);
    expect(screen.getByRole("button", { name: "Move left" })).toBeDisabled();
  });

  it("changes source after saving comparison details without rejecting the edit", () => {
    const change = vi.fn();
    const widget: WallWidget = { ...initial, settings: { assets: ["example"], metrics: [{ id: "tile", source: "today", display: "compare", size: "wide", reference: true, axes: true, icon: false }] } };
    render(<WallMetricPanel widget={widget} assets={[]} selectedTileId="tile" focused={false} onFocus={vi.fn()} onSelectTile={vi.fn()} onSettings={change} />);
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "asset-work" } });
    expect(change.mock.lastCall?.[0]).toEqual({ assets: ["example"], metrics: [{ id: "tile", source: "asset-work", display: "multi", size: "standard", icon: false }] });
  });

  it("moves, removes and adds tiles through labelled buttons", () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Move left" }));
    const moved = JSON.parse(screen.getByTestId("settings").textContent!);
    expect(moved.metrics[0].source).toBe("today");
    fireEvent.click(screen.getByRole("button", { name: "Remove tile" }));
    fireEvent.click(screen.getByRole("button", { name: "Add tile" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(JSON.parse(screen.getByTestId("settings").textContent!).metrics.filter((tile: { source: string }) => tile.source === "today")).toHaveLength(1);
    expect(screen.getByLabelText("Metric")).toHaveValue("today");
  });

  it("keeps navigation available while edits are disabled", () => {
    const focus = vi.fn();
    render(<WallMetricPanel widget={initial} selectedTileId="today" assets={[]} focused disabled onFocus={focus} onSelectTile={vi.fn()} onSettings={vi.fn()} />);
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove tile" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Back to Wall" }));
    expect(focus).toHaveBeenCalledOnce();
  });
});
