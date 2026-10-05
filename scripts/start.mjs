#!/usr/bin/env node
// start.mjs — `pnpm start`: NoticeOS on this machine, in one command
// (bead ro-ujb9.126, decision D30).
//
// A fresh clone has no store, secrets or saved settings. A proven empty folder
// gets its own Compose Postgres, the committed frozen schema and one workspace
// (owner-approved exception, ro-nzy7). Startup then prepares the runtime files,
// gets its own Dolt hub and OS task project, starts the Tower and ingest on
// loopback, and prints Home's address. Beads CLI 1.1.2 is checked before setup.
//
//   pnpm start                       # http://127.0.0.1:4747/
//   pnpm start -- --port 6000        # the Tower on 6000, its ingest door on 6001
//   pnpm start -- --dir ~/noticeos   # keep the installation somewhere else
//   pnpm start -- --no-open          # do not open a browser
//   pnpm start -- --development --dir .local/development  # foreground-owned synthetic database
//
// IT IS NOT THE MANAGED SERVICE. `pnpm os:*` runs an installation's live OS:
// launchd, the Tower on :5173, the ingest door on :8791, the checkout's own
// `.wrangler/state`, `installation/` and secret files. This command uses none of
// them. Its folder holds local state, its generated secrets, the Worker configs
// generated beside them (wrangler reads a Worker's secrets from beside its
// config), its saved-settings exports and its log; its Tower is told so through
// the same variables the managed service uses (scripts/os-runtime.mjs), and it
// refuses the managed service's ports outright. scripts/start.test.mjs boots it
// beside a planted store with a tripwire on every owner path and port.
//
// EXISTING POSTGRES IS NEVER STARTED OR MIGRATED HERE. Its address stays in the
// folder's secrets file (ro-ujb9.76.7.2). First-run setup is only for the new,
// empty project proven by start-postgres.mjs; subsequent starts read and check
// the configured database. The folder's secrets file holds DATABASE_URL beside the
// keys made for it; the start checks that address as the application login
// (scripts/database-address.mts) and hands it to the Tower's environment only.
// One whose database is behind this code stops naming the operator's command.
//
// A NEW FOLDER TAKES ITS ADDRESS FROM THE COMPOSE PROFILE, ONCE (operator,
// 2026-09-29, bead ro-ujb9.76.7.3). While the folder's secrets file has no
// DATABASE_URL, the start copies the one line `pnpm postgres:secrets` wrote to
// the profile's `database.url` into it, so a first run needs no hand copy of a
// password. Without that file it stops in one sentence naming the command to
// run first. Nothing else moves a secret: the managed service reads home's
// secrets file only, and an address already in the folder is never replaced.
//
// IT KEEPS COLLECTING ON ITS SCHEDULE (bead ro-ujb9.156). Once the door answers
// and the settings are seeded, it fires the ingest's crons at its own door and
// keeps their record in its folder (scripts/start-schedule.mjs), so Workflows
// and System health show this installation's runs. Each start pays the latest
// missed obligation of every lane once. Task polling uses its own declared hub
// and credentials; backups run once its own offsite destination is configured.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATABASE_SETUP, DATABASE_URL, LOCAL_CONNECTION_VARIABLE, readDatabaseAddress, towerDatabase } from './database-address.mjs';
import { readDevSecretBindings, syncDevVars } from './dev-secrets.mjs';
import { runSeed } from './config-seed.mjs';
import { doorIsHeld } from './ingest-door.mjs';
import { DEFAULT_INSTALLATION_DIR, INSTALLATION_DIR_ENV } from './installation.mjs';
import { redactLogText } from './os-log.mjs';
import { PRODUCT_ENV } from './product-env.mjs';
import { ADDRESS_FILE, composeSecretsDir } from './postgres-secrets.mjs';
import { developmentRefusal, openDevelopmentStart } from './start-development.mjs';
import { startSchedule } from './start-schedule.mjs';
import { MANAGED_START_PORTS, prepareFreshPostgres } from './start-postgres.mjs';
import { preflightStartedTasks, prepareStartedTasks, scrubTaskEnvironment } from './start-dolt.mjs';
import {
  HOME_ENV,
  invokedDirectly,
  samePath,
  statePaths,
  workerCrons,
} from './os-runtime.mjs';
import { WORKER_CONFIGS, WRANGLER_SECRET_SWITCHES, workerConfig } from './worker-config-folder.mjs';

