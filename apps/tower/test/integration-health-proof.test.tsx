import { integrationStatus } from '@shared/integration-status';
import { fireEvent, render, screen, within } from "./render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  collectionCadenceHours, connectionHealthState, emptyIntegrationsHistory,
  summarize, summarizeConnectionHealth, verifiedCollectionEvidence,
  type IntegrationCell, type IntegrationEvidence, type IntegrationsMatrix,
} from "@shared/integrations";
import { AMBER_MULTIPLIER } from "@shared/wall";
import { buildCatalog, buildEgressLane, buildNightlyReportLane } from "../worker/integrations-payload";
import { registerKind } from "@shared/connection-status";
import { IntegrationSummaryStrip } from "@/components/IntegrationSummaryStrip";
import { IntegrationMatrix } from "@/components/IntegrationMatrix";

const NOW = Date.parse("2026-09-06T12:00:00Z");
const state = vi.hoisted(() => ({ data: null as IntegrationsMatrix | null }));
vi.mock("@/hooks/useIntegrations", () => ({ useIntegrations: () => ({ data: state.data, isPending: false }) }));
vi.mock("@/hooks/useIntegrationProviders", () => ({ useIntegrationProviders: () => ({ data: null }) }));
vi.mock("@/hooks/useNow", () => ({ useNow: () => Date.parse("2026-09-06T12:00:00Z") }));
vi.mock("@/hooks/useWorkflows", () => ({ useWorkflows: () => ({ data: undefined, isError: false }) }));
vi.mock("@/hooks/useGa4Realtime", () => ({ useGa4Realtime: () => ({ data: undefined, isError: false }) }));
import { HealthRoute } from "@/routes/HealthRoute";

function proof(laneId: string, at = "2026-09-06T11:55:00Z"): IntegrationEvidence {
  return { polarity: "supporting", source: "Successful collection", detail: "A request succeeded.", at,
    verification: { kind: "collection-success", laneId } };
}
function cell(laneId: string, evidence: IntegrationEvidence[] = [], effective: IntegrationCell["effective"] = "live"): IntegrationCell {
  return { assetId: "example.test", laneId, declared: effective, effective, evidence, note: "Configured", ref: null, since: "2026-09-01" };
}
function mixedMatrix(): IntegrationsMatrix {
  const cells = [cell("gsc", [proof("gsc")]), cell("ga4", [proof("ga4", "2026-09-05T12:00:00Z")]),
    cell("clarity"), cell("bing-webmaster", [], "degraded"), cell("dataforseo", [], "needs-setup"),
    cell("uptime", [], "skipped"), cell("ad-network", [], "not-applicable")];
  const assets = [{ id: "example.test", displayName: "Example", isOs: true }];
  const derivedLanes = [
    buildNightlyReportLane(assets, new Map([["example.test", "2026-09-06T08:00:00Z"]]), [], new Date(NOW)),
    buildEgressLane(assets, null, null),
  ];
  return { generatedAt: new Date(NOW).toISOString(), owner: "config/integrations.json", assets,
    catalog: buildCatalog(cells.map((source) => ({ id: source.laneId, label: source.laneId, docRef: "docs/11-integrations.md" }))),
    cells: { "example.test": cells }, derivedLanes,
    summary: summarize([...cells, ...derivedLanes.flatMap((lane) => Object.values(lane.cells))]),
    history: emptyIntegrationsHistory(), undeclared: [], sharedCredential: { lanes: 0, cells: 0 },
    dataSpend: { period: "2026-09", spentUsd: 0, unknownPrices: 0, capUsd: 25, byAsset: [], unattributedUsd: 0, unattributedUnknownPrices: 0 } };
}
const allCells = (matrix: IntegrationsMatrix) => [...Object.values(matrix.cells).flat(), ...matrix.derivedLanes.flatMap((lane) => Object.values(lane.cells))];

