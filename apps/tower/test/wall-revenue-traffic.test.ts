// The Wall reads revenue-projection traffic only for assets with daily revenue
// (bead `ro-ujb9.102`).
//
// The Wall's second trend read used to fetch 84 days of sessions for EVERY
// asset, although `projectRevenue` answers "no revenue" before it looks at
// traffic for an asset with no daily revenue rows. It is now narrowed to the
// assets `mediavine_current_daily` returned. The specification is the Wall
// as it was: the same builder with the narrowing removed from that one call.
// The two payloads must be equal. The measurement is in
// docs/artifacts/tower-perf-2026-09-23/measurements.md.

import type { WorkspaceStore } from "@noticeos/postgres";
import { describe, expect, it, vi } from "vitest";
import { writeMediavine } from "./money";
import type { SignalTrendOptions } from "../worker/signal-trends";
import { buildWallPayload, type BuildOptions } from "../worker/wall-payload";
import { writeSignalRun } from "./collected-metrics";
import { createTestStore, type TestStore } from "./postgres-store";
import { addSites } from "./sites";
import { seedRevenueHistory } from "./revenue-fixture";

/** When true, every trend read ignores `assets`: the pre-bead Wall. */
const spec = vi.hoisted(() => ({ unnarrowed: false, calls: [] as SignalTrendOptions[] }));

vi.mock("../worker/signal-trends", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker/signal-trends")>();
  return {
    ...actual,
    loadSignalTrends: (...args: Parameters<typeof actual.loadSignalTrends>) => {
      const [store, days, options = {}] = args;
      spec.calls.push(options);
      return actual.loadSignalTrends(store, days, spec.unnarrowed ? { ...options, assets: undefined } : options);
    },
  };
});

const NOW = new Date("2026-09-09T15:00:00Z");
const ZONE = "America/Los_Angeles";
const OPTIONS: BuildOptions = {
  now: NOW,
  osTimeZone: ZONE,
  constants: { dataUsd: 25 },
  integrations: { catalog: [], assets: {} },
  pullConfig: [],
  dashboard: {},
  serpPanel: { assets: {} },
};

/** A site in both of the test's stores (test/sites.ts). */
async function asset(raw: TestStore, id: string): Promise<void> {
  await addSites(raw, [{ id, displayName: id, status: "live", senseOnly: 0, createdAt: NOW.toISOString() }]);
}

/** 84 days of GA4 sessions for an asset with no daily revenue, on Postgres
 * where the collectors write them (bead ro-ujb9.76.5.3). */
async function trafficOnly(store: WorkspaceStore, id: string): Promise<void> {
  const at = NOW.toISOString();
  const values = [];
  for (let t = Date.parse("2026-06-17T00:00:00Z"); t <= Date.parse("2026-09-08T00:00:00Z"); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    for (const metric of ["sessions", "active_users"]) values.push({ date, metric, value: 700 });
  }
  await writeSignalRun(store, {
    id: `${id}:traffic`, asset: id, integration: "ga4", credentialRef: "synthetic", propertyRef: "p", finishedAt: at,
    windowStart: "2026-06-17", windowEnd: "2026-09-08", providerRows: 84, observationCount: 168,
  }, values);
}

/** A few days of daily revenue (on Postgres, bead ro-ujb9.76.5.5) and no traffic at all. */
async function revenueOnly(store: WorkspaceStore, id: string): Promise<void> {
  const days: [string, number][] = [];
  for (let day = 1; day <= 8; day += 1) days.push([`2026-09-0${day}`, 900]);
  await writeMediavine(store, [{ id: 'second-run', asset: id, siteId: 'second-site', start: '2026-09-01', end: '2026-09-08',
    attemptedAt: NOW.toISOString(), days }]);
}

/** Seeds Postgres sites before their signals, then compares both Wall reads. */
async function bothWalls(seed: (raw: TestStore) => Promise<void>, seedStore: (store: WorkspaceStore) => Promise<void> = async () => undefined) {
  const raw = await createTestStore();
  try {
    await seed(raw);
    const store = raw.call;
    await seedStore(store);
    spec.unnarrowed = false;
    spec.calls.length = 0;
    const shipped = await buildWallPayload(store, OPTIONS);
    const shippedCalls = [...spec.calls];
    spec.unnarrowed = true;
    const before = await buildWallPayload(store, OPTIONS);
    spec.unnarrowed = false;
    return { shipped, before, shippedCalls };
  } finally {
    await raw.close();
  }
}

describe("the Wall's revenue traffic is read only for assets with daily revenue (ro-ujb9.102)", () => {
  it("draws the same Wall as reading every asset's traffic", async () => {
    const { shipped, before, shippedCalls } = await bothWalls(async (raw) => {
      for (const id of ["earning.test", "second.test", "traffic.test", "quiet.test"]) await asset(raw, id);
    }, async (store) => {
      await seedRevenueHistory(store, "earning.test", NOW.toISOString(), "2026-09-08");
      await revenueOnly(store, "second.test");
      await trafficOnly(store, "traffic.test");
    });
    expect(shipped).toEqual(before);
    // The edges are really in the fixture: one asset projects from traffic,
    // one has revenue and no traffic, and the traffic-only asset still charts
    // its users on the card while owing no projection.
    const card = (id: string) => shipped.assets.find((a) => a.id === id)!;
    expect(card("earning.test").revenueProjection).toMatchObject({ status: "ready" });
    expect(card("second.test").revenueProjection).toMatchObject({ status: "waiting-traffic" });
    expect(card("traffic.test").revenueProjection).toMatchObject({ status: "no-revenue" });
    expect(card("traffic.test").activeUsers.series.length).toBeGreaterThan(0);
    // And the narrowing reached the store.
    expect(shippedCalls.map((call) => call.assets)).toEqual([undefined, ["earning.test", "second.test"]]);
  });

  it("makes no traffic read when no asset has daily revenue", async () => {
    const { shipped, before, shippedCalls } = await bothWalls(async (raw) => {
      await asset(raw, "traffic.test");
    }, async (store) => trafficOnly(store, "traffic.test"));
    expect(shipped).toEqual(before);
    expect(shippedCalls).toHaveLength(1); // the card trend read only
  });
});
