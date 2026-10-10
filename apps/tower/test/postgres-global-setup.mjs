// One throwaway Postgres for the Tower suite's run, started once in Vitest's own
// process with the template every test's store is copied from
// (scripts/postgres-test-cluster.mts). Only this process holds the owner's way
// in; test processes get the app role's connection string and the copy
// service's address through `provide`, in memory, never in a file.
//
// Plain JavaScript because the cluster module compiles against the Postgres
// runner's JavaScript, which only the Node-only project reads
// (tsconfig.config-contract.node.json, allowJs).
//
// Where no Postgres can start, the tests that need it skip and say why;
// NOTICEOS_REQUIRE_POSTGRES=1 (CI) makes that a failure.

import { postgresRequired, startTestCluster, unavailableReason } from "../../../scripts/postgres-test-cluster.mjs";

/** @param {import("vitest/node").TestProject} project */
export default async function startPostgres(project) {
  try {
    const cluster = await startTestCluster();
    project.provide("postgres", { handle: cluster.handle });
    return () => cluster.close();
  } catch (error) {
    const reason = unavailableReason(error);
    if (reason === null || postgresRequired()) throw error;
    project.provide("postgres", { unavailable: reason });
    return undefined;
  }
}
