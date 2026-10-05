import { describe, expect, it } from "vitest";
import { logicalTaskProjects } from "../shared/settings";
import { resolveTowerConfig, towerConfigResolver, type TowerConfigFallbacks, type ConfigDocumentReader } from "../worker/config-source";
import { handleConfigRequest } from "../worker/config-route";

const privateRow = { asset: "example.test", prefix: "ex", database: "ex", repo: "/private/checkout", extraHostField: "/private/other" };
const hub = { host: "127.0.0.1", port: 3308, user: "root", dataDir: "/private/hub" };
const logicalRow = { asset: "example.test", prefix: "ex", database: "ex" };
function fallback(local = false): TowerConfigFallbacks {
  return {
    monthlyCaps: { dataUsd: 25 }, flagDefaults: {}, operatorRateUsdPerMin: 2, osTimeZone: "Etc/UTC",
    pullConfig: [], integrations: { catalog: [], assets: {} }, counters: { assets: {} }, dashboard: {}, serpPanel: { assets: {} },
    signalPanels: { assets: {} }, valueEvents: { assets: {} }, ga4EventParams: { assets: {} }, domainOrders: [], recurringCosts: [], entities: [],
    beads: { spokes: [privateRow], hub: local ? hub : null },
  };
}
function reader(body: unknown): ConfigDocumentReader {
  return {
    getConfigDocuments: async () => [{ file: "config/beads.json", body, source: "store", version: 5, updatedAt: null, updatedBy: null, }],
    applyConfigOps: async () => ({ ok: true as const, applied: 0, documents: [] }),
  };
}

describe("configuration connection state", () => {
  it("resolves stored settings with only the read method and shares the request result", async () => {
    let reads = 0;
    const readOnly: Pick<ConfigDocumentReader, "getConfigDocuments"> = {
      async getConfigDocuments() {
        reads++;
        return [{ file: "config/constants.json", body: { monthly_caps: { data_usd: 101 } },
          source: "store", version: 1, updatedAt: null, updatedBy: null }];
      },
    };
    const resolve = towerConfigResolver(readOnly, fallback());
    const [first, second] = await Promise.all([resolve(), resolve()]);
    expect(first).toBe(second);
    expect(first.monthlyCaps).toEqual({ dataUsd: 101 });
    expect(first.storeAvailable).toBe(true);
    expect(reads).toBe(1);
  });

  it("shows built-in values and disables editing when the settings RPC fails", async () => {
    const down: ConfigDocumentReader = { ...reader(null), getConfigDocuments: async () => { throw new Error("private connection detail"); } };
    const config = await resolveTowerConfig(down, fallback());
    expect(config.storeAvailable).toBe(false);
    expect(config.storeFailure).toContain("unavailable");
    expect(config.monthlyCaps).toEqual(fallback().monthlyCaps);
    expect(Object.values(config.sources).every(source => source === "file")).toBe(true);
    expect(Object.values(config.versions).every(version => version === null)).toBe(true);
    const response = await handleConfigRequest(new Request("https://tower.example/api/config"), {
      ingest: down, config: async () => config,
    });
    const payload = await response.json();
    expect(payload).toMatchObject({ writable: false, store: { ready: false, reason: config.storeFailure } });
    expect(JSON.stringify(payload)).not.toContain("private connection detail");
  });

  it("enables editing after a successful read, including an empty configuration", async () => {
    const empty: ConfigDocumentReader = { ...reader(null), getConfigDocuments: async () => [] };
    const config = await resolveTowerConfig(empty, fallback());
    expect(config.storeAvailable).toBe(true);
    expect(config.storeFailure).toBeNull();
  });
});

describe("task configuration ownership", () => {
  it("allowlists only logical fields for compiled deployed rows", () => {
    expect(logicalTaskProjects([privateRow, null, { asset: "bad" }])).toEqual([logicalRow]);
  });
  it("strips host fields from stored, missing, malformed and unavailable deployed answers", async () => {
    const down: ConfigDocumentReader = { ...reader(null), getConfigDocuments: async () => { throw new Error("offline"); } };
    for (const ingest of [reader({ spokes: [privateRow], hub }), reader({ spokes: null }), null, down]) {
      const config = await resolveTowerConfig(ingest, fallback());
      expect(config.beads).toEqual({ spokes: [logicalRow], hub: null });
      expect(JSON.stringify(config.beads)).not.toContain("/private/");
    }
  });
  it("preserves local raw rows for guarded removal and Undo, without trusting a stored hub", async () => {
    const config = await resolveTowerConfig(reader({ spokes: [privateRow], hub: { host: "remote" } }), fallback(true));
    expect(config.beads.spokes).toEqual([privateRow]);
    expect(config.beads.hub).toEqual(hub);
  });
  it("keeps an acknowledged empty task roster empty", async () => {
    const config = await resolveTowerConfig(reader({ spokes: [] }), fallback());
    expect(config.beads.spokes).toEqual([]);
  });
});

