// `pnpm start`: a new installation in a folder of its own, which never reaches
// the NoticeOS stack's store, installation folder, secrets, logs or ports.
//
// The first tests pin the plan (every path it writes, every variable its Tower
// is told, every refusal) without starting anything. The last one is the
// proof: it boots the real command on a new folder with a tripwire loaded into
// every Node process it starts (itself, pnpm, wrangler, vite) that refuses any
// read or write of the checkout's `installation/`, `.wrangler/` or `.local/`,
// any secrets file outside the new folder, and any connection to the managed
// service's ports, then drives the Tower's lanes, lets its schedule fire and
// checks the checkout is unchanged.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openStore } from '../packages/postgres/src/store.mjs';

import { MANAGED_DOOR, doorFromEnv } from './ingest-door.mjs';
import { installationDir } from './installation.mjs';
import { parseJobRuns } from './job-runs.mjs';
import { LOCAL_CONNECTION_VARIABLE } from './database-address.mjs';
import { ADDRESS_FILE, DEFAULT_PORT as POSTGRES_PORT, SECRETS_DIR_VARIABLE, composeSecretsDir } from './postgres-secrets.mjs';
import { findPostgres } from './postgres-dev.mjs';
import { postgresRequired, startTestCluster, unavailableReason } from './postgres-test-cluster.mjs';
import { answersHolding, filesHolding, plantedDatabase, processTree, saveClockThroughTower, storedClock, storedJobs } from './test-planted-address.mjs';
import { stripJsonc } from './jsonc.mjs';
import { statePaths, workerCrons } from './os-runtime.mjs';
import { CONFIG } from './runner/config.mjs';
import { runCommand } from './run-command.mjs';
import { schedulePaths, startedJobs } from './start-schedule.mjs';
import { databaseEmpty, prepareFreshPostgres, startPostgresPlan } from './start-postgres.mjs';
import { DEVELOPMENT_MARK, developmentRefusal } from './start-development.mjs';
import { main as migrate } from './postgres-apply.mjs';
import { localDocker, localDockerEndpoint } from './postgres-compose.mjs';
import { doltEnvironment, preflightDolt, readDoltProfile, startDoltPlan } from './dolt-host.mjs';
import {
  DEFAULT_DIR,
  FOLDER_MARK,
  MANAGED_PORTS,
  main as startMain,
  parseArgs,
  planRefusal,
  startPlan,
  takeComposeAddress,
  towerEnv,
  workerConfig,
} from './start.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const inside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// ─── The plan ────────────────────────────────────────────────────────────────

test('everything a start keeps is inside its own folder, and none of it is the NoticeOS stack’s', () => {
  const plan = startPlan({ root: REPO_ROOT });
  assert.equal(plan.home, path.join(REPO_ROOT, DEFAULT_DIR));
  const owner = statePaths(REPO_ROOT);
  // What the stack keeps: its store, installation folder, secrets,
  // and its runner state under .local (the start folder is a sibling there).
  const ownerPaths = [
    path.join(REPO_ROOT, '.wrangler'),
    installationDir({ root: REPO_ROOT, env: {} }),
    owner.devSecrets,
    owner.devVars,
    owner.logsDir,
    owner.backupsDir,
    owner.runnerStateFile,
    path.join(REPO_ROOT, '.local', 'runtime'),
  ];
  for (const [name, file] of Object.entries(plan)) {
    if (['root', 'home', 'port', 'doorPort', 'url', 'door', 'configs'].includes(name)) continue;
    assert.ok(inside(file, plan.home), `${name} (${file}) is inside ${plan.home}`);
    for (const ownerPath of ownerPaths) {
      assert.ok(!inside(file, ownerPath) && !inside(ownerPath, file), `${name} (${file}) overlaps ${ownerPath}`);
    }
  }
  for (const { source, target } of plan.configs) {
    assert.ok(inside(target, plan.home));
    assert.ok(inside(source, REPO_ROOT) && !inside(source, plan.home));
  }
  assert.equal(plan.doorPort, plan.port + 1);
  assert.equal(plan.url, `http://127.0.0.1:${plan.port}/`);
});

test('the Tower is told where this installation is, and the shell cannot pick other secrets', () => {
  const plan = startPlan({ root: REPO_ROOT, dir: '/tmp/somewhere', port: 6912 });
  const env = towerEnv(plan, {
    PATH: '/bin',
    REINDEX_OS_INSTALLATION_DIR: '/Users/operator/reindex-os/installation',
    OS_UP_PERSIST_STATE: '/Users/operator/reindex-os/.wrangler/state',
    CLOUDFLARE_ENV: 'production',
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
    BEADS_CREDENTIALS_FILE: '/synthetic/other-hub',
    BEADS_DOLT_PASSWORD: 'synthetic-password',
    BD_DOLT_SERVER_SOCKET: '/synthetic/other.sock',
    DOLT_ROOT_PATH: '/synthetic/other-data',
    MYSQL_PWD: 'synthetic-password',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.NOTICEOS_HOME, plan.home);
  assert.equal(env.NOTICEOS_INSTALLATION_DIR, plan.installation);
  assert.equal(env.NOTICEOS_WORKER_CONFIG_ROOT, plan.home);
  // The inherited pre-rename name is dropped, so nothing can read the owner's installation through it.
  assert.equal('REINDEX_OS_INSTALLATION_DIR' in env, false);
  assert.equal(env.OS_UP_PERSIST_STATE, plan.state);
  assert.equal(env.OS_UP_INGEST_DOOR_HOST, '127.0.0.1');
  assert.equal(env.OS_UP_INGEST_DOOR_PORT, '6913');
  assert.ok(inside(env.MINIFLARE_REGISTRY_PATH, plan.home));
  assert.equal('CLOUDFLARE_ENV' in env, false);
  assert.equal('CLOUDFLARE_INCLUDE_PROCESS_ENV' in env, false);
  assert.equal(Object.keys(env).some(name => /^(?:BD_|BEADS_|DOLT_|MYSQL_)/u.test(name)), false);
});

test('the Tower gets the folder’s database address and no other the shell carries', () => {
  const plan = startPlan({ root: REPO_ROOT, dir: '/tmp/somewhere', port: 6912 });
  const shell = {
    PATH: '/bin',
    [LOCAL_CONNECTION_VARIABLE]: 'postgresql://noticeos_app:shell@127.0.0.1:5432/other',
    WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES: 'postgresql://noticeos_app:older@127.0.0.1:5432/other',
  };
  const without = towerEnv(plan, shell);
  assert.equal(LOCAL_CONNECTION_VARIABLE in without, false);
  assert.equal('WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES' in without, false);
  const own = 'postgresql://noticeos_app:own@127.0.0.1:5432/noticeos';
  const withAddress = towerEnv(plan, shell, { [LOCAL_CONNECTION_VARIABLE]: own });
  assert.equal(withAddress[LOCAL_CONNECTION_VARIABLE], own);
  assert.equal('WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES' in withAddress, false);
});

test('a lane reaches the door and the bearer of the installation its dev server was told about', () => {
  assert.equal(doorFromEnv({}), MANAGED_DOOR);
  assert.equal(doorFromEnv({ OS_UP_INGEST_DOOR_HOST: '127.0.0.1', OS_UP_INGEST_DOOR_PORT: '6913' }), 'http://127.0.0.1:6913');
  assert.equal(doorFromEnv({ OS_UP_INGEST_DOOR_PORT: '6913' }), 'http://127.0.0.1:6913');
  // The secrets file is read from the home the process was given, which is how
  // the config lane inside a started Tower authenticates to its own store.
  const home = path.join(os.tmpdir(), 'a-start-folder');
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { DEFAULT_DEV_SECRETS, DEFAULT_DEV_VARS } from './scripts/dev-secrets.mjs'; process.stdout.write(JSON.stringify([DEFAULT_DEV_SECRETS, DEFAULT_DEV_VARS]));"], {
    cwd: REPO_ROOT,
    env: { ...process.env, NOTICEOS_HOME: home },
    encoding: 'utf8',
  });
  assert.deepEqual(JSON.parse(probe.stdout), [
    path.join(home, 'workers', 'ingest', '.dev.secrets.json'),
    path.join(home, 'workers', 'ingest', '.dev.vars'),
  ]);
});

