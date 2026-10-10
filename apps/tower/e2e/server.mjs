// Standalone deterministic test server. No normal vite.config, .env/.dev.vars,
// Cloudflare plugin, owner config, subprocess task client or provider transport.
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createTestViteServer } from "../../../scripts/test-vite-server.mjs";
import { installIsolationGuard } from "./isolation-guard.mjs";
import { journeyPostgres } from "./fixture-server.mjs";
import { HANDLER_FAILURE_MARK, handlerFailureText } from "./handler-failure.mjs";

// Before Vite or any fixture module loads: this process never reads the
// operator's secrets files or the checkout's config/, and never opens a
// socket to an owner port.
const isolation = installIsolationGuard();
const root = fileURLToPath(new URL("../", import.meta.url));
const port = Number(process.env.JOURNEY_PORT ?? 4187);
if (!Number.isInteger(port) || port < 1024 || [5173, 8791, 3308].includes(port)) throw new Error("Unsafe journey port");
let dispatch;
let fixedNow;
// The ingest modules and the contract package import this repo's own config
// files as their compiled fallback copies. This process answers every import
// of a repo config file with the fixture's synthetic documents instead, so
// nothing here loads owner configuration, not even as a fallback nothing
// reads. A config file the fixture does not hold fails the import, and a read
// that bypasses imports is refused by the isolation guard.
const repoConfig = path.resolve(root, "../../config");
const CONFIG_MODULE = "\0journey-config:";
let syntheticConfig;
// Through the shared test-server helper: its own Vite cache in the OS temp
// dir, so runs and `pnpm dev` never invalidate each other's optimized browser
// modules, and a close (a SIGTERM's included) that waits for the dependency
// optimizer.
const vite = await createTestViteServer(createServer, {
  configFile: false, envDir: false, root,
  plugins: [{ name: "journey-synthetic-config", enforce: "pre",
    resolveId(source, importer) {
      const from = importer?.split("?")[0];
      const bare = source.split("?")[0];
      if (!from || !bare.endsWith(".json")) return null;
      const file = path.resolve(path.dirname(from), bare);
      return path.dirname(file) === repoConfig ? `${CONFIG_MODULE}${path.basename(file, ".json")}` : null;
    },
    load(id) {
      if (!id.startsWith(CONFIG_MODULE)) return null;
      const file = `config/${id.slice(CONFIG_MODULE.length)}.json`;
      if (!syntheticConfig || !Object.hasOwn(syntheticConfig, file)) throw new Error(`The isolated journey server holds no ${file}; it never loads the owner's.`);
      return `export default ${JSON.stringify(syntheticConfig[file])};`;
    },
  }, { name: "isolated-journey-api", transformIndexHtml() {
    // Every page runs at JOURNEY_NOW, unless the journey set its own clock:
    // Playwright installs page.clock before any page script as
    // globalThis.__pwClock, and that clock must win over this pin.
    return [{ tag: "script", injectTo: "head-prepend", children: `if (!globalThis.__pwClock) {
      const ActualDate = Date;
      globalThis.Date = class extends ActualDate {
        constructor(...args) { super(...(args.length ? args : [${JSON.stringify(fixedNow)}])); }
        static now() { return ActualDate.parse(${JSON.stringify(fixedNow)}); }
      };
    }` }];
  }, configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Content-Security-Policy", "connect-src 'self'; form-action 'self'");
      next();
    });
    server.middlewares.use((req, res, next) => dispatch ? dispatch(req, res, next) : next());
  } }, react(), tailwindcss()],
  resolve: { alias: { "@": path.join(root, "src"), "@shared": path.join(root, "shared") } },
  server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
  logLevel: "warn",
}, { pages: true });
const fixtures = await vite.ssrLoadModule("/e2e/fixtures.ts");
fixedNow = fixtures.JOURNEY_NOW;
syntheticConfig = fixtures.INITIAL_DOCUMENTS;
Object.assign(globalThis, fixtures.INJECTED);
// Fixed Date only; timers/performance keep running for real request/animation
// behavior. This process is fixture-only and never imported by the normal app.
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixtures.JOURNEY_NOW])); }
  static now() { return RealDate.parse(fixtures.JOURNEY_NOW); }
};
const { createJourneyHarness } = await vite.ssrLoadModule("/e2e/harness.ts");
// The production ingest functions, unchanged: the harness runs them over its
// own Postgres copy of the run's throwaway cluster.
const ingest = (file) => vite.ssrLoadModule(`/../../workers/ingest/src/${file}`);
const { forgetConfigCache } = await ingest("config-store.ts");
const { createAsset, moveAsset } = await ingest("asset-state.ts");
const { readIntegrationHealth } = await ingest("integration-health-read.ts");
const { readCredentialSummaries } = await ingest("credential-summaries-read.ts");
const { putCredential, deleteCredential, recordCredentialOutcome } = await ingest("credentials.ts");
const { connectCredential } = await ingest("credential-connect.ts");
const { putSiteToken } = await ingest("site-tokens.ts");
const { tryHealthConnection, observeIntegration } = await ingest("integration-health-context.ts");
const { beginCollection, recordCollectedHealth } = await ingest("collection-attempt.ts");
const { discoverSites } = await ingest("site-discovery.ts");
const { runCollectNow } = await ingest("dispatch.ts");
const { runUptimeChecks, runHygieneChecks } = await ingest("hygiene.ts");
const { mediavineStatus, syncMediavine, disconnectMediavine } = await ingest("mediavine.ts");
const { probeCredential, discoverGoogleProperties } = await ingest("credential-probes.ts");
const { beginGoogleOAuth, completeGoogleOAuth } = await ingest("google-oauth.ts");
const { GOOGLE_OAUTH_REVOKED_MESSAGE } = await ingest("google-auth.ts");
// A failure's own words, reached through the lane that writes them: the
// notifier, the GA4 quota flag, the time-zone annotation, the signal store's
// writer and the watch-window registration and sweep.
const { runNotifier } = await ingest("notifier.ts");
const { recordGa4Quota } = await ingest("ga4-quota.ts");
const { recordTimeZoneChange } = await ingest("time-zone-change.ts");
const { recordSignalSuccess } = await ingest("signal-store.ts");
const { writeWatchWindow } = await ingest("routes/watch-windows.ts");
const { runWatchWindows } = await ingest("watch-windows.ts");
// The nightly report fetch, whose failures keep their own records.
const { runPullAdapter } = await ingest("pull.ts");
const postgres = await journeyPostgres();
// What a failure's words may never carry: this run's database password.
const secrets = [decodeURIComponent(new URL(postgres.appUrl).password)];
const harness = createJourneyHarness({ forgetConfigCache, createAsset, moveAsset, readIntegrationHealth, readCredentialSummaries, putCredential,
  connectCredential, putSiteToken, deleteCredential, recordCredentialOutcome, tryHealthConnection, observeIntegration, beginCollection, recordCollectedHealth,
  discoverSites, runCollectNow, runUptimeChecks, mediavineStatus, syncMediavine, disconnectMediavine, probeCredential,
  beginGoogleOAuth, completeGoogleOAuth, discoverGoogleProperties, GOOGLE_OAUTH_REVOKED_MESSAGE,
  runNotifier, runHygieneChecks, recordGa4Quota, recordTimeZoneChange, recordSignalSuccess, writeWatchWindow, runWatchWindows,
  runPullAdapter },
  postgres);
