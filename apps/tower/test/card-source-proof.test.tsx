import { fireEvent, render, screen } from "./render";
import { describe, expect, it } from "vitest";
import type { CredentialSummary, IntegrationHealthItem } from "@noticeos/contract";
import { NO_READS, sourceReadings, sourcesSummary, type ConnectionReads } from "@shared/connection-status";
import { collectionCadenceHours } from "@shared/integrations";
import { AMBER_MULTIPLIER, type CardDataSource } from "@shared/wall";
import { DataSourceIcons } from "@/components/DataSourceIcons";
import { buildCardDataSources, type LatestSignalRun } from "../worker/integrations-payload";

// A source mark is never ahead of its proof (beads `ro-ujb9.96.7.3`,
// `ro-ujb9.96.7.16`). A provider's source reads the monitoring model; a
// source no provider collects (the nightly report) reads its register cell's
// typed collection proof, which a timestamp alone never satisfies.

const NOW = Date.parse("2026-09-06T12:00:00Z");
const ASSET = "example.test";
const nightly: CardDataSource = {
  id: "nightly-report", label: "Nightly report", state: "live", observedAt: "2026-09-06T04:00:00Z",
  verification: { kind: "collection-success", laneId: "nightly-report" },
};
const read = (source: CardDataSource, reads: ConnectionReads = NO_READS, nowMs = NOW) => sourceReadings(ASSET, [source], reads, nowMs)[0]!;
const unprovenCases: [string, CardDataSource][] = [
  ["configuration only", { ...nightly, observedAt: null, verification: undefined }],
  ["a date without an outcome", { ...nightly, verification: undefined }],
  ["a different source's success", { ...nightly, verification: { kind: "collection-success", laneId: "gsc" } }],
  ["an old success", { ...nightly, observedAt: "2026-09-04T11:55:00Z" }],
  ["a future success", { ...nightly, observedAt: "2026-09-07T11:55:00Z" }],
  ["an impossible date", { ...nightly, observedAt: "2026-02-30T11:55:00Z" }],
  ["a calendar date without a time", { ...nightly, observedAt: "2026-09-06" }],
  ["an undated success", { ...nightly, observedAt: null }],
];

describe("a source no provider collects keeps its typed collection proof", () => {
  it.each(unprovenCases)("does not show working from %s", (_name, source) => {
    expect(read(source).kind).toBe("not-checked");
    const { container } = render(<DataSourceIcons sources={[read(source)]} />);
    const icon = screen.getByRole("img", { name: "Nightly report: Not checked" });
    expect(icon.querySelector('[data-state-mark="unknown"]')).toHaveTextContent("?");
    expect(container.querySelector('[data-state-mark="check"], [data-state-mark="bang"]')).toBeNull();
    expect(icon).toHaveClass("size-4", "border-dashed");
    expect(icon).not.toHaveClass("text-connected", "text-warn");
  });

  it("keeps a fresh observed success green without changing mark geometry", () => {
    const { container } = render(<DataSourceIcons sources={[read(nightly)]} />);
    const icon = screen.getByRole("img", { name: "Nightly report: Working" });
    expect(icon).toHaveClass("text-connected", "size-4");
    expect(container.querySelector('[data-state-mark="check"]')).not.toBeNull();
  });

  it("uses the same source freshness boundary as System health", () => {
    const boundary = collectionCadenceHours("nightly-report")! * AMBER_MULTIPLIER * 3_600_000;
    expect(read({ ...nightly, observedAt: new Date(NOW - boundary).toISOString() }).kind).toBe("working");
    expect(read({ ...nightly, observedAt: new Date(NOW - boundary - 1).toISOString() }).kind).toBe("not-checked");
    expect(read(nightly, NO_READS, NaN).kind).toBe("not-checked");
  });

  it("reads a late nightly report as Overdue and a missing one as Not connected", () => {
    expect(read({ ...nightly, state: "degraded" }).kind).toBe("overdue");
    expect(read({ ...nightly, state: "needs-setup" }).kind).toBe("not-connected");
  });
});