// The folder's Worker configs are written by scripts/worker-config-folder.mts,
// which the unit tests share for a folder with no secrets (bead ro-ujb9.182).
export { WORKER_CONFIGS, workerConfig };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Where the Tower answers unless `--port` says otherwise; the ingest door is the next port. */
export const DEFAULT_PORT = 4747;
/** The folder the installation lives in, relative to the checkout. */
export const DEFAULT_DIR = path.join('.local', 'start');
/**
 * The managed service's ports: its Tower (scripts/runner/config.mjs CONFIG.towerPort),
 * its ingest door (CONFIG.ingestPort), task hub (CONFIG.beadsHubPort) and the
 * shipped Postgres host port (postgres-secrets.mjs DEFAULT_PORT).
 * Refused even when free — a started Tower holding one would stop the managed
 * service from coming back. scripts/start.test.mjs pins them to CONFIG.
 */
export const MANAGED_PORTS = MANAGED_START_PORTS;
/** The file that says a folder is one `pnpm start` made. */
export const FOLDER_MARK = '.made-by-pnpm-start';
/** Wrangler's older name for the database address, which it still reads when
 * the current one is unset: never inherited by a started Tower. */
const LEGACY_CONNECTION_VARIABLE = 'WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES';

// ─── The plan ────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { port: DEFAULT_PORT, dir: null, open: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    else if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--dir') opts.dir = argv[++i] ?? null;
    else if (arg === '--no-open') opts.open = false;
    else if (arg === '--development') opts.development = true;
    else throw new Error(`unknown option ${arg} (known: --port, --dir, --no-open, --development)`);
  }
  return opts;
}

/**
 * Every path and port one start uses, from the checkout and the options.
 * Everything that is state is inside `home`; nothing names the checkout's own
 * store, installation folder, secrets or logs.
 */
export function startPlan({ root = REPO_ROOT, dir = null, port = DEFAULT_PORT } = {}) {
  const home = path.resolve(root, dir ?? DEFAULT_DIR);
  const state = statePaths(home);
  return {
    root,
    home,
    port,
    doorPort: port + 1,
    url: `http://127.0.0.1:${port}/`,
    door: `http://127.0.0.1:${port + 1}`,
    state: state.persistState,
    installation: path.join(home, DEFAULT_INSTALLATION_DIR),
    secrets: state.devSecrets,
    devVars: state.devVars,
    configs: WORKER_CONFIGS.map((relative) => ({
      source: path.join(root, relative),
      target: path.join(home, relative),
    })),
    ingestConfig: path.join(home, WORKER_CONFIGS[1]),
    registry: path.join(home, '.wrangler', 'registry'),
    logsDir: state.logsDir,
    log: path.join(state.logsDir, 'start.log'),
    lock: path.join(state.localDir, 'start.pid'),
    mark: path.join(home, FOLDER_MARK),
  };
}

/**
 * The environment the Tower runs with: the process's own, told where this
 * installation is. Each variable is one the Tower already reads —
 * `NOTICEOS_HOME` (its lanes' state, secrets and logs), the installation
 * folder (saved-settings exports), the store and the ingest door
 * (apps/tower/vite.config.ts, vite/runner-door.ts) — plus where the Worker
 * configs are and a dev registry of its own, so its Workers never register
 * over another runtime's of the same name. Two wrangler switches that would let
 * the shell's environment choose other secrets are dropped, and so is every
 * pre-rename name of a product variable (scripts/product-env.mts), so an
 * inherited REINDEX_OS_HOME can never point a started Tower at another
 * installation. The database's address is the folder's own
 * (`database`, from `towerDatabase`): one the shell carries is dropped.
 */
