// @vitest-environment node
//
// The whole chain on a real server: door → guard → Cloudflare-plugin dispatch →
// workerd → Tower Worker → INGEST binding → ingest Worker, both Workers reading
// the config store from Postgres. Only a real server reaches the seam: the
// plugin builds the Worker's `Request` from `req.rawHeaders`, not `req.headers`.
//
// Safety: the live runtime holds 5173 and 8791 and owns `.wrangler/state`. This
// test binds kernel-assigned ports, points `OS_UP_PERSIST_STATE` and wrangler's
// global dirs (dev registry included) at a fresh temp dir, and asserts it is off
// the live ports before it starts anything. Both Worker configs are copied into
// a folder with no `.dev.vars` (scripts/worker-config-folder.mts).
//
// Closing Vite while its dependency optimizer is bundling crashes the process
// inside rolldown, so scripts/test-vite-server.mts makes the server with no
// client optimizer and a close that waits for the Workers'. The site list is
// empty, so no scheduled step can fetch a real site.

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
 * another process is acceptable; binding a live port is not. */
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
  // operator's: a live runtime registers its workers in the shared one.
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

  // No page is loaded from it, so no client optimizer; see the header.
  server = await createTestViteServer(createServer, {
    root: towerRoot,
    configFile: path.join(towerRoot, "vite.config.ts"),
    server: { port: towerPort, strictPort: true, host: "127.0.0.1" },
    logLevel: "silent",
  }, { pages: false });
  await server.listen();

  // workerd takes a moment to accept the first request; poll rather than
  // sleep a fixed amount.
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

// The Tower Worker and the ingest run in one workerd under the Vite dev server,
// both on the POSTGRES Hyperdrive binding, here this suite's throwaway copy.
// One Settings read covers both halves of the config store: the saved clock
// comes from the ingest over the INGEST binding, whether one was ever chosen
// from the Tower's own read of the change history (`timeZoneEverSaved`).
//
// First in the file: it reads the store before any request here can write it.
describe("the config store, from Postgres", () => {
  it("the Tower and the ingest, in the local OS's one dev server, read the config store from Postgres on their own POSTGRES bindings", async ({ skip }) => {
    if (!postgres) return skip(`no Postgres here: ${postgresUnavailable()}`);
    const before = await settingsUntil(() => true);
    expect(before.clock.timeZone).not.toBe(SAVED_ZONE);
    expect(before.clock.chosen).toBe(false);

    // A Save of the clock, as the ingest's writer records one: the document
    // and its change, in the store's one workspace, as noticeos_app.
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
  // A mark set only on the header map never reaches workerd, and this answers
  // 403 runner_lane_loopback_only.
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

  // The proxy carries authority across without adding any: a POST arriving
  // with the wrong bearer is refused by the INGEST, not waved through.
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

  // The forged-header case, over real TCP: the strip has to happen on the
  // wire copy, or the guard refuses before the header matters while the
  // header itself sails on into workerd.
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
  // Were a checkout's `.dev.vars` read, its CREDENTIALS_KEY would make
  // `keyPresent` true and each provider it names would read `env`.
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
  // A close during an optimizer run kills the Vitest worker.
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
