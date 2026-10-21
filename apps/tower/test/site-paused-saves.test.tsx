import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { render, fireEvent, screen, within } from "./render";
import { everyTabPayload } from "./asset-detail-fixture";
import { SourcesTab } from "@/routes/asset-detail/SourcesTab";
import { RuleTunePanel } from "@/components/RuleTune";
import { FunnelListEditor } from "@/components/FunnelListEditor";

const capability = vi.hoisted(() => ({ writable: false, reason: "Config store unreachable", sources: {} }));
vi.mock("@/hooks/useConfigWritable", () => ({ useConfigWritable: () => capability }));
vi.mock("@/hooks/useConnections", () => ({ useConnections: () => ({ credentials: undefined, items: null }) }));
vi.mock("@/hooks/useWall", () => ({ useWall: () => ({ data: undefined }) }));
vi.mock("@/hooks/useSettings", () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock("@/hooks/useIntegrationProviders", () => ({ useIntegrationProviders: () => ({ data: undefined }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function wrap(node: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{node}</MemoryRouter>
  </QueryClientProvider>;
}

function statements(container: HTMLElement) {
  return container.querySelectorAll("[data-saves-paused], [data-ga4-config-read-only], [data-collection-read-only], [data-knob-read-only], [data-funnel-editor-read-only]");
}

afterEach(() => { capability.writable = false; });

it("states Saves paused once on Sources with GA4 declarations and PostHog funnels opened", () => {
  const data = everyTabPayload();
  const base = data.integrations.lanes[0]!;
  data.integrations.lanes = [
    { ...base, catalog: { ...base.catalog, id: "ga4", label: "Google Analytics 4" }, cell: { ...base.cell, laneId: "ga4" } },
    { ...base, catalog: { ...base.catalog, id: "posthog", label: "PostHog" }, cell: { ...base.cell, laneId: "posthog" },
      mappingLists: [{ name: "funnels", value: [{ id: "signup", name: "Signup", steps: [{ event: "visit" }, { event: "sign_up" }] }] }] },
  ];
  data.ga4Config = { valueEvents: ["sign_up"], eventParams: ["message"] };
  const { container } = render(wrap(<SourcesTab data={data} nowMs={Date.parse(data.generatedAt)} />));
  for (const name of [/Google Analytics/, /PostHog/]) {
    fireEvent.click(screen.getByRole("button", { name }));
  }
  for (const details of container.querySelectorAll("details")) details.open = true;
  expect(container.querySelectorAll("[data-collection-editor]")).toHaveLength(3);
  expect(container.querySelector("[data-funnel-editor]")).toHaveTextContent("Signup");
  expect(statements(container)).toHaveLength(1);
  expect(statements(container)[0]).toHaveTextContent("Saves paused · Config store unreachable");
  expect(within(container).queryByRole("button", { name: "Add funnel" })).toBeNull();
});

it("states Saves paused once in Tune, keeping both settings read only", () => {
  const knobs = [
    { key: "alpha", label: "Anomaly sensitivity", raw: 0.01, pointer: "/flag_defaults/alpha" },
    { key: "max_window_days", label: "Longest window", raw: 14, pointer: "/flag_defaults/max_window_days" },
  ].map((knob) => ({ ...knob, jargon: knob.key, value: String(knob.raw), owner: "config/constants.json", explain: "" }));
  const { container } = render(wrap(<RuleTunePanel asset="example.com" ruleId="flow-poisson-low" metric="signups"
    knobs={knobs} preview={{ state: "loading" }} onDraftChange={vi.fn()} />));
  expect(statements(container)).toHaveLength(1);
  expect(statements(container)[0]).toHaveTextContent("Saves paused · Config store unreachable");
  expect(screen.getByText("Anomaly sensitivity")).toBeVisible();
  expect(screen.getByText("Longest window")).toBeVisible();
  const inputs = container.querySelectorAll("input");
  expect(inputs).toHaveLength(2);
  for (const input of inputs) expect(input).toBeDisabled();
});

it("keeps a standalone funnel editor's explanation unless its surface suppresses it", () => {
  const props = { current: null, refusal: () => null, makeOp: () => ({ kind: "file-json-set" as const, file: "config/integrations.json" as const, pointer: "/assets/example.com/posthog", value: [], expect: null }) };
  const { container, rerender } = render(wrap(<FunnelListEditor {...props} />));
  expect(container.querySelectorAll("[data-funnel-editor-read-only]")).toHaveLength(1);
  rerender(wrap(<FunnelListEditor {...props} statesReadOnly={false} />));
  expect(container.querySelectorAll("[data-funnel-editor-read-only]")).toHaveLength(0);
  expect(screen.getByText("No funnels · report skipped")).toBeVisible();
});

it("renders no paused statement while the surface can save", () => {
  capability.writable = true;
  const data = everyTabPayload();
  const { container } = render(wrap(<SourcesTab data={data} nowMs={Date.parse(data.generatedAt)} />));
  expect(statements(container)).toHaveLength(0);
});
