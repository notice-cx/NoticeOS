// A test process's way to its own copy of the store.
//
// One process of a test run starts the run's throwaway cluster
// (scripts/postgres-test-cluster.mts): Vitest's own process, in a Workers
// suite's config or a global setup. It alone holds the owner's way in. The
// test processes get a handle — the application role's connection string and
// the address of the starting process's copy service — and ask that service
// for a copy of the store, to make one again, or to drop one. So no test
// process runs psql or holds more than the application role's login, and
// this module loads no driver: Node, and the name of the variable that hands a
// dev server its store.
//
// The copy service listens on a unix socket in a folder only this user can
// reach, and dies with the process that started the cluster.
//
// Authored TypeScript: `pnpm generate` writes the `.mjs` and the
// `.d.mts`.

import http from 'node:http';

/** Wrangler's documented variable for the POSTGRES Hyperdrive binding's local
 * connection string: how a test's dev server or Workers pool hands both
 * Workers their store, as the runner and `pnpm start` do
 * (scripts/database-address.mts). */
export { LOCAL_CONNECTION_VARIABLE } from './database-address.mjs';

/** An address nothing answers: what the binding names where a test's Workers
 * must declare it (wrangler refuses one without a local address) and nothing
 * reads the store, or before a test replaces it with its own copy's. */
export const UNREACHABLE_STORE_URL = 'postgresql://noticeos_app:unused@127.0.0.1:9/noticeos_unused_dev?sslmode=disable';

/** Plain data a test process uses to reach the run's cluster; handed over in memory (Vitest's `provide`) or in a child process's environment, never written to a file. */
export interface TestClusterHandle {
  /** The application role's loopback connection string for the template; a copy's differs only in its database. */
  readonly appUrl: string;
  /** The installation's one workspace, the same in every copy. */
  readonly workspaceId: string;
  /** The unix socket of the starting process's copy service. */
  readonly copyService: string;
}

/** What a test run does with its cluster. */
export interface TestClusterOperations {
  /** The installation's one workspace, the same in every copy. */
  readonly workspaceId: string;
  /** The application role's loopback connection string for one of the cluster's databases. */
  url(database: string): string;
  /** A new copy of the template; returns its name (a fresh one unless `name` is given). */
  createDatabase(name?: string): Promise<string>;
  /** The copy made again from the template, under the same name: every
   * connection to it is ended and everything written to it is gone. */
  resetDatabase(name: string): Promise<string>;
  /** Refresh planner statistics for this copy through its owner's service. */
  analyzeDatabase(name: string): Promise<void>;
  /** Drop a copy, ending any connection to it. */
  dropDatabase(name: string): Promise<void>;
  /** Give back a copy a test is done with: every connection to it is ended and
   * its name is gone, as after a drop, and the cluster may hand it, emptied and
   * under a new name, to the next test that asks (scripts/postgres-test-cluster.mts). */
  releaseDatabase(name: string): Promise<void>;
}

/** A copy's name: noticeos_<label>_dev, letters, digits and _. It can never
 * name the template (noticeos_dev, which has no label) or anything that is
 * not a plain name. */
const COPY_NAME = /^noticeos_[a-z0-9_]+_dev$/u;

/** `name`, when it can name a copy. */
export function checkCopyName(name: unknown): string {
  if (typeof name !== 'string' || !COPY_NAME.test(name)) {
    throw new TypeError(`a test database is named noticeos_<label>_dev and is not the template, not ${String(name)}`);
  }
  return name;
}

/** The application role's connection string for `database`, from the template's. */
export function copyUrl(appUrl: string, database: string): string {
  const url = new URL(appUrl);
  url.pathname = `/${checkCopyName(database)}`;
  return url.toString();
}

/** The fixed operations a test process may request on its own copy. */
export type CopyRequest =
  | { readonly op: 'create'; readonly name?: string }
  | { readonly op: 'reset'; readonly name: string }
  | { readonly op: 'analyze'; readonly name: string }
  | { readonly op: 'drop'; readonly name: string }
  | { readonly op: 'release'; readonly name: string };

/** One request to the copy service at `socketPath`, on a connection of its
 * own (a kept-alive one can be closed by the service just as a request is
 * sent on it); resolves the database it names. */
function ask(socketPath: string, request: CopyRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(request);
    const call = http.request(
      {
        socketPath,
        agent: false,
        path: '/copies',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => {
          try {
            const answer = JSON.parse(text) as { database?: unknown; error?: unknown };
            if (response.statusCode === 200 && typeof answer.database === 'string') resolve(answer.database);
            else reject(new Error(`the test cluster's copy service refused ${request.op}: ${String(answer.error ?? response.statusCode)}`));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    call.on('error', reject);
    call.end(body);
  });
}

/** The operations on the run's cluster, from a test process. */
export function attachTestCluster(handle: TestClusterHandle): TestClusterOperations {
  if (!handle || typeof handle.copyService !== 'string' || typeof handle.appUrl !== 'string') {
    throw new TypeError('attachTestCluster needs the handle startTestCluster returned');
  }
  return {
    workspaceId: handle.workspaceId,
    url: (database) => copyUrl(handle.appUrl, database),
    createDatabase: (name) => ask(handle.copyService, name === undefined ? { op: 'create' } : { op: 'create', name: checkCopyName(name) }),
    resetDatabase: (name) => ask(handle.copyService, { op: 'reset', name: checkCopyName(name) }),
    analyzeDatabase: async (name) => {
      await ask(handle.copyService, { op: 'analyze', name: checkCopyName(name) });
    },
    dropDatabase: async (name) => {
      await ask(handle.copyService, { op: 'drop', name: checkCopyName(name) });
    },
    releaseDatabase: async (name) => {
      await ask(handle.copyService, { op: 'release', name: checkCopyName(name) });
    },
  };
}
