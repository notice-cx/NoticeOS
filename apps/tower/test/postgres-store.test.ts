// @vitest-environment node
//
// THE TOWER SUITE REACHES POSTGRES THE WAY THE TOWER WORKER WILL (epic
// ro-ujb9.76): through the one helper
// (@noticeos/postgres), as noticeos_app over loopback TCP, in the store's one
// workspace — each test on its own copy of a new installation's store
// (test/postgres-store.ts). Skipped, naming why, where no Postgres can start
// here; required in CI (NOTICEOS_REQUIRE_POSTGRES=1).
//
// Each test's two copies are made before it and dropped after it (bead
// ro-ujb9.76.47): on a machine other runs keep busy, making a copy can take
// seconds, and that is the run's cluster at work, not what these tests prove.
// A test's own time is its transactions.

import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestStore, postgresUnavailable, type TestStore } from "./postgres-store";

const unavailable = postgresUnavailable();
let first: TestStore;
let second: TestStore;

beforeEach(async ({ skip }) => {
  if (unavailable !== null) return skip(`no Postgres here: ${unavailable}`);
  [first, second] = await Promise.all([createTestStore(), createTestStore()]);
});

afterEach(async () => {
  if (unavailable === null) await Promise.all([first.close(), second.close()]);
});

it("opens a transaction as noticeos_app in the one workspace, and a later one reads back what it wrote", async () => {
  const { store, workspaceId } = first;
  expect(await store.onlyWorkspace()).toBe(workspaceId);
  const inside = await store.inWorkspace(workspaceId, async (tx) => {
    const [before] = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM noticeos.assets");
    await tx.execute(
      "INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status) VALUES ($1, 'probe', 'probe.example.com', 'Probe', 'live')",
      [tx.workspaceId],
    );
    const [who] = await tx.query<{ session_role: string; acting_role: string; workspace: string }>(
      "SELECT session_user::text AS session_role, current_user::text AS acting_role, noticeos.current_workspace_id()::text AS workspace",
    );
    return { before: before?.n, who };
  });
  expect(inside).toEqual({ before: 0, who: { session_role: "noticeos_app", acting_role: "noticeos_app", workspace: workspaceId } });

  const readBack = await store.inWorkspace(
    workspaceId,
    (tx) => tx.query<{ asset_id: string; domain: string }>("SELECT asset_id, domain FROM noticeos.assets"),
    { readOnly: true },
  );
  expect(readBack).toEqual([{ asset_id: "probe", domain: "probe.example.com" }]);
});

it("gives each test a store of its own: what one writes, another never sees", async () => {
  await first.store.inWorkspace(first.workspaceId, (tx) =>
    tx.execute("INSERT INTO noticeos.assets (workspace_id, asset_id, display_name, status) VALUES ($1, 'mine', 'Mine', 'live')", [tx.workspaceId]),
  );
  const sites = (test: TestStore) =>
    test.store.inWorkspace(test.workspaceId, (tx) => tx.query<{ asset_id: string }>("SELECT asset_id FROM noticeos.assets"), { readOnly: true });
  expect(await sites(first)).toEqual([{ asset_id: "mine" }]);
  expect(await sites(second)).toEqual([]);
});
