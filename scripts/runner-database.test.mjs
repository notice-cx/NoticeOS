// scripts/runner/database.mjs: the runner reads
// DATABASE_URL from HOME's secrets file, checks it as the application login,
// and hands it to its one Tower child's environment and nowhere else; a
// missing or unusable address stops it before anything starts.
//
// The last test is a rehearsal of the stack's runner: a runner process whose
// home is a throwaway folder supervises the runner's own Tower child
// (`towerChild`, `startChild` from scripts/os-up.mjs) on a throwaway Postgres
// whose application login has a planted password, saves a setting through the
// Tower, and then looks for the password everywhere the runner wrote. What it
// does not start is the runner's scheduler and host lanes, and its
// single-instance guard: those are pinned to the NoticeOS stack's own ports
// and task hub, which a test must never touch. Its Worker configs are written
// into its home beside its secrets (as `pnpm start` writes them), where a
// code folder links them.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { codeMigrationVersions, LOCAL_CONNECTION_VARIABLE } from './database-address.mjs';
import { doorIsHeld } from './ingest-door.mjs';
import { statePaths } from './os-runtime.mjs';
import { towerChild } from './os-up.mjs';
import { CONFIG } from './runner/config.mjs';
import { EXIT_NO_DATABASE } from './runner/lifecycle.mjs';
import { doorOwnershipDecision, listListenerOwners } from './runner/door-ownership.mjs';
import { postgresRequired, startTestCluster, unavailableReason } from './postgres-test-cluster.mjs';
import { MANAGED_PORTS } from './start.mjs';
import { answersHolding, filesHolding, plantedDatabase, processTree, saveClockThroughTower, storedClock } from './test-planted-address.mjs';
import { WORKER_CONFIGS, workerConfig } from './worker-config-folder.mjs';
import { loopbackListeners, proveStandaloneTunnel } from './test-fixtures/standalone-access.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS, '..');
const moduleUrl = (relative) => pathToFileURL(path.join(SCRIPTS, relative)).href;

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A home whose secrets file holds `bindings`. */
function homeWith(t, bindings) {
  const home = tempDir(t, 'runner-database-');
  const { devSecrets } = statePaths(home);
  mkdirSync(path.dirname(devSecrets), { recursive: true });
  writeFileSync(devSecrets, JSON.stringify(bindings), { mode: 0o600 });
  return { home, secretsFile: devSecrets };
}

/** What runnerDatabase() answers in a fresh process whose home is `home`; the
 * database check is a stand-in unless `live`. */
function runnerDatabaseIn(home, { live = false, env = {} } = {}) {
  const check = live
    ? ''
    : `{ open: () => ({ onlyWorkspace: async () => 'a1b2c3d4-0000-4000-8000-000000000001', inWorkspace: async (id, work) => work({ query: async () => ${JSON.stringify(codeMigrationVersions().map(version => ({ version })))} }), close: async () => {} }), migrationsDir: ${JSON.stringify(path.join(REPO_ROOT, 'db', 'postgres', 'migrations'))} }`;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(moduleUrl('runner/database.mjs'))}); console.log(JSON.stringify(await m.runnerDatabase(${check})));`],
    { env: { ...process.env, ...env, NOTICEOS_HOME: home }, encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split('\n').at(-1));
}

test("the address is read from home's secrets file, and a missing one is refused naming that file", (t) => {
  const address = 'postgresql://noticeos_app:planted-in-home@127.0.0.1:5432/noticeos?sslmode=disable';
  const ready = homeWith(t, { OPERATOR_TOKEN: 'x', DATABASE_URL: address });
  assert.deepEqual(runnerDatabaseIn(ready.home), { ok: true, env: { [LOCAL_CONNECTION_VARIABLE]: address } });

  const missing = homeWith(t, { OPERATOR_TOKEN: 'x' });
  const refusal = runnerDatabaseIn(missing.home);
  assert.equal(refusal.ok, false);
  assert.equal(
    refusal.line,
    `DATABASE_URL is not set in ${missing.secretsFile}: add your NoticeOS database's connection string there (db/postgres/host/README.md sets one up).`,
  );
});