test('the NoticeOS stack’s ports are the runner’s own port map', () => {
  assert.deepEqual([...MANAGED_PORTS].sort(), [CONFIG.towerPort, CONFIG.ingestPort, CONFIG.beadsHubPort, POSTGRES_PORT].sort());
});

test('a start refuses, in one line, a stack port, the checkout, or a folder it did not make', (t) => {
  const root = tempDir(t, 'start-root-');
  const refusal = (options, fsView) => planRefusal(startPlan({ root, ...options }), fsView);
  for (const port of [5173, 8790, 8791, 3307, 3308, 5431, 5432]) {
    assert.match(refusal({ port }), /belongs to the NoticeOS stack/);
  }
  assert.match(refusal({ port: 80 }), /1024 to 65534/);
  assert.match(refusal({ port: 65535 }), /1024 to 65534/);
  assert.match(refusal({ dir: '.' }), /holds this checkout/);
  assert.match(refusal({ dir: '..' }), /holds this checkout/);

  const unmarked = path.join(root, 'someone-elses');
  mkdirSync(unmarked);
  writeFileSync(path.join(unmarked, 'notes.txt'), 'mine\n');
  assert.match(refusal({ dir: unmarked }), /did not make/);
  writeFileSync(path.join(unmarked, FOLDER_MARK), '');
  assert.equal(refusal({ dir: unmarked }), null);

  const empty = path.join(root, 'empty');
  mkdirSync(empty);
  assert.equal(refusal({ dir: empty }), null);
  assert.equal(refusal({ dir: path.join(root, 'not-yet') }), null);
  for (const line of [refusal({ port: 5173 }), refusal({ dir: '.' }), refusal({ dir: unmarked, port: 3308 })]) {
    assert.equal(line.split('\n').length, 1);
  }
});

test('its Worker configs are the checkout’s, with every path made absolute', () => {
  for (const relative of ['apps/tower/wrangler.jsonc', 'workers/ingest/wrangler.jsonc']) {
    const source = path.join(REPO_ROOT, relative);
    const text = readFileSync(source, 'utf8');
    const generated = JSON.parse(stripJsonc(workerConfig(text, source)));
    const original = JSON.parse(stripJsonc(text));
    assert.equal(generated.name, original.name);
    assert.equal('$schema' in generated, false);
    assert.equal(generated.main, path.resolve(path.dirname(source), original.main));
    assert.ok(existsSync(generated.main));
    assert.equal(generated.d1_databases, undefined);
    assert.deepEqual(generated.hyperdrive, original.hyperdrive);
  }
});

test('startup has no migration flag; existing Postgres changes use the operator command', () => {
  assert.throws(() => parseArgs(['--migrate']), /unknown option --migrate/);
});

// ─── The database address, taken once from the Compose profile ──────────────
//
// A new installation's first `pnpm start` takes DATABASE_URL from the one line
// `pnpm db:create-secrets` wrote, so no password is copied by hand. Each address
// here carries a planted, recognizable password, and no answer may repeat it.

/** A throwaway checkout, the Compose profile's `database.url` in it holding
 * `address` (none when undefined), and a start folder whose secrets file holds
 * `bindings`. */
function composeCheckout(t, { address, bindings = { CREDENTIALS_KEY: 'k', OPERATOR_TOKEN: 't' } } = {}) {
  const root = tempDir(t, 'start-compose-');
  const plan = startPlan({ root, dir: path.join(root, 'installation-under-test') });
  mkdirSync(path.dirname(plan.secrets), { recursive: true });
  writeFileSync(plan.secrets, `${JSON.stringify(bindings, null, 2)}\n`, { mode: 0o600 });
  const source = path.join(composeSecretsDir({}, root), ADDRESS_FILE);
  if (address !== undefined) {
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, `${address}\n`, { mode: 0o600 });
  }
  return { plan, source };
}

/** An address as `pnpm db:create-secrets` writes one, with a planted password. */
function plantedAddress() {
  const password = `planted-${randomBytes(9).toString('hex')}`;
  return { password, url: `postgresql://noticeos_app:${password}@127.0.0.1:5432/noticeos?sslmode=disable` };
}

test('a folder with no database address takes the Compose profile’s once, and keeps its other secrets', async (t) => {
  for (const bindings of [{ CREDENTIALS_KEY: 'k', OPERATOR_TOKEN: 't' }, { CREDENTIALS_KEY: 'k', OPERATOR_TOKEN: 't', DATABASE_URL: '  ' }]) {
    const planted = plantedAddress();
    const { plan, source } = composeCheckout(t, { address: planted.url, bindings });
    assert.deepEqual(await takeComposeAddress(plan, { env: {} }), { ok: true, took: source });
    assert.deepEqual(JSON.parse(readFileSync(plan.secrets, 'utf8')), { CREDENTIALS_KEY: 'k', OPERATOR_TOKEN: 't', DATABASE_URL: planted.url });
    assert.equal(statSync(plan.secrets).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(path.dirname(plan.secrets)), ['.dev.secrets.json'], 'nothing is left beside it');

    // Once: an address the folder holds is never replaced, whatever the profile holds now.
    const before = readFileSync(plan.secrets, 'utf8');
    writeFileSync(source, `${plantedAddress().url}\n`);
    assert.deepEqual(await takeComposeAddress(plan, { env: {} }), { ok: true, took: null });
    assert.equal(readFileSync(plan.secrets, 'utf8'), before);
  }
});

test('the profile’s folder is the one compose.yaml reads: NOTICEOS_POSTGRES_SECRETS beside compose.yaml, or secrets', (t) => {
  const root = tempDir(t, 'start-compose-dir-');
  const profile = path.join(root, 'db', 'postgres', 'host');
  assert.equal(composeSecretsDir({}, root), path.join(profile, 'secrets'));
  assert.equal(composeSecretsDir({ [SECRETS_DIR_VARIABLE]: 'elsewhere' }, root), path.join(profile, 'elsewhere'));
  assert.equal(composeSecretsDir({ [SECRETS_DIR_VARIABLE]: path.join(root, 'kept') }, root), path.join(root, 'kept'));
  // compose.yaml's own default is the same folder (scripts/postgres-host-profile.test.mjs holds its lines).
  assert.match(readFileSync(path.join(REPO_ROOT, 'db', 'postgres', 'host', 'compose.yaml'), 'utf8'), /\$\{NOTICEOS_POSTGRES_SECRETS:-\.\/secrets\}/u);
});

