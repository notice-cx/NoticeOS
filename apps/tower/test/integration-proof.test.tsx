import { fireEvent, render, screen } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  emptyIntegrationsHistory,
  summarize,
  verifiedCollectionEvidence,
  type IntegrationCell,
  type IntegrationEvidence,
  type IntegrationsConfig,
  type IntegrationsMatrix,
} from "@shared/integrations";
import { IntegrationMatrix } from "@/components/IntegrationMatrix";
import { buildAssetIntegrations, buildCatalog, mergeLane, type LatestSignalRun } from "../worker/integrations-payload";

const NOW = Date.parse("2026-09-06T12:00:00Z");
const AT = "2026-09-06T11:55:00Z";
const catalog = buildCatalog([{
  id: "gsc", label: "Google Search Console",
  docRef: "docs/11-integrations.md", credential: "shared", layer: "provider",
}])[0]!;
function cell(overrides: Partial<IntegrationCell> = {}): IntegrationCell {
  return {
    assetId: "example.test", laneId: "gsc", effective: "live", declared: "live",
    note: "Configured", ref: null, since: "2026-09-01", evidence: [], ...overrides,
  };
}
function run(overrides: Partial<LatestSignalRun> = {}): LatestSignalRun {
  return {
    asset: "example.test", integration: "gsc", status: "success", finishedAt: AT,
    windowStart: "2026-09-01", windowEnd: "2026-09-05", dataState: "final", provisionalFrom: null,
    providerRows: 5, observationCount: 5, errorCode: null, errorMessage: null, ...overrides,
  };
}
const success: IntegrationEvidence = {
  polarity: "supporting", source: "Search Console collector succeeded", detail: "5 rows returned.", at: AT,
  verification: { kind: "collection-success", laneId: "gsc" },
};

// A source's proof of access is a dated success of its own collector and
// nothing else; `connectionHealthState` reads it.
describe("collection proof requires an explicit dated collector success", () => {
  it.each([
    ["configuration only", cell()],
    ["configured degraded", cell({ effective: "degraded" })],
    ["a missing-run warning", cell({ effective: "needs-setup", evidence: [{ polarity: "against", source: "No recent run", detail: "None recorded.", at: null }] })],
    ["an arbitrary dated supporting note", cell({ evidence: [{ polarity: "supporting", source: "Manual note", detail: "Looks fine.", at: AT }] })],
    ["manual CSV revenue", cell({ laneId: "ad-network", evidence: [{ polarity: "supporting", source: "Revenue in the ledger", detail: "Manually imported.", at: null }] })],
    ["a different source's successful run", cell({ laneId: "ga4", evidence: [success] })],
    ["a successful run with an invalid date", cell({ evidence: [{ ...success, at: "not-a-date" }] })],
    ["a successful run with only a calendar date", cell({ evidence: [{ ...success, at: "2026-09-06" }] })],
    ["a successful run with an impossible calendar date", cell({ evidence: [{ ...success, at: "2026-02-30T12:00:00Z" }] })],
    ["a successful run without a date", cell({ evidence: [{ ...success, at: null }] })],
    ["a future-dated successful run", cell({ evidence: [{ ...success, at: "2026-09-07T00:00:00Z" }] })],
  ] as const)("does not verify access or collection from %s", (_name, source) => {
    expect(verifiedCollectionEvidence(source, NOW)).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity])("cannot verify collection with an invalid current clock (%s)", (nowMs) => {
    expect(verifiedCollectionEvidence(cell({ evidence: [success] }), nowMs)).toBeNull();
  });

  it.each(["skipped", "not-applicable"] as const)("claims no proof for %s sources", (effective) => {
    expect(verifiedCollectionEvidence(cell({ effective, evidence: [success] }), NOW)).toBeNull();
  });

  it("verifies collection from its own source's dated success", () => {
    expect(verifiedCollectionEvidence(cell({ evidence: [success] }), NOW)).toMatchObject({ at: AT });
  });
});

