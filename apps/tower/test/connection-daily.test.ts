// @vitest-environment node
import { javascriptInstant, type WorkspaceStore } from "@noticeos/postgres";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CONNECTION_DAILY_RETENTION_DAYS,
  connectionHistoryPayload,
  freshnessSeries,
  laneDay,
  loadConnectionHistory,
  portfolioSeries,
  recordConnectionDay,
} from "../worker/connection-daily";
import type {
  IntegrationCell,
  IntegrationCellBase,
  IntegrationsMatrix,
} from "../shared/integrations";
import { emptyIntegrationsHistory } from "../shared/integrations";
import { type TestStore, createTestStore, postgresUnavailable } from "./postgres-store";


// The daily rollup behind /health's strip and its freshness chart. The hourly
// tick's Tower step writes it (the step and the read-only page build are
// pinned in integrations-payload.test.ts); these cases are about the
// arithmetic and the upsert. A test that records takes a Postgres copy of its own.

const NOW = new Date("2026-09-05T09:00:00.000Z");
const needsPostgres = describe.skipIf(postgresUnavailable() !== null);

let ctx: TestStore;
/** This test's Postgres copy, the call's store a Worker would hand the rollup. */
let store: () => WorkspaceStore;

beforeEach(async () => {
  ctx = await createTestStore();
  store = () => ctx.call;
});

function cell(
  effective: IntegrationCellBase["effective"],
  evidence: { at: string | null }[] = [],
): IntegrationCell {
  return {
    assetId: "meals.example",
    laneId: "gsc",
    effective,
    evidence: evidence.map((one) => ({
      polarity: "supporting",
      source: "test",
      detail: "",
      at: one.at,
    })),
    declared: effective,
    note: "",
    ref: null,
    since: "2026-07-01",
  };
}

/** A matrix with one catalog lane over two assets, plus one derived lane. */
function matrix(overrides: Partial<IntegrationsMatrix> = {}): IntegrationsMatrix {
  const catalogRow = {
    id: "gsc",
    label: "Google Search Console",
    docRef: "",
    derived: false,
    scope: "property" as const,
    layer: "provider" as const,
    usage: { cost: "free" as const },
    onFailure: "keeps-last-data" as const,
    credential: "shared" as const,
  };
  return {
    generatedAt: NOW.toISOString(),
    owner: "config/integrations.json",
    catalog: [catalogRow],
    derivedLanes: [
      {
        catalog: { ...catalogRow, id: "nightly-report", derived: true },
        cells: {
          "meals.example": cell("live", [{ at: "2026-09-05T02:00:00.000Z" }]),
          "nosh.example": cell("degraded"),
        },
      },
    ],
    assets: [
      { id: "meals.example", displayName: "Meal Planner", isOs: false },
      { id: "nosh.example", displayName: "Nosh", isOs: false },
    ],
    cells: {
      "meals.example": [cell("live", [{ at: "2026-09-04T06:00:00.000Z" }])],
      "nosh.example": [cell("needs-setup")],
    },
    summary: {
      counts: { live: 2, degraded: 1, "needs-setup": 1, skipped: 0, "not-applicable": 0 },
      total: 4,
      needsAttention: 2,
    },
    undeclared: [],
    sharedCredential: { lanes: 0, cells: 0, lanesByLabel: [] },
    dataSpend: { period: "2026-09", spentUsd: 0, unknownPrices: 0, capUsd: 0, byAsset: [], unattributedUsd: 0, unattributedUnknownPrices: 0 },
    history: emptyIntegrationsHistory(),
    ...overrides,
  } as IntegrationsMatrix;
}

/** The rollup's rows, instants as JavaScript writes them. */
async function rows(): Promise<Record<string, unknown>[]> {
  const found = await (await store()).read((tx) =>
    tx.query<{ observed_at: string; newest_evidence_at: string | null }>(
      `SELECT source, day, observed_at, live, degraded, needs_setup, skipped, not_applicable, newest_evidence_at
         FROM noticeos.connection_daily_counts ORDER BY day ASC, source COLLATE "C" ASC`,
    ),
  );
  return found.map((row) => ({
    ...row,
    observed_at: javascriptInstant(row.observed_at),
    newest_evidence_at: row.newest_evidence_at === null ? null : javascriptInstant(row.newest_evidence_at),
  }));
}

