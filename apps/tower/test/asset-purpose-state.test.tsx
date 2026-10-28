import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "./render";
import { AssetTabs } from "@/routes/asset-detail/AssetTabs";
import { PurposeSections } from "@/routes/asset-detail/purpose-presentation";
import { KnobEditor } from "@/components/KnobEditor";
import { ViewBar } from "@/components/ViewBar";
import { everyTabPayload } from "./asset-detail-fixture";

vi.mock("@/hooks/useWall", () => ({ useWall: () => ({ data: undefined }) }));
vi.mock("@/hooks/useConnections", () => ({ useConnections: () => ({ credentials: undefined, items: null }) }));
vi.mock("@/hooks/useWork", () => ({ useWork: () => ({ data: undefined }) }));
vi.mock("@/hooks/useConfigWritable", () => ({
  useConfigWritable: () => ({ writable: true, reason: null, sources: {} }),
  CONFIG_READ_ONLY_FALLBACK: "Settings cannot be saved right now.",
}));

function SettingsForm() {
  const location = useLocation();
  return <>
    <ViewBar />
    <AssetTabs data={everyTabPayload()} assetId="meadow.example" nowMs={0} />
    <output data-testid="asset-location">{location.pathname}{location.search}{location.hash}</output>
    <PurposeSections surface="settings" data-testid="sections">
      <div key="identity">Identity</div>
      <div key="automation">Automation</div>
      <KnobEditor key="collection" label="Metrics endpoint" current="https://example.com/metrics" format={String}
        control={{ type: "text", validate: (value) => ({ ok: true, value }) }}
        makeOp={(value) => ({ kind: "store-asset-set", asset: "meadow.example", column: "display_name", expect: "Meadow", value })}
        onSave={vi.fn()} />
      <div key="panel">Search terms</div>
    </PurposeSections>
  </>;
}

afterEach(() => window.localStorage.clear());

describe("asset purpose section state", () => {
  it("keeps an actual buffered editor draft and explicit tab when its section moves", () => {
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={["/assets/meadow.example/settings?range=7&filter=mine#configuration"]}>
      <Routes><Route path="/assets/:id/:tab?" element={<SettingsForm />} /></Routes>
    </MemoryRouter></QueryClientProvider>);
    const field = screen.getByRole("textbox", { name: "Metrics endpoint" });
    fireEvent.change(field, { target: { value: "https://example.com/draft" } });
    const choose = (name: string) => fireEvent.click(within(screen.getByRole("group", { name: "View" })).getByRole("button", { name }));
    choose("Growth");
    const growth = screen.getByTestId("sections").textContent;
    choose("Delivery");
    expect(screen.getByTestId("sections").textContent).not.toBe(growth);
    choose("Reliability");
    expect(screen.getByRole("textbox", { name: "Metrics endpoint" })).toBe(field);
    expect(field).toHaveValue("https://example.com/draft");
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab")).toHaveLength(12);
    expect(screen.getByTestId("asset-location")).toHaveTextContent("/assets/meadow.example/settings?range=7&filter=mine#configuration");
  });
});