test('without the profile’s address a start refuses in one sentence naming the command to run first, and no refusal repeats an address', async (t) => {
  const missing = composeCheckout(t);
  const before = readFileSync(missing.plan.secrets, 'utf8');
  assert.deepEqual(await takeComposeAddress(missing.plan, { env: {} }), {
    ok: false,
    line: `DATABASE_URL is not set in ${missing.plan.secrets} and ${missing.source} does not exist yet: run pnpm db:create-secrets first (db/postgres/host/README.md sets the database up).`,
  });
  assert.equal(readFileSync(missing.plan.secrets, 'utf8'), before);

  const planted = plantedAddress();
  for (const text of ['', `not-an-address-${planted.password}`, `postgresql://noticeos_app@127.0.0.1:5432/${planted.password}`, `mysql://noticeos_app:${planted.password}@127.0.0.1/noticeos`]) {
    const bad = composeCheckout(t, { address: text });
    const answer = await takeComposeAddress(bad.plan, { env: {} });
    assert.equal(answer.ok, false, text);
    assert.equal(answer.line.split('\n').length, 1);
    assert.equal(answer.line.includes(planted.password), false, answer.line);
    assert.equal(JSON.parse(readFileSync(bad.plan.secrets, 'utf8')).DATABASE_URL, undefined);
  }
});

// ─── The proof: a real start, with a tripwire on the checkout ────────────────

const VIOLATION = 'START_ISOLATION_VIOLATION';
const ARMED = 'START_TRIPWIRE_ARMED';

/** Loaded into every Node process the start runs (NODE_OPTIONS). Plain source,
 * written beside the test's folder, so it carries no import of this checkout. */
const TRIPWIRE = `
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = process.env.START_TRIPWIRE_ROOT;
const home = process.env.START_TRIPWIRE_HOME;
const owner = ['installation', '.wrangler', '.local', 'db/postgres/host/secrets'].map((name) => path.join(root, name));
if (process.env.START_TRIPWIRE_COMPOSE) owner.push(process.env.START_TRIPWIRE_COMPOSE);
const ports = [5173, 8791, 3308, 5432];
const within = (file, dir) => file === dir || file.startsWith(dir + path.sep);
const text = (target) => {
  try {
    if (target instanceof URL) return fileURLToPath(target);
    if (typeof target === 'string') return target;
    if (Buffer.isBuffer(target)) return target.toString('utf8');
  } catch {}
  return null;
};
const report = (kind, target) => process.stderr.write('${VIOLATION} ' + JSON.stringify({ kind, target: String(target), pid: process.pid }) + '\\n');
const refused = (target) => {
  const raw = text(target);
  if (raw === null) return false;
  const file = path.resolve(raw);
  if (within(file, home)) return false;
  if (owner.some((dir) => within(file, dir))) return true;
  return ['.dev.vars', '.dev.secrets.json'].includes(path.basename(file));
};
for (const name of ['readFileSync', 'openSync', 'createReadStream', 'readdirSync', 'readFile', 'open', 'readdir']) {
  const original = fs[name];
  fs[name] = function (target, ...rest) {
    if (refused(target)) {
      report('read', target);
      throw new Error('refused by the start tripwire: ' + String(target));
    }
    return original.call(this, target, ...rest);
  };
}
for (const name of ['readFile', 'open', 'readdir']) {
  const original = fs.promises[name];
  fs.promises[name] = async function (target, ...rest) {
    if (refused(target)) {
      report('read', target);
      throw new Error('refused by the start tripwire: ' + String(target));
    }
    return original.call(this, target, ...rest);
  };
}
const writing = (rest) => (name) => name === 'renameSync' || name === 'rename' ? [rest[0]] : [];
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync']) {
  const original = fs[name];
  fs[name] = function (target, ...rest) {
    const hit = [target, ...writing(rest)(name)].find(refused);
    if (hit !== undefined) {
      report('write', hit);
      throw new Error('refused by the start tripwire: ' + String(hit));
    }
    return original.call(this, target, ...rest);
  };
}
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rename']) {
  const original = fs.promises[name];
  fs.promises[name] = async function (target, ...rest) {
    const hit = [target, ...writing(rest)(name)].find(refused);
    if (hit !== undefined) {
      report('write', hit);
      throw new Error('refused by the start tripwire: ' + String(hit));
    }
    return original.call(this, target, ...rest);
  };
}
syncBuiltinESMExports();
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const port = Number(typeof first === 'object' && first !== null ? first.port : first);
  if (ports.includes(port)) {
    report('connect', port);
    process.nextTick(() => this.destroy(new Error('refused by the start tripwire: port ' + port)));
    return this;
  }
  return connect.apply(this, args);
};
process.stderr.write('${ARMED} ' + path.basename(process.argv[1] ?? 'node') + '\\n');
`;

/** A tripwire that never fires proves nothing: it must refuse the reads and
 * connections it is there for, in a process of its own. */
test('the tripwire refuses the checkout’s installation folder, its runner state, other secrets and the managed ports', (t) => {
  const dir = tempDir(t, 'start-tripwire-');
  const tripwire = path.join(dir, 'tripwire.mjs');
  writeFileSync(tripwire, TRIPWIRE);
  const probe = `
    import fs from 'node:fs';
    import net from 'node:net';
    for (const file of ${JSON.stringify([path.join(REPO_ROOT, 'installation', 'pull.json'), path.join(REPO_ROOT, 'db', 'postgres', 'host', 'secrets', 'database.url'), path.join(dir, 'elsewhere', '.dev.vars')])}) {
      try { fs.readFileSync(file); } catch {}
    }
    // A parent that does not exist: nothing is written even if the tripwire missed it.
    try { fs.appendFileSync(${JSON.stringify(path.join(REPO_ROOT, '.local', 'tripwire-probe', 'job-runs.jsonl'))}, ''); } catch {}
    await fs.promises.writeFile(${JSON.stringify(path.join(REPO_ROOT, '.local', 'tripwire-probe', 'scheduled-jobs.json'))}, '').catch(() => {});
    const socket = net.connect({ host: '127.0.0.1', port: 8791 });
    socket.on('error', () => {});
    socket.on('close', () => process.exit(0));
  `;
  const run = spawnSync(process.execPath, ['--import', tripwire, '--input-type=module', '-e', probe], {
    env: { ...process.env, START_TRIPWIRE_ROOT: REPO_ROOT, START_TRIPWIRE_HOME: path.join(dir, 'home') },
    encoding: 'utf8',
  });
  const fired = run.stderr.split('\n').filter((line) => line.startsWith(VIOLATION)).map((line) => JSON.parse(line.slice(VIOLATION.length + 1)));
  assert.deepEqual(fired.map(({ kind, target }) => [kind, target]), [
    ['read', path.join(REPO_ROOT, 'installation', 'pull.json')],
    ['read', path.join(REPO_ROOT, 'db', 'postgres', 'host', 'secrets', 'database.url')],
    ['read', path.join(dir, 'elsewhere', '.dev.vars')],
    ['write', path.join(REPO_ROOT, '.local', 'tripwire-probe', 'job-runs.jsonl')],
    ['write', path.join(REPO_ROOT, '.local', 'tripwire-probe', 'scheduled-jobs.json')],
    ['connect', '8791'],
  ]);
  assert.match(run.stderr, new RegExp(`^${ARMED} `, 'm'));
});

/**
 * Where the start under test takes its two ports: below every OS's ephemeral
 * range (Linux from 32768, macOS from 49152). The OS hands ephemeral ports out
 * in sequence to anything that binds port 0 or opens a connection, so a pair
 * taken from that range could go to another process before the start binds
 * it, and on macOS a busy host can leave the counter where every port it
 * offers is too high to have a neighbour. Down here only a process asking for
 * that exact port can take one.
 */
const PAIR_RANGE = Object.freeze({ from: 20_000, to: 32_000 });

