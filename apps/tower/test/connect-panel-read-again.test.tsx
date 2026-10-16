import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "./render";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INTEGRATION_PROVIDERS, type CredentialSummary, type DiscoveredSite } from "@noticeos/contract";
import type { IntegrationProviderStatus } from "@shared/integrations-page";
import type { SitesAsset, SitesPayload } from "@shared/site-discovery";

// A site granted to the service account after the Google panel opened joins
// its list through Read again, without the panel closing.

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useSettings", () => ({ useSettings: () => ({ data: undefined, isPending: true, isError: false }) }));
vi.mock("@/hooks/useConfigWritable", () => ({ useConfigWritable: () => ({ writable: true, reason: null }) }));
vi.mock("@/hooks/useIntegrationProviders", () => ({
  INTEGRATION_PROVIDERS_KEY: ["integration-providers"],
  useIntegrationProviders: () => ({ data: { providers: [] }, isPending: false, isError: false, error: null }),
}));
vi.mock("@/hooks/useIntegrationHealth", () => ({
  INTEGRATION_HEALTH_KEY: ["integration-health"],
  useIntegrationHealth: () => ({ data: undefined, isError: false, status: { items: [] } }),
}));
const reads = vi.hoisted(() => ({ answers: [] as SitesPayload[], fetchProviderSites: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchProviderSites: reads.fetchProviderSites,
}));

import { ProviderConnectPanel } from "@/routes/integrations/ProviderConnectPanel";

const AT = "2026-09-23T15:00:00.000Z";
const ga4 = (id: string, host: string): DiscoveredSite => ({ lane: "ga4", ref: id, label: host, host, mapping: { propertyId: id }, ready: true });
const gsc = (url: string, host: string): DiscoveredSite => ({ lane: "gsc", ref: url, label: url, host, mapping: { siteUrl: url }, ready: true });
const journey: SitesAsset = {
  id: "journey.example", label: "Journey", domain: "journey.example", status: "live",
  cells: { ga4: { status: "needs-setup", mapping: {} }, gsc: { status: "needs-setup", mapping: {} } },
};
const listed = (sites: DiscoveredSite[]): SitesPayload => ({
  discovery: { ok: true, provider: "google", kind: "account", checkedAt: AT, sites, account: "signals@example.test", auth: "service-account" },
  assets: [journey],
  spend: null,
});

function google(): IntegrationProviderStatus {
  const provider = INTEGRATION_PROVIDERS.find((entry) => entry.id === "google")!;
  const credential: CredentialSummary = {
    provider: "google", source: "store", fields: ["GOOGLE_SIGNAL_ACCOUNTS"], assetsHeld: [], missingFields: [], auth: "service-account", metadata: null,
    keyVersion: null, createdAt: null, updatedAt: null, lastUsedAt: AT, lastOkAt: AT, lastError: null,
  };
  return { provider, credential, assets: [] };
}

afterEach(() => {
  reads.fetchProviderSites.mockReset();
  reads.answers = [];
});

describe("the Google panel's Read again", () => {
  it("reads the account again and lists the newly granted Search Console site in the open panel", async () => {
    reads.answers = [
      listed([ga4("538680421", "journey.example")]),
      listed([ga4("538680421", "journey.example"), gsc("sc-domain:journey.example", "journey.example")]),
    ];
    reads.fetchProviderSites.mockImplementation(async () => reads.answers.shift()!);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ProviderConnectPanel
            status={google()} opened="sites" asset={null} canConnect items={[]} names={new Map()}
            onClose={() => {}} onChanged={async () => {}}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const grant = await waitFor(() => {
      const line = document.querySelector('[data-site-grant="gsc"]');
      expect(line).not.toBeNull();
      return line!;
    });
    expect(grant.textContent).toMatch(/, then press Read again\.$/u);
    expect(document.querySelector('[data-site-row="journey.example"] [data-site-detail]')?.textContent).toBe("GA4 538680421 · Search Console: not in this account");

    fireEvent.click(screen.getByRole("button", { name: "Read again" }));
    await waitFor(() => expect(document.querySelector("[data-site-grant]")).toBeNull());
    expect(reads.fetchProviderSites).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-site-row="journey.example"] [data-site-detail]')?.textContent).toBe("GA4 538680421 · sc-domain:journey.example");
    expect(document.querySelector("[data-site-picker]")).not.toBeNull();
  });
});
