import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTEGRATION_PROVIDERS, type CredentialSummary, type IntegrationProviderId } from "@noticeos/contract";
import type { IntegrationProviderStatus } from "@shared/integrations-page";
import {
  SCHEDULED_JOBS, connectionCollections, isCollectionJob, scheduleHref, settingsCollections, type ScheduleOverrides,
} from "@shared/scheduled-jobs";
import type { SettingsPayload } from "@shared/settings";
import { configSaveReply } from "./config-save-reply";

// A COLLECTION'S SCHEDULE IS CHANGED ON ITS SOURCE'S MANAGE PANEL (bead
// ro-ujb9.96.7.28, operator decision 2026-09-24). Settings keeps
// only the collections no connection feeds; the traffic and search archives,
// fed by Google and Bing, show the job's one schedule on both panels.

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const state = vi.hoisted(() => ({
  schedules: null as ScheduleOverrides | null,
  settingsRead: true,
  writable: { writable: true, reason: null as string | null },
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    data: state.settingsRead ? ({ collection: { schedules: state.schedules } } as unknown as SettingsPayload) : undefined,
    isPending: !state.settingsRead,
    isError: false,
  }),
}));
vi.mock("@/hooks/useConfigWritable", () => ({ useConfigWritable: () => state.writable }));
vi.mock("@/hooks/useIntegrationProviders", () => ({
  INTEGRATION_PROVIDERS_KEY: ["integration-providers"],
  useIntegrationProviders: () => ({ data: { providers: [] }, isPending: false, isError: false, error: null }),
}));
vi.mock("@/hooks/useIntegrationHealth", () => ({
  INTEGRATION_HEALTH_KEY: ["integration-health"],
  useIntegrationHealth: () => ({ data: undefined, isError: false, status: { items: [] } }),
}));
// The account's sites are not what this is about: the list stays loading.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchProviderSites: () => new Promise(() => {}),
}));

import { ProviderConnectPanel } from "@/routes/integrations/ProviderConnectPanel";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

type Call = { url: string; method: string; body: unknown };
function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(configSaveReply(init)), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

/** A provider from the shipped catalog, connected and working. */
function connected(id: IntegrationProviderId, fields: string[]): IntegrationProviderStatus {
  const provider = INTEGRATION_PROVIDERS.find((entry) => entry.id === id)!;
  const credential: CredentialSummary = {
    provider: id, source: "store", fields, assetsHeld: [], missingFields: [], auth: null, metadata: null,
    keyVersion: null, createdAt: null, updatedAt: null,
    lastUsedAt: new Date(NOW - 3_600_000).toISOString(), lastOkAt: new Date(NOW - 3_600_000).toISOString(), lastError: null,
  };
  return { provider, credential, assets: [] };
}

const BING = () => connected("bing-webmaster", ["BING_WEBMASTER_API_KEY"]);
const GOOGLE = () => connected("google", ["GOOGLE_OAUTH_REFRESH_TOKEN"]);

