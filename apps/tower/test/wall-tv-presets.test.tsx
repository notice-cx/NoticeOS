import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "./render";
import { DEFAULT_WALL_TV_PREVIEW, type WallTvPreview } from "@shared/wall-layout";
import { WallTvPresets } from "@/components/wall/WallTvPresets";

function Harness({ initial = DEFAULT_WALL_TV_PREVIEW }: { initial?: WallTvPreview }) {
  const [value, setValue] = useState(() => structuredClone(initial));
  const [valid, setValid] = useState(true);
  return <><WallTvPresets value={value} onChange={setValue} onValidityChange={setValid} /><output data-testid="value">{JSON.stringify(value)}</output><output data-testid="valid">{String(valid)}</output></>;
}
const current = () => JSON.parse(screen.getByTestId("value").textContent!) as WallTvPreview;
const edit = (label: string, value: string) => {
  if ((label === "Width" || label === "Height") && !screen.queryByLabelText(label, { exact: true })) fireEvent.change(screen.getByLabelText("Resolution"), { target: { value: "custom" } });
  if (label === "Custom scaling" && !screen.queryByLabelText(label, { exact: true })) fireEvent.change(screen.getByLabelText("Display scaling"), { target: { value: "custom" } });
  fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
};

describe("TV preset controls", () => {
  it("offers actual resolution and scaling presets before any manual fields", () => {
    render(<Harness />);
    expect(screen.queryByLabelText("Width", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Custom scaling", { exact: true })).not.toBeInTheDocument();
    edit("Resolution", "4k");
    expect(current().presets[0]).toMatchObject({ width: 3840, height: 2160, name: "4K · 100%" });
    edit("Display scaling", "200");
    expect(current().presets[0]).toMatchObject({ width: 3840, height: 2160, scale: 200, name: "4K · 200%" });
    expect(screen.getByText(/1920 × 1080 preview/)).toBeInTheDocument();
    edit("Resolution", "1440p");
    edit("Display scaling", "100");
    expect(screen.getByText(/2560 × 1440 preview/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Width", { exact: true })).not.toBeInTheDocument();
  });
  it("selects a physical display and shows its effective scaled preview", () => {
    render(<Harness />);
    expect(screen.getByLabelText("TV preset")).toHaveValue("1080p-100");
    fireEvent.change(screen.getByLabelText("TV preset"), { target: { value: "4k-200" } });
    expect(screen.getByText(/3840 × 2160 · 200% scaling · 1920 × 1080 preview/)).toBeInTheDocument();
    expect(current().selectedId).toBe("4k-200");
    expect(DEFAULT_WALL_TV_PREVIEW.selectedId).toBe("1080p-100");
  });
  it("copies a preset with a stable distinct id and edits only that copy", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Edit presets"));
    fireEvent.click(screen.getByRole("button", { name: "Add preset" }));
    const copied = current();
    expect(copied.presets).toHaveLength(6);
    expect(copied.selectedId).toBe("tv-1");
    edit("Preset name", "Living room");
    edit("Width", "2560");
    edit("Display scaling", "125");
    expect(current().presets.find(preset => preset.id === "tv-1")).toMatchObject({ name: "Living room", width: 2560, height: 1080, scale: 125 });
    expect(current().presets[0]).toEqual(DEFAULT_WALL_TV_PREVIEW.presets[0]);
    fireEvent.click(screen.getByRole("button", { name: "Remove preset" }));
    expect(current().presets).toHaveLength(5);
  });
  it.each([["Preset name", ""], ["Width", ""], ["Width", "639"], ["Height", "4321"], ["Custom scaling", "301"], ["Custom scaling", "99.5"]])("keeps invalid %s=%s local without replacing the valid preview", (label, value) => {
    render(<Harness />);
    const before = current();
    edit(label, value);
    expect(screen.getByLabelText(label, { exact: true })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByRole("alert", { hidden: true }).length).toBeGreaterThan(0);
    expect(current()).toEqual(before);
    expect(screen.getByTestId("valid")).toHaveTextContent("false");
    expect(screen.getByLabelText(label, { exact: true })).toBeRequired();
  });
  it("recovers from a cleared numeric field and never clamps its entered value", () => {
    render(<Harness />);
    edit("Width", "");
    expect(screen.getByLabelText("Width", { exact: true })).toHaveValue(null);
    edit("Width", "7681");
    expect(screen.getByLabelText("Width", { exact: true })).toHaveValue(7681);
    edit("Width", "2560");
    expect(screen.getByTestId("valid")).toHaveTextContent("true");
    expect(current().presets[0]!.width).toBe(2560);
  });
  it("rejects scaling that leaves the preview smaller than its minimum", () => {
    render(<Harness />);
    edit("Width", "640");
    edit("Height", "360");
    edit("Display scaling", "300");
    expect(screen.getByLabelText("Display scaling", { exact: true })).toHaveAttribute("aria-invalid", "true");
    expect(current().presets[0]!.scale).toBe(100);
    expect(screen.getByTestId("valid")).toHaveTextContent("false");
  });
  it("keeps the last preset and stops adding beyond twelve", () => {
    const preset = DEFAULT_WALL_TV_PREVIEW.presets[0]!;
    const view = render(<Harness initial={{ selectedId: preset.id, presets: [preset] }} />);
    fireEvent.click(screen.getByText("Edit presets"));
    expect(screen.getByRole("button", { name: "Remove preset" })).toBeDisabled();
    view.unmount();
    render(<Harness initial={{ selectedId: "tv-1", presets: Array.from({ length: 12 }, (_, index) => ({ ...preset, id: `tv-${index + 1}` })) }} />);
    fireEvent.click(screen.getByText("Edit presets"));
    expect(screen.getByRole("button", { name: "Add preset" })).toBeDisabled();
  });
});