describe("assets that send no nightly report (ro-ujb9.96.8)", () => {
  function constantsReader(body: unknown): ConfigDocumentReader {
    return {
      getConfigDocuments: async () => [{ file: "config/constants.json", body, source: "store", version: 3, updatedAt: null, updatedBy: null, }],
      applyConfigOps: async () => ({ ok: true as const, applied: 0, documents: [] }),
    };
  }
  it("reads the saved list, and a saved document without one declares none", async () => {
    const withList = await resolveTowerConfig(constantsReader({ flag_defaults: {}, no_nightly_report: ["fees.example"] }), { ...fallback(), noNightlyReport: ["compiled.test"] });
    expect(withList.noNightlyReport).toEqual(["fees.example"]);
    const without = await resolveTowerConfig(constantsReader({ flag_defaults: {} }), { ...fallback(), noNightlyReport: ["compiled.test"] });
    expect(without.noNightlyReport).toBeNull();
  });
  it("falls back to the compiled list only when the store holds no constants", async () => {
    const config = await resolveTowerConfig(null, { ...fallback(), noNightlyReport: ["compiled.test"] });
    expect(config.noNightlyReport).toEqual(["compiled.test"]);
    expect((await resolveTowerConfig(null, fallback())).noNightlyReport).toBeNull();
  });
});

// Bead ro-trai.45: a stored config/tower.json with one part the Tower cannot
// read. It used to be swallowed whole — the compiled default served, a valid
// saved layout discarded with a bad countdown, and the editor left guarding
// its Save on a value the store did not hold.
describe("a saved TV document the Tower cannot read in one part (ro-trai.45)", () => {
  function towerReader(body: unknown): ConfigDocumentReader {
    return {
      getConfigDocuments: async () => [{ file: "config/tower.json", body, source: "store", version: 4, updatedAt: null, updatedBy: null, }],
      applyConfigOps: async () => ({ ok: true as const, applied: 0, documents: [] }),
    };
  }
  const SITES_ONLY = { version: 1, rows: [{ id: "only", height: "fill", widgets: [{ id: "sites", type: "sites", width: 1 }] }] };
  const COUNTDOWN = { emoji: "🌁", label: "Trip", targetAt: "2026-10-01T07:00:00.000Z" };
  const compiled = { countdown: { emoji: "🧭", label: "Compiled", targetAt: "2026-12-01T00:00:00.000Z" } };

  it("an undrawable layout: the default in its place, the countdown kept, the refusal named with the stored value", async () => {
    const stored = { layout: { version: 1, rows: [] } };
    const config = await resolveTowerConfig(towerReader({ wall: stored, countdown: COUNTDOWN }), { ...fallback(), dashboard: compiled });
    expect(config.dashboard.wall).toBeUndefined();
    expect(config.dashboard.countdown).toEqual(COUNTDOWN);
    expect(config.dashboard.refused).toEqual({
      wall: { saved: stored, reason: "config/tower.json wall.layout: A layout needs at least one row." },
    });
  });

  it("a bad countdown beside a valid layout: the layout stands, the countdown is named", async () => {
    const wall = { layout: SITES_ONLY, history: [] };
    const countdown = { ...COUNTDOWN, emoji: "" };
    const config = await resolveTowerConfig(towerReader({ wall, countdown }), { ...fallback(), dashboard: compiled });
    expect(config.dashboard.wall).toEqual(wall);
    expect(config.dashboard.countdown).toBeUndefined();
    expect(config.dashboard.refused).toEqual({
      countdown: { saved: countdown, reason: "config/tower.json countdown.emoji must contain one emoji" },
    });
  });

  it("only a document that is not an object at all falls back to the compiled copy", async () => {
    const config = await resolveTowerConfig(towerReader(["not", "an", "object"]), { ...fallback(), dashboard: compiled });
    expect(config.dashboard).toEqual(compiled);
  });
});

// A setting shown from the built-in copy (bead ro-dk4u): every portfolio
// setting reads store-first PER KEY, as the ingest's detector does, so a saved
// rule set that lacks a key shows the compiled value — and its Save, guarded
// by that value, creates the key (scripts/config-documents.test.mjs).
describe("settings a saved constants document lacks (ro-dk4u)", () => {
  function constantsReader(body: unknown): ConfigDocumentReader {
    return {
      getConfigDocuments: async () => [{ file: "config/constants.json", body, source: "store", version: 3, updatedAt: null, updatedBy: null, }],
      applyConfigOps: async () => ({ ok: true as const, applied: 0, documents: [] }),
    };
  }
  const compiled = { alpha: 0.01, min_baseline_per_day: 3, low_volume_window_hours: 72 };
  it("shows a flag_defaults key the saved document lacks from the compiled copy, beside the saved ones", async () => {
    const config = await resolveTowerConfig(constantsReader({ flag_defaults: { alpha: 0.02 } }), { ...fallback(), flagDefaults: compiled });
    expect(config.flagDefaults).toEqual({ alpha: 0.02, min_baseline_per_day: 3, low_volume_window_hours: 72 });
  });
  it("shows the compiled cap, rate and rules when the saved document has none of them", async () => {
    const config = await resolveTowerConfig(constantsReader({ os_time_zone: "UTC" }), { ...fallback(), flagDefaults: compiled });
    expect(config.flagDefaults).toEqual(compiled);
    expect(config.monthlyCaps).toEqual({ dataUsd: 25 });
    expect(config.operatorRateUsdPerMin).toBe(2);
  });
});
