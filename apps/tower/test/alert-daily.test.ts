// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import { openWorkspaceStore, type WorkspaceStore } from "@noticeos/postgres";
import { handleStoredRead } from "../worker/stored-read-route";
import { buildAlertDailyPayload, handleAlertDailyRequest } from "../worker/alert-daily";
import { dailyWorkspaceFixture } from "./alert-daily-cluster.mjs";
import { addSites } from "./sites";
import { createTestStore, type TestStore } from "./postgres-store";

let fixture: TestStore;
const now = new Date("2026-09-22T12:00:00Z");
beforeEach(async () => { fixture = await createTestStore(); });

async function snapshot(day: string, open: number, errors: number, warnings: number, asset: string | null = null) {
  await fixture.call.write((tx) => tx.execute(`INSERT INTO noticeos.alert_daily_counts
    (workspace_id, asset_id, day, observed_at, open, errors, warnings)
    VALUES ($1, $2, $3::date, $4::timestamptz, $5, $6, $7)`,
    [tx.workspaceId, asset, day, `${day}T06:00:00Z`, open, errors, warnings]));
}

it("reads complete portfolio totals, rises and falls, retaining gaps and measured zero", async () => {
  await snapshot("2026-09-18", 7, 1, 2);
  await snapshot("2026-09-19", 12, 3, 4);
  await snapshot("2026-09-21", 3, 1, 1);
  await snapshot("2026-09-22", 0, 0, 0);
  await addSites(fixture, [{ id: "example.com", displayName: "Example", status: "live" }]);
  await snapshot("2026-09-18", 999, 500, 499, "example.com");
  const payload = await buildAlertDailyPayload(fixture.call, now);
  expect(payload.generatedAt).toBe(now.toISOString());
  expect(payload.days.map((day) => [day.day, day.open])).toEqual([
    ["2026-09-18", 7], ["2026-09-19", 12], ["2026-09-20", null], ["2026-09-21", 3], ["2026-09-22", 0],
  ]);
  expect(payload.days[0]).toMatchObject({ open: 7, errors: 1, warnings: 2, observedAt: "2026-09-18T06:00:00.000Z" });
  expect(payload.days[2]).toEqual({ day: "2026-09-20", open: null, errors: null, warnings: null, observedAt: null });
});

it("returns no history for an empty store", async () => {
  expect((await buildAlertDailyPayload(fixture.call, now)).days).toEqual([]);
});

it("keeps the reader workspace-scoped even when the URL requests another workspace", async () => {
  const cluster = await dailyWorkspaceFixture();
  const [firstId, otherId] = cluster.workspaceIds;
  const first = openWorkspaceStore(cluster.url, { workspaceId: firstId });
  const other = openWorkspaceStore(cluster.url, { workspaceId: otherId });
  try {
    for (const [store, total] of [[first, 23], [other, 91]] as const) {
      await store.write((tx) => tx.execute(`INSERT INTO noticeos.alert_daily_counts
        (workspace_id, asset_id, day, observed_at, open, errors, warnings)
        VALUES ($1, NULL, '2026-09-21', '2026-09-21T06:00:00Z', $2, 0, 0)`, [tx.workspaceId, total]));
    }
    const response = await handleStoredRead(new Request(`http://tower/api/alerts/daily?workspace_id=${firstId}`), {
      store: other, compiledTimeZone: "UTC", config: async () => { throw new Error("Daily snapshots need no config read"); },
    });
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ days: [{ open: 91 }] });
    expect((await buildAlertDailyPayload(first, now)).days.map((day) => day.open)).toEqual([23]);
  } finally {
    await Promise.all([first.close(), other.close()]);
    await cluster.close();
  }
});

it("reads GET only and reports a store failure without manufacturing empty history", async () => {
  expect((await handleAlertDailyRequest(new Request("http://tower/api/alerts/daily", { method: "POST" }), fixture.call, now)).status).toBe(405);
  const failed: WorkspaceStore = { ...fixture.call, read: async () => { throw new Error("synthetic read failure"); } };
  const response = await handleAlertDailyRequest(new Request("http://tower/api/alerts/daily"), failed, now);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "alert_daily_read_failed" });
});


it("reads every retained portfolio day rather than an archive page", async () => {
  await fixture.call.write((tx) => tx.execute(`INSERT INTO noticeos.alert_daily_counts
    (workspace_id, asset_id, day, observed_at, open, errors, warnings)
    SELECT $1, NULL, '2026-01-01'::date + n, '2026-01-01T06:00:00Z'::timestamptz + n * interval '1 day', n, 0, 0
      FROM generate_series(0, 149) AS n`, [tx.workspaceId]));
  const { days } = await buildAlertDailyPayload(fixture.call, now);
  expect(days).toHaveLength(150);
  expect(days[0]!.open).toBe(0);
  expect(days.at(-1)!.open).toBe(149);
});
