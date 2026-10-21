// `pnpm db:try-tower`: the Tower on a throwaway development database in a
// folder of its own, which never reaches the NoticeOS stack's store,
// installation folder, secrets, logs or ports.
//
// The first tests pin the plan (every path it writes, every variable its Tower
// is told, every refusal) without starting anything. The last one is the
// proof: it boots the real command on a new folder with a tripwire loaded into
// every Node process it starts (itself, pnpm, wrangler, vite) that refuses any
// read or write of the checkout's `installation/`, `.wrangler/` or `.local/`,
// any secrets file outside the new folder, the Compose profile's secrets and
// any connection to the managed service's ports, seeds it, stops it and starts
// it again on a fresh database.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openStore } from '../packages/postgres/src/store.mjs';

import { MANAGED_DOOR, doorFromEnv } from './ingest-door.mjs';
import { installationDir } from './installation.mjs';
import { LOCAL_CONNECTION_VARIABLE } from './database-address.mjs';
import { ADDRESS_FILE, DEFAULT_PORT as POSTGRES_PORT, SECRETS_DIR_VARIABLE } from './postgres-secrets.mjs';
import { findPostgres } from './postgres-dev.mjs';
import { postgresRequired } from './postgres-test-cluster.mjs';
import { processTree } from './test-planted-address.mjs';
import { stripJsonc } from './jsonc.mjs';
import { statePaths } from './os-runtime.mjs';
import { CONFIG } from './runner/config.mjs';
import { DEVELOPMENT_MARK, developmentRefusal } from './start-development.mjs';
import {
  FOLDER_MARK,
  MANAGED_PORTS,
  main as startMain,
  parseArgs,
  planRefusal,
  startPlan,
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

test('everything a run keeps is inside its own folder, and none of it is the NoticeOS stack’s', () => {
  const plan = startPlan({ root: REPO_ROOT, dir: path.join('.local', 'try-tower') });
  assert.equal(plan.home, path.join(REPO_ROOT, '.local', 'try-tower'));
  const owner = statePaths(REPO_ROOT);
  // What the stack keeps: its store, installation folder, secrets,
  // and its runner state under .local (this folder is a sibling there).
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

test('a run refuses, in one line, a missing folder, a stack port, the checkout, or a folder it did not make', async (t) => {
  assert.throws(() => startPlan({ root: REPO_ROOT }), /needs the folder/);
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  assert.equal(await startMain([]), 1);
  assert.equal(await startMain(['--port', '6510']), 1);
  const lines = stderr.mock.calls.map((call) => String(call.arguments[0]));
  stderr.mock.restore();
  assert.deepEqual(lines, Array(2).fill('pnpm db:try-tower: --dir <folder> is required: pnpm db:try-tower -- --dir <folder> [--port <n>] [--no-open]\n'));

  const root = tempDir(t, 'start-root-');
  const refusal = (options, fsView) => planRefusal(startPlan({ root, dir: path.join(root, 'runtime'), ...options }), fsView);
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

test('it takes no migration or installation flag: development is its only mode', () => {
  assert.throws(() => parseArgs(['--migrate']), /unknown option --migrate/);
  assert.throws(() => parseArgs(['--development']), /unknown option --development/);
  assert.deepEqual(parseArgs(['--', '--dir', 'here', '--port', '6000', '--no-open']), { port: 6000, dir: 'here', open: false, help: false });
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

/** A server holding `port` on loopback, or null when something else has it. */
function hold(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Each run owns a fresh native database, never the Compose profile.
test('it refuses ordinary, mixed and symbolic-link folders before setup', async (t) => {
  const base = tempDir(t, 'development-refusal-');
  const home = path.join(base, 'runtime');
  const plan = startPlan({ root: REPO_ROOT, dir: home, port: 6510 });
  assert.equal(developmentRefusal(plan), null);
  mkdirSync(home);
  writeFileSync(plan.mark, 'ordinary installation');
  assert.match(developmentRefusal(plan), /empty folder/);
  assert.equal(existsSync(path.join(home, DEVELOPMENT_MARK)), false);
  rmSync(plan.mark);
  const fs = await import('node:fs/promises');
  await fs.symlink(path.join(base, 'other'), path.join(home, DEVELOPMENT_MARK));
  assert.match(developmentRefusal(plan), /empty folder/);
});

test('it refuses an already held runtime port without writing its folder', async (t) => {
  const base = tempDir(t, 'development-held-');
  const home = path.join(base, 'runtime');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const port = server.address().port;
    // An HTTP responder makes the existing shared readiness refusal deterministic.
    server.on('connection', socket => { socket.on('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')); });
    assert.equal(await startMain(['--dir', home, '--port', String(port), '--no-open']), 1);
    assert.equal(existsSync(home), false);
    assert.equal(server.listening, true, 'the unrelated listener stays owned by its caller');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('two developer commands seed a real Tower on its own new database, then stop and restart without adopting Compose', { timeout: 240_000 }, async (t) => {
  // The commands start Postgres in their own process, where its absence is
  // only an exit code: decide here, as the in-process tests do.
  if (!findPostgres() && !postgresRequired()) return t.skip('no Postgres server binaries (initdb, pg_ctl, psql) on this machine');
  const base = mkdtempSync(path.join(os.tmpdir(), 'development-live-'));
  let activeRuns = 0;
  t.after(() => {
    assert.equal(activeRuns, 0, `active owned processes remain; preserving ${base}`);
    rmSync(base, { recursive: true, force: true });
  });
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
  // A PID can be reused after exit. Only the identity captured beneath this
  // start (and its explicitly owned postmaster) may be inspected or signalled.
  const identity = pid => {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
    if (result.status === 1 && !result.stdout.trim()) return null;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const waitUntil = async (ready, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    return ready();
  };
  const run = async (work) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/start.mjs'), '--dir', home, '--port', String(port), '--no-open'], {
      cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    activeRuns++;
    const owned = new Map();
    let postmasterPid;
    const remember = pid => { const started = identity(pid); if (started) owned.set(pid, started); };
    const rememberTree = () => { for (const row of processTree(child.pid)) remember(row.pid); };
    const survivors = () => [...owned].filter(([pid, started]) => identity(pid) === started).map(([pid]) => pid);
    remember(child.pid);
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
      const secrets = JSON.parse(readFileSync(plan.secrets, 'utf8'));
      assert.equal(statSync(plan.secrets).mode & 0o777, 0o600);
      assert.equal(new URL(secrets.DATABASE_URL).pathname, '/noticeos_dev');
      assert.equal(new URL(secrets.DATABASE_URL).port, String(port + 2));
      assert.equal(new URL(secrets.DATABASE_URL).hostname, '127.0.0.1');
      const password = new URL(secrets.DATABASE_URL).password;
      assert.ok(password.length > 20);
      assert.equal(output.includes(password), false);
      const tree = processTree(child.pid);
      assert.ok(tree.some(row => /workerd/.test(row.args)));
      assert.ok(tree.some(row => /vite/.test(row.args)));
      for (const row of tree) remember(row.pid);
      postmasterPid = Number(readFileSync(path.join(home, '.local', 'development-postgres', 'data', 'postmaster.pid'), 'utf8').split('\n')[0]);
      for (const row of processTree(postmasterPid)) remember(row.pid);
      assert.ok(processTree(child.pid).every(row => !row.args.includes(password)));
      const db = openStore(secrets.DATABASE_URL, { maxConnections: 1 });
      try {
        const workspace = await db.onlyWorkspace();
        assert.equal((await db.inWorkspace(workspace, tx => tx.query("SELECT current_setting('noticeos.profile') AS profile")))[0].profile, 'development');
      } finally { await db.close(); }
      await work(secrets.DATABASE_URL);
      assert.match(developmentRefusal(plan), /prior development runtime/);
      assert.equal(existsSync(path.join(home, 'postgres')), false);
      assert.equal(existsSync(path.join(home, 'dolt')), false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        rememberTree();
        if (postmasterPid && identity(postmasterPid) === owned.get(postmasterPid)) {
          for (const row of processTree(postmasterPid)) remember(row.pid);
        }
        child.kill('SIGTERM');
      }
      // The Tower starts a detached process group. Killing only this command's
      // group cannot retire it when an assertion aborts the proof.
      const killOwned = () => {
        for (const pid of survivors()) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
      };
      const timer = setTimeout(killOwned, 15_000);
      try {
        await exited;
        assert.ok(await waitUntil(() => survivors().length === 0, 5_000), `owned processes survived stop: ${survivors()}`);
      } finally {
        clearTimeout(timer);
        // Rescue only recorded children if a cleanup assertion itself fails.
        killOwned();
        if (await waitUntil(() => survivors().length === 0, 2_000)) activeRuns--;
      }
      const holds = await Promise.all([hold(port), hold(port + 1), hold(port + 2)]);
      try { assert.ok(holds.every(Boolean), 'all owned Tower, ingest and Postgres ports are released'); }
      finally { await Promise.all(holds.filter(Boolean).map(server => new Promise(resolve => server.close(resolve)))); }
      t.diagnostic(`retired ${owned.size} exact owned process identities and released all three ports`);
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
  assert.match(developmentRefusal(plan), /unrelated/);
  rmSync(path.join(home, 'unrelated.txt'));
  await run(async address => {
    assert.notEqual(address, firstAddress, 'restart replaces the ephemeral application password');
    const response = await fetch(`${plan.url}api/wall`, { signal: AbortSignal.timeout(30_000) });
    assert.deepEqual((await response.json()).assets, [], 'restart deliberately starts a fresh development DB');
  });
  await t.test('an assertion failure after Vite/workerd acquisition retires every owned process and port', async () => {
    await assert.rejects(run(async () => {
      assert.fail('injected assertion after development readiness');
    }), { name: 'AssertionError', message: 'injected assertion after development readiness' });
  });
  assert.equal(readFileSync(sentinel, 'utf8'), planted);
});
