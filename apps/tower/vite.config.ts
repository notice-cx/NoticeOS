import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// By path, not through the package barrel: this file is loaded by Node before
// Vite's resolver exists, and the barrel's `./schema.js` specifiers only
// resolve inside a bundler graph.
import { parseOsTimeZone } from "../../packages/contract/src/time-zone-setting";
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
import { documentHeadPlugin } from "./vite/document-head";
import { appReleaseLane, sourceAppRelease } from './vite/app-release';
import { gitSourceVersion, sourceVersion } from '../../scripts/source-version.mjs';
import { developmentDependencies, prepareDevelopmentWorkerConfigs } from '../../deploy/compose/development.mjs';
import { liveSource } from './vite/live-source';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Where both Worker configs are read from: the checkout, unless an installation
// runs out of a folder of its own. wrangler reads a Worker's `.dev.vars` from
// beside the config it is given, which keeps a started Tower off any other
// installation's secrets.
const liveSourceRoot = process.env.NOTICEOS_LIVE_SOURCE_ROOT;
if (liveSourceRoot) developmentDependencies({source:liveSourceRoot,metadataFile:'/dependency-image.json'});
const namedWorkerConfigRoot = liveSourceRoot
  ? prepareDevelopmentWorkerConfigs({source:path.resolve(rootDir,'../..'),home:process.env.NOTICEOS_HOME})
  : readProductEnv(process.env, "workerConfigRoot");
const workerConfigRoot = namedWorkerConfigRoot ? path.resolve(namedWorkerConfigRoot) : null;
const serverConfigRoot = workerConfigRoot ?? path.resolve(rootDir, "../..");
const serverProfile = serverWorkspaceProfile([
  "apps/tower/wrangler.jsonc", "workers/ingest/wrangler.jsonc",
].map(relative => JSON.parse(stripJsonc(readFileSync(path.join(serverConfigRoot, relative), "utf8"))) as unknown), process.env);

// The names this installation's database and bucket were made under, when they
// are not the checked-in configs'. miniflare keeps local R2 objects under the
// bucket's name, so this is what keeps an older store's archives in view.
const installationHome = readProductEnv(process.env, "home");

// The file-owned config the Worker surfaces is injected into the bundle via
// `define`: Vite restarts the local Worker when a config file changes, and a
// built bundle has no runtime filesystem dependency.
const constants = constantsJson as {
  monthly_caps: { data_usd: number };
  flag_defaults: Record<string, number | string>;
  operator_rate_usd_per_min: number;
  os_time_zone: string;
};

// The Worker's fallback zone only: the saved zone is resolved store first per
// request (`worker/config-source.ts`). A zone `Intl` cannot resolve fails the
// build here instead of quietly moving every day boundary to UTC.
const osTimeZone = parseOsTimeZone(constants.os_time_zone);

// Checked at build by the same declarations a Save is judged by.
const pullConfig = checkedDefault<unknown[]>("config/pull.json", pullConfigJson);

const integrations = checkedDefault<{
  catalog: unknown[];
  assets: Record<string, unknown>;
}>("config/integrations.json", integrationsJson);

const counters = checkedDefault<{
  assets: Record<string, unknown>;
}>("config/counters.json", countersJson);

const dashboard = parseDashboardConfig(dashboardJson);

// Each asset's entry crosses verbatim: the asset page's Delete deep-compares
// it against the file as the `expect` of its `file-json-delete` op.
const serpPanel = { assets: (serpPanelJson as { assets?: Record<string, unknown> }).assets ?? {} };
// The `/refresh` block crosses because /settings edits two of its numbers;
// the refresh cadence itself is the runner's schedule, not this file.
const signalPanels = {
  assets: (signalPanelsJson as { assets?: Record<string, unknown> }).assets ?? {},
  refresh: (signalPanelsJson as { refresh?: Record<string, unknown> }).refresh ?? {},
};
const domainCosts = (domainCostsJson as { domains?: unknown[] }).domains ?? [];

// Registers the asset page edits cross verbatim and in file order: a
// collection editor addresses an array row by its index, and a browser cannot
// open a file.
const valueEvents = {
  assets: (valueEventsJson as { assets?: Record<string, unknown> }).assets ?? {},
};
const ga4EventParams = {
  assets: (ga4CustomDimensionsJson as { assets?: Record<string, unknown> }).assets ?? {},
};

const recurringCosts = (recurringCostsJson as { costs?: unknown[] }).costs ?? [];

const entities = (entitiesJson as { entities?: unknown[] }).entities ?? [];

// The hub connection crosses only while `vite` is serving: a deployed bundle
// must not carry this machine's internal topology at all.
const beadsSpokes = (beadsJson as { spokes?: unknown[] }).spokes ?? [];
const beadsHub = (beadsJson as { hub?: TaskHubConnection }).hub ?? null;

// One cap: metered data spend. The OS makes no model calls of its own.
const monthlyCaps = {
  dataUsd: constants.monthly_caps.data_usd,
};

// The shared contract's source files, matched on the resolved module id.
const CONTRACT_SOURCE = /[\\/]packages[\\/]contract[\\/]src[\\/]/;

