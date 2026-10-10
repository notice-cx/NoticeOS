#!/usr/bin/env node
// `pnpm seed:local`: a new installation's store filled with invented history.
//
//   pnpm seed:local                     # the installation `pnpm start` keeps in .local/start
//   pnpm seed:local -- --dir <folder>   # the one it keeps in <folder>
//
// It writes db/fixtures/dev-seed.json in one transaction, through the one
// helper (packages/postgres), as the application login, so every row passes
// the grants and row security a Worker's write passes and a failure keeps
// nothing. It reaches the installation `pnpm start` made in the folder through
// DATABASE_URL in that folder's secrets file, checked as `pnpm start` checks
// it; never the checkout's own secrets and never the managed service's
// installation. No local store file is opened.
//
// It refuses, writing nothing, when the folder is not one `pnpm start` made;
// when its database is not marked `noticeos.profile = 'development'` (a
// database is seedable or real, never both); and when the store already holds
// a row in a table the fixture fills, or a site on one of its ids or domains,
// because nothing in an invented row says so. The last two are decided inside
// the writing transaction, behind a transaction lock.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../packages/postgres/src/store.mjs';
import { DATABASE_URL, checkDatabase, readDatabaseAddress } from './database-address.mjs';
import { readDevSecretBindings } from './dev-secrets.mjs';
import { invokedDirectly, samePath } from './os-runtime.mjs';
import { DEVELOPMENT, PROFILE_SETTING } from './postgres-profile.mjs';
import { startPlan } from './start.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_FILE = path.join(REPO_ROOT, 'db', 'fixtures', 'dev-seed.json');

/** The tables the fixture fills besides the sites, in the order they are
 * written; any row in any of them means the store is in use. */
export const HISTORY_TABLES = Object.freeze(['pulses', 'flags', 'ledger_entries', 'counter_readings', 'annotations']);

/** Every column the fixture may name, per table. An alert names its report by
 * `pulse_date`, a correction the entry it replaces by `supersedes` (that
 * entry's external_id); the store hands out every identity and number. */
const COLUMNS = Object.freeze({
  assets: ['asset_id', 'domain', 'display_name', 'status', 'sense_only', 'created_at', 'updated_at'],
  pulses: ['asset_id', 'pulse_date', 'generated_at', 'received_at', 'capabilities', 'envelope'],
  flags: ['asset_id', 'pulse_date', 'fired_at', 'severity', 'kind', 'metric', 'message', 'rule_id', 'rule_inputs',
    'disposition', 'disposition_at', 'disposition_note', 'snooze_until', 'ack_expiry', 'resolved_at'],
  ledger_entries: ['kind', 'asset_id', 'period_month', 'family', 'amount_minor', 'currency', 'source', 'ref', 'booking_state',
    'supersedes', 'note', 'external_id', 'predicted_monthly_value_minor', 'predicted_success_chance',
    'predicted_cost_minor', 'predicted_days_to_signal'],
  counter_readings: ['asset_id', 'metric', 'value', 'observed_at'],
  annotations: ['asset_id', 'at', 'kind', 'ref', 'note'],
});

/** The seeds of one store take turns: the second finds the first's rows. */
const SEED_LOCK = "SELECT pg_advisory_xact_lock(hashtextextended('noticeos.dev-seed', 0))";

const INSERT = Object.freeze({
  assets: `INSERT INTO noticeos.assets
             (workspace_id, asset_id, domain, display_name, status, sense_only, is_os, created_at, updated_at)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, false, $7::timestamptz, $8::timestamptz)`,
  pulses: `INSERT INTO noticeos.pulses
             (workspace_id, asset_id, pulse_date, revision, generated_at, received_at, capabilities, envelope)
           VALUES ($1::uuid, $2, $3::date, 1, $4::timestamptz, $5::timestamptz, $6::jsonb, $7::json)
           RETURNING pulse_id`,
  flags: `INSERT INTO noticeos.flags
            (workspace_id, asset_id, pulse_id, fired_at, severity, kind, metric, message, rule_id, rule_inputs,
             disposition, disposition_at, disposition_note, snooze_until, ack_expiry, resolved_at)
          VALUES ($1::uuid, $2, $3::bigint, $4::timestamptz, $5, $6, $7, $8, $9, $10::jsonb,
                  $11, $12::timestamptz, $13, $14::timestamptz, $15::timestamptz, $16::timestamptz)`,
  ledger_entries: `INSERT INTO noticeos.ledger_entries
                     (workspace_id, kind, asset_id, period_month, family, amount_minor, currency, source, ref,
                      booking_state, supersedes_id, note, external_id, predicted_monthly_value_minor,
                      predicted_success_chance, predicted_cost_minor, predicted_days_to_signal)
                   VALUES ($1::uuid, $2, $3, $4::date, $5, $6::bigint, $7, $8, $9, $10, $11::bigint, $12, $13,
                           $14::bigint, $15::numeric, $16::bigint, $17::integer)
                   RETURNING entry_id`,
  counter_readings: `INSERT INTO noticeos.counter_readings (workspace_id, asset_id, metric, value, observed_at)
                     VALUES ($1::uuid, $2, $3, $4::bigint, $5::timestamptz)`,
  annotations: `INSERT INTO noticeos.annotations (workspace_id, asset_id, at, kind, ref, note)
                VALUES ($1::uuid, $2, $3::timestamptz, $4, $5, $6)`,
});

