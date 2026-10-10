#!/usr/bin/env node
// The Postgres migration runner, development profile only.
//
// Applies db/postgres/migrations/ to a throwaway cluster or a local database
// marked for development (scripts/postgres-dev.mjs says exactly what it
// refuses). Managed runtime, restart and deploy never apply schema.
// An installation's own database is the
// operator-only `pnpm postgres:migrate` (scripts/postgres-apply.mjs), which
// runs this same code and refuses every development database.
//
//   node scripts/postgres-migrate.mjs status --dir <folder> | --url <postgres://…_dev> [--json]
//   node scripts/postgres-migrate.mjs apply  --dir <folder> | --url <postgres://…_dev>
//   node scripts/postgres-migrate.mjs bootstrap --dir <folder> | --url <…> --slug <slug> [--name <display name>]
//   node scripts/postgres-migrate.mjs new <name>
//
// `status` only reads, in a READ ONLY transaction. `apply` runs every pending
// migration in ONE transaction: it takes the runner's advisory lock (a second
// runner is refused, not queued), checks that the applied set is still the one
// it planned against, creates the two roles if this development database
// lacks them, applies each file as noticeos_owner and records its SHA-256 in
// noticeos_migrations.applied. Any failure rolls the whole run back. A second
// apply with nothing pending changes nothing. A recorded migration whose file
// changed, a recorded one with no file, or a pending one older than the
// newest applied stops the run before it starts. `bootstrap` creates the
// installation's one workspace, once. `new` writes the next numbered file
// from a template and nothing else.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  DevelopmentProfileRefused,
  MIGRATIONS_DIR,
  MODEL_DIR,
  PostgresUnavailable,
  PsqlError,
  ROLES_SQL,
  migrationFiles,
  openDevelopmentUrl,
  openThrowaway,
} from './postgres-dev.mjs';
import { migrationStates } from './postgres-migration-states.mjs';
import { invokedDirectly } from './os-runtime.mjs';

/** The advisory lock every run takes: one migration run per database at a time. */
export const LOCK_KEY = "hashtextextended('noticeos.migrations', 0)";

const BOOKKEEPING = `CREATE SCHEMA IF NOT EXISTS noticeos_migrations;
CREATE TABLE IF NOT EXISTS noticeos_migrations.applied (
  version    integer PRIMARY KEY CHECK (version >= 1),
  name       text NOT NULL UNIQUE,
  sha256     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT session_user
);
-- The application login reads which migrations are applied, and nothing
-- else here: a start compares them with its code and stops when the
-- database is behind (scripts/database-address.mts).
GRANT USAGE ON SCHEMA noticeos_migrations TO noticeos_app;
GRANT SELECT ON noticeos_migrations.applied TO noticeos_app;`;

/** A run refused before it changed anything; `message` says why and what to do. */
export class MigrationRefused extends Error {}

/** A run that started and was rolled back whole; `message` names the migration. */
export class MigrationFailed extends Error {}

/** `[{ version, name, file, sha256, sql }]` in order, each checked to be plain SQL. */
export function readMigrations(dir = MIGRATIONS_DIR) {
  return migrationFiles(dir).map((file, index) => {
    const name = path.basename(file, '.sql');
    const version = Number(name.slice(0, 4));
    if (version !== index + 1) {
      throw new MigrationRefused(`${name}: migrations are numbered 0001, 0002, … without gaps`);
    }
    const bytes = readFileSync(file);
    const sql = bytes.toString('utf8');
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/imu.test(sql)) {
      throw new MigrationRefused(`${name}: a migration holds no transaction control; the runner owns the transaction`);
    }
    if (/^\s*\\/mu.test(sql)) {
      throw new MigrationRefused(`${name}: a migration holds plain SQL, no psql commands`);
    }
    return { version, name, file, sha256: createHash('sha256').update(bytes).digest('hex'), sql };
  });
}

/**
 * The freeze marker: one `<sha256>  migrations/NNNN_name.sql`
 * line per migration a kept development database has applied, and per
 * migration before a real database may apply it (scripts/postgres-apply.mjs
 * refuses one the marker does not list), exactly as
 * `shasum -a 256 migrations/NNNN_name.sql` prints it from db/postgres/. Empty
 * or absent: nothing is frozen yet.
 */
export const FROZEN_MIGRATIONS = path.join(MODEL_DIR, 'frozen-migrations.sha256');

