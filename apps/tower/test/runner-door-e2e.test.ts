// @vitest-environment node
//
// The whole chain on a real server: door → guard → Cloudflare-plugin dispatch →
// workerd → Tower Worker → INGEST binding → ingest Worker, both Workers reading
// the config store from Postgres. Only a real server reaches the seam: the
// plugin builds the Worker's `Request` from `req.rawHeaders`, not `req.headers`.
//
// Safety: the live runtime holds 5173 and 8791 and owns `.wrangler/state`. This
// test acquires ephemeral ports with bounded collision recovery, points `OS_UP_PERSIST_STATE` and wrangler's
// global dirs (dev registry included) at a fresh temp dir, and asserts it is off
// the live ports before it starts anything. Both Worker configs are copied into
// a folder with no `.dev.vars` (scripts/worker-config-folder.mts).
//
// Closing Vite while its dependency optimizer is bundling crashes the process
// inside rolldown, so scripts/test-vite-server.mts makes the server with no
// client optimizer and a close that waits for the Workers'. The site list is
// empty, so no scheduled step can fetch a real site.

import net from "node:net";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PRODUCT_ENV } from "../../../scripts/product-env.mjs";
import { startDoorFixture, type DoorFixture, type DoorAttempt } from "./helpers/runner-door-fixture";
import { secretFreeWorkerConfigs, stopLocalSecretReads } from "../../../scripts/worker-config-folder.mjs";
import { LOCAL_CONNECTION_VARIABLE, UNREACHABLE_STORE_URL, createTestStore, postgresUnavailable, type TestStore } from "./postgres-store";
import type { IntegrationCredentialsPayload } from "../shared/integrations-page";
import {
  RUNNER_DOOR_HEADER,
  RUNNER_DOOR_HEADER_VALUE,
  RUNNER_SCHEDULED_PATH,
} from "../shared/runner-lane";

let server: DoorFixture;
const attempts: DoorAttempt[] = [];
const failureAttempts: DoorAttempt[] = [];
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
  process.env.OS_UP_PERSIST_STATE = path.join(stateDir, "state");
  process.env.OS_UP_INGEST_DOOR_HOST = "127.0.0.1";
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

  let foreignRequests = 0;
  const stolen = http.createServer((_request, response) => {
    foreignRequests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "ingest" }));
  });
  try {
    server = await startDoorFixture({ env: process.env, root: stateDir, attempts, beforeAttempt: async (port, index) => {
      if (index !== 0) return;
      await new Promise<void>((resolve, reject) => {
        stolen.once("error", reject);
        stolen.listen(port, "127.0.0.1", resolve);
      });
    } });
    towerPort = server.towerPort;
    doorPort = server.doorPort;
    expect(foreignRequests).toBe(0);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.length).toBeLessThanOrEqual(3);
    expect(attempts.slice(0, -1).every(attempt => attempt.collision && attempt.closed && attempt.removed)).toBe(true);
    expect(attempts.at(-1)?.collision).toBe(false);
    expect(attempts[0]).toMatchObject({ collision: true, closed: true });
    expect(doorPort).not.toBe(attempts[0]!.port);
    expect([5173, 8791]).not.toContain(towerPort);
    expect([5173, 8791]).not.toContain(doorPort);
  } finally {
    stolen.closeAllConnections();
    await new Promise<void>((resolve, reject) => stolen.close(error => error ? reject(error) : resolve()));
    expect(stolen.listening).toBe(false);
  }
}, 120_000);

afterAll(async () => {
  try {
    try { await server?.close(); }
    finally {
      delete process.env[LOCAL_CONNECTION_VARIABLE];
      await postgres?.close();
    }
    expect([...attempts, ...failureAttempts].every(attempt => attempt.closed && attempt.removed)).toBe(true);
    for (const port of [towerPort, doorPort].filter(Boolean)) {
      await expect(new Promise<void>((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        socket.once("connect", () => { socket.destroy(); reject(new Error(`fixture port ${port} still accepts connections`)); });
        socket.once("error", error => {
          socket.destroy();
          if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve();
          else reject(error);
        });
      })).resolves.toBeUndefined();
    }
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
      await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
    console.info(JSON.stringify({ cleanup: { attempts, failureAttempts, stateDir, removed: true } }));
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
    expect(server.optimizerDisabled).toBe(true);
  });

  it("puts the Workers' debugger on a port the kernel assigned, not the first free one from 9229", async () => {
    const res = await fetch(towerUrl("/__debug"));
    const port = Number(/ws=localhost%3A(\d+)%2F/.exec(await res.text())?.[1]);
    // The kernel hands out ports from 32768 up on Linux and 49152 up on macOS.
    expect(port).toBeGreaterThanOrEqual(32_768);
  });
});

describe("fixture port acquisition failures", () => {
  it("fails once on a non-port startup error", async () => {
    const ownAttempts: DoorAttempt[] = [];
    try {
      await expect(startDoorFixture({ root: stateDir, attempts: ownAttempts,
        env: { ...process.env, NOTICEOS_TEST_VITE_CONFIG: path.join(stateDir, "absent.config.ts") },
      })).rejects.toThrow("door fixture exited (1)");
      expect(ownAttempts).toHaveLength(1);
      expect(ownAttempts[0]).toMatchObject({ collision: false, closed: true, removed: true });
    } finally { failureAttempts.push(...ownAttempts); }
  }, 30_000);

  it("fails after bounded collisions and retires every attempt", async () => {
    const ownAttempts: DoorAttempt[] = [];
    const blockers: net.Server[] = [];
    try {
      await expect(startDoorFixture({ root: stateDir, env: process.env, attempts: ownAttempts, maxAttempts: 2,
        beforeAttempt: async (port, index, proposedTower) => {
          const stolen = net.createServer(socket => socket.destroy());
          blockers.push(stolen);
          // Exercise both strict Vite binding and the production ingest door.
          await new Promise<void>((resolve, reject) => {
            stolen.once("error", reject);
            stolen.listen(index === 0 ? proposedTower : port, "127.0.0.1", resolve);
          });
        },
      })).rejects.toThrow("door fixture exited (1)");
      expect(ownAttempts).toHaveLength(2);
      expect(ownAttempts.every(attempt => attempt.collision && attempt.closed && attempt.removed)).toBe(true);
    } finally {
      failureAttempts.push(...ownAttempts);
      for (const blocker of blockers) {
        await new Promise<void>((resolve, reject) => blocker.close(error => error ? reject(error) : resolve()));
        expect(blocker.listening).toBe(false);
      }
    }
  }, 60_000);
});
