import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// The contract's timezone module BY PATH, not through the package barrel. This
// file is loaded by Node before Vite's resolver exists, and the barrel's
// internal `./schema.js` specifiers only resolve inside a Vite/bundler graph —
// importing `@noticeos/contract` here breaks `vite dev` outright. One
// dependency-free source file resolves fine.
import { parseOsTimeZone } from "../../packages/contract/src/time-zone-setting";
// Plain ESM with no imports of its own, so it loads before Vite's resolver too.
import { noNightlyReportAssets } from "../../packages/contract/src/configuration.mjs";
import { readProductEnv } from "../../scripts/product-env.mjs";
import { applyResourceNames, readResourceNames } from "../../scripts/resource-names.mjs";
import beadsJson from "../../config/beads.json";
import constantsJson from "../../config/constants.json";
import countersJson from "../../config/counters.json";
import integrationsJson from "../../config/integrations.json";
import pullConfigJson from "../../config/pull.json";
import serpPanelJson from "../../config/serp-panel.json";
import signalPanelsJson from "../../config/signal-panels.json";
import domainCostsJson from "../../config/domain-costs.json";
import entitiesJson from "../../config/entities.json";
import valueEventsJson from "../../config/value-events.json";
import ga4CustomDimensionsJson from "../../config/ga4-custom-dimensions.json";
import recurringCostsJson from "../../config/recurring-costs.json";
import dashboardJson from "../../config/tower.json";
import { parseDashboardConfig } from "./shared/dashboard";
import { logicalTaskProjects, type TaskHubConnection } from "./shared/settings";
import { taskProjectSetupHub } from "./vite/task-project-setup";
import { towerAllowedHosts } from "./vite/allowed-hosts";
import { checkedDefault } from "./vite/checked-default";
import { configWriteLane } from "./vite/config-write-lane";
import { envImportLane } from "./vite/env-import-lane";
import { lucideIcons } from "./vite/lucide-icons";
import { reconnectPage } from "./vite/reconnect-page";
import { taskLane } from "./vite/task-lane";
import { scheduledJobsLane } from "./vite/scheduled-jobs-lane";
import { ingestDoor } from "./vite/runner-door";
import { readDemoViewerLaunch } from "../../scripts/demo-viewer-installation.mjs";
import { demoViewerLane } from "./vite/demo-viewer-lane";
import { stripJsonc } from "../../scripts/jsonc.mjs";
import { serverWorkspaceProfile, workspaceDevSecretKeys, workspaceWorkerConfig } from "./vite/workspace-profile";
import { appReleaseLane, sourceAppRelease } from './vite/app-release';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Where both Worker configs are read from: the checkout, unless a whole
// installation runs out of a folder of its own. `pnpm start` (scripts/start.mjs,
// bead ro-ujb9.126) generates the two configs there, at the same relative paths,
// beside that installation's own secrets — wrangler reads a Worker's `.dev.vars`
// from beside the config it is given, so this is what keeps a started Tower off
// any other installation's secrets.
const namedWorkerConfigRoot = readProductEnv(process.env, "workerConfigRoot");
const workerConfigRoot = namedWorkerConfigRoot ? path.resolve(namedWorkerConfigRoot) : null;
const serverConfigRoot = workerConfigRoot ?? path.resolve(rootDir, "../..");
const serverProfile = serverWorkspaceProfile([
  "apps/tower/wrangler.jsonc", "workers/ingest/wrangler.jsonc",
].map(relative => JSON.parse(stripJsonc(readFileSync(path.join(serverConfigRoot, relative), "utf8"))) as unknown), process.env);

// The names this installation's database and bucket were made under, when they
// are not the checked-in configs' (bead ro-ujb9.77.8): read from its own folder
// — the home checkout's for the managed service, NOTICEOS_INSTALLATION_DIR for
// `pnpm start` — and applied over both Worker configs. miniflare keeps local R2
// objects under the bucket's name, so this is what keeps an older store's
// archives in view; a new installation has no such file and runs on the
// checked-in NoticeOS names.
const installationHome = readProductEnv(process.env, "home");

