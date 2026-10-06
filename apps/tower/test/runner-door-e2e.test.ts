// @vitest-environment node
//
// The whole chain, on a real server: door → guard → vite/Cloudflare-plugin
// dispatch → workerd → Tower Worker → INGEST Service Binding → ingest Worker,
// and back. And both Workers reading the config store from Postgres, on that
// same server, booted once for all of it (issue #24).
//
// WHY THIS FILE EXISTS. Every unit test around the runner lane was green while
// the shipped door answered 403 to every single request, because the seam that
// broke is not reachable from a unit test: the Cloudflare plugin builds the
// Worker's `Request` from `req.rawHeaders`, and the guard was editing
// `req.headers`. Two representations of the same header, one of them the wire,
// and no fake request has both unless you already know that. So this boots the
// actual vite dev server and asks the questions over TCP — the only place the
// answer was ever going to be honest.
//
// SAFETY. The operator's runtime holds 5173 (LAN) and 8791 (the ingest door)
// and owns the live `.wrangler/state`. This test may touch none of them, so it
// binds ephemeral ports it asked the kernel for, points `OS_UP_PERSIST_STATE`
// at a fresh temp dir, and redirects wrangler's global dirs — including the dev
// registry, which a live runtime is also writing to — into that same temp dir.
// It asserts it is off the live ports before it starts anything.
//
// SECRETS. Wrangler reads a Worker's `.dev.vars` from beside its config, and
// in a checkout that runs the OS that file holds the installation's real
// secrets. So the dev server gets both Worker configs copied into a folder with
// none (scripts/worker-config-folder.mts, bead ro-ujb9.182), named through the
// same variable `pnpm start` uses, and its Workers run on no local secret at
// all; the last test below holds that over the wire.
//
// LOAD. Under host load this file killed its own Vitest worker after its last
// test had passed (bead ro-ujb9.186). Vite starts a dependency optimizer on
// `listen`, and closing the server while that is still bundling crashes the
// process inside rolldown's native code (SIGSEGV or SIGBUS). The shared
// test-server helper (scripts/test-vite-server.mts) makes the server: no client
// optimizer, since no page is loaded here, a close that waits for the Workers'
// own, and a cache in the OS temp dir. The Workers' debugger takes a port the
// kernel assigns (vite.config.ts): a fixed range let two runs on one machine
// take the same one, and the loser's close hung. The last block below holds both.
//
// The scheduled proof runs against this suite's own migrated Postgres copy.
// Its site list is empty, so no scheduled step can fetch a real site.

import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { PRODUCT_ENV } from "../../../scripts/product-env.mjs";
import { createTestViteServer } from "../../../scripts/test-vite-server.mjs";
import { secretFreeWorkerConfigs, stopLocalSecretReads } from "../../../scripts/worker-config-folder.mjs";
import { LOCAL_CONNECTION_VARIABLE, UNREACHABLE_STORE_URL, createTestStore, postgresUnavailable, type TestStore } from "./postgres-store";
import type { IntegrationCredentialsPayload } from "../shared/integrations-page";
import {
  RUNNER_DOOR_HEADER,
  RUNNER_DOOR_HEADER_VALUE,
  RUNNER_SCHEDULED_PATH,
} from "../shared/runner-lane";

const towerRoot = path.dirname(fileURLToPath(new URL("../vite.config.ts", import.meta.url)));

/** The ports the operator's runtime owns. Never these. */
const LIVE_PORTS = new Set([5173, 8791]);

/** Ask the kernel for a free port, then hand it back. A tiny race against
 * another process is acceptable; binding a LIVE port is not, which is what the
 * assertion below actually guards. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close(() => reject(new Error("no ephemeral port")));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

let server: ViteDevServer;
let stateDir: string;
let towerPort: number;
let doorPort: number;
let postgres: TestStore | undefined;

/** A zone no product default and no fixture holds, so only the store can answer it. */
const SAVED_ZONE = "Pacific/Kiritimati";

const doorUrl = (p: string) => `http://127.0.0.1:${doorPort}${p}`;
const towerUrl = (p: string) => `http://127.0.0.1:${towerPort}${p}`;

