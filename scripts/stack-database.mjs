// The stack's database, as Compose and Postgres themselves report it: the
// secrets folder is wherever the stack's own declaration puts the owner's
// secret, and the migration check asks Postgres over its container's socket,
// where the profile's pg_hba.conf admits only the `postgres` user. Read-only:
// nothing here opens a migration path, and an address never reaches a command
// line, a log or the screen.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { codeMigrationVersions } from './database-address.mjs';
import { DATABASE } from './postgres-secrets.mjs';
import { runCommand } from './run-command.mjs';

/** The secret the owner's login is created from (db/postgres/host/compose.yaml). */
const OWNER_SECRET = 'noticeos_owner';

/** `docker compose` for the selected stack, as every os:* command addresses it. */
export function composePrefix(selector) {
  return ['--host', selector.dockerHost, 'compose', '--project-name', selector.project,
    ...selector.files.flatMap((file) => ['-f', file]), '--env-file', selector.envFile];
}

const ownEnv = (env) => Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'XDG_CONFIG_HOME'].filter((key) => env[key] !== undefined).map((key) => [key, env[key]]));

/**
 * The stack's Postgres secrets folder: the one holding the owner's secret in
 * the stack's resolved declaration (`docker compose config`). Throws a
 * sentence naming the fix; the declaration itself is never printed.
 */
export async function stackSecretsDir(selector, { run = runCommand, env = process.env } = {}) {
  const result = await run('docker', [...composePrefix(selector), 'config', '--format', 'json'], { env: ownEnv(env), timeoutMs: 20_000 });
  if (result.code !== 0) throw new Error('Compose could not read the stack\'s declaration; is Docker running?');
  let file;
  try { file = JSON.parse(result.stdout)?.secrets?.[OWNER_SECRET]?.file; } catch { /* reported below */ }
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    throw new Error(`the stack declares no ${OWNER_SECRET} secret file`);
  }
  return path.dirname(file);
}

/** One login's address and the database it names, from `<folder>/<file>`. */
export function secretAddress(folder, file = 'owner.url', io = { readFileSync, existsSync }) {
  const where = path.join(folder, file);
  if (!io.existsSync(where)) {
    throw new Error(`no ${file} in the stack's Postgres secrets folder ${folder}`);
  }
  const url = io.readFileSync(where, 'utf8').trim();
  let database;
  try {
    database = decodeURIComponent(new URL(url).pathname.replace(/^\//u, ''));
  } catch {
    throw new Error(`${where} does not hold a postgresql:// address`);
  }
  if (!database) throw new Error(`${where} names no database`);
  return { url, database, where };
}

/**
 * Whether the stack's database has every migration in `root`'s
 * db/postgres/migrations, read in a read-only session. `{ ok: true }` or
 * `{ ok: false, line }` naming what to do; never throws.
 */
export async function stackDatabaseCurrent(selector, { root, run = runCommand, env = process.env } = {}) {
  let result;
  try {
    result = await run('docker', [...composePrefix(selector), 'exec', '-T', 'postgres',
      'psql', '-U', 'postgres', '-d', DATABASE, '-qAtX', '-v', 'ON_ERROR_STOP=1',
      '-c', 'SET default_transaction_read_only = on',
      '-c', 'SELECT version FROM noticeos_migrations.applied ORDER BY version'], { env: ownEnv(env), timeoutMs: 20_000 });
  } catch {
    result = { code: 1 };
  }
  if (result.code !== 0) {
    return { ok: false, line: 'the stack\'s Postgres did not answer which migrations it has; pnpm os:logs -- postgres shows why' };
  }
  const applied = new Set(String(result.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean).map(Number));
  const behind = codeMigrationVersions(path.join(root, 'db', 'postgres', 'migrations')).filter((version) => !applied.has(version));
  if (behind.length > 0) {
    return { ok: false, line: `it is ${behind.length} migration${behind.length === 1 ? '' : 's'} behind this checkout; pnpm os:migrate -- --apply brings it up to date` };
  }
  return { ok: true };
}
