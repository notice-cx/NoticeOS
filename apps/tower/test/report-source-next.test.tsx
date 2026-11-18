import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialSummary } from "@noticeos/contract/integrations";
import { BrowserRuntimeProvider } from "@/lib/browser-context";
import { createBrowserRuntime } from "@/lib/browser-runtime";
import { ReportSourceNext } from "@/routes/asset-detail/ReportSourceNext";
import { everyTabPayload } from "./asset-detail-fixture";

const read = vi.hoisted(() => ({ credential: undefined as CredentialSummary | undefined }));
vi.mock("@/hooks/useConnections", () => ({ useConnections: () => ({
  credentials: read.credential && new Map([["google", read.credential]]),
  items: [], providers: { data: { keyPresent: true } },
}) }));

const unwired: CredentialSummary = {
  provider: "google", source: "none", fields: [], assetsHeld: [], missingFields: [], auth: null, metadata: null,
  keyVersion: null, createdAt: null, updatedAt: null, lastUsedAt: null, lastOkAt: null, lastError: null,
};
const nowMs = Date.parse("2026-10-25T10:00:00Z");

function view({ role = "owner", preview, mapped = false }: { role?: "owner" | "operator" | "viewer"; preview?: true; mapped?: boolean } = {}) {
  const id = crypto.randomUUID();
  const runtime = createBrowserRuntime<never>({ mode: "hosted", clientGeneration: 1, workspaceId: id, principalId: id, sessionId: id },
    { origin: location.origin, fetch: globalThis.fetch, sendAnswer: async () => {} });
  const data = everyTabPayload();
  const template = data.integrations.lanes[0]!;
  data.integrations.lanes = [{ ...template, catalog: { ...template.catalog, id: "ga4" }, cell: {
    ...template.cell, laneId: "ga4", effective: "needs-setup", evidence: [], mapped,
  } }];
  render(<BrowserRuntimeProvider value={{ runtime, workspaceLabel: "Example workspace", workspaceRole: role, backupPreview: preview }}>
    <MemoryRouter initialEntries={["/assets/meadow.example/growth?range=90"]}>
      <ReportSourceNext report="audience" assetTab="growth" data={data} nowMs={nowMs} />
    </MemoryRouter>
  </BrowserRuntimeProvider>);
}

afterEach(() => { read.credential = undefined; });

describe("empty reports use the saved connection and verified access", () => {
  it("opens the named source for an operator", () => {
    read.credential = unwired;
    view({ role: "operator" });
    expect(screen.getByRole("link", { name: "Connect Google" })).toHaveAttribute("href", "/integrations?connect=google&asset=meadow.example&fromReport=growth&range=90");
  });

  it.each([{ role: "viewer" as const }, { preview: true as const }])("has guidance without an editor for %j", options => {
    read.credential = unwired;
    view(options);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("waits for connection facts before offering setup", () => {
    view();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps a mapped, connected provider out of setup while waiting for evidence", () => {
    read.credential = { ...unwired, source: "store" };
    view({ mapped: true });
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("leads a viewer from a failed connected source to its saved status", () => {
    read.credential = { ...unwired, source: "store", lastUsedAt: "2026-10-25T09:59:00Z", lastError: "Access changed" };
    view({ mapped: true, role: "viewer" });
    expect(screen.getByRole("link", { name: "Review data sources" })).toHaveAttribute("href", "/assets/meadow.example/sources");
  });
});
