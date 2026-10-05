import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// Coming back from Google's consent screen with a failure (bead
// ro-ujb9.96.6.25): the page says it once. The notice is raised from an effect,
// and React runs effects twice in development — the Tower's own dev server,
// which is what an installation's operator opens — so without an id each
// return stacked two copies of the same toast.

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", async (importOriginal) => ({ ...(await importOriginal<typeof import("sonner")>()), toast }));
vi.mock("@/hooks/useIntegrationProviders", () => ({
  INTEGRATION_PROVIDERS_KEY: ["integration-providers"],
  useIntegrationProviders: () => ({ data: undefined, isPending: true, isError: false, error: null }),
}));
vi.mock("@/hooks/useIntegrationHealth", () => ({
  INTEGRATION_HEALTH_KEY: ["integration-health"],
  useIntegrationHealth: () => ({ data: undefined, isError: false, status: undefined }),
}));

import { IntegrationsRoute } from "@/routes/IntegrationsRoute";

describe("coming back from Google with a failure", () => {
  it("raises one notice per return, however often the effect runs", () => {
    render(
      <StrictMode>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={["/integrations?google=unreachable"]}>
            <IntegrationsRoute />
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    );
    expect(toast.error).toHaveBeenCalled();
    // Every call names the same toast, so Sonner updates it instead of adding one.
    const ids = new Set(toast.error.mock.calls.map(([, options]) => (options as { id?: string }).id));
    expect([...ids]).toEqual(["google-oauth-unreachable"]);
    expect(toast.error.mock.calls[0]![0]).toBe("Google did not answer. Try again.");
  });
});
