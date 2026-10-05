#!/usr/bin/env node
// THE POSTGRES SERVICE'S SECRET FILES (bead ro-ujb9.76.12): `pnpm
// postgres:secrets`, run once by the operator before the Compose service's
// first start (db/postgres/host/README.md, step 1).
//
//   pnpm postgres:secrets [--dir <folder>] [--port <n>]
//
// It makes a new password for each NoticeOS login and writes, into a folder
// only this account may open (default db/postgres/host/secrets, which git
// ignores):
//
//   noticeos_owner, noticeos_maint, noticeos_app
//       each login's SCRAM-SHA-256 verifier: what the service's first start
//       gives the server (compose.yaml mounts each at /run/secrets/<name>).
//       A verifier lets the server check a password; it is not one.
//   postgres
//       the superuser's verifier, of a password thrown away at once: the
//       superuser logs in only on the container's own socket.
//   database.url
//       the application's connection string, kept as the bootstrap secret
//       DATABASE_URL from the switch on (docs/06-operations.md, "Bootstrap
//       secrets vs. integration credentials").
//   owner.url, maint.url
//       the owner's and the maintenance role's connection strings, for the
//       operator's schema and maintenance commands.
//
// The folder is this account's alone (0700). A verifier file is readable
// inside it (0644), because the container reads it as its own postgres user;
// a connection string, which holds a password, is this account's only (0600).
// Nothing is printed but the files' names and the next step, and a file that
// exists is never replaced: the running service's logins were made from it.
//
// Exit codes: 0 written, 1 failed, 2 refused (nothing written).

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { scramVerifier } from './postgres-scram.mjs';
import { invokedDirectly } from './os-runtime.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The variable compose.yaml reads for the folder this command wrote, when it
 * is not the default. */
export const SECRETS_DIR_VARIABLE = 'NOTICEOS_POSTGRES_SECRETS';

/**
 * The folder the Compose profile reads its secrets from, resolved as
 * compose.yaml resolves it: `NOTICEOS_POSTGRES_SECRETS`, relative to
 * compose.yaml's own folder, or `secrets` beside it. `pnpm start` takes a new
 * installation's database address from here (scripts/start.mjs, bead
 * ro-ujb9.76.7.3).
 */
export function composeSecretsDir(env = process.env, root = REPO_ROOT) {
  const profile = path.join(root, 'db', 'postgres', 'host');
  const named = env[SECRETS_DIR_VARIABLE];
  return typeof named === 'string' && named !== '' ? path.resolve(profile, named) : path.join(profile, 'secrets');
}

/** The folder the Compose profile reads its secrets from by default. */
export const DEFAULT_DIR = composeSecretsDir({});
/** The port compose.yaml publishes by default. */
export const DEFAULT_PORT = 5432;
/** The one database every NoticeOS login may reach on the service. */
export const DATABASE = 'noticeos';
/** The one address the service is published on. */
export const HOST = '127.0.0.1';

/** Each login's verifier file, named as compose.yaml's secret and the login it is for. */
export const VERIFIERS = ['postgres', 'noticeos_owner', 'noticeos_maint', 'noticeos_app'];
/** The application's connection string: the bootstrap secret DATABASE_URL's
 * value (README.md, step g). */
export const ADDRESS_FILE = 'database.url';
/** Each connection string the operator keeps, and the login it is for. */
export const URLS = { 'owner.url': 'noticeos_owner', 'maint.url': 'noticeos_maint', [ADDRESS_FILE]: 'noticeos_app' };
/** Every file this command writes. */
export const FILES = [...VERIFIERS, ...Object.keys(URLS)];

const COMPOSE = 'db/postgres/host/compose.yaml';
export const USAGE = `usage: pnpm postgres:secrets [--dir <folder>] [--port <n>]

Writes the Postgres service's secret files (default ${path.relative(REPO_ROOT, DEFAULT_DIR)}),
never printing a password. Once, before the service's first start.`;

/** A new password: 32 URL-safe characters, so a connection string needs no escaping. */
const newPassword = () => randomBytes(24).toString('base64url');

/** A login's connection string on the service. */
export function connectionString(login, password, port) {
  return `postgresql://${login}:${password}@${HOST}:${port}/${DATABASE}?sslmode=disable`;
}

/**
 * Write every secret file into `dir` for the service on `port`. Refuses,
 * writing nothing, when any of them is already there. Returns the files
 * written, by name.
 */
export function writeSecrets(dir, { port = DEFAULT_PORT } = {}) {
  const found = FILES.filter((name) => existsSync(path.join(dir, name)));
  if (found.length) {
    const error = new Error(
      `${dir} already holds ${found.join(', ')}; the service's logins were made from them, so nothing was replaced. ` +
        'A new set is only for a new, empty service (README.md, "Starting over").',
    );
    error.refused = true;
    throw error;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const passwords = Object.fromEntries(VERIFIERS.map((login) => [login, newPassword()]));
  const contents = {
    ...Object.fromEntries(VERIFIERS.map((login) => [login, { text: scramVerifier(passwords[login]), mode: 0o644 }])),
    ...Object.fromEntries(Object.entries(URLS).map(([name, login]) => [name, { text: connectionString(login, passwords[login], port), mode: 0o600 }])),
  };
  const written = [];
  try {
    for (const [name, { text, mode }] of Object.entries(contents)) {
      writeFileSync(path.join(dir, name), `${text}\n`, { mode, flag: 'wx' });
      chmodSync(path.join(dir, name), mode);
      written.push(name);
    }
  } catch (error) {
    for (const name of written) rmSync(path.join(dir, name), { force: true });
    throw error;
  }
  return written;
}

function checkPort(value) {
  const port = Number(value);
  if (!/^\d+$/u.test(String(value)) || port < 1 || port > 65535) {
    const error = new Error(`--port is a whole number from 1 to 65535 (got ${JSON.stringify(String(value))})`);
    error.refused = true;
    throw error;
  }
  return port;
}

/** The command line; returns the exit code. */
export function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  const say = (stream, text) => stream.write(`${text}\n`);
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: { dir: { type: 'string' }, port: { type: 'string' } } });
    } catch (error) {
      error.refused = true;
      throw error;
    }
    const dir = parsed.values.dir === undefined ? DEFAULT_DIR : path.resolve(parsed.values.dir);
    const port = parsed.values.port === undefined ? DEFAULT_PORT : checkPort(parsed.values.port);
    writeSecrets(dir, { port });
    const custom = [
      ...(parsed.values.dir === undefined ? [] : [`${SECRETS_DIR_VARIABLE}=${dir}`]),
      ...(port === DEFAULT_PORT ? [] : [`NOTICEOS_POSTGRES_PORT=${port}`]),
    ];
    say(out, `Wrote the Postgres service's secrets to ${dir} (this account only):`);
    say(out, `  ${VERIFIERS.join(', ')}  verifiers the service's first start sets; not passwords`);
    say(out, '  owner.url, maint.url  your logins for schema migrations and database maintenance');
    say(out, "  database.url  the application's address, DATABASE_URL (db/postgres/host/README.md, step g)");
    say(out, `Next: ${custom.length ? `${custom.join(' ')} ` : ''}docker compose -f ${COMPOSE} up --detach --wait`);
    return 0;
  } catch (error) {
    if (error.refused) {
      say(err, `refused: ${error.message}\n${USAGE}`);
      return 2;
    }
    say(err, `failed: ${error.message}`);
    return 1;
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