/** A server holding `port` on loopback, or null when something else has it. */
function hold(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** Two free neighbouring ports — the Tower's, then its ingest door's — proved
 * free by binding both, outside the NoticeOS stack's. */
async function freePair() {
  for (let tries = 0; tries < 50; tries++) {
    const port = PAIR_RANGE.from + Math.floor(Math.random() * (PAIR_RANGE.to - PAIR_RANGE.from));
    if (MANAGED_PORTS.includes(port) || MANAGED_PORTS.includes(port + 1)) continue;
    const held = await Promise.all([hold(port), hold(port + 1)]);
    await Promise.all(held.filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))));
    if (held.every(Boolean)) return port;
  }
  throw new Error(`no free pair of ports between ${PAIR_RANGE.from} and ${PAIR_RANGE.to}`);
}

/**
 * The checkout's installation folder and secrets files, with sizes and times,
 * and whether it has a store at all. `.wrangler/state` itself is not listed:
 * where the stack runs, it changes every minute on its own. The
 * tripwire covers reads of it; a start's own store is proved to be in its folder.
 */
async function get(url, { timeoutMs = 180_000 } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  return { status: response.status, text };
}

/**
 * A throwaway Postgres for one real start, and in it a copy of the store whose
 * application login has a planted password (scripts/test-planted-address.mjs).
 * Null, naming why, where no Postgres can start here; NOTICEOS_REQUIRE_POSTGRES=1
 * (CI) makes that a failure instead.
 */
async function startStore(t) {
  let cluster;
  try {
    cluster = await startTestCluster();
  } catch (error) {
    const reason = unavailableReason(error);
    if (reason === null || postgresRequired()) throw error;
    return { unavailable: reason };
  }
  t.after(() => cluster.close());
  return plantedDatabase(cluster);
}

/** One run of the real command on `home`, with the tripwire loaded into every
 * Node process it starts, wrangler's own log kept beside the folder, and the
 * Compose profile's secrets in `composeSecrets`, never the checkout's. */
