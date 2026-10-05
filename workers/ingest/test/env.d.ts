/// <reference types="@cloudflare/vitest-pool-workers/types" />

// The `cloudflare:test` `env` is typed as `Cloudflare.Env`. Augment it with the
// extra bindings the harness injects (vitest.config.ts): cron expressions,
// Postgres copies and their reset/owner service, and each test's own store.
// Merged onto Cloudflare.Env only, so the Worker's own global `Env` stays clean
// of test-only bindings.
declare namespace Cloudflare {
  interface Env {
    /** A second copy of the store for this runtime: the config cache's
     * ownership proof (test/config-store-cache.test.ts). */
    POSTGRES_OTHER: Hyperdrive;
    /** `triggers.crons`, parsed in the Node config context — workerd has no node:fs. */
    TEST_CRONS: string[];
    /** Every binding name vitest.config.ts and wrangler.jsonc declare; test/test-env.test.ts. */
    TEST_BINDING_NAMES: string[];
    /** This test's store (test/clean-start.ts): opened on this runtime's
     * POSTGRES copy before each test and closed after it, as a Worker call's
     * is (src/call-store.ts). */
    STORE: import('@noticeos/postgres').WorkspaceStore;
    /** This runtime's hook into the run's cluster (vitest.config.ts): POST
     * /reset copies its database again, POST /owner runs owner SQL. */
    TEST_POSTGRES: Fetcher;
  }
}

// The test runtime has Node's async context (the pool turns nodejs_compat on
// for it); the Worker itself does not, so only the part test/store-fence.ts
// uses is declared, here and not for src/.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
