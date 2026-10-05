#!/usr/bin/env node
// THE POSTGRES MIGRATIONS, APPLIED TO AN INSTALLATION'S OWN DATABASE
// (bead ro-ujb9.76.34). Existing installations remain operator-only. The
// explicit ro-nzy7 exception lets pnpm start reuse this command only for a
// proven new/empty installation's frozen schema and one workspace (AGENTS.md).
//
//   pnpm postgres:migrate status    --database <name> [<connection>] [--json]
//   pnpm postgres:migrate apply     --database <name> [<connection>] --confirm <name>
//   pnpm postgres:migrate bootstrap --database <name> [<connection>] --confirm <name> --slug <slug> [--name <display name>]
//
//   <connection>  --url-from <VARIABLE>: a host that needs a password, like
//                 the installation's Compose service (db/postgres/host/); the
//                 variable, named here, holds the owner's postgresql:// URL
//                 nothing, or --socket <folder> [--port <n>]: a server on this
//                 machine, on its local socket, logged in as noticeos_owner
//                 with no password (a peer login)
//
// It needs psql alone, not the server binaries (bead ro-ujb9.76.39): the
// database may run in a container or at a provider.
//
// It is the development runner (scripts/postgres-migrate.mjs, `pnpm
// postgres:dev`) pointed at a real database, and it keeps that runner's
// guarantees by calling the same code, not a copy: the advisory lock (a second
// run is refused, not queued), one transaction for the whole run, a SHA-256
// record per file, and the refusal of a recorded migration whose file changed
// or is gone and of a pending one older than the newest applied; the
// bootstrap's lock, so two bootstraps cannot both create a workspace. What it
// adds, because the database is real:
//
//   - IT READS BEFORE IT WRITES. `status` reads in read-only transactions and
//     prints what is applied, pending or changed. `apply` and `bootstrap`
//     print the same plan first.
//   - THE TARGET IS NAMED TWICE. `--database`, and for a write `--confirm`
//     with the same name. Without it, or with another name, it prints the
//     plan and changes nothing.
//   - A DEVELOPMENT DATABASE IS REFUSED, and `pnpm postgres:dev` named: a name
//     ending in _dev before connecting, a database marked
//     noticeos.profile = 'development' before any write.
//   - IT IS THE OWNER. The session must be noticeos_owner's own login. The
//     roles and the database come first, from the Postgres service's first
//     start (db/postgres/host/first-start.sh); this command never creates a
//     role or a database.
//   - ONLY FROZEN MIGRATIONS. A real database applies a migration only once
//     db/postgres/frozen-migrations.sha256 lists it, so a file a real database
//     holds can never be edited afterwards (scripts/postgres-model.test.mjs
//     fails first); a frozen file that changed stops the run too. It never
//     writes the list itself: the freeze is a commit, made before the apply
//     (db/postgres/README.md, "Changing the schema").
//
// CONNECTING. Both ways are named on the command line, and nothing else
// decides where it connects: every psql child runs with the development
// profile's clean environment (scripts/postgres-dev.mjs, psqlEnvironment: no
// PG* settings, no password or service file, no DATABASE_URL). `--url-from`
// reads exactly the variable it names, never one it picks by itself; the URL
// may name only noticeos_owner and the --database name, and TLS settings; its
// password reaches psql only in that child's environment (PGPASSWORD), never
// its command line, and nothing this command prints repeats it.
//
// Only the explicit operator command, the proven-empty first-start exception,
// and tests may load this file. scripts/postgres-migrate.test.mjs guards that
// boundary. A restart or deploy never applies schema.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  DEVELOPMENT,
  MIGRATIONS_DIR,
  MINIMUM_MAJOR,
  PROFILE_SETTING,
  PostgresUnavailable,
  checkedSession,
  findPsql,
} from './postgres-dev.mjs';
import {
  FROZEN_MIGRATIONS,
  MigrationRefused,
  ROLES,
  applyMigrations,
  bootstrapWorkspace,
  frozenMigrationProblems,
  migrationStatus,
} from './postgres-migrate.mjs';
import { invokedDirectly } from './os-runtime.mjs';

/** The one login this command runs as. */
export const OWNER = 'noticeos_owner';
/** How the operator runs it. */
export const COMMAND = 'pnpm postgres:migrate';
/** The development databases' command, named in every refusal of one. */
const DEVELOPMENT_COMMAND = 'pnpm postgres:dev';
/** What the server lists this command's sessions as. */
const APPLICATION_NAME = 'noticeos-migrate';