export function towerEnv(plan, env = process.env, database = {}) {
  const own = scrubTaskEnvironment(env);
  for (const name of WRANGLER_SECRET_SWITCHES) delete own[name];
  for (const variable of Object.values(PRODUCT_ENV)) delete own[variable.legacy];
  for (const name of [LOCAL_CONNECTION_VARIABLE, LEGACY_CONNECTION_VARIABLE]) delete own[name];
  return {
    ...own,
    ...database,
    [HOME_ENV]: plan.home,
    [INSTALLATION_DIR_ENV]: plan.installation,
    [PRODUCT_ENV.workerConfigRoot.name]: plan.home,
    OS_UP_PERSIST_STATE: plan.state,
    OS_UP_INGEST_DOOR_HOST: '127.0.0.1',
    OS_UP_INGEST_DOOR_PORT: String(plan.doorPort),
    MINIFLARE_REGISTRY_PATH: plan.registry,
  };
}

const shown = (file, cwd = process.cwd()) => {
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
};

/** Why this plan must not run, in one line, or null. Decided before anything is written. */
export function planRefusal(plan, { exists = existsSync, list = readdirSync } = {}) {
  for (const port of [plan.port, plan.doorPort]) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return `--port needs a number from 1024 to 65534, not ${plan.port}.`;
    }
    if (MANAGED_PORTS.includes(port)) {
      return `port ${port} belongs to the managed service (pnpm os:*); choose another with --port.`;
    }
  }
  const relative = path.relative(plan.home, plan.root);
  if (samePath(plan.home, plan.root) || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return `${plan.home} holds this checkout; choose a folder of its own with --dir.`;
  }
  if (exists(plan.home) && !exists(plan.mark) && list(plan.home).length > 0) {
    return `${shown(plan.home)} holds files pnpm start did not make; choose an empty folder with --dir.`;
  }
  return null;
}

// ─── The folder ──────────────────────────────────────────────────────────────

/** The folder, its mark, the Worker configs and (once) the secrets. Returns
 * whether the secrets were made now. Never touches a secret that exists: the
 * key is what opens every credential the store holds. */
export async function prepareFolder(plan) {
  await fs.mkdir(plan.home, { recursive: true });
  await fs.writeFile(plan.mark, 'Local runtime files for one NoticeOS installation. Postgres data is stored separately.\n');
  await fs.mkdir(plan.logsDir, { recursive: true });
  for (const { source, target } of plan.configs) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, workerConfig(await fs.readFile(source, 'utf8'), source));
  }
  let made = false;
  if (!existsSync(plan.secrets)) {
    const secrets = {
      CREDENTIALS_KEY: randomBytes(32).toString('base64'),
      OPERATOR_TOKEN: randomBytes(32).toString('base64url'),
    };
    await fs.writeFile(plan.secrets, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    made = true;
  }
  await syncDevVars({ secretsFile: plan.secrets, varsFile: plan.devVars });
  return made;
}

/**
 * A new installation's database address, taken once from the Compose profile
 * (operator, 2026-09-29, bead ro-ujb9.76.7.3).
 *
 * Only while the folder's secrets file has no DATABASE_URL: the profile's
 * `database.url` (`composeSecretsDir`, the folder compose.yaml reads, beside
 * `env`'s NOTICEOS_POSTGRES_SECRETS) holds the application login's address as
 * one line. Its form is checked, then the secrets file is written whole beside
 * itself (0600) and renamed over, the other secrets unchanged. The database
 * itself is checked afterwards by `towerDatabase`, as every start checks it.
 *
 * Returns `{ ok: true, took }`, `took` the file the address came from or null
 * when the folder already had one, or `{ ok: false, line }`: one sentence that
 * never repeats any part of the address. Nothing is started, made or migrated.
 */