// Taking the Compose profile's address is `pnpm start`'s, for a new folder.
// The stack's runner never takes it: a home without
// DATABASE_URL is refused even beside a profile that holds one.
test("the runner never takes the Compose profile's address, and leaves home's secrets file as it was", (t) => {
  const missing = homeWith(t, { OPERATOR_TOKEN: 'x' });
  const profile = tempDir(t, 'runner-compose-');
  writeFileSync(path.join(profile, 'database.url'), 'postgresql://noticeos_app:planted-in-profile@127.0.0.1:5432/noticeos?sslmode=disable\n', { mode: 0o600 });
  const before = readFileSync(missing.secretsFile, 'utf8');
  const refusal = runnerDatabaseIn(missing.home, { env: { NOTICEOS_POSTGRES_SECRETS: profile } });
  assert.equal(refusal.ok, false);
  assert.equal(
    refusal.line,
    `DATABASE_URL is not set in ${missing.secretsFile}: add your NoticeOS database's connection string there (db/postgres/host/README.md sets one up).`,
  );
  assert.equal(readFileSync(missing.secretsFile, 'utf8'), before);
});

test('the Tower child carries the address in its environment, never its arguments', () => {
  const secret = 'postgresql://noticeos_app:never-an-argument@127.0.0.1:5432/noticeos';
  const child = towerChild({ exposeTowerToLan: true, database: { [LOCAL_CONNECTION_VARIABLE]: secret } });
  assert.equal(child.env[LOCAL_CONNECTION_VARIABLE], secret);
  assert.equal(child.args.some((arg) => arg.includes('never-an-argument')), false);
  assert.equal(child.command, process.execPath);
  assert.equal(child.cwd, path.join(REPO_ROOT, 'apps/tower'));
  assert.equal(child.args[0], path.join(child.cwd, 'node_modules/vite/bin/vite.js'));
  assert.deepEqual(child.args.slice(-5), ['--port', String(CONFIG.towerPort), '--strictPort', '--host', CONFIG.towerLanHost]);
});

test('the runner checks its database before it writes a heartbeat or starts a child, and a refusal starts nothing', () => {
  const source = readFileSync(path.join(SCRIPTS, 'os-up.mjs'), 'utf8');
  const supervise = source.slice(source.indexOf('async function supervise('), source.indexOf('// Entry'));
  const at = (needle) => {
    const index = supervise.indexOf(needle);
    assert.notEqual(index, -1, `supervise() no longer has ${needle}`);
    return index;
  };
  const checked = at('const database = await runnerDatabase();');
  assert.ok(at('runtimeCopyRefusal(') < checked, 'after the single-instance and code-folder guards');
  assert.ok(checked < at("status: 'starting',"), 'before the heartbeat says starting');
  assert.ok(checked < at('startChild(c)'), 'before the child starts');
  // The refusal is in the log file before the process ends: the managed
  // service's stdout goes nowhere.
  assert.match(supervise, /if \(!database\.ok\) \{\n\s+log\('ERROR', `REFUSING to start: \$\{database\.line\}`\);\n\s+await closeLog\(\);\n\s+process\.exit\(EXIT_NO_DATABASE\);/u);
  // The address goes to the Tower child and nowhere else in the runner.
  assert.deepEqual([...supervise.matchAll(/database\.env/gu)].length, 1);
  assert.match(supervise, /towerChild\(\{ exposeTowerToLan, database: database\.env \}\)/u);
  assert.equal(EXIT_NO_DATABASE, 5, 'distinct from 2, 3 (already running) and 4 (unlinked code folder)');
});

// ─── The rehearsal ──────────────────────────────────────────────────────────

/** A throwaway Postgres, or null (the test skips) where none can start. */
async function cluster(t) {
  try {
    const started = await startTestCluster();
    t.after(() => started.close());
    return started;
  } catch (error) {
    const reason = unavailableReason(error);
    if (reason === null || postgresRequired()) throw error;
    t.skip(`no Postgres here: ${reason}`);
    return null;
  }
}

/** Two free neighbouring loopback ports, the Tower's and its door's, below
 * every OS's ephemeral range and never the NoticeOS stack's. */
async function freePair() {
  const hold = (port) =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(null));
      server.listen(port, '127.0.0.1', () => resolve(server));
    });
  for (let tries = 0; tries < 50; tries++) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    if (MANAGED_PORTS.includes(port) || MANAGED_PORTS.includes(port + 1)) continue;
    const held = await Promise.all([hold(port), hold(port + 1)]);
    await Promise.all(held.filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))));
    if (held.every(Boolean)) return port;
  }
  throw new Error('no free pair of ports');
}

/** The rehearsal's runner: the runner's own pieces, in the order `supervise`
 * runs them, with the Tower on `REHEARSAL_PORT` and its door on the next. */