describe("the server creates proof only from successful collector outcomes", () => {
  it.each(["ga4", "gsc", "bing-webmaster", "dataforseo"] as const)("marks the actual %s success with its own source id", (integration) => {
    const merged = mergeLane("live", integration, { revenueRows: [], signalRuns: [run({ integration })], nowMs: NOW });
    expect(merged.evidence[0]?.verification).toEqual({ kind: "collection-success", laneId: integration });
  });

  it.each(["invalid_credentials", "budget_exhausted"])("does not treat %s as verified access", (errorCode) => {
    const merged = mergeLane("live", "gsc", {
      revenueRows: [], signalRuns: [run({ status: "error", errorCode, errorMessage: "Unavailable" })], nowMs: NOW,
    });
    expect(merged.effective).toBe("degraded");
    expect(merged.evidence.every((item) => item.verification === undefined)).toBe(true);
    expect(verifiedCollectionEvidence(cell(merged), NOW)).toBeNull();
  });

  it("retains historical success when stale without turning health green", () => {
    const merged = mergeLane("live", "gsc", { revenueRows: [], signalRuns: [run({ finishedAt: "2026-09-01T00:00:00Z" })], nowMs: NOW });
    expect(merged.effective).toBe("degraded");
    expect(merged.evidence[0]?.polarity).toBe("against");
    // Old proof of collection stays proof; it is the health that goes stale.
    expect(verifiedCollectionEvidence(cell(merged), NOW)).not.toBeNull();
  });

  it("a successful zero-row request verifies collection, not traffic", () => {
    const config: IntegrationsConfig = {
      catalog: [{ id: "gsc", label: "Google Search Console", docRef: "docs/11-integrations.md" }],
      assets: { "example.test": { gsc: { status: "live", note: "Configured", since: "2026-09-01" } } },
    };
    const lane = buildAssetIntegrations("example.test", config, {
      revenueRows: [], signalRuns: [run({ providerRows: 0, observationCount: 0 })], nowMs: NOW,
    }).lanes[0]!;
    // Proof of collection — the request succeeded, whatever it returned.
    expect(verifiedCollectionEvidence(lane.cell, NOW)).not.toBeNull();
    expect(lane.cell.evidence[0]?.verification).toEqual({ kind: "collection-success", laneId: "gsc" });
  });
});

function matrix(source: IntegrationCell): IntegrationsMatrix {
  return {
    generatedAt: new Date(NOW).toISOString(), owner: "config/integrations.json", catalog: [catalog], derivedLanes: [],
    assets: [{ id: "example.test", displayName: "Example", isOs: false }], cells: { "example.test": [source] },
    summary: summarize([source]), undeclared: [], sharedCredential: { lanes: 0, cells: 0 },
    dataSpend: { period: "2026-09", spentUsd: 0, unknownPrices: 0, capUsd: 25, byAsset: [], unattributedUsd: 0, unattributedUnknownPrices: 0 }, history: emptyIntegrationsHistory(),
  };
}
describe("System health connection details distinguish configuration from proof", () => {
  it("labels unverified live configuration and links directly to the source screen", () => {
    render(<MemoryRouter><IntegrationMatrix matrix={matrix(cell())} nowMs={NOW} /></MemoryRouter>);
    // Configured without proof is Not checked: never Working, never a sentence.
    expect(screen.getAllByText("Not checked")).toHaveLength(2);
    expect(screen.queryByText("Working")).toBeNull();
    expect(screen.getAllByRole("link", { name: "Not checked" }).every((link) => link.getAttribute("href") === "/assets/example.test/sources")).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Google Search Console" })[0]!);
    expect(screen.queryByText(/Configured status alone does not verify access/)).toBeNull();
  });

  it("keeps observed successful connections working", () => {
    render(<MemoryRouter><IntegrationMatrix matrix={matrix(cell({ evidence: [success] }))} nowMs={NOW} /></MemoryRouter>);
    expect(screen.getAllByText("Working")).toHaveLength(2);
    expect(screen.queryByText("Not checked")).toBeNull();
  });
});