/**
 * What breaks the freeze, as sentences; [] when it holds. Every line of
 * `marker` must name one of the first migrations in order (0002 is never
 * frozen while 0001 is not), and that file must still have the recorded
 * SHA-256: a frozen migration is never edited, and a correction is the next
 * migration.
 */
export function frozenMigrationProblems(marker, { dir = MIGRATIONS_DIR } = {}) {
  const migrations = readMigrations(dir);
  const problems = [];
  const lines = marker.split('\n').filter((line) => line.trim() !== '');
  lines.forEach((line, index) => {
    const match = /^([0-9a-f]{64}) [ *]migrations\/(\d{4}_[a-z0-9_]+)\.sql$/u.exec(line);
    if (!match) {
      problems.push(`line ${index + 1} is not "<sha256>  migrations/NNNN_name.sql": ${line}`);
      return;
    }
    const [, sha256, name] = match;
    const expected = migrations[index];
    if (expected?.name !== name) {
      problems.push(`line ${index + 1} names ${name}; frozen migrations are the first ones in order, so it should name ${expected?.name ?? 'no further file'}`);
    } else if (expected.sha256 !== sha256) {
      problems.push(`${name}.sql changed after it was frozen; put it back and write the change as the next migration (pnpm postgres:dev new <name>)`);
    }
  });
  return problems;
}

function recorded(dev) {
  const script = `BEGIN READ ONLY;
SELECT to_regclass('noticeos_migrations.applied') IS NOT NULL AS ready \\gset
\\if :ready
SELECT version, name, sha256, to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS applied_at
  FROM noticeos_migrations.applied ORDER BY version;
\\endif
COMMIT;
`;
  return dev.script(script).map((row) => ({ ...row, version: Number(row.version) }));
}

/**
 * Read-only: every migration file and every recorded one, with its state —
 * `applied`, `pending`, `changed` (recorded with another hash), `missing`
 * (recorded, no file) or `out-of-order` (pending but older than the newest
 * applied), as scripts/postgres-migration-states.mjs derives them for
 * `pnpm os:deploy` too. `problems` lists the ones that stop an apply.
 */
export function migrationStatus(dev, { dir = MIGRATIONS_DIR } = {}) {
  return { where: dev.where, ...migrationStates(readMigrations(dir), recorded(dev)) };
}

const quote = (text) => `'${String(text).replace(/'/gu, "''")}'`;

/** The roles db/postgres/roles.sql creates. */
export const ROLES = ['noticeos_owner', 'noticeos_app', 'noticeos_maint', 'noticeos_identity', 'noticeos_platform', 'noticeos_task_directory', 'noticeos_service_grant'];

/** The roles, created only when this development database has none of them. */
function rolesScript(dev) {
  const present = dev
    .sql(`SELECT rolname FROM pg_roles WHERE rolname IN (${ROLES.map(quote).join(', ')}) ORDER BY rolname`)
    .map((row) => row.rolname);
  if (present.length === ROLES.length) return '';
  if (present.length > 0) {
    throw new MigrationRefused(
      `this cluster has ${present.join(', ')} but not ${ROLES.filter((role) => !present.includes(role)).join(', ')}; ` +
        'create the missing ones from db/postgres/roles.sql',
    );
  }
  return readFileSync(ROLES_SQL, 'utf8');
}

/**
 * Apply every pending migration in one transaction. Returns
 * `{ applied: [names] }`; nothing pending is a no-op that opens no write.
 */
