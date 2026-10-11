// Where the stack's database is, read from the host: the stack selector
// (.local/stack.json) names the Compose files and env file, and the stack's
// Postgres secrets folder holds each login's address (scripts/postgres-secrets.mjs).
// Read-only: nothing here opens a migration path, and an address never
// reaches a command line, a log or the screen.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { checkDatabase } from './database-address.mjs';
import { ADDRESS_FILE, SECRETS_DIR_VARIABLE } from './postgres-secrets.mjs';

/** `KEY=value` lines of a Compose env file; quotes are stripped, comments skipped. */
export function readEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    const raw = match[2];
    values[match[1]] = /^(['"]).*\1$/u.test(raw) ? raw.slice(1, -1) : raw.replace(/\s+#.*$/u, '');
  }
  return values;
}

/** The stack's Postgres secrets folder: the env file's NOTICEOS_POSTGRES_SECRETS,
 * relative to the Compose file that declares it, else `secrets` beside that file. */
export function stackSecretsDir(selector, io = { readFileSync, existsSync }) {
  const declaring = selector.files.find((file) => io.readFileSync(file, 'utf8').includes(SECRETS_DIR_VARIABLE)) ?? selector.files[0];
  const base = path.dirname(declaring);
  const named = readEnvFile(io.readFileSync(selector.envFile, 'utf8'))[SECRETS_DIR_VARIABLE];
  return named ? path.resolve(base, named) : path.join(base, 'secrets');
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
 * db/postgres/migrations, asked as the application login and only read.
 * `{ ok: true }` or `{ ok: false, line }` naming what to do; never throws.
 */
export async function stackDatabaseCurrent(selector, { root, io, check = checkDatabase } = {}) {
  let address;
  try {
    address = secretAddress(stackSecretsDir(selector, io), ADDRESS_FILE, io);
  } catch (error) {
    return { ok: false, line: error.message };
  }
  return check({ url: address.url }, { where: address.where, migrationsDir: path.join(root, 'db', 'postgres', 'migrations') });
}
