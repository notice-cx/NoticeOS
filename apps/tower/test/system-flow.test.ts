import { describe, expect, it } from "vitest";
import type { CredentialSummary } from "@noticeos/contract/integrations";
import type { IntegrationHealthItem } from "@noticeos/contract/integration-health";
import type { SystemBand } from "@shared/wall";
import { systemFlow } from "@/lib/system-flow";

const NOW = Date.parse("2026-10-11T20:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

const credential = (provider: string): CredentialSummary => ({
  provider, source: "store", fields: ["KEY"], assetsHeld: [], missingFields: [], auth: null, metadata: null,
  keyVersion: 1, createdAt: at(400), updatedAt: at(400), lastUsedAt: at(1), lastOkAt: at(1), lastError: null,
} as unknown as CredentialSummary);

const item = (provider: string, capability: string, asset: string, state: IntegrationHealthItem["state"], lastSuccessAt: string | null): IntegrationHealthItem => ({
  id: `${provider}-${capability}-${asset}`, provider, capability, label: capability, asset, detail: null, report: null, reportDate: null,
  state, lastAttemptAt: at(0.2), lastSuccessAt, nextAttemptAt: null, failure: state === "failing" ? "access" : null, code: null,
  action: "Review the connection.", coverage: "monitored",
} as IntegrationHealthItem);

const system = (lanes: SystemBand["scheduledLanes"]): SystemBand => ({
  assetId: "os.example", hasPulse: true, spendTodayUsd: 0.2, dailyCapUsd: 1,
  ingest: { fresh: 1, stale: 0, notExpected: 0, expected: 1 }, scheduledLanes: lanes,
});

describe("the system map", () => {
  it("draws only connected providers, and a provider failing on some sites as at risk with its onset", () => {
    const credentials = new Map([["google", credential("google")], ["bing-webmaster", credential("bing-webmaster")]]);
    const items = [
      item("google", "ga4-daily", "a.example", "healthy", at(1)),
      item("google", "ga4-daily", "b.example", "healthy", at(1)),
      item("google", "ga4-daily", "c.example", "failing", at(6)),
      item("bing-webmaster", "bing-daily", "a.example", "healthy", at(1)),
    ];
    const { nodes, edges } = systemFlow({ credentials, items, system: system([{ job: "signals", outcome: "ran", startedAt: at(0.1) }]), nowMs: NOW });
    const sources = nodes.filter((node) => node.id.startsWith("source:"));
    expect(sources.map((node) => node.label)).toEqual(["Google", "Bing"]);
    expect(sources[0]).toMatchObject({ state: "warn", since: at(6), caption: "1 of 3 sites failing" });
    expect(sources[1]).toMatchObject({ state: "ok" });
    expect(nodes.find((node) => node.id === "collectors")).toMatchObject({ state: "warn", value: "1 of 2" });
    expect(edges.find((edge) => edge.from === "source:bing-webmaster")?.state).toBe("flowing");
  });

  it("lights a failed backup on its node and breaks the store's edge to it", () => {
    const { nodes, edges } = systemFlow({
      credentials: new Map(),
      items: [],
      system: system([{ job: "backup", outcome: "failed", startedAt: at(6) }, { job: "signals", outcome: "ran", startedAt: at(0.1) }]),
      nowMs: NOW,
    });
    expect(nodes.find((node) => node.id === "backups")).toMatchObject({ state: "error", since: at(6), caption: "last run failed" });
    expect(edges.find((edge) => edge.to === "backups")?.state).toBe("broken");
    expect(nodes.find((node) => node.id === "runner")?.state).toBe("error");
  });

  it("never calls an unread system healthy", () => {
    const { nodes, edges } = systemFlow({ credentials: undefined, items: null, system: null, nowMs: NOW });
    expect(nodes.find((node) => node.id === "store")).toMatchObject({ state: "idle", caption: "not read yet" });
    expect(nodes.find((node) => node.id === "runner")?.state).toBe("idle");
    expect(nodes.find((node) => node.id === "backups")?.state).toBe("absent");
    expect(edges.every((edge) => edge.state !== "flowing")).toBe(true);
  });
});
