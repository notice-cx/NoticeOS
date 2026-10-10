// One store per call. Every way into this Worker (a request, a scheduled run,
// an RPC call) runs with `withCallStore`: the bindings plus `STORE`, opened on
// the POSTGRES Hyperdrive binding for this call alone and closed when it ends.
// Nothing connects until a module does a unit of work.

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