describe("a provider's source reads the monitoring model, never its own payload state", () => {
  const ga4: CardDataSource = { id: "ga4", label: "Google Analytics", state: "live", observedAt: "2026-09-06T11:55:00Z", verification: { kind: "collection-success", laneId: "ga4" } };
  const at = "2026-09-06T11:50:00Z";
  const google: CredentialSummary = {
    provider: "google", source: "store", fields: ["GOOGLE_OAUTH_REFRESH_TOKEN"], assetsHeld: [], missingFields: [], auth: "oauth",
    metadata: null, keyVersion: 1, createdAt: at, updatedAt: at, lastUsedAt: at, lastOkAt: at, lastError: null,
  };
  const item = (over: Partial<IntegrationHealthItem>): IntegrationHealthItem => ({
    id: "i1", provider: "google", capability: "ga4-daily", label: "Analytics daily reports", asset: ASSET, detail: null, report: null, reportDate: null,
    state: "healthy", lastAttemptAt: at, lastSuccessAt: at, nextAttemptAt: null, failure: null, code: null,
    action: "Review the property connection.", coverage: "monitored", ...over,
  });
  const reads = (items: IntegrationHealthItem[]): ConnectionReads => ({ credentials: new Map([["google", google]]), items });

  it("is Unknown, never Working, while the reads have not answered", () => {
    expect(read(ga4).kind).toBe("unknown");
    render(<DataSourceIcons sources={[read(ga4)]} />);
    expect(screen.getByRole("img", { name: "Google Analytics: Unknown" }).querySelector('[data-state-mark="unknown"]')).not.toBeNull();
  });

  it("is Failing when its latest attempt fails, whatever its 15-minute run said", () => {
    const reading = read(ga4, reads([item({ state: "failing", lastSuccessAt: null, failure: "access", code: "access" })]));
    expect(reading.kind).toBe("failing");
    render(<DataSourceIcons sources={[reading]} />);
    const icon = screen.getByRole("img", { name: "Google Analytics: Failing" });
    expect(icon).toHaveClass("text-error");
    expect(icon.querySelector('[data-state-mark="bang"]')).toHaveTextContent("!");
  });

  it("is Working on a recorded success, and Not connected with nothing scheduled for it", () => {
    expect(read(ga4, reads([item({})])).kind).toBe("working");
    expect(read(ga4, reads([])).kind).toBe("not-connected");
  });

  it("keeps the register's scope decision: off and not applicable win", () => {
    expect(read({ ...ga4, state: "skipped" }, reads([item({})])).kind).toBe("not-using");
    expect(read({ ...ga4, state: "not-applicable" }, reads([item({})])).kind).toBe("not-applicable");
  });
});

describe("compact read-model evidence names actual successful outcomes", () => {
  const run: LatestSignalRun = {
    asset: ASSET, integration: "ga4", status: "success", finishedAt: "2026-09-06T11:55:00Z",
    windowStart: "2026-09-05", windowEnd: "2026-09-05", dataState: "final", provisionalFrom: null,
    providerRows: 0, observationCount: 0, errorCode: null, errorMessage: null,
  };
  function sources(signalRun = run) {
    return buildCardDataSources({ assetId: ASSET, latestReportAt: "2026-09-06T04:00:00Z", pull: null,
      now: new Date(NOW), signalRuns: [signalRun],
      integrations: { catalog: [
        { id: "ga4", label: "Google Analytics", docRef: "docs/11-integrations.md" },
        { id: "uptime", label: "Uptime", docRef: "docs/11-integrations.md" },
      ], assets: { [ASSET]: {
        ga4: { status: "live", note: "Configured", since: "2026-09-01" },
        uptime: { status: "live", note: "Configured", since: "2026-09-01" },
      } } } });
  }

  it("transports successful zero-row collection and accepted-report proof, never configuration proof", () => {
    const result = sources();
    expect(result.find((source) => source.id === "ga4")?.verification).toEqual({ kind: "collection-success", laneId: "ga4" });
    expect(result.find((source) => source.id === "nightly-report")?.verification).toEqual({ kind: "collection-success", laneId: "nightly-report" });
    expect(result.find((source) => source.id === "uptime")?.verification).toBeUndefined();
    // The nightly report is proven; uptime is configured but unproven; GA4 is
    // the monitoring model's to answer, and it has not.
    expect(sourcesSummary(sourceReadings(ASSET, result, NO_READS, NOW)).counts).toMatchObject({ working: 1, "not-checked": 1, unknown: 1 });
  });

  it("a dated failed attempt is not serialized as a successful outcome", () => {
    const source = sources({ ...run, status: "error", errorCode: "unavailable" }).find((entry) => entry.id === "ga4")!;
    expect(source.observedAt).toBe(run.finishedAt);
    expect(source.verification).toBeUndefined();
    expect(source.state).toBe("degraded");
  });
});


it("source states and recorded times open by focus and tap in one compact control (ro-ujb9.241)", () => {
  render(<DataSourceIcons sources={[read(nightly), { id: "uptime", label: "Uptime", kind: "not-checked",
    site: null, provider: null, detail: "Not checked yet", observedAt: null }]} />);
  const trigger = screen.getByRole("button", { name: "About data source states" });
  expect(trigger.querySelectorAll('[role="img"]')).toHaveLength(2);
  expect(trigger.querySelector('[role="img"]')).not.toHaveAttribute("title");
  fireEvent.focus(trigger);
  expect(screen.getByRole("tooltip")).toHaveTextContent("Nightly report: Working");
  expect(screen.getByRole("tooltip")).toHaveTextContent("Observed: 2026-09-06T04:00:00Z");
  expect(screen.getByRole("tooltip")).toHaveTextContent("Uptime: Not checked");
  expect(screen.getByRole("tooltip")).toHaveTextContent("Not checked yet");
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.pointerDown(trigger, { pointerType: "touch" });
  fireEvent.click(trigger);
  expect(screen.getByRole("tooltip")).toHaveTextContent("Observed: 2026-09-06T04:00:00Z");
});