const REHEARSAL = `
import { mkdirSync } from 'node:fs';
import { syncDevVarsIfPresent } from ${JSON.stringify(moduleUrl('dev-secrets.mjs'))};
import { killChild, startChild, towerChild } from ${JSON.stringify(moduleUrl('os-up.mjs'))};
import { CONFIG, HOME_ROOT, LOGS_DIR, SECRET_FILES } from ${JSON.stringify(moduleUrl('runner/config.mjs'))};
import { runnerDatabase } from ${JSON.stringify(moduleUrl('runner/database.mjs'))};
import { EXIT_NO_DATABASE, beginShutdown, runtimeCopyRefusal } from ${JSON.stringify(moduleUrl('runner/lifecycle.mjs'))};
import { closeLog, log, openLog } from ${JSON.stringify(moduleUrl('runner/log.mjs'))};
mkdirSync(LOGS_DIR, { recursive: true });
await openLog();
const copyRefusal = await runtimeCopyRefusal({ codeRoot: HOME_ROOT + '/.local/runtime/runtime-a', homeRoot: HOME_ROOT });
if (copyRefusal) throw new Error(copyRefusal);
const database = await runnerDatabase();
if (!database.ok) {
  log('ERROR', \`REFUSING to start: \${database.line}\`);
  await closeLog();
  process.exit(EXIT_NO_DATABASE);
}
await syncDevVarsIfPresent(SECRET_FILES);
const port = Number(process.env.REHEARSAL_PORT);
const tower = towerChild({ config: { ...CONFIG, towerPort: port, ingestPort: port + 1 }, exposeTowerToLan: false, database: database.env });
await startChild(tower);
process.on('SIGTERM', () => {
  beginShutdown();
  killChild(tower, 'SIGTERM');
  tower.proc.once('exit', () => process.exit(0));
  setTimeout(() => (killChild(tower, 'SIGKILL'), process.exit(0)), 8000).unref();
});
`;

/** One rehearsal runner on `home`, its wrangler folders beside it. */
function rehearse(t, { home, port }) {
  const env = {
    ...process.env,
    NOTICEOS_HOME: home,
    NOTICEOS_WORKER_CONFIG_ROOT: home,
    NOTICEOS_INSTALLATION_DIR: path.join(home, 'installation'),
    MINIFLARE_REGISTRY_PATH: path.join(home, '.wrangler', 'registry'),
    XDG_CONFIG_HOME: path.join(home, 'xdg'),
    WRANGLER_LOG_PATH: path.join(home, 'wrangler-logs'),
    REHEARSAL_PORT: String(port),
    CI: '1',
  };
  delete env[LOCAL_CONNECTION_VARIABLE];
  const child = spawn(process.execPath, ['--input-type=module', '-e', REHEARSAL], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const run = { child, output: '' };
  child.stdout.on('data', (chunk) => (run.output += chunk));
  child.stderr.on('data', (chunk) => (run.output += chunk));
  run.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  t.after(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // gone
    }
  });
  return run;
}

/** The settings the rehearsal's store starts with, loaded through its door as
 * `pnpm config:seed` loads them, from the product's defaults. */
async function seed({ home, port, token }) {
  const script = `const { runSeed } = await import(${JSON.stringify(moduleUrl('config-seed.mjs'))});
const answer = await runSeed({ door: 'http://127.0.0.1:${port + 1}', token: process.env.REHEARSAL_TOKEN, repoRoot: ${JSON.stringify(REPO_ROOT)} });
console.log(JSON.stringify({ status: answer.status, refused: answer.body?.refused ?? null }));`;
  const deadline = Date.now() + 90_000;
  let last = null;
  while (Date.now() < deadline) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, NOTICEOS_INSTALLATION_DIR: path.join(home, 'installation'), REHEARSAL_TOKEN: token },
      encoding: 'utf8',
      timeout: 60_000,
    });
    last = run.stdout.trim().split('\n').at(-1) ?? run.stderr;
    try {
      const answer = JSON.parse(last);
      if (answer.status === 200 && answer.refused?.length === 0) return;
    } catch {
      // the ingest is still waking up
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`the rehearsal's settings could not be seeded: ${last}`);
}

