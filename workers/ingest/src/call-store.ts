// ONE STORE PER CALL (the Postgres port pattern,
// docs/briefs/2026-09-29-postgres-port-pattern.md; epic ro-ujb9.76).
//
// Every way into this Worker — a request, a scheduled run, an RPC call —
// runs its work with `withCallStore`: the Worker's own bindings plus `STORE`,
// a store opened on the POSTGRES Hyperdrive binding for this call alone and
// closed when the call ends (@noticeos/postgres `withWorkspaceStore`, which
// the Tower's entry uses too). Nothing connects until a module does a unit of
// work, so a call that never reads the store costs nothing.
//
// Modules use `env.STORE` for all operational data.

import { type CallContext, type WorkspaceStore, withWorkspaceStore } from '@noticeos/postgres';
import { requireStandaloneWorkspace } from '../../../scripts/workspace-entry.mjs';

declare global {
  interface IngestEnv {
    /** The store this call reads and writes: opened by `withCallStore` for
     * each request, scheduled run and RPC call, closed when it ends. */
    STORE: WorkspaceStore;
  }
}

/** `work`, given this call's env: the Worker's bindings and a store opened for
 * this call on its POSTGRES binding, closed once `work` has finished. */
export function withCallStore<T>(env: IngestEnv, ctx: CallContext, work: (env: IngestEnv) => Promise<T>): Promise<T> {
  requireStandaloneWorkspace(env);
  return withWorkspaceStore(env.POSTGRES, ctx, (store) => work({ ...env, STORE: store }));
}