describe("current working proof is stricter than historical setup proof", () => {
  // Clarity moved to this list with bead ro-at7t: its daily export's manifests
  // became the lane's collection, with the one-day cadence the ingest's own
  // health read already held it to.
  // Uptime joined with bead ro-ujb9.165: the OS checks each home page hourly.
  it.each(["gsc", "ga4", "bing-webmaster", "dataforseo", "clarity", "nightly-report", "uptime"])("uses the existing %s cadence at its exact boundary", (laneId) => {
    const window = collectionCadenceHours(laneId)! * AMBER_MULTIPLIER * 3_600_000;
    const current = cell(laneId, [proof(laneId, new Date(NOW - window).toISOString())]);
    expect(connectionHealthState(current, NOW)).toBe("live");
    const old = cell(laneId, [proof(laneId, new Date(NOW - window - 1).toISOString())]);
    expect(connectionHealthState(old, NOW)).toBe("unverified");
    expect(verifiedCollectionEvidence(old, NOW)).not.toBeNull();
  });

  it.each(["egress", "unknown-source"])("does not invent a freshness policy for %s", (laneId) => {
    expect(connectionHealthState(cell(laneId, [proof(laneId)]), NOW)).toBe("unverified");
  });

  it.each([null, "2026-09-06", "2026-02-30T12:00:00Z", "2026-09-07T12:00:00Z"])("rejects malformed, absent and future success dates (%s)", (at) => {
    expect(connectionHealthState(cell("gsc", [{ ...proof("gsc"), at }]), NOW)).toBe("unverified");
  });

  it("does not borrow another source's proof or infer proof from old payload prose", () => {
    expect(connectionHealthState(cell("gsc", [proof("ga4")]), NOW)).toBe("unverified");
    const { verification: _verification, ...legacyEvidence } = proof("gsc");
    expect(connectionHealthState(cell("gsc", [legacyEvidence]), NOW)).toBe("unverified");
  });

  it.each(["degraded", "needs-setup", "skipped", "not-applicable"] as const)("preserves %s even with a dated success", (effective) => {
    expect(connectionHealthState(cell("gsc", [proof("gsc")], effective), NOW)).toBe(effective);
  });

  it("keeps mixed counts separate without mutating raw states or history", () => {
    const matrix = mixedMatrix();
    const before = JSON.stringify(matrix);
    expect(matrix.summary.counts.live).toBe(5);
    expect(summarizeConnectionHealth(allCells(matrix), NOW)).toEqual({ total: 9, needsAttention: 2,
      counts: { live: 2, unverified: 3, degraded: 1, "needs-setup": 1, skipped: 1, "not-applicable": 1 } });
    expect(JSON.stringify(matrix)).toBe(before);
  });

  it("does not verify event-triggered egress after an old success or a manually cleared failure", () => {
    const assets = [{ id: "example.test", displayName: "Example", isOs: true }];
    for (const up of [true, false]) {
      const lane = buildEgressLane(assets, null, { observedAt: "2026-09-01T12:00:00Z", up, detail: null });
      expect(lane.cells["example.test"]?.effective).toBe("live");
      expect(connectionHealthState(lane.cells["example.test"]!, NOW)).toBe("unverified");
    }
  });
});

describe("health headline, audit summary and cell labels agree", () => {
  /** The register's own reading, in the connection vocabulary. */
  const tally = (matrix: IntegrationsMatrix) => {
    const counts: Partial<Record<ReturnType<typeof registerKind>, number>> = {};
    for (const source of allCells(matrix)) counts[registerKind(source, NOW)] = (counts[registerKind(source, NOW)] ?? 0) + 1;
    return counts;
  };

  it("counts recent provider and accepted-report proof the same way in the strip, the grid and the accordion", () => {
    const matrix = mixedMatrix();
    render(<MemoryRouter><IntegrationSummaryStrip counts={tally(matrix)} /><IntegrationMatrix matrix={matrix} nowMs={NOW} /></MemoryRouter>);
    expect(screen.getByText("Working · 2")).toBeVisible();
    expect(screen.getByText("Not checked · 3")).toBeVisible();
    expect(screen.getByText("Failing · 1")).toBeVisible();
    expect(screen.getByText("1 failing · 2 working · 1 not connected")).toBeVisible();
    expect(within(screen.getByRole("table")).getAllByText("Working")).toHaveLength(2);
    expect(within(screen.getByRole("table")).getAllByText("Not checked")).toHaveLength(3);
  });

  it("reads a provider's source as Unknown while the credential and monitoring reads are missing", () => {
    const matrix = mixedMatrix();
    const before = JSON.stringify(matrix);
    state.data = matrix;
    const { container } = render(<MemoryRouter><HealthRoute /></MemoryRouter>);
    fireEvent.click(within(container.querySelector('[data-panel="audit"]')!).getByRole("button"));
    const strip = container.querySelector("[data-summary-strip]")!;
    // Five provider sources cannot be read without their reads: Unknown, never
    // the register's configured Working. The nightly report is the store's own.
    expect(strip).toHaveTextContent("Unknown · 5");
    expect(strip).toHaveTextContent("Working · 1");
    expect(strip).not.toHaveTextContent("Working · 2");
    expect(JSON.stringify(matrix)).toBe(before);
  });

  it("cannot give configuration-only or old payloads an all-clear headline", () => {
    const matrix = mixedMatrix();
    matrix.cells = { "example.test": [cell("gsc"), cell("clarity")] };
    matrix.derivedLanes = [];
    matrix.summary = summarize(allCells(matrix));
    state.data = matrix;
    const { container } = render(<MemoryRouter><HealthRoute /></MemoryRouter>);
    expect(container.querySelector("[data-connections-unconfirmed]")).toHaveTextContent("Not confirmed");
    expect(screen.queryByText("Nothing needs you")).toBeNull();
    expect(screen.queryByText(/every connection.*working/)).toBeNull();
  });
});

vi.mock('@/hooks/useIntegrationHealth', () => ({ INTEGRATION_HEALTH_KEY: ['integration-health'], useIntegrationHealth: () => ({ data: undefined, isError: false, status: integrationStatus(undefined, false, Date.now()) }) }));
