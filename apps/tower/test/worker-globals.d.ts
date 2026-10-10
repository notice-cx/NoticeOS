import type { TowerEnv } from "../worker/index";

// The two Workers ambient names `worker/index.ts` uses, for the test project
// only. tsconfig.app.json leaves out the generated `worker-configuration.d.ts`,
// whose INGEST type would drag the whole ingest Worker and workerd globals that
// collide with the DOM lib into the app's typecheck; `tsconfig.worker.json`
// still compiles the Worker against the real generated types.
//
// If the Worker starts using a binding beyond `TowerEnv`, widen `TowerEnv`
// rather than this shim: `Env` here is only a pointer at it.
declare global {
  // Test-only mail double. The Worker program uses Wrangler's generated
  // SendEmail overloads; no provider binding is enabled by this declaration.
  interface SendEmail {
    send(input: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
  }
  interface Env extends TowerEnv {}

  type ExportedHandler<E> = {
    fetch(request: Request, env: E, ctx?: unknown): Response | Promise<Response>;
    // The Tower's share of a scheduled tick (worker/tower-cron.ts); its
    // controller is typed structurally in index.ts.
    scheduled?(controller: { readonly cron: string }, env: E, ctx?: unknown): void | Promise<void>;
  };
}

export {};