const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/u;
/** What a --url-from URL may carry besides its login, host, port and database: TLS only. */
const URL_PARAMETERS = ['sslmode', 'sslrootcert', 'channel_binding'];

export const USAGE = `usage:
  ${COMMAND} status    --database <name> [<connection>] [--json]
  ${COMMAND} apply     --database <name> [<connection>] --confirm <name>
  ${COMMAND} bootstrap --database <name> [<connection>] --confirm <name> --slug <slug> [--name <display name>]

<connection>  --url-from <VARIABLE>: a host that needs a password, like the
              Compose service (db/postgres/host/); the variable holds
              postgresql://noticeos_owner:<password>@<host>:<port>/<name>
              nothing: psql's own local socket, for a server on this machine
              --socket <folder> [--port <n>]: another local socket

An installation's own database only, as ${OWNER}. A development database
(a name ending in _dev) is ${DEVELOPMENT_COMMAND}'s.`;

const quote = (text) => `'${String(text).replace(/'/gu, "''")}'`;
const plural = (count, one, many = `${one}s`) => (count === 1 ? one : many);

/** The frozen-migration list as committed: '' while nothing is frozen. */
export function readFrozenMarker(file = FROZEN_MIGRATIONS) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/**
 * Check the target the command line names, BEFORE anything connects, and
 * return `{ database, parts, password, hidden, where, flags }`: the libpq
 * keywords psql will use (built from the checked parts alone), the password
 * (null on the socket) and every spelling of it no output may repeat, how
 * messages name the target, and the flags that name it again in a suggested
 * next command. Throws MigrationRefused; no message quotes the variable's value.
 *
 * The third argument is for the importer, which checks each of its two
 * logins here: the `login` the session must be (a URL naming another is
 * refused), what it is `usedBy`, the `application` name the server lists it
 * as, and where a development database is sent instead (`development`).
 * This command's own are the defaults.
 */
