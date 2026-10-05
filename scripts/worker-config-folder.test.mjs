import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripJsonc } from './jsonc.mjs';
import { LOCAL_CONNECTION_VARIABLE, UNREACHABLE_STORE_URL } from './postgres-test-copies.mjs';
import {
  WORKER_CONFIGS,
  WRANGLER_DOT_ENV_SWITCH,
  relocatedWorkerConfig,
  secretFreeWorkerConfigs,
  stopLocalSecretReads,
} from './worker-config-folder.mjs';

// The unit tests' Worker configs sit in a folder with no local secrets (bead
// ro-ujb9.182): wrangler reads `.dev.vars` from beside the config it is given,
// and a checkout that runs the OS keeps the installation's real secrets there.
// Every value below is invented; no test here opens a checkout's own secrets.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INGEST = path.join('workers', 'ingest', 'wrangler.jsonc');
const INVENTED = 'INVENTED_LOCAL_SECRET';

test('a generated Worker config refuses legacy or malformed D1 bindings', () => {
  for (const d1_databases of [[{ binding: 'DB' }], { binding: 'DB' }, null]) {
    assert.throws(() => relocatedWorkerConfig(JSON.stringify({ main: 'src/index.ts', d1_databases }), '/fixture/wrangler.jsonc'), /supports Postgres only/u);
  }
});

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A checkout whose Worker configs each have a `.dev.vars` and a `.env` beside them. */
function checkoutWithSecrets(t) {
  const checkout = tempDir(t, 'worker-config-checkout-');
  for (const relative of WORKER_CONFIGS) {
    const dir = path.join(checkout, path.dirname(relative));
    mkdirSync(dir, { recursive: true });
    copyFileSync(path.join(REPO_ROOT, relative), path.join(checkout, relative));
    writeFileSync(path.join(dir, '.dev.vars'), `${INVENTED}_DEV_VARS=invented-dev-vars-value\n`);
    writeFileSync(path.join(dir, '.env'), `${INVENTED}_DOT_ENV=invented-dot-env-value\n`);
  }
  return checkout;
}

function filesUnder(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(root, full) : [path.relative(root, full)];
  });
}

test('a secret-free folder holds the Worker configs and nothing else, every path made absolute', (t) => {
  const checkout = checkoutWithSecrets(t);
  const folder = secretFreeWorkerConfigs({ checkout, parent: tempDir(t, 'worker-config-parent-') });
  assert.deepEqual(filesUnder(folder.root).sort(), [...WORKER_CONFIGS].sort());
  for (const relative of WORKER_CONFIGS) {
    const source = path.join(checkout, relative);
    const original = JSON.parse(stripJsonc(readFileSync(source, 'utf8')));
    const written = JSON.parse(stripJsonc(readFileSync(folder.configPath(relative), 'utf8')));
    assert.equal(written.name, original.name);
    assert.equal('$schema' in written, false);
    assert.equal(written.main, path.resolve(path.dirname(source), original.main));
    assert.equal(written.d1_databases, undefined);
    assert.deepEqual(written.hyperdrive, original.hyperdrive);
  }
  folder.remove();
  assert.equal(existsSync(folder.root), false);
});

test('stopping local secret reads drops the shell’s wrangler switches and turns the .env read off', () => {
  const env = { CLOUDFLARE_ENV: 'production', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true', KEPT: 'kept' };
  stopLocalSecretReads(env);
  assert.deepEqual(env, { KEPT: 'kept', [WRANGLER_DOT_ENV_SWITCH]: 'false' });
});

test('wrangler reads the .dev.vars beside a checkout’s config, and no local secret from a secret-free folder', (t) => {
  // The same wrangler, and the same call, the ingest suite's Workers pool makes.
  const wrangler = createRequire(path.join(REPO_ROOT, 'workers', 'ingest', 'package.json'))('wrangler');
  const saved = { ...process.env };
  t.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });
  // No "Using secrets defined in …" line for the checkout below, and no log file.
  process.env.WRANGLER_LOG = 'error';
  process.env.WRANGLER_LOG_PATH = tempDir(t, 'worker-config-logs-');
  // The shell at its worst: every process variable offered as a binding.
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'true';
  process.env[`${INVENTED}_PROCESS`] = 'invented-process-value';
  // Both Workers declare the store's Hyperdrive binding, which wrangler refuses
  // without a local address; nothing here reads the store.
  process.env[LOCAL_CONNECTION_VARIABLE] = UNREACHABLE_STORE_URL;
  const invented = (configPath) =>
    Object.keys(wrangler.unstable_getMiniflareWorkerOptions(configPath).workerOptions.bindings ?? {})
      .filter((name) => name.startsWith(INVENTED))
      .sort();

  const checkout = checkoutWithSecrets(t);
  // The hazard, in the wrangler this checkout runs: the file beside the config.
  assert.deepEqual(invented(path.join(checkout, INGEST)), [`${INVENTED}_DEV_VARS`]);

  const folder = secretFreeWorkerConfigs({ checkout, parent: tempDir(t, 'worker-config-parent-') });
  // An empty folder alone still lets the shell in…
  assert.deepEqual(invented(folder.configPath(INGEST)), [`${INVENTED}_PROCESS`]);
  // …and with the reads switched off, nothing local arrives at all.
  stopLocalSecretReads(process.env);
  assert.deepEqual(invented(folder.configPath(INGEST)), []);
});

test('both unit suites run their Workers from a secret-free folder', () => {
  const ingest = readFileSync(path.join(REPO_ROOT, 'workers', 'ingest', 'vitest.config.ts'), 'utf8');
  assert.match(ingest, /configPath: workerConfigs\.configPath\(INGEST_CONFIG\)/);
  assert.match(ingest, /stopLocalSecretReads\(process\.env\)/);
  const door = readFileSync(path.join(REPO_ROOT, 'apps', 'tower', 'test', 'runner-door-e2e.test.ts'), 'utf8');
  assert.match(door, /process\.env\[PRODUCT_ENV\.workerConfigRoot\.name\] = workerConfigs\.root/);
  assert.match(door, /stopLocalSecretReads\(process\.env\)/);
});
