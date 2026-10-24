import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "./render";
import { WallWeatherEditor, type WallWeatherEditorProps } from "@/components/wall/WallWeatherEditor";
import { WallWidgetPanel } from "@/components/wall/WallWidgetPanel";
import { DEFAULT_WALL_LAYOUT, type WallWeatherSettings } from "@shared/wall-layout";
import { render as renderOwned } from "@testing-library/react";
import { BrowserRuntimeProvider } from "@/lib/browser-context";
import { createBrowserRuntime } from "@/lib/browser-runtime";

vi.mock("@/components/DashboardWidgets", () => ({ CountdownEditor: () => null }));

const city = { name: "Example City, Region, Country", latitude: 12, longitude: 34 };
function Editor({ searchLocations = vi.fn().mockResolvedValue([city]), disabled = false }: Partial<WallWeatherEditorProps>) {
  const [value, setValue] = useState<WallWeatherSettings>();
  return <><WallWeatherEditor value={value} onChange={setValue} searchLocations={searchLocations} disabled={disabled} /><output data-testid="weather">{JSON.stringify(value)}</output></>;
}

describe("Wall weather editor", () => {
  it("offers default Fahrenheit/automatic weather, changes units and switches Off without searching", () => {
    const search = vi.fn();
    render(<Editor searchLocations={search} />);
    expect(screen.getByRole("radio", { name: /^On$/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: "°F" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Automatic location" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("radio", { name: "°C" }));
    expect(screen.getByTestId("weather")).toHaveTextContent('"unit":"celsius"');
    fireEvent.click(screen.getByRole("radio", { name: /^Off$/ }));
    expect(screen.getByRole("radio", { name: "°C" })).toBeDisabled();
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Open-Meteo" })).toHaveAttribute("href", "https://open-meteo.com/");
  });

  it("selects a named city from fixture search and returns to automatic without coordinate fields", async () => {
    const search = vi.fn().mockResolvedValue([city]);
    render(<Editor searchLocations={search} />);
    fireEvent.click(screen.getByRole("button", { name: "Search city" }));
    fireEvent.change(screen.getByLabelText("City", { exact: true }), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
    fireEvent.click(await screen.findByRole("button", { name: city.name }));
    expect(search).toHaveBeenCalledWith("Example", expect.any(AbortSignal));
    expect(screen.getByTestId("weather")).toHaveTextContent(JSON.stringify({ enabled: true, unit: "fahrenheit", location: { mode: "fixed", ...city } }));
    expect(screen.queryByLabelText(/latitude|longitude/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Automatic location" }));
    expect(screen.getByTestId("weather")).toHaveTextContent('"location":{"mode":"automatic"}');
  });

  it("shows empty/error states and aborts obsolete searches", async () => {
    const search = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("fixture unavailable"));
    render(<Editor searchLocations={search} />);
    fireEvent.click(screen.getByRole("button", { name: "Search city" }));
    fireEvent.change(screen.getByLabelText("City", { exact: true }), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(await screen.findByText("No cities found. Try another name.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(await screen.findByText("City search is unavailable. Try again.")).toBeVisible();
  });

  it("aborts a pending city search when switching back to automatic", async () => {
    const search = vi.fn((_query: string, _signal?: AbortSignal) => new Promise<typeof city[]>(() => {}));
    const view = render(<Editor searchLocations={search} />);
    fireEvent.click(screen.getByRole("button", { name: "Search city" }));
    fireEvent.change(screen.getByLabelText("City", { exact: true }), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
    await waitFor(() => expect(search).toHaveBeenCalledOnce());
    const signal = search.mock.calls[0]?.[1] as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Automatic location" }));
    expect(signal.aborted).toBe(true);
    view.unmount();
  });

  it("wires weather only in the selected Top strip panel", () => {
    const changed = vi.fn();
    render(<WallWidgetPanel layout={DEFAULT_WALL_LAYOUT} selectedId="strip" assets={[]} nowMs={0} onSelect={vi.fn()} onSettings={vi.fn()} onWidths={vi.fn()} onSizes={vi.fn()} onHeight={vi.fn()} onMove={vi.fn()} onRemove={vi.fn()} onWeather={changed} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Off$/ }));
    expect(changed).toHaveBeenCalledWith({ enabled: false, unit: "fahrenheit", location: { mode: "automatic" } });
  });

  it.each(["hosted", "demo"] as const)("keeps %s location search disabled", mode => {
    const id = "11111111-1111-4111-8111-111111111111";
    const owner = mode === "hosted" ? { mode, principalId: id, sessionId: id, workspaceId: id, clientGeneration: 1 } : { mode, workspaceId: id, clientGeneration: 1 };
    const fetch = vi.fn();
    const runtime = createBrowserRuntime(owner, { origin: window.location.origin, fetch, sendAnswer: async () => {} });
    const search = vi.fn();
    const changed = vi.fn();
    const view = renderOwned(<BrowserRuntimeProvider value={{ runtime, workspaceLabel: "Fixture" }}><WallWeatherEditor onChange={changed} searchLocations={search} /></BrowserRuntimeProvider>);
    try {
      expect(screen.getByText("Weather is available for private and home TVs.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Search city" })).toBeDisabled();
      expect(screen.getByRole("radio", { name: /^Off$/ })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Search city" }));
      expect(search).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
    } finally { view.unmount(); runtime.retire(); }
  });

  it.each(["freeze", "retire"] as const)("aborts city search and drops late completion after runtime %s", async operation => {
    const runtime = createBrowserRuntime({ mode: "standalone", clientGeneration: 1 }, { origin: window.location.origin, fetch: vi.fn(), sendAnswer: async () => {} });
    let resolve!: (value: typeof city[]) => void;
    const search = vi.fn((_query: string, _signal?: AbortSignal) => new Promise<typeof city[]>(done => { resolve = done; }));
    const changed = vi.fn();
    const view = renderOwned(<BrowserRuntimeProvider value={{ runtime, workspaceLabel: null }}><WallWeatherEditor onChange={changed} searchLocations={search} /></BrowserRuntimeProvider>);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Search city" }));
      fireEvent.change(screen.getByLabelText("City", { exact: true }), { target: { value: "Example" } });
      fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
      await waitFor(() => expect(search).toHaveBeenCalledOnce());
      const signal = search.mock.calls[0]![1]!;
      runtime[operation]();
      expect(signal.aborted).toBe(true);
      await act(async () => { resolve([city]); });
      expect(screen.queryByRole("button", { name: city.name })).toBeNull();
      expect(screen.queryByText("City search is unavailable. Try again.")).toBeNull();
      expect(screen.getByRole("status")).toHaveTextContent("Searching cities…");
      expect(changed).not.toHaveBeenCalled();
    } finally { view.unmount(); runtime.retire(); }
  });
});
