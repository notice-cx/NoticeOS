import { startTestCluster } from '../../../scripts/postgres-test-cluster.mjs';

/** Two populated workspaces in one disposable database, for the real RLS read. */
export async function dailyWorkspaceFixture() {
  const cluster = await startTestCluster();
  try {
    const database = await cluster.createDatabase();
    const otherId = '0000000b-0000-4000-8000-00000000000b';
    await cluster.asOwner(database, `INSERT INTO noticeos.workspaces (workspace_id, slug, display_name)
      VALUES ('${otherId}', 'other', 'Other synthetic workspace')`);
    return { url: cluster.url(database), workspaceIds: [cluster.workspaceId, otherId], close: () => cluster.close() };
  } catch (error) {
    cluster.close();
    throw error;
  }
}
