// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type TowerEnv } from "../worker/index";
import { createTestStore, type TestStore, postgresUnavailable } from "./postgres-store";
import { addSites } from "./sites";

import { formatTimestamp } from "../src/lib/format";
import { MEDIAVINE_REPORTING_CLOCK } from "../shared/daily-revenue";
import { seedRevenueHistory } from "./revenue-fixture";

// Provider report days and readiness are independent of the saved operator
// clock: Settings and ledger periods change without a rebuild, Mediavine days
// do not. Driven on the ordinary standalone Worker against a disposable store.

// 2026-09-30 20:00 UTC is already 1 October on Kiritimati (UTC+14) and still the
// morning of 30 September on Pago Pago (UTC−11): one instant, two different
// "yesterdays" and two different open months.
const NOW = new Date("2026-09-30T20:00:00.000Z");
const ASSET = "sample.test";

/** What `vite.config.ts` compiles in. UTC on purpose: neither saved zone
 * below, and not the checkout's either, so no assertion can pass by falling
 * back to it. */
const INJECTED: Record<string, unknown> = {
  __MONTHLY_CAPS__: { dataUsd: 25 },
  __FLAG_DEFAULTS__: {},
  __PULL_CONFIG__: [],
  __OPERATOR_RATE__: 1,
  __INTEGRATIONS__: { catalog: [], assets: {} },
  __COUNTERS__: { assets: {} },
  __DASHBOARD__: {},
  __OS_TIME_ZONE__: "UTC",
  __NO_NIGHTLY_REPORT__: null,
  __SCHEDULES__: null,
  __SERP_PANEL__: { assets: {} },
  __SIGNAL_PANELS__: { assets: {} },
  __VALUE_EVENTS__: { assets: {} },
  __GA4_EVENT_PARAMS__: { assets: {} },
  __DOMAIN_COSTS__: [],
  __RECURRING_COSTS__: [],
  __ENTITIES__: [],
  __BEADS__: { spokes: [] },
  __RUNNER_LANE__: false,
};

/** The config store as the ingest door answers it: `config/constants.json` is a
 * saved document carrying `savedZone`; every other file is unseeded, so the
 * compiled copy answers it. Any other RPC is a route reaching somewhere this
 * file does not expect, and says so. */
function savedStore(savedZone: () => string): TowerEnv["INGEST"] {
  const getConfigDocuments = async (files: string[]) =>
    files.map((file) =>
      file === "config/constants.json"
        ? {
            file,
            body: {
              os_time_zone: savedZone(),
              monthly_caps: { data_usd: 25 },
              operator_rate_usd_per_min: 1,
              flag_defaults: {},
            },
            source: "store" as const,
            version: 2,
            updatedAt: NOW.toISOString(),
            updatedBy: "settings",
          }
        : {
            file,
            body: null,
            source: "file" as const,
            version: null,
            updatedAt: null,
            updatedBy: null,
          },
    );
  return new Proxy({ getConfigDocuments } as Record<string, unknown>, {
    get(target, name) {
      if (name in target) return target[name as string];
      return () => {
        throw new Error(`no route under test should call INGEST.${String(name)}()`);
      };
    },
  }) as unknown as TowerEnv["INGEST"];
}

let ctx: TestStore;
/** This test's Postgres copy, where the config store's history lives, or
 * null where this run has no Postgres. */
let pg: TestStore | null = null;
const unavailable = postgresUnavailable();
let zone = "Pacific/Kiritimati";
let env: TowerEnv;
/** A call's context: the Worker closes its call's store through it. */
const CALL_CONTEXT = { waitUntil: (work: Promise<unknown>) => void work.catch(() => undefined) };

