// @vitest-environment node
//
// BOTH WORKERS READ THE CONFIG STORE FROM POSTGRES THE WAY THE LOCAL OS RUNS
// THEM (epic ro-ujb9.76; the pattern every port copies is
// docs/briefs/2026-09-29-postgres-port-pattern.md).
//
// The local OS — the managed service and `pnpm start` alike — runs ONE Vite
// dev server (apps/tower/vite.config.ts): the Cloudflare plugin runs the Tower
// Worker and, as its auxiliary Worker, the ingest, each from its own
// wrangler.jsonc, both in one workerd. This boots exactly that server on
// ephemeral loopback ports, from the checked-in Worker configs written into a
// folder of their own with no secret beside them (as `pnpm start` writes
// them, scripts/worker-config-folder.mts). Both declare the POSTGRES Hyperdrive
// binding; its local connection string reaches the dev server the way wrangler
// documents for local development,
// CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES in its environment,
// and names a copy of the run's throwaway store (test/postgres-global-setup.mjs).
//
// One Settings read covers both Workers' halves of the config store: the saved
// clock comes from the ingest's config store over the INGEST binding
// (workers/ingest/src/config-store.ts, on the ingest's own POSTGRES binding),
// and whether a clock was ever chosen from the Tower's own read of the change
// history (worker/config-source.ts `timeZoneEverSaved`, on the Tower's).
//
// SAFETY, as test/runner-door-e2e.test.ts: ports the kernel assigns, never
// the managed service's; a store, registry and wrangler folders of its own;
// Worker configs with no secret beside them.

import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { PRODUCT_ENV } from "../../../scripts/product-env.mjs";
import { createTestViteServer } from "../../../scripts/test-vite-server.mjs";
import { secretFreeWorkerConfigs, stopLocalSecretReads } from "../../../scripts/worker-config-folder.mjs";
import { LOCAL_CONNECTION_VARIABLE, createTestStore, postgresUnavailable, type TestStore } from "./postgres-store";

const towerRoot = path.dirname(fileURLToPath(new URL("../vite.config.ts", import.meta.url)));
/** The managed service's ports. Never these. */
const LIVE_PORTS = new Set([5173, 8791]);
/** A zone no product default and no fixture holds, so only the store can answer it. */
const SAVED_ZONE = "Pacific/Kiritimati";

const unavailable = postgresUnavailable();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

let server: ViteDevServer | undefined;
let stateDir: string | undefined;
let pg: TestStore | undefined;
let removeConfigs: (() => void) | undefined;
let towerPort = 0;

beforeAll(async () => {
  if (unavailable !== null) return;
  pg = await createTestStore({ scope: "suite" });
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "noticeos-postgres-runtime-"));
  vi.stubEnv(PRODUCT_ENV.home.name, stateDir);
  vi.stubEnv(PRODUCT_ENV.installationDir.name, path.join(stateDir, "installation"));
  towerPort = await freePort();
  const doorPort = await freePort();
  expect(LIVE_PORTS.has(towerPort) || LIVE_PORTS.has(doorPort)).toBe(false);

  process.env.OS_UP_PERSIST_STATE = path.join(stateDir, "state");
  process.env.OS_UP_INGEST_DOOR_HOST = "127.0.0.1";
  process.env.OS_UP_INGEST_DOOR_PORT = String(doorPort);
  process.env.MINIFLARE_REGISTRY_PATH = path.join(stateDir, "registry");
  process.env.XDG_CONFIG_HOME = path.join(stateDir, "xdg");
  process.env.WRANGLER_LOG_PATH = path.join(stateDir, "wrangler-logs");
  const workerConfigs = secretFreeWorkerConfigs({ parent: stateDir });
  removeConfigs = workerConfigs.remove;
  process.env[PRODUCT_ENV.workerConfigRoot.name] = workerConfigs.root;
  process.env[LOCAL_CONNECTION_VARIABLE] = pg.url;
  stopLocalSecretReads(process.env);

  server = await createTestViteServer(createServer, {
    root: towerRoot,
    configFile: path.join(towerRoot, "vite.config.ts"),
    server: { port: towerPort, strictPort: true, host: "127.0.0.1" },
    logLevel: "silent",
  }, { pages: false });
  await server.listen();
}, 120_000);

afterAll(async () => {
  try {
    await server?.close();
    delete process.env[LOCAL_CONNECTION_VARIABLE];
    await pg?.close();
    removeConfigs?.();
    if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
  } finally { vi.unstubAllEnvs(); }
}, 60_000);

interface SettingsRead {
  clock: { timeZone: string; chosen: boolean };
}

/** `/api/settings` once it answers what `until` waits for; workerd takes a
 * moment to accept its first request and the ingest caches a read for a
 * second, so poll, never sleep a fixed time. */
async function settingsUntil(until: (read: SettingsRead) => boolean): Promise<SettingsRead> {
  const deadline = Date.now() + 60_000;
  let last: unknown = null;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${towerPort}/api/settings`);
      last = { status: res.status, body: await res.json() };
      if (res.status === 200 && until((last as { body: SettingsRead }).body)) return (last as { body: SettingsRead }).body;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`/api/settings never answered as expected: ${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

it("the Tower and the ingest, in the local OS's one dev server, read the config store from Postgres on their own POSTGRES bindings", async ({ skip }) => {
  if (unavailable !== null || !pg) return skip(`no Postgres here: ${unavailable}`);
  const before = await settingsUntil(() => true);
  expect(before.clock.timeZone).not.toBe(SAVED_ZONE);
  expect(before.clock.chosen).toBe(false);

  // A Save of the clock, as the ingest's writer records one: the document and
  // its change, in the store's one workspace, as noticeos_app.
  const own = pg;
  await own.store.inWorkspace(own.workspaceId, async (tx) => {
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