function runStart(t, { home, port, tripwire, composeSecrets }) {
  const env = {
    ...process.env,
    [SECRETS_DIR_VARIABLE]: composeSecrets,
    NODE_OPTIONS: `--import ${tripwire}`,
    START_TRIPWIRE_ROOT: REPO_ROOT,
    START_TRIPWIRE_HOME: home,
    WRANGLER_LOG_PATH: path.join(path.dirname(home), 'wrangler-logs'),
    CI: '1',
  };
  for (const name of Object.keys(env)) {
    if (/^(?:PG|CLOUDFLARE_|CF_|OS_UP_|NOTICEOS_|BD_|BEADS_|DOLT_|MYSQL_)/u.test(name) || ['DATABASE_URL', 'OPERATOR_TOKEN', 'CREDENTIALS_KEY', 'ASSET_TOKENS'].includes(name)) delete env[name];
  }
  if (composeSecrets !== undefined) env[SECRETS_DIR_VARIABLE] = composeSecrets;
  // The address reaches the Workers only from the folder's own secrets file.
  delete env[LOCAL_CONNECTION_VARIABLE];
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts', 'start.mjs'), '--dir', home, '--port', String(port), '--no-open'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
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

test('a real start makes its own store and Tower on the Postgres its folder names, never reaches the checkout’s, and never shows the address', { timeout: 600_000 }, async (t) => {
  const postgres = await startStore(t);
  if (postgres.unavailable) return t.skip(`no Postgres here: ${postgres.unavailable}`);
  const home = path.join(tempDir(t, 'start-live-'), 'installation-under-test');
  const tripwire = path.join(path.dirname(home), 'tripwire.mjs');
  writeFileSync(tripwire, TRIPWIRE);
  const port = await freePair();
  const plan = startPlan({ root: REPO_ROOT, dir: home, port });
  // The Compose profile's secrets folder (`pnpm db:create-secrets --dir`), a
  // throwaway beside the folder: the tripwire refuses the checkout's own.
  const composeSecrets = path.join(path.dirname(home), 'compose-secrets');
  mkdirSync(composeSecrets, { mode: 0o700 });
  const composeFile = path.join(composeSecrets, ADDRESS_FILE);

  // No database is set up yet: the first start makes the folder and its
  // secrets file, then stops in one sentence naming the command to run first.
  const first = runStart(t, { home, port, tripwire, composeSecrets });
  assert.equal(await first.exited, 1);
  const refusal = first.output.split('\n').filter((line) => line.startsWith('pnpm start: '));
  assert.deepEqual(refusal, [
    `pnpm start: DATABASE_URL is not set in ${plan.secrets} and ${composeFile} does not exist yet: run pnpm db:create-secrets first (db/postgres/host/README.md sets the database up).`,
  ]);
  assert.doesNotMatch(first.output, /\n\s+at /u, 'no stack trace');
  assert.equal(existsSync(plan.lock), false);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(plan.secrets, 'utf8'))).sort(), ['CREDENTIALS_KEY', 'OPERATOR_TOKEN']);

  // `pnpm db:create-secrets` writes the application's address as one line; the
  // next start takes it by itself, with no hand copy.
  writeFileSync(composeFile, `${postgres.url}\n`, { mode: 0o600 });

  const second = runStart(t, { home, port, tripwire, composeSecrets });
  const { child, exited } = second;

  const running = await Promise.race([
    new Promise((resolve) => {
      const timer = setInterval(() => {
        if (second.output.includes('NoticeOS is running')) (clearInterval(timer), resolve(true));
      }, 250);
      exited.then(() => (clearInterval(timer), resolve(false)));
    }),
    new Promise((resolve) => setTimeout(resolve, 420_000, false).unref()),
  ]);
  assert.ok(running, `pnpm start did not come up:\n${second.output}`);

  // One address, and it is this start's.
  const urls = second.output.match(/https?:\/\/[^\s]+/g) ?? [];
  assert.deepEqual(urls, [`http://127.0.0.1:${port}/`]);
  // The start says where it took the address from, never the address.
  assert.ok(second.output.includes(`Took DATABASE_URL from ${composeFile} into ${plan.secrets}.`), second.output);
  const secrets = JSON.parse(readFileSync(plan.secrets, 'utf8'));
  assert.deepEqual(Object.keys(secrets).sort(), ['CREDENTIALS_KEY', 'DATABASE_URL', 'OPERATOR_TOKEN']);
  assert.equal(secrets.DATABASE_URL, postgres.url);
  assert.equal(statSync(plan.secrets).mode & 0o777, 0o600);

  // A setting saved through the Tower lands in the Postgres the folder names.
  const tower = `http://127.0.0.1:${port}/`;
  const { zone, clock } = await saveClockThroughTower(tower);
  assert.deepEqual(clock, { owner: 'config/constants.json', timeZone: zone, chosen: true });
  assert.deepEqual(await storedClock(postgres.url), { version: 2, updated_by: 'operator', time_zone: zone });

  // The address rides in the dev server's environment only: no process this
  // start runs carries it in its arguments, and no answer of its Tower holds it.
  const tree = processTree(child.pid);
  assert.ok(tree.some((entry) => /workerd/u.test(entry.args)), `the Workers' runtime is among ${tree.length} processes`);
  assert.deepEqual(tree.filter((entry) => entry.args.includes(postgres.password)).map((entry) => entry.pid), []);
  assert.deepEqual(await answersHolding(postgres.password, tower), []);

  // Home, and the lanes that reach the store from the dev server's own process.
  const homePage = await get(`http://127.0.0.1:${port}/`);
  assert.equal(homePage.status, 200);
  assert.match(homePage.text, /<div id="root">/);
  const config = await get(`http://127.0.0.1:${port}/api/config`);
  assert.equal(config.status, 200);
  assert.deepEqual(JSON.parse(config.text).store, { ready: true, reason: null });
  const schedules = await get(`http://127.0.0.1:${port}/api/scheduled-jobs`);
  assert.equal(schedules.status, 200);
  const wall = await get(`http://127.0.0.1:${port}/api/wall`);
  assert.equal(wall.status, 200);
  assert.deepEqual(JSON.parse(wall.text).assets, [], 'a new installation has no sites');

  // Its schedule: the ingest's crons, fired at this start's door the moment it
  // came up (each lane's latest missed obligation, once) and shown on its
  // Workflows.
  const crons = workerCrons(readFileSync(path.join(REPO_ROOT, 'workers', 'ingest', 'wrangler.jsonc'), 'utf8'));
  const jobs = startedJobs(crons);
  let workflows = null;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    workflows = JSON.parse((await get(`http://127.0.0.1:${port}/api/workflows`)).text);
    // A run's steps land just after its record line, so wait for both.
    if (workflows.runtimeFresh && jobs.every((job) => workflows.workflows.find((w) => w.id === job.id)?.latest?.steps)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.equal(workflows.runtimeFresh, true, 'its scheduler reports');
  assert.equal(workflows.runtime.hostLanes, false, 'with no host lanes');
  assert.deepEqual(workflows.runtime.jobs.map((job) => job.id).sort(), jobs.map((job) => job.id).sort());
  for (const job of jobs) {
    const latest = workflows.workflows.find((w) => w.id === job.id)?.latest;
    assert.ok(latest, `${job.label} has a recorded run`);
    // The steps are the ingest dispatch's own, so the fire reached this start's
    // ingest.
    assert.equal(latest.steps?.[0]?.id, 'config', `${job.label} reached the ingest: ${JSON.stringify(latest)}`);
    // …and nothing fails on a new installation: a source nobody connected is
    // skipped, so System health has nothing to call a failure.
    assert.notEqual(latest.state, 'failed', `${job.label} failed on a new installation: ${JSON.stringify(latest.steps)}`);
  }

  // The operator command reads this synthetic Postgres through the actual
  // ingest Worker. The same tripwire guards its token lookup and door request.
  const sample = openStore(postgres.url, { maxConnections: 1 });
  const arrivals = [4, 2].map((days) => new Date(Date.now() - days * 86_400_000).toISOString());
  const marker = 'capacity-cli-stored-value';
  try {
    const workspace = await sample.onlyWorkspace();
    await sample.inWorkspace(workspace, (tx) => tx.execute(
      `INSERT INTO noticeos.egress_checks (workspace_id, observed_at, up, detail)
       SELECT $1::uuid, stamp, true, $3::jsonb FROM unnest($2::timestamptz[]) AS stamp`,
      [workspace, arrivals, JSON.stringify({ note: marker })],
    ));
  } finally {
    await sample.close();
  }
  const capacity = await runCommand(process.execPath, ['scripts/os-capacity.mjs', '--json'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NOTICEOS_HOME: home,
      OS_UP_INGEST_DOOR_HOST: '127.0.0.1',
      OS_UP_INGEST_DOOR_PORT: String(plan.doorPort),
      NODE_OPTIONS: `--import ${tripwire}`,
      START_TRIPWIRE_ROOT: REPO_ROOT,
      START_TRIPWIRE_HOME: home,
    },
    timeoutMs: 30_000,
  });
  assert.equal(capacity.code, 0, capacity.stderr);
  const inventory = JSON.parse(capacity.stdout.slice(capacity.stdout.indexOf('{')));
  const catalog = JSON.parse(readFileSync(path.join(REPO_ROOT, 'db', 'postgres', 'tables.json'), 'utf8')).tables;
  assert.deepEqual(inventory.tables.map((table) => table.name).sort(), Object.keys(catalog).sort());
  assert.deepEqual(inventory.store.missingTables, []);
  const egress = inventory.tables.find((table) => table.name === 'egress_checks');
  assert.ok(egress.rows >= 2 && egress.valueBytes > 0 && egress.relationBytes > 0);
  assert.equal(egress.arrival, 'observed_at');
  assert.ok(egress.rowsLongWindow >= 2 && egress.rowsPerDay > 0 && egress.bytesPerDay > 0);
  assert.ok(inventory.store.bytes > 0 && inventory.store.historyRowsPerDay > 0);
  assert.equal(inventory.tables.find((table) => table.name === 'signal_observations').arrival, 'finished_at');
  assert.equal(capacity.stdout.includes(marker), false, 'capacity returns metadata only');
  assert.equal(`${capacity.stdout}\n${capacity.stderr}`.includes(postgres.password), false);

  process.kill(child.pid, 'SIGINT');
  assert.equal(await exited, 0);

  // The record is in this start's folder, and every firing reached this
  // start's store — the Postgres copy its folder names, through its own door,
  // never the checkout's.
  const records = parseJobRuns(readFileSync(schedulePaths(home).jobRuns, 'utf8'));
  assert.deepEqual([...new Set(records.map((record) => record.job))].sort(), crons.map((cron) => `cron ${cron}`).sort());
  assert.deepEqual((await storedJobs(postgres.url)).sort(), crons.map((cron) => `cron ${cron}`).sort(), 'every firing reached its store');

  const log = readFileSync(path.join(home, '.local', 'logs', 'start.log'), 'utf8');
  const output = `${first.output}\n${second.output}`;
  const violations = `${output}\n${log}`.split('\n').filter((line) => line.includes(VIOLATION));
  assert.deepEqual(violations, [], 'nothing reached the checkout’s store, installation, secrets or ports');
  // The address reached wrangler, and nothing either start wrote or printed
  // repeats its password: not the log, the heartbeat, the schedule's record,
  // the saved settings, the generated `.dev.vars`, the store, wrangler's log.
  // It is in two files only: the profile's, and the folder's secrets file.
  assert.match(log, /Found a non-empty CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES variable/u);
  assert.equal(output.includes(postgres.password), false);
  assert.deepEqual(filesHolding(postgres.password, [path.dirname(home)], { except: [plan.secrets, composeFile] }), []);
  assert.ok(existsSync(plan.devVars) && existsSync(path.join(path.dirname(home), 'wrangler-logs')), 'the scan covered the generated bindings and wrangler’s log');
  // …with the tripwire loaded in the command and the dev server that ran
  // the Tower and its lanes.
  assert.match(output, new RegExp(`^${ARMED} start\\.mjs$`, 'm'));
  assert.match(log, new RegExp(`^${ARMED} vite\\.js$`, 'm'));
  assert.equal(existsSync(path.join(home, '.local', 'start.pid')), false, 'the lock is released');
  // The preload above refuses every owner-path read/write in the actual
  // startup children. Do not inspect those private paths from the test either.
});

// This container-app proof is explicitly enabled by the completing agent and
// independent verifier. The ordinary CI root suite also retains the native-PG
// real-start proof above; it does not require every test host to have Docker.
const FIRST_START_COMPOSE = process.env.NOTICEOS_TEST_FIRST_START_COMPOSE === '1';

