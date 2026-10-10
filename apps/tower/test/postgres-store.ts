// A new installation's Postgres store for one test. Each call asks the run's
// copy service (test/postgres-global-setup.mjs) for a copy of the template in
// a database of its own, and opens the one helper on it the way the Tower
// Worker does, as noticeos_app over loopback TCP. The copy holds the roles,
// every migration and the installation's one workspace, and no sites: a test
// adds its own rows. `close()` closes the store and gives the copy back,
// emptied, to a later test.

import { inject } from "vitest";
import { openStore, openWorkspaceStore, type PostgresStore, type Transaction, type WorkspaceStore } from "@noticeos/postgres";
import { attachTestCluster, type TestClusterHandle, type TestClusterOperations } from "../../../scripts/postgres-test-copies.mjs";

export { LOCAL_CONNECTION_VARIABLE, UNREACHABLE_STORE_URL } from "../../../scripts/postgres-test-copies.mjs";

declare module "vitest" {
  export interface ProvidedContext {
    /** The run's Postgres (test/postgres-global-setup.mjs), or why there is none. */
    postgres: { handle: TestClusterHandle } | { unavailable: string };
  }
}

export interface TestStore {
  /** The helper, open on this test's own copy. */
  store: PostgresStore;
  /** This copy's address as noticeos_app, what a Worker's POSTGRES binding
   * carries; it holds this run's password, so never print it. */
  url: string;
  /** A call's store on this copy, as a Worker call gets one (`env.STORE`). */
  call: WorkspaceStore;
  /** The installation's one workspace. */
  workspaceId: string;
  /** Refresh this fixture's planner statistics without exposing its owner login. */
  analyze(): Promise<void>;
  /** Closes the store and gives the copy back. */
  close(): Promise<void>;
}

const perTest = new Set<TestStore>();

export async function releaseTestStores(): Promise<void> {
  await Promise.all([...perTest].map((fixture) => fixture.close()));
}

let cluster: TestClusterOperations | null = null;

/** Why this run has no Postgres, or null when it has one. A test that needs it skips with this. */
export function postgresUnavailable(): string | null {
  const provided = inject("postgres");
  return "unavailable" in provided ? provided.unavailable : null;
}

/** The run's cluster, from this test process. */
export function testCluster(): TestClusterOperations {
  const provided = inject("postgres");
  if ("unavailable" in provided) throw new Error(`no Postgres in this run: ${provided.unavailable}`);
  cluster ??= attachTestCluster(provided.handle);
  return cluster;
}

/** A store on a fresh copy of the run's template. */
export async function createTestStore(options: { scope?: "suite" } = {}): Promise<TestStore> {
  const own = testCluster();
  const database = await own.createDatabase();
  const url = own.url(database);
  const store = openStore(url);
  const call = openWorkspaceStore(url);
  let closed = false;
  const fixture: TestStore = {
    store,
    url,
    call,
    workspaceId: own.workspaceId,
    analyze: () => own.analyzeDatabase(database),
    async close() {
      if (closed) return;
      closed = true;
      perTest.delete(fixture);
      await call.close();
      await store.close();
      await own.releaseDatabase(database);
    },
  };
  if (options.scope !== "suite") perTest.add(fixture);
  return fixture;
}

/** This store, recording the text of every statement a reader sends it: the
 * Postgres half of a test that counts or inspects a build's reads. */
export function recordingStore(store: WorkspaceStore, sql: string[]): WorkspaceStore {
  const watched = (tx: Transaction): Transaction => ({
    workspaceId: tx.workspaceId,
    query: (text, params) => {
      sql.push(text);
      return tx.query(text, params);
    },
    execute: (text, params) => {
      sql.push(text);
      return tx.execute(text, params);
    },
  });
  return {
    where: store.where,
    workspaceId: () => store.workspaceId(),
    read: (work) => store.read((tx) => work(watched(tx))),
    write: (work) => store.write((tx) => work(watched(tx))),
    close: () => store.close(),
  };
}