const log = (msg) => console.log(`[seed] ${msg}`);
const fail = (msg) => console.error(`[seed] ${msg}`);

/** The fixture, checked to name only the tables and columns the seed writes. */
export function readFixture(file = FIXTURE_FILE) {
  const fixture = JSON.parse(readFileSync(file, 'utf8'));
  for (const table of ['assets', ...HISTORY_TABLES]) {
    if (!Array.isArray(fixture[table])) throw new Error(`${file} has no ${table} list`);
    fixture[table].forEach((row, index) => {
      const unknown = Object.keys(row).filter((column) => !COLUMNS[table].includes(column));
      if (unknown.length > 0) throw new Error(`${file}: ${table} row ${index + 1} names ${unknown.join(', ')}, which the seed does not write`);
    });
  }
  return fixture;
}

/** The seed refused before writing: `lines` say why and what to do. */
export class SeedRefused extends Error {
  constructor(lines) {
    super(lines[0]);
    this.lines = lines;
  }
}

const value = (row, column) => row[column] ?? null;
const json = (row, column) => (row[column] === undefined || row[column] === null ? null : JSON.stringify(row[column]));

/**
 * The whole seed, inside one transaction `tx` of the store's one workspace:
 * the refusals first, then every row, sites first. `where` is how a refusal
 * names the secrets file. Returns how many rows each table took.
 */
export async function fill(tx, fixture, { where = 'the secrets file' } = {}) {
  await tx.query(SEED_LOCK);
  const [mark] = await tx.query(`SELECT current_setting('${PROFILE_SETTING}', true) AS profile`);
  if (mark?.profile !== DEVELOPMENT) {
    throw new SeedRefused([
      `refusing to seed: the database ${DATABASE_URL} in ${where} names does not say it is for development, and invented rows never go into an installation's own.`,
      '  If it is a throwaway database, mark it once, as its owner:',
      `    ALTER DATABASE <its name> SET ${PROFILE_SETTING} = '${DEVELOPMENT}'`,
      'Nothing was written.',
    ]);
  }
  const [counts] = await tx.query(
    `SELECT ${HISTORY_TABLES.map((table) => `(SELECT count(*) FROM noticeos.${table})::int AS ${table}`).join(',\n            ')}`,
  );
  const held = HISTORY_TABLES.filter((table) => counts[table] > 0);
  const taken = await tx.query(
    `SELECT asset_id FROM noticeos.assets WHERE asset_id = ANY($1::text[]) OR domain = ANY($2::text[])
      ORDER BY asset_id COLLATE "C"`,
    [fixture.assets.map((site) => site.asset_id), fixture.assets.map((site) => site.domain).filter(Boolean)],
  );
  if (held.length > 0 || taken.length > 0) {
    throw new SeedRefused([
      'refusing to seed: this store already holds data.',
      ...held.map((table) => `  noticeos.${table}: ${counts[table]} row(s)`),
      ...taken.map((row) => `  noticeos.assets: the site ${row.asset_id}, on an id or domain the fixture uses`),
      'These rows are invented; once mixed in with real ones, nothing in the store can tell them apart.',
      'Seed only a new installation: pnpm start -- --dir <an empty folder>, on a new database marked for development.',
      'Nothing was written.',
    ]);
  }

  const ws = tx.workspaceId;
  for (const site of fixture.assets) {
    await tx.execute(INSERT.assets, [ws, site.asset_id, value(site, 'domain'), site.display_name, site.status,
      site.sense_only === true, site.created_at, site.updated_at]);
  }
  const reports = new Map();
  for (const report of fixture.pulses) {
    const [row] = await tx.query(INSERT.pulses, [ws, report.asset_id, report.pulse_date, value(report, 'generated_at'),
      report.received_at, json(report, 'capabilities'), json(report, 'envelope')]);
    reports.set(`${report.asset_id} ${report.pulse_date}`, row.pulse_id);
  }
  for (const alert of fixture.flags) {
    const pulseId = reports.get(`${alert.asset_id} ${alert.pulse_date}`);
    if (pulseId === undefined) throw new Error(`an alert names no report of ${alert.asset_id} on ${alert.pulse_date}`);
    await tx.execute(INSERT.flags, [ws, alert.asset_id, pulseId, alert.fired_at, alert.severity, alert.kind,
      value(alert, 'metric'), value(alert, 'message'), alert.rule_id, json(alert, 'rule_inputs'),
      value(alert, 'disposition'), value(alert, 'disposition_at'), value(alert, 'disposition_note'),
      value(alert, 'snooze_until'), value(alert, 'ack_expiry'), value(alert, 'resolved_at')]);
  }
  const entries = new Map();
  for (const entry of fixture.ledger_entries) {
    const supersedes = entry.supersedes === undefined ? null : entries.get(entry.supersedes);
    if (supersedes === undefined) throw new Error(`a correction names no earlier entry ${entry.supersedes}`);
    const [row] = await tx.query(INSERT.ledger_entries, [ws, entry.kind, entry.asset_id, entry.period_month, entry.family,
      value(entry, 'amount_minor'), entry.currency, value(entry, 'source'), value(entry, 'ref'), value(entry, 'booking_state'),
      supersedes, value(entry, 'note'), value(entry, 'external_id'), value(entry, 'predicted_monthly_value_minor'),
      value(entry, 'predicted_success_chance'), value(entry, 'predicted_cost_minor'), value(entry, 'predicted_days_to_signal')]);
    if (entry.external_id) entries.set(entry.external_id, row.entry_id);
  }
  for (const reading of fixture.counter_readings) {
    await tx.execute(INSERT.counter_readings, [ws, reading.asset_id, reading.metric, reading.value, reading.observed_at]);
  }
  for (const note of fixture.annotations) {
    await tx.execute(INSERT.annotations, [ws, note.asset_id, note.at, note.kind, value(note, 'ref'), value(note, 'note')]);
  }
  return Object.fromEntries(['assets', ...HISTORY_TABLES].map((table) => [table, fixture[table].length]));
}