export function applyMigrations(dev, { dir = MIGRATIONS_DIR } = {}) {
  const status = migrationStatus(dev, { dir });
  if (status.problems.length) {
    const lines = status.problems.map((m) => `  ${m.name}: ${m.state}`).join('\n');
    throw new MigrationRefused(
      `${status.where}: these migrations stop the run; a recorded migration is never edited, add a new one instead\n${lines}`,
    );
  }
  if (status.pending.length === 0) return { where: status.where, applied: [] };
  const files = readMigrations(dir);
  const planned = status.migrations.filter((m) => m.state === 'applied').map((m) => m.version).join(',');
  const lines = [
    'BEGIN;',
    `DO $$ BEGIN IF NOT pg_try_advisory_xact_lock(${LOCK_KEY}) THEN
  RAISE EXCEPTION 'noticeos-migrate: another migration run holds the lock on this database' USING ERRCODE = '55P03';
END IF; END $$;`,
    rolesScript(dev),
    `DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO noticeos_owner', current_database()); END $$;`,
    'SET LOCAL ROLE noticeos_owner;',
    BOOKKEEPING,
    `DO $$ BEGIN
  IF (SELECT coalesce(string_agg(version::text, ',' ORDER BY version), '') FROM noticeos_migrations.applied) <> ${quote(planned)} THEN
    RAISE EXCEPTION 'noticeos-migrate: the applied migrations changed while this run was starting; run it again' USING ERRCODE = '40001';
  END IF;
END $$;`,
  ];
  for (const pending of status.pending) {
    const migration = files.find((m) => m.version === pending.version);
    lines.push(
      `\\echo noticeos-migrate: applying ${migration.name}`,
      migration.sql,
      ';',
      `INSERT INTO noticeos_migrations.applied (version, name, sha256) VALUES (${migration.version}, ${quote(migration.name)}, ${quote(migration.sha256)});`,
    );
  }
  lines.push('COMMIT;', '');
  try {
    dev.script(lines.join('\n'));
  } catch (error) {
    if (!(error instanceof PsqlError)) throw error;
    if (/noticeos-migrate: another migration run/u.test(error.message)) {
      throw new MigrationRefused(`${status.where}: another migration run holds the lock; nothing was applied`);
    }
    const failing = [...error.output.matchAll(/^noticeos-migrate: applying (\S+)$/gmu)].at(-1)?.[1];
    throw new MigrationFailed(
      `${status.where}: ${failing ? `${failing} failed` : 'the run failed before its first migration'}; ` +
        `the whole run was rolled back, nothing was applied\n${error.message}`,
    );
  }
  return { where: status.where, applied: status.pending.map((m) => m.name) };
}

/**
 * Create the installation's one workspace, the bootstrap a new install runs
 * once after its first apply: as noticeos_owner, inside the new workspace's
 * own id (forced row security admits no other way in), under an advisory lock
 * so two bootstraps cannot both create one. The existing workspaces are
 * counted as noticeos_owner too, through the one policy that lets it read
 * their list (owner_lists_workspaces in 0001_baseline.sql), so the same
 * bootstrap runs where the session is the owner's own login
 * (scripts/postgres-apply.mjs, an installation's own database). Returns
 * `{ workspaceId, created }`; a second bootstrap creates nothing and returns
 * the first one's id.
 */
export function bootstrapWorkspace(dev, { slug, displayName = slug, workspaceId = crypto.randomUUID(), dir = MIGRATIONS_DIR }) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(slug ?? '')) {
    throw new MigrationRefused(`a workspace slug is lower-case letters, digits and -, like main (got ${JSON.stringify(slug)})`);
  }
  const status = migrationStatus(dev, { dir });
  if (status.problems.length || status.pending.length) {
    throw new MigrationRefused(`${status.where}: apply the migrations first (node scripts/postgres-migrate.mjs apply …)`);
  }
  const script = `BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('noticeos.bootstrap', 0)) \\gset
SET LOCAL ROLE noticeos_owner;
SELECT count(*) AS existing, coalesce((array_agg(workspace_id::text ORDER BY created_at))[1], '') AS existing_id
  FROM noticeos.workspaces \\gset
SELECT :existing = 0 AS fresh \\gset
\\if :fresh
SET LOCAL noticeos.workspace_id = :'workspace_id';
SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
  WHERE attrelid='noticeos.workspaces'::regclass AND attname='status' AND NOT attisdropped) AS lifecycle \\gset
\\if :lifecycle
INSERT INTO noticeos.workspaces (workspace_id, slug, display_name, status) VALUES (:'workspace_id'::uuid, :'slug', :'display_name', 'active');
\\else
INSERT INTO noticeos.workspaces (workspace_id, slug, display_name) VALUES (:'workspace_id'::uuid, :'slug', :'display_name');
\\endif
\\echo noticeos-bootstrap created :workspace_id
\\else
\\echo noticeos-bootstrap exists :existing_id
\\endif
COMMIT;
`;
  const out = dev.run(script, { vars: { workspace_id: workspaceId, slug, display_name: displayName } });
  const [, verdict, id] = /^noticeos-bootstrap (created|exists) (\S+)$/mu.exec(out) ?? [];
  if (!verdict) throw new MigrationFailed(`${status.where}: the bootstrap said nothing recognisable: ${out.trim()}`);
  return { where: status.where, workspaceId: id, created: verdict === 'created' };
}

