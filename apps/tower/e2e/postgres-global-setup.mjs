// ONE THROWAWAY POSTGRES FOR A JOURNEY RUN (epic ro-ujb9.76; the pattern is
// docs/briefs/2026-09-29-postgres-port-pattern.md).
//
// Started once, in Playwright's own process, before any worker: every worker's
// fixture server takes its own copies of it (fixture-server.mjs), so a run
// builds one template instead of one per worker. This process keeps the
// owner's way in; the workers get only the handle, through the environment.
// Stopped when the run ends.

import { startTestCluster } from "../../../scripts/postgres-test-cluster.mjs";
import { JOURNEY_POSTGRES } from "./fixture-server.mjs";

export default async function startPostgres() {
  const cluster = await startTestCluster();
  process.env[JOURNEY_POSTGRES] = JSON.stringify(cluster.handle);
  return () => cluster.close();
}