/** What a failed write says: a Postgres error's own sentence and code, which
 * names a statement and never the address; anything else by its code alone. */
function failure(error) {
  const cause = error?.cause ?? error;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  if (/^[0-9A-Z]{5}$/u.test(code)) return `${cause.message} (${code})`;
  return code ? `the store could not be written (${code})` : String(error?.message ?? error);
}

/** A path as a person reads it: relative to where they stand, when inside it. */
function shown(file, cwd = process.cwd()) {
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

export function parseArgs(argv) {
  const opts = { dir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--dir' && argv[i + 1] !== undefined) opts.dir = argv[++i];
    else throw new Error(`unknown option ${arg} (known: --dir <folder>)`);
  }
  return opts;
}

/**
 * Seed the store of the installation `pnpm start` keeps in `dir`, or refuse
 * and say why. Returns the exit code.
 */
export async function seedLocal({ dir = null, root = REPO_ROOT, fixture = null } = {}) {
  const plan = startPlan({ root, dir });
  const inside = path.relative(plan.home, plan.root);
  if (samePath(plan.home, plan.root) || (!inside.startsWith('..') && !path.isAbsolute(inside))) {
    fail(`refusing to seed: ${shown(plan.home)} holds this checkout; seed a folder pnpm start made: pnpm start -- --dir <folder>`);
    return 1;
  }
  if (!existsSync(plan.mark)) {
    fail(`refusing to seed: ${shown(plan.home)} is not an installation pnpm start made; make one first: pnpm start -- --dir ${shown(plan.home)}`);
    return 1;
  }
  const where = shown(plan.secrets);
  let bindings;
  try {
    ({ bindings } = await readDevSecretBindings({ secretsFile: plan.secrets, varsFile: plan.devVars }));
  } catch {
    fail(`refusing to seed: ${where} could not be read, so ${DATABASE_URL} is unknown.`);
    return 1;
  }
  const reading = readDatabaseAddress(bindings, where);
  if (!reading.ok) {
    fail(`refusing to seed: ${reading.line}`);
    return 1;
  }
  const checked = await checkDatabase(reading.address, { where });
  if (!checked.ok) {
    fail(`refusing to seed: ${checked.line}`);
    return 1;
  }

  const rows = fixture ?? readFixture();
  const store = openStore(reading.address.url, { maxConnections: 1 });
  try {
    const workspace = await store.onlyWorkspace();
    const written = await store.inWorkspace(workspace, (tx) => fill(tx, rows, { where }));
    log(
      `seeded the store of ${shown(plan.home)}: ${written.assets} sites, ${written.pulses} reports, ${written.flags} alerts, ` +
        `${written.ledger_entries} ledger entries, ${written.counter_readings} counter readings, ${written.annotations} change notes.`,
    );
    return 0;
  } catch (error) {
    if (error instanceof SeedRefused) {
      for (const line of error.lines) fail(line);
      return 1;
    }
    fail(`the seed failed, and the store kept none of it: ${failure(error)}`);
    return 1;
  } finally {
    await store.close();
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
    process.exitCode = 1;
  }
  // exitCode, not process.exit: a hard exit can cut a refusal's last lines off
  // a piped stdout.
  if (opts) process.exitCode = await seedLocal({ dir: opts.dir });
}
