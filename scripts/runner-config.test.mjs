import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as osUp from './os-up.mjs';
import { resolveHomeRoot, statePaths } from './os-runtime.mjs';
import {
  BACKUPS_DIR,
  BEADS_DOLT_DIR,
  CONFIG,
  HOME_ROOT,
  INGEST_WRANGLER,
  LOGS_DIR,
  LOG_FILE,
  OS_CHECKOUT,
  REPO_ROOT,
  RUNNER_STATE_FILE,
  SECRET_FILES,
  STATE,
  osCheckoutName,
  runnerPaths,
} from './runner/config.mjs';

// scripts/runner/config.mjs (bead ro-ujb9.22): where the local runner's code
// and state are, and its knobs. It moved one directory down from
// scripts/os-up.mjs, so the one thing that could silently change is which
// checkout it thinks it is in.

const CHECKOUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the runner module finds the same checkout os-up.mjs sits in', () => {
  assert.equal(REPO_ROOT, CHECKOUT);
  assert.equal(INGEST_WRANGLER, path.join(CHECKOUT, 'workers', 'ingest', 'wrangler.jsonc'));
});

test('state resolves from home, the way a runtime copy needs it to', () => {
  assert.equal(HOME_ROOT, resolveHomeRoot(REPO_ROOT, process.env));
  assert.deepEqual(STATE, statePaths(HOME_ROOT));
  assert.equal(LOGS_DIR, STATE.logsDir);
  assert.equal(LOG_FILE, STATE.logFile);
  assert.equal(RUNNER_STATE_FILE, STATE.runnerStateFile);
  assert.equal(BACKUPS_DIR, STATE.backupsDir);
  assert.equal(BEADS_DOLT_DIR, STATE.beadsDoltDir);
  assert.equal(OS_CHECKOUT, osCheckoutName(HOME_ROOT));
});

test("the secret files are home's paths, never a runtime copy's", () => {
  // Paths only: nothing here opens either file.
  const home = statePaths(HOME_ROOT);
  assert.deepEqual(SECRET_FILES, { secretsFile: home.devSecrets, varsFile: home.devVars });
  const copy = path.join(HOME_ROOT, '.local', 'runtime', 'runtime-a');
  const fromCopy = runnerPaths(copy, { NOTICEOS_HOME: HOME_ROOT });
  assert.equal(fromCopy.devSecrets, home.devSecrets);
  assert.equal(fromCopy.devVars, home.devVars);
});

test('os-up.mjs still offers the same CONFIG, runnerPaths and osCheckoutName', () => {
  assert.equal(osUp.CONFIG, CONFIG);
  assert.equal(osUp.runnerPaths, runnerPaths);
  assert.equal(osUp.osCheckoutName, osCheckoutName);
});

test('the port map keeps the ingest door on loopback and off the Tower port', () => {
  assert.equal(CONFIG.ingestHost, '127.0.0.1');
  assert.equal(CONFIG.beadsHubHost, '127.0.0.1');
  assert.notEqual(CONFIG.ingestPort, CONFIG.towerPort);
  assert.notEqual(CONFIG.ingestPort, 8787, 'wrangler’s default, squatted on this machine');
});
