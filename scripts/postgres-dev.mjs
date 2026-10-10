// The Postgres development profile: the only databases the Postgres tooling
// talks to. Two ways in: a throwaway cluster in a folder (`openThrowaway`,
// marked by a file so an existing server's data folder is never touched, on a
// private unix socket, optionally also on one loopback port for noticeos_app
// alone) and a local development URL (`openDevelopmentUrl`: this machine
// only, a `_dev` database, no password, marked `noticeos.profile =
// 'development'`).
//
// The profile holds no secret. Every psql child runs with the PG* environment
// removed, no password file and no service file, so nothing outside the
// command line decides where it connects. (`checkedSession` is the exception:
// the operator-only scripts/postgres-apply.mjs gets the same transport, and a
// password reaches psql as PGPASSWORD.) Values cross as text and are cast in
// SQL; a number that is not a safe integer is refused.
//
// Shared memory: a server removes its System V segment when it exits but not
// when killed outright, and a sandbox that refuses shared memory lets the
// segment be made and then refuses it to the server. So before any server
// starts, the profile refuses where segments cannot be listed and removes the
// segments dead servers left. Every server is stopped in `stopServer`, on
// `close()`, on exit or an interrupt, and by a watchdog
// (scripts/postgres-watchdog.mjs) when this process is killed with SIGKILL.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVELOPMENT, PROFILE_SETTING } from './postgres-profile.mjs';
import { scramVerifier } from './postgres-scram.mjs';
import { MIGRATION_FILE } from './postgres-migration-files.mjs';
import { findPsql, findPostgres, MINIMUM_MAJOR } from './postgres-tools.mjs';

export { findPsql, findPostgres, MINIMUM_MAJOR };

export { DEVELOPMENT, PROFILE_SETTING };

export const MODEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'postgres');
export const MIGRATIONS_DIR = path.join(MODEL_DIR, 'migrations');
export const ROLES_SQL = path.join(MODEL_DIR, 'roles.sql');

/** The database a throwaway cluster holds; the mark every development
 * database carries is scripts/postgres-profile.mjs's. */
export const DEV_DATABASE = 'noticeos_dev';
/** The file that makes a folder a throwaway cluster this profile created. */
export const CLUSTER_MARKER = 'noticeos-dev-cluster.json';

/** The migration files in the order they apply: `NNNN_name.sql`. */
export function migrationFiles(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

/** The two synthetic workspaces the proof loads. */
export const PROOF_WORKSPACES = [
  { ws: '0000000a-0000-4000-8000-00000000000a', slug: 'a', site: 'a.example' },
  { ws: '0000000b-0000-4000-8000-00000000000b', slug: 'b', site: 'b.example' },
];

/** This machine cannot run a server: no binaries, an old version, or the OS
 * refused one (a sandbox without shared memory). Distinct from a failure of
 * the SQL under test, which is a plain Error. */
export class PostgresUnavailable extends Error {}

/** A target the development profile will not touch. Nothing was sent to it. */
export class DevelopmentProfileRefused extends Error {}

/** A psql command that failed; `message` carries psql's own words, and
 * `output` what it printed before it stopped. */
export class PsqlError extends Error {
  constructor(message, output = '') {
    super(message);
    this.output = output;
  }
}

function requireTools(tools) {
  if (!tools?.initdb || !tools.pgCtl || !tools.psql) {
    throw new PostgresUnavailable('no Postgres server binaries (initdb, pg_ctl, psql) on this machine');
  }
  return requireClient(tools);
}

/** The client alone: psql, 15 or later. */
function requireClient(tools) {
  if (!tools?.psql) throw new PostgresUnavailable('no psql on this machine; install the Postgres client (psql 15 or later)');
  if (!(tools.major >= MINIMUM_MAJOR)) {
    throw new PostgresUnavailable(`PostgreSQL ${MINIMUM_MAJOR} or later is required; this machine has ${tools.version}`);
  }
  return tools;
}

// ─── The psql transport ─────────────────────────────────────────────────────

/** How long a psql child waits to connect, in seconds. The operator's own
 * commands keep 5, so a wrong address is told within seconds; a throwaway
 * cluster's sessions wait 30, so a proof on a busy machine fails on what it
 * proves and not on connection time. */
export const OPERATOR_CONNECT_SECONDS = 5;
export const THROWAWAY_CONNECT_SECONDS = 30;

/** The environment every psql child gets: this process's, minus anything
 * libpq reads to decide where to connect or what to present, and a connect
 * wait of `connectSeconds` (the operator's unless a throwaway cluster's
 * session passes its own). */
export function psqlEnvironment(base = process.env, { connectSeconds = OPERATOR_CONNECT_SECONDS } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!/^PG/u.test(key) && key !== 'DATABASE_URL') env[key] = value;
  }
  return {
    ...env,
    LC_ALL: 'C',
    PGPASSFILE: os.devNull,
    PGSERVICEFILE: os.devNull,
    PGCONNECT_TIMEOUT: String(connectSeconds),
    PGAPPNAME: 'noticeos-dev',
  };
}

