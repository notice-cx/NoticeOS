// The database address: from the secrets file to the dev server's
// environment. Both Workers reach Postgres through their POSTGRES Hyperdrive
// binding, which locally connects to the address wrangler reads from
// CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_POSTGRES. The installation
// keeps that address as the bootstrap secret DATABASE_URL in its secrets
// file. The runner and `pnpm start` both call `towerDatabase` first: it reads
// the address, checks it, and returns the one variable the dev server's
// environment gains, or one sentence saying why the start must stop.
//
// Every sentence names DATABASE_URL and the secrets file and never repeats
// any part of the address, not even its host, because a sentence lands in a
// log. The address travels in one child's environment only: never an
// argument, a file or a Worker binding. Nothing here applies schema: the
// check reads, as the application login, which migrations the database has.
// `readRecordedMigrations` is the one way the OS reads
// noticeos_migrations.applied, for every start and for `pnpm os:deploy`.

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATABASE_URL } from './dev-secrets.mjs';
import { stripJsonc } from './jsonc.mjs';
import { MIGRATION_FILE } from './postgres-migration-files.mjs';

export { DATABASE_URL };

/** The Hyperdrive binding both Workers reach Postgres through (their
 * wrangler.jsonc): a Worker config that declares it opens the Postgres store. */
export const POSTGRES_BINDING = 'POSTGRES';

/** Wrangler's documented variable for the POSTGRES Hyperdrive binding's local
 * connection string: how the dev server hands both Workers their store. */
export const LOCAL_CONNECTION_VARIABLE = `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${POSTGRES_BINDING}` as const;

/** The login every Worker transaction runs as (db/postgres/roles.sql). */
export const APPLICATION_LOGIN = 'noticeos_app';

/** Where a new installation's database is set up; named by the refusals. */
export const DATABASE_SETUP = 'db/postgres/host/README.md';

/** The migrations this code has, beside it. */
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'postgres', 'migrations');

/** A checked address. `url` is the whole connection string; nothing prints it. */
export interface DatabaseAddress {
  readonly url: string;
}

/** Why a start must stop, as one sentence without its command's prefix. */
export interface Refusal {
  readonly ok: false;
  readonly line: string;
}

/** The variables the dev server's environment gains. */
export type DatabaseEnv = Readonly<Record<string, string>>;

/**
 * DATABASE_URL out of the secrets file's bindings, or why it cannot be used.
 * `where` is how the sentence names the secrets file. Nothing is connected to.
 */
export function readDatabaseAddress(
  bindings: Readonly<Record<string, unknown>> | null | undefined,
  where: string,
): { readonly ok: true; readonly address: DatabaseAddress } | Refusal {
  const raw = bindings?.[DATABASE_URL];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') {
    return refused(`${DATABASE_URL} is not set in ${where}: add your NoticeOS database's connection string there (${DATABASE_SETUP} sets one up)`);
  }
  const form = `(${DATABASE_SETUP} shows its form)`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refused(`${DATABASE_URL} in ${where} is not a postgresql:// connection string ${form}`);
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    return refused(`${DATABASE_URL} in ${where} is not a postgresql:// connection string ${form}`);
  }
  if (url.username === '') {
    return refused(`${DATABASE_URL} in ${where} names no login; NoticeOS logs in as ${APPLICATION_LOGIN} ${form}`);
  }
  if (url.password === '') {
    return refused(`${DATABASE_URL} in ${where} has no password, and the Workers' database binding needs one ${form}`);
  }
  if (url.pathname === '' || url.pathname === '/') {
    return refused(`${DATABASE_URL} in ${where} names no database ${form}`);
  }
  return { ok: true, address: { url: value } };
}

/** The dev server's environment for this address: the one variable wrangler
 * reads (it wins over any older spelling a shell may still carry). */
export function databaseEnv(address: DatabaseAddress): DatabaseEnv {
  return { [LOCAL_CONNECTION_VARIABLE]: address.url };
}

/** Whether a Worker config's text (wrangler.jsonc) binds the Postgres store;
 * false for text that is not JSON(C). */