beforeAll(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "reindex-door-e2e-"));
  vi.stubEnv(PRODUCT_ENV.home.name, stateDir);
  vi.stubEnv(PRODUCT_ENV.installationDir.name, path.join(stateDir, "installation"));
  towerPort = await freePort();
  doorPort = await freePort();
  expect(LIVE_PORTS.has(towerPort), `refusing to bind the live port ${towerPort}`).toBe(false);
  expect(LIVE_PORTS.has(doorPort), `refusing to bind the live port ${doorPort}`).toBe(false);

  process.env.OS_UP_PERSIST_STATE = path.join(stateDir, "state");
  process.env.OS_UP_INGEST_DOOR_HOST = "127.0.0.1";
  process.env.OS_UP_INGEST_DOOR_PORT = String(doorPort);
  // Keep miniflare's dev registry and wrangler's global dir out of the
  // operator's: a live runtime registers its workers in the shared one, and a
  // test has no business writing there.
  process.env.MINIFLARE_REGISTRY_PATH = path.join(stateDir, "registry");
  process.env.XDG_CONFIG_HOME = path.join(stateDir, "xdg");
  process.env.WRANGLER_LOG_PATH = path.join(stateDir, "wrangler-logs");
  // Both Worker configs from a folder with no `.dev.vars` beside them, and no
  // `.env` or process read either: the Workers run on no local secret.
  const workerConfigs = secretFreeWorkerConfigs({ parent: stateDir });
  process.env[PRODUCT_ENV.workerConfigRoot.name] = workerConfigs.root;
  stopLocalSecretReads(process.env);
  // Both Workers declare the store's Hyperdrive binding (wrangler.jsonc): a
  // copy of the run's throwaway Postgres, or where there is none an address
  // nothing answers; CI requires Postgres for its store-reading proofs.
  postgres = postgresUnavailable() === null ? await createTestStore({ scope: "suite" }) : undefined;
  process.env[LOCAL_CONNECTION_VARIABLE] = postgres?.url ?? UNREACHABLE_STORE_URL;

  // No page is loaded from it, so no client optimizer; see LOAD above.
  server = await createTestViteServer(createServer, {
    root: towerRoot,
    configFile: path.join(towerRoot, "vite.config.ts"),
    server: { port: towerPort, strictPort: true, host: "127.0.0.1" },
    logLevel: "silent",
  }, { pages: false });
  await server.listen();

  // workerd takes a moment to accept the first request; poll rather than sleep a
  // fixed amount, so a slow machine does not turn into a flake.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(towerUrl("/api/health"));
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("tower dev server never became ready");
    await new Promise((r) => setTimeout(r, 250));
  }
}, 120_000);

afterAll(async () => {
  try {
    await server?.close();
    delete process.env[LOCAL_CONNECTION_VARIABLE];
    await postgres?.close();
    if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
  } finally { vi.unstubAllEnvs(); }
}, 60_000);

interface SettingsRead {
  clock: { timeZone: string; chosen: boolean };
}

/** `/api/settings` once it answers what `until` waits for; the ingest caches
 * a read for a second, so poll, never sleep a fixed time. */