async function composeTest(t) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'first-start-compose-'));
  let port;
  for (let candidate = 5450; candidate <= 5496; candidate += 4) {
    const held = await Promise.all([hold(candidate), hold(candidate + 1), hold(candidate + 2), hold(candidate + 3)]);
    await Promise.all(held.filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
    if (held.every(Boolean)) { port = candidate; break; }
  }
  assert.ok(port, 'a disposable four-port block in 5450–5499 is free');
  const home = path.join(base, 'installation-under-test');
  const plan = startPlan({ root: REPO_ROOT, dir: home, port });
  const own = startPostgresPlan(plan);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(?:PG|NOTICEOS_|OS_UP_|CLOUDFLARE_|CF_|BD_|BEADS_|DOLT_|MYSQL_)/u.test(name) || ['DATABASE_URL', 'NODE_OPTIONS', 'OPERATOR_TOKEN', 'CREDENTIALS_KEY', 'ASSET_TOKENS'].includes(name)) delete env[name];
  env[SECRETS_DIR_VARIABLE] = own.secrets;
  env.NOTICEOS_POSTGRES_PORT = String(own.port);
  // Even cleanup is a resource request: prove the selected endpoint is local
  // before registering any action against this disposable project.
  const endpoint = await localDockerEndpoint(runCommand, { cwd: REPO_ROOT, env });
  assert.ok(endpoint, 'the disposable Compose target is local');
  delete env.DOCKER_CONTEXT;
  env.DOCKER_HOST = endpoint;
  assert.equal((await preflightDolt(plan, { env })).ok, true, 'this task service and volume are provably absent before cleanup is registered');
  const compose = args => runCommand('docker', ['compose', '-p', own.project, '-f', own.compose, '--env-file', os.devNull, ...args], { cwd: REPO_ROOT, env, timeoutMs: 120_000 });
  t.after(async () => {
    const taskProfile = startDoltPlan(plan);
    const down = await runCommand('docker', ['compose', '-p', own.project, '-f', own.compose, '-f', taskProfile.composeFile, '--env-file', os.devNull, 'down', '--volumes'], {
      cwd: REPO_ROOT, env: { ...env, ...doltEnvironment(taskProfile, env) }, timeoutMs: 120_000,
    });
    assert.equal(down.code, 0, 'only this declared disposable Postgres and Dolt project is removed');
    rmSync(base, { recursive: true, force: true });
  });
  const tripwire = path.join(base, 'tripwire.mjs');
  writeFileSync(tripwire, TRIPWIRE);
  return { base, home, plan, own, env, compose, tripwire };
}

function started(run) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 240_000);
    const check = () => {
      if (run.output.includes('NoticeOS is running')) { clearTimeout(timer); resolve(true); }
    };
    run.child.stdout.on('data', check);
    run.exited.then(() => { clearTimeout(timer); resolve(false); });
    check();
  });
}

test('one pnpm start prepares isolated Postgres and a core task hub, onboards a site and receives its first report without exposing secrets', { skip: !FIRST_START_COMPOSE, timeout: 480_000 }, async t => {
  const { base, home, plan, own, compose, tripwire } = await composeTest(t);
  const run = runStart(t, { home, port: plan.port, tripwire });
  assert.equal(await started(run), true, 'the one startup command reaches a healthy Tower');
  const bindings = JSON.parse(readFileSync(plan.secrets, 'utf8'));
  assert.equal(statSync(plan.secrets).mode & 0o777, 0o600);
  assert.equal(Number(new URL(bindings.DATABASE_URL).port), own.port);
  assert.equal(JSON.parse(readFileSync(path.join(home, 'postgres', 'profile.json'), 'utf8')).project, own.project);
  const store = openStore(bindings.DATABASE_URL, { maxConnections: 1 });
  try {
    const workspace = await store.onlyWorkspace();
    const rows = await store.inWorkspace(workspace, tx => tx.query('SELECT count(*)::int AS applied FROM noticeos_migrations.applied'), { readOnly: true });
    assert.equal(rows[0].applied, readdirSync(path.join(REPO_ROOT, 'db', 'postgres', 'migrations')).filter(name => name.endsWith('.sql')).length);
    const assets = await store.inWorkspace(workspace, tx => tx.query('SELECT asset_id, is_os, domain, display_name FROM noticeos.assets'), { readOnly: true });
    assert.equal(assets.length, 1);
    assert.equal(assets[0].is_os, true);
    assert.equal(assets[0].domain, null);
    assert.equal(assets[0].display_name, 'NoticeOS');
  } finally { await store.close(); }
  assert.equal((await get(plan.url)).status, 200);
  assert.deepEqual(JSON.parse((await get(`${plan.url}api/config`)).text).store, { ready: true, reason: null });
  const profile = readDoltProfile(home);
  assert.equal(profile.port, plan.port + 3);
  assert.equal(profile.project, own.project);
  const saved = JSON.parse(readFileSync(path.join(plan.installation, 'beads.json'), 'utf8'));
  assert.equal(saved.spokes.length, 1);
  const core = saved.spokes[0];
  assert.match(core.asset, /^os-[0-9a-f]{16}$/u);
  const source = JSON.parse((await get(`${plan.url}api/task-source`)).text);
  assert.equal(source.connected, 'beads', 'the initial own-project poll reaches the saved snapshot');
  assert.equal(source.sources.find(row => row.id === 'beads')?.failing, 0);
  const work = JSON.parse((await get(`${plan.url}api/work`)).text);
  assert.equal(work.projects.length, 1);
  assert.equal(work.projects[0].name, 'NoticeOS');
  assert.equal(work.projects[0].ok, true);
  assert.deepEqual(JSON.parse((await get(`${plan.url}api/wall`)).text).assets, [], 'the core OS is not a portfolio site');
  const action = async (route, body) => {
    const response = await fetch(`${plan.url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(plan.url).origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const json = await response.json();
    return { status: response.status, body: json };
  };
  const created = await action('api/tasks', { project: core.asset, title: 'Synthetic first-run task', type: 'task', priority: 2 });
  assert.equal(created.status, 201, 'a task is created through the real Tower action lane');
  assert.match(created.body.id, /^no-/u);
  const detail = JSON.parse((await get(`${plan.url}api/tasks/${created.body.id}`)).text);
  assert.equal(detail.task.title, 'Synthetic first-run task');
  assert.equal((await action(`api/tasks/${created.body.id}/close`, { reason: 'Synthetic completion proof' })).status, 200);
  const complete = JSON.parse((await get(`${plan.url}api/tasks/${created.body.id}`)).text);
  assert.equal(complete.task.status, 'closed');
  const saveConfig = async ops => {
    const response = await fetch(`${plan.url}api/config`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: new URL(plan.url).origin }, body: JSON.stringify({ ops }), signal: AbortSignal.timeout(60_000) });
    return response.status;
  };
  // The same writes as Add a site: the real Tower/ingest action creates the
  // row, then the guarded setup Save adds its source and panel declarations.
  // No direct SQL insertion can make a broken onboarding route pass.
  const site = 'example.com';
  const added = await action('api/assets', { id: site, domain: site, displayName: 'Example', status: 'onboarding', senseOnly: 1 });
  assert.equal(added.status, 201, 'the first website is added through the supported product action');
  assert.equal(added.body.asset.id, site);
  const settings = JSON.parse((await get(`${plan.url}api/settings`)).text);
  const since = new Date().toISOString().slice(0, 10);
  const sources = Object.fromEntries(settings.sources.rows.filter(row => row.scope === 'property' || row.scope === 'both')
    .map(row => [row.id, { status: 'needs-setup', since }]));
  assert.equal(await saveConfig([
    { kind: 'file-json-insert', file: 'config/integrations.json', pointer: `/assets/${site}`, value: sources },
    { kind: 'file-json-insert', file: 'config/signal-panels.json', pointer: `/assets/${site}`, value: { enabled: false, reason: 'no-lane-yet', since } },
  ]), 200);
  assert.equal(await saveConfig([{ kind: 'file-json-set', file: 'config/beads.json', pointer: '/spokes/0', expect: core, value: core }]), 200,
    'the core project reference remains valid in a real guarded Save after the first site exists');
  const wall = JSON.parse((await get(`${plan.url}api/wall`)).text);
  assert.equal(wall.assets.length, 1);
  assert.equal(wall.assets[0].id, site, 'only the user site enters portfolio counts');
  assert.equal(wall.assets[0].pulseReceivedAt, null, 'a new site has no invented report');
  const log = readFileSync(plan.log, 'utf8');
  assert.equal(`${run.output}\n${log}`.includes(VIOLATION), false);
  for (const name of ['database.url', 'owner.url', 'maint.url']) {
    const address = readFileSync(path.join(own.secrets, name), 'utf8').trim();
    const password = decodeURIComponent(new URL(address).password);
    assert.equal(`${run.output}\n${log}`.includes(address), false);
    assert.equal(`${run.output}\n${log}`.includes(password), false);
    assert.equal(processTree(run.child.pid).some(entry => entry.args.includes(password)), false);
    assert.deepEqual(await answersHolding(password, plan.url), []);
    assert.deepEqual(filesHolding(password, [base], { except: [plan.secrets, ...['database.url', 'owner.url', 'maint.url'].map(file => path.join(own.secrets, file))] }), []);
  }
  const state = await compose(['ps', '--all', '--quiet', 'postgres']);
  assert.equal(state.code, 0);
  assert.ok(state.stdout.trim(), 'this explicit project has its Postgres service');
  process.kill(run.child.pid, 'SIGINT');
  assert.equal(await run.exited, 0);
  // The documented bootstrap token boundary (docs/11, ASSET_TOKEN convention)
  // is set only in this disposable installation while stopped. No provider
  // account or public site is needed to prove the first incoming report.
  const assetToken = randomBytes(32).toString('hex');
  writeFileSync(plan.secrets, `${JSON.stringify({ ...bindings, ASSET_TOKENS: JSON.stringify({ [site]: assetToken }) }, null, 2)}\n`, { mode: 0o600 });
  const preserved = [path.join(home, 'dolt', 'core.json'), path.join(home, 'dolt', 'credentials'), ...['beads.json', 'task-host.json', 'integrations.json', 'signal-panels.json'].map(file => path.join(plan.installation, file))]
    .map(file => [file, readFileSync(file, 'utf8')]);
  const again = runStart(t, { home, port: plan.port, tripwire });
  assert.equal(await started(again), true, 'the same declared hub starts again without reinitialization');
  const retained = JSON.parse((await get(`${plan.url}api/tasks/${created.body.id}`)).text);
  assert.equal(retained.task.status, 'closed');
  for (const [file, content] of preserved) assert.equal(readFileSync(file, 'utf8'), content);
  const generatedAt = new Date().toISOString();
  const envelope = { asset: site, generatedAt, capabilities: ['signups'],
    metrics: { signups: { last24h: 3, avg7d: 2, total: 42 } }, flags: [] };
  const reported = await fetch(`${plan.door}/api/pulse`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${assetToken}` },
    body: JSON.stringify(envelope), signal: AbortSignal.timeout(30_000),
  });
  assert.equal(reported.status, 201, 'the real ingest authenticates and stores the first report');
  assert.equal((await reported.json()).ok, true);
  const siteResponse = await get(`${plan.url}api/assets/${site}?view=overview`);
  assert.equal(siteResponse.status, 200);
  const observed = JSON.parse(siteResponse.text);
  assert.equal(observed.metrics.find(metric => metric.name === 'signups')?.total, 42);
  const afterReport = JSON.parse((await get(`${plan.url}api/wall`)).text);
  assert.ok(afterReport.assets[0].pulseReceivedAt, 'the real Tower observes report arrival');
  const reportStore = openStore(bindings.DATABASE_URL, { maxConnections: 1 });
  try {
    const workspace = await reportStore.onlyWorkspace();
    const pulses = await reportStore.inWorkspace(workspace, tx => tx.query(
      'SELECT envelope::text AS envelope FROM noticeos.current_pulses WHERE asset_id = $1', [site]), { readOnly: true });
    assert.equal(pulses.length, 1);
    assert.deepEqual(JSON.parse(pulses[0].envelope), envelope, 'the accepted envelope survives the real Postgres read');
  } finally { await reportStore.close(); }
  const allOutput = `${run.output}\n${again.output}\n${readFileSync(plan.log, 'utf8')}`;
  assert.equal(allOutput.includes(assetToken), false);
  assert.deepEqual(await answersHolding(assetToken, plan.url), []);
  for (const file of ['root', 'noticeos']) {
    const password = readFileSync(path.join(profile.secretsDir, file), 'utf8').trim();
    assert.equal(allOutput.includes(password), false);
    assert.equal(processTree(again.child.pid).some(entry => entry.args.includes(password)), false);
    assert.deepEqual(await answersHolding(password, plan.url), []);
    assert.deepEqual(filesHolding(password, [base], { except: [path.join(profile.secretsDir, file), profile.credentialsFile] }), []);
  }
  process.kill(again.child.pid, 'SIGINT');
  assert.equal(await again.exited, 0);
});