// Single-source the file-owned config the Worker surfaces (spend caps for the
// SYSTEM band; flag defaults + the pull registry for the asset-detail wiring
// panel; shared Home/Wall display config) from static JSON imports and inject
// them into the Worker bundle via `define`. Vite tracks these imports and
// restarts the local Worker when a config file changes; production still gets
// an immutable, versioned bundle with no runtime filesystem dependency. The
// payload builders take these as parameters, so tests inject their own.
const constants = constantsJson as {
  monthly_caps: { data_usd: number };
  flag_defaults: Record<string, number | string>;
  operator_rate_usd_per_min: number;
  os_time_zone: string;
};

// The operator's clock (config/constants.json `os_time_zone`, bead ro-py40),
// compiled in as the Worker's FALLBACK only: every day the Tower reads is on
// the SAVED zone, resolved store first per request (`worker/config-source.ts`,
// bead ro-ujb9.88), and this copy answers only when the store holds none. This
// call is the BUILD BOUNDARY — the same job parseDashboardConfig does for the
// display config. A zone `Intl` cannot resolve fails the build here, instead
// of shipping a fallback that quietly moves every boundary to UTC.
const osTimeZone = parseOsTimeZone(constants.os_time_zone);

// The pull, integrations and counters defaults are checked here, at the same
// boundary, by the declarations a Save is judged by (vite/checked-default.ts).
const pullConfig = checkedDefault<unknown[]>("config/pull.json", pullConfigJson);

// The per-asset integration register (config/integrations.json): the Worker
// surfaces its DECLARED states (the matrix + each asset's integrations section)
// and merges store health over them at render time — it never writes the file.
const integrations = checkedDefault<{
  catalog: unknown[];
  assets: Record<string, unknown>;
}>("config/integrations.json", integrationsJson);

// Which totals each property shows on its card (config/counters.json). The
// Tower resolves them into the wall payload; how often they are read is the
// counters job's schedule, not this file. The ingest lane owns the scraping
// half of the same file.
const counters = checkedDefault<{
  assets: Record<string, unknown>;
}>("config/counters.json", countersJson);

const dashboard = parseDashboardConfig(dashboardJson);

// Which assets have a tracked SERP panel (config/serp-panel.json), and which
// have a standing signal panel (config/signal-panels.json). The `/assets`
// register of each crosses into the Tower, plus the roster's `/refresh` block —
// the refresh CADENCE lives in scripts/runner/config.mjs (panelRefreshCron).
//
// The card needs one fact from each: does this asset owe a panel review at all?
// A key set would answer that, and until bead `ro-sk7q` the serp-panel define
// carried nothing else. It now carries each asset's ENTRY VERBATIM, because the
// asset page's Delete needs the same value as the `expect` its `file-json-delete`
// op is guarded by — the entry as the file holds it, deep-compared before
// anything is written. `serpPanelAssets()` still reads only the keys.
const serpPanel = { assets: (serpPanelJson as { assets?: Record<string, unknown> }).assets ?? {} };
// The roster's `/refresh` block rides along since bead `ro-x5gu.8`: two of its
// numbers — the history window and the freshness bar — are DECLARED KNOBS, and
// /settings edits them in place. The block, not the file: the cadence itself is
// still the runner's schedule and is not in this file at all.
const signalPanels = {
  assets: (signalPanelsJson as { assets?: Record<string, unknown> }).assets ?? {},
  refresh: (signalPanelsJson as { refresh?: Record<string, unknown> }).refresh ?? {},
};
// The domain ORDERS behind the ledger's summed `infra` rows — what /financials
// shows an operator checking a figure against a receipt.
const domainCosts = (domainCostsJson as { domains?: unknown[] }).domains ?? [];

