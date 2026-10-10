import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { stripJsonc } from '../../scripts/jsonc.mjs';
import {
  startTestCluster,
  unavailableReason,
  workersPoolDriverAliases,
  type TestCluster,
} from '../../scripts/postgres-test-cluster.mjs';
import { LOCAL_CONNECTION_VARIABLE, UNREACHABLE_STORE_URL } from '../../scripts/postgres-test-copies.mjs';
import { fixtureConfigPlugin } from '../../scripts/test-config-isolation.mjs';
import { unitTestAttribution } from '../../scripts/unit-test-attribution.mjs';
import { unitTestWorkers } from '../../scripts/unit-test-workers.mjs';
import { secretFreeWorkerConfigs, stopLocalSecretReads } from '../../scripts/worker-config-folder.mjs';
import { ASSET_TOKENS, CREDENTIALS_KEY, OPERATOR_TOKEN } from './test/fixtures';

const WRANGLER_CONFIG = fileURLToPath(new URL('./wrangler.jsonc', import.meta.url));

/**
 * The Worker runs on the bindings this file declares, and no others. The pool
 * builds the Worker's env from the wrangler config it is given, and wrangler
 * adds the `.dev.vars` beside that config (in a checkout that runs the OS, the
 * installation's real secrets) with no option to turn that read off, so the
 * pool gets wrangler.jsonc copied into a new, empty folder with the `.env` and
 * process reads switched off (scripts/worker-config-folder.mts).
 * test/test-env.test.ts proves the env holds exactly the names declared here.
 */
const INGEST_CONFIG = path.join('workers', 'ingest', 'wrangler.jsonc');
const workerConfigs = secretFreeWorkerConfigs({ configs: [INGEST_CONFIG] });
process.once('exit', workerConfigs.remove);
stopLocalSecretReads(process.env);

/**
 * A process-local signing key keeps collector tests realistic without loading
 * the operator's credential into workerd. Two properties, so "collected every
 * configured property" and "collected the first one" are different numbers.
 * They share one service account, which is also the shape in production.
 */