export function checkTarget(
  { database, socket = null, port = null, urlFrom = null },
  env = process.env,
  { login = OWNER, usedBy = 'this command', application = APPLICATION_NAME, development = DEVELOPMENT_COMMAND } = {},
) {
  if (!database) throw new MigrationRefused(`name the database: --database <name>\n${USAGE}`);
  if (!DATABASE_NAME.test(database)) {
    throw new MigrationRefused(`a database name is lower-case letters, digits and _ (got ${JSON.stringify(database)})`);
  }
  if (database.endsWith('_dev')) {
    throw new MigrationRefused(
      `${database} is a development database (its name ends in _dev); --database names an installation's own database. ` +
        `Use ${development} for it. Nothing was sent.`,
    );
  }
  if (urlFrom !== null && (socket !== null || port !== null)) {
    throw new MigrationRefused('name a local socket or --url-from, not both');
  }
  if (urlFrom === null) {
    if (socket !== null && (!path.isAbsolute(socket) || socket.includes(','))) {
      throw new MigrationRefused(`--socket is one local socket folder, an absolute path (got ${JSON.stringify(socket)})`);
    }
    const checkedPort = port === null ? null : checkPort(port, '--port');
    const on = socket === null ? "psql's own local socket" : `the local socket in ${socket}`;
    return {
      database,
      parts: {
        ...(socket === null ? {} : { host: socket }),
        ...(checkedPort === null ? {} : { port: String(checkedPort) }),
        dbname: database,
        user: login,
        application_name: application,
      },
      password: null,
      hidden: [],
      where: `${database} on ${on}${checkedPort === null ? '' : `, port ${checkedPort}`}`,
      flags: [`--database ${database}`, ...(socket === null ? [] : [`--socket ${socket}`]), ...(checkedPort === null ? [] : [`--port ${checkedPort}`])].join(' '),
    };
  }
  if (!VARIABLE_NAME.test(urlFrom)) {
    throw new MigrationRefused(`--url-from names an environment variable, like NOTICEOS_OWNER_URL (got ${JSON.stringify(urlFrom)})`);
  }
  const raw = env[urlFrom];
  if (!raw) throw new MigrationRefused(`${urlFrom} is not set here; it holds the owner's postgresql:// connection string`);
  const invalid = () => new MigrationRefused(`${urlFrom} does not hold a postgresql:// URL`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalid();
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw invalid();
  let user;
  let named;
  let password;
  try {
    user = decodeURIComponent(url.username);
    named = decodeURIComponent(url.pathname.replace(/^\//u, ''));
    password = url.password ? decodeURIComponent(url.password) : null;
  } catch {
    throw invalid();
  }
  if (user !== login) {
    // Only a NoticeOS role is named back: a password typed where the login
    // goes must not be repeated.
    const who = ROLES.includes(user) ? user : 'another login';
    throw new MigrationRefused(`${urlFrom} logs in as ${who}; ${usedBy} runs as ${login} only. Nothing was sent.`);
  }
  if (named !== database) {
    throw new MigrationRefused(`${urlFrom} names the database ${named ? JSON.stringify(named) : '(none)'}, not ${database}. Nothing was sent.`);
  }
  const keys = [...url.searchParams.keys()];
  for (const key of keys) {
    if (!URL_PARAMETERS.includes(key)) {
      throw new MigrationRefused(`${urlFrom} carries the parameter "${key}"; only ${URL_PARAMETERS.join(', ')} are accepted. Nothing was sent.`);
    }
  }
  if (new Set(keys).size !== keys.length) throw new MigrationRefused(`${urlFrom} names a parameter twice. Nothing was sent.`);
  const host = url.hostname.replace(/^\[(.*)\]$/u, '$1');
  if (!host || host.includes(',')) throw new MigrationRefused(`${urlFrom} must name one host. Nothing was sent.`);
  const checkedPort = url.port ? checkPort(url.port, `${urlFrom}'s port`) : null;
  return {
    database,
    parts: {
      host,
      ...(checkedPort === null ? {} : { port: String(checkedPort) }),
      dbname: database,
      user: login,
      ...Object.fromEntries(keys.map((key) => [key, url.searchParams.get(key)])),
      application_name: application,
    },
    password,
    hidden: [password, url.password].filter(Boolean),
    where: `${database} on ${host}${checkedPort === null ? '' : `:${checkedPort}`} (from ${urlFrom})`,
    flags: `--database ${database} --url-from ${urlFrom}`,
  };
}

function checkPort(value, what) {
  const port = Number(value);
  if (!/^\d+$/u.test(String(value)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MigrationRefused(`${what} is a whole number from 1 to 65535 (got ${JSON.stringify(String(value))})`);
  }
  return port;
}

/**
 * Connect to a checked target and read, in one read-only transaction, who
 * this session is and what the database says of itself. Refuses (before any
 * write) a session that is not the checked login's own (noticeos_owner's, for
 * this command), a database marked for development (naming `development`
 * instead), and a server older than the store needs. Returns the session
 * with its `facts`.
 */
export function openInstallationDatabase(target, { tools = findPsql(), development = DEVELOPMENT_COMMAND } = {}) {
  const db = checkedSession(target.parts, { where: target.where, password: target.password, tools });
  const [row] = db.script(`BEGIN READ ONLY;
SELECT session_user AS login,
  current_database() AS database,
  current_setting('${PROFILE_SETTING}', true) AS profile,
  current_setting('server_version') AS version,
  current_setting('server_version_num')::int / 10000 AS major,
  (SELECT string_agg(rolname, ' ' ORDER BY rolname) FROM pg_roles WHERE rolname IN (${ROLES.map(quote).join(', ')})) AS roles,
  has_database_privilege(current_database(), 'CREATE') AS can_create;
COMMIT;
`);
  const facts = {
    login: row?.login ?? null,
    database: row?.database ?? null,
    profile: row?.profile ?? null,
    version: row?.version ?? null,
    major: Number(row?.major),
    roles: (row?.roles ?? '').split(' ').filter(Boolean),
    canCreate: row?.can_create === 't',
  };
  if (facts.login !== target.parts.user) {
    throw new MigrationRefused(`${target.where}: this session is ${facts.login}, not ${target.parts.user}; nothing was written`);
  }
  if (facts.database !== target.database) {
    throw new MigrationRefused(`${target.where}: the server answered for ${facts.database}; nothing was written`);
  }
  if (facts.profile === DEVELOPMENT) {
    throw new MigrationRefused(
      `${target.where} is marked for development (${PROFILE_SETTING} = '${DEVELOPMENT}'); use ${development} for it. Nothing was written.`,
    );
  }
  if (!(facts.major >= MINIMUM_MAJOR)) {
    throw new MigrationRefused(`${target.where} runs PostgreSQL ${facts.version}; ${MINIMUM_MAJOR} or later is required`);
  }
  return { ...db, facts };
}

/** How many workspaces the store holds, read as the owner (its read policy on
 * the list); null before the migrations have made the table. */
function countWorkspaces(db) {
  const [row] = db.script(`BEGIN READ ONLY;
SELECT to_regclass('noticeos.workspaces') IS NOT NULL AS ready \\gset
\\if :ready
SELECT count(*) AS workspaces FROM noticeos.workspaces;
\\endif
COMMIT;
`);
  return row ? Number(row.workspaces) : null;
}

const STATE_WORDS = {
  changed: 'is recorded here with another hash: its file changed after this database applied it. A recorded migration is never edited; add a new one instead',
  missing: 'is recorded here, but its file is gone',
  'out-of-order': 'is pending but older than the newest applied migration',
};

/**
 * Read-only: the plan an apply would follow on `db` (from
 * `openInstallationDatabase`): every migration's state, which pending ones
 * are not frozen, how many workspaces there are, and `stops`, one sentence
 * per thing that stops an apply before it writes.
 */
export function installationPlan(db, { dir = MIGRATIONS_DIR, frozen = readFrozenMarker() } = {}) {
  const status = migrationStatus(db, { dir });
  const frozenCount = frozen.split('\n').filter((line) => line.trim() !== '').length;
  const unfrozen = status.pending.filter((m) => m.version > frozenCount).map((m) => m.name);
  const missingRoles = ROLES.filter((role) => !db.facts.roles.includes(role));
  const stops = [
    ...status.problems.map((m) => `${m.name} ${STATE_WORDS[m.state]}`),
    ...frozenMigrationProblems(frozen, { dir }),
    ...(unfrozen.length
      ? [
          `not frozen yet: ${unfrozen.join(', ')}. A real database applies only frozen migrations; from db/postgres/, freeze ${plural(unfrozen.length, 'it', 'each')} and commit the ${plural(unfrozen.length, 'line')} first:\n` +
            unfrozen.map((name) => `      shasum -a 256 migrations/${name}.sql >> frozen-migrations.sha256`).join('\n'),
        ]
      : []),
    ...(missingRoles.length
      ? [`the ${plural(missingRoles.length, 'role')} ${missingRoles.join(', ')} ${plural(missingRoles.length, 'is', 'are')} missing: create ${plural(missingRoles.length, 'it', 'them')} first (db/postgres/roles.sql), as the Postgres service's first start does (db/postgres/host/first-start.sh)`]
      : []),
    ...(status.pending.length && !db.facts.canCreate
      ? [`${OWNER} may not create schemas in ${db.facts.database}: make it the database's owner, as the Postgres service's first start does (db/postgres/host/first-start.sh)`]
      : []),
  ];
  return {
    where: db.where,
    facts: db.facts,
    migrations: status.migrations,
    pending: status.pending,
    unfrozen,
    workspaces: countWorkspaces(db),
    stops,
  };
}

/** The plan as the operator reads it. `flags` name the target again in the
 * next command, which `next: false` (the plan printed before a write) leaves out. */
export function describePlan(plan, flags, { next = true } = {}) {
  const lines = [`${plan.where}: PostgreSQL ${plan.facts.version}, as ${plan.facts.login}`];
  for (const m of plan.migrations) {
    const note = m.appliedAt ? `  (${m.appliedAt})` : plan.unfrozen.includes(m.name) ? '  (not frozen)' : '';
    lines.push(`  ${m.state.padEnd(12)} ${m.name}${note}`);
  }
  if (plan.migrations.length === 0) lines.push('  no migrations');
  lines.push(`Workspaces: ${plan.workspaces === null ? 'none (no schema yet)' : plan.workspaces === 0 ? 'none yet' : plan.workspaces}`);
  if (plan.stops.length) {
    lines.push(`${plan.stops.length} ${plural(plan.stops.length, 'thing stops', 'things stop')} an apply:`, ...plan.stops.map((stop) => `  ✗ ${stop}`));
  } else if (plan.pending.length) {
    lines.push(`${plan.pending.length} pending.${next ? ` To apply: ${COMMAND} apply ${flags} --confirm ${plan.facts.database}` : ''}`);
  } else {
    lines.push('Up to date.');
    if (next && plan.workspaces === 0) {
      lines.push(`Next, its one workspace: ${COMMAND} bootstrap ${flags} --confirm ${plan.facts.database} --slug main --name "My sites"`);
    }
  }
  return lines.join('\n');
}

/**
 * The command line; returns the exit code: 0 done (or, for status, nothing
 * stops an apply), 1 failed (or status found what stops an apply), 2
 * refused, 3 no Postgres tools here. `options` lets the proofs name the
 * environment, the migrations folder, the frozen list and the tools.
 */
export function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr, options = {}) {
  const { env = process.env, dir = MIGRATIONS_DIR, frozen = null, tools = undefined } = options;
  let hidden = [];
  const say = (stream, text) => stream.write(`${hidden.reduce((shown, secret) => shown.split(secret).join('***'), String(text))}\n`);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        database: { type: 'string' },
        socket: { type: 'string' },
        port: { type: 'string' },
        'url-from': { type: 'string' },
        confirm: { type: 'string' },
        slug: { type: 'string' },
        name: { type: 'string' },
        json: { type: 'boolean' },
        // The development runner's targets, known here only to point there.
        dir: { type: 'string' },
        url: { type: 'string' },
      },
    });
  } catch (error) {
    say(err, `refused: ${error.message}\n${USAGE}`);
    return 2;
  }
  const [command, ...rest] = parsed.positionals;
  const values = parsed.values;
  try {
    if (!['status', 'apply', 'bootstrap'].includes(command) || rest.length) throw new MigrationRefused(USAGE);
    if (values.dir !== undefined || values.url !== undefined) {
      throw new MigrationRefused(`--dir and --url name development databases; that is ${DEVELOPMENT_COMMAND}. Nothing was sent.`);
    }
    if (command === 'status' && values.confirm !== undefined) throw new MigrationRefused('status only reads; --confirm is for apply and bootstrap');
    if (command !== 'bootstrap' && (values.slug !== undefined || values.name !== undefined)) {
      throw new MigrationRefused('--slug and --name are for bootstrap');
    }
    if (command !== 'status' && values.json) throw new MigrationRefused('--json is for status');
    const target = checkTarget(
      { database: values.database, socket: values.socket ?? null, port: values.port ?? null, urlFrom: values['url-from'] ?? null },
      env,
    );
    hidden = target.hidden;
    const db = openInstallationDatabase(target, { tools });
    const plan = installationPlan(db, { dir, frozen: frozen ?? readFrozenMarker() });
    if (command === 'status') {
      if (values.json) {
        const { where, facts, migrations, workspaces, stops } = plan;
        say(out, JSON.stringify({ where, version: facts.version, login: facts.login, migrations, workspaces, stops }, null, 2));
      } else {
        say(out, describePlan(plan, target.flags));
      }
      return plan.stops.length ? 1 : 0;
    }
    say(out, describePlan(plan, target.flags, { next: false }));
    if (values.confirm === undefined) {
      throw new MigrationRefused(`nothing was changed. To go ahead, type the database's name again: --confirm ${target.database}`);
    }
    if (values.confirm !== target.database) {
      throw new MigrationRefused(`--confirm names ${JSON.stringify(values.confirm)}, not ${target.database}. Nothing was changed.`);
    }
    if (command === 'apply') {
      if (plan.stops.length) throw new MigrationRefused('nothing was applied (above: what stops it)');
      if (plan.pending.length === 0) {
        say(out, 'Up to date; nothing applied.');
        return 0;
      }
      const result = applyMigrations(db, { dir });
      say(out, result.applied.map((name) => `  applied      ${name}`).join('\n'));
      say(out, `Applied ${result.applied.length} ${plural(result.applied.length, 'migration')} to ${target.where}, in one transaction.`);
      if (plan.workspaces === null || plan.workspaces === 0) {
        say(out, `Next, its one workspace: ${COMMAND} bootstrap ${target.flags} --confirm ${target.database} --slug main --name "My sites"`);
      }
      return 0;
    }
    if (plan.pending.length) {
      throw new MigrationRefused(`apply the migrations first: ${COMMAND} apply ${target.flags} --confirm ${target.database}`);
    }
    if (plan.stops.length) throw new MigrationRefused('nothing was changed (above: what stops it)');
    const result = bootstrapWorkspace(db, { slug: values.slug, displayName: values.name ?? values.slug, dir });
    say(out, `${target.where} ${result.created ? 'now has its one workspace' : 'already has its workspace'}: ${result.workspaceId}`);
    return 0;
  } catch (error) {
    if (error instanceof MigrationRefused || error instanceof PostgresUnavailable) {
      say(err, `refused: ${error.message}`);
      return error instanceof PostgresUnavailable ? 3 : 2;
    }
    say(err, `failed: ${error.message}`);
    return 1;
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