export async function takeComposeAddress(plan, { env = process.env } = {}) {
  let document;
  try {
    document = JSON.parse(await fs.readFile(plan.secrets, 'utf8'));
  } catch {
    document = null;
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, line: `${shown(plan.secrets)} could not be read, so ${DATABASE_URL} is unknown; it is one JSON object of the installation's secrets.` };
  }
  const held = document[DATABASE_URL];
  if (held !== undefined && held !== null && !(typeof held === 'string' && held.trim() === '')) {
    return { ok: true, took: null };
  }
  const source = path.join(composeSecretsDir(env, plan.root), ADDRESS_FILE);
  let text;
  try {
    text = await fs.readFile(source, 'utf8');
  } catch (error) {
    return {
      ok: false,
      line: error?.code === 'ENOENT'
        ? `${DATABASE_URL} is not set in ${shown(plan.secrets)} and ${shown(source)} does not exist yet: run pnpm postgres:secrets first (${DATABASE_SETUP} sets the database up).`
        : `${shown(source)} could not be read, so ${DATABASE_URL} is unknown (${DATABASE_SETUP}).`,
    };
  }
  const line = text.split('\n')[0].trim();
  if (line === '') {
    return { ok: false, line: `${shown(source)} holds no address; ${DATABASE_SETUP} shows what pnpm postgres:secrets writes there.` };
  }
  const reading = readDatabaseAddress({ [DATABASE_URL]: line }, shown(source));
  if (!reading.ok) return reading;
  const next = `${plan.secrets}.tmp-${process.pid}`;
  try {
    await fs.rm(next, { force: true });
    await fs.writeFile(next, `${JSON.stringify({ ...document, [DATABASE_URL]: reading.address.url }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.chmod(next, 0o600);
    await fs.rename(next, plan.secrets);
  } catch (error) {
    await fs.rm(next, { force: true }).catch(() => undefined);
    return { ok: false, line: `${shown(plan.secrets)} could not be written${error?.code ? ` (${error.code})` : ''}, so ${DATABASE_URL} was not taken from ${shown(source)}.` };
  }
  return { ok: true, took: source };
}

/** One start per folder: two runtimes on one store is the corruption this
 * codebase's single-runtime rule exists for (bead ro-mad). */
export function takeLock(plan, { alive = processAlive } = {}) {
  try {
    const held = JSON.parse(readFileSync(plan.lock, 'utf8'));
    if (Number.isInteger(held?.pid) && held.pid !== process.pid && alive(held.pid)) {
      return `another pnpm start (pid ${held.pid}) is using ${shown(plan.home)}.`;
    }
  } catch {
    // no lock, or an unreadable one: take it
  }
  mkdirSync(path.dirname(plan.lock), { recursive: true });
  writeFileSync(plan.lock, `${JSON.stringify({ pid: process.pid, port: plan.port })}\n`);
  return null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// ─── The Tower ───────────────────────────────────────────────────────────────

/** The Tower's dev server — the same child `pnpm os:up` runs, on this folder.
 * Its database address rides in its environment, never its arguments. */
function spawnTower(plan, logStream, database) {
  const child = spawn(
    'pnpm',
    ['--filter', '@noticeos/tower', 'exec', 'vite', '--port', String(plan.port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: plan.root, env: towerEnv(plan, process.env, database), stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  logRedacted(child.stdout, logStream);
  logRedacted(child.stderr, logStream);
  return child;
}

/** A child's output into the log a line at a time, each line scrubbed of
 * credential shapes as the runner's log is (scripts/os-log.mts). */
function logRedacted(stream, logStream) {
  stream.setEncoding('utf8');
  let partial = '';
  stream.on('data', (chunk) => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) logStream.write(`${redactLogText(line)}\n`);
  });
  stream.on('end', () => {
    if (partial !== '') logStream.write(`${redactLogText(partial)}\n`);
    partial = '';
  });
}

/** Resolves once `url` accepts a connection; rejects when `exited` settles first or time runs out. */
async function waitForPort(url, { exited, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let gone = false;
  exited.then(() => {
    gone = true;
  });
  while (Date.now() < deadline) {
    if (gone) throw new Error('the Tower stopped while starting');
    if (await doorIsHeld(url, { timeoutMs: 500 })) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`nothing answered on ${new URL(url).host} after ${Math.round(timeoutMs / 1000)}s`);
}

/** Load the product's default settings into a store that lacks them. The first
 * request wakes the ingest, so it is retried while the runtime warms up. */
async function seedSettings(plan, token, { exited, timeoutMs = 90_000 }) {
  process.env[INSTALLATION_DIR_ENV] = plan.installation;
  const deadline = Date.now() + timeoutMs;
  let gone = false;
  exited.then(() => {
    gone = true;
  });
  let last = null;
  while (Date.now() < deadline && !gone) {
    try {
      const { status, body } = await runSeed({ door: plan.door, token, repoRoot: plan.root });
      if (status === 200 && (body?.refused?.length ?? 0) === 0) return;
      last = `the store answered ${status}${body?.detail ? ` (${body.detail})` : ''}`;
      if (status < 500) break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`the default settings could not be loaded: ${last ?? 'the Tower stopped'}`);
}

function openBrowser(url) {
  const hasDesktop = process.platform === 'darwin' || process.platform === 'win32' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (!process.stdout.isTTY || process.env.CI || !hasDesktop) return;
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // no browser to open; the address is printed
  }
}

function tail(file, lines = 20) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

// ─── One start ───────────────────────────────────────────────────────────────

const say = (line) => process.stdout.write(`${line}\n`);
const refuse = (line) => {
  process.stderr.write(`pnpm start: ${line}\n`);
  return 1;
};

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    return refuse(error.message);
  }
  if (opts.development && !opts.dir) return refuse('--development requires its own explicit --dir folder.');
  const plan = startPlan({ dir: opts.dir, port: opts.port });
  const refusal = planRefusal(plan) ?? developmentRefusal(plan, opts.development === true);
  if (refusal) return refuse(refusal);
  for (const port of [plan.port, plan.doorPort]) {
    if (await doorIsHeld(`http://127.0.0.1:${port}`)) {
      return refuse(`port ${port} is in use; stop what holds it, or choose another with --port.`);
    }
  }

  let development = null;
  try {
    if (opts.development) development = openDevelopmentStart(plan);
    return await runPreparedStart(plan, opts, development);
  } catch (error) {
    if (!opts.development) throw error;
    return refuse('development startup could not finish; no existing installation was adopted.');
  } finally {
    development?.close();
  }
}