/** One psql variable value, as the text Postgres will cast. */
function variableText(name, value) {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(name)) throw new TypeError(`psql variable ${name}: letters, digits and _ only`);
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return String(value);
    throw new TypeError(`${name}: ${value} is not a safe integer; pass decimals and large numbers as strings or BigInt`);
  }
  if (value instanceof Date) return value.toISOString();
  throw new TypeError(`${name}: write NULL in the SQL; a variable is text, a number, a BigInt, a boolean or a Date`);
}

/** Parse CSV (RFC 4180) as COPY writes it: an unquoted empty field is NULL,
 * a quoted one the empty string. */
export function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let i = 0;
  const endField = () => {
    record.push(field === '' && !wasQuoted ? null : field);
    field = '';
    wasQuoted = false;
  };
  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (char === '"') quoted = false;
      else field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      wasQuoted = true;
    } else if (char === ',') {
      endField();
    } else if (char === '\n') {
      endField();
      records.push(record);
      record = [];
    } else if (char !== '\r') {
      field += char;
    }
    i += 1;
  }
  if (field !== '' || wasQuoted || record.length) {
    endField();
    records.push(record);
  }
  if (records.length === 0) return [];
  const [header, ...rows] = records;
  return rows.map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? null])));
}

/** A psql child's environment: the clean one with its connect wait, plus the
 * password of a checked target that needs one (`checkedSession`), which so
 * never reaches psql's command line. The development profile itself never
 * passes one. */
const childEnvironment = (password, connectSeconds) => {
  const env = psqlEnvironment(process.env, { connectSeconds });
  return password === null ? env : { ...env, PGPASSWORD: password };
};