async function read<T = Record<string, unknown>>(path: string): Promise<T> {
  const response = await worker.fetch(new Request(`https://tower.test${path}`), env, CALL_CONTEXT);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

interface WallRead {
  portfolio: { period: string; periodIsCurrent: boolean };
  assets: {
    id: string;
    dailyRevenue?: { date: string; amountMinor: number | null; timeZone: string };
    revenueProjection?: { period: string; status: string; reportedThrough: string | null };
  }[];
}

beforeAll(() => {
  for (const [name, value] of Object.entries(INJECTED)) vi.stubGlobal(name, value);
});
afterAll(() => {
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  // Only the clock: the Postgres driver's own timers keep running.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  ctx = await createTestStore();
  pg = ctx;
  // In both stores: the Worker reads the site list on Postgres (test/sites.ts).
  await addSites(ctx, [{ id: ASSET, displayName: "Sample", status: "live", senseOnly: 0, createdAt: NOW.toISOString() }]);
  // Reports through 30 September: complete for both zones below.
  if (pg) await seedRevenueHistory(pg.call, ASSET, NOW.toISOString(), "2026-09-30");
  env = { NOTICEOS_WORKSPACE_PROFILE: "standalone", INGEST: savedStore(() => zone), ...(pg ? { POSTGRES: { connectionString: pg.url } } : {}) };
});
afterEach(async () => {
  vi.useRealTimers();
  await pg?.close();
  pg = null;
});

describe("provider reporting days remain independent of Settings", () => {
  it("keeps provider reports fixed while ledger periods and timestamps follow saved zones", async () => {
    // Soft, so one run names EVERY surface that did not follow, not just the first.
    const check = async (saved: string, expected: { month: string; timestamp: string }) => {
      zone = saved;
      const settings = await read<{ clock: { timeZone: string } }>("/api/settings");
      expect.soft(settings.clock.timeZone, "Settings clock").toBe(saved);
      const wall = await read<WallRead>("/api/wall");
      const card = wall.assets[0]!;
      expect.soft(card.dailyRevenue?.date, "Wall: yesterday's revenue day").toBe("2026-09-29");
      expect.soft(card.revenueProjection?.period, "Wall: provider projection month").toBe("2026-09");
      expect.soft(card.revenueProjection?.reportedThrough, "Wall: projection reported through").toBe("2026-09-29");
      expect.soft(card.revenueProjection?.status, "Wall: projection status").toBe("ready");
      // Booked money stays in its selected ledger period (September here),
      // independently of the provider projection month.
      expect.soft(wall.portfolio.period, "Wall: money card month shown").toBe("2026-09");
      expect.soft(wall.portfolio.periodIsCurrent, "Wall: money card month is the open one").toBe(expected.month === "2026-09");
      expect.soft(card.dailyRevenue?.timeZone, "Wall: provider report clock").toBe(MEDIAVINE_REPORTING_CLOCK.timeZone);
      const financials = await read<{ currentPeriod?: string; period: string; periodIsCurrent: boolean }>("/api/financials");
      expect.soft(financials.period, "Financials: month shown").toBe("2026-09");
      expect.soft(financials.periodIsCurrent, "Financials: month shown is the open one").toBe(expected.month === "2026-09");
      expect.soft(financials.currentPeriod, "Financials: open month").toBe(expected.month);
      const detail = await read<{ osTimeZone?: string; dailyRevenue: { to: string } }>(`/api/assets/${ASSET}`);
      expect.soft(detail.dailyRevenue.to, "Asset page: daily revenue window end").toBe("2026-09-29");
      expect.soft(detail.osTimeZone, "Asset page: ordinary timestamp clock").toBe(saved);
      expect.soft(formatTimestamp(NOW.toISOString(), detail.osTimeZone), "Evidence timestamp label").toBe(expected.timestamp);
    };
    await check("Pacific/Kiritimati", { month: "2026-10", timestamp: "Oct 1, 2026, 10:00:00 AM GMT+14" });
    // The operator saves another zone. Same build, same instant, same rows.
    await check("Pacific/Pago_Pago", { month: "2026-09", timestamp: "Sep 30, 2026, 9:00:00 AM GMT-11" });
    await check("UTC", { month: "2026-09", timestamp: "Sep 30, 2026, 8:00:00 PM UTC" });
    await check(MEDIAVINE_REPORTING_CLOCK.timeZone, { month: "2026-09", timestamp: "Sep 30, 2026, 1:00:00 PM PDT" });
  });

  it("falls back to the compiled zone, not the checkout's, when nothing is saved", async () => {
    zone = "Not/AZone";
    const wall = await read<WallRead>("/api/wall");
    // A stored value Intl cannot resolve is not a setting; the compiled copy
    // (UTC here) answers, exactly as the Settings page does.
    expect((await read<{ clock: { timeZone: string } }>("/api/settings")).clock.timeZone).toBe("UTC");
    expect(wall.assets[0]!.dailyRevenue?.timeZone).toBe(MEDIAVINE_REPORTING_CLOCK.timeZone);
    expect(wall.assets[0]!.dailyRevenue?.date).toBe("2026-09-29");
    expect(wall.assets[0]!.revenueProjection?.period).toBe("2026-09");
  });
});

describe.skipIf(unavailable !== null)(`a clock nobody chose is offered from the browser${unavailable === null ? "" : ` (skipped: no Postgres here, ${unavailable})`}`, () => {
  const chosen = async () => (await read<{ clock: { chosen: boolean } }>("/api/settings")).clock.chosen;
  // The config store's history, as the ingest's writer records it
  // (workers/ingest/src/config-store.ts): the document's key, the ops, who.
  const change = async (ops: unknown[]) => {
    const own = pg!;
    await own.store.inWorkspace(own.workspaceId, (tx) =>
      tx.execute(
        `INSERT INTO noticeos.config_changes (workspace_id, document_key, ops, reason, actor, version_before, version_after, changed_at)
         VALUES ($1::uuid, 'constants', $2::jsonb, NULL, 'operator', 1, 2, $3::timestamptz)`,
        [tx.workspaceId, JSON.stringify(ops), NOW.toISOString()],
      ),
    );
  };

  it("is unchosen on the product's UTC until a save sets the zone, even back to UTC", async () => {
    zone = "UTC";
    expect(await chosen()).toBe(false);
    // A seed records the whole document, not a choice of zone.
    await change([{ kind: "document-seed", file: "config/constants.json" }]);
    expect(await chosen()).toBe(false);
    // Another setting in the same document is not the clock either.
    await change([{ kind: "file-json-set", file: "config/constants.json", pointer: "/monthly_caps/data_usd", expect: 25, value: 30 }]);
    expect(await chosen()).toBe(false);
    await change([{ kind: "file-json-set", file: "config/constants.json", pointer: "/os_time_zone", expect: "UTC", value: "UTC" }]);
    expect(await chosen()).toBe(true);
  });

  it("is chosen when the saved zone is not the product default", async () => {
    zone = "Pacific/Pago_Pago";
    expect(await chosen()).toBe(true);
  });
});