test("a runner starts on the home's secrets file names, saves a setting there through the Tower, and never shows the address", { timeout: 420_000 }, async (t) => {
  const pg = await cluster(t);
  if (!pg) return;
  const planted = await plantedDatabase(pg);
  const port = await freePair();
  const token = randomBytes(24).toString('base64url');

  // A home as the stack keeps it: secrets, and the Worker configs
  // beside them. First with no address: the runner refuses and starts nothing.
  const { home, secretsFile } = homeWith(t, { CREDENTIALS_KEY: randomBytes(32).toString('base64'), OPERATOR_TOKEN: token });
  for (const relative of WORKER_CONFIGS) {
    const source = path.join(REPO_ROOT, relative);
    mkdirSync(path.dirname(path.join(home, relative)), { recursive: true });
    writeFileSync(path.join(home, relative), workerConfig(readFileSync(source, 'utf8'), source));
  }
  const refused = rehearse(t, { home, port });
  assert.equal(await refused.exited, EXIT_NO_DATABASE);
  const refusedLog = readFileSync(statePaths(home).logFile, 'utf8').trim().split('\n');
  assert.equal(refusedLog.length, 1, 'one line, and no stack trace');
  assert.match(refusedLog[0], new RegExp(`\\[os-up\\] ERROR REFUSING to start: DATABASE_URL is not set in ${secretsFile.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}: `, 'u'));
  assert.equal(await doorIsHeld(`http://127.0.0.1:${port + 1}`), false, 'no Tower started');

  // With the address beside the other secrets, it comes up on that database.
  writeFileSync(secretsFile, JSON.stringify({ ...JSON.parse(readFileSync(secretsFile, 'utf8')), DATABASE_URL: planted.url }), { mode: 0o600 });
  const runner = rehearse(t, { home, port });
  const deadline = Date.now() + 240_000;
  let exitedEarly = false;
  void runner.exited.then(() => (exitedEarly = true));
  while (!(await doorIsHeld(`http://127.0.0.1:${port + 1}`)) || !(await doorIsHeld(`http://localhost:${port}`))) {
    assert.ok(!exitedEarly && Date.now() < deadline, `the rehearsal's Tower did not come up:\n${runner.output}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await seed({ home, port, token });

  const tower = `http://localhost:${port}/`;
  const { zone, clock } = await saveClockThroughTower(tower);
  assert.deepEqual(clock, { owner: 'config/constants.json', timeZone: zone, chosen: true });
  assert.deepEqual(await storedClock(planted.url), { version: 2, updated_by: 'operator', time_zone: zone });

  if (process.env.NOTICEOS_TEST_ACCESS_TUNNEL === '1') {
    const keysRoot = process.env.NOTICEOS_TEST_SSH_ROOT;
    assert.ok(keysRoot, 'the access proof requires an owned SSH key directory');
    loopbackListeners(port);
    loopbackListeners(port + 1);
    const proof = await proveStandaloneTunnel({
      origin: `http://127.0.0.1:${port}/`, keysRoot,
      work: async forwarded => {
        const page = await fetch(forwarded, { signal: AbortSignal.timeout(10_000) });
        assert.equal(page.status, 200, 'the authenticated tunnel serves the actual Tower page');
        assert.match(await page.text(), /<div id="root">/u);
        const { zone: forwardedZone, clock: forwardedClock } = await saveClockThroughTower(forwarded);
        assert.deepEqual(forwardedClock, { owner: 'config/constants.json', timeZone: forwardedZone, chosen: true });
        assert.equal((await storedClock(planted.url)).time_zone, forwardedZone, 'the tunnel write reached only the disposable store');
      },
    });
    console.log(`standalone-access-proof ${JSON.stringify(proof)}`);
  }

  const tree = processTree(runner.child.pid);
  assert.ok(tree.some((entry) => /workerd/u.test(entry.args)), `the Workers' runtime is among ${tree.length} processes`);
  assert.deepEqual(tree.filter((entry) => entry.args.includes(planted.password)).map((entry) => entry.pid), []);
  assert.deepEqual(await answersHolding(planted.password, tower), []);
  // The heartbeat the runner writes while its child runs.
  const heartbeat = readFileSync(statePaths(home).runnerStateFile, 'utf8');
  assert.match(heartbeat, /"towerPid":\d+/u);
  assert.equal(heartbeat.includes(planted.password), false);
  const ownership = doorOwnershipDecision({ owners: await listListenerOwners(port + 1), group: JSON.parse(heartbeat).towerPid }, { ingestHost: '127.0.0.1', ingestPort: port + 1 });
  assert.equal(ownership.owns, true, ownership.reason);
  assert.match(ownership.reason, /in this runner's process group/u, 'native Vite stays in the supervised child group, without a process-tree fallback');

  runner.child.kill('SIGTERM');
  assert.equal(await runner.exited, 0);

  // Its log (with the child's output, as the runner writes it), the
  // generated `.dev.vars`, its store and wrangler's own log: the address
  // reached wrangler, and none of them repeats its password.
  const state = statePaths(home);
  const log = readFileSync(state.logFile, 'utf8');
  assert.match(log, /\[tower\] .*Found a non-empty CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES variable/u);
  assert.doesNotMatch(readFileSync(state.devVars, 'utf8'), /DATABASE_URL/u);
  assert.equal(`${refused.output}${runner.output}`.includes(planted.password), false);
  assert.deepEqual(filesHolding(planted.password, [home], { except: [secretsFile] }), []);
});