function runPsql(tools, connection, { script = null, file = null, sql = null, vars = {}, format = 'csv', password = null, connectSeconds = OPERATOR_CONNECT_SECONDS } = {}) {
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', connection];
  args.push(...(format === 'csv' ? ['--csv'] : ['-A', '-t']));
  for (const [name, value] of Object.entries(vars)) args.push('-v', `${name}=${variableText(name, value)}`);
  if (file) args.push('-f', file);
  else if (sql !== null) args.push('-c', sql);
  else args.push('-f', '-');
  const result = spawnSync(tools.psql, args, {
    encoding: 'utf8',
    env: childEnvironment(password, connectSeconds),
    input: script ?? undefined,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new PsqlError((result.stderr || `psql exited ${result.status}`).trim(), result.stdout ?? '');
  }
  return result.stdout;
}

/**
 * A connection to one development database. `run(sql, { vars })` runs SQL
 * through psql's reader (psql variables `:'name'` are interpolated as quoted
 * text) and returns what it printed; `script` returns that as rows of psql's
 * CSV, and `sql(text)` sends one command string as it is and returns its rows
 * (psql's CSV prints NULL and '' alike, so both read as null: for catalog and
 * bookkeeping reads; `inWorkspace` reads data exactly); `file(path)` runs a
 * file; `text(sql)` returns unaligned, tuples-only output. Every call is its
 * own connection; a transaction is what one call's script holds, and each
 * waits `connectSeconds` to connect.
 */
function session(tools, connection, where, password = null, connectSeconds = OPERATOR_CONNECT_SECONDS) {
  const psql = (options) => runPsql(tools, connection, { ...options, password, connectSeconds });
  return {
    tools,
    where,
    connection,
    run: (script, { vars = {} } = {}) => psql({ script, vars }),
    script: (script, { vars = {} } = {}) => parseCsv(psql({ script, vars })),
    sql: (sql) => parseCsv(psql({ sql })),
    text: (sql) => psql({ sql, format: 'text' }),
    file: (file, { vars = {} } = {}) => psql({ file, vars, format: 'text' }),
    /** A psql child that holds this connection open, for proofs of concurrency. */
    spawnInteractive: () =>
      spawn(tools.psql, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', connection], {
        env: childEnvironment(password, connectSeconds),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
  };
}

/**
 * A session on a database the caller has checked itself: the one way in for
 * scripts/postgres-apply.mjs. Nothing in this profile calls it. `parts` are
 * libpq keywords and values, quoted here; `password` reaches psql only
 * through its environment. Needs psql alone, not the server binaries.
 *
 * @param {Record<string, string>} parts
 * @param {{ where: string, password?: string | null, tools?: ReturnType<typeof findPsql> }} options
 */
export function checkedSession(parts, { where, password = null, tools = findPsql() }) {
  const connection = Object.entries(parts).map(([key, value]) => pair(key, value)).join(' ');
  return { ...session(requireClient(tools), connection, where, password), close() {} };
}

// ─── The two ways in ────────────────────────────────────────────────────────

/** The parameters a development URL may carry: neither changes which server it reaches. */
const URL_PARAMETERS = new Set(['host', 'user']);
const LOOPBACK = new Map([
  ['localhost', 'localhost'],
  ['127.0.0.1', '127.0.0.1'],
  ['[::1]', '::1'],
]);

/** A URL for messages: its password, and every parameter value but host=
 * and user=, masked. */
export function redactUrl(url) {
  return String(url)
    .replace(/(\/\/[^:/@]*):[^@/]*@/u, '$1:***@')
    .replace(/([?&](?!host=|user=)[^=&#]+=)[^&#]*/gu, '$1***');
}

/** One libpq keyword/value pair, quoted. */
const pair = (key, value) => `${key}='${String(value).replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;

/**
 * Check a connection string BEFORE anything connects: this machine only, a
 * database whose name ends in _dev, no password, no parameter but host= (a
 * socket folder) and user=. Returns the libpq connection string psql will
 * use, built from the checked parts alone, so no other reading of the URL can
 * send it anywhere else. Throws DevelopmentProfileRefused otherwise.
 */
export function checkDevelopmentUrl(raw) {
  const shown = redactUrl(raw);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new DevelopmentProfileRefused(`not a postgres:// URL: ${shown}`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new DevelopmentProfileRefused(`not a postgres:// URL: ${shown}`);
  }
  if (url.password) {
    throw new DevelopmentProfileRefused(
      `a development database needs no password; use a local trust or peer login (${shown})`,
    );
  }
  for (const key of url.searchParams.keys()) {
    if (!URL_PARAMETERS.has(key)) {
      throw new DevelopmentProfileRefused(
        `the parameter "${key}" could send this elsewhere; only host= (a socket folder) and user= are accepted (${shown})`,
      );
    }
  }
  if (url.searchParams.getAll('host').length > 1 || url.searchParams.getAll('user').length > 1) {
    throw new DevelopmentProfileRefused(`name one host and one user (${shown})`);
  }
  const socketFolder = url.searchParams.get('host');
  if (socketFolder !== null && (!path.isAbsolute(socketFolder) || socketFolder.includes(','))) {
    throw new DevelopmentProfileRefused(`host= must be one local socket folder (an absolute path) (${shown})`);
  }
  if (url.hostname && !LOOPBACK.has(url.hostname)) {
    throw new DevelopmentProfileRefused(`not a local database: ${url.hostname} is not this machine (${shown})`);
  }
  if (url.hostname && socketFolder !== null) {
    throw new DevelopmentProfileRefused(`name a local host or a socket folder, not both (${shown})`);
  }
  if (!url.hostname && socketFolder === null) {
    throw new DevelopmentProfileRefused(`name the local host or socket folder explicitly (${shown})`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  if (!/^[a-z0-9_]+_dev$/u.test(database)) {
    throw new DevelopmentProfileRefused(
      `not a development database: its name must end in _dev, like ${DEV_DATABASE} (${shown})`,
    );
  }
  const user = url.searchParams.get('user') ?? (url.username ? decodeURIComponent(url.username) : null);
  return [
    pair('host', socketFolder ?? LOOPBACK.get(url.hostname)),
    ...(url.port ? [pair('port', url.port)] : []),
    pair('dbname', database),
    ...(user ? [pair('user', user)] : []),
  ].join(' ');
}

/** Refuse a database that does not itself say it is for development. */
function requireDevelopmentMark(target) {
  const [row] = target.sql(`SELECT current_setting('${PROFILE_SETTING}', true) AS profile, current_database() AS database`);
  if (row?.profile !== DEVELOPMENT) {
    throw new DevelopmentProfileRefused(
      `${target.where} is not marked for development; if it is a throwaway database, run once: ` +
        `ALTER DATABASE ${row?.database ?? DEV_DATABASE} SET ${PROFILE_SETTING} = '${DEVELOPMENT}'`,
    );
  }
  const [version] = target.sql('SHOW server_version_num');
  const major = Math.floor(Number(version?.server_version_num) / 10000);
  if (!(major >= MINIMUM_MAJOR)) {
    throw new DevelopmentProfileRefused(`${target.where} runs PostgreSQL ${major}; ${MINIMUM_MAJOR} or later is required`);
  }
}

/** A session on a local development database named by URL. */
export function openDevelopmentUrl(raw, tools = findPostgres()) {
  const connection = checkDevelopmentUrl(raw);
  const target = session(requireTools(tools), connection, redactUrl(raw));
  requireDevelopmentMark(target);
  return { ...target, close() {} };
}

function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', env: psqlEnvironment() });
  if (result.status !== 0) {
    throw new Error(`${path.basename(bin)} ${args[0] ?? ''} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

// ─── Shared memory: what a server holds, and what a dead one leaves ────────

/** The System V segment a running server (15 or later) holds: only a 56-byte
 * header, mode 0600, since the real shared memory is anonymous. The
 * postmaster and every child stay attached, and the server checks that
 * count before it starts, so a segment nobody is attached to, made by a
 * process that has exited, is a dead server's. A server started again in
 * the same folder would remove it itself; a throwaway folder never is. */
export const SERVER_SEGMENT = { bytes: 56, mode: 0o600 };

/** Permission bits from `ipcs`' `--rw-------` or /proc's octal `600`. */
function modeBits(text) {
  if (/^[0-7]+$/u.test(text)) return Number.parseInt(text, 8) & 0o777;
  return [...text.slice(-9)].reduce((mode, char) => mode * 2 + (char === '-' ? 0 : 1), 0);
}

/** One whitespace-separated table row, by the header's column names. */
const byColumn = (names, line) => Object.fromEntries(line.split(/\s+/u).map((value, index) => [names[index], value]));

/**
 * Shared-memory segments as `{ id, key, mode, owner, creator, attached,
 * bytes, creatorPid }`, from `ipcs -m -a` (macOS and the BSDs: owner and
 * creator are user names) or Linux's /proc/sysvipc/shm (user ids). Null for
 * a listing in neither form.
 */
export function parseSegments(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const header = lines.findIndex((line) => /^T\s+ID\s+KEY\s+MODE\s+OWNER\s/u.test(line));
  if (header >= 0) {
    const names = lines[header].split(/\s+/u);
    return lines
      .filter((line) => /^m\s/u.test(line))
      .map((line) => byColumn(names, line))
      .map((row) => ({
        id: Number(row.ID),
        key: row.KEY,
        mode: modeBits(row.MODE),
        owner: row.OWNER,
        creator: row.CREATOR,
        attached: Number(row.NATTCH),
        bytes: Number(row.SEGSZ),
        creatorPid: Number(row.CPID),
      }));
  }
  if (/^key\s+shmid\s+perms\s+size\s+cpid\s+lpid\s+nattch\s+uid\s+gid\s+cuid\s/u.test(lines[0] ?? '')) {
    const names = lines[0].split(/\s+/u);
    return lines.slice(1).map((line) => {
      const row = byColumn(names, line);
      return {
        id: Number(row.shmid),
        key: `0x${(Number(row.key) >>> 0).toString(16).padStart(8, '0')}`,
        mode: modeBits(row.perms),
        owner: row.uid,
        creator: row.cuid,
        attached: Number(row.nattch),
        bytes: Number(row.size),
        creatorPid: Number(row.cpid),
      };
    });
  }
  return null;
}

/**
 * This machine's segments, read through `tools` (Linux's /proc file, else
 * `ipcs`), or null where neither exists or the listing reads as neither
 * form: then nothing is swept. Throws PostgresUnavailable where the OS
 * refuses the listing, as a sandbox does: the same sandbox lets a server
 * make its segment and then refuses it to the server, which cannot remove
 * what it never got, so starting one there would leave a segment behind.
 */
export function listSharedMemory(tools) {
  const refused = (why) =>
    new PostgresUnavailable(
      `this process may not use System V shared memory (${why}); a Postgres server started here would leave its segment behind, so none is started`,
    );
  if (tools.segmentsFile) {
    try {
      return parseSegments(readFileSync(tools.segmentsFile, 'utf8'));
    } catch (error) {
      throw refused(`${tools.segmentsFile}: ${error.code ?? error.message}`);
    }
  }
  if (!tools.ipcs) return null;
  const result = spawnSync(tools.ipcs, ['-m', '-a'], { encoding: 'utf8', env: psqlEnvironment() });
  if (result.error || result.status !== 0) {
    throw refused((result.stderr || result.error?.message || `ipcs exited ${result.status}`).trim().split('\n')[0]);
  }
  return parseSegments(result.stdout);
}

/** Whether process `pid` exists. Signal 0 checks without sending anything;
 * EPERM means it runs as someone else. Not a positive pid counts as alive,
 * so nothing is removed on a guess. */
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/** How a listing names this process's user: by name (`ipcs`) or by id (/proc,
 * and `ipcs` for a user id with no name, as in some containers). */
function thisUser() {
  const names = new Set([String(process.getuid())]);
  try {
    names.add(os.userInfo().username);
  } catch {
    // No name for this user id: the id alone identifies it.
  }
  return names;
}

/**
 * The segments dead servers left: this user's own (as owner and creator),
 * exactly a server's size and mode, attached by nobody, and made by a
 * process that has exited. Never an attached segment, one whose creator
 * still runs (it may be a server starting), another user's, or any other.
 */
export function orphanedServerSegments(segments, { alive = processAlive, user = thisUser() } = {}) {
  return segments.filter(
    (segment) =>
      user.has(segment.owner) &&
      user.has(segment.creator) &&
      segment.bytes === SERVER_SEGMENT.bytes &&
      segment.mode === SERVER_SEGMENT.mode &&
      segment.attached === 0 &&
      !alive(segment.creatorPid),
  );
}

function removeSegment(tools, id) {
  if (!tools?.ipcrm) return 'no ipcrm on this machine';
  const result = spawnSync(tools.ipcrm, ['-m', String(id)], { encoding: 'utf8', env: psqlEnvironment() });
  return result.status === 0 ? null : (result.stderr || result.error?.message || `ipcrm exited ${result.status}`).trim();
}

/**
 * Remove each segment `orphanedServerSegments` names from `segments` (a
 * listing; null sweeps nothing) and log every removal, or why one failed.
 * Returns the segments removed.
 */
export function sweepOrphanedSegments(
  segments,
  { tools = null, alive = processAlive, user = thisUser(), remove = (id) => removeSegment(tools, id), log = (line) => process.stderr.write(`${line}\n`) } = {},
) {
  if (!segments) return [];
  const removed = [];
  for (const segment of orphanedServerSegments(segments, { alive, user })) {
    const failure = remove(segment.id);
    if (failure) {
      log(`postgres-dev: could not remove the orphaned shared-memory segment ${segment.id} (key ${segment.key}): ${failure}`);
      continue;
    }
    removed.push(segment);
    log(
      `postgres-dev: removed the orphaned shared-memory segment ${segment.id} (key ${segment.key}): nothing attached, and process ${segment.creatorPid}, which made it, has exited`,
    );
  }
  return removed;
}

// ─── Stopping a server, in one place ────────────────────────────────────────

/** Servers this process started and has not yet seen stop: data folder → its tools and private socket folder. */
const running = new Map();

/** The postmaster's pid from `data`/postmaster.pid while that process runs, else null. */
function serverPid(data) {
  try {
    const pid = Number(readFileSync(path.join(data, 'postmaster.pid'), 'utf8').split('\n')[0]);
    return Number.isSafeInteger(pid) && pid > 0 && processAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Stop the server in `data` and wait, bounded: a fast shutdown (sessions
 * ended, a checkpoint) for up to `seconds`, then, if it still runs, an
 * immediate one (no checkpoint, which a throwaway never needs). A server
 * removes its shared-memory segment on either. Returns null once it is
 * stopped, else what pg_ctl said.
 */
function stopServer(pgCtl, data, { mode = 'fast', seconds = 15 } = {}) {
  let said = '';
  const attempt = (how, wait) => {
    const result = spawnSync(pgCtl, ['-D', data, '-m', how, '-w', '-t', String(wait), 'stop'], {
      encoding: 'utf8',
      env: psqlEnvironment(),
      timeout: (wait + 5) * 1000,
    });
    said = (result.stderr || result.stdout || result.error?.message || '').trim();
  };
  if (serverPid(data) !== null) attempt(mode, seconds);
  if (serverPid(data) !== null && mode !== 'immediate') attempt('immediate', 10);
  if (serverPid(data) !== null) return said || `the server in ${data} is still running`;
  const owned = running.get(data);
  if (owned) rmSync(owned.socketDir, { recursive: true, force: true });
  running.delete(data);
  return null;
}

/** The signals that end a command or a test run early. Exit covers every
 * other ending but SIGKILL, which no process can answer: the watchdog does. */
const INTERRUPTS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
let stopsOnExit = false;

/** The watchdog (scripts/postgres-watchdog.mjs) that stops this process's
 * servers once it is gone, even killed with SIGKILL. */
const WATCHDOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'postgres-watchdog.mjs');
let watchdog = null;

/**
 * Tell this process's watchdog about a server in `data` listening in
 * `socketDir` — before pg_ctl starts it, so a command killed while its server
 * is still starting is covered too — and again with `started` once the start
 * has returned. The first call starts the watchdog: detached, reading one
 * line per report from a pipe only this process holds, keeping nothing alive
 * here. When the pipe closes it stops each server reported to it. Returns
 * the watchdog's pid, or null where none could start.
 */
function watchServer(data, socketDir, { started = false } = {}) {
  if (!watchdog || watchdog.exitCode !== null || watchdog.signalCode !== null) {
    // No environment: it needs none, and a test runner's settings (NODE_OPTIONS,
    // NODE_TEST_CONTEXT) must not reach it.
    watchdog = spawn(process.execPath, [WATCHDOG], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: {} });
    watchdog.on('error', () => undefined);
    watchdog.stdin.on('error', () => undefined);
    watchdog.unref();
    watchdog.stdin.unref();
  }
  watchdog.stdin.write(`${JSON.stringify(started ? { data, socketDir, started } : { data, socketDir })}\n`);
  return watchdog.pid ?? null;
}

/** Stop every server still running, immediately: this process is ending. */
function stopEveryServer() {
  for (const [data, { pgCtl }] of running) stopServer(pgCtl, data, { mode: 'immediate', seconds: 10 });
}

/** Remember a started server, and stop it however this process ends, but SIGKILL. */
function stopOnExit(pgCtl, data, socketDir) {
  running.set(data, { pgCtl, socketDir });
  if (stopsOnExit) return;
  stopsOnExit = true;
  process.on('exit', stopEveryServer);
  for (const signal of INTERRUPTS) {
    const onSignal = () => {
      stopEveryServer();
      // Alone, end the way the signal would have ended the process; beside
      // another listener (node --test has its own), that listener decides.
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, onSignal);
        process.kill(process.pid, signal);
      }
    };
    process.on(signal, onSignal);
  }
}

// The loopback mode: how a Worker reaches a throwaway cluster. A Hyperdrive
// binding is locally a TCP pipe from workerd, which opens no unix socket, and
// Miniflare refuses a local connection string without a password. So a
// throwaway cluster can also listen on one loopback address and port, for
// noticeos_app alone, with the password `applicationLogin()` sets: made in
// this process, sent on psql's standard input, kept in memory only. The owner
// still reaches it only on the private socket.

/** The one address the loopback mode listens on. */
export const LOOPBACK_ADDRESS = '127.0.0.1';
/** The one role the loopback mode lets in over TCP. */
export const LOOPBACK_ROLE = 'noticeos_app';
/** The client-authentication file a loopback start writes into its cluster folder. */
export const LOOPBACK_HBA = 'pg_hba.loopback.conf';

/** The client authentication of a loopback start: the owner on the private
 * socket, the application role over loopback by password, nothing else. */
export function loopbackHba() {
  return [
    '# Written by scripts/postgres-dev.mjs for a throwaway cluster in loopback mode; rewritten on every start.',
    '# The private socket folder, which only the process that started the server can reach.',
    'local all all trust',
    '# Over TCP: the application role alone, from this machine alone, by the password this start set.',
    `host all ${LOOPBACK_ROLE} ${LOOPBACK_ADDRESS}/32 scram-sha-256`,
    '# No other line matches, so every other TCP connection is refused.',
    '',
  ].join('\n');
}

/**
 * The owner's session on `database` of a throwaway cluster this machine runs,
 * through its private socket folder: what a test process uses to reach a
 * cluster another process of the same run started
 * (scripts/postgres-test-cluster.mts). `port` names the socket file (null for
 * a socket-only cluster, whose server runs on the default port). Its psql
 * children wait a throwaway cluster's time to connect
 * (THROWAWAY_CONNECT_SECONDS).
 *
 * @param {{ tools?: ReturnType<typeof findPostgres>, socketDir: string, port?: number | null, database: string, where?: string }} target
 */
export function socketSession({ tools = findPostgres(), socketDir, port = null, database, where = `throwaway cluster on ${socketDir}` }) {
  if (typeof socketDir !== 'string' || !path.isAbsolute(socketDir)) throw new TypeError('a socket folder is an absolute path');
  if (!/^[a-z0-9_]+$/u.test(database ?? '')) throw new TypeError(`a database name is lower-case letters, digits and _, not ${database}`);
  const connection = [pair('host', socketDir), ...(port === null ? [] : [pair('port', checkLoopbackPort(port))]), pair('dbname', database), pair('user', 'postgres')];
  return session(requireTools(tools), connection.join(' '), where, null, THROWAWAY_CONNECT_SECONDS);
}

/** A port the loopback mode may take: a whole number from 1024 to 65535. */
function checkLoopbackPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new DevelopmentProfileRefused(`a loopback port is a whole number from 1024 to 65535, not ${String(port)}`);
  }
  return port;
}

/**
 * Start the throwaway cluster kept in `dir` (creating it when the folder is
 * missing or empty) and return a session on its development database.
 * `close()` stops the server; the folder stays for the next command. A
 * folder holding anything but a cluster this profile made is refused
 * untouched. Before any server runs (initdb runs one too), it refuses where
 * shared memory cannot be listed and removes the segments dead servers left
 * (`removedSegments` are the ones this start removed). `loopbackPort` starts
 * it in loopback mode; without it, it listens on no TCP port at all.
 *
 * @param {string} dir
 * @param {ReturnType<typeof findPostgres>} [tools]
 * @param {{ loopbackPort?: number | null }} [options]
 */
export function openThrowaway(dir, tools = findPostgres(), { loopbackPort = null } = {}) {
  const found = requireTools(tools);
  const root = path.resolve(dir);
  const data = path.join(root, 'data');
  const marker = path.join(root, CLUSTER_MARKER);
  const port = loopbackPort === null ? null : checkLoopbackPort(loopbackPort);
  if (port !== null && /['\s\\]/u.test(root)) {
    throw new DevelopmentProfileRefused(`a loopback cluster's folder path may hold no quote, space or backslash: ${root}`);
  }
  const fresh = !existsSync(root) || readdirSync(root).length === 0;
  if (!fresh && !existsSync(marker)) {
    throw new DevelopmentProfileRefused(
      `${root} is not empty and is not a throwaway cluster made by this profile (no ${CLUSTER_MARKER}); choose an empty folder`,
    );
  }
  const removedSegments = sweepOrphanedSegments(listSharedMemory(found), { tools: found });
  if (fresh) {
    mkdirSync(root, { recursive: true });
    try {
      // PostgreSQL 17 added the builtin Unicode codepoint locale used by the
      // pinned fresh-install host. Older local binaries retain their argv.
      const locale = found.major >= 17 ? ['--locale-provider=builtin', '--builtin-locale=C.UTF-8'] : [];
      run(found.initdb, ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-sync', '-E', 'UTF8', '--no-instructions', ...locale]);
    } catch (error) {
      rmSync(data, { recursive: true, force: true });
      throw new PostgresUnavailable(`a throwaway Postgres could not be created here: ${error.message.split('\n')[0]}`);
    }
    writeFileSync(
      marker,
      `${JSON.stringify({ profile: DEVELOPMENT, createdBy: 'scripts/postgres-dev.mjs', createdAt: new Date().toISOString(), server: found.version }, null, 2)}\n`,
    );
  } else {
    const recorded = JSON.parse(readFileSync(marker, 'utf8'));
    if (recorded.profile !== DEVELOPMENT) throw new DevelopmentProfileRefused(`${marker} does not mark a development cluster`);
  }
  // The socket lives in its own short private folder: a unix socket path has
  // a ~100-byte limit, and a private folder keeps other users off it.
  const socketDir = mkdtempSync(path.join(os.tmpdir(), 'nos-'));
  // Loopback mode: this start's client authentication, and room for the
  // Workers' pools (each store opens up to five connections, and a test run
  // has one store per Worker runtime).
  let listen = `-c listen_addresses='' -c max_connections=12`;
  if (port !== null) {
    const hba = path.join(root, LOOPBACK_HBA);
    writeFileSync(hba, loopbackHba(), { mode: 0o600 });
    listen = `-c listen_addresses=${LOOPBACK_ADDRESS} -c port=${port} -c hba_file='${hba}' -c max_connections=100`;
  }
  const watchdogPid = watchServer(data, socketDir);
  const start = (extra) =>
    run(found.pgCtl, [
      '-D', data,
      '-l', path.join(root, 'server.log'),
      '-w',
      '-o', `${listen} -k ${socketDir} -c fsync=off -c shared_buffers=16MB -c TimeZone=UTC${extra}`,
      'start',
    ]);
  // pg_stat_statements is loaded at start; a server build without it starts
  // without, and `queryStatistics` is false. A start pg_ctl gave up waiting
  // for may still be running, so each failed start is stopped first.
  let queryStatistics = true;
  try {
    try {
      start(' -c shared_preload_libraries=pg_stat_statements');
    } catch {
      queryStatistics = false;
      stopServer(found.pgCtl, data, { mode: 'immediate', seconds: 10 });
      start('');
    }
  } catch (error) {
    const stillRunning = stopServer(found.pgCtl, data, { mode: 'immediate', seconds: 10 });
    if (!stillRunning) rmSync(socketDir, { recursive: true, force: true });
    throw new PostgresUnavailable(`a throwaway Postgres could not start here: ${error.message.split('\n')[0]}`);
  }
  stopOnExit(found.pgCtl, data, socketDir);
  watchServer(data, socketDir, { started: true });
  const stop = () => {
    const stillRunning = stopServer(found.pgCtl, data);
    if (stillRunning) process.stderr.write(`postgres-dev: the throwaway Postgres in ${data} did not stop: ${stillRunning}\n`);
  };
  try {
    // The owner's way in: the private socket, whose file is named after the
    // port the server runs on.
    const onSocket = (database) => socketSession({ tools: found, socketDir, port, database, where: `throwaway cluster ${root}` });
    const admin = onSocket('postgres');
    const [exists] = admin.sql(`SELECT count(*) AS n FROM pg_database WHERE datname = '${DEV_DATABASE}'`);
    if (exists.n === '0') {
      admin.sql(`CREATE DATABASE ${DEV_DATABASE}`);
      admin.sql(`ALTER DATABASE ${DEV_DATABASE} SET ${PROFILE_SETTING} = '${DEVELOPMENT}'`);
    }
    const target = onSocket(DEV_DATABASE);
    requireDevelopmentMark(target);
    if (queryStatistics) target.sql('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    const loopback =
      port === null
        ? {}
        : {
            loopbackPort: port,
            /** The owner's session on another database of this cluster (a
             * test's own copy of the template, say): the private socket only. */
            onDatabase: onSocket,
            /**
             * Give noticeos_app a login with a new password (the roles exist
             * once the first `apply` has run) and return `url(database)`: its
             * loopback connection string for one of this cluster's databases,
             * the string a Hyperdrive binding's localConnectionString takes.
             * Only this process ever holds the password.
             */
            applicationLogin() {
              const password = randomBytes(24).toString('base64url');
              target.run(`ALTER ROLE ${LOOPBACK_ROLE} LOGIN PASSWORD '${scramVerifier(password)}';\n`);
              return {
                url: (database = DEV_DATABASE) => {
                  if (!/^[a-z0-9_]+$/u.test(database)) throw new TypeError(`a database name is lower-case letters, digits and _, not ${database}`);
                  return `postgresql://${LOOPBACK_ROLE}:${password}@${LOOPBACK_ADDRESS}:${port}/${database}?sslmode=disable`;
                },
              };
            },
          };
    return { ...target, socketDir, root, queryStatistics, watchdogPid, removedSegments, ...loopback, close: stop };
  } catch (error) {
    stop();
    throw error;
  }
}

/**
 * Run `fn(dev)` against a brand-new throwaway cluster in a temporary folder,
 * always stopping it and deleting the folder afterwards. `dev` is the session
 * `openThrowaway` returns, plus `psql(sql, { file })`: superuser SQL (or a
 * file) on the development database with ON_ERROR_STOP, returning unaligned,
 * tuples-only output — what the proofs read.
 */
export async function withDisposablePostgres(fn, tools = findPostgres()) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pgd-'));
  let dev = null;
  try {
    dev = openThrowaway(root, tools);
    const psql = (sql, { file = null } = {}) => (file ? dev.file(file) : dev.text(sql));
    return await fn({ ...dev, psql, socketDir: dev.socketDir });
  } finally {
    dev?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Explicit transactions for the application's writes ────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ROLES = { app: 'noticeos_app', owner: 'noticeos_owner' };

/**
 * Run `sql` (statements that return no rows; null for none) and then `read`
 * (one SELECT, optional) in ONE explicit transaction that names its workspace
 * and acts as the application role (or, to provision, the owner): BEGIN, SET
 * LOCAL ROLE, SET LOCAL noticeos.workspace_id, SET LOCAL TimeZone = UTC, the
 * SQL, the read, COMMIT. Any error stops psql before COMMIT, so the
 * transaction rolls back whole. `vars` are psql variables (`:'name'` in the
 * SQL, cast there); the workspace is also `:'workspace_id'`. Returns the
 * read's rows as the server's own text, through COPY CSV so NULL (null) and
 * the empty string ('') stay apart; [] without a read.
 */
export function inWorkspace(dev, workspaceId, sql, { vars = {}, role = 'app', read = null } = {}) {
  if (!UUID.test(String(workspaceId))) throw new TypeError(`workspace id ${workspaceId} is not a lower-case UUID`);
  if (!ROLES[role]) throw new TypeError(`role is app or owner, not ${role}`);
  if ('workspace_id' in vars) throw new TypeError('workspace_id is set by inWorkspace itself');
  for (const [name, value] of Object.entries(vars)) variableText(name, value);
  const script = [
    'BEGIN;',
    `SET LOCAL ROLE ${ROLES[role]};`,
    "SET LOCAL noticeos.workspace_id = :'workspace_id';",
    "SET LOCAL TimeZone = 'UTC';",
    sql ? sql.trim().replace(/;?$/u, ';') : '',
    read ? `COPY (${read.trim().replace(/;$/u, '')}) TO STDOUT WITH (FORMAT csv, HEADER);` : '',
    'COMMIT;',
    '',
  ].join('\n');
  return parseCsv(dev.run(script, { vars: { ...vars, workspace_id: workspaceId } }));
}

/** Provision a workspace (as the owner, inside its own id) and return its id. */
export function createWorkspace(dev, { slug, displayName = slug, workspaceId = crypto.randomUUID() }) {
  inWorkspace(
    dev,
    workspaceId,
    "INSERT INTO noticeos.workspaces (workspace_id, slug, display_name) VALUES (:'workspace_id'::uuid, :'slug', :'display_name')",
    { vars: { slug, display_name: displayName }, role: 'owner' },
  );
  return workspaceId;
}