async function runPreparedStart(plan, opts, development) {
  // Development has no Docker/task-hub setup or installation address fallback.
  const taskCheck = development ? { ok: true, enabled: false } : await preflightStartedTasks(plan);
  if (!taskCheck.ok) return refuse(taskCheck.line);
  const setup = development ? { ok: true, created: true, env: {} }
    : await prepareFreshPostgres(plan, { requireTasks: taskCheck.enabled && taskCheck.fresh });
  if (!setup.ok) return refuse(setup.line);
  // A concurrent or failed first setup can leave an unmarked folder. Refuse
  // it before the ordinary path writes runtime files into it.
  const changed = planRefusal(plan);
  if (changed) return refuse(changed);
  const locked = takeLock(plan);
  if (locked) return refuse(locked);
  const release = () => {
    try {
      if (JSON.parse(readFileSync(plan.lock, 'utf8'))?.pid === process.pid) rmSync(plan.lock);
    } catch {
      // already gone
    }
  };

  await prepareFolder(plan);
  // A new installation's address, from the Compose profile, once.
  let taken;
  if (development) {
    const secrets = JSON.parse(await fs.readFile(plan.secrets, 'utf8'));
    await fs.writeFile(plan.secrets, `${JSON.stringify({ ...secrets, [DATABASE_URL]: development.address }, null, 2)}\n`, { mode: 0o600 });
    taken = { ok: true, took: null };
  } else {
    taken = await takeComposeAddress(plan, { env: { ...process.env, ...setup.env } });
  }
  if (!taken.ok) {
    release();
    return refuse(taken.line);
  }
  if (taken.took) say(`Took ${DATABASE_URL} from ${shown(taken.took)} into ${shown(plan.secrets)}.`);
  // The folder's database, before anything else is made: a start that cannot
  // reach it leaves only the folder and its secrets file, where the address goes.
  const database = await towerDatabase({
    where: shown(plan.secrets),
    readBindings: () => readDevSecretBindings({ secretsFile: plan.secrets, varsFile: plan.devVars }),
  });
  if (!database.ok) {
    release();
    return refuse(database.line);
  }
  const tasks = await prepareStartedTasks(plan, taskCheck, {
    fresh: setup.created,
    address: database.env[LOCAL_CONNECTION_VARIABLE],
  });
  if (!tasks.ok) {
    release();
    return refuse(tasks.line);
  }
  const { bindings } = await readDevSecretBindings({ secretsFile: plan.secrets, varsFile: plan.devVars });
  const logStream = createWriteStream(plan.log, { flags: 'a' });
  logStream.write(`\n── pnpm start ${new Date().toISOString()} · ${plan.url}\n`);
  const tower = spawnTower(plan, logStream, database.env);
  // 'exit', not 'close' (scripts/run-command.mjs): this watches the server's
  // life, and a process it started can hold its log pipe after it died.
  const exited = new Promise((resolve) => {
    tower.on('exit', (code) => resolve(code ?? 1));
    tower.on('error', () => resolve(127));
  });

  let stopping = false;
  let schedule = null;
  const stop = async () => {
    stopping = true;
    schedule?.stop();
    for (const [signal, after] of [['SIGTERM', 5000], ['SIGKILL', 2000]]) {
      try {
        process.kill(-tower.pid, signal);
      } catch {
        break; // the group is gone
      }
      if (await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(resolve, after, false))])) break;
    }
    development?.close();
    release();
  };
  const onSignal = () => {
    if (stopping) return;
    void stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await waitForPort(plan.url, { exited, timeoutMs: 120_000 });
    await waitForPort(plan.door, { exited, timeoutMs: 60_000 });
    await seedSettings(plan, bindings.OPERATOR_TOKEN, { exited });
    schedule = development ? null : await startSchedule({
      home: plan.home,
      door: plan.door,
      token: bindings.OPERATOR_TOKEN,
      taskRun: tasks.run,
      crons: workerCrons(readFileSync(plan.ingestConfig, 'utf8')),
      emit: (level, text) => logStream.write(`${new Date().toISOString()} [schedule] ${level} ${text}\n`),
    });
  } catch (error) {
    process.stderr.write(`pnpm start: ${error.message} — the last lines of ${shown(plan.log)}:\n${tail(plan.log)}\n`);
    await stop();
    return 1;
  }

  say(`NoticeOS is running: ${plan.url}`);
  if (development) say('Development database resets when stopped. Run pnpm seed:local in another terminal.');
  say(`Its data, settings and log are in ${shown(plan.home)}. Ctrl-C stops it.`);
  if (opts.open) openBrowser(plan.url);

  const code = await exited;
  schedule?.stop();
  if (!stopping) {
    process.stderr.write(`pnpm start: the Tower stopped (exit ${code}) — the last lines of ${shown(plan.log)}:\n${tail(plan.log)}\n`);
    release();
    return code || 1;
  }
  return 0;
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
