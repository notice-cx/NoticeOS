import { describe, expect, it } from "vitest";
import type { CredentialSummary } from "@noticeos/contract/integrations";
import type { IntegrationHealthItem } from "@noticeos/contract/integration-health";
import type { ScheduledLane, SystemBand } from "@shared/wall";
import { systemFlow } from "@/lib/system-flow";
import { backupLane, backupNight, pressedBackupLane } from "./backup-lanes";

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
  it("draws only connected providers, and a provider failing on some assets as at risk with its onset", () => {
    const credentials = new Map([["google", credential("google")], ["bing-webmaster", credential("bing-webmaster")]]);
    const items = [
      item("google", "ga4-daily", "a.example", "healthy", at(1)),
      item("google", "ga4-daily", "b.example", "healthy", at(1)),
      item("google", "ga4-daily", "c.example", "failing", at(6)),
      item("bing-webmaster", "bing-daily", "a.example", "healthy", at(1)),
    ];
    const { nodes, edges } = systemFlow({ credentials, items, system: system([{ job: "signals", outcome: "ran", startedAt: at(0.1), lastRanAt: at(0.1), failedRuns: 0, failingSince: null }]), nowMs: NOW });
    const sources = nodes.filter((node) => node.id.startsWith("source:"));
    expect(sources.map((node) => node.label)).toEqual(["Google", "Bing"]);
    expect(sources[0]).toMatchObject({ state: "warn", since: at(6), caption: "1 of 3 assets failing" });
    expect(sources[1]).toMatchObject({ state: "ok" });
    expect(nodes.find((node) => node.id === "collectors")).toMatchObject({ state: "warn", value: "1 of 2" });
    expect(edges.find((edge) => edge.from === "source:bing-webmaster")?.state).toBe("flowing");
  });

  describe("the backups node", () => {
    const signals = { job: "signals", outcome: "ran" as const, startedAt: at(0.1), lastRanAt: at(0.1), failedRuns: 0, failingSince: null };
    const backups = (lane: ScheduledLane) => {
      const { nodes, edges } = systemFlow({ credentials: new Map(), items: [], system: system([lane, signals]), nowMs: NOW });
      return { node: nodes.find((node) => node.id === "backups"), edge: edges.find((edge) => edge.to === "backups")?.state, runner: nodes.find((node) => node.id === "runner")?.state };
    };

    it("dates twelve failed nights from the first, captioned with the last good copy's age, and breaks the store's edge", () => {
      const { node, edge, runner } = backups(backupLane(NOW, 12, backupNight(NOW, 12)));
      expect(node).toMatchObject({ state: "error", since: backupNight(NOW, 11), caption: "last good copy 12d ago" });
      expect(edge).toBe("broken");
      expect(runner).toBe("error");
    });

    it("is amber after one failed night and red after two", () => {
      expect(backups(backupLane(NOW, 1, backupNight(NOW, 1)))).toMatchObject({ node: { state: "warn", since: backupNight(NOW, 0), caption: "last good copy 1d ago" }, edge: "flowing" });
      expect(backups(backupLane(NOW, 2, backupNight(NOW, 2)))).toMatchObject({ node: { state: "error", since: backupNight(NOW, 1), caption: "last good copy 2d ago" }, edge: "broken" });
    });

    it("is green once a backup runs after the failures, scheduled or pressed", () => {
      expect(backups(backupLane(NOW, 0, backupNight(NOW, 0))).node).toMatchObject({ state: "ok", since: null, caption: "last good copy 16h ago" });
      expect(backups(pressedBackupLane(NOW, at(1))).node).toMatchObject({ state: "ok", since: null, caption: "last good copy 1h ago" });
    });

    it("reads no good copy yet when none was ever made", () => {
      expect(backups(backupLane(NOW, 2, null)).node).toMatchObject({ state: "error", since: backupNight(NOW, 1), caption: "no good copy yet" });
    });
  });

  it("never calls an unread system healthy", () => {
    const { nodes, edges } = systemFlow({ credentials: undefined, items: null, system: null, nowMs: NOW });
    expect(nodes.find((node) => node.id === "store")).toMatchObject({ state: "idle", caption: "not read yet" });
    expect(nodes.find((node) => node.id === "runner")?.state).toBe("idle");
    expect(nodes.find((node) => node.id === "backups")?.state).toBe("absent");
    expect(edges.every((edge) => edge.state !== "flowing")).toBe(true);
  });
});