needsPostgres("recording a day of the integrations matrix", () => {
  it("writes one row per lane, declared and derived alike", async () => {
    expect(await recordConnectionDay(await store(), matrix(), NOW)).toBe(2);

    const stored = await rows();
    expect(stored.map((row) => row.source)).toEqual(["gsc", "nightly-report"]);
    expect(stored[0]).toMatchObject({
      day: "2026-09-05",
      live: 1,
      needs_setup: 1,
      degraded: 0,
      newest_evidence_at: "2026-09-04T06:00:00.000Z",
    });
    expect(stored[1]).toMatchObject({ live: 1, degraded: 1 });
  });

  it("sums to the same counts the strip states, so the two cannot disagree", async () => {
    await recordConnectionDay(await store(), matrix(), NOW);
    const history = (await loadConnectionHistory(await store()))!;
    const series = portfolioSeries(history);

    const summary = matrix().summary.counts;
    expect(series.live.at(-1)!.v).toBe(summary.live);
    expect(series.degraded.at(-1)!.v).toBe(summary.degraded);
    expect(series["needs-setup"].at(-1)!.v).toBe(summary["needs-setup"]);
  });

  it("keeps the latest observation of a day rather than appending to it", async () => {
    await recordConnectionDay(await store(), matrix(), NOW);
    const later = new Date("2026-09-05T21:00:00.000Z");
    await recordConnectionDay(
      await store(),
      matrix({ cells: { "meals.example": [cell("degraded")], "nosh.example": [cell("degraded")] } }),
      later,
    );

    const gsc = (await rows()).filter((row) => row.source === "gsc");
    expect(gsc).toHaveLength(1);
    expect(gsc[0]).toMatchObject({ observed_at: later.toISOString(), degraded: 2, live: 0 });
  });

  it("refuses to walk a day backwards on an out-of-order build", async () => {
    await recordConnectionDay(await store(), matrix(), new Date("2026-09-05T21:00:00.000Z"));
    await recordConnectionDay(
      await store(),
      matrix({ cells: { "meals.example": [cell("degraded")], "nosh.example": [cell("degraded")] } }),
      NOW,
    );

    expect((await rows()).find((row) => row.source === "gsc")).toMatchObject({ live: 1 });
  });

  it("drops a day older than the retention window", async () => {
    await (await store()).write((tx) =>
      tx.execute(
        `INSERT INTO noticeos.connection_daily_counts
           (workspace_id, source, day, observed_at, live, degraded, needs_setup, skipped, not_applicable)
         VALUES ($1, 'gsc', '2020-01-01', '2020-01-01T00:00:00.000Z', 1, 0, 0, 0, 0)`,
        [tx.workspaceId],
      ),
    );

    await recordConnectionDay(await store(), matrix(), NOW);

    expect((await rows()).map((row) => row.day)).not.toContain("2020-01-01");
    expect(CONNECTION_DAILY_RETENTION_DAYS).toBe(400);
  });

  it("answers no days, never a failure, before the first hour records one", async () => {
    expect(connectionHistoryPayload(await loadConnectionHistory(await store()))).toMatchObject({ days: 0, sources: [] });
    expect(connectionHistoryPayload(await loadConnectionHistory(await store())).states.degraded).toEqual([]);
  });

  it("orders the day's data sources byte by byte", async () => {
    await recordConnectionDay(
      await store(),
      matrix({ catalog: [{ ...matrix().catalog[0]!, id: "a-lower" }, { ...matrix().catalog[0]!, id: "Z-upper" }],
        cells: { "meals.example": [cell("live"), cell("live")], "nosh.example": [cell("live"), cell("live")],
        },
      }),
      NOW,
    );
    expect([...(await loadConnectionHistory(await store())).byLane.keys()]).toEqual(["Z-upper", "a-lower", "nightly-report"]);
  });
});

describe("what a lane's day says", () => {
  it("takes the NEWEST dated evidence and ignores the undated", () => {
    const day = laneDay([
      cell("live", [{ at: "2026-09-01T00:00:00.000Z" }, { at: null }]),
      cell("live", [{ at: "2026-09-03T00:00:00.000Z" }]),
    ]);
    expect(day.newestEvidenceAt).toBe("2026-09-03T00:00:00.000Z");
    expect(day.states.live).toBe(2);
  });

  it("carries no evidence date at all when nothing was dated", () => {
    // Not "infinitely stale" and certainly not fresh: the lane gave nothing to date.
    expect(laneDay([cell("needs-setup")]).newestEvidenceAt).toBeNull();
  });
});

needsPostgres("the freshness series", () => {
  it("is hours between the day's observation and its newest evidence", async () => {
    await recordConnectionDay(await store(), matrix(), NOW);
    const history = (await loadConnectionHistory(await store()))!;

    const gsc = freshnessSeries(history).find((one) => one.source === "gsc")!;
    // Observed 09-05T09:00, newest evidence 09-04T06:00 — 27 hours.
    expect(gsc.points).toEqual([{ t: "2026-09-05", v: 27 }]);
  });

  it("leaves out a lane-day that carried no dated evidence", async () => {
    await recordConnectionDay(
      await store(),
      matrix({ cells: { "meals.example": [cell("needs-setup")], "nosh.example": [cell("needs-setup")] } }),
      NOW,
    );
    const history = (await loadConnectionHistory(await store()))!;

    expect(freshnessSeries(history).map((one) => one.source)).not.toContain("gsc");
  });

  it("floors a provider clock ahead of ours at zero rather than below the axis", async () => {
    await recordConnectionDay(
      await store(),
      matrix({
        cells: {
          "meals.example": [cell("live", [{ at: "2026-09-06T00:00:00.000Z" }])],
          "nosh.example": [cell("live")],
        },
      }),
      NOW,
    );
    const history = (await loadConnectionHistory(await store()))!;

    expect(freshnessSeries(history).find((one) => one.source === "gsc")!.points[0]!.v).toBe(0);
  });
});

needsPostgres("the payload shape", () => {
  it("says how many days it holds once the table is there", async () => {
    await recordConnectionDay(await store(), matrix(), new Date("2026-09-03T09:00:00.000Z"));
    await recordConnectionDay(await store(), matrix(), NOW);

    const payload = connectionHistoryPayload(await loadConnectionHistory(await store()));
    // Two days, and zero would be a third sentence: it is there and holds nothing yet.
    expect(payload.days).toBe(2);
    expect(payload.states.live.map((point) => point.t)).toEqual(["2026-09-03", "2026-09-05"]);
  });
});