// The GA4 lane's two per-asset declarations (bead `ro-x5gu.3`): which events an
// asset calls value events (config/value-events.json), and which event
// parameters its operator has registered as custom dimensions on that asset's
// GA4 property (config/ga4-custom-dimensions.json). Only the `/assets` register
// of each crosses — the seeds, the notes and the file's own prose are the
// READMEs' business.
//
// They are here because the asset page EDITS them and a browser cannot open a
// file: `CollectionEditor` takes its rows from the payload the page already
// fetches, deliberately, so no surface becomes a second reader of a file
// (bead `ro-x5gu.7`). The ingest reads both files directly for its own work —
// this define is the Tower's read, not a second copy of the concept.
const valueEvents = {
  assets: (valueEventsJson as { assets?: Record<string, unknown> }).assets ?? {},
};
const ga4EventParams = {
  assets: (ga4CustomDimensionsJson as { assets?: Record<string, unknown> }).assets ?? {},
};

// The subscriptions nobody meters (config/recurring-costs.json). Until bead
// `ro-x5gu.2` this file reached no payload at all, so the only way to correct a
// price was a text editor — and /financials showed the ledger rows it books
// without ever showing the declaration they come from. Both registers now cross
// VERBATIM and in FILE ORDER: the page edits them, and a collection editor
// addresses an array row by its index.
const recurringCosts = (recurringCostsJson as { costs?: unknown[] }).costs ?? [];

// Which legal entity owns which assets (config/entities.json, bead `ro-aodz`).
// It crosses for the same reason the two money registers do: /settings edits
// these rows and an asset's Identity card moves one asset between them, and a
// browser cannot open a file — so the rows arrive VERBATIM and in FILE ORDER,
// which is how a collection editor addresses one.
const entities = (entitiesJson as { entities?: unknown[] }).entities ?? [];

// The task-hub project map (config/beads.json): which asset owns which bead
// prefix, database and repo. /settings edits it through the declared register
// (bead `ro-x5gu.5`) — adding a row does not create the Dolt database it names,
// so the page answers an Add with the operator steps that are left.
//
// The hub CONNECTION crosses only while `vite` is serving, exactly like the
// runner lane below and for the same reason: a deployed bundle should not carry
// this machine's internal topology at all, rather than carry it behind a guard.
// It crosses locally because the onboarding command an operator copies needs the
// real host and port to work, and typing them into this app instead would make a
// FOURTH copy of a value three files already have to agree on.
const beadsSpokes = (beadsJson as { spokes?: unknown[] }).spokes ?? [];
const beadsHub = (beadsJson as { hub?: TaskHubConnection }).hub ?? null;

// One cap, because one is all anything measures: metered data spend. The
// inference ceiling was withdrawn on 2026-09-05 (D6, bead `ro-uj7x`) — the OS
// makes no model calls of its own, so nothing could ever fill that meter.
const monthlyCaps = {
  dataUsd: constants.monthly_caps.data_usd,
};

// The shared contract's source files (packages/contract/src), matched on the
// resolved module id. See `environments.client` below for why they matter.
const CONTRACT_SOURCE = /[\\/]packages[\\/]contract[\\/]src[\\/]/;

