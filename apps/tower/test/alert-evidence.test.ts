// @vitest-environment node
import type { Transaction, WorkspaceStore } from "@noticeos/postgres";
import { afterEach, describe, expect, it } from "vitest";
import { deriveAlertEvidence, type AlertEvidenceInput, type AlertPulseEvidence } from "../shared/alert-evidence";
import { evidenceInstant, isAttentionEligible, summarizeVerification } from "../shared/signal-liveness";
import { countAttentionConditions, reviewAlertConditions, type EvidenceFlagRow } from "../worker/alert-evidence";
import { buildAssetDetailPayload, type AssetDetailDeps } from "../worker/asset-detail-payload";
import { buildWallPayload, type BuildOptions } from "../worker/wall-payload";
import { readAlerts, storeAlert, storeReport } from "./alert-rows";
import { createTestStore, type TestStore } from "./postgres-store";
import { addSites } from "./sites";

const NOW = new Date("2026-09-06T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const FRESH = "2026-09-06T04:00:00.000Z";
const OLD = "2026-08-03T04:00:00.000Z";
const base: AlertEvidenceInput = {
  asset: "example.test", ruleId: "hygiene-sitemap", kind: "anomaly", severity: "warn",
  metric: "sitemap", firedAt: OLD, ruleInputs: { lastObservedAt: FRESH, evaluatedAt: FRESH },
};
function report(options: { date?: string; flags?: unknown; metrics?: Record<string, unknown>; asset?: string } = {}): AlertPulseEvidence {
  const date = options.date ?? "2026-09-06";
  const asset = options.asset ?? "example.test";
  return {
    id: 7, asset, date, receivedAt: `${date}T04:01:00.000Z`,
    envelope: JSON.stringify({
      asset, generatedAt: `${date}T04:00:00.000Z`, capabilities: ["requests"],
      metrics: options.metrics ?? { requests: { last24h: 1, avg7d: 9, total: 50 } },
      flags: options.flags ?? [{ severity: "warn", kind: "anomaly", metric: "requests" }],
    }),
  };
}
const declared: AlertEvidenceInput = { ...base, ruleId: "asset-declared", metric: "requests", pulseId: 1, ruleInputs: null };

describe("alert evidence is separate from lifecycle", () => {
  it("recent site evidence confirms a month-old unresolved alert without changing onset", () => {
    const result = deriveAlertEvidence(base, NOW_MS);
    expect(result.liveness.state).toBe("live");
    expect(result.verification).toMatchObject({ state: "confirmed", lastConfirmedAt: FRESH, lastEvaluatedAt: FRESH });
    expect(base.firedAt).toBe(OLD);
  });
  it("a stopped evaluator leaves last-known attention visible", () => {
    const result = deriveAlertEvidence({ ...base, ruleInputs: { lastObservedAt: OLD, evaluatedAt: OLD } }, NOW_MS);
    expect(result.verification).toMatchObject({ state: "unverified", lastConfirmedAt: OLD, lastEvaluatedAt: OLD });
    expect(result.liveness.state).toBe("last-known");
    expect(isAttentionEligible(result.liveness)).toBe(true);
  });
  it.each([null, {}, { evaluatedAt: FRESH }, { lastObservedAt: "2026-09-07T00:00:00Z", evaluatedAt: FRESH }])(
    "missing, partial or future evaluator evidence does not confirm: %j", (ruleInputs) => {
      expect(deriveAlertEvidence({ ...base, ruleInputs }, NOW_MS).verification.state).toBe("unverified");
    },
  );
  it("unknown rules cannot borrow known-looking timestamps", () => {
    const result = deriveAlertEvidence({ ...base, ruleId: "brand-new-rule" }, NOW_MS);
    expect(result.verification).toMatchObject({ state: "unverified", source: null });
    expect(isAttentionEligible(result.liveness)).toBe(true);
  });
  it("old ingest freshness evaluation is not refreshed by reading the page", () => {
    const result = deriveAlertEvidence({ ...base, ruleId: "ingest-freshness", ruleInputs: { evaluatedAt: OLD } }, NOW_MS);
    expect(result.verification).toMatchObject({ state: "unverified", lastEvaluatedAt: OLD });
  });
  it("quota age uses the actual lane's cadence", () => {
    const flag = { ...base, ruleId: "ga4-quota-pressure" };
    expect(deriveAlertEvidence({ ...flag, ruleInputs: { lane: "google-signals", lastObservedAt: FRESH } }, NOW_MS).verification.state).toBe("unverified");
    expect(deriveAlertEvidence({ ...flag, ruleInputs: { lane: "signal-dumps", lastObservedAt: FRESH } }, NOW_MS).verification.state).toBe("confirmed");
    expect(deriveAlertEvidence({ ...flag, ruleInputs: { lane: "unknown", lastObservedAt: FRESH } }, NOW_MS).verification.state).toBe("unverified");
  });
  it("recorded closure is not verified recovery and decisions remain actionable", () => {
    expect(deriveAlertEvidence({ ...base, resolvedAt: FRESH }, NOW_MS).verification.state).toBe("recorded-closed");
    const decision = deriveAlertEvidence({ ...base, ruleId: "watch-window-closed" }, NOW_MS, null, { outcome: "inconclusive", readbackBead: "ex-12" });
    expect(decision.verification.state).toBe("not-applicable");
    expect(decision.liveness).toEqual({ state: "awaiting-decision", verdict: "inconclusive", decisionHome: "ex-12" });
    expect(isAttentionEligible(decision.liveness)).toBe(true);
  });
});

describe("nightly source verification", () => {
  it("fresh declaration confirms; an old confirming report retains its dated last-known evidence", () => {
    expect(deriveAlertEvidence(declared, NOW_MS, report()).verification.state).toBe("confirmed");
    const old = deriveAlertEvidence(declared, NOW_MS, report({ date: "2026-08-04" }));
    expect(old.verification).toMatchObject({ state: "unverified", lastConfirmedAt: "2026-08-04T04:01:00.000Z" });
  });
  it("same linked pulse confirms despite source generation preceding stored flag time", () => {
    const pulse = report();
    const flag = { ...declared, pulseId: pulse.id, firedAt: "2026-09-06T04:02:00.000Z" };
    expect(deriveAlertEvidence(flag, NOW_MS, pulse).verification.state).toBe("confirmed");
    expect(deriveAlertEvidence({ ...flag, ruleId: "flow-poisson-low" }, NOW_MS, pulse).verification.state).toBe("confirmed");
  });
  it("only a valid fresh newer report covering the metric establishes source-ended", () => {
    const result = deriveAlertEvidence(declared, NOW_MS, report({ flags: [] }));
    expect(result.verification).toMatchObject({ state: "source-ended", lastEvaluatedAt: "2026-09-06T04:01:00.000Z" });
    expect(result.liveness.state).toBe("stale");
    expect(isAttentionEligible(result.liveness)).toBe(false);
    expect(deriveAlertEvidence(declared, NOW_MS, report({ flags: [], metrics: { other: { last24h: 1, avg7d: 1, total: 1 } } })).verification.state).toBe("unverified");
  });
  it.each([null, report({ flags: [] , date: "2026-08-04" }), report({ date: "2026-09-07" }), report({ flags: {} }), report({ flags: [null] }), { ...report(), envelope: "not JSON" }, report({ asset: "another.test" })])(
    "absent, old, future, malformed or wrong-asset reports never imply recovery (%j)", (pulse) => {
      const result = deriveAlertEvidence(declared, NOW_MS, pulse);
      expect(result.liveness.state).toBe("last-known");
      expect(result.verification.state).toBe("unverified");
    },
  );
  it("a newer receipt of an older source report does not end the flag", () => {
    const pulse = { ...report({ date: "2026-08-02", flags: [] }), receivedAt: FRESH };
    expect(deriveAlertEvidence(declared, NOW_MS, pulse).verification.state).toBe("unverified");
  });
  it("same-source omitted declaration cannot end itself", () => {
    expect(deriveAlertEvidence({ ...declared, pulseId: 7 }, NOW_MS, report({ flags: [] })).verification.state).toBe("unverified");
  });
  it("a different latest report cannot re-evaluate an unresolved central rule", () => {
    expect(deriveAlertEvidence({ ...declared, ruleId: "flow-poisson-low" }, NOW_MS, report()).verification.state).toBe("unverified");
  });
  it.each([
    { severity: "error", kind: "anomaly", metric: "requests" },
    { severity: "warn", kind: "opportunity", metric: "requests" },
  ])("a changed metric condition neither confirms nor ends the older claim: %j", (flag) => {
    const result = deriveAlertEvidence(declared, NOW_MS, report({ flags: [flag] }));
    expect(result.verification.state).toBe("unverified");
    expect(isAttentionEligible(result.liveness)).toBe(true);
  });
});

describe("strict shared clock and group evidence", () => {
  it.each(["2026-02-30T12:00:00Z", "2026-09-06", "2026-09-06T12:00:00", "2026-09-07T00:00:00Z", "2026-09-05T24:00:00Z", "not a date"])("rejects invalid timestamp %s", (at) => {
    expect(evidenceInstant(at, NOW_MS)).toBeNull();
  });
  it.each([NaN, Infinity, -Infinity])("rejects nonfinite now %s", (now) => expect(evidenceInstant(FRESH, now)).toBeNull());
  it("normalizes offsets and summarizes only fully supported member evidence", () => {
    expect(evidenceInstant("2026-09-05T21:00:00-07:00", NOW_MS)).toBe(FRESH);
    const valid = deriveAlertEvidence(base, NOW_MS).verification;
    expect(summarizeVerification([valid, valid], NOW_MS).state).toBe("confirmed");
    expect(summarizeVerification([valid, undefined], NOW_MS).state).toBe("unverified");
    expect(summarizeVerification([valid, { ...valid, state: "unverified" }], NOW_MS).lastConfirmedAt).toBeNull();
    expect(summarizeVerification([valid, { ...valid, lastEvaluatedAt: "2026-09-07T00:00:00Z" }], NOW_MS).state).toBe("unverified");
  });
});

describe("real store selection: same counts and rows on Wall and asset detail", () => {
  const opened: TestStore[] = [];
  afterEach(async () => { await Promise.all(opened.splice(0).map((db) => db.close())); });
  async function database() {
    const ctx = await createTestStore(); opened.push(ctx);
    await addSites(ctx, [{ id: "example.test", domain: null, displayName: "Example", status: "live" }]);
    return ctx;
  }
  const detail: AssetDetailDeps = {
    now: NOW, flagDefaults: {}, pullConfig: [], monthlyCaps: { dataUsd: 25 }, operatorRateUsdPerMin: 2,
    integrations: { catalog: [], assets: {} }, counters: { assets: {} },
    serpPanel: { assets: {} }, signalPanels: { assets: {} }, valueEvents: { assets: {} }, ga4EventParams: { assets: {} },
    osTimeZone: "America/Los_Angeles",
  };
  const wall: BuildOptions = { now: NOW, constants: detail.monthlyCaps, pullConfig: [], integrations: detail.integrations,
    serpPanel: detail.serpPanel, dashboard: { countdown: { emoji: "", label: "", targetAt: FRESH } },
    osTimeZone: detail.osTimeZone };
  // The alerts and reports go into the test's copy of its sites; the store
  // numbers them.
  async function insertFlag(
    ctx: TestStore, ruleId: string, severity = "warn", inputs: unknown = null, metric = "requests",
    over: { firedAt?: string; message?: string } = {},
  ): Promise<number> {
    return storeAlert(ctx.call, {
      asset: "example.test", firedAt: over.firedAt ?? OLD, severity, kind: "anomaly", metric,
      message: over.message ?? null, ruleId, ruleInputs: inputs === null ? null : JSON.stringify(inputs),
    });
  }
  async function insertReport(ctx: TestStore, pulse: AlertPulseEvidence): Promise<void> {
    await storeReport(ctx.call, {
      asset: pulse.asset, date: pulse.date, receivedAt: pulse.receivedAt, envelope: pulse.envelope,
    });
  }
  it("16 repeated firings are one condition; severity shifts do not multiply it", async () => {
    const ctx = await database();
    for (let i = 0; i < 16; i++) await insertFlag(ctx, "asset-declared", i === 0 ? "error" : "warn");
    await insertFlag(ctx, "hygiene-sitemap", "warn", base.ruleInputs, "sitemap");
    await insertReport(ctx, report());
    const [portfolio, asset] = await Promise.all([buildWallPayload(ctx.call, wall), buildAssetDetailPayload(ctx.call, "example.test", detail)]);
    expect(portfolio.attention).toHaveLength(2);
    expect(asset!.flags.open).toHaveLength(2);
    expect(portfolio.assets[0]).toMatchObject({ openError: 0, openWarn: 2 });
    expect(asset!.asset).toMatchObject({ openError: 0, openWarn: 2 });
    expect(asset!.flags).toMatchObject({ openError: 0, openWarn: 2 });
    expect(asset!.flags.open.find((row) => row.ruleId === "asset-declared")!.occurrences).toBe(16);
    expect(portfolio.attention.every((row) => row.verification?.state === "confirmed")).toBe(true);
  });
  it("the newer warning replaces an older error's displayed severity and message", async () => {
    const ctx = await database();
    // Each written as it fired: an alert's firing and first words never change.
    await insertFlag(ctx, "asset-declared", "error", null, "requests", { message: "Old error evidence" });
    const newId = await insertFlag(ctx, "asset-declared", "warn", null, "requests",
      { firedAt: "2026-09-05T04:00:00Z", message: "New warning evidence" });
    await insertReport(ctx, report());
    const [portfolio, asset] = await Promise.all([buildWallPayload(ctx.call, wall), buildAssetDetailPayload(ctx.call, "example.test", detail)]);
    expect(portfolio.attention[0]).toMatchObject({ id: newId, severity: "warn", message: "New warning evidence", occurrences: 2 });
    expect(asset!.flags.open[0]).toMatchObject({ id: newId, severity: "warn", message: "New warning evidence", occurrences: 2 });
    expect(portfolio.assets[0]).toMatchObject({ openError: 0, openWarn: 1 });
    expect(asset!.flags).toMatchObject({ openError: 0, openWarn: 1 });
  });
  it("valid source-ended rows leave both badge totals but remain on asset evidence history", async () => {
    const ctx = await database();
    await insertFlag(ctx, "asset-declared");
    await insertFlag(ctx, "unknown-rule");
    await insertReport(ctx, report({ flags: [] }));
    const [portfolio, asset] = await Promise.all([buildWallPayload(ctx.call, wall), buildAssetDetailPayload(ctx.call, "example.test", detail)]);
    expect(portfolio.attention.map((row) => row.ruleId)).toEqual(["unknown-rule"]);
    expect(portfolio.assets[0]!.openWarn).toBe(1);
    expect(asset!.flags.openWarn).toBe(1);
    expect(asset!.flags.notCurrent[0]!.verification!.state).toBe("source-ended");
    expect({ n: (await readAlerts(ctx.call, "resolved_at IS NULL")).length }).toEqual({ n: 2 });
  });
  it("does not fall back to an old good pulse after malformed newest evidence", async () => {
    const ctx = await database();
    await insertFlag(ctx, "asset-declared");
    await insertReport(ctx, { ...report({ date: "2026-09-05", flags: [] }), id: 6 });
    // Malformed evidence the store can hold: its envelope column takes only a
    // JSON object, so the newest report's flags are the part that is broken.
    await insertReport(ctx, report({ flags: {} }));
    const asset = await buildAssetDetailPayload(ctx.call, "example.test", detail);
    expect(asset!.flags.open[0]!.verification!.state).toBe("unverified");
    expect(asset!.flags.openWarn).toBe(1);
  });
  it("database errors are not returned as empty/verified evidence", async () => {
    const row: EvidenceFlagRow = { ...declared, id: 1, severity: "warn", ruleInputs: null };
    const failureStore = { read() { throw new Error("database unavailable"); } } as unknown as WorkspaceStore;
    await expect(reviewAlertConditions(failureStore, [row], NOW_MS)).rejects.toThrow("database unavailable");
    expect(countAttentionConditions([]).size).toBe(0);
  });
  it("reads every asset's latest report in one statement without truncating assets", async () => {
    // A Postgres statement takes the assets as one array.
    const ctx = await database();
    const rows: EvidenceFlagRow[] = [];
    for (let i = 0; i < 81; i++) {
      const asset = `asset-${i}.test`;
      await addSites(ctx, [{ id: asset, domain: null, displayName: asset, status: "live" }]);
      rows.push({ ...declared, id: i + 1, asset, severity: "warn", ruleInputs: null });
    }
    const bindSizes: number[] = [];
    const store = ctx.call;
    const watched = (tx: Transaction): Transaction => ({
      workspaceId: tx.workspaceId,
      query: (text, params) => {
        bindSizes.push(params?.length ?? 0);
        return tx.query(text, params);
      },
      execute: (text, params) => tx.execute(text, params),
    });
    const counting: WorkspaceStore = { ...store, read: (work) => store.read((tx) => work(watched(tx))) };
    const conditions = await reviewAlertConditions(counting, rows, NOW_MS);
    expect(bindSizes).toEqual([1]);
    expect(conditions).toHaveLength(81);
    expect(conditions.every((condition) => condition.verification.state === "unverified")).toBe(true);
  });
});