function renderPanel(status: IntegrationProviderStatus) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ProviderConnectPanel
          status={status}
          opened="sites"
          asset={null}
          canConnect
          items={[]}
          names={new Map()}
          onClose={() => {}}
          onChanged={async () => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.schedules = null;
  state.settingsRead = true;
  state.writable = { writable: true, reason: null };
  toasts.success.mockReset();
  toasts.error.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("where each collection's schedule is changed", () => {
  it("puts every collection on a connection's panel or in Settings, never both and never neither", () => {
    const collections = SCHEDULED_JOBS.filter(isCollectionJob);
    const providers = INTEGRATION_PROVIDERS.map((provider) => provider.id);
    const onPanels = new Set(providers.flatMap((provider) => connectionCollections(provider).map((job) => job.id)));
    const inSettings = new Set(settingsCollections().map((job) => job.id));
    for (const job of collections) expect(onPanels.has(job.id) !== inSettings.has(job.id), job.id).toBe(true);
    // Every connection a job names is one the catalog ships.
    for (const job of collections) for (const provider of job.connections ?? []) expect(providers).toContain(provider);
    // The operator's split (2026-09-24): what no connection feeds stays in Settings.
    expect([...inSettings]).toEqual(["pull", "counters", "panel-refresh"]);
    expect(connectionCollections("google").map((job) => job.id)).toEqual(["signal-dumps"]);
    expect(connectionCollections("bing-webmaster").map((job) => job.id)).toEqual(["signal-dumps"]);
    expect(connectionCollections("mediavine").map((job) => job.id)).toEqual(["mediavine"]);
    expect(connectionCollections("dataforseo").map((job) => job.id)).toEqual(["dataforseo"]);
    expect(connectionCollections("discord")).toEqual([]);
  });

  it("links a collection to the panel of a connected source, to Settings, or nowhere when nothing is connected", () => {
    const job = (id: string) => SCHEDULED_JOBS.find((entry) => entry.id === id)!;
    expect(scheduleHref(job("pull"), () => false)).toBe("/settings#data-collection");
    expect(scheduleHref(job("signal-dumps"), (provider) => provider === "bing-webmaster")).toBe("/integrations?connect=bing-webmaster");
    expect(scheduleHref(job("signal-dumps"), () => true)).toBe("/integrations?connect=google");
    expect(scheduleHref(job("signal-dumps"), () => false)).toBeNull();
  });
});

describe("a connection's Manage panel", () => {
  it("shows the shared job under its own name on Bing's panel and on Google's", () => {
    stubFetch();
    for (const status of [BING(), GOOGLE()]) {
      const { unmount } = renderPanel(status);
      const dialog = screen.getByRole("dialog");
      const schedule = dialog.querySelector<HTMLElement>("[data-connection-schedule]")!;
      const rows = [...schedule.querySelectorAll("[data-schedule-row]")].map((row) => row.getAttribute("data-schedule-row"));
      expect(rows).toEqual(["signal-dumps"]);
      // Labelled by the job, so the pick reads as the job's, not the provider's.
      expect(within(schedule).getByText("Traffic and search archives")).toBeVisible();
      expect(within(schedule).getByText("Google Analytics · Search Console · Bing")).toBeVisible();
      expect(within(schedule).getByRole("combobox", { name: "Traffic and search archives · how often" })).toHaveValue("daily");
      // Under the connection's own actions, above its sites.
      const disconnect = within(dialog).getByRole("button", { name: "Disconnect" });
      expect(disconnect.compareDocumentPosition(schedule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      unmount();
    }
  });

  it("saves a pick in either panel as the job's one guarded schedules write, with Saved · Undo beside it", async () => {
    const saved: ScheduleOverrides = { pull: { enabled: true, cron: "30 2 * * *" } };
    state.schedules = saved;
    const calls = stubFetch();
    renderPanel(GOOGLE());

    fireEvent.change(screen.getByRole("combobox", { name: "Traffic and search archives · time" }), { target: { value: "09:15" } });

    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
    const put = calls.filter((call) => call.method === "PUT").at(-1)!;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(put.url).toBe("/api/config");
    expect(put.body).toMatchObject({
      slug: "schedule-signal-dumps",
      ops: [{
        kind: "file-json-set", file: "config/constants.json", pointer: "/schedules", expect: saved,
        value: { ...saved, "signal-dumps": { enabled: true, cron: "15 9 * * *", timezone: zone } },
      }],
    });
    const row = document.querySelector<HTMLElement>('[data-connection-schedule] [data-schedule-row="signal-dumps"]')!;
    await waitFor(() => expect(row.querySelector('[data-save-state="saved"]')).not.toBeNull());
    expect(within(row).getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("shows no schedule while the key is being replaced, and none for a connection that feeds no collection", () => {
    stubFetch();
    const { unmount } = renderPanel(BING());
    fireEvent.click(screen.getByRole("button", { name: "Replace API key" }));
    expect(document.querySelector("[data-connection-schedule]")).toBeNull();
    unmount();

    renderPanel(connected("discord", ["DISCORD_WEBHOOK_URL"]));
    expect(document.querySelector("[data-connection-schedule]")).toBeNull();
  });

  it("draws nothing before the saved schedules are read, and a lock while saves are paused", () => {
    stubFetch();
    state.settingsRead = false;
    const first = renderPanel(BING());
    expect(document.querySelector("[data-schedule-row]")).toBeNull();
    first.unmount();

    state.settingsRead = true;
    state.writable = { writable: false, reason: "Read-only deployment" };
    renderPanel(BING());
    expect(document.querySelector("[data-schedules-locked]")).not.toBeNull();
    expect(screen.getByRole("combobox", { name: "Traffic and search archives · time" })).toBeDisabled();
  });
});