export default defineConfig(({ command }) => {
  const appRelease = sourceAppRelease(path.resolve(rootDir, '../..'), { liveSource: command === 'serve' && Boolean(liveSourceRoot) });
  const appSourceVersion = liveSourceRoot ? gitSourceVersion(liveSourceRoot,{declared:true}) : sourceVersion(path.resolve(rootDir,'../..'));
  // Reserved local-variable collisions are checked before any host adapter
  // is constructed or installation custody is read.
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
    // The Tower is exposed on the LAN: keep Vite's DNS-rebinding protection
    // and admit only this machine's own names plus any the operator adds.
    allowedHosts: towerAllowedHosts(),
    // No error overlay: Vite broadcasts internal server errors to every client,
    // and a kiosk wall has nobody to press dismiss. Errors still reach the log.
    // An immutable app has no editable source; release detection owns display
    // refreshes, and a Vite reconnect must not reload desk drafts after a deploy.
    hmr: process.env.NOTICEOS_IMMUTABLE_APP === '1' ? false : { overlay: false },
    ws: process.env.NOTICEOS_IMMUTABLE_APP === '1' ? false : undefined,
  },
  plugins: [
    ...(liveSourceRoot ? [liveSource({sourceRoot:liveSourceRoot,codeRoot:path.resolve(rootDir,'../..')})] : []),
    // First, and `enforce: "pre"`: the door mark must be stripped off LAN
    // requests before the Cloudflare plugin dispatches them to the Worker.
    ...(serverProfile === "standalone" ? [ingestDoor()] : []),
    appReleaseLane(appRelease),
    documentHeadPlugin(serverProfile, path.join(rootDir, "vite/demo-head.html")),
    ...(demoLaunch === null ? [] : [demoViewerLane(demoLaunch.installation.viewer)]),
    // The local lanes answer only while `vite` serves a standalone profile;
    // hosted and demo settings go through the Worker and INGEST admission.
    // Each is `enforce: "pre"` so it answers its path before the Cloudflare
    // plugin dispatches it into the Worker, where the built answer lives.
    ...(serverProfile === "standalone" ? [configWriteLane()] : []),
    ...(serverProfile === "standalone" ? [taskLane({ demoViewer: demoLaunch?.installation.viewer ?? null }), scheduledJobsLane()] : []),
    ...(serverProfile === "standalone" ? [envImportLane()] : []),
    // Position does not order this one: its `configureServer` hook is
    // `order: "post"`, so its error handler lands after the Cloudflare
    // plugin's dispatch middleware regardless of this array.
    reconnectPage(),
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
      // A kernel-assigned debugger port (address at /__debug): two dev servers
      // starting at once would otherwise pick the same "first free from 9229"
      // and the loser's close hangs.
      inspectorPort: 0,
      // One workerd runtime hosts the ingest as an auxiliary Worker, so the
      // Tower's INGEST Service Binding is an in-process call and exactly one
      // process opens the local persist state. Its bindings, secrets and crons
      // come from workers/ingest/wrangler.jsonc. `devOnly`: in production the
      // ingest is its own deployed Worker and must not reach the Tower's build.
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
      // OS_UP_PERSIST_STATE lets a harness boot a second runtime against a
      // throwaway copy instead of the live state.
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
            // The contract's barrel builds zod schemas at the top level, which a
            // bundler must assume matter; its modules have no import-time
            // effects, so the client build may drop any it takes nothing from.
            // Client only: the Workers bundle the package on their own terms.
            // `undefined` leaves every other module to its package's own
            // `sideEffects` answer.
            moduleSideEffects: (id: string) => (CONTRACT_SOURCE.test(id) ? false : undefined),
          },
        },
      },
    },
  },
  define: {
    __NOTICEOS_RELEASE__: JSON.stringify(appRelease),
    __NOTICEOS_SOURCE_VERSION__: JSON.stringify(appSourceVersion),
    __NOTICEOS_LIVE_SOURCE__: JSON.stringify(Boolean(liveSourceRoot)),
    __DEMO_VIEWER__: JSON.stringify(demoLaunch?.installation.viewer ?? null),
    __MONTHLY_CAPS__: JSON.stringify(monthlyCaps),
    __FLAG_DEFAULTS__: JSON.stringify(constants.flag_defaults),
    __PULL_CONFIG__: JSON.stringify(pullConfig),
    __OPERATOR_RATE__: JSON.stringify(constants.operator_rate_usd_per_min),
    __INTEGRATIONS__: JSON.stringify({ catalog: integrations.catalog, assets: integrations.assets }),
    __COUNTERS__: JSON.stringify({ assets: counters.assets }),
    __DASHBOARD__: JSON.stringify(dashboard),
    __OS_TIME_ZONE__: JSON.stringify(osTimeZone),
    // Fallbacks only, like the zone: the saved values are read store first.
    __NO_NIGHTLY_REPORT__: JSON.stringify(noNightlyReportAssets(constantsJson)),
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
    // A build substitutes `false` and the bundler drops the whole runner
    // branch, so a deployed Tower has no runner surface to guard.
    __RUNNER_LANE__: JSON.stringify(command === "serve"),
  },
});
});