export default defineConfig(({ command }) => {
  const appRelease = sourceAppRelease(path.resolve(rootDir, '../..'));
  // Check reserved local-variable collisions before any host adapter is
  // constructed or installation custody is read. The callback seals reloads.
  if (command === "serve") for (const relative of ["apps/tower/wrangler.jsonc", "workers/ingest/wrangler.jsonc"]) {
    workspaceDevSecretKeys(path.join(serverConfigRoot, relative), serverProfile, process.env.CLOUDFLARE_ENV);
  }
  const demoLaunch = serverProfile === "standalone" ? readDemoViewerLaunch(path.resolve(rootDir, "../..")) : null;
  const resourceNames = serverProfile === "standalone" ? readResourceNames({
    root: installationHome ? path.resolve(installationHome) : path.resolve(rootDir, "../.."),
    env: process.env,
  }) : {};
  if (demoLaunch !== null && command !== "serve") throw new Error("The synthetic viewer supports local serving only.");
  return ({
  cacheDir: process.env.NOTICEOS_VITE_CACHE_DIR || undefined,
  build: {
    license: { fileName: "third-party-licenses.md" },
  },
  server: {
    ...(demoLaunch === null ? {} : { host: "127.0.0.1", port: demoLaunch.towerPort, strictPort: true }),
    // os:up exposes the Tower on the trusted LAN. Keep Vite's DNS-rebinding
    // protection enabled and admit only this machine's own names, read from
    // the machine at start, plus any the operator adds (vite/allowed-hosts.ts).
    allowedHosts: towerAllowedHosts(),
    // No dev error overlay, anywhere. This dev server IS production (the wall
    // TV and the desk both read it), and vite broadcasts internal server
    // errors to every connected client — on 2026-08-11 one transient workerd
    // dispatch failure painted a stack trace over the healthy, running wall
    // for half an hour because a kiosk has nobody to press dismiss (ro-l2ji).
    // Errors still reach the terminal and the os-up log, which is where this
    // deployment reads them; the app's own error handling (reconnect page for
    // document loads, keep-last-good pollers) already covers the surfaces.
    // A prepared image has no editable source. Release detection owns display
    // refreshes; Vite reconnect must not reload desk drafts after a deploy.
    hmr: process.env.NOTICEOS_IMMUTABLE_APP === '1' ? false : { overlay: false },
    ws: process.env.NOTICEOS_IMMUTABLE_APP === '1' ? false : undefined,
  },
  plugins: [
    // First, and `enforce: "pre"`: the runner guard has to strip the door mark
    // off LAN requests before the Cloudflare plugin dispatches them to the
    // Worker. See vite/runner-door.ts.
    ...(serverProfile === "standalone" ? [ingestDoor()] : []),
    appReleaseLane(appRelease),
    ...(demoLaunch === null ? [] : [demoViewerLane(demoLaunch.installation.viewer)]),
    // The Tower's one direct write to the repo (D18, bead ro-pbzu.5): a Save in
    // a settings field applies the same validated changeset `pnpm config:apply`
    // applies, archives it and commits it. `apply: "serve"` and standalone
    // only: hosted/demo settings go through the Worker and private INGEST
    // admission instead. Also `enforce: "pre"`: it must answer that path before the
    // Cloudflare plugin dispatches it into the Worker. See
    // vite/config-write-lane.ts.
    ...(serverProfile === "standalone" ? [configWriteLane()] : []),
    // The Tower's other local lane (D19, bead `ro-l1ed.1`): the operator's
    // create/claim/close/comment on the portfolio's task hub. Same shape and
    // the same shared boundary as the config lane above (vite/lane.ts) — but
    // where that one needs a filesystem, this one needs a `bd` binary and a
    // route to a Dolt server on 127.0.0.1, which workerd has no more of than a
    // filesystem. Registered AFTER the config lane and, like it, `enforce:
    // "pre"` and `apply: "serve"`: it must answer /api/tasks/* before the
    // Cloudflare plugin dispatches them, and a built Tower answers them from
    // the Worker with `live: false` and the reason. `bd` remains the path an
    // AGENT uses — this lane is the operator's. See vite/task-lane.ts.
    ...(serverProfile === "standalone" ? [taskLane({ demoViewer: demoLaunch?.installation.viewer ?? null }), scheduledJobsLane()] : []),
    // The third local lane (bead `ro-vu8d.7`): the Import button on a Legacy env
    // card. Same shape and the same shared boundary as the two above — and what
    // it needs that workerd has not is the operator's own
    // `workers/ingest/.dev.secrets.json`, sitting beside this process. It runs
    // `pnpm dev:secrets:import`'s own function in process rather than spawning
    // it, and a built Tower answers the path from the Worker with
    // `importable: false` and the reason, so the card falls back to the command
    // it always showed. See vite/env-import-lane.ts.
    ...(serverProfile === "standalone" ? [envImportLane()] : []),
    // The other half of the same boundary: the answer a wall TV gets when the
    // dispatch into workerd throws during a page load. Listed here beside the
    // door because both are infrastructure rather than app, but position is not
    // what orders it — its `configureServer` hook is `order: "post"`, so its
    // error handler is appended after the Cloudflare plugin's dispatch
    // middleware regardless of this array. See vite/reconnect-page.ts.
    reconnectPage(),
    // Dev server only: each icon is served as its own small module instead of
    // the whole icon set pre-bundled into one 4 MB file every screen downloads
    // (bead ro-ujb9.83). No source file or production output changes. See
    // vite/lucide-icons.ts.
    lucideIcons(rootDir),
    react(),
    tailwindcss(),
    cloudflare({
      ...(workerConfigRoot === null
        ? {}
        : { configPath: path.join(workerConfigRoot, "apps", "tower", "wrangler.jsonc") }),
      config: (config) => {
        applyResourceNames(config, resourceNames);
        return workspaceWorkerConfig(config, serverProfile, command, process.env.CLOUDFLARE_ENV);
      },
      // The Workers' debugger listens on a port the kernel assigns (its address
      // is at /__debug). The plugin's default is "the first free port from
      // 9229", which every dev server on the machine picks the same way — so
      // two starting at once (the door e2e test beside another run, or beside
      // `pnpm start`) took the same one, and the loser's close hung (bead
      // ro-ujb9.186).
      inspectorPort: 0,
      // ONE runtime over the central store. The ingest used to be a second
      // `wrangler dev` process pointed at this same persist dir, which meant two
      // workerd runtimes each opening the same sqlite as their own
      // D1DatabaseObject — undefined territory for a Durable Object, and the
      // leading suspect for the 2026-08-02 corruption (bead ro-mad). Hosting it
      // here as an auxiliary Worker made ownership exclusive. Postgres now owns
      // the store; the Tower's INGEST Service Binding stays an in-process call.
      //
      // Its bindings, secrets and `triggers.crons` all still come from
      // workers/ingest/wrangler.jsonc — nothing about the ingest is redeclared
      // here, and `wrangler deploy` from that workspace is untouched.
      // `devOnly`: local development only. In production the ingest is its own
      // deployed Worker that `wrangler deploy` publishes from workers/ingest,
      // and the Tower reaches it over the same INGEST Service Binding as ever —
      // so this must NOT end up in the Tower's build output.
      auxiliaryWorkers: [
        {
          configPath: path.resolve(workerConfigRoot ?? path.resolve(rootDir, "../.."), "workers/ingest/wrangler.jsonc"),
          config: (config) => {
            applyResourceNames(config, resourceNames);
            return workspaceWorkerConfig(config, serverProfile, command, process.env.CLOUDFLARE_ENV);
          },
          devOnly: true,
        },
      ],
      // Repo-root .wrangler/state: the same base migrations are applied to with
      // `wrangler ... --persist-to ../../.wrangler/state`, and now the only
      // process that opens it while the OS is up.
      //
      // OS_UP_PERSIST_STATE points it somewhere else — the knob that makes this
      // runtime testable at all. Because the whole point of the topology is
      // "exactly one runtime opens the live store", any harness that boots a
      // second one has to be pointed at a throwaway copy first, and nothing
      // should have to edit this file to do that. `test/runner-door-e2e.test.ts`
      // is the standing consumer.
      persistState: {
        path: process.env.OS_UP_PERSIST_STATE
          ? path.resolve(process.env.OS_UP_PERSIST_STATE)
          : path.resolve(rootDir, "../../.wrangler/state"),
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
      "@shared": path.resolve(rootDir, "shared"),
    },
  },
  environments: {
    client: {
      build: {
        rolldownOptions: {
          treeshake: {
            // THE CONTRACT'S BARREL MUST NOT DRAG ZOD ONTO EVERY SCREEN (bead
            // `ro-82x`). `@noticeos/contract` re-exports every module from one
            // index, and two of them (`schema.ts`, `posthog.ts`) build zod
            // schemas at the top level. A bundler has to assume a top-level call
            // might matter, so any screen that imported one constant from the
            // package — and `lib/api.ts`, which every screen uses, imports two —
            // also downloaded those schemas and zod under them: ~80 kB minified
            // on every address, for validation the browser never runs (the
            // Worker validates; the client reads what it is sent). The
            // contract's modules are declarations and pure functions with no
            // import-time effects, so the CLIENT build may drop any of them it
            // takes nothing from. Only this environment: the Workers bundle the
            // same package on their own terms. `undefined` leaves every other
            // module to its package's own `sideEffects` answer.
            //
            // Since bead `ro-ujb9.83` browser code no longer imports the index
            // at all — it imports zod-free modules by subpath, which is what
            // takes zod off the DEV server too, and
            // test/client-contract-imports.test.ts holds it there. This stays
            // as the production backstop.
            moduleSideEffects: (id: string) => (CONTRACT_SOURCE.test(id) ? false : undefined),
          },
        },
      },
    },
  },
  define: {
    __NOTICEOS_RELEASE__: JSON.stringify(appRelease),
    __DEMO_VIEWER__: JSON.stringify(demoLaunch?.installation.viewer ?? null),
    __MONTHLY_CAPS__: JSON.stringify(monthlyCaps),
    __FLAG_DEFAULTS__: JSON.stringify(constants.flag_defaults),
    __PULL_CONFIG__: JSON.stringify(pullConfig),
    __OPERATOR_RATE__: JSON.stringify(constants.operator_rate_usd_per_min),
    __INTEGRATIONS__: JSON.stringify({ catalog: integrations.catalog, assets: integrations.assets }),
    __COUNTERS__: JSON.stringify({ assets: counters.assets }),
    __DASHBOARD__: JSON.stringify(dashboard),
    __OS_TIME_ZONE__: JSON.stringify(osTimeZone),
    // The fallback only, like the zone: the saved list is read store first.
    __NO_NIGHTLY_REPORT__: JSON.stringify(noNightlyReportAssets(constantsJson)),
    // The saved job schedules' fallback, like the list above: read store first
    // (bead `ro-ujb9.96.7.12`); the compiled copy answers an unseeded store.
    __SCHEDULES__: JSON.stringify(
      (constantsJson as { schedules?: unknown }).schedules !== null &&
        typeof (constantsJson as { schedules?: unknown }).schedules === "object"
        ? (constantsJson as { schedules?: unknown }).schedules
        : null,
    ),
    __SERP_PANEL__: JSON.stringify(serpPanel),
    __SIGNAL_PANELS__: JSON.stringify(signalPanels),
    __DOMAIN_COSTS__: JSON.stringify(domainCosts),
    __VALUE_EVENTS__: JSON.stringify(valueEvents),
    __GA4_EVENT_PARAMS__: JSON.stringify(ga4EventParams),
    __RECURRING_COSTS__: JSON.stringify(recurringCosts),
    __ENTITIES__: JSON.stringify(entities),
    __BEADS__: JSON.stringify({
      spokes: command === "serve" ? beadsSpokes : logicalTaskProjects(beadsSpokes),
      hub: serverProfile === "standalone" ? taskProjectSetupHub(command, beadsHub, { home: process.env.NOTICEOS_HOME, repoRoot: path.resolve(rootDir, "../..") }) : null,
    }),
    // The local runner's lane exists only while `vite` is serving. A build
    // substitutes `false` and the whole branch — door header check, cron RPC,
    // ingest proxy — is dead code the bundler drops, so a deployed Tower has no
    // runner surface to guard in the first place.
    __RUNNER_LANE__: JSON.stringify(command === "serve"),
  },
});
});
