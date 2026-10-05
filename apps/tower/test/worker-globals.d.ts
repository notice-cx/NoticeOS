import type { TowerEnv } from "../worker/index";

// THE TWO WORKERS AMBIENT NAMES `worker/index.ts` STILL USES, FOR THE TEST
// PROJECT ONLY (bead ro-ap7n).
//
// `apps/tower/test/worker-fetch.test.ts` drives the Worker's own fetch switch,
// which puts `worker/index.ts` into the tsconfig.app.json program for the first
// time. That program deliberately does NOT include the generated
// `worker-configuration.d.ts`: its `INGEST: Service<typeof import(
// "../../workers/ingest/src/index").default>` would drag the entire ingest
// Worker — and 14k lines of workerd runtime globals that collide with the DOM
// lib jsdom tests need — into a React app's typecheck.
//
// Everything else in `worker/index.ts` is already free of Workers globals
// (`TowerEnv` next door is the structural binding surface, the same trick every
// route file uses). What is left is the deployment contract at the bottom of
// the file, `satisfies ExportedHandler<Env>`, which names two globals that only
// exist in the WORKER program — and which stays there precisely because it is
// what catches a binding renamed in wrangler.jsonc.
//
// So the test program gets the two names, in the narrowest shape that makes
// that assertion mean the same thing on both sides. The worker program still
// compiles against the real generated types: `tsconfig.worker.json` does not
// include `test/`, so these never shadow them.
//
// IF THE WORKER STARTS USING A BINDING BEYOND `TowerEnv` — `ASSETS`, or a new
// one — this file is where the app typecheck will complain first. Widen
// `TowerEnv` rather than this shim: `Env` here is deliberately nothing but a
// pointer at it.
declare global {
  // Test-only mail double. The Worker program uses Wrangler's generated
  // SendEmail overloads; no provider binding is enabled by this declaration.
  interface SendEmail {
    send(input: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
  }
  interface Env extends TowerEnv {}

  type ExportedHandler<E> = {
    fetch(request: Request, env: E, ctx?: unknown): Response | Promise<Response>;
    // The Tower's share of a scheduled tick (worker/tower-cron.ts, bead
    // ro-ujb9.96.7.29); its controller is typed structurally in index.ts.
    scheduled?(controller: { readonly cron: string }, env: E, ctx?: unknown): void | Promise<void>;
  };
}

export {};