function testGoogleAccounts(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccount = {
    type: 'service_account',
    client_email: 'signals-test@example.test',
    private_key_id: 'test-key',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  return JSON.stringify({
    'test-signals': {
      service_account_b64: Buffer.from(JSON.stringify(serviceAccount)).toString('base64'),
      properties: {
        'meals.example': {
          ga4_property_id: '123456',
          gsc_site_url: 'sc-domain:meals.example',
        },
        'nosh.example': {
          ga4_property_id: '654321',
          gsc_site_url: 'sc-domain:nosh.example',
        },
      },
    },
  });
}

/**
 * wrangler.jsonc, read here in the Node config context because workerd has no
 * `node:fs`: test/crons.test.ts pins its `triggers.crons` and
 * test/test-env.test.ts needs the bindings it declares. A malformed config
 * fails the run; a parity test that cannot read the config must not pass.
 */
const wranglerConfig = JSON.parse(stripJsonc(readFileSync(WRANGLER_CONFIG, 'utf8'))) as Record<string, unknown> & {
  triggers?: { crons?: string[] };
  vars?: Record<string, unknown>;
};

/**
 * Postgres test copies: one throwaway cluster per run, started when the first
 * Workers runtime is built. Each runtime gets its own copy of the store as
 * `POSTGRES`, a second copy as `POSTGRES_OTHER` (for the config cache's
 * ownership proof), and `TEST_POSTGRES`: POST /reset remakes the first copy
 * before every file (test/clean-start.ts), and the second only with
 * `{ other: true }`; POST /owner runs a fixture statement as the owner.
 *
 * Required: nearly every file reads the config store, so a run where no
 * Postgres can start fails, naming why. wrangler insists on a local connection
 * string for the binding before this file's own replaces it, so the variable
 * wrangler reads names an address nothing listens on.
 */
process.env[LOCAL_CONNECTION_VARIABLE] = UNREACHABLE_STORE_URL;
let postgres: Promise<TestCluster> | null = null;
let runtimes = 0;
async function postgresOptions(): Promise<{
  hyperdrives: Record<string, string>;
  serviceBindings: Record<string, (request: Request) => Promise<Response>>;
}> {
  postgres ??= startTestCluster();
  let cluster: TestCluster;
  try {
    cluster = await postgres;
  } catch (error) {
    const reason = unavailableReason(error);
    if (reason === null) throw error;
    throw new Error(`the ingest suite runs on Postgres, and none can start here: ${reason}`, { cause: error });
  }
  // Numbered before the first await: runtimes are built concurrently.
  const runtime = (runtimes += 1);
  const database = await cluster.createDatabase(`noticeos_ingest_${runtime}_dev`);
  const other = await cluster.createDatabase(`noticeos_ingest_${runtime}_other_dev`);
  return {
    hyperdrives: { POSTGRES: cluster.url(database), POSTGRES_OTHER: cluster.url(other) },
    serviceBindings: {
      TEST_POSTGRES: async (request: Request) => {
        const { pathname } = new URL(request.url);
        if (pathname === '/reset') {
          const body = await request.text();
          const asked = (body === '' ? {} : JSON.parse(body)) as { other?: unknown };
          await cluster.resetDatabase(database);
          if (asked.other === true) await cluster.resetDatabase(other);
          return new Response(null, { status: 204 });
        }
        if (pathname === '/owner') {
          const asked = (await request.json()) as { sql?: unknown; other?: unknown };
          if (typeof asked.sql !== 'string') return new Response('POST /owner takes { sql }', { status: 400 });
          try {
            await cluster.asOwner(asked.other === true ? other : database, asked.sql);
          } catch (error) {
            return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
          }
          return new Response(null, { status: 204 });
        }
        return new Response('POST /reset or /owner', { status: 404 });
      },
    },
  };
}

/** Every binding wrangler.jsonc declares: each list's `binding` names (R2, Hyperdrive, …) and its `vars`. */
const WRANGLER_BINDINGS: string[] = [
  ...Object.values(wranglerConfig).flatMap((value) =>
    Array.isArray(value)
      ? value.flatMap((entry: { binding?: unknown } | null) => (typeof entry?.binding === 'string' ? [entry.binding] : []))
      : [],
  ),
  ...Object.keys(wranglerConfig.vars ?? {}),
];

export default defineConfig({
  // node-postgres, as this pool must load it (scripts/postgres-test-cluster.mts says why).
  resolve: { alias: workersPoolDriverAliases() },
  plugins: [
    // The suite never reads the checkout's own config/: the copies this Worker
    // compiles in as its fallback are answered with test/fixture-config/'s
    // frozen documents, so an operator saving a setting cannot change a result.
    // A test importing a config file is refused, bar the seed-validation tests
    // listed in scripts/test-config-isolation.mjs.
    fixtureConfigPlugin({
      fixtureDir: fileURLToPath(new URL('./test/fixture-config', import.meta.url)),
      testDir: fileURLToPath(new URL('./test', import.meta.url)),
    }),
    cloudflareTest(async () => {
      const postgres = await postgresOptions();
      // The test runner wraps global fetch, so use an auxiliary Worker to
      // exercise the unwrapped native function. All outbound traffic is local.
      const serviceBindings = { NATIVE_MEDIAVINE: 'test-native-mediavine', ...postgres.serviceBindings };
      const bindings = {
        TEST_CRONS: wranglerConfig.triggers?.crons ?? [],
        ASSET_TOKENS: JSON.stringify(ASSET_TOKENS),
        OPERATOR_TOKEN,
        GOOGLE_SIGNAL_ACCOUNTS: testGoogleAccounts(),
        BING_WEBMASTER_API_KEY: 'test-bing-key',
        // Explicitly empty, as a safety rule: the notifier posts to whatever
        // webhook it resolves, and this value wins over any local secret, so the
        // only webhook any test can reach is one it injected itself.
        DISCORD_WEBHOOK_URL: '',
        DATAFORSEO_LOGIN: 'test-dataforseo-login',
        DATAFORSEO_PASSWORD: 'test-dataforseo-password',
        // The throwaway key from test/fixtures.ts, so the credential-store suite
        // can seal and open real AES-GCM rows. An installation's own key must
        // never load into workerd.
        CREDENTIALS_KEY,
      };
      return {
        wrangler: { configPath: workerConfigs.configPath(INGEST_CONFIG) },
        miniflare: {
          hyperdrives: postgres.hyperdrives,
          serviceBindings,
          workers: [{ name: 'test-native-mediavine', modules: true, compatibilityDate: '2026-07-06', outboundService: 'test-native-outbound',
            script: transpileModule(readFileSync(new URL('../../packages/mediavine/src/index.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 } }).outputText + `
              export default { async fetch() {
                const client = new MediavineClient({ credentials: { email: 'fake@example.test', password: 'synthetic-only' }, session: { accessToken: 'synthetic-native-access', refreshToken: 'synthetic-native-refresh', expiresAt: Date.now() + 3600000 }, saveSession: async () => {} });
                try { return Response.json(await client.sites()); } catch (error) { return Response.json({ error: error.message }, {status: 500}); }
              } };` },
            { name: 'test-native-outbound', modules: true, compatibilityDate: '2026-07-06', script: `
            export default { async fetch(request) {
              if (request.url !== 'https://api-publishers.mediavine.com/graphql' || request.method !== 'POST' || request.headers.get('authorization') !== 'Bearer synthetic-native-access') return new Response('Unexpected test request', {status: 503});
              const body = await request.json();
              if (!body.query.includes('sitesForUser')) return new Response('Unexpected test operation', {status: 503});
              return Response.json({ data: { sitesForUser: { edges: [{node: {id: 'synthetic-site', title: 'Test publisher', domain: 'example.test'}}], pageInfo: {hasNextPage: false, endCursor: null} } } });
            } };` }],
          bindings: {
            ...bindings,
            // Every name this Worker's env may hold: wrangler.jsonc's bindings
            // and this file's. test/test-env.test.ts fails on any other.
            TEST_BINDING_NAMES: [
              ...WRANGLER_BINDINGS,
              ...Object.keys(postgres.hyperdrives),
              ...Object.keys(serviceBindings),
              ...Object.keys(bindings),
              'TEST_BINDING_NAMES',
            ],
          },
        },
      };
    }),
    // A worker that dies names the file it was running.
    unitTestAttribution(),
  ],
  test: {
    // One Workers runtime per Vitest worker, reused from file to file: starting
    // one for every file was most of the suite's time. Every file still starts
    // clean (test/clean-start.ts; test/isolation-probe.ts proves it).
    isolate: false,
    // Half the cores, beside the Tower suite (scripts/unit-test-workers.mts).
    maxWorkers: unitTestWorkers(),
    setupFiles: ['./test/clean-start.ts'],
    // A collector test drives a whole sweep, hundreds of store calls, which on
    // a busy host outruns Vitest's 5 s default. A limit here catches a hang; it
    // is not a speed check.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The collectors log every sweep as JSON, which would push the failures CI
    // must show out of its log. A failing test still prints its own output.
    silent: 'passed-only',
  },
});