async function settingsUntil(until: (read: SettingsRead) => boolean): Promise<SettingsRead> {
  const deadline = Date.now() + 60_000;
  let last: unknown = null;
  for (;;) {
    try {
      const res = await fetch(towerUrl("/api/settings"));
      last = { status: res.status, body: await res.json() };
      if (res.status === 200 && until((last as { body: SettingsRead }).body)) return (last as { body: SettingsRead }).body;
    } catch {
      // not answering yet
    }
    if (Date.now() > deadline) throw new Error(`/api/settings never answered as expected: ${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// BOTH WORKERS READ THE CONFIG STORE FROM POSTGRES THE WAY THE LOCAL OS RUNS
// THEM (epic ro-ujb9.76; the pattern every port copies is
// docs/briefs/2026-09-29-postgres-port-pattern.md).
//
// The local OS — the managed service and `pnpm start` alike — runs ONE Vite
// dev server (apps/tower/vite.config.ts): the Cloudflare plugin runs the Tower
// Worker and, as its auxiliary Worker, the ingest, each from its own
// wrangler.jsonc, both in one workerd: the server this file boots. Both
// declare the POSTGRES Hyperdrive binding; its local connection string reaches
// the dev server the way wrangler documents for local development,
// CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES in its environment,
// and names this suite's copy of the run's throwaway store.
//
// One Settings read covers both Workers' halves of the config store: the saved
// clock comes from the ingest's config store over the INGEST binding
// (workers/ingest/src/config-store.ts, on the ingest's own POSTGRES binding),
// and whether a clock was ever chosen from the Tower's own read of the change
// history (worker/config-source.ts `timeZoneEverSaved`, on the Tower's).
//
// First in the file: it reads the store before any request here can write it.
describe("the config store, from Postgres", () => {
  it("the Tower and the ingest, in the local OS's one dev server, read the config store from Postgres on their own POSTGRES bindings", async ({ skip }) => {
    if (!postgres) return skip(`no Postgres here: ${postgresUnavailable()}`);
    const before = await settingsUntil(() => true);
    expect(before.clock.timeZone).not.toBe(SAVED_ZONE);
    expect(before.clock.chosen).toBe(false);

    // A Save of the clock, as the ingest's writer records one: the document and
    // its change, in the store's one workspace, as noticeos_app.
    await postgres.store.inWorkspace(postgres.workspaceId, async (tx) => {
      await tx.execute(
        `INSERT INTO noticeos.config_documents (workspace_id, document_key, body, version, updated_at, updated_by)
         VALUES ($1::uuid, 'constants', $2::json, 2, now(), 'settings')`,
        [tx.workspaceId, JSON.stringify({
          os_time_zone: SAVED_ZONE,
          operator_rate_usd_per_min: 1,
          monthly_caps: { data_usd: 25 },
          flag_defaults: {},
        })],
      );
      await tx.execute(
        `INSERT INTO noticeos.config_changes (workspace_id, document_key, ops, reason, actor, version_before, version_after, changed_at)
         VALUES ($1::uuid, 'constants', $2::jsonb, NULL, 'operator', 1, 2, now())`,
        [tx.workspaceId, JSON.stringify([{ kind: "file-json-set", file: "config/constants.json", pointer: "/os_time_zone", expect: before.clock.timeZone, value: SAVED_ZONE }])],
      );
    });

    const after = await settingsUntil((read) => read.clock.timeZone === SAVED_ZONE);
    expect(after.clock).toMatchObject({ timeZone: SAVED_ZONE, chosen: true });
  }, 90_000);
});

describe("the ingest door, end to end", () => {
  // THE REGRESSION. Before the rawHeaders fix this answered
  // 403 runner_lane_loopback_only — the mark never survived into workerd — and
  // so did every other request in this file.
  it("carries the door mark all the way into the Worker", async () => {
    const res = await fetch(doorUrl(RUNNER_SCHEDULED_PATH));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "cron_required" });
  });

  it("translates the legacy scheduled path and fires the ingest's dispatch", async () => {
    // The outcome-windows lane performs only local Postgres work: no provider
    // call, spend or request to a site.
    const res = await fetch(doorUrl(`/__scheduled?cron=${encodeURIComponent("30 3 * * *")}`));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; cron: string; outcome: string; steps: { id: string; state: string; finishedAt?: string }[] };
    expect(body).toMatchObject({ ok: true, cron: "30 3 * * *", outcome: 'ran' });
    expect(body.steps.map((step) => [step.id, step.state])).toEqual([['config', 'succeeded'], ['outcomes', 'succeeded']]);
    expect(body.steps.every((step) => step.finishedAt)).toBe(true);
  });

  it("proxies a GET to the ingest Worker and returns the ingest's own answer", async () => {
    const res = await fetch(doorUrl("/healthz"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, service: "ingest" });
  });

  // The proxy carries authority across without adding any: a POST arriving with
  // the wrong bearer is refused by the INGEST, not waved through by the Tower.
  it("leaves the ingest's own operator auth in force on a proxied POST", async () => {
    const res = await fetch(doorUrl("/api/beads-snapshot"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer definitely-wrong" },
      body: JSON.stringify({ projects: [] }),
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });
});

describe("the LAN boundary, end to end", () => {
  it("refuses a runner path that arrives on the Tower's own port", async () => {
    const res = await fetch(towerUrl(`${RUNNER_SCHEDULED_PATH}?cron=${encodeURIComponent("0 * * * *")}`));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "runner_lane_loopback_only" });
  });

  // The forged-header case, over real TCP. The strip has to happen on the wire
  // copy or this passes for the wrong reason — the guard refusing before the
  // header matters — while the header itself sails on into workerd.
  it("refuses a forged door header on the Tower's own port", async () => {
    const res = await fetch(
      towerUrl(`${RUNNER_SCHEDULED_PATH}?cron=${encodeURIComponent("0 * * * *")}`),
      { headers: { [RUNNER_DOOR_HEADER]: RUNNER_DOOR_HEADER_VALUE } },
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "runner_lane_loopback_only" });
  });

  it("refuses a forged door header sent under a different casing", async () => {
    const res = await fetch(
      towerUrl(`${RUNNER_SCHEDULED_PATH}?cron=${encodeURIComponent("0 * * * *")}`),
      { headers: { "X-NoticeOS-Runner-Door": RUNNER_DOOR_HEADER_VALUE } },
    );
    expect(res.status).toBe(403);
  });

  it("still serves the Tower's ordinary API on the LAN port", async () => {
    const res = await fetch(towerUrl("/api/health"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});

describe("the Workers' secrets, end to end", () => {
  // Bead ro-ujb9.182. Were a checkout's `.dev.vars` read, its CREDENTIALS_KEY
  // would make `keyPresent` true and each provider it names would read `env`.
  it("are none of the checkout's: no encryption key and no provider from the environment", async () => {
    const res = await fetch(towerUrl("/api/integrations/providers"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as IntegrationCredentialsPayload;
    expect(body.keyPresent).toBe(false);
    expect(body.providers.length).toBeGreaterThan(0);
    expect(body.providers.filter((status) => status.credential.source === "env").map((status) => status.provider.id)).toEqual([]);
  });
});

describe("the dev server under test", () => {
  // Bead ro-ujb9.186: a close during an optimizer run is what killed the worker.
  it("runs no dependency optimizer for its close to interrupt", () => {
    expect(server.environments.client?.depsOptimizer).toBeUndefined();
  });

  it("puts the Workers' debugger on a port the kernel assigned, not the first free one from 9229", async () => {
    const res = await fetch(towerUrl("/__debug"));
    const port = Number(/ws=localhost%3A(\d+)%2F/.exec(await res.text())?.[1]);
    // The kernel hands out ports from 32768 up on Linux and 49152 up on macOS.
    expect(port).toBeGreaterThanOrEqual(32_768);
  });
});
