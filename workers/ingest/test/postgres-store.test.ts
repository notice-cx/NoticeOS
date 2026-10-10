// This Worker's runtime reaches Postgres the way the deployed Worker will:
// inside workerd, through the `POSTGRES` Hyperdrive binding (a local
// Hyperdrive: a TCP pipe to the run's throwaway cluster, vitest.config.ts),
// with the one helper every Worker and script uses (@noticeos/postgres): the
// store names the installation's one workspace, a transaction runs as
// noticeos_app in it, and a later transaction reads back what it wrote. The
// run's copy of the store is a new installation's, made again before this
// file (test/clean-start.ts), holding the complete synthetic fixture sites and no
// others (test/sites.ts).

import { env } from 'cloudflare:test';
import { openStore } from '@noticeos/postgres';
import { expect, it } from 'vitest';
import { storeSites } from './sites';
import { TEST_SITES } from './invented-sites';

it('opens a transaction as noticeos_app in the one workspace, and a later one reads back what it wrote', async () => {
  expect(env).not.toHaveProperty('DB');
  const seeded = await storeSites();
  expect(seeded).toEqual(TEST_SITES.map((site) => ({
    id: site.id, domain: site.domain, display_name: site.displayName,
    status: site.status, sense_only: site.senseOnly, is_os: site.isOs,
    created_at: site.createdAt, updated_at: site.updatedAt,
  })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const store = openStore(env.POSTGRES.connectionString);
  try {
    const workspaceId = await store.onlyWorkspace();
    const inside = await store.inWorkspace(workspaceId, async (tx) => {
      const before = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM noticeos.assets');
      await tx.execute(
        "INSERT INTO noticeos.assets (workspace_id, asset_id, domain, display_name, status) VALUES ($1, 'probe', 'probe.example.com', 'Probe', 'live')",
        [tx.workspaceId],
      );
      const [who] = await tx.query<{ session_role: string; acting_role: string; workspace: string }>(
        'SELECT session_user::text AS session_role, current_user::text AS acting_role, noticeos.current_workspace_id()::text AS workspace',
      );
      return { before: before[0]?.n, who };
    });
    expect(inside).toEqual({ before: seeded.length, who: { session_role: 'noticeos_app', acting_role: 'noticeos_app', workspace: workspaceId } });

    const readBack = await store.inWorkspace(
      workspaceId,
      (tx) => tx.query<{ asset_id: string; domain: string; created_at: string }>("SELECT asset_id, domain, created_at FROM noticeos.assets WHERE asset_id = 'probe'"),
      { readOnly: true },
    );
    expect(readBack).toEqual([{ asset_id: 'probe', domain: 'probe.example.com', created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/) }]);
  } finally {
    await store.close();
  }
});

it("gives each test a store of its own on this runtime's copy, as each call into the Worker gets one", async () => {
  expect(await env.STORE.workspaceId()).toMatch(/^[0-9a-f-]{36}$/);
  const seeded = TEST_SITES.map((site) => site.id);
  const held = await env.STORE.read((tx) => tx.query<{ asset_id: string }>('SELECT asset_id FROM noticeos.assets'));
  expect(held.map((row) => row.asset_id).sort()).toEqual([...seeded, 'probe'].sort());
});