await harness.ready();

// Fail closed for provider/runner fetches. Node's HTTP listener is independent
// of fetch; Vite's transform pipeline and all fixture handlers need no network.
globalThis.fetch = async (input) => {
  isolation.noteFetch(input);
  throw new Error("Outbound fetch is forbidden in the isolated journey server");
};

dispatch = async (req, res, next) => {
  const pathname = new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname;
  if (!pathname.startsWith("/api/") && !pathname.startsWith("/__journey/")) return next();
  try {
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`)) {
      res.statusCode = 403; res.end("Isolated fixture is loopback and same-origin only"); return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) { res.statusCode = 413; res.end("Fixture body too large"); return; }
      chunks.push(chunk);
    }
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method, headers: Object.entries(req.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]]),
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await harness.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    // The reason, in the answer and on one marked line the runner attaches to
    // the failing test (handler-failure.mjs); never an address or a password.
    const reason = handlerFailureText(error, secrets);
    console.error(`${HANDLER_FAILURE_MARK} ${req.method} ${pathname}: ${reason}`);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader("content-type", "text/plain; charset=utf-8"); }
    res.end(`Isolated journey handler failed: ${reason}`);
  }
};
await vite.listen();
console.log(`Isolated journey server: http://127.0.0.1:${port}`);
let closing;
function close() {
  // Vite's own SIGTERM handler closes through the same close and then exits
  // 128 + 15 unless an exit code is already set. A stop this server was asked
  // for is a clean exit, so it exits 0 whichever handler finishes first, and
  // the runner can tell a clean stop from a crash (fixture-server.mjs).
  process.exitCode = 0;
  closing ??= (async () => { await vite.close(); await harness.close(); process.exit(0); })();
  return closing;
}
process.once("SIGTERM", close);
process.once("SIGINT", close);
// Started by a runner (fixture-server.mjs): when that runner dies without
// stopping this server, its IPC channel closes, and the server goes with it.
if (process.connected) process.once("disconnect", close);