const TEMPLATE = (name) => `-- ${name}.sql — <what this changes, and why>.
--
-- Plain SQL only: scripts/postgres-migrate.mjs runs every pending migration
-- in one transaction as noticeos_owner. A recorded migration is never edited;
-- a correction is the next migration.
--
-- A new table carries workspace_id first in every key and every link, and
-- this file enables and forces its row security with the workspace_isolation
-- policy (0001's loop covered only the tables that existed then). Give it its
-- revision rule and grants in db/postgres/model.json and here;
-- scripts/postgres-model.test.mjs holds both to it.
`;

/** Write the next numbered migration from the template; returns its path. */
export function createMigration(name, { dir = MIGRATIONS_DIR } = {}) {
  if (!/^[a-z0-9]+(_[a-z0-9]+)*$/u.test(name)) {
    throw new MigrationRefused(`name a migration in lower_snake_case, like add_example_table (got ${JSON.stringify(name)})`);
  }
  const next = readMigrations(dir).length + 1;
  const base = `${String(next).padStart(4, '0')}_${name}`;
  const file = path.join(dir, `${base}.sql`);
  writeFileSync(file, TEMPLATE(base), { flag: 'wx' });
  return file;
}

function describe(status) {
  const lines = [`${status.where}`];
  for (const m of status.migrations) {
    lines.push(`  ${m.state.padEnd(12)} ${m.name}${m.appliedAt ? `  (${m.appliedAt})` : ''}`);
  }
  if (status.migrations.length === 0) lines.push('  no migrations');
  lines.push(
    status.problems.length
      ? `${status.problems.length} migration(s) stop an apply`
      : status.pending.length
        ? `${status.pending.length} pending: node scripts/postgres-migrate.mjs apply …`
        : 'up to date',
  );
  return lines.join('\n');
}

export const USAGE = `usage:
  node scripts/postgres-migrate.mjs status --dir <folder> | --url <postgres://…/name_dev> [--json]
  node scripts/postgres-migrate.mjs apply  --dir <folder> | --url <postgres://…/name_dev>
  node scripts/postgres-migrate.mjs bootstrap --dir <folder> | --url <…> --slug <slug> [--name <display name>]
  node scripts/postgres-migrate.mjs new <name>

--dir   a throwaway cluster kept in that folder (created there when it is empty)
--url   a local database whose name ends in _dev and that is marked
        noticeos.profile = 'development'; no password, no other parameter`;

/** The command line; returns the exit code. */
export function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        dir: { type: 'string' },
        url: { type: 'string' },
        json: { type: 'boolean' },
        slug: { type: 'string' },
        name: { type: 'string' },
      },
    });
  } catch (error) {
    err.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  const [command, ...rest] = parsed.positionals;
  const { dir, url, json, slug, name } = parsed.values;
  try {
    if (command === 'new') {
      if (rest.length !== 1 || dir || url) throw new MigrationRefused(USAGE);
      out.write(`${path.relative(process.cwd(), createMigration(rest[0]))}\n`);
      return 0;
    }
    if (!['status', 'apply', 'bootstrap'].includes(command)) throw new MigrationRefused(USAGE);
    if (Boolean(dir) === Boolean(url)) {
      throw new MigrationRefused(`name exactly one development target, --dir or --url\n${USAGE}`);
    }
    const dev = dir ? openThrowaway(dir) : openDevelopmentUrl(url);
    try {
      if (command === 'status') {
        const status = migrationStatus(dev);
        out.write(json ? `${JSON.stringify({ where: status.where, migrations: status.migrations }, null, 2)}\n` : `${describe(status)}\n`);
        return status.problems.length ? 1 : 0;
      }
      if (command === 'bootstrap') {
        const result = bootstrapWorkspace(dev, { slug, displayName: name ?? slug });
        out.write(
          `${result.where}\n${result.created ? 'created' : 'already has'} workspace ${result.workspaceId}\n`,
        );
        return 0;
      }
      const result = applyMigrations(dev);
      out.write(
        result.applied.length
          ? `${result.where}\n${result.applied.map((name) => `  applied      ${name}`).join('\n')}\n`
          : `${result.where}\nup to date; nothing applied\n`,
      );
      return 0;
    } finally {
      dev.close();
    }
  } catch (error) {
    if (error instanceof MigrationRefused || error instanceof DevelopmentProfileRefused || error instanceof PostgresUnavailable) {
      err.write(`refused: ${error.message}\n`);
      return error instanceof PostgresUnavailable ? 3 : 2;
    }
    err.write(`failed: ${error.message}\n`);
    return 1;
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  process.exitCode = main();
}