test('a failed fresh Compose setup refuses unknown database objects and supports explicit operator repair without automatic retry', { skip: !FIRST_START_COMPOSE, timeout: 360_000 }, async t => {
  const { home, plan, own, env, compose, tripwire } = await composeTest(t);
  const clean = { ...env };
  delete clean[SECRETS_DIR_VARIABLE];
  delete clean.NOTICEOS_POSTGRES_PORT;
  assert.equal((await prepareFreshPostgres(plan, { env: clean, apply: () => false })).ok, false);
  assert.equal(planRefusal(plan), null, 'our provenance remains usable for recovery');
  assert.equal(databaseEmpty(own), true, 'profile extensions alone are an empty installation');
  for (const [create, remove] of [
    ['CREATE SCHEMA noticeos;', 'DROP SCHEMA noticeos;'],
    ['CREATE SCHEMA unrelated;', 'DROP SCHEMA unrelated;'],
    ['CREATE SCHEMA pgcustom; CREATE TABLE pgcustom.kept (value text);', 'DROP SCHEMA pgcustom CASCADE;'],
    ['CREATE TABLE public.kept (value text);', 'DROP TABLE public.kept;'],
    ['CREATE COLLATION public.kept FROM pg_catalog."C";', 'DROP COLLATION public.kept;'],
  ]) {
    assert.equal((await compose(['exec', '-T', 'postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'noticeos', '-c', create])).code, 0);
    assert.equal(databaseEmpty(own), false, 'any existing schema or user object disqualifies automatic setup');
    assert.equal((await compose(['exec', '-T', 'postgres', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'noticeos', '-c', remove])).code, 0);
  }
  let applied = false;
  assert.equal((await prepareFreshPostgres(plan, { env: clean, apply: () => { applied = true; return true; } })).created, false);
  assert.equal(applied, false, 'a later start never retries automatic schema setup');
  const owner = { NOTICEOS_FIRST_START_REPAIR_URL: readFileSync(path.join(own.secrets, 'owner.url'), 'utf8').trim() };
  const flags = ['--database', 'noticeos', '--url-from', 'NOTICEOS_FIRST_START_REPAIR_URL', '--confirm', 'noticeos'];
  const silent = { write: () => true };
  assert.equal(migrate(['apply', ...flags], silent, silent, { env: owner }), 0);
  assert.equal(migrate(['bootstrap', ...flags, '--slug', 'main', '--name', 'My sites'], silent, silent, { env: owner }), 0);
  const run = runStart(t, { home, port: plan.port, tripwire });
  assert.equal(await started(run), true, 'ordinary startup reaches the explicitly repaired healthy database');
  process.kill(run.child.pid, 'SIGINT');
  assert.equal(await run.exited, 0);
});


// Development starts own a fresh native database, never the Compose profile.
test('development is explicit and refuses ordinary, mixed and symbolic-link folders before setup', async (t) => {
  assert.equal(parseArgs(['--development']).development, true);
  assert.equal(parseArgs([]).development, undefined);
  assert.equal(await startMain(['--development']), 1, 'no implicit default installation is selected');
  const base = tempDir(t, 'development-refusal-');
  const home = path.join(base, 'runtime');
  const plan = startPlan({ root: REPO_ROOT, dir: home, port: 6510 });
  assert.equal(developmentRefusal(plan, true), null);
  mkdirSync(home);
  writeFileSync(plan.mark, 'ordinary installation');
  assert.match(developmentRefusal(plan, true), /empty folder/);
  assert.equal(existsSync(path.join(home, DEVELOPMENT_MARK)), false);
  rmSync(plan.mark);
  const fs = await import('node:fs/promises');
  await fs.symlink(path.join(base, 'other'), path.join(home, DEVELOPMENT_MARK));
  assert.match(developmentRefusal(plan, true), /empty folder/);
});

test('development startup refuses an already held runtime port without writing its folder', async (t) => {
  const base = tempDir(t, 'development-held-');
  const home = path.join(base, 'runtime');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const port = server.address().port;
    // An HTTP responder makes the existing shared readiness refusal deterministic.
    server.on('connection', socket => { socket.on('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')); });
    assert.equal(await startMain(['--development', '--dir', home, '--port', String(port), '--no-open']), 1);
    assert.equal(existsSync(home), false);
    assert.equal(server.listening, true, 'the unrelated listener stays owned by its caller');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('two developer commands seed a real Tower on its own new database, then stop and restart without adopting Compose', { timeout: 240_000 }, async (t) => {
  // The commands start Postgres in their own process, where its absence is
  // only an exit code: decide here, as the in-process tests do.
  if (!findPostgres() && !postgresRequired()) return t.skip('no Postgres server binaries (initdb, pg_ctl, psql) on this machine');
  const base = tempDir(t, 'development-live-');
  const home = path.join(base, 'runtime');
  const compose = path.join(base, 'untouched-compose');
  mkdirSync(compose, { mode: 0o700 });
  const sentinel = path.join(compose, ADDRESS_FILE);
  const planted = 'Never read or change this synthetic Compose address.\n';
  writeFileSync(sentinel, planted, { mode: 0o600 });
  const tripwire = path.join(base, 'tripwire.mjs');
  writeFileSync(tripwire, TRIPWIRE);
  const range = /^(\d+)-(\d+)$/.exec(process.env.NOTICEOS_TEST_POSTGRES_PORTS ?? '6500-6547');
  assert.ok(range, 'development proof requires an explicit owned port range');
  let port;
  for (let candidate = Number(range[1]); candidate + 2 <= Number(range[2]); candidate++) {
    const holds = await Promise.all([hold(candidate), hold(candidate + 1), hold(candidate + 2)]);
    await Promise.all(holds.filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
    if (holds.every(Boolean)) { port = candidate; break; }
  }
  assert.ok(port, 'three owned loopback ports must be free');
  const plan = startPlan({ root: REPO_ROOT, dir: home, port });
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${tripwire}`,
    START_TRIPWIRE_ROOT: REPO_ROOT,
    START_TRIPWIRE_HOME: home,
    START_TRIPWIRE_COMPOSE: compose,
    [SECRETS_DIR_VARIABLE]: compose,
    DATABASE_URL: 'postgresql://unused:generated@127.0.0.1:5432/unused',
    WRANGLER_LOG_PATH: path.join(base, 'wrangler-logs'),
    CI: '1',
    WRANGLER_SEND_METRICS: 'false',
  };
  const run = async (work) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/start.mjs'), '--development', '--dir', home, '--port', String(port), '--no-open'], {
      cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    const started = new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(new Error('development start readiness timed out')), 120_000);
      const check = () => { if (output.includes('NoticeOS is running:')) done(); };
      const done = error => {
        clearTimeout(timer);
        child.stdout.off('data', check);
        error ? reject(error) : resolve();
      };
      child.stdout.on('data', check);
      exited.then(() => done(new Error(`development start exited before readiness:\n${output}`)), done);
      check();
    });
    try {
      await started;
      assert.ok(output.includes(ARMED));
      assert.doesNotMatch(output, new RegExp(VIOLATION));
      assert.doesNotMatch(output, /Took DATABASE_URL/);
      const secrets = JSON.parse(readFileSync(plan.secrets, 'utf8'));
      assert.equal(statSync(plan.secrets).mode & 0o777, 0o600);
      assert.equal(new URL(secrets.DATABASE_URL).pathname, '/noticeos_dev');
      assert.equal(new URL(secrets.DATABASE_URL).port, String(port + 2));
      assert.equal(new URL(secrets.DATABASE_URL).hostname, '127.0.0.1');
      const password = new URL(secrets.DATABASE_URL).password;
      assert.ok(password.length > 20);
      assert.equal(output.includes(password), false);
      assert.ok(processTree(child.pid).some(row => /workerd/.test(row.args)));
      assert.ok(processTree(child.pid).every(row => !row.args.includes(password)));
      const db = openStore(secrets.DATABASE_URL, { maxConnections: 1 });
      try {
        const workspace = await db.onlyWorkspace();
        assert.equal((await db.inWorkspace(workspace, tx => tx.query("SELECT current_setting('noticeos.profile') AS profile")))[0].profile, 'development');
      } finally { await db.close(); }
      await work(secrets.DATABASE_URL);
      assert.match(developmentRefusal(plan, false), /--development/);
      assert.match(developmentRefusal(plan, true), /prior development runtime/);
      assert.equal(existsSync(path.join(home, 'postgres')), false);
      assert.equal(existsSync(path.join(home, 'dolt')), false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 15_000);
      try { await exited; } finally { clearTimeout(timer); }
      assert.equal(existsSync(path.join(home, '.local', 'development-postgres')), false, 'owned PG retired before command exit');
      assert.equal(existsSync(plan.lock), false);
      assert.equal(existsSync(path.join(home, '.development-start-active')), false);
      assert.doesNotMatch(output, new RegExp(VIOLATION));
    }
  };
  let firstAddress;
  await run(async address => {
    firstAddress = address;
    const seeded = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/db-seed.mjs'), '--dir', home], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(seeded.status, 0, seeded.stderr);
    const response = await fetch(`${plan.url}api/wall`, { signal: AbortSignal.timeout(30_000) });
    const wall = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(wall.assets.map(asset => asset.id), ['meadow.example', 'northwind.example']);
    const money = await fetch(`${plan.url}api/financials?period=2026-05`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(money.status, 200);
    assert.ok((await money.json()).properties.length === 2);
    const again = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts/db-seed.mjs'), '--dir', home], { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(again.status, 1, 'second seed refuses existing synthetic rows');
  });
  writeFileSync(path.join(home, 'unrelated.txt'), 'fixture');
  assert.match(developmentRefusal(plan, true), /unrelated/);
  rmSync(path.join(home, 'unrelated.txt'));
  await run(async address => {
    assert.notEqual(address, firstAddress, 'restart replaces the ephemeral application password');
    const response = await fetch(`${plan.url}api/wall`, { signal: AbortSignal.timeout(30_000) });
    assert.deepEqual((await response.json()).assets, [], 'restart deliberately starts a fresh development DB');
  });
  assert.equal(readFileSync(sentinel, 'utf8'), planted);
});
