// ONE THROWAWAY POSTGRES FOR THE TOWER SUITE'S RUN (epic ro-ujb9.76; the
// pattern is docs/briefs/2026-09-29-postgres-port-pattern.md).
//
// Started once, before any test file, in Vitest's own process, with the
// template every test's store is copied from (scripts/postgres-test-cluster.mts).
// This process alone holds the owner's way in; the test processes get the
// handle through `provide` — the application role's connection string and the
// address of this process's copy service — in memory, never in a file, and
// ask for their copies with scripts/postgres-test-copies.mts
// (test/postgres-store.ts). Stopped when the run ends.
//
// Plain JavaScript on purpose: the cluster module compiles against the
// Postgres runner's own JavaScript, which only the Node-only generation
// project reads (tsconfig.config-contract.node.json, allowJs), so no Tower
// TypeScript imports it. What the test processes see is typed in
// test/postgres-store.ts.
//
// Where no Postgres can start here, the tests that need it skip and say why;
// NOTICEOS_REQUIRE_POSTGRES=1 (CI) makes that a failure instead.

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