export function bindsPostgres(wranglerJsonc: string | null | undefined): boolean {
  try {
    const config = JSON.parse(stripJsonc(String(wranglerJsonc ?? ''))) as { hyperdrive?: unknown } | null;
    const bindings: unknown[] = Array.isArray(config?.hyperdrive) ? config.hyperdrive : [];
    return bindings.some((entry) => (entry as { binding?: unknown } | null)?.binding === POSTGRES_BINDING);
  } catch {
    return false;
  }
}

/** The migration versions this code has: db/postgres/migrations/NNNN_name.sql. */
export function codeMigrationVersions(dir: string = MIGRATIONS_DIR): number[] {
  return readdirSync(dir)
    .map((name) => MIGRATION_FILE.exec(name)?.[1])
    .filter((version): version is string => version !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/** What the check needs of a store: the helper's own shape (packages/postgres). */
export interface CheckedStore {
  onlyWorkspace(): Promise<string>;
  inWorkspace<T>(
    workspaceId: string,
    work: (tx: { query(sql: string): Promise<Record<string, unknown>[]> }) => Promise<T>,
    options?: { readonly readOnly?: boolean },
  ): Promise<T>;
  close(): Promise<void>;
}

export interface CheckOptions {
  /** How the sentence names the secrets file. */
  readonly where: string;
  /** The code's migrations (default: beside this file). */
  readonly migrationsDir?: string;
  /** Opens a store on the address (default: the one helper, packages/postgres). */
  readonly open?: (url: string) => CheckedStore | Promise<CheckedStore>;
}

/** Codes Node gives a connection that never reached a server. */
const UNANSWERED = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);
/** SQLSTATEs of a login the server refused (bad password, no such role, pg_hba). */
const LOGIN_REFUSED = new Set(['28P01', '28000']);
/** SQLSTATEs of a database with no NoticeOS schema its login can read. */
const NO_SCHEMA = new Set(['42883', '3F000', '42P01', '42501']);

async function openHelperStore(url: string): Promise<CheckedStore> {
  // Loaded only here, so importing this module for its names never loads the
  // driver.
  const { openStore } = await import('../packages/postgres/src/store.mjs');
  return openStore(url, { maxConnections: 1 }) as CheckedStore;
}

/** One migration the database records applying: a row of noticeos_migrations.applied. */
export interface RecordedMigration {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
}

/** The migrations a database records, or the one sentence saying why they could not be read. */
export type RecordedMigrations = { readonly ok: true; readonly records: readonly RecordedMigration[] } | Refusal;

/**
 * Which migrations the database at `address` records applying, asked as the
 * application login in one READ ONLY transaction in its one workspace, which
 * it must name. A refusal is one sentence naming what to do; it never carries
 * the driver's message, which can repeat the address's login or host.
 */
export async function readRecordedMigrations(
  address: DatabaseAddress,
  options: Pick<CheckOptions, 'where' | 'open'>,
): Promise<RecordedMigrations> {
  const { where, open = openHelperStore } = options;
  const named = `the database ${DATABASE_URL} in ${where} names`;
  let store: CheckedStore | null = null;
  let workspaceId: string;
  try {
    store = await open(address.url);
    workspaceId = await store.onlyWorkspace();
  } catch (error) {
    await store?.close().catch(() => undefined);
    return refused(checkFailure(error, named, where));
  }
  try {
    const rows = await store.inWorkspace(
      workspaceId,
      (tx) => tx.query('SELECT version, name, sha256 FROM noticeos_migrations.applied ORDER BY version'),
      { readOnly: true },
    );
    const records = rows.map((row) => ({ version: Number(row.version), name: String(row.name ?? ''), sha256: String(row.sha256 ?? '') }));
    return { ok: true, records };
  } catch (error) {
    // The one workspace answered, so the schema is there; what is missing is
    // the record of its migrations, or its login's right to read it.
    const code = errorCode(error);
    return refused(
      NO_SCHEMA.has(code)
        ? `${named} does not let its login read which migrations it has, so whether it is behind this code is unknown (db/postgres/README.md)`
        : checkFailure(error, named, where),
    );
  } finally {
    await store.close().catch(() => undefined);
  }
}

/**
 * Whether the database at `address` is one this code can start on, asked as
 * the application login and only read: it answers, its login is the
 * application's, it has every migration this code has, and it names its one
 * workspace. A refusal is one sentence naming what to do.
 */
export async function checkDatabase(address: DatabaseAddress, options: CheckOptions): Promise<{ readonly ok: true } | Refusal> {
  const { where, migrationsDir = MIGRATIONS_DIR } = options;
  const read = await readRecordedMigrations(address, options);
  if (!read.ok) return read;
  const applied = new Set(read.records.map((record) => record.version));
  const behind = codeMigrationVersions(migrationsDir).filter((version) => !applied.has(version));
  if (behind.length > 0) {
    return refused(
      `the database ${DATABASE_URL} in ${where} names is ${behind.length} migration${behind.length === 1 ? '' : 's'} behind this code; ` +
        'pnpm os:migrate -- --apply brings it up to date (db/postgres/README.md)',
    );
  }
  return { ok: true };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

function checkFailure(error: unknown, named: string, where: string): string {
  const name = error instanceof Error ? error.name : '';
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : '';
  if (name === 'NoSingleWorkspace') {
    return `${named} has no workspace yet; pnpm os:migrate -- --bootstrap creates it (db/postgres/README.md)`;
  }
  if (name === 'TransactionRefused') {
    return `${DATABASE_URL} in ${where} logs in as another role; NoticeOS logs in as ${APPLICATION_LOGIN} (${DATABASE_SETUP})`;
  }
  if (UNANSWERED.has(code) || /timeout/iu.test(message)) {
    return `${named} does not answer; start it (${DATABASE_SETUP}), then try again`;
  }
  if (LOGIN_REFUSED.has(code)) {
    return `${named} refused its login; check the user and password in ${DATABASE_URL}`;
  }
  if (code === '3D000') {
    return `${named} does not exist (${DATABASE_SETUP} creates it)`;
  }
  if (NO_SCHEMA.has(code)) {
    return `${named} has no NoticeOS schema its login can read; pnpm os:migrate -- --apply creates it (db/postgres/README.md)`;
  }
  const said = /^[0-9A-Z]{5}$/u.test(code) || /^E[A-Z_]+$/u.test(code) ? ` (${code})` : '';
  return `${named} could not be checked${said}; see ${DATABASE_SETUP}`;
}

function refused(line: string): Refusal {
  return { ok: false, line: `${line}.` };
}

/** Where DATABASE_URL is read from: the installation's secrets file. */
export interface AddressSource {
  /** How the sentence names the secrets file. */
  readonly where: string;
  /** Reads the secrets file's bindings (scripts/dev-secrets.mjs `readDevSecretBindings`). */
  readonly readBindings: () => Promise<{ readonly bindings: Readonly<Record<string, unknown>> }>;
}

export interface TowerDatabaseOptions extends Omit<CheckOptions, 'where'>, AddressSource {}

/** DATABASE_URL, read from the secrets file and checked for its form, or why not. */
async function readAddress({ where, readBindings }: AddressSource): Promise<{ readonly ok: true; readonly address: DatabaseAddress } | Refusal> {
  let bindings: Readonly<Record<string, unknown>>;
  try {
    ({ bindings } = await readBindings());
  } catch {
    // The reader's message can quote the file; the sentence names it instead.
    return refused(`${where} could not be read, so ${DATABASE_URL} is unknown; it is one JSON object of the installation's secrets`);
  }
  return readDatabaseAddress(bindings, where);
}

/**
 * What the dev server's environment gains for this installation's database, or
 * the one sentence that stops the start: the address read from the secrets
 * file, then checked. Never throws, and never repeats the address.
 */
export async function towerDatabase(options: TowerDatabaseOptions): Promise<{ readonly ok: true; readonly env: DatabaseEnv } | Refusal> {
  const reading = await readAddress(options);
  if (!reading.ok) return reading;
  const checked = await checkDatabase(reading.address, options);
  if (!checked.ok) return checked;
  return { ok: true, env: databaseEnv(reading.address) };
}

/**
 * Which migrations this installation's database records, read through the
 * address every start reads: what `pnpm os:deploy` holds a commit's Postgres
 * migrations against. Never throws, and never repeats the address.
 */
export async function recordedMigrations(options: AddressSource & Pick<CheckOptions, 'open'>): Promise<RecordedMigrations> {
  const reading = await readAddress(options);
  if (!reading.ok) return reading;
  return readRecordedMigrations(reading.address, options);
}
