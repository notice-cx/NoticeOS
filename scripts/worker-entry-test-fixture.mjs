// Local-only ordinary Worker bundling shared by hosted entry proofs.
//
// Within one `pnpm test:scripts` run, a bundle is made once per content: the
// esbuild output, name and settings are hashed, and the wrangler dry run's
// output is kept in the run's folder (scripts/script-tests-global.mjs) for
// every later file that asks for the same bundle (issue #10).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { WORKER_BUNDLES } from './script-tests-global.mjs';
import { REPO_ROOT } from './test-config-isolation.mjs';
import { stopLocalSecretReads } from './worker-config-folder.mjs';

const wranglerRequire = createRequire(createRequire(path.join(REPO_ROOT, 'workers/ingest/package.json')).resolve('wrangler/package.json'));
const { build } = wranglerRequire('esbuild');
export const { Miniflare } = wranglerRequire('miniflare');
const wranglerPackage = wranglerRequire.resolve('wrangler/package.json');
const wranglerMetadata = JSON.parse(readFileSync(wranglerPackage, 'utf8'));
const fixtureDir = path.join(REPO_ROOT, 'workers/ingest/test/fixture-config');
const defines = {
  __MONTHLY_CAPS__: { dataUsd: 0 }, __FLAG_DEFAULTS__: {}, __PULL_CONFIG__: [],
  __OPERATOR_RATE__: 0, __INTEGRATIONS__: { catalog: [], assets: {} }, __COUNTERS__: { assets: {} },
  __DASHBOARD__: {}, __OS_TIME_ZONE__: 'UTC', __NO_NIGHTLY_REPORT__: null, __SCHEDULES__: null,
  __SERP_PANEL__: { assets: {} }, __SIGNAL_PANELS__: { assets: {} }, __VALUE_EVENTS__: { assets: {} },
  __GA4_EVENT_PARAMS__: { assets: {} }, __DOMAIN_COSTS__: [], __RECURRING_COSTS__: [],
  __ENTITIES__: [], __BEADS__: { spokes: [] }, __RUNNER_LANE__: false,
};

export async function bundleWorkerFixture(root, name, entry) {
  const intermediate = path.join(root, `${name}.mjs`);
  // Resolve configuration to the same frozen fixture documents as the Worker
  // unit suite, before the compiler reads any checkout-owned configuration.
  await build({
    absWorkingDir: REPO_ROOT, entryPoints: [entry], outfile: intermediate,
    bundle: true, platform: 'neutral', format: 'esm', target: 'es2022',
    mainFields: ['module', 'main'], conditions: ['workerd', 'browser'], logLevel: 'silent',
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire("/workspace-fixture.mjs");' },
    external: [...builtinModules, ...builtinModules.map(name => `node:${name}`), 'cloudflare:*', 'pg-native'],
    define: Object.fromEntries(Object.entries(defines).map(([key, value]) => [key, JSON.stringify(value)])),
    plugins: [{ name: 'owned-configuration', setup(builder) {
      builder.onResolve({ filter: /config\/[^/]+\.json$/ }, args => {
        const resolved = path.resolve(args.resolveDir, args.path);
        if (path.dirname(resolved) === path.join(REPO_ROOT, 'config')) return { path: path.join(fixtureDir, path.basename(resolved)) };
        return undefined;
      });
    } }],
  });
  const settings = { name: `noticeos-${name}-fixture`, compatibility_date: '2026-07-06', compatibility_flags: ['nodejs_compat'], send_metrics: false };
  const described = (dir) => ({ modules: true, modulesRoot: dir, scriptPath: path.join(dir, `${name}.js`), compatibilityDate: '2026-07-06', compatibilityFlags: ['nodejs_compat'] });
  const bundles = process.env[WORKER_BUNDLES];
  const kept = bundles ? path.join(bundles, createHash('sha256')
    .update(JSON.stringify({ name, settings, wrangler: wranglerMetadata.version }))
    .update(readFileSync(intermediate)).digest('hex')) : null;
  if (kept && await madeElsewhere(kept, `${name}.js`)) return described(kept);
  try {
    return described(wranglerBundle(root, name, settings, intermediate, kept));
  } finally {
    if (kept) rmSync(`${kept}.lock`, { recursive: true, force: true });
  }
}

/** Whether `kept` holds a finished bundle: at once, or once the file that took
 * its lock has made it. A lock left by a file that failed is waited out once,
 * and the caller then makes its own. */
async function madeElsewhere(kept, script) {
  const done = () => existsSync(path.join(kept, script));
  if (done()) return true;
  try { mkdirSync(`${kept}.lock`); return false; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  for (const until = Date.now() + 120_000; Date.now() < until && existsSync(`${kept}.lock`);) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return done();
}

/** The wrangler dry run of `intermediate` into `root`, kept in `kept` when the
 * run has a bundle folder. */
function wranglerBundle(root, name, settings, intermediate, kept) {
  const out = path.join(root, `${name}-build`); mkdirSync(out);
  const config = path.join(root, `${name}.json`);
  writeFileSync(config, JSON.stringify({ ...settings, main: intermediate }));
  const home = path.join(root, `${name}-home`); mkdirSync(home);
  const childEnv = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, TMPDIR: root,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
    NODE_OPTIONS: process.env.NODE_OPTIONS, WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true',
    BETTER_AUTH_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1', NO_COLOR: '1' };
  stopLocalSecretReads(childEnv);
  const result = spawnSync(process.execPath, [path.join(path.dirname(wranglerPackage), wranglerMetadata.bin.wrangler), 'deploy', '--dry-run', '--config', config, '--outdir', out], { cwd: root, env: childEnv, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  if (kept) {
    // Complete before it is visible: a copy under a name of its own, then one
    // rename. Another file that made the same bundle meanwhile keeps its own.
    const staging = `${kept}.${process.pid}.${Date.now()}`;
    cpSync(out, staging, { recursive: true });
    try { renameSync(staging, kept); } catch { rmSync(staging, { recursive: true, force: true }); }
  }
  return out;
}
